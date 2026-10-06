/**
 * try-share-forced.mjs —— 实机验证「主动发言」这条链路：群聊 + 个人 各发一条。
 *
 * ⚠ 与 try-share-live.mjs 的区别（这一点必须说清楚）：
 *   那个脚本等**模型自己**说"值得说"；实测模型 35+ 次全拒（见报告），
 *   所以这个脚本把 `share.suitable` **强行置为 true**，只验"判定通过之后
 *   能不能真的发出去、发到对的地方、日志记对"。
 *   要说的话仍取模型自己产出的那个 `thinking`（不是我编的台词），
 *   在日志里也会留下 why="实机验证：suitable 由脚本置 true"，事后可分辨。
 *
 * 用法：SHARE_TARGET=<会话名> node tools/try-share-forced.mjs [provider]
 */

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
import { runPs } from '../src/ps.js';
import { parseUia, findLayoutPanes } from '../src/parse-uia.js';

const TARGET = String(process.env.SHARE_TARGET ?? '').trim();
const provider = String(process.argv[2] ?? '').trim();

const cfg = loadConfig();
if (provider) {
  const env = loadEnvFile(path.join(ROOT, '.env'));
  cfg.llm.provider = provider;
  cfg.llm = resolveProvider(cfg, process.env, env.keys);
}
const state = loadState();

// ---- 1) 切到目标会话 ----
let cur = await readCurrentConversation({ cfg });
if (TARGET && cur.name !== TARGET) {
  console.log(`切到「${TARGET}」……`);
  const read = await readSessions();
  const r = await switchToConversation(TARGET, {
    sessions: read.sessions, handle: read.handle, cfg, restoreCursor: true, waitMs: 1500,
  });
  console.log('  切换 =', JSON.stringify(r));
  cur = await readCurrentConversation({ cfg });
}
console.log('当前会话 =', JSON.stringify(cur.name));

// ---- 2) 看清布局（群聊/个人 的适配就体现在这里）----
const raw = await runPs('uia-read.ps1', [], { timeoutMs: 30000 });
const panes = findLayoutPanes(raw);
const p = parseUia(raw, cfg);
console.log(`布局 = ${panes.member ? '群聊（有成员列表 Pane）' : '个人（没有成员列表 Pane）'}` +
  `　锚点=${p.layoutAnchor}　isGroup=${p.isGroup}`);
console.log(`  消息列表面板 = ${p.column.pane ? `${p.column.pane.x}..${p.column.pane.x + p.column.pane.w}` : '（无）'}` +
  `　消息带 x ${p.column.xMin}~${p.column.xMax}`);
console.log(`  解析：会话名=${JSON.stringify(p.conversation)} 消息 ${p.messages.length} 条`);

// ---- 3) 让模型推一次（拿到它自己的 thinking，当要说的话）----
const now = Date.now();
const { store } = loadStore(cfg, ROOT, cur.name);
const { log: lifeLog } = loadLifeLog(cfg, ROOT, '');
const r = await generateLifeSimulation(cfg, {
  now,
  persona: activeSystemPromptOf(state, cfg),
  memoryDigest: renderMemory(store, cfg),
  lifeDigest: renderLife(lifeLog, cfg, { note: false }),
  lastAt: lifeLog.entries.length ? lifeLog.entries[lifeLog.entries.length - 1].at : 0,
  conversation: cur.name,
});
if (!r.ok) { console.log('模拟失败：', r.reason, r.detail); process.exit(1); }
const saved = appendLifeEntry(cfg, ROOT, r.entry, now, '');
const e = saved.entry;
console.log(`模拟：${e.mood}｜在做：${e.doing}｜在想：${e.thinking}`);
console.log(`  模型自己的判断 = ${JSON.stringify(e.share)}`);

// ---- 4) 把"值得说"置为 true（**这一步是脚本干的，不是模型**）----
const text = (e.thinking || e.doing || '').trim().slice(0, 30);
if (!text) { console.log('模型没给出可用的 thinking，换一句'); }
const say = text || '突然有点想吃泡面';
const forced = { ...e, share: { suitable: true, why: '实机验证：suitable 由脚本置 true', text: say } };

const d = decideShare(cfg, { entry: forced, conversation: cur.name, now: Date.now(), state, enabled: true });
console.log(`判定（本地闸门）= ${d.ok ? `通过 → 发到「${d.conversation}」："${d.text}"` : '被挡：' + d.reason}`);
if (!d.ok) { updateLifeEntry(cfg, ROOT, e.at, { share: forced.share, shared: { at: Date.now(), ok: false, sent: false, reason: d.reason, text: say, conversation: cur.name } }, ''); process.exit(1); }

// ---- 5) 真发 ----
recordShare(state, Date.now(), d.text);
saveState(state);
const sendRes = await sendMessage(cfg, d.text);
console.log('发送结果 =', JSON.stringify(sendRes).slice(0, 240));
updateLifeEntry(cfg, ROOT, e.at, {
  share: forced.share,
  shared: {
    at: Date.now(), ok: sendRes.ok === true, sent: sendRes.sent === true,
    reason: sendRes.ok ? '' : String(sendRes.error ?? sendRes.reason ?? ''), text: d.text, conversation: d.conversation,
  },
}, '');
if (sendRes.ok && (sendRes.dryRun || sendRes.sent)) {
  state.history = Array.isArray(state.history) ? state.history : [];
  state.history.push({ side: 'self', sender: '', text: d.text, at: Date.now() });
  state.histSeen = state.history.map((x) => `${x.side}|${x.text}`);
  markSent(state, d.text);
  markReplied(state, Date.now());
  saveState(state);
  console.log(`✓ 已发出（${cur.name}）：${d.text}`);
}
