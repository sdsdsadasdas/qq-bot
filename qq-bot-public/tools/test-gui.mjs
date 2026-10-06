/**
 * test-gui.mjs — 控制台的接口测试。
 *
 * 需要先起控制台（机器人控制台.cmd 或 node gui/server.js）。
 * 测试会**改完再改回来**，不留副作用。
 *
 * 用法：node tools/test-gui.mjs [端口]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { consoleServes, skipConsole, guardFile } from './testkit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 7788;
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`); }
}

/**
 * .cmd 必须纯 ASCII。
 *
 * 交付前先查这个，因为它是「双击打不开」的根因，而且**踩过两次**：
 * Windows cmd 按系统 ANSI 代码页（中文系统是 GBK）读批处理文件，
 * UTF-8 无 BOM 的中文会变成乱码，乱码落在行首还会被当成命令执行，
 * 脚本在第一处就崩了，浏览器自然没被打开。
 *
 * 实测报错长这样：
 *   '.0.0.1:' is not recognized as an internal or external command
 *   '起来需要一两秒，浏览器会自己重试）' is not recognized
 *
 * 所以这一段放在最前面：**不依赖控制台是否在跑**，随时都能跑。
 */
console.log('='.repeat(70));
console.log('启动器与静态检查（不需要控制台在跑）');
console.log('='.repeat(70));

console.log('\n0) .cmd 文件必须是纯 ASCII（双击打不开的根因，踩过两次）');
{
  const cmdFiles = fs.readdirSync(ROOT).filter((f) => f.toLowerCase().endsWith('.cmd'));
  check(`发现 ${cmdFiles.length} 个 .cmd 文件`, cmdFiles.length > 0, cmdFiles.join(', '));

  for (const name of cmdFiles) {
    const abs = path.join(ROOT, name);
    const buf = fs.readFileSync(abs);
    const offenders = [];
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] > 127) offenders.push(i);
    }
    check(`${name} 纯 ASCII`, offenders.length === 0,
      offenders.length ? `${offenders.length} 个非 ASCII 字节，首个在偏移 ${offenders[0]}` : `${buf.length} 字节`);

    const text = buf.toString('utf8');
    check(`${name} 没有 UTF-8 BOM`, !(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF));
    check(`${name} 有 @echo off`, /^\s*@echo off/im.test(text));
    // 行尾必须是 CRLF（老式 cmd 对 LF 的容忍度不一）
    const lfOnly = (text.match(/(?<!\r)\n/g) || []).length;
    check(`${name} 用 CRLF 换行`, lfOnly === 0, lfOnly ? `${lfOnly} 处裸 LF` : '');
  }

  // 启动器要能识别"已在运行"，否则重复双击会 EADDRINUSE 崩掉
  const launcher = cmdFiles.find((f) => f.includes('控制台'));
  if (launcher) {
    const t = fs.readFileSync(path.join(ROOT, launcher), 'utf8');
    check('启动器会先探测端口（避免重复启动）',
      /TcpClient|ALREADY/.test(t), '查找端口探测逻辑');
    check('启动器把浏览器指向 127.0.0.1:7788', t.includes('127.0.0.1') && t.includes('7788'));
    // 「改了控制台代码 → 双击启动器 → 界面还是旧的」这个坑：
    // 端口被占用时只打开浏览器、不重启，于是永远加载不到新代码。
    // 现在会自己判断代码新旧并自动重启（见下面那几条断言）。
    const codeLines = t.split(/\r?\n/).filter((l) => !/^\s*REM\b/i.test(l));
    // ---- node 不能只靠 PATH 找 ----
    //
    // 实测（用户双击后的真实反馈）：
    //     "Node.js was not found on PATH -- the console cannot start."
    // 查下来这台机器**根本没装 Node.js**：系统/用户 PATH 里没有，Program Files、
    // nvm、volta、fnm 全都没有；唯一的 node.exe 是 DSH 桌面版自带的那个，
    // 而 DSH 只把它注入到"自己拉起的进程"的 PATH 里 —— 所以我的终端能用、
    // 用户双击却不行。启动器必须自己去常见位置找，并且**说出用的是哪个**。
    check('启动器不依赖 PATH 找 node（先 where，再常见安装位置，再 DSH 自带）',
      t.includes('where node') && t.includes('%ProgramFiles%\\nodejs\\node.exe') && t.includes('DSH Desktop'));
    check('启动时会用找到的那个 node（而不是裸 node）',
      /"%NODE_EXE%" gui\\server\.js/.test(t) && !/^node gui\\server\.js/m.test(t));
    check('找到哪个会打印出来（否则出问题不知道用的哪份）', /echo\s+node: %NODE_EXE%/.test(t));
    check('找不到时说清找过哪里、以及怎么手动指定',
      t.includes('QQ_BOT_NODE') && /where I know how to look|usual install folders/i.test(t));
    check('支持 QQ_BOT_NODE 显式指定', /if defined QQ_BOT_NODE if exist/.test(t));

    check('启动器说明它跑的是当前代码（同一进程内加载的不算）', /OLD code/i.test(t) || /stale/i.test(t));

    // 端口被占用时的行为：以前是英文 choice 提问，结果用户不知道按什么、
    // 双击永远打不开（实测两次）。现在改成自动判断，不许再有会卡住的提问。
    check('端口被占用时不再有会卡住的 choice 提问', !/\bchoice\b/i.test(t));
    check('能分辨"是不是自己的控制台"（查 /api/ping 的 app 字段）',
      t.includes('/api/ping') && t.includes("qq-bot-console"));
    check('代码过期时会自动重启（而不是只开浏览器）', /:restart/.test(t) && /stale/.test(t));

    // 安全线：绝不能杀掉"占用端口的任何进程" —— 那可能是不相干的程序。
    // 只看代码行：文件头注释里就写着 "Stop-Process on whatever owns the port"，
    // 不排除注释会把注释当成代码来数（第一次就是这么数错的）。
    const stopLines = codeLines.filter((l) => /Stop-Process/.test(l));
    check('只有一处 Stop-Process（代码里）', stopLines.length === 1, `${stopLines.length} 处`);
    check('而且那一处的 PID 来自我们自己的 /api/ping（不是"谁占端口就杀谁"）',
      stopLines[0] && stopLines[0].includes('/api/ping') && stopLines[0].includes('$j.pid'),
      (stopLines[0] || '').slice(0, 90));
    const conflictBlock = /^:conflict([\s\S]*?)(?=^:[A-Za-z])/m.exec(t.replace(/\r\n/g, '\n'));
    check('冲突时只报告、不动手（那块里没有 Stop-Process）',
      Boolean(conflictBlock) && !/Stop-Process/.test(conflictBlock[1]),
      conflictBlock ? `${conflictBlock[1].split('\n').length} 行` : '没找到 :conflict 块');
    check('冲突时会告诉用户是谁占着端口',
      Boolean(conflictBlock) && /Get-NetTCPConnection|OwningProcess/.test(conflictBlock[1]),
      conflictBlock ? (conflictBlock[1].match(/Get-NetTCPConnection|OwningProcess/) || ['没找到'])[0] : '');

    /**
     * 启动器最容易写坏的地方之二：**端口空闲时掉进别的标签块**。
     *
     * 真的写坏过：`:openonly`（只开浏览器那块）排在了 `:startit`（启动服务那块）
     * 前面，于是端口空闲时批处理一路直下、掉进 openonly ——
     * 打印"已有控制台在运行"、打开一个没有服务的网页、3 秒后退出，
     * **服务根本没启动**。用户看到的现象就是「控制台打不开」，而语法检查全绿。
     *
     * 批处理的规矩：标签块必须靠 goto/exit 隔离，直线路径上不能夹着别的块。
     */
    const flow = t.replace(/\r\n/g, '\n');
    // 探测那行的写法：端口空闲时**直接往下走**（走到 :startit），
    // 被占用时才 goto 走开。所以这里认的是 "if errorlevel 1 goto ..."。
    const probe = /^if errorlevel 1 goto\s+:[\w-]+\s*$/im.exec(flow);
    check('启动器：端口空闲时直接往下走、被占用才跳走', Boolean(probe), probe ? probe[0].trim() : '没找到探测跳转');
    if (probe) {
      const target = /goto\s+:([\w-]+)/.exec(probe[0])[1];
      const blockRe = new RegExp(`^:${target}\\b([\\s\\S]*?)(?=^:[A-Za-z])`, 'm');
      const blk = blockRe.exec(flow);
      check('端口空闲时跳到的那一块必须真的启动服务',
        /(?:"?%NODE_EXE%"?|node)\s+gui\\server\.js/i.test(blk[1]), `跳到 :${target}`);

      // 块之间不能互相掉进去：每个块的最后一行必须是 goto / exit。
      // （批处理没有"函数"，一个块写完不跳走就会串到下一个块 —— 这个项目踩过。）
      //
      // ⚠ 必须**按行**找标签。用 indexOf(':startit') 会命中 "goto :startit" 那一行，
      //   于是切出来的"块"从半截 goto 开始，最后一行当然是错的（第一版就是这毛病）。
      const blocks = [];
      let cur = null;
      for (const line of flow.split('\n')) {
        const m2 = /^:([A-Za-z]\w*)\s*$/.exec(line.trim());
        if (m2) { cur = { name: m2[1], lines: [] }; blocks.push(cur); continue; }
        if (!cur) continue;
        const t2 = line.trim();
        if (t2 && !/^REM\b/i.test(t2) && !/^::/.test(t2)) cur.lines.push(t2);
      }
      const bad = blocks
        .filter((b) => b.lines.length > 0 && !/^(goto\s|exit\s)/i.test(b.lines[b.lines.length - 1]))
        .map((b) => `${b.name}→"${b.lines[b.lines.length - 1].slice(0, 32)}"`);
      check(`每个标签块都以 goto/exit 收尾（共 ${blocks.length} 块）`, bad.length === 0, bad.join(' / '));
    }

    // 端口可以被环境变量覆盖（冲突提示里就是让用户这么做的 —— 之前硬写死会忽略它）
    check('GUIPORT 允许用 GUI_PORT 覆盖', /if "%GUI_PORT%"==""/.test(t));
  } else {
    check('找到控制台启动器', false, cmdFiles.join(', '));
  }
}

console.log('\n' + '='.repeat(70));
console.log('控制台接口测试  (' + BASE + ')');
console.log('='.repeat(70));

async function api(p, opts) {
  const r = await fetch(BASE + p, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, text, json, headers: r.headers };
}

const post = (p, body) => api(p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

// ⚠ 先确认这个端口上的控制台**服务的就是这份代码**。
//
// 这一段会通过控制台真的写 config.json 和 .env（第 3、4 节）。如果本测试是从
// **另一个副本**跑的（比如导出的发布包），端口上那个控制台仍然是主项目的 ——
// 于是测试写的是**主项目的** config.json 和 .env，读的却是本副本的文件：
//   · 第 3 节那两条断言必然红（写进去的值在另一份文件里）
//   · 更糟的是主项目的 .env 被塞进了 `ZHIPU_API_KEY=sk-gui-test-value`（实测发生过）
// 所以不匹配就直接跳过控制台那几节，别去动别人的文件。
const consolePre = await consoleServes(ROOT, PORT);
if (!consolePre.ok) {
  skipConsole('控制台接口测试（第 1 ~ 8 节）', consolePre.reason);
  console.log('\n  想跑这几节：在**本目录**起控制台（node gui/server.js），再跑一次。');
  console.log('\n' + '='.repeat(70));
  console.log(`结果：通过 ${pass} / 失败 ${fail}（上面那几节没跑）`);
  console.log('='.repeat(70));
  process.exit(0);
}

console.log('='.repeat(70));
console.log('控制台接口测试  (' + BASE + ')');
console.log('='.repeat(70));

// ---------------------------------------------------------------- 连通性
console.log('\n1) 服务可达');
let cfg;
try {
  cfg = await api('/api/config');
  check('GET /api/config 返回 200', cfg.status === 200, `status=${cfg.status}`);
} catch (e) {
  console.log(`  [FAIL] 连不上控制台：${e.message}`);
  console.log('\n  请先启动：node gui/server.js  或双击「机器人控制台.cmd」');
  process.exit(1);
}

const page = await api('/');
check('GET / 返回 HTML', page.status === 200 && page.text.includes('<!doctype html>'));
check('HTML 是 UTF-8', String(page.headers.get('content-type')).includes('utf-8'), page.headers.get('content-type'));
check('HTML 不引用外部 CDN', !/<script[^>]+src=["']https?:/i.test(page.text));

// 控制台"代码过期"检测：跑着的进程加载的是启动那一刻的 gui/*.js，
// 改了代码不重启的话界面永远不变（真实踩过：「为什么打开控制台不是修改后的界面」）。
// 页面靠这个字段提醒用户去重启。
const ping = await api('/api/ping');
check('ping 报出控制台进程的启动时间', !!(ping.json.console && typeof ping.json.console.startedAt === 'number'));
check('ping 报出"代码是否比进程新"',
  !!(ping.json.console && typeof ping.json.console.stale === 'boolean'),
  JSON.stringify(ping.json.console && { stale: ping.json.console.stale, newest: ping.json.console.newestFile }));
check('刚起的控制台不该被判定为过期（否则每次打开都在喊重启）',
  ping.json.console.stale === false,
  ping.json.console && `started=${ping.json.console.startedAtText} newest=${ping.json.console.newestFile}`);
check('config 接口也带上这个标志（页面就是从这里读的）',
  !!(cfg.json.console && typeof cfg.json.console.stale === 'boolean'));
check('HTML 含关键控件',
  ['apiKey', 'provider', 'btnStart', 'btnStop', 'whitelist', 'takeoverNow', 'cardPersona', 'personaPrompt2',
    'enableThinking', 'thinkingWrap', 'ignoreSystemMessages', 'systemPatterns',
    'replyScope', 'pollEnabled'].every((id) => page.text.includes(`id="${id}"`)));

// 页面里的 JS 必须能通过语法检查。
// 加这一条是因为踩过：测试只覆盖了 HTTP 接口，而内嵌脚本里有个
// 非法的对象字面量键（'a' + b + 'c': ...），导致整个脚本不执行 ——
// 界面看着出来了，但所有输入框都是空的，接口测试却全绿。
console.log('\n1b) 内嵌脚本的语法');
{
  const m = /<script>([\s\S]*?)<\/script>/.exec(page.text);
  if (!m) {
    check('页面里有 <script> 块', false);
  } else {
    const js = m[1];
    const tmp = path.join(ROOT, 'tools', '.gui-script.check.js');
    fs.writeFileSync(tmp, js, 'utf8');
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
      check(`内嵌脚本语法正确（${js.length} 字符）`, true);
    } catch (e) {
      const detail = String(e.stderr || e.message).split('\n').slice(0, 4).join(' | ');
      check('内嵌脚本语法正确', false, detail);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    }

    // 顺带查几个容易写错的地方
    check('没有把表达式直接当对象键（需要 [ ]）',
      !/^\s*'[^']*'\s*\+\s*\w+\s*\+/m.test(js), '扫描：\'a\' + b + \'c\': 形式');
    check('脚本里没有未转义的 </script>', !js.includes('</script>'));

    /**
     * 静态检查页面的「渲染赋值」是否覆盖了所有输入控件。
     *
     * 为什么要有这条：踩过一次 —— 页面里的脚本因为语法错**完全不执行**，
     * 界面看着正常但所有输入框都是空的，而当时的接口测试全绿。
     * 语法检查能挡住语法错，这条挡住「控件加了但忘了在 renderAll 里赋值」。
     */
    const inputIds = [...page.text.matchAll(/<(?:input|select|textarea)[^>]*\bid="([^"]+)"/g)]
      .map((m2) => m2[1])
      .filter((id) => !['btnSave', 'btnReload', 'btnStart', 'btnStop', 'btnClearLogs',
        'toggleKey', 'clearKey', 'toast', 'logs', 'dot', 'modeBadge'].includes(id));

    const notRendered = inputIds.filter((id) => !js.includes(`$('${id}')`));
    check(`所有输入控件都在脚本里被引用（${inputIds.length} 个）`, notRendered.length === 0,
      notRendered.length ? `没引用: ${notRendered.join(', ')}` : '');

    /**
     * 抽出「从接口数据填回界面」的那些函数体，确认每个控件都在里面被赋值。
     *
     * 为什么这样断：踩过一次 —— 页面脚本因为语法错完全不执行，
     * 界面看着正常但所有输入框都是空的，而当时的接口测试全绿。
     * 语法检查能挡住语法错；这条挡住「控件加了但忘了填」。
     *
     * 只看赋值目标 `$('id').value =` / `.checked =` / `.innerHTML =`，
     * 不数出现次数 —— 属性赋值里 ID 只出现一次，数次数是错的（踩过）。
     */
    const assignTargets = new Set(
      [...js.matchAll(/\$\('([^']+)'\)\s*\.(?:value|checked|textContent|innerHTML)\s*=/g)]
        .map((m2) => m2[1]),
    );
    // 有些控件是先取到局部变量再赋值（const sel = $('provider'); sel.value = ...），
    // 上面的字面匹配会漏掉。这里额外认「$('id') 赋给变量后该变量有赋值」。
    const aliases = [...js.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*\$\('([^']+)'\)/g)];
    for (const [, varName, id] of aliases) {
      const re = new RegExp(`\\b${varName}\\s*\\.(?:value|checked|textContent|innerHTML)\\s*=`);
      if (re.test(js)) assignTargets.add(id);
    }
    // 例外：**不是配置项**的输入框不该被配置渲染赋值。
    //   ruleTest —— 「试打一句」的输入框，纯用户临时输入，加载时留空才对。
    // 加例外要谨慎：这条断言的用处正是"加了控件却忘了在 renderAll 里填值"
    //（那样界面永远显示空/旧值，而且不会报任何错）。
    const NO_ASSIGN = new Set(['ruleTest', 'personaSeed']);   // 纯界面状态，不从配置填
    const missing = inputIds.filter((id) => !assignTargets.has(id) && !NO_ASSIGN.has(id));
    check(`所有输入控件都被赋值（${assignTargets.size} 个赋值目标）`, missing.length === 0,
      missing.length ? `漏了: ${missing.join(', ')}` : '');

    /**
     * 反方向也要查：脚本里 `$('xxx')` 引用的 id 必须真的存在于 HTML。
     *
     * 为什么需要这条：`$('x')` 取不到就是 null，紧接着的 `.textContent = ...`
     * 会在浏览器里抛 TypeError —— **整个渲染函数当场断掉**，而服务端接口
     * 测试全绿、脚本语法也合法。只有真开浏览器才看得见（而浏览器测试要弹窗口）。
     * 加个 id 时打错一个字就是这么个后果，静态查一遍便宜得多。
     */
    const htmlIds = new Set(
      [...page.text.matchAll(/\bid="([^"]+)"/g)].map((m2) => m2[1]),
    );
    const jsIds = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m2) => m2[1]));
    const dangling = [...jsIds].filter((id) => !htmlIds.has(id));
    check(`脚本引用的每个控件 id 都在 HTML 里存在（${jsIds.size} 个引用）`, dangling.length === 0,
      dangling.length ? `HTML 里没有: ${dangling.join(', ')}` : '');
  }
}

// ------------------------------------------------------------ key 打码
console.log('\n2) API key 打码（不能在列表接口里泄露明文）');
{
  const v = cfg.json;
  const d = v.providers.deepseek.key;
  check('deepseek key 标记为已配置', d.set === true);
  check('返回值里没有明文 key', !/sk-[a-f0-9]{20,}/.test(cfg.text), '扫描了整个响应体');
  check('打码保留了头尾便于辨认', /^sk-..\*+/.test(d.masked), d.masked);
  check('默认不返回明文（value 为空）', d.value === '', `value="${d.value}"`);

  const revealed = await api('/api/config?reveal=1');
  const rk = revealed.json.providers.deepseek.key;
  check('显式 reveal=1 才给明文', rk.value.startsWith('sk-') && rk.value.length > 20, `len=${rk.value.length}`);
  check('reveal 也只透出当前厂商之外各家的明文（这是设计如此，便于核对）', typeof revealed.json.providers.kimi.key.value === 'string');
}

// ------------------------------------------------------- 写配置能落盘
console.log('\n3) 改配置能真正落盘（改完再改回来）');
{
  const before = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const origProb = before.trigger.replyProbability;
  const origCtx = before.llm.contextMessages;
  const origModel = before.llm.providers[before.llm.provider].model;
  const beforeProviderNames = Object.keys(before.llm.providers).sort().join(',');

  const newProb = origProb === 0.33 ? 0.44 : 0.33;
  const r = await post('/api/config', {
    config: {
      'trigger.replyProbability': newProb,
      'llm.contextMessages': 12,
    },
  });
  check('POST /api/config 返回 ok', r.status === 200 && r.json.ok === true, JSON.stringify(r.json.applied));

  const after = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  check(`replyProbability 已写成 ${newProb}`, after.trigger.replyProbability === newProb, `实际 ${after.trigger.replyProbability}`);
  check('contextMessages 已写成 12', after.llm.contextMessages === 12, `实际 ${after.llm.contextMessages}`);

  // 关键：注释键不能被 JSON 重写弄丢（那些是给人看的说明）
  check('$comment 注释键保留', typeof after.$comment !== 'undefined' && typeof after.llm.$comment !== 'undefined');
  // 别写死厂商名单 —— 那是用户配置，加一个（比如 local）就会红。
  // 这里要验的是"改别的字段时没把 providers 搞坏"，所以对比跑测试之前的快照。
  check('改配置没有动到 providers（厂商一个没少）',
    Object.keys(after.llm.providers).sort().join(',') === beforeProviderNames,
    `${beforeProviderNames} → ${Object.keys(after.llm.providers).sort().join(',')}`);
  check('providers 里每家都还有 baseUrl 和 model',
    Object.values(after.llm.providers).every((p) => p && p.baseUrl && p.model),
    JSON.stringify(Object.entries(after.llm.providers).map(([k, v]) => [k, Boolean(v.baseUrl), Boolean(v.model)])));
  check('模型名未被误改', after.llm.providers[before.llm.provider].model === origModel);

  // 改回来
  await post('/api/config', {
    config: { 'trigger.replyProbability': origProb, 'llm.contextMessages': origCtx },
  });
  const restored = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  check('已恢复原值', restored.trigger.replyProbability === origProb && restored.llm.contextMessages === origCtx);
}

// ------------------------------------------------------------- key 写盘
console.log('\n4) key 写进 .env（不动 config.json，改完清掉）');
{
  const envFile = path.join(ROOT, '.env');
  const beforeText = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  check('.env 存在', fs.existsSync(envFile));

  const r = await post('/api/config', { keys: { ZHIPU_API_KEY: 'sk-gui-test-value' } });
  check('写 key 返回 ok', r.status === 200 && r.json.ok === true, JSON.stringify(r.json.applied));

  const afterText = fs.readFileSync(envFile, 'utf8');
  check('.env 里出现了新 key', afterText.includes('ZHIPU_API_KEY=sk-gui-test-value'));
  check('.env 原有的 key 没被动', afterText.includes('DEEPSEEK_API_KEY=sk-'), 'deepseek 那行还在');
  check('厂商 key 显示为已配置', r.json.view.providers.zhipu.key.set === true);

  // 清掉测试 key（写空值）
  await post('/api/config', { keys: { ZHIPU_API_KEY: '' } });
  const cleaned = fs.readFileSync(envFile, 'utf8');
  check('测试 key 已清空', /ZHIPU_API_KEY=\s*(\r?\n|$)/.test(cleaned) || !cleaned.includes('sk-gui-test-value'));

  // 如果原来是别的样子就还原
  const hadZhipu = /ZHIPU_API_KEY=sk-/.test(beforeText);
  if (!hadZhipu) {
    const lines = cleaned.split(/\r?\n/).filter((l) => !/^ZHIPU_API_KEY=\s*$/.test(l));
    fs.writeFileSync(envFile, lines.join('\r\n'), 'utf8');
    check('.env 恢复干净（移除测试留下的空行）', !fs.readFileSync(envFile, 'utf8').includes('ZHIPU_API_KEY='));
  }
}

// --------------------------------------------------------- 接管模式开关
console.log('\n5) 接管模式开关（改完改回来）');
{
  const stateFile = path.join(ROOT, 'state.json');
  const before = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const orig = before.takeoverEnabled;

  const r = await post('/api/takeover', { on: !orig });
  check('切换返回新值', r.status === 200 && r.json.takeoverEnabled === !orig, `→ ${r.json.takeoverEnabled}`);
  const mid = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  check('state.json 已落盘', mid.takeoverEnabled === !orig);

  await post('/api/takeover', { on: orig });
  const back = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  check('已恢复原值', back.takeoverEnabled === orig, `→ ${back.takeoverEnabled}`);
}

// ------------------------------------------------------------- 启停控制
console.log('\n6) 启停接口');
{
  // ⚠ 这一段会真的把机器人启起来（就一两秒）。而机器人一启动就会读配置 ——
  //   如果 autoSwitch 开着，它**会去动用户的鼠标**：移动光标、点 QQ 会话列表、
  //   抢焦点。跑测试把人家正在打的字点进 QQ 里，是不可接受的副作用。
  //   所以先把自动切换关掉再启动，跑完还原。
  //   （实测过：停得够快时它还没来得及点，但那只是运气。测试不该靠运气。）
  // GET /api/config 返回的是**拍平**的配置（trigger.xxx 直接挂在顶层），
  // POST 才用 { config: { 'a.b': v } } 这种点号路径。
  const before = await api('/api/config');
  const autoWas = before.json.autoSwitch ? before.json.autoSwitch.enabled : undefined;
  if (autoWas === true) {
    await post('/api/config', { config: { 'autoSwitch.enabled': false } });
  }
  const off = await api('/api/config');
  check('启停测试期间自动切换是关的（跑测试不许动用户的鼠标）',
    !off.json.autoSwitch || off.json.autoSwitch.enabled === false,
    JSON.stringify(off.json.autoSwitch && off.json.autoSwitch.enabled));

  const s1 = await post('/api/bot/start');
  check('启动返回 ok', s1.status === 200 && s1.json.ok === true, JSON.stringify(s1.json));
  await new Promise((r) => setTimeout(r, 1500));

  const st = await api('/api/config');
  check('状态显示运行中', st.json.state.running === true);

  const s2 = await post('/api/bot/start');
  check('重复启动被拒绝', s2.json.ok === false, s2.json.error);

  const s3 = await post('/api/bot/stop');
  check('停止返回 ok', s3.status === 200 && s3.json.ok === true);
  await new Promise((r) => setTimeout(r, 2000));

  const st2 = await api('/api/config');
  check('状态显示已停止', st2.json.state.running === false);

  const s4 = await post('/api/bot/stop');
  check('重复停止被拒绝', s4.json.ok === false, s4.json.error);

  // 还原用户原来的设置（本来是开的就开回去）
  if (autoWas === true) {
    await post('/api/config', { config: { 'autoSwitch.enabled': true } });
    const back = await api('/api/config');
    check('跑完把自动切换还原成原来的值', back.json.autoSwitch.enabled === true);
  }

  // 日志里应该有启动和退出的痕迹
  const lg = await api('/api/logs');
  check('日志有内容', lg.json.logs.length > 0, `${lg.json.logs.length} 条`);
  check('日志含启动命令', lg.json.logs.some((l) => l.line.includes('bot.js')), '');
}

// ------------------------------------------------------- 记忆 / 生活日志
console.log('\n7) 记忆与生活日志接口');
{
  const mem = await api('/api/memory');
  check('记忆接口可用', mem.status === 200 && mem.json.ok === true);
  check('两层都在', Boolean(mem.json.global) && Boolean(mem.json.conversation));
  check('现在会带回生活日志（人生模拟的产物）', Boolean(mem.json.life), JSON.stringify(Object.keys(mem.json.life || {})));
  check('生活日志里有「开没开 / 几次检测一次 / 文件路径」',
    mem.json.life
    && typeof mem.json.life.enabled === 'boolean'
    && typeof mem.json.life.everyChecks === 'number'
    && typeof mem.json.life.file === 'string',
    JSON.stringify({ e: mem.json.life && mem.json.life.enabled, n: mem.json.life && mem.json.life.everyChecks }));
  check('最近记录是数组（页面要铺开渲染）', Array.isArray(mem.json.life.recent));
  check('带上了注入提示词的那段文字（可能为空串）', typeof mem.json.life.digest === 'string');
  check('页面上能看到主动分享的状态（它会自己往群里说话，用户必须看得见）',
    Boolean(mem.json.life.share)
    && typeof mem.json.life.share.enabled === 'boolean'
    && typeof mem.json.life.share.minIntervalMinutes === 'number'
    && typeof mem.json.life.share.maxPerDay === 'number',
    JSON.stringify(mem.json.life.share && {
      enabled: mem.json.life.share.enabled,
      gap: mem.json.life.share.minIntervalMinutes,
      perDay: mem.json.life.share.maxPerDay,
    }));
  check('面板报出了"允许在哪些会话分享"', Array.isArray(mem.json.life.share.allowed));
  check('面板报出了判断/适合/实际发出的次数',
    typeof mem.json.life.share.totalConsidered === 'number'
    && typeof mem.json.life.share.totalSuitable === 'number'
    && typeof mem.json.life.share.totalShared === 'number');

  // 清空生活日志**不能**顺手把记忆也清了（这是它单独一个 scope 的原因）。
  //
  // ⚠ 但这一步会真的清掉用户的生活日志 —— 所以先原样备份文件，
  //   验完再写回去。测试把用户积累的数据弄丢是不可接受的。
  const lifePath = path.join(ROOT, mem.json.life.file);
  const lifeBackup = fs.existsSync(lifePath) ? fs.readFileSync(lifePath, 'utf8') : null;
  const lifeTotalBefore = mem.json.life.total;
  const gBefore = JSON.stringify(mem.json.global.memory);
  const cBefore = JSON.stringify(mem.json.conversation.memory);

  const cleared = await post('/api/memory/clear', { scope: 'life' });
  check('清空生活日志返回 ok', cleared.status === 200 && cleared.json.ok === true, cleared.json.error);
  check('清完之后生活日志是空的', cleared.json.life.total === 0, String(cleared.json.life && cleared.json.life.total));
  check('总记忆没被动过', JSON.stringify(cleared.json.global.memory) === gBefore);
  check('会话记忆没被动过', JSON.stringify(cleared.json.conversation.memory) === cBefore);

  // 乱传 scope 必须被拒绝，绝不能回落到"全清"
  const bogus = await post('/api/memory/clear', { scope: 'nonsense' });
  check('乱传 scope 不会清掉任何东西', bogus.json.ok === false, JSON.stringify(bogus.json));
  const stillThere = await api('/api/memory');
  check('乱传 scope 之后总记忆还在', JSON.stringify(stillThere.json.global.memory) === gBefore);

  // 还原生活日志
  //
  // ⚠ 这里必须用 unlinkSync，不能用 fs.rmSync(p, {force:true})：实测在本机的
  //   Z: 盘上 rmSync 会**静默地什么都不做**（不抛错、文件还在），
  //   于是"还原"这一步看起来跑了、其实没删掉，测试留下一份空日志。
  //   unlinkSync 正常。这条是踩出来的，别改回去。
  if (lifeBackup !== null) fs.writeFileSync(lifePath, lifeBackup, 'utf8');
  else { try { fs.unlinkSync(lifePath); } catch { /* 本来就没有 */ } }
  const restored = await api('/api/memory');
  check('生活日志已还原（测试不许弄丢用户的数据）',
    lifeBackup === null ? restored.json.life.exists === false : restored.json.life.total === lifeTotalBefore,
    `before=${lifeTotalBefore} after=${restored.json.life.total} exists=${restored.json.life.exists}`);
}

// --------------------------------------------- 删除会话记忆（用户报的需求）
console.log('\n7a) 删除会话记忆：这一次要真的能删掉');
{
  // 用户原话：「要能删除会话，现在清空记忆后无法删除会话」。
  // 「清空」只把内容抹掉，文件还在、条目还挂在列表里 —— 于是看起来"删不掉"。
  // 这一节验的就是那个新动作：文件真的没了、列表里不再有它。
  //
  // ⚠ 只动**测试自己造的那个会话**（名字带 __测试，一眼能认出来），
  //   绝不碰用户的真会话；跑完无论如何都要把它清掉。
  const mem0 = await api('/api/memory');
  const dirAbs = path.join(ROOT, mem0.json.dir || 'memory');
  // ⚠ 名字里别带首尾下划线/空格：产品算文件名的规则会把它们去掉并补一个短哈希
  //   （`__x__` → `x-3f2a1b.json`），那样测试手写的文件和产品写的文件**不是同一个**，
  //   于是"删掉了但列表里还有一条"（实测踩到）。
  const TESTNAME = '测试会话-待删';
  const testFile = path.join(dirAbs, `${TESTNAME}.json`);
  const others0 = (mem0.json.conversations || []).length;

  fs.mkdirSync(dirAbs, { recursive: true });
  fs.writeFileSync(testFile, JSON.stringify({
    conversation: TESTNAME, mood: { label: '测试', why: '', at: null }, events: ['造出来给删除用的'],
  }, null, 2), 'utf8');

  const mem1 = await api('/api/memory');
  const names1 = (mem1.json.conversations || []).map((c) => c.conversation);
  check('测试会话出现在列表里（否则下面删的就不是它）', names1.includes(TESTNAME), JSON.stringify(names1));

  // 先确认「清空」的老行为：清完内容没了，**条目还在** —— 这正是用户抱怨的那点
  const cleared = await post('/api/memory/clear', { scope: 'conversation', conversation: TESTNAME });
  check('清空后条目仍然在列表里（这就是"清空 ≠ 删除"）',
    (cleared.json.conversations || []).some((c) => c.conversation === TESTNAME));
  check('清空后文件也还在（只是内容被抹成空的）', fs.existsSync(testFile));

  // 越权：名字不能直接拼路径。请求里的 `file` 只当"从服务端列表里挑一条"的钥匙
  const cfgLen = fs.statSync(path.join(ROOT, 'config.json')).size;
  const evil1 = await post('/api/memory/delete', { file: '../../config.json' });
  check('不许用 file=../../config.json 删到别的地方', evil1.json.ok === false, JSON.stringify(evil1.json));
  const evil2 = await post('/api/memory/delete', { conversation: '../../config.json' });
  check('也不许用会话名穿越（名字必须先在服务端的列表里）', evil2.json.ok === false);
  const evil3 = await post('/api/memory/delete', {});
  check('什么都没说就删 → 拒绝', evil3.json.ok === false);
  check('这几次越权都没碰到 config.json', fs.statSync(path.join(ROOT, 'config.json')).size === cfgLen);

  // 真删
  const del = await post('/api/memory/delete', { conversation: TESTNAME });
  check('删除返回 ok', del.status === 200 && del.json.ok === true, JSON.stringify(del.json).slice(0, 160));
  check('⚠ 文件真的没了（rmSync 在 Z: 盘上会静默不删，所以这里必须验）', !fs.existsSync(testFile));
  check('列表里不再有这个会话',
    !(del.json.conversations || []).some((c) => c.conversation === TESTNAME),
    JSON.stringify((del.json.conversations || []).map((c) => c.conversation)));
  check('其他会话没被连累（条数回到原来的样子）',
    (del.json.conversations || []).length === others0,
    `${others0} → ${(del.json.conversations || []).length}`);
  check('总记忆也没被动',
    JSON.stringify(del.json.global.memory) === JSON.stringify(mem1.json.global.memory));

  const again = await post('/api/memory/delete', { conversation: TESTNAME });
  check('再删一次 → 明确说"列表里没有这个会话"，不假装成功', again.json.ok === false, JSON.stringify(again.json));

  // 兜底清场（万一上面某一步失败留下的）
  try { if (fs.existsSync(testFile)) fs.unlinkSync(testFile); } catch { /* 忽略 */ }
  check('测试会话没有留在你的记忆目录里', !fs.existsSync(testFile), testFile);
}

// ------------------------------------------------- 人生模拟开关 / 换人生
console.log('\n7b) 人生模拟：开关与多份人生');
{
  // ⚠ 这一节会写 state.json（开关、当前人生）并新建临时人生文件 ——
  //   所以每一步都要记下原值、跑完还原。测试不许把用户的人生切走或删掉。
  //
  // ⚠⚠ state.json 用**护栏**兜住，不是"最后写回去"：实测有一次断言里抛了异常
  //   （读了个 undefined），进程直接带着改过的 state 退出 ——
  //   用户的 lifeProfile 于是永远指向一份已经被删掉的"控制台测试人生943717"，
  //   界面上看着像"人生没了"。护栏在 exit/SIGINT/异常时都会还原。
  const STATE = path.join(ROOT, 'state.json');
  guardFile(STATE);
  const stateBefore = fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8') : null;

  const v0 = await api('/api/life');
  check('人生接口可用', v0.status === 200 && v0.json.ok !== false, `status=${v0.status}`);
  const view = v0.json;
  check('报出人生模拟是否生效', typeof view.enabled === 'boolean', String(view.enabled));
  check('报出主动分享是否生效', !!(view.share && typeof view.share.enabled === 'boolean'));
  check('报出当前是谁的人生', typeof view.profile === 'string', JSON.stringify(view.profile));
  check('列出所有可用的人生', Array.isArray(view.lives), `${(view.lives || []).length} 份`);
  check('报出人生文件所在目录', typeof view.livesDir === 'string', view.livesDir);
  check('报出哪些值被控制台覆盖过', !!(view.overridden && typeof view.overridden.lifeEnabled === 'boolean'));
  check('每份人生都带条数（用来确认"没被选中的也还在"）',
    (view.lives || []).every((x) => typeof x.total === 'number'));
  check('主动分享的配额也报出来（今天几次 / 每天上限 / 允许的会话）',
    view.share && typeof view.share.sharesToday === 'number'
    && typeof view.share.maxPerDay === 'number' && Array.isArray(view.share.allowed));

  // ---- 开关：写 state（机器人每轮现读），不是写 config ----
  const cfgBefore = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
  const off = await post('/api/life', { lifeEnabled: false });
  check('关掉人生模拟返回新状态', off.status === 200 && off.json.enabled === false);
  check('关掉之后 config.json **没被动**（这是运行时开关，不是配置）',
    fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8') === cfgBefore);
  check('关掉时主动分享也跟着显示为关', off.json.share.enabled === false);
  check('关掉时会说明这是"被控制台覆盖"', off.json.overridden.lifeEnabled === true);

  const on = await post('/api/life', { lifeEnabled: true });
  check('开回来生效', on.json.enabled === true);

  const shOff = await post('/api/life', { shareEnabled: false });
  check('关掉主动发言生效', shOff.json.share.enabled === false);
  const shOn = await post('/api/life', { shareEnabled: true });
  check('开回主动发言生效', shOn.json.share.enabled === true);

  check('乱给的键被忽略（别让控制台变成万能后门）',
    (await post('/api/life', { 随便什么: 1 })).json.ok === false);
  check('空请求被拒绝', (await post('/api/life', {})).json.ok === false);

  // ---- 切到一个不存在的，必须拒绝（静默建空文件会让人以为"人生丢了"）----
  const ghost = await post('/api/life', { lifeProfile: '根本不存在的某某' });
  check('切到不存在的人生被拒绝', ghost.json.ok === false, JSON.stringify(ghost.json.error));
  check('被拒绝后当前人生没变', (await api('/api/life')).json.profile === view.profile);

  // ---- 新建一份 + 切过去 + 切回来 ----
  //
  // ⚠ 归宿必须是**测试自己造的**那份，不能拿"用户当前那份"当基准：
  //   选了人设之后，人设会把它的人生名写进 state 的 lifeProfile，
  //   而那份生活日志是**用到时才创建**的（可能还不存在）。
  //   这时候"切回去"会被正确地拒绝，测试却会读成"切不回去"。
  //   实测踩到：用户建了人设 bb（人生也叫 bb、文件还没生成）之后这一节就红了。
  const baseName = '控制台测试基准' + Date.now().toString().slice(-6);
  // 这两份文件是测试造的 —— 名字里只有中文和数字，所以产品算出来的文件名就是它本身
  // （带别的字符会被替换并补短哈希，那样护栏盯的就不是同一个文件了）。
  const livesDirAbs = path.join(ROOT, JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).life?.dir || 'lives');
  guardFile(path.join(livesDirAbs, `${baseName}.json`));
  const base = await post('/api/life', { createLife: baseName, seed: false });
  check('先造一份基准人生（这一节的归宿是它，不是用户当前那份）',
    base.json.profile === baseName, JSON.stringify(base.json.error));
  const baseTotal = base.json.total;

  const testName = '控制台测试人生' + Date.now().toString().slice(-6);
  guardFile(path.join(livesDirAbs, `${testName}.json`));
  const created = await post('/api/life', { createLife: testName, seed: true, seedFrom: baseName });
  check('新建人生成功并自动切过去', created.json.profile === testName, JSON.stringify(created.json.error));
  check('新人生出现在列表里', created.json.lives.some((x) => x.profile === testName));
  check('勾了"复制当起点"就带上了条数', created.json.total === baseTotal, `${created.json.total} vs ${baseTotal}`);

  const again = await post('/api/life', { createLife: testName });
  check('同名再建被拒绝（绝不覆盖别人的人生）', again.json.ok === false, JSON.stringify(again.json.error));

  const back = await post('/api/life', { lifeProfile: baseName });
  check('能切回原来那份', back.json.profile === baseName);
  check('切回去之后原那份的条数没变', back.json.total === baseTotal, `${back.json.total} vs ${baseTotal}`);
  check('新建那份还在列表里（没被选中的也保存着）',
    back.json.lives.some((x) => x.profile === testName && x.total === baseTotal));

  // ---- 清理：删掉两份临时人生 + 还原 state ----
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const dir = path.join(ROOT, conf.life?.dir || 'lives');
  for (const f of (fs.existsSync(dir) ? fs.readdirSync(dir) : [])) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j.profile === testName || j.profile === baseName) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* 忽略 */ } }
    } catch { /* 忽略 */ }
  }
  if (stateBefore !== null) fs.writeFileSync(STATE, stateBefore, 'utf8');
  else { try { fs.unlinkSync(STATE); } catch { /* 忽略 */ } }

  const restored = await api('/api/life');
  check('测试结束后当前人生还原了', restored.json.profile === view.profile, restored.json.profile);
  check('两份临时人生都已删除',
    !restored.json.lives.some((x) => x.profile === testName || x.profile === baseName),
    JSON.stringify((restored.json.lives || []).map((x) => x.profile)));
}

// ------------------------------------------------------------- 边界情况
console.log('\n8) 边界情况');
{
  const bad = await post('/api/config', { config: { 'trigger.whitelist': ['测试会话'] } });
  check('无效写入不崩', bad.status === 200);
  // 改回去
  await post('/api/config', { config: { 'trigger.whitelist': cfg.json.trigger.whitelist } });
  const restored = await api('/api/config');
  check('白名单已还原', JSON.stringify(restored.json.trigger.whitelist) === JSON.stringify(cfg.json.trigger.whitelist),
    JSON.stringify(restored.json.trigger.whitelist));

  const nf = await api('/api/nonexistent');
  check('未知路径返回 404', nf.status === 404, `status=${nf.status}`);

  const envName = await post('/api/config', { keys: { 'bad name!': 'x' } });
  check('非法环境变量名被忽略', envName.status === 200, '没写进 .env');
}

console.log('\n' + '='.repeat(70));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(70));
process.exitCode = fail > 0 ? 1 : 0;
