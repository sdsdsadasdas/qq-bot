/**
 * check-life-live.mjs —— 实机跑一次人生模拟（一次性验证脚本，验完就删）。
 *
 * 为什么单独写一个而不是直接开机器人：开机器人会**真的往群里发消息**，
 * 而这次要验的只有一件事 —— 「拿真实配置调一次本地 API，能不能产出一条
 * 能用的生活记录并落盘」。这条路上不涉及发送，所以不该捎带发消息的风险。
 *
 * 走的是 bot.js 里 runLifeSimulation() **同一套**调用：
 *   人设 + 记忆 + 最近生活 → generateLifeSimulation → appendLifeEntry
 */

import { loadConfig, ROOT, resolveProvider, loadEnvFile } from '../src/config.js';
import { loadStore, renderMemory } from '../src/memory.js';
import { loadLifeLog, renderLife, appendLifeEntry, lifeConfig, nextLifeClock } from '../src/life.js';
import { generateLifeSimulation, apiCallStats } from '../src/llm.js';
import { activeSystemPrompt as activeSystemPromptOf } from '../src/takeover.js';
import { loadState } from '../src/gate.js';
import { listModels } from '../src/llm.js';
import { readCurrentConversation } from '../src/switch.js';
import { decideShare, countSharesToday } from '../src/life.js';
import path from 'node:path';

const cfg = loadConfig();

// 可选：用命令行指定的厂商跑这一趟（配置里的 provider=local，而本地服务没开时
// 拿云端验一遍能证明"提示词→调用→解析→落盘"这条链是通的）。
const wantProvider = String(process.argv[2] ?? '').trim();
if (wantProvider) {
  const env = loadEnvFile(path.join(ROOT, '.env'));
  cfg.llm.provider = wantProvider;
  // ⚠ resolveProvider 是**返回**一份新配置，不是原地改 —— 不接返回值等于没换厂商
  //   （第一版就写错了：provider 显示 deepseek，baseUrl 还是本地的 8080）。
  cfg.llm = resolveProvider(cfg, process.env, env.keys);
}

const lc = lifeConfig(cfg);

console.log('=== 配置 ===');
console.log('provider     :', cfg.llm.provider, '| model:', cfg.llm.model);
console.log('baseUrl      :', cfg.llm.baseUrl);
console.log('key          :', cfg.llm.apiKey ? `已配置（${cfg.llm.apiKeySource}，${String(cfg.llm.apiKey).length} 字符）` : '无');
console.log('life.enabled :', lc.enabled, '| everyChecks:', lc.everyChecks, '| file:', lc.file);
console.log('life.timeout :', lc.timeoutMs, 'ms | maxTokens:', lc.maxTokens, '| jsonMode:', cfg.life.jsonMode === true);

console.log('\n=== 本地服务探测 ===');
const models = await listModels(cfg.llm.baseUrl, { apiKey: cfg.llm.apiKey, timeoutMs: 8000 });
console.log('ok=', models.ok, '| models=', models.models.join(', ') || models.error);

const state = loadState();
console.log('\n=== 组装「设定」===');
const persona = activeSystemPromptOf(state, cfg);
console.log('人设长度     :', persona.length, '字');
const { store } = loadStore(cfg, ROOT, '');
const memoryDigest = renderMemory(store, cfg);
console.log('记忆摘要     :', memoryDigest ? memoryDigest.length + ' 字' : '（空）');
const { log: lifeLog } = loadLifeLog(cfg, ROOT);
const lifeDigest = renderLife(lifeLog, cfg, { note: false });
console.log('已有生活记录 :', lifeLog.entries.length, '条');
const lastAt = lifeLog.entries.length ? lifeLog.entries[lifeLog.entries.length - 1].at : 0;

// 分享要发到"此刻打开着的那个会话"，所以这里也现读一次（只读，不动鼠标）
const cur = await readCurrentConversation({ cfg });
console.log('当前会话     :', JSON.stringify(cur.name));

const realNow = Date.now();
// 跟机器人一致：喂给模型的是**角色时钟**（每条往前推 stepMinutes），不是真实时间。
// 用真实时间的话，两次模拟只隔几十秒，模型看到"上一次是 1 分钟前"就什么都不换。
const clock = nextLifeClock(cfg, lifeLog, realNow);
const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '（无）');
console.log('真实时间     :', fmt(realNow));
console.log('角色时钟     :', fmt(clock.lifeAt), '（这次模拟要用的「现在」）');
console.log('上一条时钟   :', fmt(clock.prevLifeAt), clock.prevLifeAt ? `→ 相距 ${Math.round((clock.lifeAt - clock.prevLifeAt) / 60000)} 分钟` : '');
console.log('时钟设置     : step=' + lifeConfig(cfg).clock.stepMinutes + ' 分钟，最多领先现实 ' + lifeConfig(cfg).clock.maxAheadMinutes + ' 分钟');

console.log('\n=== 调用本地 API（这一步要等，本地推理慢）===');
const before = apiCallStats.total;
const t0 = Date.now();
const r = await generateLifeSimulation(cfg, {
  now: clock.lifeAt, persona, memoryDigest, lifeDigest, lastAt: clock.prevLifeAt ?? 0, conversation: cur.name,
});
console.log('耗时         :', ((Date.now() - t0) / 1000).toFixed(1), 's');
console.log('ok           :', r.ok, r.ok ? '' : `reason=${r.reason} detail=${r.detail}`);
console.log('API 计数增量 :', apiCallStats.total - before);
if (r.hadReasoning) console.log('（这是推理模型：先输出了思考）');
if (!r.ok) process.exit(1);

console.log('原始输出     :', JSON.stringify(r.raw));
console.log('解析出的条目 :', JSON.stringify(r.entry));

console.log('\n=== 清洗并写入生活日志 ===');
const saved = appendLifeEntry(cfg, ROOT,
  (r.entry && typeof r.entry === 'object') ? { ...r.entry, lifeAt: clock.lifeAt } : r.entry, realNow, '');
console.log('写入 ok      :', saved.ok, saved.error || '');
console.log('生活日志第   :', saved.total, '条');
console.log('落盘文件     :', saved.path);
console.log('条目         :', JSON.stringify(saved.entry));

console.log('\n=== 注入回复提示词的那段（模型以后会读到的）===');
const { log: after } = loadLifeLog(cfg, ROOT);
console.log(renderLife(after, cfg));

// ---- 主动分享：只看判定，**不真发**（这个脚本永远不往群里打字）----
console.log('\n=== 主动分享的判定（这个脚本不会真发，只走判定链）===');
const sh = lifeConfig(cfg).share;
console.log('share.enabled      :', sh.enabled, '| probability:', sh.probability,
  '| 间隔:', Math.round(sh.minIntervalMs / 60000), '分钟 | 每日上限:', sh.maxPerDay,
  '| 静默:', sh.quietFrom === sh.quietTo ? '无' : `${sh.quietFrom}~${sh.quietTo}`);
console.log('今天已主动分享     :', countSharesToday(state, Date.now()), '次');
console.log('模型给的分享判断   :', JSON.stringify(saved.entry.share));
const d = decideShare(cfg, { entry: saved.entry, conversation: cur.name, now: Date.now(), state });
console.log('本地闸门结论       :', d.ok ? `会发 → "${d.text}"（发到「${d.conversation}」）` : `不发 —— ${d.reason}`);

console.log('\n日志文件内容：');
console.log(JSON.stringify(JSON.parse((await import('node:fs')).readFileSync(saved.path, 'utf8')), null, 2));
