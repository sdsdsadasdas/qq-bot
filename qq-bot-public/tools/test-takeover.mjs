import { detectTakeoverCommand, isTakeoverActive, activeSystemPrompt, commandAck, fallbackAllowedAfterApiFailure } from "../src/takeover.js";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { configLooksConfigured, skipNote } from './testkit.mjs';
const cfg = loadConfig({ argv: [] });

// 「你的 config 里 fallbackWhenApiDown 是 false」这条是拿真实配置做的交叉验证：
// 它守的是"用户选的那个偏好没被改掉"。在一份还没配的副本上，配置还是默认值，
// 这条只会红 —— 不是坏了，是还没配。
//
// 这个文件没有 check() 计数器（逐条 console.log + pass/fail++），所以这里用
// **不计数**的写法：没配好就打印 [SKIP]，配好了才 +1。关键是别让"还没配"
// 混进 pass 计数里 —— 那会让"通过 N"看起来比实际跑过的断言多。
const REAL_READY = configLooksConfigured(cfg);

// 这里测的是「接管 → 回复概率变 1」，跟「群内只在@时回复」无关。
// 真实 config.json 里那个开关可能是 true，那样不带 @ 的测试消息会在概率之前
// 就被挡掉，「接管时全部通过闸门」会变成 0/500，看着像接管坏了其实是配置不同。
// 显式钉成 false（需要 true 的场景自己打开）。
cfg.trigger.replyInGroupOnlyWhenMentioned = false;
const mk = (msgs) => ({ messages: msgs.map((t, i) => ({ side: "incoming", sender: "群友丙", text: t, y: i })) });

const cases = [
  ["你接管", "enable"],
  ["@示例昵称 你接管", "enable"],
  ["你 接 管", "enable"],
  ["你下班", "disable"],
  ["停止接管", "disable"],
  ["今天吃啥", null],
];
let pass = 0, fail = 0;
for (const [text, want] of cases) {
  const got = detectTakeoverCommand(mk([text]), cfg).cmd;
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] "${text}" → ${got}  期望 ${want}`);
}
console.log("\n--- 多条消息时取最新指令 ---");
const r = detectTakeoverCommand(mk(["你接管", "随便聊聊", "你下班"]), cfg);
const ok2 = r.cmd === "disable";
ok2 ? pass++ : fail++;
console.log(`  [${ok2 ? "PASS" : "FAIL"}] 最新是「你下班」→ ${r.cmd}`);

console.log("\n--- 模式状态与提示词切换 ---");
const on = isTakeoverActive({ takeoverEnabled: true }, cfg);
const off = isTakeoverActive({ takeoverEnabled: false }, cfg);
const dflt = isTakeoverActive({}, cfg);
console.log(`  [${on === true ? "PASS" : "FAIL"}] state=true → ${on}`);
console.log(`  [${off === false ? "PASS" : "FAIL"}] state=false → ${off}`);
console.log(`  [${dflt === (cfg.persona.enabled === true) ? "PASS" : "FAIL"}] 无 state → 用 config (${dflt})`);
pass += (on === true) + (off === false) + (dflt === (cfg.persona.enabled === true));

const spOn = activeSystemPrompt({ takeoverEnabled: true }, cfg);
const spOff = activeSystemPrompt({ takeoverEnabled: false }, cfg);
const okType = typeof spOn === 'string' && typeof spOff === 'string';

// ⚠ 这里**不能**断言提示词里含某个词（原来写的是 `includes('可爱')`），
//   也不能断言 spOn !== spOff：
//   —— 那段文案是**用户自己写的**，他改一版人设、或者把两份提示词写成一样，
//      断言当场变红，而功能一点问题都没有（本项目已经修过好几处这种"测试依赖用户配置"）。
//
//   要验的是**机制**，所以用合成配置钉死：
//     接管 → 用 persona 那份；非接管 → 用 llm 那份；persona 是空数组时不能把默认提示词弄丢。
const synth = (persona, llm) => ({ persona: { systemPrompt: persona }, llm: { systemPrompt: llm } });
const a = activeSystemPrompt({ takeoverEnabled: true }, synth('PERSONA文字', 'LLM文字'));
const b = activeSystemPrompt({ takeoverEnabled: false }, synth('PERSONA文字', 'LLM文字'));
const emptyPersona = activeSystemPrompt({ takeoverEnabled: true }, synth([], 'LLM文字'));
const bothEmpty = activeSystemPrompt({ takeoverEnabled: true }, synth([], []));

const okMech = a === 'PERSONA文字' && b === 'LLM文字' && emptyPersona === 'LLM文字' && bothEmpty === '';
// 「接管时用的就是 persona 那份」这条也要认**合法**的另一种情形：
// persona.systemPrompt 没配（或配成空）时，接口按设计会回落到 llm.systemPrompt ——
// 那仍然是"提示词没丢"。原写法直接拿 cfg.persona.systemPrompt 去比，
// 于是"没配人设"这种正常配置会被判成红（开发机上真出现过：清掉一处测试残留之后，
// persona.systemPrompt 只剩注释、没有值）。**空 = 回落**，不是故障。
const personaRaw = Array.isArray(cfg.persona?.systemPrompt)
  ? cfg.persona.systemPrompt.join('\n').trim()
  : String(cfg.persona?.systemPrompt ?? '').trim();
const llmRaw = Array.isArray(cfg.llm?.systemPrompt)
  ? cfg.llm.systemPrompt.join('\n').trim()
  : String(cfg.llm?.systemPrompt ?? '').trim();
const okIsPersona = spOn.trim() !== ''
  && spOn.trim() === (personaRaw || llmRaw);
const okSp = okType && okMech && okIsPersona;
okSp ? pass++ : fail++;
console.log(`  [${okSp ? 'PASS' : 'FAIL'}] 接管用 persona / 非接管用 llm / 空 persona 不丢默认（合成配置验机制）`);
console.log(`        合成结果: 接管=${JSON.stringify(a)} 非接管=${JSON.stringify(b)} persona空=${JSON.stringify(emptyPersona)}`);
console.log(`        你的 config：接管时用的就是 persona 那份=${okIsPersona}，长度 ${spOn.length} 字，开头: ${JSON.stringify(spOn.slice(0, 36))}`);

// 关键回归：config 里 persona.systemPrompt 写成数组（为可读性），
// 但 API 的 content 必须是字符串。不规范化就会 API 报错 → 静默降级到本地规则，
// 表现成「接管开着但回复不是模型生成的」。这个坑踩过。
const rawIsArray = Array.isArray(cfg.persona.systemPrompt);
const normOk = rawIsArray ? okType : true;
normOk ? pass++ : fail++;
console.log(`  [${normOk ? 'PASS' : 'FAIL'}] config 里是数组(${rawIsArray}) → 已规范化成 API 可接受的字符串`);

console.log('\n--- 人设语气池 ---');
{
  const { fallbackReply, BUILTIN_POOLS } = await import('../src/fallback.js');
  // ⚠ 不能直接读 `cfg.persona.fallbackGeneric`：那是**用户可选**的配置项。
  //   默认配置里没有它（导出发布包时会被清掉），于是 `pool.includes` 抛
  //   TypeError —— 整个测试文件一行都不跑。而"接管模式用可爱池"这件事
  //   跟用户写没写过这个键无关：没写就该用代码里的内置默认。
  //   （踩过：公开包里 test-takeover 就是这么崩的。）
  const pool = (Array.isArray(cfg.persona?.fallbackGeneric) && cfg.persona.fallbackGeneric.length)
    ? cfg.persona.fallbackGeneric
    : BUILTIN_POOLS.personaGeneric;
  const got = new Set();
  for (let i = 0; i < 12; i++) {
    got.add(fallbackReply(cfg, { text: `zzz${i}`, counter: i, persona: cfg.persona }).reply);
  }
  const allFromPersona = [...got].every((g) => pool.includes(g));
  allFromPersona ? pass++ : fail++;
  console.log(`  [${allFromPersona ? 'PASS' : 'FAIL'}] 接管模式兜底句全部来自可爱池: ${[...got].slice(0, 6).join(' / ')}`);

  const normal = new Set();
  for (let i = 0; i < 12; i++) {
    normal.add(fallbackReply(cfg, { text: `zzz${i}`, counter: i }).reply);
  }
  const differs = [...normal].some((n) => !pool.includes(n));
  differs ? pass++ : fail++;
  console.log(`  [${differs ? 'PASS' : 'FAIL'}] 非接管模式用的是另一套池子（不完全重合）`);
}

console.log("\n--- 应答句 ---");
const ack = commandAck("enable", cfg);
const okAck = ack.length > 0 && cfg.persona.onEnableReplies.includes(ack);
okAck ? pass++ : fail++;
console.log(`  [${okAck ? "PASS" : "FAIL"}] enable 应答: "${ack}"`);

// ------------------------------------------- 接管期间每条都回
console.log('\n--- 接管期间自动「每条都回」 ---');
{
  const { effectiveReplyProbability } = await import('../src/takeover.js');
  const { decide } = await import('../src/gate.js');

  // ⚠ 必须显式钉住 replyAllWhenActive，不能继承真实 config.json。
  //
  // 这一节测的是「接管期间自动每条都回」这个**行为**（replyAllWhenActive=true 时的表现）。
  // 但用户完全可以把它设成 false —— 那是一种合法的偏好表达
  //（「用 API 生成回复」+「随机只回一部分」），不是配置错误。
  // 继承真实配置的话，用户一改偏好测试就红，看起来像功能坏了（本轮真踩到）。
  // 想测 false 的情况，下面有专门一段。
  cfg.persona.replyAllWhenActive = true;

  // ⚠ 会话白名单也得钉住，理由和上面那条一模一样，只是更难发现：
  //   下面「500 条全部通过闸门」是**端到端**跑 decide()，而 decide() 的第一道闸门
  //   就是会话白名单（白名单为空 = 谁都不回，安全默认）。
  //   真实 config.json 里白名单有群名时它绿；一份刚导出的副本里白名单是空的，
  //   于是 500 条全部被挡在概率判断之前 —— 表现是"接管时通过闸门 0/500"，
  //   看着像接管坏了，其实只是这份配置没有允许任何会话。
  //   把它钉成测试自己造的那个会话名，这一节就只验"接管提升概率"这件事。
  cfg.trigger.replyScope = 'whitelist';
  cfg.trigger.whitelist = ['示例群'];

  const on = effectiveReplyProbability({ takeoverEnabled: true }, cfg);
  const off = effectiveReplyProbability({ takeoverEnabled: false }, cfg);
  const okOn = on === 1;
  const okOff = Math.abs(off - cfg.trigger.replyProbability) < 1e-9;
  okOn ? pass++ : fail++;
  okOff ? pass++ : fail++;
  console.log(`  [${okOn ? 'PASS' : 'FAIL'}] 接管时生效概率 = ${on}（应为 1）`);
  console.log(`  [${okOff ? 'PASS' : 'FAIL'}] 非接管时生效概率 = ${off}（应为配置值 ${cfg.trigger.replyProbability}）`);

  // 关掉这个行为时应该仍然按配置概率
  const cfgNo = JSON.parse(JSON.stringify(cfg));
  cfgNo.persona.replyAllWhenActive = false;
  const kept = effectiveReplyProbability({ takeoverEnabled: true }, cfgNo);
  const okKept = Math.abs(kept - cfg.trigger.replyProbability) < 1e-9;
  okKept ? pass++ : fail++;
  console.log(`  [${okKept ? 'PASS' : 'FAIL'}] replyAllWhenActive=false 时接管期仍按配置概率 = ${kept}`);

  // 端到端：接管时 500 条应全部通过闸门
  const mk = () => ({ source: 'uia', conversation: '示例群', isGroup: true, messages: [] });
  let hit = 0;
  for (let i = 0; i < 500; i++) {
    const p = mk();
    p.messages = [{ index: 0, side: 'incoming', sender: '某人', text: `随便说说${i}`, x: 1709, y: 553, h: 16, bottom: 569 }];
    const s = { takeoverEnabled: true, seen: [], sentReplies: [], replyTimes: [], pending: [] };
    if (decide(cfg, s, p).decisions[0].reply) hit++;
  }
  const okAll = hit === 500;
  okAll ? pass++ : fail++;
  console.log(`  [${okAll ? 'PASS' : 'FAIL'}] 接管时 500 条全部通过闸门（实际 ${hit}）`);

  // 退出接管后应回到**配置里那个概率**（不写死 0.25）。
  // 写死 25% 会随用户改配置而误报：实测用户把它设成 1（每条都回）之后，
  // 这里就成了"回到 100.0%（目标 25%）"的红字，而机制其实完全正常。
  const want = Number(cfg.trigger?.replyProbability);
  let hit2 = 0;
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const p = mk();
    p.messages = [{ index: 0, side: 'incoming', sender: '某人', text: `随便说说${i}`, x: 1709, y: 553, h: 16, bottom: 569 }];
    const s = { takeoverEnabled: false, seen: [], sentReplies: [], replyTimes: [], pending: [] };
    if (decide(cfg, s, p).decisions[0].reply) hit2++;
  }
  const rate = hit2 / N;
  // 概率是 1 或 0 时是确定性行为，直接精确比对；否则给 3% 的抽样余量
  const okRate = want >= 1 ? rate === 1 : (want <= 0 ? rate === 0 : Math.abs(rate - want) < 0.03);
  okRate ? pass++ : fail++;
  console.log(`  [${okRate ? 'PASS' : 'FAIL'}] 退出接管后回到 ${(rate * 100).toFixed(1)}%（配置里是 ${(want * 100).toFixed(1)}%）`);
}

console.log("\n--- 模型调不通时要不要发兜底话（reply.fallbackWhenApiDown）---");
{
  // 用户问「为什么接管模式还有固定回复」之后加的开关。
  // 机制的关键在于**只在"请求真的发出去了却失败"时才管用** ——
  // 非接管模式本来就该用本地回复，绝不能因为开了这个开关就一条都不回。
  const mk = (v) => ({ reply: { fallbackWhenApiDown: v } });

  const attemptedFail = { apiAttempted: true };
  const didNotCall = { apiAttempted: false };

  const cases = [
    ['请求发出去了失败了 + 开关=false → 不发兜底（返回 false）', mk(false), attemptedFail, false],
    ['请求发出去了失败了 + 开关=true  → 发兜底', mk(true), attemptedFail, true],
    ['请求发出去了失败了 + 没配这个键 → 发兜底（老行为）', { reply: {} }, attemptedFail, true],
    ['压根没调 API（非接管模式）+ 开关=false → 照旧用本地回复', mk(false), didNotCall, true],
    ['压根没调 API（非接管模式）+ 开关=true  → 照旧用本地回复', mk(true), didNotCall, true],
  ];
  for (const [label, c, opts, want] of cases) {
    const got = fallbackAllowedAfterApiFailure(c, opts);
    const ok = got === want;
    ok ? pass++ : fail++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label} → ${got}`);
  }

  // 真实 config：用户选了"模型挂了就不发"，所以这里应该是 false
  const realCfg = loadConfig({ argv: [] });
  const real = realCfg.reply?.fallbackWhenApiDown;
  // 没配好就只说一句 [SKIP]，**不计 pass 也不计 fail** ——
  // 计进 pass 会把"这份配置还没配"伪装成一条通过的断言。
  if (!REAL_READY) {
    skipNote('你的 config 里 fallbackWhenApiDown（选了"模型挂了就不发"）');
  } else {
    const okReal = real === false;
    okReal ? pass++ : fail++;
    console.log(`  [${okReal ? 'PASS' : 'FAIL'}] 你的 config 里是 ${real}（选了"模型挂了就不发"）`);
  }

  // bot.js 必须真的用了这个判定，否则又是一次"配置写了没人读"
  const botSrc = readFileSync(new URL('../src/bot.js', import.meta.url), 'utf8');
  const okWired = /fallbackAllowedAfterApiFailure\(cfg, \{ apiAttempted: apiCall\.call === true \}\)/.test(botSrc)
    && /source = 'silent'/.test(botSrc);
  okWired ? pass++ : fail++;
  console.log(`  [${okWired ? 'PASS' : 'FAIL'}] bot.js 里真的接线了（不是又一个死开关）`);
}

console.log("\n" + "=".repeat(60));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail > 0 ? 1 : 0;

