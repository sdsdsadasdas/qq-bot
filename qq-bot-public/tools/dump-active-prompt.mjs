/** 用运行时 state 还原机器人【实际】使用的提示词。 */
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { activeSystemPrompt, isTakeoverActive } from '../src/takeover.js';
import { buildMessages } from '../src/llm.js';

const cfg = loadConfig({ argv: [] });

// state.json 里的 takeoverEnabled 才是运行时真值
let state = {};
try { state = JSON.parse(fs.readFileSync('state.json', 'utf8')); } catch (e) { console.log('读 state.json 失败:', e.message); }

console.log('========== 运行时状态 ==========');
console.log('state.takeoverEnabled :', state.takeoverEnabled);
console.log('config.persona.enabled:', cfg.persona?.enabled);
console.log('isTakeoverActive()    :', isTakeoverActive(state, cfg));
console.log('');

const sys = activeSystemPrompt(state, cfg);
console.log(`========== 实际发出的 system（${sys.length} 字）==========`);
console.log(sys);
console.log('');

console.log('========== 完整消息结构 ==========');
const msgs = buildMessages({ ...cfg, systemPrompt: sys }, {
  conversation: '测试群', time: '21:30', title: '-', sender: '群友甲',
  text: '在干嘛呢', isGroup: true,
});
msgs.forEach((m, i) => {
  console.log(`[#${i}] role=${m.role}  ${m.content.length} 字`);
});
console.log('');
console.log('===== user 轮内容 =====');
console.log(msgs[1].content);
