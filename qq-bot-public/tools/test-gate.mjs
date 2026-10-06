/**
 * test-gate.mjs — 验证概率闸门与决策逻辑。
 *
 * 概率必须用统计验证，不能靠眼看几条。这里断言的是一万次抽样的分布。
 *
 * 用法：node tools/test-gate.mjs
 */
import { loadConfig } from '../src/config.js';
import { readFileSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, loadState, enqueuePending, peekPending, findPendingFor, shiftPendingAt, pendingConversations } from '../src/gate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// state.json 的真实路径（gate.js 用的是同一个位置）。第 15 节要临时动它再还原。
const STATE_FILE = path.join(ROOT, 'state.json');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`); }
}

const baseCfg = loadConfig({ argv: [] });

// 这个测试关心的是**概率闸门**，不关心「群内只在@时回复」—— 后者是第 6 节的专项。
// 而真实 config.json 里那个开关可能是 true（用户自己开了），一旦是 true，
// 所有不带 @ 的测试消息都会在概率判断**之前**就被挡掉，概率测试全体失真。
// 实测踩过：19 通过掉到 11。
//
// 所以这里显式钉成 false，需要 true 的那一节自己打开。
// 同类坑第二次踩了 —— 上一个是 state.json 里的 takeoverEnabled（见 freshState）。
baseCfg.trigger.replyInGroupOnlyWhenMentioned = false;

// 「被 @ 时必回」那一堆断言靠的是 isMentioned，而 isMentioned 读的是
// **cfg.trigger.botNames**。继承真实配置的话，这个测试就悄悄依赖了用户填没填昵称：
//   开发机上 botNames=['示例昵称','小深','D老师']，所以测试里的 "@小深 在吗" 认得出来；
//   一份刚导出的副本里它还是占位符 ['你的QQ昵称']，同一条消息立刻认不出来 ——
//   于是"被 @ 必回""被 @ 时理由标明必回"整片变红，而代码一行没改过。
// 这里钉成本地合成值（和测试文本里出现的名字一致），让它不依赖任何用户配置。
baseCfg.trigger.botNames = ['小深', 'D老师', '示例昵称'];
baseCfg.trigger.mentionPatterns = ['@{bot}', '@{bot} '];

function makeParsed(messages, conversation = '示例群') {
  return {
    source: 'uia',
    conversation,
    isGroup: true,
    messages: messages.map((m, i) => ({
      index: i, side: 'incoming', sender: m.sender ?? '某人',
      text: m.text, x: 1709, y: 553 + i * 40, h: 16, bottom: 569 + i * 40,
    })),
    incoming: [], self: [],
  };
}

/**
 * 造一个干净的测试状态。
 *
 * 关键：**必须显式关掉 takeoverEnabled**。
 * 它原本用 loadState() 读真实 state.json，而真实文件里 takeoverEnabled 可能是 true ——
 * 那样 effectiveReplyProbability 会被强制成 1，所有概率测试都会失真。
 * 实测踩过：接管模式开着时，这个测试从 16 通过掉到 12。
 */
function freshState() {
  const s = loadState();
  s.seen = []; s.sentReplies = []; s.replyTimes = []; s.pending = [];
  s.takeoverEnabled = false;   // 与真实运行状态隔离
  return s;
}

/** 造一个接管模式下的状态，用于验证概率被提升到 100%。 */
function freshTakeoverState() {
  const s = freshState();
  s.takeoverEnabled = true;
  return s;
}

console.log('='.repeat(70));
console.log('概率闸门与决策测试');
console.log('='.repeat(70));

// ---------------------------------------------------------------- 1. 被 @ 必回
console.log('\n1) 被 @ 的消必须必回（哪怕概率设得很低）');
{
  const cfg = JSON.parse(JSON.stringify(baseCfg));
  cfg.trigger.replyProbability = 0.01;
  cfg.trigger.mentionAlwaysReplies = true;
  cfg.trigger.whitelist = ['示例群'];

  let replied = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const state = freshState();
    const parsed = makeParsed([{ text: '@小深 在吗' }]);
    const d = decide(cfg, state, parsed);
    if (d.decisions[0].reply) replied++;
  }
  check(`被 @ 时 ${N} 次全部回复`, replied === N, `实际 ${replied}/${N}`);
}

// ------------------------------------------------------- 2. 非 @ 的回复概率
console.log('\n2) 未被 @ 的消息回复率应接近配置值');
{
  const cfg = JSON.parse(JSON.stringify(baseCfg));
  cfg.trigger.replyProbability = 0.25;
  cfg.trigger.whitelist = ['示例群'];

  const N = 10000;
  let replied = 0;
  for (let i = 0; i < N; i++) {
    const state = freshState();
    const parsed = makeParsed([{ text: `随便一句话 ${i}` }]);
    const d = decide(cfg, state, parsed);
    if (d.decisions[0].reply) replied++;
  }
  const rate = replied / N;
  check(`回复率 ${(rate * 100).toFixed(2)}% 接近 25%`, Math.abs(rate - 0.25) < 0.02, `${replied}/${N}`);
}

// ------------------------------------------------------------ 3. 概率边界值
console.log('\n3) 概率边界：0 = 不回，1 = 全回');
{
  const cfg0 = JSON.parse(JSON.stringify(baseCfg));
  cfg0.trigger.replyProbability = 0;
  cfg0.trigger.whitelist = ['示例群'];
  let r0 = 0;
  for (let i = 0; i < 300; i++) {
    const state = freshState();
    const d = decide(cfg0, state, makeParsed([{ text: `x${i}` }]));
    if (d.decisions[0].reply) r0++;
  }
  check('概率 0 → 一条都不回', r0 === 0, `实际 ${r0}`);

  const cfg1 = JSON.parse(JSON.stringify(baseCfg));
  cfg1.trigger.replyProbability = 1;
  cfg1.trigger.whitelist = ['示例群'];
  let r1 = 0;
  for (let i = 0; i < 300; i++) {
    const state = freshState();
    const d = decide(cfg1, state, makeParsed([{ text: `x${i}` }]));
    if (d.decisions[0].reply) r1++;
  }
  check('概率 1 → 全部回', r1 === 300, `实际 ${r1}`);
}

// --------------------------------------- 4. 概率只掷一次（冻结进 decision）
console.log('\n4) 概率结果随 decision 冻结，不被重复扫描重掷');
{
  const cfg = JSON.parse(JSON.stringify(baseCfg));
  cfg.trigger.replyProbability = 0.5;
  cfg.trigger.whitelist = ['示例群'];

  // 不能只测一条消息 —— 那会随随机数走到不同分支，测试结果时对时错。
  // 这里分别构造「明确命中」和「明确未命中」两种情形（用概率 1 和 0 固定下来）。
  const cfgHit = JSON.parse(JSON.stringify(cfg));
  cfgHit.trigger.replyProbability = 1;
  const stHit = freshState();
  const dHit = decide(cfgHit, stHit, makeParsed([{ text: '一定会被回的消息' }])).decisions[0];
  check('命中时 decision 带 roll 值', typeof dHit.roll === 'number', `roll=${dHit.roll}`);
  check('命中时 reply=true', dHit.reply === true, dHit.reason);
  enqueuePending(stHit, dHit);
  const head = peekPending(stHit);
  check('命中时入队并保留原文', head !== null && head.text === '一定会被回的消息',
    head ? head.text : '(空队列)');
  check('队列项按文本去重（不会重复入队）', enqueuePending(stHit, dHit) === false);

  const cfgMiss = JSON.parse(JSON.stringify(cfg));
  cfgMiss.trigger.replyProbability = 0;
  const stMiss = freshState();
  const dMiss = decide(cfgMiss, stMiss, makeParsed([{ text: '一定不会被回的消息' }])).decisions[0];
  check('未命中时 reply=false 且理由写明', dMiss.reply === false && dMiss.reason.includes('概率未命中'),
    dMiss.reason);
  check('未命中时不入队（bot.js 只对 reply:true 入队）', stMiss.pending.length === 0,
    `pending=${stMiss.pending.length}`);

  // 已处理的消息不会再被决策层重复放行 —— 这个标记由 bot.js 负责，
  // 这里显式模拟一次，确认标记后确实会被去重挡下。
  const st2 = freshState();
  st2.seen.push(`${dHit.conversation}|${dHit.message.side}|${dHit.message.text}`);
  const d2 = decide(cfgHit, st2, makeParsed([{ text: '一定会被回的消息' }])).decisions[0];
  check('已标记处理过的消息第二轮被去重挡下', d2.reason.includes('已处理'), d2.reason);
}

// ----------------------------------------------- 5. 没被 @ 却没抽中时的记法
console.log('\n5) 概率未命中时理由要写明，便于排查');
{
  const cfg = JSON.parse(JSON.stringify(baseCfg));
  cfg.trigger.replyProbability = 0;   // 必然不命中
  cfg.trigger.whitelist = ['示例群'];
  const state = freshState();
  const d = decide(cfg, state, makeParsed([{ text: '不会被回的消息' }]));
  check('理由包含「概率未命中」', d.decisions[0].reason.includes('概率未命中'), d.decisions[0].reason);
  check('被 @ 时理由标明必回', (() => {
    const st = freshState();
    const dd = decide(cfg, st, makeParsed([{ text: '@小深 喂' }]));
    return dd.decisions[0].reason.includes('必回');
  })());
}

// ------------------------------------------------- 6. 「只在被@时回」仍可用
console.log('\n6) replyInGroupOnlyWhenMentioned=true 时非 @ 消息直接跳过');
{
  const cfg = JSON.parse(JSON.stringify(baseCfg));
  cfg.trigger.replyInGroupOnlyWhenMentioned = true;
  cfg.trigger.replyProbability = 1;   // 即使概率 100% 也不该回
  cfg.trigger.whitelist = ['示例群'];
  const state = freshState();
  const d = decide(cfg, state, makeParsed([{ text: '群里随便聊' }]));
  check('非 @ 消息被跳过', d.decisions[0].reply === false, d.decisions[0].reason);
  const st2 = freshState();
  const d2 = decide(cfg, st2, makeParsed([{ text: '@小深 在吗' }]));
  check('被 @ 的消息通过', d2.decisions[0].reply === true, d2.decisions[0].reason);
}

// ------------------------- 7. 「只在@时」和「回复概率」的先后顺序（踩过）
console.log('\n7) 「群内只在@时」排在概率之前 —— 开着它，概率就是死代码');
{
  // 这个顺序本身是设计如此（「只在@时」是更硬的一道闸门），
  // 但它有个很难自己发现的后果：用户配了 replyProbability=0.25 想"随机回一些"，
  // 只要「只在@时」也开着，概率对群消息就**一次都不会被用到**。
  // 实测踩过：只在@时=true + 概率 25% → 200 条普通群消息回 0 条，
  // 用户看到的现象就是"随机回复没生效"。
  const texts = ['今天天气不错', '打王者吗', '草', '你们在说啥', '我晚饭吃啥呢', '笑死我了'];

  const measure = (mentionOnly, probability) => {
    const cfg = JSON.parse(JSON.stringify(baseCfg));
    cfg.trigger.replyInGroupOnlyWhenMentioned = mentionOnly;
    cfg.trigger.replyProbability = probability;
    cfg.trigger.whitelist = ['示例群'];
    let replied = 0;
    const N = 600;
    for (let i = 0; i < N; i++) {
      const s = freshState();
      const d = decide(cfg, s, makeParsed([{ text: texts[i % texts.length] }]));
      if (d.decisions[0].reply) replied++;
    }
    return replied / N;
  };

  const blockedRate = measure(true, 0.25);
  const randomRate = measure(false, 0.25);
  const allRate = measure(false, 1);

  check('「只在@时」开着时，非@消息回复率是 0（概率完全被绕过）',
    blockedRate === 0, `${(blockedRate * 100).toFixed(1)}%`);
  check('关掉「只在@时」后，25% 概率真的生效',
    randomRate > 0.15 && randomRate < 0.35, `${(randomRate * 100).toFixed(1)}%`);
  check('概率 1 = 全回（对照组，证明上面那个 0 不是因为整条链路坏了）',
    allRate === 1, `${(allRate * 100).toFixed(1)}%`);
  check('两种配置的结论确实不同', blockedRate !== randomRate);

  // 被 @ 的消息不受概率影响（mentionAlwaysReplies 默认 true）
  const cfgM = JSON.parse(JSON.stringify(baseCfg));
  cfgM.trigger.replyInGroupOnlyWhenMentioned = false;
  cfgM.trigger.replyProbability = 0.05;   // 概率压到 5%，被@仍然必须回
  cfgM.trigger.whitelist = ['示例群'];
  let mentionHit = 0;
  for (let i = 0; i < 100; i++) {
    const s = freshState();
    const d = decide(cfgM, s, makeParsed([{ text: '@小深 在吗' }]));
    if (d.decisions[0].reply) mentionHit++;
  }
  check('概率再低，被 @ 也是必回', mentionHit === 100, `${mentionHit}/100`);

  // bot.js 必须对「这个组合很奇怪」发出警告 —— 用 warn 不用 info，
  // 混在启动 banner 里的 info 没人会看见，问题会一直挂着
  const botSrc = readFileSync(new URL('../src/bot.js', import.meta.url), 'utf8');
  check('bot.js 会对「只在@时 + 非0概率」这个组合发出 warn',
    /mentionOnly && Number\.isFinite\(probConfigured\) && probConfigured > 0/.test(botSrc)
    && /log\.warn\(`  ⚠ 「群内只在@时」开着/.test(botSrc));
  check('警告里给了两条明确的修法（改 false / 改成 0）',
    botSrc.includes('trigger.replyInGroupOnlyWhenMentioned 改成 false')
    && botSrc.includes('trigger.replyProbability 改成 0'));
}

// ---------------- 10. 同一句话重发，必须还能回（用户报的「连队列都没进」）
console.log('\n10) 去重不许把「新发的同一句话」当成「重复读到」');
{
  // 去重键是 `${会话}|${side}|${文本}`，没有时间/发送者/位置。
  // 它本来只想防"同一条可见消息被每 4 秒重复决策"，却把"人刚发的同一句话"也杀了：
  // 实测第 2 次发「@示例昵称 测试一下」直接 `已处理过（去重）`，既不回也不进队列。
  // 用户的原话：「被@的消息有时候不会回，连队列都没进」。
  const { pruneSeenToWindow, markSeen } = await import('../src/gate.js');
  const cfg = JSON.parse(JSON.stringify(baseCfg));
  cfg.trigger.replyProbability = 0.25;
  cfg.trigger.whitelist = ['示例群'];
  cfg.trigger.mentionAlwaysReplies = true;
  cfg.trigger.replyInGroupOnlyWhenMentioned = false;
  cfg.persona.replyAllWhenActive = false;

  const CONV = '示例群';
  const mkParsed = (texts) => ({
    source: 'uia', conversation: CONV, isGroup: true,
    messages: texts.map((t, i) => ({
      index: i, side: 'incoming', sender: '群友乙', text: t, x: 1709, y: 553 + i * 40, h: 16, bottom: 569 + i * 40,
    })),
    incoming: [], self: [],
  });

  const st = { seen: [], sentReplies: [], replyTimes: [], pending: [], counters: {}, takeoverEnabled: false };

  // 第 1 次
  let p1 = mkParsed(['@示例昵称 测试一下']);
  let d1 = decide(cfg, st, p1);
  check('第 1 次被@ → 必回', d1.decisions[0].reply === true, d1.decisions[0].reason);
  markSeen(st, d1.decisions[0].fingerprint);
  pruneSeenToWindow(st, p1);

  // 第 2 次：**一模一样的新消息**，而且它还在窗口里 —— 这一条仍然应该去重
  const d2 = decide(cfg, st, p1);
  check('同一条消息被重复读到 → 仍然去重（这是去重存在的意义）',
    d2.decisions[0].reply === false && d2.decisions[0].reason.includes('已处理过'),
    d2.decisions[0].reason);

  // 场景：那条消息滚出窗口了（窗口里换成了别的消息）
  const p3 = mkParsed(['今天天气不错', '打王者吗', '@示例昵称 测试一下']);
  // 注意：新窗口里又有同一句话 —— 但它其实是**人刚发的**
  pruneSeenToWindow(st, mkParsed(['今天天气不错', '打王者吗']));
  const d3 = decide(cfg, st, mkParsed(['@示例昵称 测试一下']));
  check('滚出窗口后，同一句话重新出现 → 能正常回（这就是修的那条）',
    d3.decisions[0].reply === true, d3.decisions[0].reason);

  // 窗口读空时不许把 seen 清光（否则窗口恢复后所有消息都会被重回一遍）
  const before = st.seen.length;
  const empty = pruneSeenToWindow(st, { conversation: CONV, messages: [] });
  check('窗口读空 → 不清 seen（解析失败时的保护）',
    st.seen.length === before && empty.dropped === 0, `before=${before} after=${st.seen.length}`);

  // 别的会话的记录不许被这个窗口清掉
  const st2 = { seen: [`${CONV}|incoming|旧消息`, `别的群|incoming|别人的消息`], sentReplies: [], replyTimes: [], pending: [] };
  pruneSeenToWindow(st2, mkParsed(['新消息']));
  check('只清本会话的记录，别的会话不动',
    st2.seen.includes('别的群|incoming|别人的消息') && !st2.seen.includes(`${CONV}|incoming|旧消息`),
    JSON.stringify(st2.seen));

  // bot.js 必须真的调用它，而且要在决策循环之后
  const botSrc = readFileSync(new URL('../src/bot.js', import.meta.url), 'utf8');
  const iLoop = botSrc.indexOf('for (const d of result.decisions)');
  const iPrune = botSrc.indexOf('pruneSeenToWindow(state, parsed)');
  check('bot.js 在决策循环之后调用 pruneSeenToWindow',
    iLoop > 0 && iPrune > iLoop, `loop@${iLoop} < prune@${iPrune}`);
}

// ------------------- 11. 回复范围：白名单模式 / 回复所有对话
console.log('\n11) 回复范围两种模式：只回白名单 vs 回复所有对话');
{
  const { isReplyTarget, replyScopeOf, REPLY_REJECT_TEXT } = await import('../src/config.js');

  const mk = (whitelist, replyScope, blacklist = []) => ({
    trigger: { whitelist, blacklist, replyScope, replyProbability: 1, mentionAlwaysReplies: true },
    persona: { replyAllWhenActive: false },
  });

  // ---- 模式解析 ----
  check('默认（没配）是 whitelist 模式', replyScopeOf(mk(['A'], undefined)) === 'whitelist');
  check('认得 "all"', replyScopeOf(mk(['A'], 'all')) === 'all');
  check('大小写不敏感', replyScopeOf(mk(['A'], 'ALL')) === 'all');
  check('认不出来的值回退成 whitelist（安全的那一侧）',
    replyScopeOf(mk(['A'], 'everything')) === 'whitelist'
    && replyScopeOf(mk(['A'], 123)) === 'whitelist'
    && replyScopeOf(mk(['A'], null)) === 'whitelist');

  // ---- 模式 1：白名单 ----
  check('白名单模式：名单内的会话 → 回', isReplyTarget(mk(['示例群'], 'whitelist'), '示例群').ok === true);
  check('白名单模式：名单外的会话 → 不回', isReplyTarget(mk(['示例群'], 'whitelist'), '别的群').ok === false);
  check('白名单模式 + 白名单为空 → 谁也不回（安全默认）',
    isReplyTarget(mk([], 'whitelist'), '任何群').ok === false);

  // 拒绝原因要能区分开（原来只有一句含糊的「不在白名单（或命中黑名单）」）
  check('原因区分：白名单为空 vs 不在名单里',
    isReplyTarget(mk([], 'whitelist'), 'X').why === 'whitelist-empty'
    && isReplyTarget(mk(['A'], 'whitelist'), 'X').why === 'not-in-whitelist',
    `${isReplyTarget(mk([], 'whitelist'), 'X').why} / ${isReplyTarget(mk(['A'], 'whitelist'), 'X').why}`);
  check('原因区分：命中黑名单', isReplyTarget(mk(['A'], 'whitelist', ['X']), 'X').why === 'blacklist');
  check('每个拒绝原因都有中文文案', ['blacklist', 'whitelist-empty', 'not-in-whitelist']
    .every((k) => typeof REPLY_REJECT_TEXT[k] === 'string' && REPLY_REJECT_TEXT[k].length > 0));

  // ---- 模式 2：回复所有对话 ----
  check('all 模式：白名单外的会话也回', isReplyTarget(mk([], 'all'), '任何群').ok === true);
  check('all 模式：白名单为空照样回（这就是它的意义）',
    isReplyTarget(mk([], 'all'), 'X').ok === true);
  check('all 模式：白名单里有的也回', isReplyTarget(mk(['A'], 'all'), 'A').ok === true);
  check('all 模式下白的名单不参与判定（填不填都一样）',
    isReplyTarget(mk(['A', 'B'], 'all'), 'C').ok === isReplyTarget(mk([], 'all'), 'C').ok);

  // ---- 黑名单两种模式都生效 ----
  check('all 模式下黑名单仍然生效（"所有"不该把明确的"别回"也绕过去）',
    isReplyTarget(mk([], 'all', ['广告群']), '广告群').ok === false);
  check('all 模式下黑名单命中也报 blacklist',
    isReplyTarget(mk([], 'all', ['广告群']), '广告群').why === 'blacklist');

  // ---- 端到端：真的过一遍 decide ----
  const conv = '别的群';
  const parse = (name) => ({
    source: 'uia', conversation: name, isGroup: true,
    messages: [{ index: 0, side: 'incoming', sender: '某人', text: '随便说点什么', x: 1709, y: 553, h: 16, bottom: 569 }],
    incoming: [], self: [],
  });
  const st = () => ({ seen: [], sentReplies: [], replyTimes: [], pending: [], counters: {}, takeoverEnabled: false });

  const wlCfg = JSON.parse(JSON.stringify(baseCfg));
  wlCfg.trigger.whitelist = ['示例群'];
  wlCfg.trigger.replyScope = 'whitelist';
  wlCfg.trigger.replyProbability = 1;
  wlCfg.trigger.replyInGroupOnlyWhenMentioned = false;
  wlCfg.persona.replyAllWhenActive = false;
  check('端到端·白名单模式：名单外的会话，全部不进队列',
    decide(wlCfg, st(), parse(conv)).decisions.every((d) => d.reply === false));

  const allCfg = JSON.parse(JSON.stringify(wlCfg));
  allCfg.trigger.replyScope = 'all';
  const dAll = decide(allCfg, st(), parse(conv)).decisions[0];
  check('端到端·all 模式：同一个会话就能回了', dAll.reply === true, dAll.reason);

  // decide 的返回值要把模式带出来（启动日志/界面要用）
  check('decide 返回值带上了生效模式',
    decide(allCfg, st(), parse(conv)).scope === 'all'
    && decide(wlCfg, st(), parse(conv)).scope === 'whitelist');
  check('decide 返回值带上了拒绝原因码',
    decide(wlCfg, st(), parse(conv)).scopeWhy === 'not-in-whitelist',
    String(decide(wlCfg, st(), parse(conv)).scopeWhy));

  // ---- 真实 config ----
  const real = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  check('真实 config 里有 trigger.replyScope', real.trigger?.replyScope !== undefined, String(real.trigger?.replyScope));
  check('它的值是合法的两种之一', ['whitelist', 'all'].includes(real.trigger?.replyScope));
  check('它带说明注释', Array.isArray(real.trigger?.$comment_replyScope) && real.trigger.$comment_replyScope.length > 0);

  // ---- 接线 ----
  const gateSrc = readFileSync(new URL('../src/gate.js', import.meta.url), 'utf8');
  check('gate.js 用 isReplyTarget（不再自己拼 isWhitelisted && !isBlacklisted）',
    gateSrc.includes('isReplyTarget(') && !/isWhitelisted\(cfg/.test(gateSrc));
  const botSrc = readFileSync(new URL('../src/bot.js', import.meta.url), 'utf8');
  check('bot.js 的 banner 会说明回复范围', botSrc.includes('回复范围    :'));
  check('bot.js 在 all 模式下不误报「白名单为空」',
    /replyScopeOf\(cfg\) === 'whitelist' && wl\.length === 0/.test(botSrc));
  const pageSrc = readFileSync(new URL('../gui/page.js', import.meta.url), 'utf8');
  check('控制台有回复范围选择框', pageSrc.includes('id="replyScope"'));
  check('控制台会保存它', pageSrc.includes("'trigger.replyScope'"));
  check('控制台会提示当前模式的后果', pageSrc.includes('function renderScopeHint'));
  const srvSrc = readFileSync(new URL('../gui/server.js', import.meta.url), 'utf8');
  check('服务端把 replyScope 暴露给页面', /replyScope:\s*cfg\.trigger\?\.replyScope === 'all' \? 'all' : 'whitelist'/.test(srvSrc));
}

// ------------------------------------- 8. 接管模式把生效概率提到 100%
console.log('\n8) 接管模式 → 生效概率升到 100%（哪怕配置是 25%）');
{
  const cfg = JSON.parse(JSON.stringify(baseCfg));
  cfg.trigger.replyProbability = 0.25;
  cfg.trigger.whitelist = ['示例群'];
  // ⚠ 必须显式钉住，不能继承真实 config.json。
  // 这一节测的是「接管期间把概率抬到 100%」这个**行为**，
  // 而用户可以把 config 里的 replyAllWhenActive 设成 false 来表达偏好 ——
  // 那就不是在测这个行为了，测试会无端变红（本轮真踩到）。
  cfg.persona.replyAllWhenActive = true;

  const N = 1000;
  let hit = 0;
  for (let i = 0; i < N; i++) {
    const s = freshTakeoverState();
    const d = decide(cfg, s, makeParsed([{ text: `随便说说${i}` }]));
    if (d.decisions[0].reply) hit++;
  }
  check(`接管时 ${N} 条全部回复`, hit === N, `实际 ${hit}/${N}`);

  // 关掉这个行为后，接管期间也应按配置概率
  const cfgNo = JSON.parse(JSON.stringify(cfg));
  cfgNo.persona.replyAllWhenActive = false;
  let hit2 = 0;
  for (let i = 0; i < 2000; i++) {
    const s = freshTakeoverState();
    const d = decide(cfgNo, s, makeParsed([{ text: `随便说说${i}` }]));
    if (d.decisions[0].reply) hit2++;
  }
  const rate2 = hit2 / 2000;
  check(`replyAllWhenActive=false 时按 25% 抽（实际 ${(rate2 * 100).toFixed(1)}%）`,
    Math.abs(rate2 - 0.25) < 0.04, `${hit2}/2000`);
}

// --------------------------------------------------------- 9. 白名单仍然生效
console.log('\n9) 白名单外的会话一律不回');
{
  const cfg = JSON.parse(JSON.stringify(baseCfg));
  cfg.trigger.replyProbability = 1;
  // ⚠ 必须显式钉住范围。这一段验的是**白名单模式下的机制**，
  //   而 `replyScope` 是用户随时会改的一项（他自己把范围调成「所有对话」去测轮询时，
  //   这两条断言就会红 —— 代码一行没动，红得莫名其妙）。
  //   钉住之后：既验了 whitelist 下拦得住，也顺手验了 all 下不该拦。
  cfg.trigger.replyScope = 'whitelist';
  const state = freshState();
  const d = decide(cfg, state, makeParsed([{ text: '@小深 在吗' }], '别人的群'));
  check('白名单外不回', d.decisions[0].reply === false, d.decisions[0].reason);
  // 接管时也不该绕过白名单
  const d2 = decide(cfg, freshTakeoverState(), makeParsed([{ text: '@小深 在吗' }], '别人的群'));
  check('接管时也不绕过白名单', d2.decisions[0].reply === false, d2.decisions[0].reason);

  // 反过来：范围=所有对话时，白名单外的会话**应该**能回（不然就是范围没生效）
  const cfgAll = JSON.parse(JSON.stringify(cfg));
  cfgAll.trigger.replyScope = 'all';
  const d3 = decide(cfgAll, freshState(), makeParsed([{ text: '@小深 在吗' }], '别人的群'));
  check('范围=所有对话时，白名单外照样能回（范围真的生效）',
    d3.decisions[0].reply === true, d3.decisions[0].reason);
}

// ------------------------- 9. 队列按会话挑（轮询全部会话之后才暴露的坑）
//
// 用户开了「轮询全部会话」之后，队列里会同时压着好几个会话的消息。
// 而回复是往**当前屏幕显示的那个**聊天发的 —— 如果照旧拿队头，
// 在「测试群」排队的那句话会在轮到私聊那一屏时被发进私聊。
// （队头那条的 conversation 一直存着，只是以前同时只有一个会话，从没暴露。）
console.log('\n12) 待回复队列按会话挑（不能拿队头就发）');
{
  const mk = (conversation, text, queuedAt = Date.now()) => ({
    fp: conversation + '|' + text, conversation, side: 'incoming', sender: '某人',
    text, mentioned: false, queuedAt,
  });

  const st = { pending: [mk('测试群', '群里的问题'), mk('某个私聊', '私聊的问题')] };

  const g = findPendingFor(st, '测试群');
  check('在「测试群」这一屏只挑出群里的那条', g && g.item.text === '群里的问题', JSON.stringify(g?.item?.text));
  check('挑出来的时候**不动队列**（失败还要留着重试）', st.pending.length === 2, String(st.pending.length));

  const p = findPendingFor(st, '某个私聊');
  check('换到私聊那一屏挑出私聊那条', p && p.item.text === '私聊的问题', JSON.stringify(p?.item?.text));

  check('这一屏没有自己的消息时返回 null（而不是退回队头）',
    findPendingFor({ pending: [mk('测试群', 'x')] }, '毫不相干的会话') === null);

  // 会话名带成员数（QQ 群名常见）也要认得出来，不能因为多了个「（10）」就不发
  const st2 = { pending: [mk('示例群', '在吗')] };
  check('会话名带成员数也能对上（子串匹配）',
    Boolean(findPendingFor(st2, '示例群（10）')), 'conversation 匹配用 sessionMatches');

  // 会话名读不出来时不猜
  check('会话名读不出来时不发（宁可晚一轮，也不能回错人）',
    findPendingFor({ pending: [mk('测试群', 'x')] }, '') === null);

  // 过期的丢掉（10 分钟 TTL），不然一个永远轮不到的会话会把队列堵死
  const old = { pending: [mk('早就退了的群', 'x', Date.now() - 11 * 60 * 1000), mk('测试群', 'y')] };
  const got = findPendingFor(old, '测试群');
  check('过期条目被清掉，但当前会话那条照样挑得出来',
    got && got.item.text === 'y' && old.pending.length === 1, JSON.stringify(old.pending.map((x) => x.text)));

  // 出队按位置，不按队头
  const st3 = { pending: [mk('A群', 'a'), mk('B群', 'b'), mk('A群', 'a2')] };
  const slot = findPendingFor(st3, 'B群');
  shiftPendingAt(st3, slot.index);
  check('出队删掉的是挑中的那条，别的原样留着',
    st3.pending.map((x) => x.text).join(',') === 'a,a2', JSON.stringify(st3.pending.map((x) => x.text)));
  check('出队拿到的是那一条本身', slot.item.text === 'b');
  check('乱传 index 不抛也不乱删', shiftPendingAt(st3, 99) === null && st3.pending.length === 2);
  check('队列说明能报出压着哪些会话',
    pendingConversations(st3).join(',') === 'A群', JSON.stringify(pendingConversations(st3)));
}

// ------------------- 13. 轮询下的重复回复（用户报的「致命 bug」）
//
// 现象原话：「每次轮询过程中会识别多次，有时候重复回复一段话多次」。
//
// 真实日志（08:27:48 与 08:31:15，同一个私聊）：
//     回复 [乐音] "你是谁"   → "示例昵称"
//     …3 分钟后…
//     回复 [乐音] "你是谁"   → "示例昵称"      ← 同一条消息又回了一遍
// 而且同一批里还有一条被读成残句的消息：
//     回复 [乐音] "该用户通过“"              ← QQ 的长系统消息只读到前半段
//
// 成因：去重键是 `会话|方向|文本`，而 `seen` 会被 pruneSeenToWindow **按窗口清理**。
// 轮询把两处软肋同时放大：
//   1. 同一条消息在不同轮**解析出的文本不一样**（长消息被截断）→ 指纹变了
//   2. 某一轮读到的是**部分窗口**（界面重画 / UIA 少给元素）→ 那条不在窗口里
// 两种都会让 seen 记录被清掉 → 同一条消息下一轮又变成"新的" → 又回一遍。
//
// 修法：回过就单独记一笔（state.handled，按时间过期，**不受窗口清理影响**），
// 决策时用归一化文本比对，并且能认出"被截断的同一句"。
// 同时保留"真人故意发两次同一句"的能力 —— 靠窗口里看得见几条来判。
console.log('\n13) 轮询下的重复回复（同一条消息被回多次）');
{
  const cfg = JSON.parse(JSON.stringify(baseCfg));
  cfg.trigger.replyScope = 'all';           // 轮询时的典型配置
  cfg.trigger.replyProbability = 1;
  cfg.trigger.replyInGroupOnlyWhenMentioned = false;
  const mk = (text) => makeParsed([{ text: `@小深 ${text}` }], '测试群');

  // ① 回过一次 → 窗口被"重新读到"（seen 被清掉的那种）→ 不许再回
  {
    const st = freshState();
    const first = decide(cfg, st, mk('你是谁'));
    check('第一次：该回', first.decisions[0].reply === true, first.decisions[0].reason);
    enqueuePending(st, first.decisions[0]);
    // 模拟轮询的窗口清理：seen 被清空（真实故障里就是这一步把记录弄丢的）
    st.seen = [];
    const again = decide(cfg, st, mk('你是谁'));
    check('seen 被清掉之后，同一条**不该**再回（这就是本次修的 bug）',
      again.decisions[0].reply === false, again.decisions[0].reason);
    check('拒绝理由说清了是"刚回过"', /刚回过/.test(String(again.decisions[0].reason)),
      again.decisions[0].reason);
  }

  // ② 长消息被截断成两半 → 仍算同一条
  //
  // ⚠ 用例不能再用那句防骗通知了：它现在会被**系统消息过滤**先拦掉（那是另一条闸门，
  //   见 test-system.mjs）。这里要验的是"截断容错"，得用一句**普通的**长消息。
  {
    const st = freshState();
    const longText = '今天下午三点开会记得带上你的笔记本和充电器还有那份周报';
    const full = decide(cfg, st, mk(longText));
    check('长消息：第一次该回', full.decisions[0].reply === true, full.decisions[0].reason);
    enqueuePending(st, full.decisions[0]);
    st.seen = [];
    const cut = decide(cfg, st, mk('今天下午三点开会记得带上'));
    check('同一句话被截断后再读到 → 不许再回（按前缀认出来）',
      cut.decisions[0].reply === false, `${cut.decisions[0].reason}`);
  }

  // ③ 真人**故意**连发两次同一句：窗口里看得见两条 → 第二条要回
  {
    const st = freshState();
    const one = decide(cfg, st, mk('在吗在吗亲'));
    enqueuePending(st, one.decisions[0]);
    st.seen = [];
    // 这一屏里明明白白有两条一样的
    const two = decide(cfg, st, makeParsed(
      [{ text: '@小深 在吗在吗亲' }, { text: '@小深 在吗在吗亲' }], '测试群',
    ));
    check('窗口里有两条一模一样的 → 第一条当旧的、第二条当新发的（第二条该回）',
      two.decisions[0].reply === false && two.decisions[1].reply === true,
      JSON.stringify(two.decisions.map((d) => [d.reply, d.reason])));
  }

  // ④ 短消息不许被前缀匹配误并（「你好」和「你好啊」是两句不同的话）
  {
    const st = freshState();
    const a = decide(cfg, st, makeParsed([{ text: '@小深 你好' }], '测试群'));
    enqueuePending(st, a.decisions[0]);
    st.seen = [];
    const b = decide(cfg, st, makeParsed([{ text: '@小深 你好啊' }], '测试群'));
    check('「你好」之后来一句「你好啊」→ 该回（短句不参与前缀合并）',
      b.decisions[0].reply === true, b.decisions[0].reason);
  }

  // ⑤ 超过时限之后，同一句话再来 → 该回（不能永久拉黑一句话）
  {
    const st = freshState();
    const t0 = Date.now();
    const a = decide(cfg, st, mk('这句话十一分钟后再说一遍'), t0);
    enqueuePending(st, a.decisions[0]);
    st.seen = [];
    const late = decide(cfg, st, mk('这句话十一分钟后再说一遍'), t0 + 11 * 60 * 1000);
    check('过了 10 分钟之后同一句话再来 → 该回（账本会过期）',
      late.decisions[0].reply === true, late.decisions[0].reason);
    const soon = decide(cfg, st, mk('这句话十一分钟后再说一遍'), t0 + 60 * 1000);
    st.seen = [];
    check('一分钟内再来 → 不回（还在账本有效期内）',
      soon.decisions[0].reply === false, soon.decisions[0].reason);
  }

  // ⑥ 别的会话不受影响（同一个文本在另一个群里该回）
  {
    const st = freshState();
    const a = decide(cfg, st, makeParsed([{ text: '@小深 某某某' }], '测试群'));
    enqueuePending(st, a.decisions[0]);
    st.seen = [];
    const other = decide(cfg, st, makeParsed([{ text: '@小深 某某某' }], '另一个群'));
    check('同一个文本出现在**另一个会话**里 → 照样该回（账本按会话分）',
      other.decisions[0].reply === true, other.decisions[0].reason);
  }

  // ⑦ 账本要落盘（否则重启后又开始重复回）
  {
    const st = freshState();
    const a = decide(cfg, st, mk('重启之后不许再回这句'));
    enqueuePending(st, a.decisions[0]);
    check('进了队列就记了账', Array.isArray(st.handled) && st.handled.length === 1,
      JSON.stringify(st.handled));
    check('账本里有会话/方向/归一化文本/时间',
      st.handled[0].conv === '测试群' && st.handled[0].side === 'incoming'
      && typeof st.handled[0].text === 'string' && typeof st.handled[0].at === 'number',
      JSON.stringify(st.handled[0]));
  }
}

// ------------------- 14. 系统消息不进队列（端到端，不只是纯函数）
//
// 规则表在 src/system-msg.js，那边有专门一套测试（test-system.mjs）。
// 这一条只验**接线**：decide() 真的把系统消息挡在队列外，理由写得清楚。
console.log('\n14) 系统消息不进待回复队列');
{
  const cfg = JSON.parse(JSON.stringify(baseCfg));
  cfg.trigger.replyScope = 'all';
  cfg.trigger.replyProbability = 1;
  cfg.trigger.replyInGroupOnlyWhenMentioned = false;

  const sysTexts = ['临时会话', '你已被移出群聊', '群友甲拍了拍我', '[图片]'];
  for (const t of sysTexts) {
    const st = freshState();
    const d = decide(cfg, st, makeParsed([{ text: t }], '测试群'));
    const sysDec = d.decisions[0];
    check(`「${t}」被拦下且理由点了名`, sysDec.reply === false && /系统消息（/.test(String(sysDec.reason)),
      `${sysDec.reply} / ${sysDec.reason}`);
    check(`「${t}」带 system 标记（便于日志区分）`, sysDec.system === true);
  }

  // 反过来：真人说的话不许被这条闸门吃掉
  const human = freshState();
  const h = decide(cfg, human, makeParsed([{ text: '图片' }], '测试群'));
  check('真人只发「图片」两个字 → 该回（裸词不筛）', h.decisions[0].reply === true, h.decisions[0].reason);

  // 关掉开关就恢复原样
  const cfgOff = JSON.parse(JSON.stringify(cfg));
  cfgOff.trigger.ignoreSystemMessages = false;
  const off = decide(cfgOff, freshState(), makeParsed([{ text: '临时会话' }], '测试群'));
  check('关掉过滤之后，「临时会话」照旧会被回（开关真的管用）',
    off.decisions[0].reply === true, off.decisions[0].reason);
}

// ------------------------------------------------- state.json 带 BOM 也要读得出来
//
// state.json 是**用户可能手工改**的文件（改回复范围、清队列、看历史）。
// 记事本另存 UTF-8 默认带 BOM，而带 BOM 时 `JSON.parse` 直接抛 →
// loadState 静默落到空状态 → **去重台账、待回复队列全丢**，
// 表现就是"同一条消息被回了两三次"（这正是之前那个致命 bug 的复发路径）。
//
// ⚠ 这一段会临时改写用户的 state.json，所以：原文件先按字节存下来，
//   无论断言怎么走，最后都必须原样写回（try/finally 兜住）。
console.log('\n15) state.json 带 BOM 时不能把去重台账丢掉');
{
  if (!fs.existsSync(STATE_FILE)) {
    console.log('  [SKIP] 没有 state.json（没跑过机器人）—— 这一节跳过');
  } else {
    const original = fs.readFileSync(STATE_FILE);
    try {
      const parsed = JSON.parse(original.toString('utf8').replace(/^\uFEFF/, ''));
      const seeded = {
        ...parsed,
        handled: [{ key: '测试群|incoming|带BOM也要记得我回过', at: Date.now() }],
        pending: [],
      };
      fs.writeFileSync(STATE_FILE, '\uFEFF' + JSON.stringify(seeded, null, 2), 'utf8');

      const st = loadState();
      check('⚠ 带 BOM 的 state.json 仍能读出内容（不是空状态）',
        st.takeoverEnabled !== undefined || (st.handled || []).length > 0,
        JSON.stringify({ handled: (st.handled || []).length, takeover: st.takeoverEnabled }));
      check('⚠ 去重台账没丢（丢了就会重复回复同一句话）',
        (st.handled || []).some((h) => h.key === '测试群|incoming|带BOM也要记得我回过'),
        `${(st.handled || []).length} 条`);
    } finally {
      fs.writeFileSync(STATE_FILE, original);   // 按字节还原，绝不留下测试痕迹
    }
    check('state.json 已按原样还原',
      Buffer.compare(fs.readFileSync(STATE_FILE), original) === 0);
  }
}

console.log('\n' + '='.repeat(70));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(70));
process.exitCode = fail > 0 ? 1 : 0;





