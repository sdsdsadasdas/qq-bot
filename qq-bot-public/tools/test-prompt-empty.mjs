/**
 * test-prompt-empty.mjs — 回归测试：人设提示词被清空时的行为。
 *
 * 背景（真实 bug）：
 *   用户在控制台里改了人设提示词，点保存。如果那一栏是空的，
 *   保存会写进 `[""]` 或 `[]`。而 **`[]` 在 JS 里是 truthy**，
 *   于是 `activeSystemPrompt` 的判断通过、返回空字符串 —— 默认提示词被丢掉。
 *
 *   后果不只是"没人设"：空 content 会让 **API 直接报错**，
 *   机器人静默降级到本地规则。用户看到的是"回复突然变机械了"，
 *   根本不会联想到是自己清空了提示词那一栏。
 *
 * 修法两道：
 *   1. src/takeover.js  —— 空提示词回落到 llm.systemPrompt
 *   2. gui/server.js    —— 全空的提示词不写盘，保留原值
 *
 * 用法：node tools/test-prompt-empty.mjs [控制台端口]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { activeSystemPrompt, normalizePrompt } from '../src/takeover.js';
import { guardConfigFile, consoleServes, skipConsole } from './testkit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = path.join(ROOT, 'config.json');
const PORT = Number(process.argv[2]) || 7788;

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`); }
}

console.log('='.repeat(70));
console.log('空人设提示词的回落测试');
console.log('='.repeat(70));

const original = fs.readFileSync(CFG, 'utf8');

// 这个测试要写真实 config.json（验证"空人设被拦住"要经过控制台那条路），
// 所以挂上护栏：异常 / Ctrl+C / 被 kill 都还原，且一开始就是坏值会警告。
// 为什么必须这样：原来还原只是脚本最后一句，中途被打断就把
// persona.systemPrompt 永久留成 ["【改过了】<时间戳>","第二行"]（真出过）。
const guard = guardConfigFile(CFG);

// ------------------------------------------------------ 1. normalizePrompt
console.log('\n1) normalizePrompt 对各种空值都返回空字符串');
{
  const cases = [[], [''], ['', '', ''], '   ', '\n\n', null, undefined];
  for (const v of cases) {
    const got = normalizePrompt(v);
    check(`normalizePrompt(${JSON.stringify(v)}) === ''`, got === '', `实际 ${JSON.stringify(got)}`);
  }
  check('正常数组被拼成多行', normalizePrompt(['a', 'b']).includes('\n'), JSON.stringify(normalizePrompt(['a', 'b'])));
  check('正常字符串原样返回', normalizePrompt('hello') === 'hello');
}

// --------------------------------------------- 2. activeSystemPrompt 回落
console.log('\n2) 提示词为空时必须回落到 llm.systemPrompt（不能返回空串）');
{
  const withPrompt = (personaPrompt) => {
    const raw = JSON.parse(original);
    raw.persona.systemPrompt = personaPrompt;
    fs.writeFileSync(CFG, JSON.stringify(raw, null, 2), 'utf8');
    const cfg = loadConfig({ argv: [] });
    return { cfg, sp: activeSystemPrompt({ takeoverEnabled: true }, cfg) };
  };

  const cases = [
    ['空数组 []', []],
    ['[""]', ['']],
    ['["","",""]', ['', '', '']],
    ['纯空白 "   "', '   '],
    ['只有换行', '\n\n\n'],
  ];

  for (const [label, val] of cases) {
    const { cfg, sp } = withPrompt(val);
    const ok = sp.length > 0;
    check(`${label} → 得到非空提示词`, ok, `长度 ${sp.length}`);
    check(`${label} → 回落到 llm.systemPrompt`, sp === normalizePrompt(cfg.llm.systemPrompt),
      ok ? '' : '返回了空串，会导致 API 报错');
  }

  // 非空时应该用 persona 的
  const { sp: spOk } = withPrompt(['自定义人设']);
  check('非空时用 persona 的提示词', spOk === '自定义人设', JSON.stringify(spOk));

  // 非接管模式下用 llm 的
  const raw = JSON.parse(original);
  raw.persona.systemPrompt = ['接管用人设'];
  fs.writeFileSync(CFG, JSON.stringify(raw, null, 2), 'utf8');
  const cfg2 = loadConfig({ argv: [] });
  const spOff = activeSystemPrompt({ takeoverEnabled: false }, cfg2);
  check('非接管模式用 llm.systemPrompt', spOff === normalizePrompt(cfg2.llm.systemPrompt),
    JSON.stringify(spOff.slice(0, 30)));
}

fs.writeFileSync(CFG, original, 'utf8');

// ------------------------------------------------- 3. 控制台的写入保护
console.log('\n3) 控制台把空提示词写盘时要被拦住（不发坏值）');
// 这一节要**通过控制台**写 config.json 再读回来断言，所以先确认端口上那个控制台
// 服务的就是这份代码。机器上可能跑着别的副本（导出发布包之后最常见：
// 包里的测试连的是主项目那个控制台），那时写的是自己这份、读回来的是别人那份，
// 红得莫名其妙而且很难查。对不上就整节跳过，不计 pass/fail。
//
// ⚠ 原来 `catch` 里只有一句 `process.exitCode = 1` —— **它不会退出**，
//   后面的断言照样执行、集体变红。改成 if/else 包住整节才有"跳过"的效果。
const ro = await consoleServes(ROOT, PORT);
if (!ro.ok) {
  skipConsole('控制台把空提示词写盘时要被拦住（第 3 节整节）', ro.reason);
} else {
  const post = (body) => fetch(`http://127.0.0.1:${PORT}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());

  // 先写一个正常值作为基准
  const GOOD = '【基准人设】' + Date.now();
  await post({ config: { 'persona.systemPrompt': [GOOD] } });
  let cur = JSON.parse(fs.readFileSync(CFG, 'utf8')).persona.systemPrompt;
  check('基准值写入成功', String(cur).includes('基准人设'), JSON.stringify(cur));

  // 再试着写空值 —— 应该被拦住，保留上一个值
  const r1 = await post({ config: { 'persona.systemPrompt': [''] } });
  cur = JSON.parse(fs.readFileSync(CFG, 'utf8')).persona.systemPrompt;
  check('[""] 被拦住，保留了原值', String(cur).includes('基准人设'),
    `applied=${JSON.stringify(r1.applied)} 现值=${JSON.stringify(cur)}`);

  const r2 = await post({ config: { 'persona.systemPrompt': [] } });
  cur = JSON.parse(fs.readFileSync(CFG, 'utf8')).persona.systemPrompt;
  check('[] 被拦住，保留了原值', String(cur).includes('基准人设'), JSON.stringify(cur));

  const r3 = await post({ config: { 'persona.systemPrompt': '   ' } });
  cur = JSON.parse(fs.readFileSync(CFG, 'utf8')).persona.systemPrompt;
  check('纯空白被拦住', String(cur).includes('基准人设'), JSON.stringify(cur));

  check('界面收到"已忽略"的提示', JSON.stringify(r1.applied).includes('忽略'),
    JSON.stringify(r1.applied));

  // 正常值仍然能写
  const OK2 = '【改过了】' + Date.now();
  await post({ config: { 'persona.systemPrompt': [OK2, '第二行'] } });
  cur = JSON.parse(fs.readFileSync(CFG, 'utf8')).persona.systemPrompt;
  check('正常值仍然能写进去', String(cur).includes('改过了'), JSON.stringify(cur));

  // 还原（护栏也会在异常/信号时做一遍，这里显式做是为了能立刻断言）
  guard.restore();
  check('配置已还原', fs.readFileSync(CFG, 'utf8') === original);
  check('进来的时候文件是干净的（上一次没留下测试痕迹）', guard.dirty === false,
    guard.dirty ? '有残留，去 config.json.bak-* 恢复' : '');
}

console.log('\n' + '='.repeat(70));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(70));
process.exitCode = fail > 0 ? 1 : 0;
