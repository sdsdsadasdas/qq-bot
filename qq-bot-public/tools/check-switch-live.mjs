/**
 * check-switch-live.mjs —— 实机验证自动切换（一次性脚本，验完就删）。
 *
 * 要验的就是这次修的那条路径：**把窗口句柄一起传给点击脚本**。
 * 所以这里刻意照着 bot.js 里 maybeSwitchConversation() 的调用形状来写：
 *   readSessions() → 拿 sessions + handle → switchToConversation(..., { sessions, handle })
 * 少传 handle 就会退回"对着不在前台的窗口点击 = 只激活、收不到点击"的老毛病。
 *
 * ⚠ 会动鼠标（每次约 2~3 秒，点完还原光标位置）。连着切 3 次，
 *   因为之前"3 次里偶尔有 1 次不成"就是这个问题的症状。
 */

import { loadConfig } from '../src/config.js';
import { readSessions, switchToConversation, readCurrentConversation } from '../src/switch.js';
import { targetConversations, pickNextConversation, sessionMatches } from '../src/sessions.js';

const cfg = loadConfig();
console.log('autoSwitch.enabled :', cfg.autoSwitch?.enabled);
console.log('restoreCursor      :', cfg.autoSwitch?.restoreCursor, '| settleMs:', cfg.autoSwitch?.settleMs);

const before = await readCurrentConversation({ cfg });
console.log('\n起始会话           :', JSON.stringify(before), before.ok ? '' : '（读不到会话名，QQ 窗口是不是最小化了？）');

const read = await readSessions();
console.log('readSessions       : ok=' + read.ok, 'handle=' + read.handle, read.ok ? '' : read.error);
if (!read.ok) process.exit(1);
for (const s of read.sessions) console.log('   ', s.name, `@(${s.cx},${s.cy})`);

const targets = targetConversations(cfg, read.sessions);
console.log('可切换目标         :', targets.map((t) => t.name).join('、') || '（无）');
if (targets.length === 0) process.exit(1);

let current = before.name;
let last = '';
let okCount = 0;
const total = 3;

for (let i = 1; i <= total; i++) {
  const pick = pickNextConversation(targets, current, last);
  if (!pick) { console.log('\n没有可切换的目标了，停。'); break; }

  console.log(`\n--- 第 ${i}/${total} 次： 「${current || '未知'}」 → 「${pick.name}」 ---`);

  // 每次现读坐标：窗口位置、列表滚动都会让坐标过期（拿旧坐标点 = 随机点界面）
  const fresh = await readSessions();
  if (!fresh.ok) { console.log('读会话列表失败：', fresh.error); break; }

  const r = await switchToConversation(pick.name, {
    sessions: fresh.sessions,
    handle: fresh.handle,                     // ← 这次修的就是这一行
    cfg,
    restoreCursor: cfg.autoSwitch?.restoreCursor !== false,
    waitMs: cfg.autoSwitch?.settleMs ?? 1500,
  });
  console.log('switchToConversation →', JSON.stringify(r));

  const after = await readCurrentConversation({ cfg });
  const good = Boolean(after.name) && sessionMatches(after.name, pick.name);
  console.log(`界面读回             : 「${after.name}」 ${good ? '✓ 切过去了' : '✗ 没切过去'}`);

  if (good) { okCount++; current = after.name; last = pick.name; }
  else { console.log('失败，就此停下（不再继续点，免得在界面上乱点）'); break; }
}

console.log(`\n===== 结果：${okCount}/${total} 次切换成功 =====`);
process.exit(okCount === total ? 0 : 1);
