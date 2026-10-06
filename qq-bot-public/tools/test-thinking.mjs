/**
 * 实测开启思考后，机器人真实回复的延迟与质量。
 *
 * 注意：buildMessages 不使用 ctx.pendingIncoming（那是内部变量），
 * 而是用 renderIncomingLine(ctx) 从【字段】重新构造消息行。
 * 所以 ctx 必须提供 { time, title, sender, text } —— 少一个，
 * 内容就会退化成默认值（'某人' / '-'），模型看不到用户说的话。
 * 这是我上一版测试脚本踩的坑。
 */
import { loadConfig } from '../src/config.js';
import { generateReply } from '../src/llm.js';

const cfg = loadConfig({ argv: [] });
console.log('enableThinking =', cfg.llm.enableThinking, '| maxTokens =', cfg.llm.maxTokens);
console.log('');

const cases = [
  { name: 'T1 普通寒暄', text: '在干嘛呢' },
  { name: 'T2 需要动脑', text: '帮我想三个适合周末去玩的室内活动，简单说理由' },
  { name: 'T3 简单事实', text: '1+1等于几' },
  { name: 'T4 群聊调侃', text: '示例昵称今天怎么这么安静' },
];

const times = [];
for (const c of cases) {
  const ctx = {
    conversation: '测试群',
    time: '21:30',
    title: '-',
    sender: '群友甲',
    text: c.text,
    isGroup: true,
  };
  const t0 = Date.now();
  const r = await generateReply(cfg, ctx);
  const dt = Date.now() - t0;
  times.push(dt);

  console.log(`--- ${c.name} (${(dt / 1000).toFixed(1)}s) ---`);
  console.log(`  用户: ${c.text}`);
  console.log(`  回复: ${r.reply ?? '(空)'}   [ok=${r.ok}${r.reason ? ' reason=' + r.reason : ''}]`);
  console.log(`  completion=${r.usage?.completion_tokens} prompt=${r.usage?.prompt_tokens}`);
  console.log('');
}

const avg = times.reduce((a, b) => a + b, 0) / times.length;
console.log(`平均延迟: ${(avg / 1000).toFixed(1)}s  最长: ${(Math.max(...times) / 1000).toFixed(1)}s`);
