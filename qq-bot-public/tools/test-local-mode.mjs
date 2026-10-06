/**
 * test-local-mode.mjs — 「非接管模式不调 API」这条规则的回归测试。
 *
 * 背景（用户原话）：
 *   「接管不是调用API的模式吗，不接管时不调用API」
 *   「把不接管时改成使用本地模式」
 *
 * 改之前：composeReply 无条件 await generateReply()，两种模式都花钱，
 *   而且非接管时发给模型的是 llm.systemPrompt 那句 73 字的通用话，
 *   控制台里精心写的人设**根本用不上** —— 花了钱还不像小深。
 *
 * 改之后：shouldCallApi() 决定要不要发请求，默认只有接管模式才发。
 *
 * 这个测试守的就是这条线。bot.js 一 import 就跑主循环、没法当库用，
 * 所以判断逻辑抽在 takeover.js 里，这里测它 + 本地兜底确实有话说。
 *
 * 用法：node tools/test-local-mode.mjs
 */
import { shouldCallApi, isTakeoverActive } from '../src/takeover.js';
import { fallbackReply } from '../src/fallback.js';
import { loadConfig } from '../src/config.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configLooksConfigured, skipNote } from './testkit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// 第 6、9 节里有几条是**拿真实 config.json 交叉验证**的：
//   · 「接管开启 → 会调 API（key 已从 .env 读到）」——必须有真 key
//   · 「@前缀下 greeting 意图能命中」——依赖 botNames 里真的有名字
// 这些在开发机上守着"我配的东西生效了没"；在一份刚导出的副本上
// 只能是红的（没 key、昵称还是占位符），而那不代表代码坏了。
// 所以先问一句这份配置配没配好，没配就让那几条说 [SKIP]。
const REAL_READY = configLooksConfigured(loadConfig({ argv: [] }));

/** 造一份自足的配置，不读用户的 config.json（测试不许依赖用户设置）。 */
function mkCfg(over = {}) {
  return {
    llm: {
      enabled: true,
      apiKey: 'sk-test-not-real',
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      systemPrompt: '通用提示词',
      callApiInTakeoverOnly: true,
      ...(over.llm ?? {}),
    },
    persona: { systemPrompt: ['你是小深'], ...(over.persona ?? {}) },
    fallback: { enabled: true, ...(over.fallback ?? {}) },
    trigger: {},
  };
}

console.log('='.repeat(70));
console.log('本地模式 / API 调用时机（非接管不调 API）');
console.log('='.repeat(70));

// ---------------------------------------------------------------- 1. 默认策略
section('1) 默认：只有接管模式才调 API');
{
  const cfg = mkCfg();
  const off = shouldCallApi({ takeoverEnabled: false }, cfg);
  const on = shouldCallApi({ takeoverEnabled: true }, cfg);

  check('不接管 → 不调', off.call === false, `reason=${off.reason}`);
  check('不接管的理由码是 not-takeover（bot.js 靠它区分「主动不调」和「真故障」）',
    off.reason === 'not-takeover', off.reason);
  check('接管 → 调', on.call === true, `reason=${on.reason}`);
  check('接管的理由码是 takeover', on.reason === 'takeover', on.reason);
  check('两种模式结论确实不同（不是恒真/恒假）', off.call !== on.call);
}

// ---------------------------------------------------- 2. 想退回旧行为的开关
section('2) callApiInTakeoverOnly=false 退回「两种模式都调」');
{
  const cfg = mkCfg({ llm: { callApiInTakeoverOnly: false } });
  const off = shouldCallApi({ takeoverEnabled: false }, cfg);
  const on = shouldCallApi({ takeoverEnabled: true }, cfg);

  check('不接管也会调', off.call === true, `reason=${off.reason}`);
  check('理由码是 always', off.reason === 'always', off.reason);
  check('接管照样调', on.call === true, on.reason);
}

// ------------------------------------------------------------ 3. 故障与关闭
section('3) 关闭 / 没 key 一律不调（且理由要准）');
{
  const noEnabled = mkCfg({ llm: { enabled: false } });
  const r1 = shouldCallApi({ takeoverEnabled: true }, noEnabled);
  check('llm.enabled=false → 不调', r1.call === false, `reason=${r1.reason}`);
  check('理由码 disabled（跟 generateReply 的 FAIL 码一致）', r1.reason === 'disabled', r1.reason);

  const noKey = mkCfg({ llm: { apiKey: '' } });
  const r2 = shouldCallApi({ takeoverEnabled: true }, noKey);
  check('没 key，即使接管也不调', r2.call === false, `reason=${r2.reason}`);
  check('理由码 no-key', r2.reason === 'no-key', r2.reason);

  // key 是空串/undefined 都算没 key
  const undefKey = mkCfg({ llm: { apiKey: undefined } });
  check('apiKey 为 undefined 也算没 key',
    shouldCallApi({ takeoverEnabled: true }, undefKey).reason === 'no-key');

  // 绝不能出现「决定要调，但 key 是空的」这种组合
  const combos = [
    { enabled: true, apiKey: 'sk-x', callApiInTakeoverOnly: undefined },
    { enabled: false, apiKey: 'sk-x', callApiInTakeoverOnly: true },
    { enabled: true, apiKey: '', callApiInTakeoverOnly: false },
  ];
  const bad = combos
    .map((llm) => ({ llm, r: shouldCallApi({ takeoverEnabled: true }, mkCfg({ llm })) }))
    .filter((x) => x.r.call === true && (!x.llm.enabled || !x.llm.apiKey));
  check('不存在「要调 API 但没开/没 key」的组合', bad.length === 0, `坏组合 ${bad.length} 个`);
}

// ---------------------------------------------------------------- 4. 健壮性
section('4) 配置残缺也不许抛');
{
  const noLlm = { persona: {}, fallback: { enabled: true } };
  const r = shouldCallApi({ takeoverEnabled: false }, noLlm);
  check('cfg.llm 缺失 → 不调且不抛', r.call === false, `reason=${r.reason}`);

  let threw = false;
  try { shouldCallApi(undefined, undefined); } catch { threw = true; }
  check('连 cfg 都不给也不抛（返回对象）', threw === false);

  const r3 = shouldCallApi(undefined, { llm: { enabled: true, apiKey: 'sk-x' } });
  check('state 为 undefined 时按非接管处理',
    r3.call === false && r3.reason === 'not-takeover', `${r3.call}/${r3.reason}`);
}

// -------------------------------------------- 5. 不接管时本地必须「有话说」
section('5) 不接管时，本地兜底对「被@」类消息必须有回复');
{
  const cfg = mkCfg();

  // 这些是群里最常见的被 @ 之后的说法，一条都不能空
  const samples = [
    '@示例昵称 说话',
    '@示例昵称 在吗',
    '@示例昵称 你好',
    '@示例昵称 你是谁',
    '@示例昵称 ？',
    '@示例昵称 你怎么看',
    '@示例昵称 说句话',
    '@示例昵称 666',
    '@示例昵称',
    '@示例昵称 帮我写个代码',
  ];

  let empty = 0;
  const shown = [];
  for (const text of samples) {
    const r = fallbackReply(cfg, { text, counter: 0, recentReplies: [], persona: null });
    if (!r.reply) { empty++; shown.push(`空 ← ${text}`); }
  }
  check(`本地兜底 ${samples.length} 条被@样例全部有回复`, empty === 0,
    empty === 0 ? `例：${JSON.stringify(fallbackReply(cfg, { text: samples[0], counter: 0, recentReplies: [], persona: null }).reply)}` : shown.join(' / '));

  // 反复取也要有内容（池子耗尽/去重逻辑不能把它搞成空）
  let emptyRepeat = 0;
  const seen = [];
  for (let i = 0; i < 40; i++) {
    const r = fallbackReply(cfg, { text: '@示例昵称 说话', counter: i, recentReplies: seen });
    if (!r.reply) emptyRepeat++;
    else seen.push(r.reply);
  }
  check('连抽 40 次都有回复（不会因为「最近说过」被抽空）', emptyRepeat === 0, `空 ${emptyRepeat} 次`);

  // 兜底关掉时**允许**为空 —— 那时机器人就该闭嘴，不能硬编一句
  const off = mkCfg({ fallback: { enabled: false } });
  const rOff = fallbackReply(off, { text: '@示例昵称 说话', counter: 0 });
  check('fallback.enabled=false 时允许返回空（表示不该答）', !rOff.reply, `source=${rOff.source}`);
}

// -------------------------------------------------- 6. 真实配置里的开关自检
section('6) 真实 config.json 自检（只读，不改）');
{
  // 用 loadConfig 而不是裸 JSON.parse —— 裸读拿到的是文件里的空 apiKey，
  // .env 里的 key 是 loadConfig 解析进去的。裸读会让下面几条断言退化成
  // 「no-key」而不是真正想验的「not-takeover」，等于白测（一开始就踩了）。
  const cfg = loadConfig();

  check('config.json 里有 llm.callApiInTakeoverOnly', cfg.llm?.callApiInTakeoverOnly !== undefined,
    `= ${cfg.llm?.callApiInTakeoverOnly}`);
  check('它是布尔值（不是字符串 "true"，那会让判断永远走 false 分支）',
    typeof cfg.llm?.callApiInTakeoverOnly === 'boolean',
    typeof cfg.llm?.callApiInTakeoverOnly);

  const raw = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  check('它带说明注释 $comment_when（不然以后没人知道这是干嘛的）',
    Array.isArray(raw.llm?.$comment_when) && raw.llm.$comment_when.length > 0);

  // 接管关掉时，真配置的决定必须是「不调」，而且理由得是主动不调而不是没 key。
  //
  // ⚠ 这里给这份**真配置**补一个假 key 再判：理由是，"不调"要由**策略**决定，
  //   不能被"你没配 key"替代掉。而一份刚导出的副本本来就没有 key（apiKey 空、
  //   .env 也没有），不补的话理由码如实变成 no-key，这条断言就问不出它想问的事
  //   （不是坏了，是问错了对象）。补的是内存里的副本，不写盘。
  const cfgWithKey = loadConfig();
  cfgWithKey.llm.apiKey = 'sk-test-not-real';
  const real = shouldCallApi({ takeoverEnabled: false }, cfgWithKey);
  check('用真配置、接管关闭 → 不调 API', real.call === false, `reason=${real.reason}`);
  check('理由码是 not-takeover（证明「不调」是因为策略，不是因为没有 key）',
    real.reason === 'not-takeover', `reason=${real.reason}  key=${cfg.llm?.apiKeySource ?? 'none'}`);

  // 接管开着时必须能调，否则接管模式等于废了。
  // 这一条**必须**有真 key（它要证明的是"key 真的被读进来了、接管真的会发请求"），
  // 所以没配好的机器上直接跳过 —— 补假 key 就把要验的东西换掉了。
  if (!REAL_READY) {
    skipNote('用真配置、接管开启 → 会调 API（key 已从 .env 读到）');
    skipNote('key 来源是 .env 或环境变量，没写进 config.json');
  } else {
    const realTakeover = shouldCallApi({ takeoverEnabled: true }, cfg);
    check('用真配置、接管开启 → 会调 API（key 已从 .env 读到）',
      realTakeover.call === true, `call=${realTakeover.call} reason=${realTakeover.reason}`);
    check('key 来源是 .env 或环境变量，没写进 config.json',
      String(cfg.llm?.apiKeySource ?? '').startsWith('.env:') || String(cfg.llm?.apiKeySource ?? '').startsWith('env:'),
      String(cfg.llm?.apiKeySource));
  }
}

// ------------------------------------------- 7. 真的不发请求（fetch 间谍）
section('7) 非接管时真的一个网络请求都不发（给 fetch 装间谍）');
{
  const { generateReply } = await import('../src/llm.js');

  const realFetch = globalThis.fetch;
  let calls = 0;
  let urls = [];
  globalThis.fetch = async (url, ...rest) => {
    calls++;
    urls.push(String(url));
    return realFetch(url, ...rest);
  };

  try {
    const cfg = mkCfg();

    // 复刻 bot.js 里那三行的形状。为了不跟 bot.js 走散，
    // 下面还会断言 bot.js 源码里确实是这个形状（第 8 节）。
    async function likeBotJs(state) {
      const apiCall = shouldCallApi(state, cfg);
      const llmRes = apiCall.call
        ? await generateReply(cfg, { text: '@示例昵称 说话' })
        : { ok: false, reason: apiCall.reason };
      if (llmRes.ok) return { source: 'llm', reply: llmRes.reply };
      const fb = fallbackReply(cfg, {
        text: '@示例昵称 说话', counter: 0, recentReplies: [], reason: llmRes.reason,
      });
      return { source: `fallback:${fb.source}`, reply: fb.reply, reason: llmRes.reason };
    }

    const r = await likeBotJs({ takeoverEnabled: false });

    check('非接管：fetch 一次都没被调用', calls === 0, `实际 ${calls} 次 ${urls.join(',')}`);
    check('非接管：拿到了本地回复（机器人不会变成哑巴）', Boolean(r.reply), `reply=${JSON.stringify(r.reply)}`);
    check('非接管：source 标出是本地规则', String(r.source).startsWith('fallback:'), r.source);
    check('非接管：reason 是 not-takeover，日志会显示「未调用 API」而不是「API 不可用」',
      r.reason === 'not-takeover', String(r.reason));

    // 对照组：接管模式必须真的发请求（否则上面那条「0 次」可能只是因为整条路都断了）
    // 用假 baseUrl + 假 key，请求会在网络层失败，但 fetch 一定被调到 —— 这就够了。
    const cfgNet = mkCfg({ llm: { baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-fake', timeoutMs: 1500 } });
    const before = calls;
    const apiCall = shouldCallApi({ takeoverEnabled: true }, cfgNet);
    if (apiCall.call) await generateReply(cfgNet, { text: 'ping' });
    check('对照组：接管模式确实发了请求（证明 spy 抓得住）', calls > before,
      `接管时 fetch +${calls - before} 次`);
    check('对照组：请求打到的是 chat/completions',
      urls.slice(before).some((u) => u.includes('/chat/completions')), urls.slice(before).join(','));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --------------------------------- 8. bot.js 里那道闸门不许被改掉/绕过去
section('8) bot.js 源码自检：闸门还在，且 generateReply 只被这一处调用');
{
  const src = readFileSync(path.join(ROOT, 'src', 'bot.js'), 'utf8');

  check('bot.js 用 shouldCallApi 做判断', src.includes('shouldCallApi('));
  check('bot.js 从 takeover.js 导入 shouldCallApi',
    /import\s*\{[^}]*shouldCallApi[^}]*\}\s*from\s*['"]\.\/takeover\.js['"]/.test(src));

  // 关键：generateReply 的调用必须是**条件调用**，不能是裸 await。
  // 这条断言就是为了防止以后有人「顺手」把它改回无条件 —— 那正是之前的 bug。
  //
  // 注意别用「前面有没有非词字符」来判：三元里的 `? await generateReply(` 前面
  // 就是一个空格，会被误判成裸调用（第一版就这么写的，自己踩了自己）。
  // 正确做法：先把那一处合法的三元整段抠掉，再看到底还有没有剩下的。
  const stripped = src.replace(/apiCall\.call\s*\?\s*await\s+generateReply\s*\([^)]*\)/, '');
  const leftover = (stripped.match(/await\s+generateReply\s*\(/g) ?? []).length;
  check('bot.js 里没有裸的 await generateReply(...)（必须是条件调用）', leftover === 0,
    leftover ? `还剩 ${leftover} 处裸调用 —— 非接管模式又会偷偷花钱` : '');

  const guarded = /apiCall\.call\s*\?\s*await\s+generateReply\s*\(/.test(src);
  check('generateReply 挂在 apiCall.call 三元里', guarded);

  const count = (src.match(/generateReply\s*\(/g) ?? []).length;
  check('generateReply 在 bot.js 里只出现 1 次（导入那行不算调用）', count === 1, `${count} 次`);

  // 日志里必须把「主动不调」和「真故障」分开，否则本地回复全顶着「API 不可用」，看着像坏了
  check('日志区分 not-takeover 与真故障', src.includes("'not-takeover'") && src.includes('未调用 API'));
}

// ------------------------- 9. 本地回复质量：@前缀不能把意图判断搞瘫
section('9) 带 @ 前缀时意图判断仍要正常（本地模式才像人话）');
{
  const cfg = loadConfig();
  // 「@前缀下 greeting 意图能命中」这条要**先摘掉 @ 前缀**才判意图，而摘前缀靠的
  // 是 cfg.trigger.botNames。继承真实配置 = 依赖用户填没填昵称：
  // 一份刚导出的副本里它是占位符 ['你的QQ昵称']，"@示例昵称 你好" 摘不掉前缀，
  // 于是这一池又被判成死代码 —— 红的是测试，不是代码。
  // 钉成本地合成值（与下面测试文本里的名字一致），这条就只验机制。
  cfg.trigger.botNames = ['小深', 'D老师', '示例昵称'];
  cfg.trigger.mentionPatterns = ['@{bot}', '@{bot} '];
  const one = (text, i = 3) => fallbackReply(cfg, {
    text, counter: i, recentReplies: [], persona: null, sender: '群友乙',
  });

  // greeting 是锚定行首的 /^(你好|...)/ —— @前缀不摘掉，这一池就是死代码。
  // 而「群内只在@时回复」模式下 100% 的消息都带这个前缀，等于整池报废。
  const greetPoolHit = ['@示例昵称 你好', '@示例昵称 在吗', '@示例昵称 早', '@示例昵称 早~']
    .every((t) => one(t).intent === 'greeting');
  check('@前缀下 greeting 意图能命中（这一池曾经是死代码）', greetPoolHit,
    `"@示例昵称 你好" → intent=${one('@示例昵称 你好').intent}`);

  const hi = one('@示例昵称 你好');
  check('「你好」不再掉进复述模板（曾经回「你好」emmm）',
    hi.source !== 'template', `source=${hi.source} reply=${JSON.stringify(hi.reply)}`);

  // 「早」不能贪心：只写 `早` 的话「早点睡」也当打招呼，回一句「在」，牛头不对马嘴
  check('「早点睡」不被当成打招呼', one('@示例昵称 早点睡').intent !== 'greeting',
    `intent=${one('@示例昵称 早点睡').intent}`);
  check('「早点睡」判成晚安', one('@示例昵称 早点睡').intent === 'goodnight',
    `intent=${one('@示例昵称 早点睡').intent} reply=${JSON.stringify(one('@示例昵称 早点睡').reply)}`);
  check('「早上开会」不被当成打招呼', one('@示例昵称 早上开会').intent !== 'greeting');
  check('「早说啊」不被当成打招呼', one('@示例昵称 早说啊').intent !== 'greeting');

  check('「笑死」判成 laughter', one('@示例昵称 笑死').intent === 'laughter');
  check('「谢谢」判成 thanks', one('@示例昵称 谢谢').intent === 'thanks');
  check('「晚安」判成 goodnight', one('@示例昵称 晚安').intent === 'goodnight');

  // 长问句绝不能被整句复述回来（复读机一眼假）
  const longQ = '@示例昵称 帮我看看这个报错到底咋回事';
  const echoBack = [];
  for (let i = 0; i < 25; i++) echoBack.push(one(longQ, i));
  const parroted = echoBack.filter((r) => String(r.reply).includes('帮我看看这个报错'));
  check('长问句不会被原样复述回来（复读机检测）', parroted.length === 0,
    parroted.length ? `复述了 ${parroted.length}/25 次: ${JSON.stringify(parroted[0].reply)}` : `抽了 25 次`);
  check('长问句也确实有得回（不是靠空转通过的）',
    echoBack.every((r) => r.reply), '有回复');

  // 复述类的方括号文案不该出现在 QQ 里（没人这么打字）
  const all = [];
  for (let i = 0; i < 60; i++) all.push(one('@示例昵称 吃了吗', i));
  check('回复里不出现「」这种引号（不像真人打字）',
    all.every((r) => !String(r.reply).includes('「')), JSON.stringify(all[0].reply));
}

console.log('\n' + '='.repeat(70));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(70));
process.exit(fail === 0 ? 0 : 1);
