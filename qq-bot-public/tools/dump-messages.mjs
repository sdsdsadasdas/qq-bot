/** 打印 buildMessages 实际生成的消息内容 */
import { loadConfig } from '../src/config.js';
import { buildMessages } from '../src/llm.js';

const cfg = loadConfig({ argv: [] });

const msgs = buildMessages(cfg, {
  conversation: '测试群',
  pendingIncoming: ['群友|帮我想三个适合周末去玩的室内活动，简单说理由'],
  transcript: '群友|帮我想三个适合周末去玩的室内活动，简单说理由',
  isGroup: true,
});

console.log('消息条数:', msgs.length);
msgs.forEach((m, i) => {
  console.log('');
  console.log(`===== [#${i}] role=${m.role} =====`);
  console.log(m.content);
});
