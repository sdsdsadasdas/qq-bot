/**
 * test-pools.mjs — 固定回复池的「可配置化」测试。
 *
 * 覆盖三件事：
 *   1. 默认状态：没有覆盖时用的就是内置默认
 *   2. 覆盖生效：config.fallback.pools 里写了就用它
 *   3. 落盘策略：只有和内置默认不同的才写进 config.json，改回默认会把键删掉
 *
 * 用法：node tools/test-pools.mjs [端口]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { resolvePools, BUILTIN_POOLS, POOL_LABELS, fallbackReply } from '../src/fallback.js';
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

/**
 * 造一份「用户没改过回复池」的配置。
 *
 * 为什么需要：用户会真的去改 config.json（实测他把 fallback.pools.generic
 * 换成了「示例自定义句」「示例自定义句，等下」这类自己的句子）。
 * 直接断言"生效值 == 内置默认"就会撞上他的自定义值而报错 ——
 * **测试不该依赖用户的状态**。
 *
 * 做法：清掉那两个用户可改的键，再看「没有覆盖时用内置默认」这条规则本身。
 */
function cfgWithoutUserPools(extra = {}) {
  const cfg = loadConfig({ argv: [] });
  const fallback = { ...cfg.fallback, ...extra };
  delete fallback.pools;
  if (!('generic' in extra)) delete fallback.generic;
  return { ...cfg, fallback };
}

console.log('='.repeat(70));
console.log('固定回复池可配置化测试');
console.log('='.repeat(70));

// ------------------------------------------------------------ 1. 内置默认
console.log('\n1) 内置默认池');
{
  check(`内置池数量 ${Object.keys(BUILTIN_POOLS).length}`, Object.keys(BUILTIN_POOLS).length >= 10);
  const noEmpty = Object.entries(BUILTIN_POOLS).filter(([, v]) => !Array.isArray(v) || v.length === 0);
  check('每个内置池都非空', noEmpty.length === 0, noEmpty.map(([k]) => k).join(', '));
  const missingLabel = Object.keys(BUILTIN_POOLS).filter((k) => !POOL_LABELS[k]);
  check('每个池都有中文说明（界面要用）', missingLabel.length === 0, missingLabel.join(', '));
}

// --------------------------------------------------- 2. 无覆盖时用内置默认
console.log('\n2) 优先级：pools > fallback.generic（老配置项）> 内置默认');
{
  // 用「用户没改过」的配置来验规则本身，不依赖用户当前存了什么
  const clean = cfgWithoutUserPools();
  const pools = resolvePools(clean);

  const diff = Object.keys(BUILTIN_POOLS)
    .filter((k) => JSON.stringify(pools[k]) !== JSON.stringify(BUILTIN_POOLS[k]));
  check('没有任何覆盖时，全部等于内置默认', diff.length === 0, diff.join(', '));

  // 老配置项 fallback.generic 应当生效
  const withLegacy = cfgWithoutUserPools({ generic: ['老的写法A', '老的写法B'] });
  check('fallback.generic（老配置项）生效',
    JSON.stringify(resolvePools(withLegacy).generic) === JSON.stringify(['老的写法A', '老的写法B']),
    JSON.stringify(resolvePools(withLegacy).generic));

  // pools.generic 的优先级高于 fallback.generic
  const both = cfgWithoutUserPools({ generic: ['老的写法'] });
  both.fallback.pools = { generic: ['新写法优先'] };
  check('pools.generic 优先于 fallback.generic',
    JSON.stringify(resolvePools(both).generic) === JSON.stringify(['新写法优先']),
    JSON.stringify(resolvePools(both).generic));

  // 老配置项为空数组时不该顶掉内置默认
  const emptyLegacy = cfgWithoutUserPools({ generic: [] });
  check('fallback.generic 为空数组时回退到内置默认',
    JSON.stringify(resolvePools(emptyLegacy).generic) === JSON.stringify(BUILTIN_POOLS.generic));
}

// -------------------------------------------------------- 3. 覆盖能生效
console.log('\n3) 写入 fallback.pools 后覆盖生效');
{
  const cfg = cfgWithoutUserPools();
  cfg.fallback.pools = { greeting: ['自定义问好A', '自定义问好B'], generic: ['自定义兜底'] };
  const pools = resolvePools(cfg);
  check('greeting 被覆盖', JSON.stringify(pools.greeting) === JSON.stringify(['自定义问好A', '自定义问好B']),
    JSON.stringify(pools.greeting));
  check('generic 被覆盖', JSON.stringify(pools.generic) === JSON.stringify(['自定义兜底']));
  check('未覆盖的池仍用默认', JSON.stringify(pools.thanks) === JSON.stringify(BUILTIN_POOLS.thanks));

  // 端到端：实际回复要用到覆盖后的句子
  const got = new Set();
  for (let i = 0; i < 12; i++) {
    got.add(fallbackReply(cfg, { text: '在吗', counter: i }).reply);
  }
  check('实际回复来自覆盖后的池', [...got].every((g) => g.startsWith('自定义问好')),
    [...got].slice(0, 4).join(' / '));
}

// ------------------------------------------------- 4. 空数组视为「没改」
console.log('\n4) 空数组视为没改（避免误清空成一句都发不出）');
{
  const cfg = loadConfig({ argv: [] });
  cfg.fallback.pools = { greeting: [] };
  const pools = resolvePools(cfg);
  check('空数组回退到内置默认', JSON.stringify(pools.greeting) === JSON.stringify(BUILTIN_POOLS.greeting));
}

// --------------------------------------------------- 5. 通过控制台写入/还原
console.log('\n5) 控制台写入与还原（会改完改回来）');
// 先问一句：这个端口上的控制台**服务的是不是我这份代码**。
//
// 为什么这一步不能省（真踩过）：这一段是"自己写 config.json、再读回来断言"，
// 而机器上可能跑着**另一个副本**的控制台（导出发布包之后最常见：
// 包里的测试连的是主项目那个控制台）。那时写的是自己这份、读回来的是别人那份，
// 于是红的莫名其妙 —— 查半天才发现是连错了对象。
// 对不上就整节跳过（不计 pass/fail），而不是让"这份代码没在跑"看起来像测试坏了。
//
// ⚠ 注意原来的 `catch` 里只有一句 `process.exitCode = 1` —— **它不会退出**，
//   后面的断言照样执行并集体变红。这里改成 if/else 包住整节：跳就干净地跳。
const ro = await consoleServes(ROOT, PORT);
if (!ro.ok) {
  skipConsole('控制台写入与还原（第 5 节整节）', ro.reason);
} else {
  const original = fs.readFileSync(CFG, 'utf8');
  // 护栏：这一段会通过控制台往真实 config.json 里写，异常/信号也必须还回去。
  // （原来只在最后一句还原 —— 中途被打断就把测试池永久留在用户配置里，真出过。）
  const guard = guardConfigFile(CFG);

  // 上面 consoleServes 已经问过"你是我要找的那个控制台吗"，所以这里直接取配置视图。
  const base = await (await fetch(`http://127.0.0.1:${PORT}/api/config`)).json();

  check('接口返回了 pools', base.pools && Object.keys(base.pools).length > 0,
    `${Object.keys(base.pools || {}).length} 项`);
  check('每项都带 label / effective / builtin / overridden',
    Object.values(base.pools).every((p) => p.label && Array.isArray(p.effective) && Array.isArray(p.builtin) && 'overridden' in p));

  // 注意：不能断言"全部未覆盖" —— 用户可能已经改过某些池（实测他就改了 generic）。
  // 只验证「overridden 标记与文件里实际有没有那个键一致」这条规则。
  {
    const rawNow = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    const inFile = new Set(Object.keys(rawNow.fallback?.pools ?? {}));
    const mismatch = Object.entries(base.pools)
      .filter(([k, p]) => Boolean(p.overridden) !== inFile.has(k))
      .map(([k]) => k);
    check('overridden 标记与 config.json 里的实际情况一致', mismatch.length === 0,
      mismatch.length ? `不一致: ${mismatch.join(', ')}` : `${inFile.size} 项被用户改过`);
  }

  const post = (body) => fetch(`http://127.0.0.1:${PORT}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());

  // 记录测试前的 pools 键集合，之后只验证"变化量"
  const poolsBeforeTest = new Set(Object.keys(JSON.parse(fs.readFileSync(CFG, 'utf8')).fallback?.pools ?? {}));

  // 写一个自定义池
  const w = await post({ pools: { greeting: ['测试甲', '测试乙', '测试丙'] } });
  check('写入返回 ok', w.ok === true, JSON.stringify(w.applied));

  const rawAfter = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  check('config.json 出现了 fallback.pools', rawAfter.fallback?.pools !== undefined);
  check('写的是三句', JSON.stringify(rawAfter.fallback.pools.greeting) === JSON.stringify(['测试甲', '测试乙', '测试丙']));
  check('接口视图标为已覆盖', w.view.pools.greeting.overridden === true);

  // 只应该多出 greeting 这一个键（用户原有的自定义键要保留，不能被这次写入抹掉）
  {
    const after = new Set(Object.keys(rawAfter.fallback.pools));
    const added = [...after].filter((k) => !poolsBeforeTest.has(k));
    const removed = [...poolsBeforeTest].filter((k) => !after.has(k));
    check('只新增了被改的那一项', added.length === 1 && added[0] === 'greeting', `新增: ${added.join(',') || '无'}`);
    check('用户原有的自定义项没被抹掉', removed.length === 0, `被抹掉: ${removed.join(',') || '无'}`);
  }

  // 其它键不能被破坏
  check('fallback 的其它键还在', rawAfter.fallback.rules !== undefined && rawAfter.fallback.generic !== undefined);
  check('$comment 注释还在', typeof rawAfter.fallback.$comment !== 'undefined');
  // 注意：pools 里用户原本的自定义项（如果有）必须原样保留，
  // 不能被"只写被改的那一项"这个逻辑顺手抹掉 —— 上面已经断言过 removed 为空。

  // 写回内置默认 → **greeting 这个键**应被删掉（不写一个等值的数组进配置）
  const w2 = await post({ pools: { greeting: BUILTIN_POOLS.greeting } });
  const rawBack = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  check('改回默认后 greeting 键被移除',
    rawBack.fallback?.pools?.greeting === undefined,
    JSON.stringify(rawBack.fallback?.pools?.greeting ?? null));
  check('接口视图回到未覆盖', w2.view.pools.greeting.overridden === false);
  // 用户原有的自定义项仍然在
  {
    const still = [...poolsBeforeTest].filter((k) => k !== 'greeting');
    const now = new Set(Object.keys(rawBack.fallback?.pools ?? {}));
    const lost = still.filter((k) => !now.has(k));
    check('用户原有的自定义项仍然在', lost.length === 0, `丢了: ${lost.join(',') || '无'}`);
  }

  // 全量恢复默认
  await post({ pools: { question: ['临时'] } });
  const w3 = await post({ resetPools: true });
  const rawReset = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  check('resetPools 清掉了整个 pools 段', rawReset.fallback?.pools === undefined);

  // 不认识的池名应被忽略
  await post({ pools: { 不存在的池: ['x'] } });
  const rawBad = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  check('不认识的池名被忽略', rawBad.fallback?.pools === undefined, JSON.stringify(rawBad.fallback?.pools));

  // 还原文件到测试前（护栏也会在异常/信号时做一遍）
  guard.restore();
  check('配置已还原到测试前', fs.readFileSync(CFG, 'utf8') === original);
  check('进来的时候文件是干净的（上一次没留下测试痕迹）', guard.dirty === false,
    guard.dirty ? '有残留，去 config.json.bak-* 恢复' : '');
}

console.log('\n6) 配置护栏：异常退出也必须把文件还回去');
{
  // 这一段是"测试自己的安全网"的测试。
  // 来由：曾经有个测试把 persona 写坏之后**没有还原**（还原写成了最后一句，
  // 中途被打断就没了），而它下一次跑会把坏值当基准 —— 一切照旧全绿，
  // 用户的配置却永久留着一句 "【改过了】<时间戳>"。所以护栏必须有，
  // 而且必须**真的在异常退出时生效**，不能只是"写在注释里的承诺"。
  const { spawnSync } = await import('node:child_process');
  const child = path.join(ROOT, 'tools', '_tmp-guard-child.mjs');
  const target = path.join(ROOT, 'tools', '_tmp-guard-target.json');
  const before = '{"persona":{"systemPrompt":["原始值"]}}\n';

  fs.writeFileSync(target, before, 'utf8');
  fs.writeFileSync(child, [
    "import fs from 'node:fs';",
    "import { guardConfigFile } from './testkit.mjs';",
    `const f = ${JSON.stringify(target)};`,
    'guardConfigFile(f);',
    'fs.writeFileSync(f, \'{"persona":{"systemPrompt":["被写坏了"]}}\', "utf8");',
    'process.exit(7);   // 模拟"跑到一半挂了"',
    '',
  ].join('\n'), 'utf8');

  const r = spawnSync(process.execPath, [child], { stdio: 'ignore' });
  check('子进程确实异常退出了', r.status === 7, `exit=${r.status}`);
  check('护栏在异常退出时把文件还原了', fs.readFileSync(target, 'utf8') === before,
    JSON.stringify(fs.readFileSync(target, 'utf8')));

  try { fs.unlinkSync(child); } catch { /* 忽略 */ }
  try { fs.unlinkSync(target); } catch { /* 忽略 */ }
}

console.log('\n' + '='.repeat(70));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(70));
process.exitCode = fail > 0 ? 1 : 0;
