/**
 * 把新提示词写进 config.json —— 两处都换。
 *
 * 为什么必须两处都换：
 *   activeSystemPrompt() 在【接管模式】下用 persona.systemPrompt，
 *   非接管时用 llm.systemPrompt。只换一处会导致切换模式时语气突变。
 *   （实测 state.takeoverEnabled = true，所以真正在用的是 persona 那份。）
 */
import fs from 'node:fs';

const cfgPath = 'config.json';
const raw = fs.readFileSync('prompts/persona-v2.txt', 'utf8').trim();

// persona.systemPrompt 在配置里是「按行分行」的字符串数组，保持这个风格
const asLines = raw.split('\n');

const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const oldLlm = String(cfg.llm.systemPrompt ?? '');
const oldPersona = Array.isArray(cfg.persona.systemPrompt)
  ? cfg.persona.systemPrompt.join('\n')
  : String(cfg.persona.systemPrompt ?? '');

console.log('=== 替换前 ===');
console.log('  llm.systemPrompt     长度:', oldLlm.length);
console.log('  persona.systemPrompt 长度:', oldPersona.length);
console.log('  persona 是数组        :', Array.isArray(cfg.persona.systemPrompt));

cfg.llm.systemPrompt = raw;
cfg.persona.systemPrompt = asLines;

fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

const back = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
console.log('');
console.log('=== 替换后 ===');
console.log('  llm.systemPrompt     长度:', String(back.llm.systemPrompt).length);
console.log('  persona.systemPrompt 长度:',
  (Array.isArray(back.persona.systemPrompt)
    ? back.persona.systemPrompt.join('\n')
    : String(back.persona.systemPrompt)).length);
console.log('  两者内容一致          :',
  String(back.llm.systemPrompt) ===
  (Array.isArray(back.persona.systemPrompt)
    ? back.persona.systemPrompt.join('\n') : String(back.persona.systemPrompt)));
console.log('  JSON 合法             : 是');
