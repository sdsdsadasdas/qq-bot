/**
 * verify-live.mjs — 现场核对机器人到底有没有把消息发进 QQ。
 *
 * 用法：node tools/verify-live.mjs
 *
 * 做三件事：
 *   1. 读 state.json，列出已发送的回复文本
 *   2. 现场截图 + OCR，看群里是否真的出现了这些文本
 *   3. 判断机器人自己的消息是否被正确识别为「自己」（右侧对齐），防自嗨是否生效
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ROOT } from '../src/config.js';
import { runPs } from '../src/ps.js';
import { parseChat } from '../src/parse.js';

const cfg = loadConfig({ argv: [] });

// ---- 1. 状态文件 ----
const stateFile = path.join(ROOT, 'state.json');
let state = null;
try {
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
} catch (e) {
  console.log(`读 state.json 失败: ${e.message}`);
}

if (state) {
  console.log('='.repeat(70));
  console.log(`已发送的回复 (${state.sentReplies.length} 条):`);
  for (const s of state.sentReplies) console.log(`  · ${s}`);
  console.log(`待回复队列: ${state.pending.length} 条`);
  for (const p of state.pending) console.log(`  · ${p.text}`);
  console.log(`回复时间戳: ${state.replyTimes.length} 次`);
  console.log(`计数器: ${JSON.stringify(state.counters)}`);
}

// ---- 2. 现场截图 + OCR ----
const shot = path.join(ROOT, '.verify-live.png');
const cap = await runPs('capture-window.ps1', [
  '-ProcessName', cfg.process?.name ?? 'QQ',
  '-OutImage', shot,
], { timeoutMs: 45000 });

if (!cap.ok) {
  console.log(`\n截图失败: ${cap.error}`);
  process.exit(0);
}

const ocr = await runPs('ocr-image.ps1', ['-ImagePath', shot, '-Language', cfg.ocr?.lang ?? 'zh-Hans-CN'],
  { timeoutMs: 45000 });

if (!ocr.ok) {
  console.log(`\nOCR 失败: ${ocr.error}`);
  process.exit(0);
}

console.log('\n' + '='.repeat(70));
console.log(`现场截图: ${ocr.imageW}x${ocr.imageH}，OCR ${ocr.lines.length} 行`);

const parsed = parseChat(ocr.lines, { w: ocr.imageW, h: ocr.imageH }, cfg);
console.log(`会话: "${parsed.conversation}"   消息 ${parsed.messages.length} 条 (他人 ${parsed.incoming.length} / 自己 ${parsed.self.length})`);
console.log('-'.repeat(70));

for (const m of parsed.messages) {
  const tag = m.side === 'self' ? '我  ' : '他人';
  console.log(`  ${tag} x=${String(Math.round(m.x)).padStart(4)} y=${String(Math.round(m.y)).padStart(4)}  "${m.text}"`);
}

// ---- 3. 核对 ----
console.log('='.repeat(70));
if (state && state.sentReplies.length) {
  const onScreen = parsed.messages.map((m) => m.text.replace(/\s/g, ''));
  let found = 0;
  console.log('核对：机器人发出的文本是否出现在屏幕上？');
  for (const s of state.sentReplies) {
    const key = s.replace(/\s/g, '');
    const hit = onScreen.some((t) => t.includes(key) || key.includes(t));
    console.log(`  ${hit ? '✓ 找到了' : '✗ 没找到'}  "${s}"`);
    if (hit) found++;
  }
  console.log(`\n结论: ${found}/${state.sentReplies.length} 条能在界面上看到`);

  if (state.sentReplies.length > 0 && found === 0) {
    console.log('  → 消息可能没真的发出去！检查 send-text.ps1 的粘贴与回车是否生效。');
  }

  // 自嗨检测：机器人发出去的话有没有被当成「他人消息」
  const asIncoming = parsed.incoming.filter((m) =>
    state.sentReplies.some((s) => m.text.replace(/\s/g, '').includes(s.replace(/\s/g, ''))));
  if (asIncoming.length) {
    console.log(`\n⚠ 防自嗨可能失效：有 ${asIncoming.length} 条机器人自己的话被识别成「他人消息」`);
    for (const m of asIncoming) console.log(`    "${m.text}"`);
  } else {
    console.log('防自嗨: 没有把机器人自己的话当成他人消息 ✓');
  }
} else {
  console.log('state.json 里还没有发送记录。');
}
