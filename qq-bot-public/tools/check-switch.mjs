/**
 * check-switch.mjs — 一次性验证：真的去点会话列表，看切没切成。
 *
 * ⚠ 这个脚本会**移动鼠标并点击**。跑之前请把手离开鼠标、别在打字。
 *   跑完光标会还原到原处。
 *
 * 用法：node tools/check-switch.mjs [目标会话名]
 */
import { loadConfig } from '../src/config.js';
import { readSessions, switchToConversation } from '../src/switch.js';
import { targetConversations, pickNextConversation } from '../src/sessions.js';
import { readConversation } from '../src/reader.js';

const cfg = loadConfig();

console.log('  自动切换开关: ' + (cfg.autoSwitch?.enabled === true ? '开' : '关'));
console.log('');

console.log('  ① 读会话列表…');
const before = await readSessions();
if (!before.ok) { console.log('    失败: ' + before.error); process.exit(1); }
for (const s of before.sessions) {
  console.log(`    ${JSON.stringify(s.name).padEnd(36)} 点击点=(${s.cx},${s.cy})`);
}

const targets = targetConversations(cfg, before.sessions);
console.log('');
console.log('  ② 目标（白名单 ∩ 列表）: ' + JSON.stringify(targets));

console.log('');
console.log('  ③ 当前开着的是哪个会话…');
const now = await readConversation(cfg, {});
console.log('    ' + JSON.stringify(now.parsed.conversation) + '  消息 ' + now.parsed.messages.length + ' 条');

const want = process.argv[2] || (targets.length > 1 ? targets.find((t) => t !== now.parsed.conversation) : null);
if (!want) { console.log('    没有"另一个目标"可切（只有一个目标且已在上面）—— 不点，避免白抢焦点'); process.exit(0); }

console.log('');
console.log('  ④ 切到「' + want + '」…（会移动鼠标，3 秒后动手）');
await new Promise((r) => setTimeout(r, 3000));

const sw = await switchToConversation(want, { sessions: before.sessions, handle: before.handle, waitMs: cfg.autoSwitch?.settleMs ?? 1500 });
console.log('    ' + JSON.stringify(sw));

console.log('');
console.log('  ⑤ 再读一次，看是不是真的切过去了…');
const after = await readConversation(cfg, {});
console.log('    会话名 = ' + JSON.stringify(after.parsed.conversation));
console.log('    消息 ' + after.parsed.messages.length + ' 条');
const ok = after.parsed.conversation === want || after.parsed.conversation.includes(want) || want.includes(after.parsed.conversation);
console.log('');
console.log('    ' + (ok ? '✓ 切换成功' : '✗ 没切成（读到的还是「' + after.parsed.conversation + '」）'));
