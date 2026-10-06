/**
 * test-console-guard.mjs — 回归测试：「控制台没打开时不许跑机器人」。
 *
 * 需求原话：「在控制台没打开的时候不要打开机器人」。
 *
 * 为什么这是硬规则而不是"顺手加个检查"：
 *   机器人往**真群**里发消息。没有控制台的时候，用户看不到它在说什么、
 *   也没法一键停 —— 它在替你说话而你不知道它说了什么。
 *
 * 三道防线，这个文件全部要测：
 *   1. 启动时探测不到 → 拒绝启动（不是警告后继续）
 *   2. 运行中控制台消失 → 机器人自己停（避免孤儿）
 *   3. start-bot.cmd 这条旁路也被堵住
 *
 * 用法：node tools/test-console-guard.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONSOLE_APP, consolePort, consoleRequired, probeConsole, startupVerdict, createConsoleWatch,
} from '../src/console-guard.js';
import { parseArgs } from '../src/config.js';
import { configLooksConfigured, skipNote } from './testkit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`); }
}

// 「你的 config 里端口是 7788」是拿真实配置做的交叉验证：
// 开发机上它守的是"我改没改端口、控制台和机器人对不对得上"；
// 在一份还没配的副本上它只是"还没配"。所以没配好就 [SKIP]。
const REAL_READY = configLooksConfigured(JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')));
const checkReal = (name, cond, detail = '') => {
  if (!REAL_READY) { skipNote(name); return; }
  check(name, cond, detail);
};
function section(t) { console.log(`\n${t}`); }

/** 造一个假的 fetch，用来模拟控制台的各种响应。 */
function fakeFetch(spec) {
  return async () => {
    if (spec.throw) throw spec.throw;
    return {
      ok: spec.ok !== false,
      status: spec.status ?? 200,
      json: async () => spec.body,
    };
  };
}
const connRefused = () => {
  const e = new Error('fetch failed');
  e.cause = { code: 'ECONNREFUSED' };
  return e;
};
const abortErr = () => {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
};

console.log('='.repeat(72));
console.log('控制台联动：没控制台就不许跑机器人');
console.log('='.repeat(72));

// ---------------------------------------------------------- 1. 端口
section('1) 端口解析：环境变量 GUI_PORT 优先');
{
  const cfg = { console: { port: 8899 } };
  check('环境变量优先于 config', consolePort(cfg, { GUI_PORT: '7000' }) === 7000);
  check('没有环境变量时用 config', consolePort(cfg, {}) === 8899);
  check('都没有时用默认 7788', consolePort({}, {}) === 7788);
  check('环境变量是垃圾值时回退 config', consolePort(cfg, { GUI_PORT: 'abc' }) === 8899);
  check('环境变量是 0 / 负数时回退（不能变成端口 0）', consolePort(cfg, { GUI_PORT: '0' }) === 8899
    && consolePort(cfg, { GUI_PORT: '-1' }) === 8899);
  check('config.port 也是垃圾值时用默认', consolePort({ console: { port: 'x' } }, {}) === 7788);
  check('cfg 为 undefined 不抛', consolePort(undefined, {}) === 7788);

  // GUI_PORT 优先是有原因的：控制台启子进程时把 process.env 传下来，
  // 所以机器人拿到的就是控制台**实际绑定的**端口，不会错配。
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  checkReal('真实 config 里 console.port 是 7788', real.console?.port === 7788, String(real.console?.port));
}

// ---------------------------------------------------------- 2. 要不要
section('2) 什么时候要求控制台');
{
  check('默认要求', consoleRequired({}, {}) === true);
  check('config.console.required=false → 不要求', consoleRequired({ console: { required: false } }, {}) === false);
  check('--allow-no-console → 不要求', consoleRequired({}, { allowNoConsole: true }) === false);
  check('CLI 优先于 config（两个都说不用也只是不用）',
    consoleRequired({ console: { required: false } }, { allowNoConsole: true }) === false);
  check('config 说不用、CLI 没说话 → 不要求',
    consoleRequired({ console: { required: false } }, { allowNoConsole: false }) === false);
  check('只认显式的 false：别的值都算要求',
    consoleRequired({ console: { required: 'no' } }, {}) === true
    && consoleRequired({ console: { required: 0 } }, {}) === true);

  check('parseArgs 认识 --allow-no-console', parseArgs(['--watch', '--allow-no-console']).allowNoConsole === true);
  check('默认不开这个开关', parseArgs(['--watch']).allowNoConsole === false);
}

// ---------------------------------------------------------- 3. 探测
section('3) probeConsole：必须确认「是本项目的控制台」，不能只看端口有人');
{
  // 探到了，而且标记对得上
  const ok = await probeConsole(7788, {
    fetchImpl: fakeFetch({ body: { app: CONSOLE_APP, pid: 123, port: 7788 } }),
  });
  check('正常控制台 → alive', ok.alive === true && ok.reason === 'ok', ok.detail);

  // 端口没人监听 —— 最常见的"控制台没开"
  const refused = await probeConsole(7788, { fetchImpl: fakeFetch({ throw: connRefused() }) });
  check('连接被拒 → not-running', refused.alive === false && refused.reason === 'not-running', refused.detail);

  // 端口上有东西，但不是我们的控制台 —— 必须拒绝，不能当成"控制台在线"
  const other = await probeConsole(7788, {
    fetchImpl: fakeFetch({ body: { app: 'some-other-app' } }),
  });
  check('端口被别的程序占用 → 不算在线（关键：不能只看端口通不通）',
    other.alive === false && other.reason === 'port-occupied-by-other', other.detail);

  const notJson = await probeConsole(7788, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('不是 JSON'); } }),
  });
  check('响应不是 JSON → 也不算在线', notJson.alive === false, notJson.reason);

  const httpErr = await probeConsole(7788, { fetchImpl: fakeFetch({ ok: false, status: 500 }) });
  check('HTTP 500 → port-occupied-by-other（不是我们的控制台）',
    httpErr.alive === false && httpErr.reason === 'port-occupied-by-other', httpErr.detail);

  const timeout = await probeConsole(7788, { fetchImpl: fakeFetch({ throw: abortErr() }) });
  check('超时 → timeout', timeout.alive === false && timeout.reason === 'timeout', timeout.detail);

  const otherErr = await probeConsole(7788, { fetchImpl: fakeFetch({ throw: new Error('boom') }) });
  check('其他错误 → error（不抛）', otherErr.alive === false && otherErr.reason === 'error', otherErr.detail);

  // 真实网络：探一个几乎肯定没人监听的端口
  const dead = await probeConsole(59999, { timeoutMs: 800 });
  check('真网络探测空闲端口 → not-running（用真 fetch，不用假货）',
    dead.alive === false, `${dead.reason} ${dead.detail ?? ''}`);
}

// ---------------------------------------------------------- 4. 启动判决
section('4) startupVerdict：探不到就拒绝启动');
{
  const refused = startupVerdict({ alive: false, required: true, reason: 'not-running', port: 7788 });
  check('探不到 → ok=false（拒绝启动）', refused.ok === false);
  check('标题说清了是什么问题', refused.title.includes('拒绝启动') && refused.title.includes('7788'), refused.title);
  check('提示里给了正确做法（控制台启动器）',
    refused.hints.some((h) => h.includes('控制台')), JSON.stringify(refused.hints.slice(0, 2)));
  check('提示里给了逃生口（--allow-no-console）',
    refused.hints.some((h) => h.includes('--allow-no-console')));
  check('提示里给了永久关闭的办法（console.required）',
    refused.hints.some((h) => h.includes('console.required')));

  const alive = startupVerdict({ alive: true, required: true, reason: 'ok', port: 7788 });
  check('探到了 → ok=true', alive.ok === true);

  const skipped = startupVerdict({ alive: false, required: false, reason: 'not-running', port: 7788 });
  check('显式跳过检查 → ok=true（但仍然会 warn，见 bot.js）', skipped.ok === true);

  // 各种失败原因都要有看得懂的中文，不能把 reason 码直接丢给用户
  for (const reason of ['not-running', 'port-occupied-by-other', 'timeout', 'error']) {
    const v = startupVerdict({ alive: false, required: true, reason, port: 7788 });
    const readable = /[\u4e00-\u9fa5]/.test(v.title) && !v.title.includes(reason);
    check(`reason=${reason} 被翻译成了人话`, readable, v.title);
  }
}

// ---------------------------------------------------------- 5. 看门狗
section('5) createConsoleWatch：运行中控制台没了就自己停');
{
  const w = createConsoleWatch({ threshold: 2 });
  const a = w.note({ alive: false, reason: 'not-running' });
  check('第 1 次失败：只警告，不停', a.shouldExit === false && a.failures === 1, `failures=${a.failures}`);
  check('第 1 次失败会发出警告（justWarned）', a.justWarned === true);
  const b = w.note({ alive: false, reason: 'not-running' });
  check('第 2 次失败：判定死亡', b.shouldExit === true && b.failures === 2, `failures=${b.failures}`);

  // 失败一次又恢复 —— 不该被杀（控制台偶尔忙一下会让一次探测超时）
  const w2 = createConsoleWatch({ threshold: 2 });
  w2.note({ alive: false, reason: 'timeout' });
  const rec = w2.note({ alive: true, reason: 'ok' });
  check('失败一次后恢复 → 计数器归零', rec.failures === 0 && rec.shouldExit === false);
  check('恢复时会报 recovered（这样日志里能说一句"又连上了"）', rec.recovered === true);
  const after = w2.note({ alive: false, reason: 'timeout' });
  check('恢复之后再失败，是从 0 重新数（不会累积成误杀）',
    after.shouldExit === false && after.failures === 1, `failures=${after.failures}`);

  // 警告只发一次，不刷屏
  const w3 = createConsoleWatch({ threshold: 5 });
  w3.note({ alive: false, reason: 'x' });
  const second = w3.note({ alive: false, reason: 'x' });
  check('连续失败时警告只发一次（否则每轮刷一行）', second.justWarned === false);

  check('threshold 给 0/负数时回退成 2',
    createConsoleWatch({ threshold: 0 }).limit === 2 && createConsoleWatch({ threshold: -3 }).limit === 2);
  check('threshold=1 时一次失败就停', createConsoleWatch({ threshold: 1 }).note({ alive: false }).shouldExit === true);
  check('note(undefined) 不抛，按失败处理',
    (() => { try { return createConsoleWatch({}).note(undefined).failures === 1; } catch { return false; } })());
}

// ---------------------------------------------------------- 6. 接线
section('6) bot.js 的三处接线 + 控制台的 /api/ping');
{
  const bot = fs.readFileSync(path.join(ROOT, 'src', 'bot.js'), 'utf8');

  check('bot.js 导入了 console-guard', /from '\.\/console-guard\.js'/.test(bot));

  // 启动检查必须在 acquireLock **之前**：被拒时不该去抢锁，
  // 否则会在磁盘上留下锁文件，让下次正常启动以为"有残留锁"
  const iProbe = bot.indexOf('await probeConsole(guardPort');
  const iLock = bot.indexOf('acquireLock();');
  check('启动探测在 acquireLock 之前（被拒时不留锁文件）', iProbe > 0 && iProbe < iLock,
    `probe@${iProbe} < lock@${iLock}`);

  check('探不到时会拒绝启动（设置非 0 退出码并 return）',
    /if \(!verdict\.ok\)[\s\S]{0,600}?process\.exitCode = 3[\s\S]{0,200}?return;/.test(bot));

  check('看门狗存在（运行中检测）', bot.includes('createConsoleWatch('));
  const iWatch = bot.indexOf('const w = watchdog.note(probe);');
  const iStop = bot.indexOf("stop(4, '控制台已断开');");
  check('看门狗判定死亡后会停止机器人', iWatch > 0 && iStop > iWatch, `note@${iWatch} < stop@${iStop}`);
  check('看门狗用的是非 0 退出码（4），跟正常退出区分得开', bot.includes('stop(4,'));
  check('stop() 接受退出码和原因', /const stop = \(exitCode = 0, why = /.test(bot));
  check('控制台断开时日志不写「收到停止信号」（那会让人以为是自己按了 Ctrl+C）',
    !/控制台已断开[\s\S]{0,80}收到停止信号/.test(bot) && bot.includes('${why}，收尾中…'));
  check('看门狗只在"要求控制台"时才启用（三处防线不能互相打架）',
    /const watchdog = guardRequired \?/.test(bot));

  // 控制台检查必须在每一轮循环的最前面。
  // 之前写在扫描之后，而扫描连续失败 ≥5 次时会 continue 跳过它 ——
  // 于是"QQ 窗口被关掉"这种本来就连续失败的场景里，控制台死了机器人反而不停。
  const iLoop = bot.indexOf('while (running) {');
  const iCheck = bot.indexOf('if (!(await consoleStillThere())) return;');
  const iScan = bot.indexOf('await scanOnce(state, { verbose: cfg.cli.verbose });', iLoop);
  check('控制台检查在扫描之前（退避分支不会跳过它）',
    iLoop > 0 && iCheck > iLoop && iCheck < iScan, `loop@${iLoop} < check@${iCheck} < scan@${iScan}`);
  check('退避分支的 continue 在扫描之后（所以下一轮仍会先查控制台）',
    bot.indexOf('await sleep(backoff);', iScan) > iScan);

  const server = fs.readFileSync(path.join(ROOT, 'gui', 'server.js'), 'utf8');
  check('控制台暴露了 /api/ping', server.includes("'/api/ping'"));
  check('/api/ping 返回应用标记', server.includes(`app: 'qq-bot-console'`) || server.includes('app: CONSOLE_APP'));
  check('标记字符串两边一致（写歪了探测永远失败）',
    server.includes(`'${CONSOLE_APP}'`), CONSOLE_APP);
}

// ---------------------------------------------------------- 7. 旁路
section('7) start-bot.cmd 这条旁路必须被堵住');
{
  const p = path.join(ROOT, 'start-bot.cmd');
  const bytes = fs.readFileSync(p);
  const text = bytes.toString('ascii');

  check('文件不再是"直接跑机器人"', !/node\s+src\\bot\.js\s+--watch\s+%\*/.test(text),
    '旧内容: node src\\bot.js --watch %*');
  check('它指向控制台启动器', /other \.cmd/i.test(text));
  check('它给出了显式逃生口的命令行', text.includes('--allow-no-console'));
  check('它以非 0 退出码结束（避免被脚本当成成功）', /exit \/b 1/.test(text));

  // 这两个是 .cmd 上真踩过的坑，必须继续守住
  const nonAscii = [...bytes].filter((b) => b > 127).length;
  check('纯 ASCII（中文会变乱码、乱码行会被当命令执行）', nonAscii === 0, `非 ASCII 字节 ${nonAscii}`);
  const lfOnly = (text.match(/(?<!\r)\n/g) ?? []).length;
  check('全是 CRLF（裸 LF 会让多行 if 块被静默跳过）', lfOnly === 0, `裸 LF ${lfOnly} 个`);

  // 另一个启动器也要守同样的规矩
  const consoleCmd = path.join(ROOT, '机器人控制台.cmd');
  if (fs.existsSync(consoleCmd)) {
    const cb = fs.readFileSync(consoleCmd);
    const ctext = cb.toString('ascii');
    check('机器人控制台.cmd 仍然是纯 ASCII', [...cb].filter((b) => b > 127).length === 0);
    check('机器人控制台.cmd 仍然是 CRLF', (ctext.match(/(?<!\r)\n/g) ?? []).length === 0);
  }
}

console.log('\n' + '='.repeat(72));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(72));
process.exit(fail === 0 ? 0 : 1);
