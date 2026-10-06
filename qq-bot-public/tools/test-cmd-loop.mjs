/**
 * test-cmd-loop.mjs — 「接管指令被反复执行」的回归测试。
 *
 * 用户报的现象：发了「你接管」之后，程序反复处理这条指令。
 *
 * 真实原因（比现象严重得多）：
 *   一条老指令会**永远留在聊天窗里**，每一轮扫描（约 4 秒）都被 detectTakeoverCommand
 *   重新检测到。而 bot.js 当时的写法是：
 *
 *       if (takeoverCmd.cmd && takeoverCmd.message) {
 *         ...
 *         if (wasOn !== willBe) { ...应答... }
 *         else { log.info('已经是...状态，忽略'); }
 *         saveState(state);
 *         return {...};        // ← 无条件 return，else 分支也走这里
 *       }
 *
 *   于是每一轮扫描都在这里掉头，后面「把消息放进待回复队列」那段**永远走不到**，
 *   机器人再也不会回任何消息 —— 整个死掉，而且不报错。
 *
 *   日志上的铁证：刷满「接管指令 → 已经是开启状态，忽略」，
 *   两条之间**一条扫描汇总都没有**（汇总在 return 之后）。
 *
 * 用法：node tools/test-cmd-loop.mjs
 */
import { detectTakeoverCommand, planTakeoverCommand } from '../src/takeover.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

const CFG = {
  persona: {
    enabled: false,
    takeoverPatterns: ['你接管', '你来接管', '接管吧', '你上'],
    releasePatterns: ['你下班', '下班吧', '退了'],
  },
  trigger: {},
};

/** 造一个 parsed：newest 在最后（和解析器输出的顺序一致）。 */
function mkParsed(texts, conversation = '示例群') {
  return {
    conversation,
    isGroup: true,
    messages: texts.map((text, i) => ({
      index: i, side: 'incoming', sender: '群友乙', text, y: 100 + i * 40,
    })),
  };
}

console.log('='.repeat(70));
console.log('接管指令：不许被反复执行，也不许卡住扫描');
console.log('='.repeat(70));

// ------------------------------------------------------- 1. 窗口限制
section('1) 只在最近几条里找指令（老指令不许复活）');
{
  // 指令在最前面，后面跟了 5 条普通消息 → 早已滚出窗口
  const stale = mkParsed(['@示例昵称 你接管', '打王者吗', '来', '草', '行', '好']);
  check('老指令滚出窗口后检测不到（默认窗口 3）',
    detectTakeoverCommand(stale, CFG).cmd === null,
    JSON.stringify(detectTakeoverCommand(stale, CFG).cmd));

  // 指令在最近 3 条之内 → 检测得到
  const fresh = mkParsed(['草', '行', '@示例昵称 你接管']);
  check('最近 3 条内的指令检测得到', detectTakeoverCommand(fresh, CFG).cmd === 'enable');

  // 窗口可配。
  // 注意缩小窗口的方向别写反：window=1 意思是「只看最后 1 条」，
  // 所以指令是最后一条时**仍然认得出**，指令后面只要还有 1 条就认不出。
  check('persona.commandWindow 可以放大窗口',
    detectTakeoverCommand(stale, { ...CFG, persona: { ...CFG.persona, commandWindow: 8 } }).cmd === 'enable');
  check('window=1 时，指令是最后一条仍认得出',
    detectTakeoverCommand(mkParsed(['草', '行', '@示例昵称 你接管']),
      { ...CFG, persona: { ...CFG.persona, commandWindow: 1 } }).cmd === 'enable');
  check('window=1 时，指令后面只要还有 1 条就认不出',
    detectTakeoverCommand(mkParsed(['@示例昵称 你接管', '草']),
      { ...CFG, persona: { ...CFG.persona, commandWindow: 1 } }).cmd === null);
  check('commandWindow 传 0 / 负数时回退成 3（不许变成"扫全部"）',
    detectTakeoverCommand(stale, { ...CFG, persona: { ...CFG.persona, commandWindow: 0 } }).cmd === null
    && detectTakeoverCommand(stale, { ...CFG, persona: { ...CFG.persona, commandWindow: -5 } }).cmd === null);
  check('opts.window 覆盖 persona.commandWindow',
    detectTakeoverCommand(stale, CFG, { window: 8 }).cmd === 'enable');

  // 新的盖过旧的
  const both = mkParsed(['@示例昵称 你接管', '中间聊了几句', '@示例昵称 你下班']);
  check('同时存在时，新指令盖过旧指令', detectTakeoverCommand(both, CFG).cmd === 'disable',
    String(detectTakeoverCommand(both, CFG).cmd));

  check('自己发的指令不算（不许自问自答）',
    detectTakeoverCommand({ conversation: 'c', messages: [{ side: 'self', text: '你接管' }] }, CFG).cmd === null);
  check('空 messages 不抛',
    detectTakeoverCommand({ conversation: 'c', messages: [] }, CFG).cmd === null);
  check('parsed 为 undefined 不抛',
    detectTakeoverCommand(undefined, CFG).cmd === null);
}

// ------------------------------------------------------- 2. plan 决策
section('2) planTakeoverCommand：切/不切要分清楚');
{
  const on = { takeoverEnabled: true, conversation: 'c' };
  const off = { takeoverEnabled: false, conversation: 'c' };
  const en = { cmd: 'enable', message: { side: 'incoming', text: '@示例昵称 你接管' } };
  const dis = { cmd: 'disable', message: { side: 'incoming', text: '@示例昵称 你下班' } };

  check('没检测到 → none', planTakeoverCommand(off, { cmd: null, message: null }, CFG).action === 'none');
  check('关着 + 开启指令 → apply', planTakeoverCommand(off, en, CFG).action === 'apply');
  check('apply 的 willBe=true', planTakeoverCommand(off, en, CFG).willBe === true);
  check('开着 + 开启指令 → ignore（不重复执行）', planTakeoverCommand(on, en, CFG).action === 'ignore');
  check('关着 + 下班指令 → ignore', planTakeoverCommand(off, dis, CFG).action === 'ignore');
  check('开着 + 下班指令 → apply', planTakeoverCommand(on, dis, CFG).action === 'apply');
  check('apply 的 willBe=false', planTakeoverCommand(on, dis, CFG).willBe === false);

  // fingerprint 必须跟 gate.js 里 decide 用的键**逐字一致**，
  // 否则「指令消息不参与普通回复」那条排除就失效了，机器人会回自己一句「你接管」
  const p = planTakeoverCommand({ takeoverEnabled: false, conversation: '示例群' }, en, CFG);
  check('fingerprint 格式 = conversation|side|text（和 decide 的键一致）',
    p.fingerprint === '示例群|incoming|@示例昵称 你接管', String(p.fingerprint));

  check('reason 是给人看的、非空', typeof p.reason === 'string' && p.reason.length > 0, p.reason);
  check('state 为 undefined 不抛', (() => {
    try { planTakeoverCommand(undefined, en, CFG); return true; } catch { return false; }
  })());
}

// ------------------------------------------- 3. 核心回归：反复扫描的模拟
section('3) 核心回归：同一条老指令连续扫描 20 轮');
{
  // 关键前提：指令就摆在聊天窗里，**每一轮都看得见**（这就是真实情况）
  const parsed = mkParsed(['@示例昵称 你接管']);
  const state = { takeoverEnabled: false, conversation: '示例群' };
  const actions = [];
  let acks = 0;

  for (let i = 0; i < 20; i++) {
    const det = detectTakeoverCommand(parsed, CFG);
    const plan = planTakeoverCommand(state, det, CFG);
    actions.push(plan.action);
    if (plan.action === 'apply') {
      state.takeoverEnabled = plan.willBe;
      acks++;                      // 只有 apply 才会真的发应答
    }
    // ignore → 调用方继续往下走（不 return）。这里模拟「别的消息照常处理」。
  }

  const applies = actions.filter((a) => a === 'apply').length;
  const ignores = actions.filter((a) => a === 'ignore').length;

  check('20 轮里只 apply 了 1 次（第一轮）', applies === 1, `apply=${applies}`);
  check('应答也只发了 1 条（不会刷屏）', acks === 1, `acks=${acks}`);
  check('剩下 19 轮全是 ignore（不是 none —— 指令确实每轮都被看见）', ignores === 19, `ignore=${ignores}`);
  check('第一轮就是 apply', actions[0] === 'apply');
  check('第二轮起全是 ignore', actions.slice(1).every((a) => a === 'ignore'));

  // 第 2 轮之后必须有 ignore —— 这正是旧代码会卡住的位置。
  // 旧代码在 ignore 时也 return，所以「有没有卡住」只能靠源码断言（第 4 节）。
  check('状态确实被切成开着', state.takeoverEnabled === true);
}

// ---------------------------------------- 4. bot.js 源码契约（防回退）
section('4) bot.js 源码契约：ignore 时不许掉头');
{
  const src = readFileSync(path.join(ROOT, 'src', 'bot.js'), 'utf8');

  check('旧的 `if (takeoverCmd.cmd && takeoverCmd.message) {` 整块已经不在',
    !/if \(takeoverCmd\.cmd && takeoverCmd\.message\)\s*\{/.test(src));
  check('旧的 info 级「已经是…状态，忽略」已经不在',
    !/已经是\$\{willBe \? '开启' : '关闭'\}状态，忽略/.test(src));
  check('已经接入 planTakeoverCommand', src.includes('planTakeoverCommand('));
  check('ignore 分支用 log.debug（用 info 会每 4 秒刷一行）',
    /cmdPlan\.action === 'ignore'\)\s*\{[\s\S]{0,400}?log\.debug\(/.test(src));

  // 最关键的一条：takeover 区块里的提前 return 必须**只有 apply 分支里有**
  const block = src.slice(
    src.indexOf('// ---- 0) 接管/下班指令 ----'),
    src.indexOf('// ---- 1) 决策'),
  );
  const returns = (block.match(/return \{ parsed, result/g) ?? []).length;
  check('接管区块里只有 1 处提前 return', returns === 1, `${returns} 处`);
  check('那 1 处 return 在 apply 分支内（在 ignore 分支之前）',
    block.indexOf('cmdPlan.action === \'apply\'') < block.indexOf('return { parsed, result')
    && block.indexOf('return { parsed, result') < block.indexOf("cmdPlan.action === 'ignore'"),
    '顺序: apply → return → ignore');
  check('ignore 分支之后确实还有入队循环（说明没有掉头）',
    // 注意：入队循环在 `// ---- 1) 决策` 之后，不在 block 里 ——
    // 所以这一条要用全文比，用 block 比会永远拿到 -1（第一版就写错了）
    src.indexOf("cmdPlan.action === 'ignore'") < src.indexOf('enqueuePending(state, d)'),
    `ignore@${src.indexOf("cmdPlan.action === 'ignore'")} < enqueue@${src.indexOf('enqueuePending(state, d)')}`);
  check('指令消息被排除在普通回复之外（防自问自答）',
    src.includes('d.fingerprint === cmdPlan.fingerprint'));
  check('指令消息无条件 markSeen（否则会被当普通消息回）',
    /if \(cmdPlan\.action !== 'none'\)[\s\S]{0,200}?markSeen\(state, cmdPlan\.fingerprint\)/.test(src));
}

// ------------------------------------------- 5. 真实 config 里的窗口设置
section('5) 真实 config.json 自检（只读）');
{
  const cfg = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  check('persona.takeoverPatterns 里有「你接管」',
    (cfg.persona?.takeoverPatterns ?? []).includes('你接管'),
    JSON.stringify(cfg.persona?.takeoverPatterns));
  check('persona.releasePatterns 存在（不然只能开不能关）',
    Array.isArray(cfg.persona?.releasePatterns) && cfg.persona.releasePatterns.length > 0,
    JSON.stringify(cfg.persona?.releasePatterns));

  // 用真实配置跑一遍「指令+后续聊天」的场景，确认不会误判
  const real = mkParsed(['@示例昵称 你接管', '??', '啥情况', '怎么不回我']);
  check('真实配置下，指令后面只要来了 3 条消息就不再被检测',
    detectTakeoverCommand(real, cfg).cmd === null,
    String(detectTakeoverCommand(real, cfg).cmd));
}

console.log('\n' + '='.repeat(70));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(70));
process.exit(fail === 0 ? 0 : 1);
