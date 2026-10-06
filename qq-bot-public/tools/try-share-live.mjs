/**
 * try-share-live.mjs —— 实机跑一次「主动发言」：循环模拟直到模型说"值得说"，然后真的发出去。
 *
 * 为什么循环：提示词里把门槛压得很高（大部分时候该是 false），
 *   所以等一次自然的 true 本来就要试几次。绝不"替模型编一句话发出去" ——
 *   那样测的就不是这个功能了。
 *
 * 走的是 bot.js 里 shareLifeEntry() **同一套顺序**：
 *   现读当前会话 → 判定（模型 + 本地闸门）→ sendMessage → 回写生活日志 → 记账
 * 唯一的差别：这里不等"每 5 次控制台检测"那个节拍，直接连着试
 *（节拍本身有单测盯着，实机要验的是"发得出去"）。
 *
 * ⚠ 这个脚本会**真的往群里发消息**（模型自己生成的那句）。
 *    只在用户明确要求实机验证时跑。
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT, resolveProvider, loadEnvFile } from '../src/config.js';
import { loadStore, renderMemory } from '../src/memory.js';
import {
  loadLifeLog, renderLife, appendLifeEntry, lifeConfig, decideShare, recordShare, updateLifeEntry,
} from '../src/life.js';
import { generateLifeSimulation } from '../src/llm.js';
import { activeSystemPrompt as activeSystemPromptOf } from '../src/takeover.js';
import { loadState, saveState, markSent, markReplied } from '../src/gate.js';
import { sendMessage } from '../src/sender.js';
import { readCurrentConversation, readSessions, switchToConversation } from '../src/switch.js';
import { shareAllowedIn } from '../src/life.js';

const MAX_TRIES = Number(process.argv[3]) || 12;
// 可选：目标会话名。走环境变量传，因为群名里可能有括号和顿号，
// 从命令行参数传会被 shell 拆得七零八落（踩过）。
const SWITCH_TO = String(process.env.SHARE_TARGET ?? '').trim();

const cfg = loadConfig();

// 配置里是 local，而本地服务很可能没开 —— 那时用云端把这条链验完。
// （只改本次进程的 cfg，不动 config.json；跑完什么都不会留下。）
const wantProvider = String(process.argv[2] ?? '').trim();
if (wantProvider) {
  const env = loadEnvFile(path.join(ROOT, '.env'));
  cfg.llm.provider = wantProvider;
  cfg.llm = resolveProvider(cfg, process.env, env.keys);
}
console.log('provider =', cfg.llm.provider, '| model =', cfg.llm.model);

const lc = lifeConfig(cfg);
const state = loadState();

// ---- 1) 现读当前会话（分享只发到"此刻打开着的那个"，且必须在名单里）----
let cur = await readCurrentConversation({ cfg });
console.log('当前会话 =', JSON.stringify(cur.name));

// 不在名单里就早点说清楚 —— 否则会白跑十几次模拟，最后才发现"就算想说也发不出去"。
// （踩过：模型 12 次全说不说，其实当时打开的是白名单外的「测试群」。）
// SHARE_TARGET 给了就切过去（不管当前在不在名单里）—— 实机"群聊/私聊各试一次"要用。
if (SWITCH_TO && cur.name !== SWITCH_TO) {
  console.log(`当前是「${cur.name}」，按 SHARE_TARGET 切到「${SWITCH_TO}」……`);
  const read = await readSessions();
  if (read.ok) {
    const r = await switchToConversation(SWITCH_TO, {
      sessions: read.sessions, handle: read.handle, cfg, restoreCursor: true, waitMs: 1500,
    });
    console.log('切换结果 =', JSON.stringify(r));
    cur = await readCurrentConversation({ cfg });
    console.log('切换后会话 =', JSON.stringify(cur.name));
  } else {
    console.log('读会话列表失败：' + read.error);
  }
}

if (!cur.ok || !cur.name) {
  console.log('读不到当前会话名 —— 先把 QQ 窗口打开到聊天页再跑。');
  process.exit(1);
}
if (!shareAllowedIn(cfg, cur.name)) {
  console.log(`\n⚠ 「${cur.name}」不在允许分享的名单里，所以这次一个字都发不出去。`);
  console.log('允许的会话：' + ((lc.share.conversations.length ? lc.share.conversations : (cfg.trigger?.whitelist ?? [])).join('、') || '（空）'));
  console.log('先把 QQ 切到其中一个，或用 SHARE_TARGET 环境变量指定一个再跑。');
  process.exit(1);
}

// ---- 2) 循环：模拟 → 判定 → 命中就发 ----
const reasons = [];
let sent = null;

for (let i = 1; i <= MAX_TRIES && !sent; i++) {
  const now = Date.now();
  const { store } = loadStore(cfg, ROOT, cur.name);
  const { log: lifeLog } = loadLifeLog(cfg, ROOT, '');
  const lastAt = lifeLog.entries.length ? lifeLog.entries[lifeLog.entries.length - 1].at : 0;

  const r = await generateLifeSimulation(cfg, {
    now,
    persona: activeSystemPromptOf(state, cfg),
    memoryDigest: renderMemory(store, cfg),
    lifeDigest: renderLife(lifeLog, cfg, { note: false }),
    lastAt,
    conversation: cur.name,
  });
  if (!r.ok) {
    console.log(`第 ${i} 次：模拟失败（${r.reason}：${r.detail ?? ''}）`);
    break;
  }

  const saved = appendLifeEntry(cfg, ROOT, r.entry, now, '');
  const e = saved.entry;
  const s = e.share;
  console.log(`第 ${i} 次：${e.mood}｜在做：${e.doing}` +
    `｜判断：${s ? (s.suitable ? `值得说（${s.why}）→「${s.text}」` : `不说（${s.why}）`) : '没给判断'}`);

  const d = decideShare(cfg, { entry: e, conversation: cur.name, now, state, enabled: lc.share.enabled });
  if (!d.ok) {
    reasons.push(d.reason);
    // 节流类原因（间隔/每日上限/静默）不会因为多试几次而消失，早点收工
    if (/间隔|上限|静默|名单|没开/.test(d.reason)) { console.log('闸门挡住了：' + d.reason); break; }
    continue;
  }

  // ---- 命中：这就是"主动进行一次输出" ----
  console.log(`\n>>> 模型认为值得说，本地闸门也放行。真发 →「${d.conversation}」："${d.text}"`);
  recordShare(state, now, d.text);
  saveState(state);

  const sendRes = await sendMessage(cfg, d.text);
  const record = {
    at: now,
    ok: sendRes.ok === true,
    sent: sendRes.sent === true,
    reason: sendRes.ok ? '' : String(sendRes.error ?? sendRes.reason ?? '发送失败'),
    text: d.text,
    conversation: d.conversation,
  };
  updateLifeEntry(cfg, ROOT, e.at, { shared: record }, '');

  console.log('发送结果 =', JSON.stringify(sendRes).slice(0, 300));
  if (!sendRes.ok) { console.log('发送失败：' + record.reason); break; }

  if (sendRes.dryRun || sendRes.sent) {
    state.history = Array.isArray(state.history) ? state.history : [];
    state.history.push({ side: 'self', sender: '', text: d.text, at: now });
    const cap = Math.max(20, Number(cfg.llm?.historyBuffer ?? 60) || 60);
    if (state.history.length > cap) state.history = state.history.slice(-cap);
    state.histSeen = state.history.map((h) => `${h.side}|${h.text}`);
    markSent(state, d.text);
    markReplied(state, now);
    saveState(state);
  }
  sent = d.text;
}

console.log('\n===== 结果 =====');
if (sent) {
  console.log('✓ 主动发言已发出：' + JSON.stringify(sent));
  const after = loadLifeLog(cfg, ROOT, '');
  const last = after.log.entries[after.log.entries.length - 1];
  console.log('生活日志里那条的发送记录：' + JSON.stringify(last.shared));
} else {
  console.log('这次没能发出。试了 ' + reasons.length + ' 次，闸门原因：' +
    JSON.stringify([...new Set(reasons)], null, 0));
  console.log('（模型一直说"不适合"也是**正常结果** —— 提示词就是让它大部分时候闭嘴。）');
}
console.log('今天主动发言次数 =', (loadState().shareTimes ?? []).length);
