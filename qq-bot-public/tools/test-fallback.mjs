/**
 * test-fallback.mjs — 验证降级回复逻辑（不需要网络，不需要 QQ）。
 *
 * 用法：node tools/test-fallback.mjs
 *
 * 断言的是「要求 2」的核心：不管网断没断，被 @ 的消息一定能拿到一句能发出去的回复。
 */
import { loadConfig } from '../src/config.js';
import { generateReply } from '../src/llm.js';
import { fallbackReply, clampReply, previewFallback } from '../src/fallback.js';
import { isMentioned } from '../src/parse.js';

const cfg = loadConfig({ argv: [] });

// 第 8 节测的是 @ 检测的**容错**（全角＠、没空格），它读的是 cfg.trigger.botNames。
// 继承真实配置 = 这个测试悄悄依赖"用户把昵称填了没有"：
//   开发机上 botNames 是 ['示例昵称','小深','D老师']，测试里的 "@小深 在吗" 正常认出；
//   一份刚导出的副本里它是占位符 ['你的QQ昵称']，于是那 6 条一起变红 ——
//   看起来像"@ 检测坏了"，其实只是这份配置还没配。
// 钉成本地合成值（与下面测试文本里的名字一致），@ 检测这条路就不再依赖用户配置。
cfg.trigger.botNames = ['小深', 'D老师', '示例昵称'];
cfg.trigger.mentionPatterns = ['@{bot}', '@{bot} '];

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`); }
}

console.log('='.repeat(70));
console.log('降级回复逻辑测试');
console.log('='.repeat(70));

console.log('\n1) 意图分类命中正确');
// 断言的是「命中了正确的意图」而不是「回复等于某一句话」——
// 现在每个意图配一组回复并随机挑，固定断言会随实现变化而失效。
const intentCases = [
  ['在吗', 'greeting'],
  ['在不在？', 'greeting'],
  ['你好', 'greeting'],
  ['谢谢你啊', 'thanks'],
  ['晚安', 'goodnight'],
  ['你是不是机器人', 'ask_if_bot'],
  ['明天几点', 'meeting'],
  ['这个怎么弄？', 'question'],
  ['哈哈哈', 'laughter'],
  ['好的', 'agreement'],
  ['烦死了', 'complaint'],
];
for (const [input, want] of intentCases) {
  const r = fallbackReply(cfg, { text: input, sender: '群友丙', counter: 0 });
  check(`"${input}" → ${r.intent}  "${r.reply}"`, r.intent === want, `期望意图 ${want}`);
}

console.log('\n1b) 答复必须非空且不发疯');
for (const [input] of intentCases) {
  const r = fallbackReply(cfg, { text: input, sender: '群友丙', counter: 0 });
  check(`"${input}" 回复非空且 <= 20 字`, r.reply.length > 0 && [...r.reply].length <= 20, `"${r.reply}"`);
}

console.log('\n1c) 同一句话重复提问必须给出不同回复（counter 递增模拟轮转）');
{
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    seen.add(fallbackReply(cfg, { text: '在吗', sender: '群友丙', counter: i }).reply);
  }
  check(`"在吗" 连问 5 次产生 ${seen.size} 种回复`, seen.size >= 3, [...seen].join(' / '));
}

console.log('\n1d) 带 recentReplies 时不应重复最近发过的');
{
  const sent = [];
  let dup = 0;
  for (let i = 0; i < 6; i++) {
    const r = fallbackReply(cfg, { text: '随便聊点啥', recentReplies: sent, counter: i });
    if (sent.includes(r.reply)) dup++;
    sent.push(r.reply);
  }
  check(`6 次不重复（重复 ${dup} 次）`, dup === 0, sent.join(' / '));
}

console.log('\n2) 规则未命中 → 通用话术（同一条消息 + 同 counter 必须稳定）');
const g1 = fallbackReply(cfg, { text: '今天天气不错', counter: 7 });
const g2 = fallbackReply(cfg, { text: '今天天气不错', counter: 7 });
check(`"${g1.reply}"`, g1.reply.length > 0, `source=${g1.source}`);
check('同输入同 counter 回复稳定', g1.reply === g2.reply, `${g1.reply} === ${g2.reply}`);

console.log('\n3) 规则被关掉 → defaultReply 兜底');
const cfgOff = JSON.parse(JSON.stringify(cfg));
cfgOff.fallback.rules = [];
cfgOff.fallback.generic = [];
cfgOff.fallback.useTemplates = false;
// 用一个不命中任何意图的句子，否则会走 intent 分支
const d = fallbackReply(cfgOff, { text: '嗯嗯呢呃', counter: 0 });
check(`兜底 "${d.reply}"`, d.reply === cfg.fallback.defaultReply || d.source === 'intent',
  `source=${d.source}`);

// ---------------------------------- 3b. 接管模式的兜底**必须**是可爱池
//
// 这是一条真 bug 的回归测试（2026-10-06 在导出发布包时才暴露）。
//
// 池子有两个来源，键名不一样：
//   · pools.fallbackGeneric —— persona 里**手写**的那份（可选）
//   · pools.personaGeneric  —— 代码里的内置可爱池（BUILTIN_POOLS）
// 老代码只看前者，于是**没手写 persona.fallbackGeneric 的配置**，
// 接管模式一直在用普通 GENERIC 池 —— 实测取到的是"收到 / 在忙，等下"，
// 也就是"API 一断就从「诶嘿」掉回客服腔"，正好是这个项目要避免的那件事。
//
// 为什么在开发机上是**假绿**：那份 config.json 里有 `fallback.generic`
// （16 条，内容恰好等于内置 GENERIC）把问题盖住了。所以这条测试必须用
// **自己造的 cfg**（不给 fallback.generic、不给 persona.fallbackGeneric），
// 不能拿真实配置来跑。
console.log('\n3b) 接管模式的兜底池必须是可爱池（哪怕没手写 persona.fallbackGeneric）');
{
  const { BUILTIN_POOLS } = await import('../src/fallback.js');
  const bare = { fallback: { enabled: true, useTemplates: false }, persona: { enabled: true } };

  const got = new Set();
  for (let i = 0; i < 12; i++) {
    got.add(fallbackReply(bare, { text: `zzz${i}`, counter: i, persona: bare.persona }).reply);
  }
  const arr = [...got];
  check('接管模式取到的句子全部来自内置可爱池',
    arr.every((g) => BUILTIN_POOLS.personaGeneric.includes(g)),
    JSON.stringify(arr.slice(0, 6)));
  check('没有混进普通 GENERIC 池的句子（那些是客服腔）',
    !arr.some((g) => BUILTIN_POOLS.generic.includes(g) && !BUILTIN_POOLS.personaGeneric.includes(g)),
    JSON.stringify(arr.filter((g) => BUILTIN_POOLS.generic.includes(g)).slice(0, 4)));

  // 手写过 persona.fallbackGeneric 的配置，仍然以手写的为准（别把用户的编辑盖掉）
  const hand = { fallback: { enabled: true }, persona: { fallbackGeneric: ['我手写的兜底'] } };
  const h = fallbackReply(hand, { text: 'zzz', counter: 0, persona: hand.persona });
  check('手写的 persona.fallbackGeneric 优先于内置可爱池',
    h.reply === '我手写的兜底', JSON.stringify(h));

  // 非接管模式不能被这次修改带偏（那边本来就该用普通池）
  const normal = new Set();
  for (let i = 0; i < 12; i++) normal.add(fallbackReply(bare, { text: `zzz${i}`, counter: i }).reply);
  check('非接管模式仍然用普通池（没被顺手改成可爱池）',
    [...normal].every((g) => !BUILTIN_POOLS.personaGeneric.includes(g) || BUILTIN_POOLS.generic.includes(g)),
    JSON.stringify([...normal].slice(0, 4)));
}

console.log('\n4) fallback.enabled=false → 返回空（调用方应放弃回复）');
const cfgDisabled = JSON.parse(JSON.stringify(cfg));
cfgDisabled.fallback.enabled = false;
const dis = fallbackReply(cfgDisabled, { text: '你好' });
check('返回空字符串', dis.reply === '' && dis.source === 'disabled', `source=${dis.source}`);

console.log('\n5) API 不可用时不抛异常，只返回 ok:false');
const cfgNoKey = JSON.parse(JSON.stringify(cfg));
cfgNoKey.llm.apiKey = '';
cfgNoKey.llm.apiKeySet = false;
// ⚠ 必须显式钉住「这家要 key」。
// 这里的 cfg 来自**真实 config.json**，而用户完全可以把当前厂商换成本地服务
// （requiresKey:false）—— 那时"没 key"根本不是错误，这条断言自然就红了。
// 本节要测的是"云端缺 key 时的分类"，所以自己指定前提。
cfgNoKey.llm.apiKeyRequired = true;
const noKey = await generateReply(cfgNoKey, { text: '你好' });
check('no-key 分类正确', noKey.ok === false && noKey.reason === 'no-key', `reason=${noKey.reason}`);

const cfgDisabledLlm = JSON.parse(JSON.stringify(cfg));
cfgDisabledLlm.llm.enabled = false;
const off = await generateReply(cfgDisabledLlm, { text: '你好' });
check('disabled 分类正确', off.ok === false && off.reason === 'disabled', `reason=${off.reason}`);

console.log('\n6) 超时被正确分类（指向一个不会立刻响应的地址）');
const cfgTimeout = JSON.parse(JSON.stringify(cfg));
cfgTimeout.llm.apiKey = 'sk-test-not-real';
cfgTimeout.llm.baseUrl = 'http://10.255.255.1';   // 不可路由地址 → 应超时或网络错误
cfgTimeout.llm.timeoutMs = 1200;
const to = await generateReply(cfgTimeout, { text: '你好' });
check('返回失败且不抛异常', to.ok === false, `reason=${to.reason} ms=${to.ms}`);

console.log('\n7) 长度截断');
const long = '这是一句很长很长的回复'.repeat(20);
const clamped = clampReply(long, 20);
check(`截断到 20 字`, [...clamped].length === 20, `实际 ${[...clamped].length} 字`);
const withPrefix = clampReply('正文', 10, '【自动回复】');
check('前缀被保留', withPrefix.startsWith('【自动回复】'), withPrefix);

console.log('\n8) @ 检测容错（全角＠ / 空格）');
const mentionCases = [
  [{ text: '@小深 在吗' }, true, '普通 @'],
  [{ text: '@小深在吗' }, true, '无空格'],
  [{ text: '＠小深 在吗' }, true, '全角 ＠'],
  [{ text: '小深 在吗' }, false, '只有名字没有 @'],
  [{ text: '@别人 在吗' }, false, 'at 的是别人'],
  [{ text: '@D老师 帮个忙' }, true, '第二个 botName'],
];
for (const [msg, expect, label] of mentionCases) {
  const got = isMentioned(msg, cfg);
  check(`${label}: ${JSON.stringify(msg.text)} → ${got}`, got === expect);
}

// ---------------------------------------- 9. 自定义规则 + 「试打一句」
//
// 用户报的第一个问题：「未接入 API 时的回复功能无法自主增加提示词」。
// 引擎一直支持 fallback.rules（匹配写法 → 一组回复），缺的是控制台界面；
// 界面要做「试打一句」，就得有个**能被单独调用**的判定函数（previewFallback）。
//
// 这里把三件事钉住：
//   1. 规则的优先级可以被内置意图抢走 —— 界面必须能说出"被抢了"
//   2. 非法正则不能变成死规则（退化成子串包含），而且要报出来
//   3. 预处理过的规则要真的能被用在试打里（控制台传的是**没保存的**那份）
console.log('\n9) 自定义规则与试打');
{
  const base = { fallback: { enabled: true, useTemplates: false } };

  const withRule = {
    ...base,
    fallback: {
      ...base.fallback,
      rules: [{ match: 'ZZMARK|测试专用词', replies: ['规则回复A', '规则回复B'] }],
    },
  };
  const hit = previewFallback(withRule, { text: 'ZZMARK 你好' });
  check('规则命中时来源是「自定义规则」', hit.plain.source === 'rule', JSON.stringify(hit.plain));
  check('报出命中的是第几条（界面要显示 #几）', hit.ruleIndex === 0, String(hit.ruleIndex));
  check('回复来自那条规则的候选池', ['规则回复A', '规则回复B'].includes(hit.plain.reply), hit.plain.reply);

  const miss = previewFallback(withRule, { text: '完全无关的一句话' });
  check('没命中任何规则时 ruleIndex = -1', miss.ruleIndex === -1, String(miss.ruleIndex));

  // 「给在吗写规则」是用户最容易踩的坑：内置 greeting 会先接走
  const shadow = previewFallback({
    ...base,
    fallback: { ...base.fallback, rules: [{ match: '在吗', replies: ['我自己写的回复'] }] },
  }, { text: '在吗' });
  check('内置意图会抢走规则（greeting 先命中）', shadow.ruleShadowed === true,
    JSON.stringify({ rule: shadow.ruleIndex, src: shadow.plain.source, reply: shadow.plain.reply }));

  const first = previewFallback({
    ...base,
    fallback: {
      ...base.fallback,
      customRulesFirst: true,
      rules: [{ match: '在吗', replies: ['我自己写的回复'] }],
    },
  }, { text: '在吗' });
  check('打开 customRulesFirst 之后规则说了算',
    first.plain.source === 'rule' && first.plain.reply === '我自己写的回复',
    JSON.stringify(first.plain));
  check('这时候不该再报"被抢"', first.ruleShadowed === false);

  // 非法正则：不能整条变死代码，也不能悄悄改语义
  const bad = previewFallback({
    ...base,
    fallback: { ...base.fallback, customRulesFirst: true, rules: [{ match: '吃了(', replies: ['按子串也能命中'] }] },
  }, { text: '今天吃了(饭' });
  check('非法正则退化成子串匹配（规则仍然活着）',
    bad.plain.source === 'rule' && bad.plain.reply === '按子串也能命中', JSON.stringify(bad.plain));
  check('非法正则会被报出来（界面要提醒用户）', /吃了\(/.test(bad.ruleError), bad.ruleError);

  check('一条规则都没有时也不抛', previewFallback(base, { text: '你好' }).ruleCount === 0);
  check('普通语气与接管语气分别给出结果',
    typeof previewFallback(base, { text: '你好' }).plain.reply === 'string'
    && typeof previewFallback(base, { text: '你好' }).persona.reply === 'string');
}

console.log('\n' + '='.repeat(70));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(70));
process.exitCode = fail > 0 ? 1 : 0;

