/**
 * 验证：记忆整理（输出 JSON）开思考会不会被截断。
 * 对比 enableThinking true / false 两种情况。
 */
import { loadConfig } from '../src/config.js';
import { chatOnce } from '../src/llm.js';

const base = loadConfig({ argv: [] });

// 构造一个接近真实的记忆整理请求（取 generateMemoryPatch 的提示词骨架）
const system = [
  '你是一个「记忆整理器」。你只输出 JSON，不输出任何解释、前后缀或代码块标记。',
  '',
  '规则：',
  '1. conversation.mood 是必填的。',
  '2. 其它字段只写**变化**。',
  '3. 不要编造。',
  '',
  '输出结构：',
  '{',
  '  "global": { "addFacts": [], "addLikes": [], "addDislikes": [] },',
  '  "conversation": { "mood": {"label":"","why":""}, "events": [], "relations": [], "topics": [] }',
  '}',
].join('\n');

const user = [
  '【全局记忆】{}',
  '',
  '【这个会话的记忆（测试群）】{}',
  '',
  '【刚刚发生的对话】',
  '21:30|-|群友甲|帮我想三个适合周末去玩的室内活动',
  '桌游互动有趣，适合朋友聚会；宅家观影舒适；手工制作放松。',
  '21:32|-|群友甲|谢了',
  '小事',
  '',
  '现在输出记忆差异 JSON。',
].join('\n');

for (const thinking of [false, true]) {
  const cfg = { llm: { ...base.llm, enableThinking: thinking } };
  const t0 = Date.now();
  const r = await chatOnce(cfg, {
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    maxTokens: 2000,
    temperature: 0.2,
    model: undefined,
    jsonMode: false,
    enableThinking: thinking,
  });
  const dt = Date.now() - t0;

  const txt = String(r.content ?? '');
  let parsed = null, parseErr = null;
  try { parsed = JSON.parse(txt.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); }
  catch (e) { parseErr = e.message; }

  console.log(`--- enableThinking=${thinking} ---`);
  console.log(`  耗时 ${(dt / 1000).toFixed(1)}s  ok=${r.ok}  completion=${r.usage?.completion_tokens}`);
  console.log(`  输出长度 ${txt.length} 字`);
  console.log(`  JSON 可解析: ${parsed ? '✅ 是' : '❌ 否 — ' + parseErr}`);
  console.log(`  内容开头: ${JSON.stringify(txt.slice(0, 100))}`);
  console.log('');
}
