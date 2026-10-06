/**
 * test-parse-uia.mjs — 用当前 QQ 窗口的真实 UIA 数据验证 UIA 解析器。
 *
 * 用法：node tools/test-parse-uia.mjs
 *
 * 不改动 QQ，只读取。用来确认「聊天列判定 / 会话名 / 发送者 / 消息内容」都对。
 */
import { loadConfig } from '../src/config.js';
import { runPs } from '../src/ps.js';
import { parseUia, resolveChatColumn } from '../src/parse-uia.js';
import { decide, loadState } from '../src/gate.js';
import { isMentioned } from '../src/parse.js';

const cfg = loadConfig({ argv: [] });

console.log('='.repeat(72));
console.log('UIA 解析器验证（读取真实 QQ 窗口）');
console.log('='.repeat(72));

const uia = await runPs('uia-read.ps1', ['-ProcessName', cfg.process?.name ?? 'QQ'], { timeoutMs: 60000 });

if (!uia.ok) {
  console.log(`uia-read 失败: ${uia.error}`);
  process.exit(1);
}

console.log(`激活=${uia.activated}  后代=${uia.descendantCount}  文本元素=${uia.texts.length}`);
console.log(`发送按钮: x=${uia.sendButton?.x} y=${uia.sendButton?.y} w=${uia.sendButton?.w} h=${uia.sendButton?.h}`);
console.log(`输入框  : ${uia.editBox ? `'${uia.editBox.name}' value='${uia.editBox.value}'` : '(未暴露)'}`);

const col = resolveChatColumn(uia.sendButton, cfg);
console.log(`聊天列判定: x ${col.xMin}~${col.xMax}   y ${col.yMin}~${col.yMax}`);

const parsed = parseUia(uia, cfg);
console.log('');
console.log(`解析器版本: ${parsed.parserVersion ?? '(无标记)'}`);
console.log(`会话名: "${parsed.conversation}"`);
console.log(`  标题栏候选: ${JSON.stringify(parsed.conversationCandidates)}`);
console.log(`聊天列内元素: ${parsed.messages.length} 条消息`);
console.log('-'.repeat(72));
for (const m of parsed.messages) {
  const men = isMentioned(m, cfg) ? '  <<< 被@' : '';
  console.log(`[${String(m.index).padStart(2)}] 发送者="${m.sender}"  x=${m.x} y=${m.y}${men}`);
  console.log(`     内容: ${m.text}`);
}
console.log('-'.repeat(72));

// 决策层联调
const state = loadState();
state.seen = [];
state.sentReplies = [];
state.replyTimes = [];
state.pending = [];
const result = decide(cfg, state, parsed);
console.log(`决策: 会话「${result.conversationName}」${result.isGroup ? '群聊' : '私聊'} | 白名单${result.whitelisted ? '命中' : '未命中'}`);
for (const d of result.decisions) {
  console.log(`  ${d.reply ? '→ 回复' : '  跳过'}  "${d.message.text}"   (${d.reason})`);
}
const toReply = result.decisions.filter((d) => d.reply);
console.log('-'.repeat(72));
console.log(`应回复 ${toReply.length} 条`);

// 排除性检查：右侧群成员列表不该混进来。
// 注意判据要用「他人区间」和「自己区间」的并集 —— 自己发的消息右对齐，
// x 本来就会超过他人区间的 xMax，用单一 xMax 判会误报。
const memberListLeak = parsed.messages.filter((m) => {
  const cx = m.x;   // m.x 是内容起笔位置
  const inIncoming = cx <= col.xMax;
  const inSelf = cx >= col.selfXMin && cx <= col.selfXMax;
  return !inIncoming && !inSelf;
});
console.log(`右侧群成员列表误入: ${memberListLeak.length} 条 ${memberListLeak.length ? '← 有问题！' : '✓'}`);

// 上下文长度检查
console.log(`视口上方的历史消息: ${parsed.offscreenAbove ?? 0} 条（这些就是长上下文的来源）`);
console.log(`自己发的消息: ${parsed.self?.length ?? 0} 条（右对齐识别）`);
