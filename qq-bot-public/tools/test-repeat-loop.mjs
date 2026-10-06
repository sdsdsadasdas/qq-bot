/**
 * 场景还原：机器人陷入复读循环时，历史里堆了一串相同回复。
 * 验证新提示词能否打破这个锚定。
 */
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { chatOnce } from '../src/llm.js';
import { activeSystemPrompt } from '../src/takeover.js';

const cfg = loadConfig({ argv: [] });
let state = {};
try { state = JSON.parse(fs.readFileSync('state.json', 'utf8')); } catch {}
const sys = activeSystemPrompt(state, cfg);

console.log(`system 长度: ${sys.length}`);
console.log('');

// 还原真实历史：机器人自己重复说了三次同一句话
const stuckReply = '困到睡着了 (´·ω·`)';
const history = [
  { role: 'user', content: '21:10|-|群友|在吗' },
  { role: 'assistant', content: stuckReply },
  { role: 'user', content: '21:11|-|群友|这啥回复' },
  { role: 'assistant', content: stuckReply },
  { role: 'user', content: '21:12|-|群友|我前面说了什么你复述一下' },
  { role: 'assistant', content: stuckReply },
];

for (const q of ['什么鬼', '玛德你是人啊', '你在复读吗']) {
  const msgs = [
    { role: 'system', content: sys },
    ...history,
    { role: 'user', content: `现在需要你回复这一条：\n21:13|-|群友|${q}\n\n直接给出你要打的那句话。` },
  ];
  const t0 = Date.now();
  const r = await chatOnce(cfg, { messages: msgs, maxTokens: 4096, temperature: 1 });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const out = r.ok ? r.content.trim() : `[失败 ${r.reason}]`;
  const repeated = out.includes('困到睡着');
  console.log(`【群友】${q}`);
  console.log(`  → ${out}`);
  console.log(`  ${repeated ? '❌ 仍在复读' : '✅ 打破了复读'}   (${dt}s)`);
  console.log('');
}
