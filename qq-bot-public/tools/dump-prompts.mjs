/** 导出机器人实际使用的提示词（避免 PowerShell 读取 GBK 文件导致乱码）。 */
import { loadConfig } from '../src/config.js';
import { buildMessages } from '../src/llm.js';

const cfg = loadConfig({ argv: [] });

console.log('========== persona（人设）==========');
console.log('enabled       :', cfg.persona?.enabled);
console.log('replyAllWhenActive:', cfg.persona?.replyAllWhenActive);
console.log('takeoverPatterns:', JSON.stringify(cfg.persona?.takeoverPatterns));
console.log('');
console.log('---------- persona.systemPrompt ----------');
const ps = cfg.persona?.systemPrompt;
if (Array.isArray(ps)) ps.forEach((l, i) => console.log(`[${i}] ${l}`));
else console.log(ps);
console.log('');

console.log('========== llm.systemPrompt ==========');
console.log(cfg.llm?.systemPrompt);
console.log('');

console.log('========== 实际发给模型的消息 ==========');
const msgs = buildMessages({ ...cfg, persona: { ...cfg.persona, enabled: true } }, {
  conversation: '测试群', time: '21:30', title: '-', sender: '群友甲',
  text: '在干嘛呢', isGroup: true,
});
msgs.forEach((m, i) => {
  console.log('');
  console.log(`===== [#${i}] role=${m.role} (${m.content.length} 字) =====`);
  console.log(m.content);
});
