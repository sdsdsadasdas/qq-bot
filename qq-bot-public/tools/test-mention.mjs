/**
 * test-mention.mjs — 「机器人认得出自己被 @ 吗」的回归测试。
 *
 * 背景（真踩过的坑）：
 *   config.json 里 trigger.botNames 写的是 ["小深","D老师"] —— 人设名。
 *   但群里 @ 的是 **QQ 昵称「示例昵称」**。isMentioned() 于是永远返回 false。
 *   拿 35 条真实的带 @ 消息去喂，认出 0 条。
 *
 * 为什么藏了好几天没暴露：当时接管模式开着（强制全回）、
 * replyInGroupOnlyWhenMentioned 又是 false，被@规则压根不参与决策。
 * 一旦打开「群内只在@时回复」，isMentioned 就成了第一道闸门 ——
 * 认不出名字 = 一条都不回，而且不报错、不抛异常，只是「没反应」。
 *
 * 这个测试守两件事：
 *   1. 真实群消息里的 @ 能被认出来
 *   2. 认不出来的时候，mentionSelfCheck 会告警（而不是静默死掉）
 *
 * 用法：node tools/test-mention.mjs
 */
import { isMentioned, mentionSelfCheck, looksLikeMissedMention } from '../src/parse.js';
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

// 第 6 节是**拿真实 config.json 交叉验证**的（「你的昵称在不在 botNames 里」
// 「用你这份配置去认 @」）。这份价值只在**已经配好的机器**上成立。
// 在一份刚导出、还没配的副本上（botNames 还是占位符「你的QQ昵称」），
// 它必然红 —— 而那不是代码坏了，是"还没开始用"。所以先问一句配没配好。
const REAL_READY = configLooksConfigured(JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8')));
const checkReal = (name, cond, detail = '') => {
  if (!REAL_READY) { skipNote(name); return; }
  check(name, cond, detail);
};
function section(t) { console.log(`\n${t}`); }

// ------------------------------------------------------------------ 夹具 ----
// 这些是从真实群聊里抄下来的原文（含「@ 后面没空格」和「@ 在句尾」两种形态）。
// 故意内联而不是去读 state.json —— 测试不该依赖用户的运行时状态，
// 否则用户清一次 state 测试就红了。
const MENTION_ME = [
  '@示例昵称 说句话',
  '@示例昵称说话',                          // 没空格
  '@示例昵称背一下圆周率',                    // 没空格
  '@示例昵称 你爱吃白饭吗',
  '@示例昵称你知道这个群群主是谁吗',
  '那你是谁@示例昵称',                        // @ 在句尾
  '你叫啥名字@示例昵称',                      // @ 在句尾
  '@示例昵称 说一句耗费2亿token的话',
  '@示例昵称 帮我写个代码',
  '@示例昵称 ？',
];

// 这些 @ 的是**别人**，机器人不该认为自己被叫了（认错了就会到处插嘴）
const MENTION_OTHERS = [
  '@云出@群友庚 这俩是谁',
  '@群友戊 这样下去可以转生吗',
  '@乐音 给我吃',
  '@全体成员',
  '@示例群友听到没有',
];

const NO_MENTION = ['今天天气不错', '打王者啊', '草', '你们在说啥'];

const CFG_OK = { trigger: { botNames: ['示例昵称', '小深', 'D老师'], mentionPatterns: ['@{bot}', '@{bot} '] } };
// 出过事的那个配置，原样保留 —— 用来证明「这个 bug 真的存在过」
const CFG_BROKEN = { trigger: { botNames: ['小深', 'D老师'], mentionPatterns: ['@{bot}', '@{bot} '] } };

const asMsgs = (texts) => texts.map((text) => ({ text, side: 'incoming' }));

console.log('='.repeat(70));
console.log('被@识别 / 群内只在@时回复');
console.log('='.repeat(70));

// ------------------------------------------------------------ 1. 基础形态
section('1) 各种 @ 形态都要认出来（含没空格、@ 在句尾）');
{
  const misses = MENTION_ME.filter((t) => !isMentioned({ text: t }, CFG_OK));
  check(`${MENTION_ME.length} 条 @自己的消息全部认出`, misses.length === 0,
    misses.length ? '漏掉: ' + JSON.stringify(misses) : '');

  check('没空格「@示例昵称说话」认得出', isMentioned({ text: '@示例昵称说话' }, CFG_OK));
  check('@ 在句尾「你叫啥名字@示例昵称」认得出', isMentioned({ text: '你叫啥名字@示例昵称' }, CFG_OK));
  check('全角＠也认得出（OCR 会把 @ 识别成 ＠）', isMentioned({ text: '＠示例昵称 在吗' }, CFG_OK));
  check('人设名也认（小深 / D老师）',
    isMentioned({ text: '@小深 在吗' }, CFG_OK) && isMentioned({ text: '@D老师 看看' }, CFG_OK));
}

// -------------------------------------------------------- 2. 不许认错别人
section('2) @ 别人时不许误判（认错了就会到处插嘴）');
{
  const wrong = MENTION_OTHERS.filter((t) => isMentioned({ text: t }, CFG_OK));
  check(`${MENTION_OTHERS.length} 条 @别人的消息一条都没误判`, wrong.length === 0,
    wrong.length ? '误判: ' + JSON.stringify(wrong) : '');
  check('没有 @ 的普通消息不误判', NO_MENTION.every((t) => !isMentioned({ text: t }, CFG_OK)));
  check('空文本不抛也不误判', isMentioned({ text: '' }, CFG_OK) === false);
  check('message 缺 text 字段不抛', isMentioned({}, CFG_OK) === false);
}

// ------------------------------------------- 3. 那个 bug：botNames 写漏了
section('3) 回归：botNames 漏写 QQ 昵称 → 一条都认不出（这就是当时的 bug）');
{
  const hitBroken = MENTION_ME.filter((t) => isMentioned({ text: t }, CFG_BROKEN)).length;
  check('用出事的那个配置，认出 0 条（复现原 bug）', hitBroken === 0, `认出 ${hitBroken} 条`);
  const hitOk = MENTION_ME.filter((t) => isMentioned({ text: t }, CFG_OK)).length;
  check('把 QQ 昵称加进 botNames 后全部认出', hitOk === MENTION_ME.length, `认出 ${hitOk} 条`);
  check('两种配置的结论确实不同（不是恒真/恒假）', hitBroken !== hitOk);
}

// ------------------------------------------------- 4. 自检要真的会告警
section('4) mentionSelfCheck：认不出来时必须告警，而不是静默死掉');
{
  const bad = mentionSelfCheck(asMsgs(MENTION_ME), CFG_BROKEN);
  check('攒够样本 + 零命中 → ok=false（会触发告警）', bad.ok === false,
    `sawAt=${bad.sawAt} hit=${bad.hit}`);
  check('看到了全部样本', bad.sawAt === MENTION_ME.length, `${bad.sawAt}/${MENTION_ME.length}`);
  check('告警里带了看到的@消息原文（用户照着改就能修好）',
    bad.samples.length > 0 && bad.samples.every((s) => typeof s === 'string'), JSON.stringify(bad.samples.slice(0, 1)));

  const good = mentionSelfCheck(asMsgs(MENTION_ME), CFG_OK);
  check('修好之后 ok=true（不再告警）', good.ok === true, `sawAt=${good.sawAt} hit=${good.hit}`);
  check('命中数等于 @自己的条数', good.hit === MENTION_ME.length, `${good.hit}`);
}

// ------------------------------------------------------- 5. 不许误报
section('5) mentionSelfCheck 不许误报');
{
  const few = mentionSelfCheck(asMsgs(MENTION_ME.slice(0, 3)), CFG_BROKEN);
  check('样本不够时不告警（刚启动、历史还少）', few.ok === true, `sawAt=${few.sawAt}`);

  const none = mentionSelfCheck(asMsgs(NO_MENTION), CFG_BROKEN);
  check('完全没有 @ 的消息时不告警', none.ok === true, `sawAt=${none.sawAt}`);
  check('没 @ 时 sawAt=0（不是把普通消息算进去）', none.sawAt === 0, `${none.sawAt}`);

  // 群里 @ 别人的占多数是正常的：只要认出过一条就算 ok
  const mostlyOthers = mentionSelfCheck(
    asMsgs([...MENTION_OTHERS, ...MENTION_OTHERS, '@示例昵称 在吗']), CFG_OK);
  check('@别人的多、@自己的少 → 仍然 ok（命中率低不算故障）',
    mostlyOthers.ok === true, `sawAt=${mostlyOthers.sawAt} hit=${mostlyOthers.hit}`);

  check('空数组不抛', (() => { try { mentionSelfCheck([], CFG_OK); return true; } catch { return false; } })());
  check('undefined 不抛', (() => { try { mentionSelfCheck(undefined, CFG_OK); return true; } catch { return false; } })());
}

// ----------------------------------------- 6. 真实 config.json 必须写得对
section('6) 真实 config.json 自检（只读，不改）');
{
  const cfg = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const names = cfg.trigger?.botNames ?? [];

  checkReal('trigger.botNames 非空', names.length > 0, JSON.stringify(names));
  checkReal('里面含 QQ 昵称「示例昵称」（漏了它 = 一条都不回）', names.includes('示例昵称'),
    JSON.stringify(names));

  // 用真实配置 + 真实形态的消息跑一遍
  const hit = MENTION_ME.filter((t) => isMentioned({ text: t }, cfg)).length;
  checkReal('用真实配置，@自己的消息全部认出', hit === MENTION_ME.length, `${hit}/${MENTION_ME.length}`);

  const wrong = MENTION_OTHERS.filter((t) => isMentioned({ text: t }, cfg));
  checkReal('用真实配置，@别人的消息不误判', wrong.length === 0, JSON.stringify(wrong));

  checkReal('这个字段带说明注释（不然以后没人知道它是载荷关键的）',
    Array.isArray(cfg.trigger?.$comment_botNames) && cfg.trigger.$comment_botNames.length > 0);
}

// ------------------------------- 7. bot.js 里那道自检还得接着挂着
section('7) bot.js 源码自检：自检不能被顺手删掉');
{
  const src = readFileSync(path.join(ROOT, 'src', 'bot.js'), 'utf8');
  check('bot.js 调用了 mentionSelfCheck', src.includes('mentionSelfCheck('));
  check('只在「群内只在@时回复」模式下才需要它（条件不丢）',
    src.includes('replyInGroupOnlyWhenMentioned !== false'));
  check('告警里会打印当前 botNames（用户照着改就能修）', src.includes('当前 botNames'));
}

// ------------------------------------------------- 误报「疑似漏判@」的排除
//
// 实测踩到：日志里每轮刷两行
//   「疑似漏判@：正文里有「示例昵称」但没被当成@」
//   「  原文里还有 @ 吗: 没有 → 多半是解析把 @ 元素丢了」
// 用户看到的现象是「@ 文字丢了」。真相是**误报**：QQ 会把自己的昵称渲染成一个
// 元素（在自己消息旁边），解析器把它当成一条自己发的消息，正文就是自己的名字。
// 这段判断现在抽成了纯函数，这里把它钉住。
console.log('\n' + '「疑似漏判@」的误报排除');
{
  const cfg = { trigger: { botNames: ['示例昵称', '小深'], mentionPatterns: ['@{bot}', '@{bot} '] } };

  check('真是 @ 消息 → 不算漏判（不用报警）',
    looksLikeMissedMention({ side: 'incoming', text: '@示例昵称 你在干嘛' }, cfg) === false);
  check('提了名字但没有 @ → 该报警',
    looksLikeMissedMention({ side: 'incoming', text: '你在干嘛示例昵称' }, cfg) === true);
  check('压根没提名字 → 不报警', looksLikeMissedMention({ side: 'incoming', text: '今天天气不错' }, cfg) === false);
  check('自己发的消息 → 不报警（自己的话本来就不需要 @）',
    looksLikeMissedMention({ side: 'self', text: '示例昵称' }, cfg) === false);
  check('整条文本就是一个名字（名字标签）→ 不报警',
    looksLikeMissedMention({ side: 'incoming', text: '示例昵称' }, cfg) === false);
  check('名字前后只有空格也算名字标签 → 不报警',
    looksLikeMissedMention({ side: 'incoming', text: '  示例昵称  ' }, cfg) === false);
  check('空文本 → 不报警', looksLikeMissedMention({ side: 'incoming', text: '' }, cfg) === false);
  check('没有 message → 不报警', looksLikeMissedMention(null, cfg) === false);
  check('没配 botNames → 不报警', looksLikeMissedMention({ side: 'incoming', text: '示例昵称' }, {}) === false);
  check('全角 ＠ 也算认出来了 → 不报警',
    looksLikeMissedMention({ side: 'incoming', text: '＠示例昵称 早' }, cfg) === false);
  check('名字出现在句子中间（不是@）→ 该报警',
    looksLikeMissedMention({ side: 'incoming', text: '刚看到示例昵称在群里' }, cfg) === true);

  // 接线：bot.js 必须真的用这个判断（而不是自己又写一遍）
  const bot = readFileSync(path.join(ROOT, 'src', 'bot.js'), 'utf8');
  check('bot.js 用 looksLikeMissedMention 做判断', bot.includes('looksLikeMissedMention(d?.message, cfg)'));
}

console.log('\n' + '='.repeat(70));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(70));
process.exit(fail === 0 ? 0 : 1);
