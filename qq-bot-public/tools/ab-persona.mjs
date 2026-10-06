/**
 * 拟人度 A/B 测试台。
 * 用法：node tools/ab-persona.mjs [promptFile]
 *   promptFile 省略时用机器人当前生效的 persona 提示词。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { chatOnce } from '../src/llm.js';
import { activeSystemPrompt } from '../src/takeover.js';

const cfg = loadConfig({ argv: [] });
let state = {};
try { state = JSON.parse(fs.readFileSync('state.json', 'utf8')); } catch {}

const promptFile = process.argv[2];
const sysPrompt = promptFile
  ? fs.readFileSync(promptFile, 'utf8').trim()
  : activeSystemPrompt(state, cfg);

console.log(`提示词来源: ${promptFile ?? '(机器人当前生效)'}`);
console.log(`长度: ${sysPrompt.length} 字`);
console.log('');

// 真实群聊场景（覆盖机器人实际会遇到的情况）
const cases = [
  { who: '群友甲', text: '在干嘛呢' },
  { who: '群友甲', text: '示例昵称今天怎么这么安静' },
  { who: '群友甲', text: '这个模型好傻啊' },
  { who: '群友乙', text: '晚上吃啥好' },
  { who: '群友甲', text: '你会写代码吗' },
  { who: '群友丙', text: '今天好累啊，加班到现在' },
  { who: '群友甲', text: '推荐个电影' },
  { who: '群友乙', text: '哈哈哈哈笑死我了' },
  { who: '群友甲', text: '你是谁' },
  { who: '群友乙', text: '明天周末了！' },
];

console.log('='.repeat(64));
for (const c of cases) {
  const line = `21:30|-|${c.who}|${c.text}`;
  const t0 = Date.now();
  const r = await chatOnce(cfg, {
    messages: [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: `现在需要你回复这一条：\n${line}\n\n直接给出你要打的那句话。` },
    ],
    maxTokens: 4096,
    temperature: 1,
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const out = r.ok ? r.content.trim() : `[失败 ${r.reason}]`;
  console.log(`【${c.who}】${c.text}`);
  console.log(`  → ${out}   (${dt}s, ${r.usage?.completion_tokens} tok)`);
  console.log('');
}
