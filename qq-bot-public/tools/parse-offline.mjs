/**
 * parse-offline.mjs — 用一份真实 OCR 结果离线验证解析器。
 *
 * 用法：
 *   node tools/parse-offline.mjs <ocr-json> [config.json]
 *
 * ocr-json 是 tools/ocr-image.ps1 的输出。这样可以在不碰 QQ 的情况下反复调解析规则。
 * 调试解析逻辑时优先用这个，比每次截图快得多。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { parseChat, isMentioned } from '../src/parse.js';
import { decide, loadState } from '../src/gate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ocrFile = process.argv[2];
if (!ocrFile) {
  console.error('用法: node tools/parse-offline.mjs <ocr-json> [geometry-override.json]');
  process.exit(2);
}

const raw = fs.readFileSync(ocrFile, 'utf8');
const ocr = JSON.parse(raw.replace(/^\uFEFF/, ''));

const cfg = loadConfig({ argv: [] });
if (process.argv[3]) {
  cfg.geometry = { ...cfg.geometry, ...JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) };
}

const size = { w: ocr.imageW, h: ocr.imageH };
const parsed = parseChat(ocr.lines, size, cfg);

console.log('='.repeat(70));
console.log(`图像: ${size.w}x${size.h}   OCR 行数: ${ocr.lines.length}   engine: ${ocr.engine}`);
console.log(`会话名: "${parsed.conversation}"`);
console.log(`  标题栏候选: ${JSON.stringify(parsed.conversationCandidates)}`);
console.log(`时间戳: ${JSON.stringify(parsed.timestamps)}`);
console.log(`几何: msgLeft=${parsed.geometry.msgLeft.toFixed(0)} msgTop=${parsed.geometry.msgTop.toFixed(0)} ` +
            `msgBottom=${parsed.geometry.msgBottom.toFixed(0)} selfLeft=${parsed.geometry.selfLeft.toFixed(0)}`);
console.log('='.repeat(70));
console.log(`消息块: ${parsed.messages.length}  (他人 ${parsed.incoming.length} / 自己 ${parsed.self.length})`);
console.log('-'.repeat(70));

for (const m of parsed.messages) {
  const tag = m.side === 'incoming' ? '他人' : '自己';
  const men = isMentioned(m, cfg) ? '  <<< 被@' : '';
  console.log(`[${String(m.index).padStart(2)}] ${tag}  x=${String(Math.round(m.x)).padStart(4)} y=${String(Math.round(m.y)).padStart(4)}${men}`);
  if (m.sender) console.log(`      发送者: ${m.sender}`);
  console.log(`      内容  : ${m.text}`);
  if (m.rawLines.length > 1) console.log(`      原始行: ${JSON.stringify(m.rawLines)}`);
}

console.log('-'.repeat(70));

// 决策层：验证闸门
console.log(`白名单: ${JSON.stringify(cfg.trigger?.whitelist ?? [])}`);
const state = loadState();
state.seen = [];
state.sentReplies = [];
state.replyTimes = [];
const result = decide(cfg, state, parsed);
console.log(`决策: 会话「${result.conversationName}」${result.isGroup ? '群聊' : '私聊'} | 白名单${result.whitelisted ? '命中' : '未命中'}`);
console.log('-'.repeat(70));
for (const d of result.decisions) {
  console.log(`  ${d.reply ? '→ 回复' : '  跳过'}  "${d.message.text}"   (${d.reason})`);
}
const toReply = result.decisions.filter((d) => d.reply);
console.log('-'.repeat(70));
console.log(`应回复 ${toReply.length} 条:`);
for (const d of toReply) console.log(`   "${d.message.text}"`);

// 丢弃的行
const keptTexts = new Set();
for (const m of parsed.messages) for (const r of m.rawLines) keptTexts.add(r);
const dropped = ocr.lines
  .map((l) => l.text)
  .filter((t) => !keptTexts.has(t) && !parsed.timestamps.includes(t.replace(/\s+/g, '').replace(/：/g, ':')));
console.log(`未纳入消息的行: ${JSON.stringify(dropped)}`);
