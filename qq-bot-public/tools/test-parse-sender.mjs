/**
 * test-parse-sender.mjs — 回归测试：发送者昵称被「粘成一串」。
 *
 * 用户报的现象（在记忆面板里看到的）：
 *   关系里出现了「群友丁」「群友丁」「群友丁」「群友辛的怎么改」——
 *   其实是同一个人的昵称和群头衔被拼接、还被拆成好几份。
 *
 * 根因（实测查出来的，两个独立的 bug 叠在一起）：
 *
 *   1. 昵称/头衔的分界写死成绝对像素 `x >= 1750`。但这个偏移取决于
 *      **该用户有没有群头衔**：
 *        无头衔：昵称 x≈1732~1740
 *        有头衔：昵称被推到 x≈1822~1830   ← 越过 1750，被判成头衔
 *      于是昵称和头衔一起塞进 pendingTitle，而 sender 永远是空字符串。
 *
 *   2. 换行判断靠「遇到 LV 徽章就 flush」。但 Chromium 给的 y 是
 *      「头衔 618 / LV 619」—— 头衔排在 LV **之前**，等 LV 才 flush 时，
 *      新消息的头衔已经被算进上一条了。于是发送者名跨消息累积成
 *      35 个字的一串（4 个名字粘在一起）。
 *
 *   3. 附带发现：y 边界按元素切会把最上面一行切成两半（头衔进来、LV 和昵称
 *      被丢掉），导致第一条消息 sender 为空、头衔被当成正文。
 *
 * 夹具是**实机抓下来的真 UIA dump**（tools/fixtures/uia-live-rows.json），
 * 不是手搓的 —— 手搓很容易刚好绕开真实布局。
 *
 * 用法：node tools/test-parse-sender.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUia, findLayoutPanes, resolveChatColumn } from '../src/parse-uia.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tools', 'fixtures', 'uia-live-rows.json');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

/** 读夹具。PowerShell 的 `>` 重定向默认写 UTF-16LE，所以两种编码都要试。 */
function readFixture(file = FIXTURE) {
  const buf = fs.readFileSync(file);
  // UTF-16LE 的 BOM 是 FF FE
  if (buf[0] === 0xFF && buf[1] === 0xFE) return JSON.parse(buf.toString('utf16le').replace(/^\uFEFF/, ''));
  return JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));
}

// ---------------------------------------------------------------- 夹具缺失 ----
//
// 这个文件的核心断言全部建立在**实机抓下来的夹具**上（`tools/fixtures/*.json`）。
// 那些夹具里是真实的群名、群友昵称和**聊天内容原文**，所以：
//   · 它们不进公开仓库（导出发布包时会被剔掉）
//   · 别人克隆下来也没有它们
// 这时候**不能崩**：原先 `readFixture()` 会直接抛 ENOENT，
// 整个文件一行都不跑，看起来像"这项目是坏的"。
// 所以这里明确跳过并说清原因 —— 跳过是诚实，崩掉是误导。
// ⚠ 这段必须在 readFixture() **之前**（第一版放在后面，照样崩）。
if (!fs.existsSync(FIXTURE)) {
  console.log('='.repeat(72));
  console.log('跳过：缺少实机夹具');
  console.log('='.repeat(72));
  console.log(`  要的文件：${path.relative(ROOT, FIXTURE)}`);
  console.log('  这些夹具含真实群名/昵称/聊天原文，所以**不随仓库发布**。');
  console.log('  自己复现：把 QQ 停在一个群聊上，然后');
  console.log('      powershell -NoProfile -ExecutionPolicy Bypass -File tools/uia-read.ps1 -AllTypes > tools/fixtures/uia-live-rows.json');
  console.log('  没有夹具时，解析逻辑由这些测试覆盖：');
  console.log('      node tools/test-parse-uia.mjs   （对着当前窗口实测）');
  console.log('      node tools/test-context.mjs     （提示词与历史组织）');
  console.log('');
  process.exit(0);
}

const uia = readFixture();
const cfg = { readSource: 'uia' };
const parsed = parseUia(uia, cfg, {});

// 这个群里出现过的人。
//
// ⚠ 称号和名字的方向（我一开始搞反了，用户指出来的）：
//   左边 x 小的 = **称号**（含群头衔、青铜这类等级称号）
//   右边 x 大的 = **QQ 名字**
//   拼起来是「称号在前，名字在后」。
//
// 判据（不是猜的）：机器人的 QQ 昵称是「示例昵称」（群里 @ 的就是它），
// 它在发送者行里位于右侧；被 @ 的成员那个颜文字昵称也在右侧。
const REAL_NAMES = ['示例群友', '群友丁', '群友己', '示例昵称'];
const REAL_TITLES = ['群友乙', '群友丁', '群友辛的怎么改', '青铜'];

// 实测抓到过的「多个元素粘在一起」的串。它们**一个都不许再作为 sender 出现**。
// 注意：不要把「称号+名字」放进来 —— 那是 senderWithTitle 的**正确**形态。
const GLUED_GARBAGE = [
  '群友丁示例群友搞完示例群友',   // 4 个元素粘一起（35 字）
  '群友丁群友丁',                          // 称号跨消息累积
  '示例群友搞完群友己',
  '青铜群友己群友辛的怎么改',
  '搞完示例群友搞完',
];

console.log('='.repeat(72));
console.log('发送者昵称解析（真实 UIA dump 夹具）');
console.log('='.repeat(72));

// ------------------------------------------------------ 1. 基本
section('1) 夹具能解析出消息');
{
  check('夹具存在', fs.existsSync(FIXTURE));
  check('解析出了消息', parsed.messages.length >= 10, `${parsed.messages.length} 条`);
  check('会话名认出来了', parsed.conversation === '示例群', parsed.conversation);
  check('认出是群聊', parsed.isGroup === true);
  check('能区分自己发的消息', parsed.self.length > 0, `${parsed.self.length} 条`);
}

// ------------------------------------------------ 2. 核心：不许拼接
section('2) 核心回归：发送者名不许是多个名字粘在一起');
{
  const incoming = parsed.messages.filter((m) => m.side === 'incoming');

  // 2.1 每个 sender 都必须是单个真实名字
  const badSender = incoming.filter((m) => !REAL_NAMES.includes(m.sender));
  check(`所有他人消息的 sender 都是单个真实 QQ 名字（${REAL_NAMES.length} 个候选）`,
    badSender.length === 0,
    badSender.length ? JSON.stringify([...new Set(badSender.map((m) => m.sender))]) : '');

  // 2.2 sender 不许为空 —— 空说明分界又判错了
  const emptySender = incoming.filter((m) => !m.sender);
  check('没有 sender 为空的他人消息', emptySender.length === 0,
    emptySender.length ? `${emptySender.length} 条，例如 text=${JSON.stringify(emptySender[0].text)}` : '');

  // 2.3 长度上限
  const longest = incoming.map((m) => m.sender).sort((a, b) => [...b].length - [...a].length)[0] ?? '';
  check('最长的 sender 不超过 20 字（原来是 35 字）', [...longest].length <= 20,
    JSON.stringify(longest) + ` ${[...longest].length} 字`);

  // 2.4 实测抓到过的拼接串，一个都不许再作为 sender 出现
  const senders = parsed.messages.map((m) => m.sender);
  const stillGarbled = GLUED_GARBAGE.filter((g) => senders.includes(g));
  check(`实测抓到过的 ${GLUED_GARBAGE.length} 个拼接串不再作为 sender 出现`,
    stillGarbled.length === 0, stillGarbled.length ? JSON.stringify(stillGarbled) : '');

  // 2.5 也不许把称号和名字粘进 sender
  const gluedInSender = incoming.filter((m) =>
    REAL_TITLES.some((t) => REAL_NAMES.some((n) => m.sender === t + n || m.sender === n + t)));
  check('sender 里没有「称号紧贴名字」的形式', gluedInSender.length === 0,
    gluedInSender.length ? JSON.stringify(gluedInSender.map((m) => m.sender)) : '');
}

// ------------------------------------------ 2b. 称号在前，名字在后
section('2b) 称号在前、名字在后（用户明确指出的方向）');
{
  const both = parsed.messages.filter((m) => m.side === 'incoming' && m.sender && m.title);
  check('确实有同时带称号和名字的消息（否则这一节等于没测）', both.length > 0, `${both.length} 条`);

  // 这一条就是用户的规则本身
  const wrongOrder = both.filter((m) => m.senderWithTitle !== m.title + m.sender);
  check('senderWithTitle === 称号 + 名字（顺序钉死）', wrongOrder.length === 0,
    wrongOrder.length ? `例如 title=${JSON.stringify(wrongOrder[0].title)} sender=${JSON.stringify(wrongOrder[0].sender)} withTitle=${JSON.stringify(wrongOrder[0].senderWithTitle)}` : '');

  const nameFirst = both.filter((m) => m.senderWithTitle === m.sender + m.title);
  check('不是「名字在前」', nameFirst.length === 0,
    nameFirst.length ? JSON.stringify(nameFirst[0].senderWithTitle) : '');

  // sender 里必须是名字（右边那段），不是称号
  const senderIsTitle = both.filter((m) => REAL_TITLES.includes(m.sender));
  check('sender 字段里放的是名字，不是称号', senderIsTitle.length === 0,
    senderIsTitle.length ? JSON.stringify([...new Set(senderIsTitle.map((m) => m.sender))]) : '');
  const titleIsName = both.filter((m) => REAL_NAMES.includes(m.title));
  check('title 字段里放的是称号，不是名字', titleIsName.length === 0,
    titleIsName.length ? JSON.stringify([...new Set(titleIsName.map((m) => m.title))]) : '');

  // 方向判据本身 —— 把**证据**钉进测试，防止以后有人"想当然"再翻回去。
  //
  // 机器人的 QQ 昵称是「示例昵称」（群里 @ 的就是它，这是事实不是推测），
  // 它在发送者行里位于**右侧**（x 更大），左边是「青铜」。
  // 所以"右边才是名字"这件事有独立证据，不靠猜。
  // 注意别按 y 去找：名字元素在 y=-113，而它的 LV 徽章在 y=-112（差 1）。
  // 按名字找就行。
  const botEntry = uia.texts.find((t) => t.type === 'Text' && String(t.name).trim() === '示例昵称' && t.x > 2000);
  const titleEntry = uia.texts.find((t) => t.type === 'Text' && String(t.name).trim() === '青铜' && t.x > 2000);
  check('原始数据：示例昵称（机器人的名字）在「青铜」（称号）右边 —— 名字在右',
    Boolean(botEntry && titleEntry && botEntry.x > titleEntry.x),
    botEntry && titleEntry ? `示例昵称 x=${botEntry.x} > 青铜 x=${titleEntry.x}` : '夹具里没找到这两项');

  // 另一个独立证据：被 @ 的成员（那个颜文字昵称）也在右侧
  const mentionEntry = uia.texts.find((t) => t.type === 'Text'
    && String(t.name).trim().startsWith('o(') && String(t.name).trim().endsWith(')q') && t.x > 1800);
  const itsTitle = uia.texts.find((t) => t.type === 'Text' && mentionEntry && Math.abs(t.y - mentionEntry.y) <= 1 && String(t.name).trim() === '群友乙');
  check('原始数据：被 @ 的成员昵称也在「群友乙」（称号）右边',
    Boolean(mentionEntry && itsTitle && mentionEntry.x > itsTitle.x),
    mentionEntry && itsTitle ? `${mentionEntry.x} > ${itsTitle.x}` : '夹具里没找到');
}

// ------------------------------------------ 3. 称号和名字要各归各位
section('3) 名字进 sender，称号进 title，不许互相串');
{
  const withBoth = parsed.messages.filter((m) => m.side === 'incoming' && m.sender && m.title);
  check('确实解析出了「有称号」的消息（否则这一节等于没测）', withBoth.length > 0,
    `${withBoth.length} 条`);

  const badTitle = withBoth.filter((m) => !REAL_TITLES.includes(m.title));
  check('title 都是已知的称号', badTitle.length === 0,
    badTitle.length ? JSON.stringify([...new Set(badTitle.map((m) => m.title))]) : '');

  const badName = withBoth.filter((m) => !REAL_NAMES.includes(m.sender));
  check('sender 都是已知的名字', badName.length === 0,
    badName.length ? JSON.stringify([...new Set(badName.map((m) => m.sender))]) : '');
}

// ---------------------------------- 4. 称号不许漏进正文（y 边界bug）
section('4) 称号和名字都不许漏进正文');
{
  const incoming = parsed.messages.filter((m) => m.side === 'incoming');
  const leaky = incoming.filter((m) =>
    REAL_TITLES.some((t) => String(m.text).startsWith(t))
    || REAL_NAMES.some((n) => String(m.text).startsWith(n)));
  check('没有消息的正文以称号或名字开头', leaky.length === 0,
    leaky.length ? JSON.stringify(leaky[0].text) : '');

  // 夹具里第一条消息的正文就是「没玩」—— 修之前它是「<称号>没玩」
  const first = incoming[0];
  check('最上面那条消息的正文是干净的', first && first.text === '没玩',
    first ? JSON.stringify(first.text) : '(没有消息)');
  check('最上面那条消息的 sender 是名字（整行都被收进来了）',
    first && first.sender === '示例群友',
    first ? JSON.stringify(first.sender) : '(没有消息)');
  check('最上面那条消息的称号归到了 title', first && first.title === '群友乙',
    first ? JSON.stringify(first.title) : '(没有消息)');
}

// ------------------------------------------ 5. 时间戳仍然被剥掉
section('5) 别把「剥时间戳」一起弄坏');
{
  const incoming = parsed.messages.filter((m) => m.side === 'incoming');
  const withTime = incoming.filter((m) => /^\d{1,2}:\d{2}$/.test(String(m.text).trim()));
  check('没有消息的正文只剩一个时间戳', withTime.length === 0,
    withTime.length ? JSON.stringify(withTime[0].text) : '');
  const trailing = incoming.filter((m) => /\d{1,2}:\d{2}$/.test(String(m.text).trim()));
  check('正文末尾不再挂着时间戳', trailing.length === 0,
    trailing.length ? JSON.stringify(trailing.map((m) => String(m.text).slice(-8))) : '');
}

// ------------------------------------------ 6. 分界参数可配 + 边界
section('6) nameOffset 可配，且默认值落在实测的安全区');
{
  // 实测：称号 = LV.x+31~39，名字 = LV.x+74~116
  const defaultOffset = 55;
  check('默认分界 55 落在称号上界(39)和名字下界(74)之间',
    defaultOffset > 39 && defaultOffset < 74, String(defaultOffset));

  // 分界调大到 200：所有行内文字都算称号，于是 sender 会变空。
  // 这一节**不是**在说它是对的 —— 是在说：即使分界配错了，也只会退化成
  // "名字没了"，绝不会变成"跨消息累积"（那才是真正致命的那个 bug）。
  const off = parseUia(uia, { readSource: 'uia', uia: { nameOffset: 200 } }, {});
  const offIncoming = off.messages.filter((m) => m.side === 'incoming');
  const offNames = [...new Set(offIncoming.map((m) => m.sender))];
  check('分界调大到 200：sender 变空，但每条仍各有各的称号，不会跨消息累积',
    offNames.every((n) => n === '') && [...new Set(offIncoming.map((m) => m.title))].length <= 4,
    JSON.stringify([...new Set(offIncoming.map((m) => m.title))]));

  const tiny = parseUia(uia, { readSource: 'uia', uia: { nameOffset: 1 } }, {});
  const tinySenders = tiny.messages.filter((m) => m.side === 'incoming').map((m) => m.sender);
  check('分界调到 1（什么都是名字）→ 仍然不拼接',
    tinySenders.every((s) => s === '' || [...s].length <= 20),
    JSON.stringify([...new Set(tinySenders)]));

  check('nameOffset 给了垃圾值（0/负数/字符串）时回退默认',
    (() => {
      const good = (p) => p.messages.filter((m) => m.side === 'incoming')
        .every((m) => !m.sender || REAL_NAMES.includes(m.sender));
      return good(parseUia(uia, { readSource: 'uia', uia: { nameOffset: 0 } }, {}))
        && good(parseUia(uia, { readSource: 'uia', uia: { nameOffset: 'x' } }, {}));
    })());
}

// ------------------------------------------ 7. 空/异常输入
section('7) 空输入和异常输入不许抛');
{
  for (const bad of [undefined, null, {}, { texts: [] }, { texts: 'x' }, { texts: [null, 1, {}] }]) {
    let threw = false;
    try { parseUia(bad, cfg, {}); } catch { threw = true; }
    check(`parseUia(${JSON.stringify(bad)?.slice(0, 24) ?? 'undefined'}) 不抛`, threw === false);
  }
}

// ============================================================================
// 第二个夹具：机器人自己的头部 + 群成员面板都在场的那种布局
// ============================================================================
const SELF_FIXTURE = path.join(ROOT, 'tools', 'fixtures', 'uia-self-header.json');
let selfParsed = null;
try { selfParsed = parseUia(readFixture(SELF_FIXTURE), cfg, {}); } catch (e) {
  console.log('\n  (第二个夹具读不出来: ' + e.message + ')');
}

section('8) 机器人自己的头部行不许被当成「别人的发送者行」');
{
  // 自己发的消息**也带**一行头部：LV + 等级 + 称号 + 自己的名字，而且整体靠右。
  // 实测：LV x=2092、称号「这啥AI」x=2116、自己的名字「示例昵称」x=2164。
  //
  // 原来的判断是「右对齐 **且没有 LV 徽章** 才算自己」，于是带了头部的自己消息
  // 落到发送者行分支里，被当成别人的头部 —— 自己的话变成「示例昵称 说的」。
  // 后果（用户先发现的）：
  //   · 记忆里凭空多出一个叫「示例昵称」的"群友"
  //   · 自己说过的话被记成别人的经历
  //   · 历史里同一条话出现两次
  // 而「示例昵称」正好是群里 @ 时出现的名字，所以看起来像"把@消息错认成人名"。
  if (!selfParsed) {
    check('第二个夹具可读', false, '夹具读不出来，这一节跳过');
  } else {
    const inc = selfParsed.messages.filter((m) => m.side === 'incoming');
    check('第二个夹具解析出了消息', selfParsed.messages.length > 5, `${selfParsed.messages.length} 条`);

    const botAsOther = inc.filter((m) => m.sender === '示例昵称');
    check('没有「他人消息」的 sender 是机器人自己的名字',
      botAsOther.length === 0,
      botAsOther.length ? `${botAsOther.length} 条，例如 text=${JSON.stringify(botAsOther[0].text)}` : '');

    check('机器人自己的话被算成 self（不是别人的）',
      selfParsed.self.length > 0, `${selfParsed.self.length} 条 self`);

    // 同一段文字不许同时出现在 self 和 incoming 里（那是"自己说的话被记成别人说的"）
    const selfTexts = new Set(selfParsed.self.map((m) => String(m.text)));
    const dup = inc.filter((m) => selfTexts.has(String(m.text)));
    check('没有哪句话同时被算成「自己说的」和「别人说的」', dup.length === 0,
      dup.length ? JSON.stringify(dup[0].text) : '');

    // 名字里不许混进"机器人自己的名字"当称号那部分
    const titles = inc.map((m) => m.title);
    check('title 里没有机器人自己的名字', !titles.includes('示例昵称'), JSON.stringify([...new Set(titles)]));
  }
}

section('9) 头部行只认贴着 LV 徽章的那一小段（右边是成员面板，左边是时间戳）');
{
  // 实测：头部最远到 LV.x + 116；群成员面板在 LV.x + 561 起；
  // 聊天列最左边的时间戳在 LV 徽章**左边**（负偏移）。
  // 不设边界的话，只要面板里某个元素的 y 恰好撞上这一行，
  // 「群友己」「管理员」就会被粘进名字；时间戳也会被粘进去
  // （实测抓到过 sender = "示例群友10-05 11:48:42"）。
  const FIXTURES = [
    ['旧布局', path.join(ROOT, 'tools', 'fixtures', 'uia-live-rows.json')],
    ['新布局', SELF_FIXTURE],
  ];

  for (const [label, file] of FIXTURES) {
    let p;
    try { p = parseUia(readFixture(file), cfg, {}); } catch { continue; }
    const names = p.messages.filter((m) => m.side === 'incoming').map((m) => m.sender);

    const withTime = names.filter((n) => /\d{1,2}:\d{2}/.test(n) || /\d{2}-\d{2}/.test(n));
    check(`${label}：sender 里没有时间戳`, withTime.length === 0, JSON.stringify(withTime));

    const panelWords = ['管理员', '群主', '群聊成员', 'LV'];
    const withPanel = names.filter((n) => panelWords.some((w) => n.includes(w)));
    check(`${label}：sender 里没有群成员面板/头衔这类词`, withPanel.length === 0, JSON.stringify(withPanel));

    const tooLong = names.filter((n) => [...n].length > 20);
    check(`${label}：sender 长度都正常（<=20 字）`, tooLong.length === 0, JSON.stringify(tooLong));

    const numeric = names.filter((n) => /^\d+$/.test(n));
    check(`${label}：sender 里没有纯数字（等级/时间）`, numeric.length === 0, JSON.stringify(numeric));
  }

  // 边界参数可配
  const tiny = parseUia(readFixture(SELF_FIXTURE), { readSource: 'uia', uia: { nameRowMaxOffset: 10 } }, {});
  const tinyNames = tiny.messages.filter((m) => m.side === 'incoming').map((m) => m.sender);
  check('nameRowMaxOffset 调小后 sender 变空，但仍不掺垃圾',
    tinyNames.every((n) => n === ''), JSON.stringify([...new Set(tinyNames)]));
  check('nameRowMaxOffset 给垃圾值时回退默认',
    (() => {
      const a = parseUia(readFixture(SELF_FIXTURE), { readSource: 'uia', uia: { nameRowMaxOffset: 0 } }, {});
      return a.messages.filter((m) => m.side === 'incoming').every((m) => !m.sender || [...m.sender].length <= 20);
    })());
}

section('10) 新解析器上，机器人自己的名字不会出现在他人 sender 里（真实 config 交叉验证）');
{
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const botNames = real.trigger?.botNames ?? [];
  check('config 里确实配了机器人自己的名字', botNames.length > 0, JSON.stringify(botNames));

  for (const [label, file] of [['旧布局', path.join(ROOT, 'tools', 'fixtures', 'uia-live-rows.json')], ['新布局', SELF_FIXTURE]]) {
    let p;
    try { p = parseUia(readFixture(file), cfg, {}); } catch { continue; }
    const bad = p.messages
      .filter((m) => m.side === 'incoming')
      .filter((m) => botNames.some((n) => n && (m.sender === n || m.title === n)));
    check(`${label}：他人消息的 sender/title 都不等于机器人自己的名字`, bad.length === 0,
      bad.length ? JSON.stringify(bad.map((m) => [m.sender, m.title])) : '');
  }
}

section('11) 会话名不许是标题栏里的按钮文案');
{
  // 实测踩到：QQ 切会话的瞬间，标题带里最宽的那个 Button 是「语音通话」，
  // 于是会话名被读成「语音通话」。后果不只是显示错：
  //   · 记忆按会话分文件 → 凭空多出一份 memory/语音通话.json
  //   · 白名单按名字匹配 → "不在白名单里"，机器人一条都不回
  const { extractConversationName, resolveChatColumn } = await import('../src/parse-uia.js');

  const col = {
    xMin: 1719, xMax: 2059, yMin: -1416, yMax: 784,
    selfXMin: 1999, selfXMax: 2299,
    titleYMin: 304, titleYMax: 384, titleXMin: 1679, titleXMax: 2079,
  };
  const btn = (name, x, w, y = 309) => ({ type: 'Button', name, x, y, w, h: 20 });

  // 只有工具栏按钮 → 宁可返回空，也不要随便认一个
  for (const label of ['语音通话', '视频通话', '更多', '邀请加群', '屏幕共享', '文件', '截图', '表情']) {
    const r = extractConversationName([btn(label, 1731, 347)], col);
    check(`标题带里只有「${label}」时 → 会话名为空（不认按钮）`, r.name === '', JSON.stringify(r.name));
  }

  // 会话名 + 工具栏按钮 → 认会话名
  const mixed = extractConversationName(
    [btn('示例群', 1731, 157), btn('语音通话', 1880, 60), btn('更多', 1950, 33)], col);
  check('会话名与工具栏按钮混在一起时，认会话名', mixed.name === '示例群', JSON.stringify(mixed.name));
  check('候选里不再包含工具栏按钮',
    !mixed.candidates.includes('语音通话') && !mixed.candidates.includes('更多'),
    JSON.stringify(mixed.candidates));

  // 很短的群名也要认出来（不能因为宽度小就被丢掉）
  const shortName = extractConversationName([btn('学习', 1731, 40), btn('更多', 1950, 33)], col);
  check('很短的群名（「学习」）也认得出', shortName.name === '学习', JSON.stringify(shortName.name));

  // 真实现场：当前这个会话的标题
  const live = path.join(ROOT, 'tools', 'fixtures', 'uia-self-header.json');
  try {
    const u = readFixture(live);
    const got = extractConversationName(u.texts, resolveChatColumn(u.sendButton, {}));
    check('真实夹具里的会话名不是工具栏按钮',
      !['语音通话', '视频通话', '更多', ''].includes(got.name), JSON.stringify(got.name));
  } catch (e) {
    check('真实夹具可读', false, e.message);
  }
}

// ---------------------------------------------------- 私聊 vs 群聊的布局
//
// 用户的原话：「与个人的对话与群聊不同，做适配」。
//
// 不同在哪儿（实机测出来的）：
//   群聊右侧有成员列表 → 消息区被挤窄 → 发送按钮 x=2086
//   私聊没有成员列表   → 消息区更宽   → 发送按钮 x=2338
//   同一个窗口、同样大小，两者差 250px。
// 而原来所有横向边界都是「相对发送按钮」算的，于是同一套偏移在私聊里整体偏右
// 约 250px：**消息一条都读不到、会话名也读不出来**（实机就是这样卡住的）。
//
// 修法：改用「消息列表」Pane 当锚点 —— 它就是消息区，两种布局里都成立。
// 夹具 tools/fixtures/uia-direct.json 是那次故障现场的真 UIA dump（含 panes）。
section('私聊布局（以消息列表面板为锚，而不是发送按钮）');
{
  const dir = readFixture(path.join(ROOT, 'tools', 'fixtures', 'uia-direct.json'));

  check('夹具里带 panes（没有它就退化成旧的偏移方案）', Array.isArray(dir.panes) && dir.panes.length > 0,
    `${(dir.panes || []).length} 个`);

  const panes = findLayoutPanes(dir);
  check('认得出「会话列表」Pane', Boolean(panes.list), JSON.stringify(panes.list));
  check('认得出「消息列表」Pane', Boolean(panes.msg), JSON.stringify(panes.msg));
  check('私聊里没有成员列表 Pane（这正是两种布局的差别）', panes.member === null,
    JSON.stringify(panes.member));

  const col = resolveChatColumn(dir.sendButton, {}, panes);
  check('边界以面板为锚', col.anchor === 'panel', col.anchor);
  check('消息带左界在面板左沿附近',
    Math.abs(col.xMin - (panes.msg.x - 20)) <= 1, `${col.xMin} vs ${panes.msg.x - 20}`);
  check('消息带右界是按面板宽度切的（不再是发送按钮那些偏移）',
    col.xMax !== dir.sendButton.x - 120 && col.xMax === Math.round(panes.msg.x + panes.msg.w * 0.57),
    `xMax=${col.xMax} 面板推算=${Math.round(panes.msg.x + panes.msg.w * 0.57)} sendX-120=${dir.sendButton.x - 120}`);
  check('"自己"的判定线落在面板右半边（自己气泡右对齐）',
    col.selfXMin === col.xMax && col.selfXMin > panes.msg.x + panes.msg.w / 2,
    `selfXMin=${col.selfXMin} 面板中线=${panes.msg.x + panes.msg.w / 2}`);
  check('自己的右沿接近面板右沿', col.selfXMax <= panes.msg.x + panes.msg.w,
    `selfXMax=${col.selfXMax} paneRight=${panes.msg.x + panes.msg.w}`);

  const p = parseUia(dir, {});
  check('私聊能读出会话名（修好之前这里是空字符串）',
    p.conversation === '示例群友', JSON.stringify(p.conversation));
  check('私聊判成非群聊', p.isGroup === false, String(p.isGroup));
  check('私聊没有成员列表 Pane', p.hasMemberPane === false);

  // 会话名旁边那个「在线状态 在线」按钮：私聊独有，必须排掉
  check('标题候选里没有「在线状态」这类按钮',
    !(p.conversationCandidates || []).some((n) => /在线状态/.test(String(n))),
    JSON.stringify(p.conversationCandidates));

  // 那串竖排的 "1".."9" 噪声：实测被粘成过 "12:06123456789"
  check('竖排单个数字噪声没被当成消息（1 字符碎片规则）',
    !(p.messages || []).some((m) => /\d{4,}/.test(m.text) || /^12:06/.test(m.text)),
    JSON.stringify((p.messages || []).map((m) => m.text)));

  // ---- 私聊里的消息：合成行 ----
  // ⚠ 这个私聊窗口当时是空的，没法拿真消息验，所以按**实测的面板几何**
  //   补了两条消息行（坐标合成、面板内外关系真实）。测试名里写明这一点。
  const withMsgs = readFixture(path.join(ROOT, 'tools', 'fixtures', 'uia-direct-msgs.json'));
  const q = parseUia(withMsgs, {});
  check('（合成消息行）私聊能解析出消息', q.messages.length >= 2, `${q.messages.length} 条`);
  const inc = q.incoming.map((m) => m.text);
  const own = q.self.map((m) => m.text);
  check('（合成消息行）左对齐的算他人', inc.includes('在吗') && inc.includes('刚在忙'), JSON.stringify(inc));
  check('（合成消息行）右对齐的算自己', own.includes('在的'), JSON.stringify(own));
  // 对方昵称不在测试里写字面量：它中间含「星号+斜杠」，会把块注释/字符串截断
  //（这个坑我踩过四次）。直接拿解析出来的会话名比。
  check('（合成消息行）私聊里他人消息的 sender 补成对方昵称（私聊没有发送者行）',
    q.incoming.length > 0 && q.incoming.every((m) => m.sender === q.conversation),
    JSON.stringify(q.incoming.map((m) => m.sender)));
  check('（合成消息行）自己发的不带 sender', q.self.every((m) => m.sender === ''));
  check('（合成消息行）发送者来源标成 direct-peer（能看出是推断的不是解析出来的）',
    q.incoming.every((m) => m.senderFrom === 'direct-peer'));

  // ---- 群聊那条路不能因为这次改动而回退 ----
  const grp = readFixture(FIXTURE);
  const g = parseUia(grp, {});
  check('群聊夹具没有 panes → 自动退回偏移方案', g.layoutAnchor === 'offsets', g.layoutAnchor);
  check('群聊仍然判成群聊', g.isGroup === true, String(g.isGroup));
  check('群聊仍然能读到消息', g.messages.length > 0, `${g.messages.length} 条`);
  check('群聊的消息 sender 不是硬补的', g.incoming.every((m) => m.senderFrom !== 'direct-peer'));
}

// ------------------------------------- 自己的名字标签 / 没有发送者行时的断句
//
// 两件实测出来的事（都在测试群里现场抓的）：
//  1. QQ 会把自己的昵称渲染成一个 Text 元素，位置在自己那半边
//     （实测 x=2098 w=63，紧挨着自己的头像 x=2171），条件正好满足"自己发的消息"。
//     它被当成一条自己发的消息之后：历史里多一条 `[self] "示例昵称"`，
//     而且「@ 漏判」自检拿它当证据，每轮刷两行误报 —— 用户看到的就是「@ 文字丢了」。
//  2. 群里**同一个人连续发言时 QQ 不重复渲染名字行**，系统消息也没有头部，
//     于是整屏一个 LV 徽章都没有，相邻消息再没有东西能断开，会被粘成一大坨
//     （实测一条正文里串了 2 个时间戳、3 个发送者名和 2 个 @）。
//     所以"按 y 断句"的判据不能是"群聊还是私聊"，而是"这一屏有没有 LV 徽章"。
section('自己的名字标签 & 没有发送者行时的断句');
{
  const uia = {
    ok: true,
    sendButton: { name: '发送', type: 'Button', x: 2086, y: 898, w: 36, h: 36 },
    texts: [
      { name: '示例昵称', type: 'Text', x: 2098, y: 301, w: 63, h: 19 },   // 自己的名字标签
      { name: '在吗', type: 'Text', x: 1709, y: 400, w: 50, h: 20 },       // 他人，无发送者行
      { name: '在的', type: 'Text', x: 1709, y: 550, w: 50, h: 20 },       // 同上，隔 150px
    ],
    panes: [],
  };
  const cfg = { trigger: { botNames: ['示例昵称'] }, geometry: { minMessageChars: 2 }, uia: {} };
  const p = parseUia(uia, cfg);

  check('自己的名字标签不再变成一条"自己发的消息"',
    !p.self.some((m) => m.text === '示例昵称'), JSON.stringify(p.self.map((m) => m.text)));
  check('真实消息不受影响（两条都在）',
    p.messages.map((m) => m.text).join('|') === '在吗|在的', JSON.stringify(p.messages.map((m) => m.text)));
  check('两条消息没有被粘成一条（没有 LV 徽章时按 y 断句）', p.messages.length === 2, `${p.messages.length} 条`);

  // 说明"过滤靠的就是 botNames 这份名单" —— 不配的话它照样会被当成消息
  const p2 = parseUia(uia, { ...cfg, trigger: { botNames: [] } });
  check('不配 botNames 时它确实会被当成自己发的消息（过滤靠这份名单）',
    p2.self.some((m) => m.text === '示例昵称'), JSON.stringify(p2.self.map((m) => m.text)));

  // 反过来：有 LV 徽章的那条路（群里已验证）不能因为这次改动而多断句
  const grp = readFixture(FIXTURE);
  const g = parseUia(grp, {});
  check('有 LV 徽章的群聊仍走原来的断句路径（消息条数不变）', g.messages.length === 12, `${g.messages.length} 条`);
}

// ------------------------------------------------- 没有 LV 徽章时的发送者行（靠头像）
//
// 用户报的第二个版本：「提交给API的消息名字与信息粘连在一起」（换小模型之后才暴露）。
//
// 现场是「测试群」：这个群整屏一个 LV 徽章都没有，所以上面那套 LV 锚点全失效，
// 昵称元素被当成正文 → 解析出 "群友甲在干嘛呢"：
//     y≈-296  G:"群友甲"@x1606  T:"群友甲"@x1656   ← 头像 + 昵称，同一个 y
//     y≈-261  T:"想"@x1672                    ← 正文，下一行
// 夹具 tools/fixtures/uia-group-avatar.json 是实机抓的（那次现场），不是手搓的。
section('11) 没有 LV 徽章：靠头像认出发送者行');
{
  const file = path.join(ROOT, 'tools', 'fixtures', 'uia-group-avatar.json');
  check('夹具存在', fs.existsSync(file));

  const av = parseUia(readFixture(file), { trigger: { botNames: ['示例昵称'] } });
  const inc = av.messages.filter((m) => m.side === 'incoming');

  check('解析出了消息', av.messages.length >= 8, `${av.messages.length} 条`);
  check('认出是群聊', av.isGroup === true, String(av.isGroup));
  check('他人消息都有发送者（头像的 Name 就是昵称）',
    inc.length > 0 && inc.every((m) => m.sender), JSON.stringify([...new Set(inc.map((m) => m.sender))]));

  // 核心断言：正文里不许再粘着发送者昵称
  const names = [...new Set(inc.map((m) => m.sender))];
  const glued = inc.filter((m) => names.some((n) => m.text.startsWith(n) && m.text !== n));
  check('正文开头不再粘着发送者昵称（"群友甲在干嘛呢" 这种）', glued.length === 0,
    JSON.stringify(glued.map((m) => [m.sender, m.text])));

  check('昵称也不再被当成一条消息',
    !av.messages.some((m) => names.includes(String(m.text).trim())),
    JSON.stringify(av.messages.map((m) => m.text)));

  // 称号（实测这个群里那个颜文字群主有「群主」称号）
  check('称号被单独认出来（没混进正文）',
    inc.some((m) => m.title === '群主') && !inc.some((m) => String(m.text).startsWith('群主')),
    JSON.stringify(inc.filter((m) => m.title).map((m) => [m.title, m.sender, m.text])));

  // ⚠ 这条是**最容易白干**的地方：头像锚点靠 Group 元素，而 uia-read.ps1 默认
  //   只导出 Text/Button/Edit —— 不在那边放行 Group 的话，线上读到的永远没有头像，
  //   整套逻辑在实测里静默失效（测试却全绿，因为夹具是带 -AllTypes 抓的）。
  const psSrc = fs.readFileSync(path.join(ROOT, 'tools', 'uia-read.ps1'), 'utf8');
  check('uia-read.ps1 默认就导出 Group（头像）元素 —— 否则线上头像锚点永远为空',
    /-not \$AllTypes[^\n]*'Group'/.test(psSrc), '看 uia-read.ps1 的类型过滤那一行');

  // 同一个道理：doctor 的读取参数必须和 reader.js 一致，
  // 否则体检报告描述的布局不是机器人实际看到的那个（踩过一次）。
  const readerSrc = fs.readFileSync(path.join(ROOT, 'src', 'reader.js'), 'utf8');
  const docSrc = fs.readFileSync(path.join(ROOT, 'src', 'doctor.js'), 'utf8');
  const procArg = /uia-read\.ps1', \['-ProcessName'/;
  check('reader 和 doctor 用同一套读取参数', procArg.test(readerSrc) && procArg.test(docSrc),
    'reader=' + procArg.test(readerSrc) + ' doctor=' + procArg.test(docSrc));
}

// ------------------------------------------------- 时间字段（用户要求：时间也加 |）
//
// QQ 不给每条消息渲染时间，只在一段对话开头插一条**时间分隔线**（实测 x=1534、
// 列 xMin=1590 的居中 `10:38`）。所以：
//   · 正文里粘着时间戳（`打王者啊20:44`）→ 剥下来当这条的 time（最准）
//   · 否则退回上一根分隔线，而且**只给紧随其后的第一条** —— 一根线管一片消息，
//     给全片盖同一个时间就是编
section('12) 时间：粘在正文里的剥下来，分隔线只给紧跟着的那一条');
{
  const file = path.join(ROOT, 'tools', 'fixtures', 'uia-group-avatar.json');
  const av = parseUia(readFixture(file), { trigger: { botNames: ['示例昵称'] } });
  const timed = av.messages.filter((m) => m.time);

  check('有消息拿到了时间', timed.length >= 1, JSON.stringify(timed.map((m) => [m.time, m.text])));
  check('时间都是 HH:MM 形状', timed.every((m) => /^\d{1,2}:\d{2}$/.test(m.time)));
  check('时间没有留在正文里', !av.messages.some((m) => /\d{1,2}:\d{2}$/.test(String(m.text).trim())),
    JSON.stringify(av.messages.map((m) => m.text)));
  check('一根分隔线只喂一条消息（不搞"全片同一个时间"）',
    new Set(timed.map((m) => m.time)).size === timed.length,
    JSON.stringify(timed.map((m) => [m.time, m.text])));
  check('拿不到时间的渲染成 -（由 llm.renderIncomingLine 负责，这里只保证字段存在）',
    av.messages.every((m) => typeof m.time === 'string'));

  // 粘在正文里的两种位置都要能剥（实测开头结尾都出现过）
  const mk = (text) => ({
    ok: true,
    sendButton: { name: '发送', type: 'Button', x: 2086, y: 898, w: 36, h: 36 },
    texts: [
      { name: '在吗', type: 'Text', x: 1709, y: 300, w: 50, h: 20 },
      { name: text, type: 'Text', x: 1709, y: 400, w: 200, h: 20 },
    ],
    panes: [],
  });
  const cfg2 = { trigger: { botNames: ['示例昵称'] }, geometry: { minMessageChars: 2 } };
  const end = parseUia(mk('打王者啊20:44'), cfg2).messages.at(-1);
  check('结尾粘的时间戳被剥下来当 time',
    end?.time === '20:44' && end?.text === '打王者啊',
    JSON.stringify([end?.time, end?.text]));
  const head = parseUia(mk('20:55群主@示例昵称 你在干嘛'), cfg2).messages.at(-1);
  check('开头粘的时间戳被剥下来当 time',
    head?.time === '20:55' && !String(head?.text).startsWith('20:55'),
    JSON.stringify([head?.time, head?.text]));
}

console.log('\n' + '='.repeat(72));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(72));
process.exit(fail === 0 ? 0 : 1);

