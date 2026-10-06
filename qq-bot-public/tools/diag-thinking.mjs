/**
 * 诊断：开启思考后，回复路径的行为。
 * 直接调用 chatOnce，把 ok/reason/hadReasoning/usage 都打出来。
 */
import { loadConfig } from '../src/config.js';
import { chatOnce, buildMessages } from '../src/llm.js';

const cfg = loadConfig({ argv: [] });
console.log('enableThinking =', cfg.llm.enableThinking, '| maxTokens =', cfg.llm.maxTokens);
console.log('');

const cases = [
  { name: 'T1 普通寒暄', text: '在干嘛呢' },
  { name: 'T2 需要动脑', text: '帮我想三个适合周末去玩的室内活动，简单说理由' },
  { name: 'T3 简单问题', text: '1+1等于几' },
];

for (const c of cases) {
  const msgs = buildMessages(cfg, {
    conversation: '测试群',
    pendingIncoming: [`群友|${c.text}`],
    transcript: `群友|${c.text}`,
    isGroup: true,
  });
  const t0 = Date.now();
  const r = await chatOnce(cfg, { messages: msgs });
  const dt = Date.now() - t0;

  console.log(`--- ${c.name} ---`);
  console.log(`  耗时       : ${(dt / 1000).toFixed(1)}s`);
  console.log(`  ok         : ${r.ok}`);
  console.log(`  reason     : ${r.reason ?? '-'}`);
  console.log(`  hadReasoning: ${r.hadReasoning}`);
  console.log(`  content    : ${JSON.stringify((r.content ?? '').slice(0, 120))}`);
  console.log(`  reasoning  : ${JSON.stringify(String(r.reasoning ?? '').slice(0, 120))}`);
  console.log(`  usage      : ${JSON.stringify(r.usage ?? {})}`);
  console.log(`  prompt 消息数: ${msgs.length}`);
  console.log('');
}
