/**
 * test-syntax.mjs — 所有源码文件必须语法正确。
 *
 * 为什么单独做这个测试：写注释时踩了**两次**同一个坑 ——
 * 群里那个颜文字昵称（形如 o( 星号 斜杠 斜杠 斜杠 斜杠 ▽ … )q）
 * 中间含「星号+斜杠」，抄进块注释里会把注释**提前闭合**，
 * 于是后面的注释文字变成代码，整个文件语法报错。
 *
 * 两次都是靠手工跑 node --check 才发现的，而且第二次是在改另一个文件时
 * 又犯了一遍。这种错误不该靠人记得去查 —— 加个测试，改完立刻就知道。
 *
 * 顺带也覆盖：整份文件被模板字符串/反引号弄坏、括号不配对之类的低级错误。
 *
 * ⚠ 故意用 stdio:'ignore' 而不是管道：在受限沙箱里，node 子进程走管道
 *   捕获输出会 EPERM。这里只关心退出码，不需要输出。
 *
 * 用法：node tools/test-syntax.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`); }
}

/** 收集要检查的文件。fixtures 是数据不是代码，跳过。 */
function collect(dir) {
  const out = [];
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const name of fs.readdirSync(abs)) {
    const p = path.join(abs, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === 'fixtures' || name === 'node_modules') continue;
      out.push(...collect(path.join(dir, name)));
    } else if (name.endsWith('.js') || name.endsWith('.mjs')) {
      out.push(path.join(dir, name));
    }
  }
  return out;
}

const files = [...collect('src'), ...collect('gui'), ...collect('tools')].sort();

console.log('='.repeat(72));
console.log('源码语法检查（node --check）');
console.log('='.repeat(72));
console.log(`\n  共 ${files.length} 个文件\n`);

const broken = [];
for (const rel of files) {
  // stdio: 'ignore' —— 只要退出码。管道在受限沙箱下会 EPERM。
  const r = spawnSync(process.execPath, ['--check', rel], { cwd: ROOT, stdio: 'ignore' });
  if (r.status !== 0) broken.push(rel);
}

check(`全部 ${files.length} 个文件语法正确`, broken.length === 0,
  broken.length ? `坏文件: ${broken.join(', ')}` : '');

// 出错时把 node 自己的报错原文打出来，别让人再手工跑一遍
if (broken.length > 0) {
  console.log('\n  --- node --check 的原文 ---');
  for (const rel of broken) {
    const r = spawnSync(process.execPath, ['--check', rel], { cwd: ROOT, encoding: 'utf8' });
    console.log(`  [${rel}]`);
    for (const line of String(r.stderr ?? '').split('\n').slice(0, 6)) {
      if (line.trim()) console.log(`      ${line.trim()}`);
    }
  }
}

// ---------------------------------------------------------- 关键文件在位
console.log('\n  关键文件在位检查');
{
  const must = [
    'src/bot.js', 'src/config.js', 'src/gate.js', 'src/llm.js', 'src/fallback.js',
    'src/parse.js', 'src/parse-uia.js', 'src/takeover.js', 'src/memory.js',
    'src/console-guard.js', 'gui/server.js', 'gui/page.js',
  ];
  const missing = must.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  check(`关键模块都在（${must.length} 个）`, missing.length === 0,
    missing.length ? `缺: ${missing.join(', ')}` : '');
}

// -------------------------------------------- 块注释不许被提前闭合
console.log('\n  块注释完整性（那个颜文字昵称害我踩了四次）');
{
  // 这一类错误的精确特征：块注释的**续行**（以 * 开头）里出现了 `*/`。
  // 那会把注释提前闭合，后面的注释文字变成代码 → 整个文件语法报错。
  //
  // 只查这一种形态，不误伤：
  //   · `// ... */ ...`   行注释 —— 无害
  //   · `catch { /* 忽略 */ }` 完整的行内块注释 —— 无害
  //   · `*/` 单独一行      注释正常结束 —— 无害
  const suspicious = [];
  for (const rel of files) {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if (!t.startsWith('*')) return;        // 不是块注释的续行
      if (t === '*/' || t.startsWith('*/')) return;   // 正常结束
      if (t.includes('*/')) suspicious.push(`${rel}:${i + 1}  ${t.slice(0, 60)}`);
    });
  }
  check('块注释续行里没有星号紧跟斜杠（那会提前闭合注释）', suspicious.length === 0,
    suspicious.length ? suspicious.join(' | ') : '');
}

// ------------------------------------ 控制台页面生成的脚本也要能解析
console.log('\n  控制台页面生成的浏览器脚本');
{
  // 这一条是**真抓到过问题的**：gui/page.js 整个是个模板字符串，
  // 里面写反引号或裸的 `\n` 会把外层模板提前闭合 / 把字符串断成两行，
  // 生成的脚本当场语法错误 —— 而页面的表现是**整个 JS 静默失效**
  // （输入框全空、按钮全没反应），HTTP 测试完全看不出来。
  //
  // 上一版只检查了源码文件本身，抓不到"生成之后才坏"这种情况。
  let ok = false;
  let detail = '';
  try {
    const { renderPage } = await import('../gui/page.js');
    const html = renderPage({ port: 7788 });
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    if (!m) {
      detail = '页面里找不到 <script> 块';
    } else {
      const tmp = path.join(ROOT, 'tools', '.generated-page-check.mjs');
      fs.writeFileSync(tmp, m[1], 'utf8');
      const r = spawnSync(process.execPath, ['--check', tmp], { cwd: ROOT, stdio: 'ignore' });
      ok = r.status === 0;
      try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
      if (!ok) {
        const r2 = spawnSync(process.execPath, ['--check', tmp], { cwd: ROOT, encoding: 'utf8' });
        detail = String(r2.stderr ?? '').split('\n').slice(0, 4).join(' / ');
      } else {
        detail = `${m[1].length} 字`;
      }
    }
  } catch (e) {
    detail = e.message;
  }
  check('renderPage() 生成的 <script> 语法正确', ok, detail);
}

console.log('\n' + '='.repeat(72));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(72));
process.exit(fail === 0 ? 0 : 1);
