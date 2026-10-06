/**
 * test-sessions.mjs — 回归测试：自动切换聊天。
 *
 * 用户要求：「加入可以自动切换每一个聊天的功能，而非手动抓取」。
 *
 * 这个功能有两块，测试也分两块：
 *   1. **纯判定**（src/sessions.js）：该去哪些会话、下一个是谁、该不该现在切。
 *      这些能直接测，不用碰界面。
 *   2. **会话列表的解析**：从 uia-read.ps1 的输出里认出「会话名」。
 *      这一块用**实机抓下来的夹具**测 —— 手搓的 JSON 很容易刚好绕开真实布局。
 *
 * 为什么不测"真的去点"：那会动用户的鼠标。点击那条路由
 * src/switch.js 单独隔离，这里只检查它的接线（脚本名、参数、还原光标）。
 *
 * 用法：node tools/test-sessions.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseSessions, sessionMatches, targetConversations,
  pickNextConversation, findSessionPoint, shouldSwitchNow, judgeClick,
  autoScopeOf, shouldPauseForUser,
} from '../src/sessions.js';
import { configLooksConfigured, skipNote } from './testkit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`); }
}

// 拿真实 config.json 交叉验证的那几条（「自动切换是不是真的开着」）：
// 在已经配好的机器上它们能抓到"我改了配置没生效"，在刚导出的副本上
// 只能说明"还没配"。所以配没配好先问一句，没配就 [SKIP] 而不是红。
const REAL_READY = configLooksConfigured(JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')));
const checkReal = (name, cond, detail = '') => {
  if (!REAL_READY) { skipNote(name); return; }
  check(name, cond, detail);
};
function section(t) { console.log(`\n${t}`); }

/** 读 uia-read.ps1 的输出（PowerShell 的 `>` 写的是 UTF-16LE）。 */
function readUia(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xFF && buf[1] === 0xFE) return JSON.parse(buf.toString('utf16le').replace(/^\uFEFF/, ''));
  return JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));
}

console.log('='.repeat(72));
console.log('自动切换聊天');
console.log('='.repeat(72));

// ------------------------------------------------------ 1. 会话列表解析
section('1) 从 UIA 输出里认出会话名和点击点');
{
  // 实机夹具：这一份里有 4 个会话，每个都带"名字 + 最后一条消息预览"两行
  const live = path.join(ROOT, 'tools', 'fixtures', 'uia-sessions.json');
  if (!fs.existsSync(live)) {
    // 跳过，**不算失败**：夹具里是真实群名和聊天预览，不随仓库发布。
    // 记成 FAIL 会让"新克隆下来跑一遍"看起来像项目坏了，而其实只是少了一份
    // 只有开发机才有的数据（这个区别对第一次接触这个项目的人很重要）。
    console.log('  [SKIP] uia-sessions.json 不在（含真实群名，未随仓库发布）—— 这一节跳过');
  } else {
    const uia = readUia(live);
    const sessions = parseSessions(uia);

    check('解析出会话列表', sessions.length >= 2, `${sessions.length} 个`);
    check('每个都有名字', sessions.every((s) => s.name), JSON.stringify(sessions.map((s) => s.name)));

    // 关键：不能把"最后一条消息预览"当成会话名。
    // 实测布局：名字 h=22、预览 h=19，且名字在同一簇里更靠上。
    const names = sessions.map((s) => s.name);
    const previews = ['你已被移出群聊', '示例昵称：', '嗯嗯嗯'];
    check('没有把消息预览当成会话名',
      !names.some((n) => previews.includes(n)), JSON.stringify(names.filter((n) => previews.includes(n))));
    check('名字宽度正常（不是被截断的预览片段）',
      sessions.every((s) => s.w >= 20), JSON.stringify(sessions.map((s) => [s.name, s.w])));

    // 点击点必须落在元素内部
    check('点击点在元素中心',
      sessions.every((s) => Math.abs(s.cx - (s.x + s.w / 2)) <= 1 && Math.abs(s.cy - (s.y + s.h / 2)) <= 1),
      JSON.stringify(sessions[0]));

    // 同一份输入解析两次结果要一致（别引入随机/顺序依赖）
    check('解析是稳定的', JSON.stringify(parseSessions(uia)) === JSON.stringify(sessions));
  }

  // 脏数据不许抛
  for (const bad of [undefined, null, {}, { conversations: 'x' }, { conversations: [null, 1, {}] },
    { conversations: [{ name: 'ok', x: 1, y: 2, w: 10, h: 10 }, { name: '', x: 1, y: 2, w: 3, h: 3 },
      { name: 'zero', x: 0, y: 0, w: 0, h: 0 }] }]) {
    let threw = false;
    let out = null;
    try { out = parseSessions(bad); } catch { threw = true; }
    check(`parseSessions(${JSON.stringify(bad)?.slice(0, 26) ?? 'undefined'}) 不抛`, threw === false);
    if (!threw && out) {
      check('  结果一定是数组且每项都有名字', Array.isArray(out) && out.every((s) => s.name));
    }
  }
}

// ------------------------------------------------------ 2. 名字匹配
section('2) 会话名匹配（跟白名单同一套规则）');
{
  check('完全相等', sessionMatches('示例群', '示例群') === true);
  check('子串也算（白名单用的是 includes）', sessionMatches('示例群（10）', '示例群') === true);
  check('不一样就是不匹配', sessionMatches('别的群', '示例群') === false);
  check('空目标不匹配（别把空串当通配）', sessionMatches('任何', '') === false);
  check('两边都 undefined 不抛', sessionMatches(undefined, undefined) === false);
}

// ------------------------------------------------------ 3. 该去哪些会话
section('3) 该轮流看哪些会话');
{
  const sessions = [
    { name: '示例群', x: 1, y: 1, w: 10, h: 10, cx: 6, cy: 6 },
    { name: '示例群友、群友甲、示例昵称', x: 1, y: 20, w: 10, h: 10, cx: 6, cy: 25 },
    { name: '无关的群', x: 1, y: 40, w: 10, h: 10, cx: 6, cy: 45 },
  ];

  const cfgDefault = { autoSwitch: {}, trigger: { whitelist: ['示例群'] } };
  check('默认用白名单', targetConversations(cfgDefault, sessions).join(',') === '示例群',
    JSON.stringify(targetConversations(cfgDefault, sessions)));

  const cfgOwn = { autoSwitch: { conversations: ['无关的群'] }, trigger: { whitelist: ['示例群'] } };
  check('autoSwitch.conversations 优先于白名单',
    targetConversations(cfgOwn, sessions).join(',') === '无关的群',
    JSON.stringify(targetConversations(cfgOwn, sessions)));

  // 白名单里写了个已经退出的群 → 不该去点它（列表里没有）
  const cfgGone = { autoSwitch: {}, trigger: { whitelist: ['早就退了的群'] } };
  check('列表里没有的目标会被过滤掉（不会瞎点）',
    targetConversations(cfgGone, sessions).length === 0);

  check('空配置不抛', Array.isArray(targetConversations({}, sessions)));
  check('一个都匹配不上时返回空', targetConversations({ autoSwitch: {}, trigger: {} }, sessions).length === 0);
}

// ------------------------------------------- 3b. 轮询范围三档（用户 2026-10-06 要求）
//
// 用户原话：「无法对非当前界面的QQ聊天进行监测，是否能通过轮询每一个对话来检测」。
// 选的是「全部会话都轮询，但只在白名单里回」—— 所以 scope=all 必须**不受白名单限制**
// 地覆盖整个会话列表，而"回不回"是另一件事（gate.js 管）。
section('3b) 轮询范围：全部 / 白名单 / 指定列表');
{
  const sessions = [
    { name: '测试群' }, { name: '示例群' }, { name: '无关的群' }, { name: '不想理的群' },
  ];

  const all = { autoSwitch: { scope: 'all' }, trigger: { whitelist: ['测试群'], blacklist: ['不想理的群'] } };
  check('scope=all 时整个会话列表都轮（白名单管不着它）',
    targetConversations(all, sessions).join(',') === '测试群,示例群,无关的群',
    JSON.stringify(targetConversations(all, sessions)));
  check('scope=all 也照样尊重黑名单（"别回这个"更该"别老点开看"）',
    !targetConversations(all, sessions).includes('不想理的群'));

  const wl = { autoSwitch: { scope: 'whitelist' }, trigger: { whitelist: ['测试群'] } };
  check('scope=whitelist 只轮白名单', targetConversations(wl, sessions).join(',') === '测试群');

  const lst = { autoSwitch: { scope: 'list', conversations: ['示例群', '不在列表里的群'] }, trigger: { whitelist: ['测试群'] } };
  check('scope=list 只轮指定列表，且跟会话列表取交集',
    targetConversations(lst, sessions).join(',') === '示例群',
    JSON.stringify(targetConversations(lst, sessions)));

  // ⚠ 老配置没有 scope 字段，语义不能悄悄变：有 conversations 用列表，否则用白名单
  check('没写 scope 且没有 conversations → 还是白名单（老配置行为不变）',
    autoScopeOf({ autoSwitch: {} }) === 'whitelist');
  check('没写 scope 但有 conversations → 用列表（老配置行为不变）',
    autoScopeOf({ autoSwitch: { conversations: ['x'] } }) === 'list');
  check('乱写 scope → 按老规矩推，不抛',
    autoScopeOf({ autoSwitch: { scope: '乱写的' } }) === 'whitelist');
}

// ------------------------------------------- 3c. "你在用电脑就暂停"闸门
//
// 轮询必须点击 QQ 的会话列表并把它抢到前台。Windows 不允许后台进程在用户活跃时
// 抢前台（实测：抢不到，那一下变成"激活窗口"），后果是**你打字打到一半被切走**。
// 所以用系统空闲时间当闸门。
section('3c) 空闲闸门：你一动键鼠就暂停轮询');
{
  const cfg = { autoSwitch: { pauseWhenActive: true, activeIdleMs: 4000 } };
  check('刚动过键鼠 → 暂停', shouldPauseForUser(cfg, 300).ok === false);
  check('暂停理由说清了差多久', /0\.3s|闲置/.test(shouldPauseForUser(cfg, 300).reason),
    shouldPauseForUser(cfg, 300).reason);
  check('闲置够久 → 放行', shouldPauseForUser(cfg, 5000).ok === true);
  check('正好到阈值 → 放行', shouldPauseForUser(cfg, 4000).ok === true);

  check('关掉暂停开关 → 永远放行', shouldPauseForUser({ autoSwitch: { pauseWhenActive: false } }, 0).ok === true);
  check('读不到空闲时间（-1）→ 放行，不让探测失败把轮询锁死',
    shouldPauseForUser(cfg, -1).ok === true);
  check('NaN 也当读不到处理', shouldPauseForUser(cfg, NaN).ok === true);

  const custom = { autoSwitch: { pauseWhenActive: true, activeIdleMs: 15000 } };
  check('阈值可以调（15s）', shouldPauseForUser(custom, 5000).ok === false
    && shouldPauseForUser(custom, 20000).ok === true);
}

// ------------------------------------------------------ 4. 下一个是谁
section('4) 轮询：下一个切哪儿（以及什么时候不该切）');
{
  const targets = ['A群', 'B群', 'C群'];

  check('没切过、当前不在目标上 → 从第一个开始',
    pickNextConversation(targets, '别的', '')?.name === 'A群');

  // 已经在某个目标上 → 从它的下一个开始，别白点一次
  check('当前就在 A 上 → 下一个是 B（不重复点 A）',
    pickNextConversation(targets, 'A群', '')?.name === 'B群');

  check('上次切到 A → 这次 B', pickNextConversation(targets, 'B群', 'A群')?.name === 'B群');
  check('轮到最后回到开头', pickNextConversation(targets, 'A群', 'C群')?.name === 'A群');

  // 只有一个目标时：已经在上面就别动（每次点击都抢焦点）
  check('只有一个目标且已经在上面 → 不切',
    pickNextConversation(['A群'], 'A群', '') === null);
  check('只有一个目标但当前不在上面 → 切过去',
    pickNextConversation(['A群'], '别的', '')?.name === 'A群');

  check('没有目标 → 不切', pickNextConversation([], '任何', '') === null);
  check('targets 是 undefined 也不抛', pickNextConversation(undefined, 'x', '') === null);

  // 用户手动切走了：轮询不能卡住
  const seq = [];
  let last = '';
  for (let i = 0; i < 6; i++) {
    const p = pickNextConversation(targets, '用户手动打开的群', last);
    seq.push(p.name);
    last = p.name;
  }
  check('来回轮询覆盖所有目标（不会卡在同一个）',
    new Set(seq).size === 3, seq.join(','));
}

// ------------------------------------------------------ 5. 找点击点
section('5) 按名字找点击点');
{
  const sessions = [
    { name: '示例群', x: 1413, y: 284, w: 91, h: 22, cx: 1459, cy: 295 },
    { name: '示例群友、群友甲、示例昵称', x: 1413, y: 364, w: 171, h: 22, cx: 1499, cy: 375 },
  ];
  check('精确命中', findSessionPoint(sessions, '示例群')?.cx === 1459);
  check('带成员数也能命中（归一后匹配）',
    findSessionPoint(sessions, '示例群（10）')?.cx === 1459,
    JSON.stringify(findSessionPoint(sessions, '示例群（10）')));
  check('找不到返回 null（调用方要跳过，不能瞎点）',
    findSessionPoint(sessions, '不存在的群') === null);
  check('空名字返回 null', findSessionPoint(sessions, '') === null);
  check('sessions 为空不抛', findSessionPoint([], 'x') === null);
}

// ------------------------------------------------------ 6. 该不该现在切
section('6) 该不该现在真的去点');
{
  const on = { autoSwitch: { enabled: true, minGapMs: 3000 } };
  const off = { autoSwitch: { enabled: false } };

  check('开关关着 → 不切', shouldSwitchNow(off, 0, 1000).ok === false);
  check('开关关着的理由是"没开"', shouldSwitchNow(off, 0, 1000).reason.includes('没开'));
  check('刚切过 → 先别切（界面还没刷完）',
    shouldSwitchNow(on, 1000, 2000).ok === false);
  check('隔够了 → 可以切', shouldSwitchNow(on, 1000, 5000).ok === true);
  check('从没切过 → 可以切', shouldSwitchNow(on, 0, 1).ok === true);
  check('minGapMs=0 时不限速', shouldSwitchNow({ autoSwitch: { enabled: true, minGapMs: 0 } }, 1000, 1001).ok === true);
  check('enabled 是字符串 "true" 不算开（必须真布尔）',
    shouldSwitchNow({ autoSwitch: { enabled: 'true' } }, 0, 1).ok === false);
}

// ------------------------------------------------------ 7. 接线
section('7) 接线：谁去点、点了之后做什么');
{
  const sw = fs.readFileSync(path.join(ROOT, 'src', 'switch.js'), 'utf8');
  check('switch.js 调 uia-read.ps1 读列表', sw.includes("'uia-read.ps1'"));
  check('switch.js 调 qq-click.ps1 去点', sw.includes("'qq-click.ps1'"));
  check('默认还原光标（别把人家光标丢在会话列表上）',
    sw.includes("opts.restoreCursor !== false") && sw.includes("args.push('-Restore')"));
  check('点击前重新读坐标（旧坐标等于随机点界面）',
    /if \(!sessions\)[\s\S]{0,200}?readSessions\(/.test(sw));
  check('切完会等界面刷新', /settleMs|waitMs/.test(sw) && sw.includes('setTimeout'));
  check('找不到目标时明确失败（带上有哪些会话，便于排查）',
    /找不到「\$\{want\}」/.test(sw) && sw.includes('当前有：'));

  const bot = fs.readFileSync(path.join(ROOT, 'src', 'bot.js'), 'utf8');
  check('bot.js 导入了切换能力',
    bot.includes("from './switch.js'") && bot.includes("from './sessions.js'"));

  // 注意要从**主循环里**找，不能用全文 indexOf —— 文件前面 `--once` 那条分支
  // 也有一模一样的 `await scanOnce(...)`，全文找会拿到那一处（自己踩的）。
  const loopAt = bot.indexOf('while (running) {');
  const switchAt = bot.indexOf('await maybeSwitchConversation()', loopAt);
  const scanAt = bot.indexOf('await scanOnce(state, { verbose: cfg.cli.verbose });', loopAt);
  check('切换发生在扫描**之前**（这样这轮读到的就是新会话）',
    switchAt > 0 && scanAt > switchAt, `loop@${loopAt} switch@${switchAt} scan@${scanAt}`);
  check('切换出错不会让监测停掉（try/catch 包着）',
    /try\s*\{[\s\S]{0,120}?await maybeSwitchConversation\(\)[\s\S]{0,200}?catch/.test(bot));
  check('只在开启时才提示"会抢鼠标"', bot.includes('会去点 QQ 的会话列表'));
  check('扫描读到的会话名会纠正当前会话（用户手动换过也能跟上）',
    /if \(parsed\.conversation\) setCurrentConversation\(parsed\.conversation\)/.test(bot));

  // 会动鼠标的地方要集中：只有 switch.js 应该**调用** qq-click.ps1。
  // 判据是"真的用 runPs 去跑它"，不是"文件里提到过这个词" ——
  // 注释里提一嘴（sessions.js 就提了）不该算数，第一版这么写误报过一次。
  const callers = ['src/bot.js', 'src/sessions.js', 'src/switch.js'].filter((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    return /runPs\(\s*'qq-click\.ps1'/.test(src);
  });
  check('只有 switch.js 会去点鼠标（其它模块不碰输入）',
    callers.length === 1 && callers[0] === 'src/switch.js', JSON.stringify(callers));

  // PowerShell 脚本必须纯 ASCII
  // （qq-send-message.ps1 也一起查：它本来有三行中文注释，违反了这条规矩 ——
  //   注释里的乱码平时无害，但乱码落在行首会被 cmd/PowerShell 当命令执行，
  //   这个坑本项目踩过两次。既然改了它，就顺手让它受检查。）
  for (const f of ['qq-click.ps1', 'uia-read.ps1', 'qq-send-message.ps1']) {
    const bytes = fs.readFileSync(path.join(ROOT, 'tools', f));
    const nonAscii = [...bytes].filter((b) => b > 127).length;
    check(`tools/${f} 是纯 ASCII`, nonAscii === 0, `非 ASCII ${nonAscii} 字节`);
  }

  // ---- 实机踩出来的两个坑，必须留住 ----
  //
  // 坑一：UIA 给的是**物理**像素，而没声明 DPI 感知的 PowerShell 活在虚拟坐标空间里。
  //       表现极其误导：脚本报 ok、光标真的动了、点却落在别的地方，什么都没发生。
  // 坑二：点击一个**不在前台**的窗口，那一下只会"激活"它，控件收不到点击。
  //       表现同样误导：坐标完全正确（回读光标验证过），会话就是不切。
  const click = fs.readFileSync(path.join(ROOT, 'tools', 'qq-click.ps1'), 'utf8');
  check('点击脚本声明了 DPI 感知（否则物理坐标会落错地方）',
    click.includes('SetProcessDPIAware()'), '');
  check('点击前会把目标窗口提到前台（否则点击被"激活"吃掉）',
    click.includes('SetForegroundWindow') && click.includes('ForegroundHandle'));
  check('点完回读光标位置并报出偏移量（落错地方要能看出来）',
    click.includes('drift') && click.includes('landed'));
  check('点击脚本不再用"完全相等"判成败（实测差 1~4px 也切成功了，那样会把成功报成失败）',
    !/\$landed\[0\]\s*-eq\s*\$X/.test(click));
  check('switch.js 会把窗口句柄传下去',
    sw.includes('-ForegroundHandle') && sw.includes('handle'));
  check('readSessions 会把句柄带回来',
    sw.includes('handle: Number(raw.handle)'));
  check('switch.js 用 judgeClick 决定落点能不能信（判定留给 Node，脚本只报事实）',
    sw.includes('judgeClick'));
  check('落点可疑时 switch.js 会读一次界面复核，而不是直接判失败',
    sw.includes('readCurrentConversation') && sw.includes('verified: true'));

  // 光标落点偏移的判断放在 Node 里，因为它需要单元测试。
  // 下面这些数字全是实机量出来的。
  section('落点偏移的判定（judgeClick）');
  check('落点准确 → 可信', judgeClick({ ok: true, drift: 0 }).ok);
  check('差 1px → 仍然可信', judgeClick({ ok: true, drift: 1 }).ok);
  check('差 3px（实测 452 vs 455）→ 仍然可信', judgeClick({ ok: true, drift: 3 }).ok,
    JSON.stringify(judgeClick({ ok: true, drift: 3 })));
  check('差 4px（实测 1503 vs 1499 = 4）→ 仍然可信', judgeClick({ ok: true, drift: 4 }).ok);
  check('差 5px → 可疑，且 suspect 为真（调用方该去读界面复核）',
    judgeClick({ ok: true, drift: 5 }).ok === false && judgeClick({ ok: true, drift: 5 }).suspect === true);
  check('差 300px（真的坐标空间不对）→ 可疑',
    judgeClick({ ok: true, drift: 300 }).suspect === true);
  check('脚本没输出 → 不可信且 not suspect（没点出去，复核也没意义）',
    judgeClick(null).ok === false && judgeClick(null).suspect === false);
  check('脚本报错 → 不可信、not suspect，原因里带原始报错',
    judgeClick({ ok: false, error: 'boom' }).suspect === false &&
    judgeClick({ ok: false, error: 'boom' }).reason.includes('boom'));
  check('没有 drift 字段（旧版脚本）→ 视为可信，不能因此卡死',
    judgeClick({ ok: true }).ok === true);
  check('tolerance 可覆盖', judgeClick({ ok: true, drift: 20 }, { tolerance: 30 }).ok === true);
  check('tolerance 默认是 4', judgeClick({ ok: true, drift: 5 }).suspect === true);

  // 切换成功与否，最终由界面说了算
  section('切换复核');
  const botSrc = fs.readFileSync(path.join(ROOT, 'src', 'bot.js'), 'utf8');
  check('bot 扫描之后会核对"以为切到的"和"界面实际在的"会话',
    botSrc.includes('sessionMatches(actual, switchIntent)'));
  check('核对不上会立刻重试（清掉最小间隔，而不是干等）',
    /switchMisses[\s\S]{0,400}lastSwitchAt = 0/.test(botSrc));
  check('连续切不过去会自动停用自动切换（免得反复动鼠标）',
    botSrc.includes('autoSwitchOn = false'));
  check('maybeSwitchConversation 返回切到哪个会话（否则没法复核）',
    botSrc.includes('return r.name;'));

  // 实机踩的第三个坑，也是最阴的一个：
  // bot 把会话列表传给了 switch.js，却没传窗口句柄 → 那句 SetForegroundWindow
  // 根本没执行 → 点击被"激活窗口"吃掉。表现是：脚本报成功、界面纹丝不动、
  // 而同一套代码手动跑却 5/5 成功（手动跑那条路径自己读取了句柄）。
  check('bot 把窗口句柄一起传给 switch.js（否则前台激活不会执行）',
    /handle:\s*read\.handle/.test(botSrc),
    '');
  check('switch.js 在只有 sessions 没有句柄时会去补读一次句柄',
    /else if \(!\(handle > 0\)\)/.test(sw));
  check('switch.js 拿不到句柄时宁可拒绝点击，也不盲点',
    sw.includes('拿不到 QQ 窗口句柄'));
  check('点击仍然一定带 -ForegroundHandle', sw.includes("'-ForegroundHandle'"));

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  check('config 里有 autoSwitch', Boolean(cfg.autoSwitch));
  check('autoSwitch 带"会动鼠标"的警告注释',
    Array.isArray(cfg.autoSwitch.$comment) && cfg.autoSwitch.$comment.some((s) => s.includes('鼠标')));
  const r = shouldSwitchNow(cfg, 0, Date.now());
  checkReal('真实 config 下这个开关是"可以切"的状态（用户要求开启）',
    cfg.autoSwitch?.enabled === true, String(cfg.autoSwitch?.enabled));
  void r;
}

console.log('\n' + '='.repeat(72));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(72));
process.exit(fail === 0 ? 0 : 1);
