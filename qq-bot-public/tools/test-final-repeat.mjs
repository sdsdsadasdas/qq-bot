/**
 * 终极验证（走真实路径）：
 * 复现「困到睡着了」那批对话，历史里带三条重复自述，
 * 检查 ① buildMessages 是否折叠了重复 ② 回复是否还复读。
 *
 * 上一版测试直接给 chatOnce 传 messages，绕过了 buildMessages，
 * 所以测不到折叠逻辑 —— 这是修正版。
 */
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { chatOnce, buildMessages } from '../src/llm.js';
import { renderLife } from '../src/life.js';
import { activeSystemPrompt } from '../src/takeover.js';

const cfg = loadConfig({ argv: [] });
let state = {};
try { state = JSON.parse(fs.readFileSync('state.json', 'utf8')); } catch {}

// 这个脚本是"拿本机真实的生活日志复现问题"的诊断脚本（不是断言测试），
// 没有 life.json 就没得跑。而 life.json 是**运行数据**，导出的发布包里不含它，
// 所以这里明确跳过 —— 直接抛 ENOENT 会让人以为项目坏了。
if (!fs.existsSync('life.json')) {
  console.log('跳过：没有 life.json（运行数据，发布包里不含）。');
  console.log('      想跑这个诊断：先让机器人跑一阵人生模拟，或 node src/bot.js --once 生成。');
  process.exit(0);
}

const sys = activeSystemPrompt(state, cfg);
const lifeDigest = renderLife(JSON.parse(fs.readFileSync('life.json', 'utf8')), cfg);

// 还原当时的历史：三条一模一样的自述
const stuck = '困到睡着了 (´·ω·`)';
const history = [
  { side: 'other', text: '我以为你睡着了', sender: '群友', time: '21:11', title: '-' },
  { side: 'self', text: stuck },
  { side: 'other', text: '醒醒', sender: '群友', time: '21:12', title: '-' },
  { side: 'self', text: stuck },
  { side: 'other', text: '你还在吗', sender: '群友', time: '21:12', title: '-' },
  { side: 'self', text: stuck },
];

const questions = ['我知道了', '这啥回复', '什么鬼', '玛德你是人啊'];
let bad = 0;

for (const q of questions) {
  const msgs = buildMessages({ ...cfg, systemPrompt: sys }, {
    conversation: '测试群',
    history,
    time: '21:13',
    title: '-',
    sender: '群友',
    text: q,
    isGroup: true,
    lifeDigest,
  });

  const t0 = Date.now();
  const r = await chatOnce(cfg, { messages: msgs, maxTokens: 4096, temperature: 1 });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const out = (r.content ?? '').trim();
  const echo = out.includes('困') || out.includes('睡') || out.includes('眼皮');
  if (echo) bad++;
  console.log(`【群友】${q}`);
  console.log(`  → ${out}   (${dt}s)`);
  console.log(`  ${echo ? '❌ 仍在复读' : '✅ 正常'}`);
}

// 展示折叠后的历史结构
const probe = buildMessages({ ...cfg, systemPrompt: sys }, {
  conversation: '测试群', history, time: '21:13', title: '-',
  sender: '群友', text: '测试', isGroup: true, lifeDigest,
});
console.log('');
console.log('=== 折叠后的消息结构 ===');
probe.forEach((m, i) => {
  const one = m.content.split('\n')[0].slice(0, 42);
  console.log(`  [#${i}] ${m.role.padEnd(9)} ${one}${m.content.length > 42 ? '…' : ''}`);
});
const selfCount = probe.filter((m) => m.role === 'assistant').length;
console.log(`  assistant 轮数: ${selfCount}（原历史里有 3 条重复自述）`);

console.log('');
console.log('='.repeat(50));
console.log(bad === 0 ? '全部正常，复读已消除 ✅' : `${bad}/${questions.length} 条仍在复读`);
