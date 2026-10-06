/**
 * 全路径验证：回复 / 记忆整理 / 人生模拟 三条路径都在开启思考下跑通。
 */
import { loadConfig } from '../src/config.js';
import { generateReply, generateMemoryPatch, generateLifeSimulation } from '../src/llm.js';

const cfg = loadConfig({ argv: [] });
console.log('=== 生效配置 ===');
console.log('  enableThinking :', cfg.llm.enableThinking);
console.log('  maxTokens      :', cfg.llm.maxTokens, '| timeoutMs:', cfg.llm.timeoutMs);
console.log('  memory         : maxTokens', cfg.memory.maxTokens, '| timeoutMs', cfg.memory.timeoutMs);
console.log('  life           : maxTokens', cfg.life.maxTokens, '| timeoutMs', cfg.life.timeoutMs);
console.log('');

let allOk = true;

// ---------- 1. 回复 ----------
console.log('========== 1. 聊天回复 ==========');
for (const [name, text] of [
  ['寒暄', '在干嘛呢'],
  ['动脑', '帮我想三个适合周末去玩的室内活动，简单说理由'],
]) {
  const t0 = Date.now();
  const r = await generateReply(cfg, {
    conversation: '测试群', time: '21:30', title: '-', sender: '群友甲',
    text, isGroup: true,
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const ok = r.ok && r.reply;
  if (!ok) allOk = false;
  console.log(`  [${name}] ${dt}s  ${ok ? '✅' : '❌'}  ${r.reply ?? r.reason}`);
  console.log(`      completion=${r.usage?.completion_tokens}`);
}

// ---------- 2. 记忆整理 ----------
console.log('\n========== 2. 记忆整理（输出 JSON）==========');
{
  const t0 = Date.now();
  const r = await generateMemoryPatch(cfg, {
    conversation: '测试群',
    globalJson: '{}',
    conversationJson: '{}',
    transcript: [
      '21:30|-|群友甲|帮我想三个适合周末去玩的室内活动',
      '桌游互动有趣，适合朋友聚会；宅家观影舒适；手工制作放松。',
      '21:32|-|群友甲|谢了',
      '小事',
    ].join('\n'),
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (!r.ok) allOk = false;
  console.log(`  耗时 ${dt}s  ok=${r.ok}  ${r.ok ? '✅' : '❌ ' + r.reason}`);
  console.log(`  completion=${r.usage?.completion_tokens}`);
  if (r.patch) console.log(`  patch: ${JSON.stringify(r.patch).slice(0, 220)}`);
}

// ---------- 3. 人生模拟 ----------
console.log('\n========== 3. 人生模拟 ==========');
{
  const t0 = Date.now();
  const r = await generateLifeSimulation(cfg, {
    conversation: '测试群',
    persona: '小深',
    memoryDigest: '',
    lifeDigest: '',
    recent: [],
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (!r.ok) allOk = false;
  console.log(`  耗时 ${dt}s  ok=${r.ok}  ${r.ok ? '✅' : '❌ ' + r.reason}`);
  console.log(`  completion=${r.usage?.completion_tokens}`);
  if (r.life) console.log(`  life: ${JSON.stringify(r.life).slice(0, 220)}`);
}

console.log('\n' + '='.repeat(50));
console.log(allOk ? '三条路径全部通过 ✅' : '有路径失败 ❌');
process.exit(allOk ? 0 : 1);
