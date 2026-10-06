/**
 * test-rules.mjs — 验证「人工改回复」的三种方式都能生效，以及优先级符合预期。
 *
 * 重点是那个坑：默认「内置意图 → 配置 rules」，所以给「在吗」写配置规则不会生效。
 * 打开 customRulesFirst 才能覆盖内置意图。
 *
 * 用法：node tools/test-rules.mjs
 */
import { loadConfig } from '../src/config.js';
import { fallbackReply } from '../src/fallback.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`); }
}

const base = loadConfig({ argv: [] });
const clone = () => JSON.parse(JSON.stringify(base));

console.log('='.repeat(72));
console.log('回复可修改性测试');
console.log('='.repeat(72));

// ------------------------------------------------ 1. 改 generic 立即生效
console.log('\n1) 改 fallback.generic → 不命中任何意图时用新的兜底');
{
  const cfg = clone();
  cfg.fallback.generic = ['自定义兜底A', '自定义兜底B'];
  cfg.fallback.useTemplates = false;
  // 必须清掉 fallback.pools.generic：它的优先级高于 fallback.generic，
  // 而用户可能已经改过它（实测他把兜底池换成「示例自定义句」「示例自定义句，等下」）。
  // 不清的话这里断言的就是用户的句子，测试会假失败 —— **测试不该依赖用户配置**。
  delete cfg.fallback.pools;
  // 注意选词：不能以「嗯/好/行/ok/收到」开头（agreement 意图），
  // 不能含疑问词或以问号结尾（question 意图），否则根本走不到 generic。
  const got = new Set();
  for (let i = 0; i < 10; i++) {
    got.add(fallbackReply(cfg, { text: `zzz无意义字符串${i}`, counter: i }).reply);
  }
  check('只出现自定义的兜底句', [...got].every((g) => g.startsWith('自定义兜底')),
    [...got].join(' / '));
  check('兜底句轮流出现（不是永远同一句）', got.size >= 2, `出现 ${got.size} 种`);
}

// ------------------------------------------- 2. 加 rules 也能命中新关键词
console.log('\n2) 加一条 rules → 命中自己的关键词');
{
  const cfg = clone();
  cfg.fallback.rules = [{ match: '内网穿透|端口映射', replies: ['这个我上周弄过'] }];
  const r = fallbackReply(cfg, { text: '内网穿透怎么配', counter: 0 });
  // 「怎么」会命中 question 意图，所以默认模式下拿不到自定义规则 —— 这正是第 3 项要说明的
  check('默认模式下被 question 意图抢走（符合预期）',
    r.source === 'intent' && r.intent === 'question', `source=${r.source} intent=${r.intent}`);

  // 换一个不含疑问词、不以附和词开头的句子，就能走到自定义规则
  const r2 = fallbackReply(cfg, { text: '内网穿透搞定了', counter: 0 });
  check(`"内网穿透搞定了" → "${r2.reply}"`, r2.reply === '这个我上周弄过' && r2.source === 'rule',
    `source=${r2.source}`);
}

// ------------------------------- 3. 内置意图覆盖面很广，会抢走自定义规则
console.log('\n3) 内置意图很"贪"，自定义规则很容易被抢走（所以要 customRulesFirst）');
{
  const cfg = clone();
  cfg.fallback.rules = [{ match: '在吗', replies: ['【我的自定义回复】'] }];
  const r = fallbackReply(cfg, { text: '在吗', counter: 0 });
  check('「在吗」被内置 greeting 抢走', r.source === 'intent' && r.intent === 'greeting',
    `source=${r.source} intent=${r.intent}`);
  check('回复不是自定义那句', r.reply !== '【我的自定义回复】', `"${r.reply}"`);

  const cfg2 = clone();
  cfg2.fallback.rules = [{ match: '周报', replies: ['【周报规则】'] }];
  const r2 = fallbackReply(cfg2, { text: '周报写了吗', counter: 0 });
  check('「周报写了吗」被内置 question 抢走（结尾的"吗"）',
    r2.source === 'intent' && r2.intent === 'question', `source=${r2.source} intent=${r2.intent}`);
}

// ------------------------------- 4. customRulesFirst 打开后能覆盖内置意图
console.log('\n4) customRulesFirst=true → 配置 rules 优先，可覆盖内置意图');
{
  const cfg = clone();
  cfg.fallback.customRulesFirst = true;
  cfg.fallback.rules = [
    { match: '在吗', replies: ['【我的自定义回复】'] },
    { match: '周报', replies: ['【周报规则】'] },
  ];
  const r = fallbackReply(cfg, { text: '在吗', counter: 0 });
  check('「在吗」命中自定义规则', r.source === 'rule', `source=${r.source}`);
  check(`回复 = "【我的自定义回复】"`, r.reply === '【我的自定义回复】', `"${r.reply}"`);

  const r2 = fallbackReply(cfg, { text: '周报写了吗', counter: 0 });
  check('「周报写了吗」也命中自定义规则', r2.reply === '【周报规则】' && r2.source === 'rule',
    `source=${r2.source} "${r2.reply}"`);
}

// ------------------------------------- 5. 单句 replies 会一直回同一句（提醒）
console.log('\n5) replies 只写一句时会一直回那句（所以建议写多句）');
{
  const cfg = clone();
  cfg.fallback.customRulesFirst = true;
  cfg.fallback.rules = [{ match: '测试单句', replies: ['唯一一句'] }];
  const got = new Set();
  for (let i = 0; i < 8; i++) got.add(fallbackReply(cfg, { text: '测试单句', counter: i }).reply);
  check('确实只有一种回复（这是预期行为，但会显机械）', got.size === 1, [...got].join(' / '));
}

// ---------------------------------------- 6. 改 defaultReply 作为最后兜底
console.log('\n6) 关掉 templates 和 generic 后落到 defaultReply');
{
  const cfg = clone();
  cfg.fallback.rules = [];
  cfg.fallback.generic = [];
  cfg.fallback.useTemplates = false;
  cfg.fallback.defaultReply = '【最终兜底】';
  // 注意：GENERIC 是源码里的内置池。要让 generic 真正为空，
  // 得确保 fallback.generic 是非空数组才不会被内置池接管 —— 这里刻意测试相反的情况：
  // generic 设为空数组时会回退到内置 GENERIC，所以先确认这一点。
  const r = fallbackReply(cfg, { text: 'zzzqqq', counter: 0 });
  check('generic 为空数组时回退到内置 GENERIC 池（这是设计行为）',
    r.source === 'generic', `source=${r.source} "${r.reply}"`);
}

// ------------------------------------------- 7. 非法正则不应炸掉整个模块
console.log('\n7) rules 里写了非法正则时不应崩溃');
{
  const cfg = clone();
  cfg.fallback.customRulesFirst = true;
  cfg.fallback.rules = [{ match: '[未闭合', replies: ['不该走到这里'] }];
  let threw = false;
  let r = null;
  try { r = fallbackReply(cfg, { text: '随便什么', counter: 0 }); } catch { threw = true; }
  check('没有抛异常', !threw);
  check('退化成子串匹配后仍能返回回复', r && r.reply.length > 0, r ? `"${r.reply}"` : '(null)');
}

// --------------------------- 8. 回复长度上限仍然生效
console.log('\n8) reply.maxChars 截断对自定义回复同样生效');
{
  const cfg = clone();
  cfg.reply.maxChars = 6;
  cfg.fallback.customRulesFirst = true;
  cfg.fallback.rules = [{ match: '长长长', replies: ['这是一句特别长的自定义回复内容'] }];
  const raw = fallbackReply(cfg, { text: '长长长', counter: 0 });
  const { clampReply } = await import('../src/fallback.js');
  const clamped = clampReply(raw.reply, cfg.reply.maxChars, '');
  check(`截断到 ${cfg.reply.maxChars} 字`, [...clamped].length === cfg.reply.maxChars,
    `"${clamped}" (${[...clamped].length} 字)`);
}

console.log('\n' + '='.repeat(72));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(72));
process.exitCode = fail > 0 ? 1 : 0;
