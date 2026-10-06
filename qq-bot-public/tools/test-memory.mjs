/**
 * test-memory.mjs — 记忆模块的回归测试。
 *
 * 需求原话：「每次调用API时，API都会读取并修改一份json文件，
 *            这个文件包含现在的心情，自己做过什么事，自己喜欢什么，与其他群友的关系」
 *
 * 这个模块有两个特点，所以测试的重点和别处不同：
 *
 * 1. **输入是模型写出来的** —— 也就是不可信输入。
 *    模型会漏字段、写错类型、把「某人」当成群友、把「早」当成聊过的话题。
 *    所以这里大量测「喂垃圾进去会怎样」。
 *
 * 2. **记忆会被塞进每一轮提示词** —— 所以它必须有上限。
 *    没上限的话它只会越滚越长，每轮 token 跟着涨，最后把上下文挤爆。
 *    所以每一项上限都要有测试钉住。
 *
 * 用法：node tools/test-memory.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  emptyMemory, sanitizeMemory, loadMemory, saveMemory, renderMemory,
  applyMemoryPatch, shouldUpdateMemory, memoryFile, listConversations, DEFAULT_LIMITS,
} from '../src/memory.js';
import { buildMessages, parseJsonLoose } from '../src/llm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'));
const mkCfg = (over = {}) => ({
  memory: { enabled: true, file: 'memory.json', updateEvery: 1, updateMinIntervalMs: 0, ...over },
  llm: { contextMessages: 16, systemPrompt: 'sys' },
});

console.log('='.repeat(72));
console.log('记忆模块：心情 / 经历 / 喜好 / 与群友的关系');
console.log('='.repeat(72));

// ---------------------------------------------------- 1. 脏数据不许崩
section('1) sanitizeMemory：模型写的脏数据不许崩，也不许带进来');
{
  const garbage = [
    undefined, null, 0, '', 'string', [], true,
    { mood: 'happy' },                       // 心情该是对象，给了字符串
    { mood: { label: { a: 1 } } },            // label 该是字符串，给了对象
    { events: 'not-an-array' },
    { events: [null, 1, {}, { text: 'ok' }, 'plain string'] },
    { relations: [{ name: 123 }, { name: 'a' }, { name: 'a', note: 'dup' }] },
    { likes: [null, undefined, '', '  ', '白饭'] },
    { facts: { nested: true } },
    { version: 'x', updatedAt: 42 },
  ];
  let threw = 0;
  for (const g of garbage) {
    try {
      const m = sanitizeMemory(g, mkCfg());
      const okShape = m && typeof m === 'object'
        && m.mood && typeof m.mood.label === 'string'
        && Array.isArray(m.facts) && Array.isArray(m.likes) && Array.isArray(m.dislikes)
        && Array.isArray(m.events) && Array.isArray(m.relations) && Array.isArray(m.topics);
      if (!okShape) throw new Error('结构不完整: ' + JSON.stringify(m));
    } catch { threw++; }
  }
  check(`${garbage.length} 种脏输入全部没抛、且返回结构完整的记忆`, threw === 0, `抛了 ${threw} 次`);

  const a = sanitizeMemory({ events: 'not-an-array' }, mkCfg());
  check('events 给了字符串 → 退化成空数组', Array.isArray(a.events) && a.events.length === 0);
  const b = sanitizeMemory({ events: ['plain string', { text: 'obj' }] }, mkCfg());
  check('events 里的裸字符串也能收（转成 {text}）', b.events.length === 2, JSON.stringify(b.events.map((e) => e.text)));
  const c = sanitizeMemory({ likes: [null, '  ', '白饭'] }, mkCfg());
  check('列表里的空值/空白被丢掉', c.likes.length === 1 && c.likes[0] === '白饭', JSON.stringify(c.likes));
  const d = sanitizeMemory({ relations: [{ name: 'a', note: '1' }, { name: 'a', note: '2' }] }, mkCfg());
  check('同名关系只留一条（后写的覆盖）', d.relations.length === 1 && d.relations[0].note === '2',
    JSON.stringify(d.relations));
  const e = sanitizeMemory({ updatedAt: 42 }, mkCfg());
  check('updatedAt 非字符串 → 归 null', e.updatedAt === null);
}

// ------------------------------------------------------------ 2. 上限
section('2) 上限：记忆不许无限长（它要塞进每一轮提示词）');
{
  const cfg = mkCfg({ limits: { events: 3, relations: 2, likes: 2, itemChars: 10, digestChars: 200 } });
  const long = {
    events: Array.from({ length: 10 }, (_, i) => ({ text: `事件${i}` })),
    relations: Array.from({ length: 6 }, (_, i) => ({ name: `人${i}`, note: 'x' })),
    likes: ['a', 'b', 'c', 'd'],
    facts: ['这是一个特别特别特别特别长的句子会被截断'],
  };
  const m = sanitizeMemory(long, cfg);
  check('events 截到上限，且保留**最新**的', m.events.length === 3 && m.events[2].text === '事件9',
    JSON.stringify(m.events.map((e) => e.text)));
  check('relations 截到上限', m.relations.length === 2);
  check('likes 截到上限', m.likes.length === 2);
  check('单条超长被截断并加省略号', m.facts[0].endsWith('…') && [...m.facts[0]].length === 11, m.facts[0]);

  const digest = renderMemory({
    facts: Array.from({ length: 30 }, (_, i) => `事实编号${i}`),
    likes: Array.from({ length: 30 }, (_, i) => `喜欢${i}`),
  }, cfg);
  check('渲染出来的整段受 digestChars 硬上限约束',
    [...digest].length < 400, `${[...digest].length} 字（上限 200 + 标题行）`);

  // 上限配置本身是脏的怎么办
  const weird = sanitizeMemory(long, mkCfg({ limits: { events: -1, likes: 'abc', itemChars: 0 } }));
  check('limits 给了负数/非数字 → 回退默认值，不会把记忆清空',
    weird.events.length > 0 && weird.likes.length > 0,
    `events=${weird.events.length} likes=${weird.likes.length}`);
}

// ------------------------------------------------------------ 3. 渲染
section('3) renderMemory：空记忆返回空串（不许往提示词里塞废话）');
{
  const cfg = mkCfg();
  check('空记忆 → 空串', renderMemory(emptyMemory(), cfg) === '');
  check('null → 空串', renderMemory(null, cfg) === '');

  const m = {
    mood: { label: '有点困', why: '被连着追问' },
    facts: ['群里叫我小深'],
    likes: ['白饭', '躺着'],
    dislikes: ['被复读'],
    events: [{ at: 1791111290139, text: '被点名背圆周率', who: '群友乙' }],
    relations: [{ name: '群友乙', role: '群主', note: '老爱逗我' }],
    topics: ['打游戏'],
  };
  const s = renderMemory(m, cfg);
  check('含心情', s.includes('有点困'));
  check('含喜欢', s.includes('白饭'));
  check('含不喜欢', s.includes('被复读'));
  check('含经历和当事人', s.includes('背圆周率') && s.includes('群友乙'));
  check('含关系与身份', s.includes('群主') && s.includes('老爱逗我'));
  check('含话题', s.includes('打游戏'));
  check('有「不要念出来」这类约束（否则模型会像报菜名一样把记忆全抖出来）',
    s.includes('不要一条条念出来'));
  check('开头标明这是记忆块', s.startsWith('【你的记忆】'));
}

// ------------------------------------------------------------ 4. 打补丁
section('4) applyMemoryPatch：模型只能提建议，合并规则由本地说了算');
{
  const cfg = mkCfg();

  // 4.1 非对象补丁
  for (const bad of [null, undefined, 'x', 42, []]) {
    const r = applyMemoryPatch(emptyMemory(), bad, cfg);
    check(`补丁是 ${JSON.stringify(bad)} → 无变化且不抛`, r.changes.length === 0);
  }

  // 4.2 心情
  const r1 = applyMemoryPatch(emptyMemory(), { mood: { label: '开心', why: '被夸了' } }, cfg, 1000);
  check('心情被写入', r1.memory.mood.label === '开心' && r1.memory.mood.at === 1000);
  check('心情变更记了一条摘要', r1.changes.some((c) => c.includes('心情')));
  const r2 = applyMemoryPatch(r1.memory, { mood: { label: '开心', why: '被夸了' } }, cfg, 2000);
  check('心情没变 → 不记变更（否则日志每轮都刷"心情已更新"）', r2.changes.length === 0);

  // 4.3 经历：去重 + 上限丢最旧
  const r3 = applyMemoryPatch(emptyMemory(), {
    addEvents: [{ text: '被点名', who: '群友乙' }, { text: '被点名' }, { text: '' }, { text: '吃了白饭' }],
  }, cfg);
  check('同一件事不重复记', r3.memory.events.length === 2, JSON.stringify(r3.memory.events.map((e) => e.text)));
  const capCfg = mkCfg({ limits: { events: 2 } });
  const r4 = applyMemoryPatch(
    { events: [{ text: 'A' }, { text: 'B' }] }, { addEvents: [{ text: 'C' }] }, capCfg);
  check('经历超上限时丢最旧的', r4.memory.events.map((e) => e.text).join(',') === 'B,C',
    JSON.stringify(r4.memory.events.map((e) => e.text)));

  // 4.4 关系 upsert
  const r5 = applyMemoryPatch(emptyMemory(), {
    relations: [{ name: '群友乙', role: '群主', note: '老爱逗我' }],
  }, cfg, 3000);
  check('新关系被建立', r5.memory.relations.length === 1 && r5.memory.relations[0].name === '群友乙');
  const r6 = applyMemoryPatch(r5.memory, { relations: [{ name: '群友乙', note: '其实人挺好' }] }, cfg, 4000);
  check('同名关系是更新不是新增', r6.memory.relations.length === 1);
  check('更新时没给的字段保留原值（role 不该被清掉）',
    r6.memory.relations[0].role === '群主' && r6.memory.relations[0].note === '其实人挺好',
    JSON.stringify(r6.memory.relations[0]));
  const r7 = applyMemoryPatch(r5.memory, { relations: [{ name: '群友乙', role: '群主', note: '老爱逗我' }] }, cfg);
  check('关系完全没变 → 不记变更', r7.changes.length === 0);

  // 4.5 占位名：实测模型真的会这么干
  const r8 = applyMemoryPatch(emptyMemory(), {
    relations: [
      { name: '某人', note: '不知道是谁' },
      { name: '群友', note: 'x' },
      { name: '对方', note: 'y' },
      { name: '群友乙', note: '真实的人' },
    ],
  }, cfg);
  check('占位名「某人/群友/对方」一律不收（实测模型会建这种关系）',
    r8.memory.relations.length === 1 && r8.memory.relations[0].name === '群友乙',
    JSON.stringify(r8.memory.relations.map((r) => r.name)));

  // 4.6 话题太短是噪音
  const r9 = applyMemoryPatch(emptyMemory(), { addTopics: ['早', '哦', '打游戏'] }, cfg);
  check('一个字的话题被丢掉（「早」不是话题）',
    r9.memory.topics.join(',') === '打游戏', JSON.stringify(r9.memory.topics));

  // 4.7 追加去重 + 移除
  const r10 = applyMemoryPatch({ likes: ['白饭'] }, { addLikes: ['白饭', '躺着'] }, cfg);
  check('已有的喜欢不重复加', r10.memory.likes.join(',') === '白饭,躺着', JSON.stringify(r10.memory.likes));
  const r11 = applyMemoryPatch(r10.memory, { removeLikes: ['白饭'] }, cfg);
  check('removeLikes 真的能删掉', r11.memory.likes.join(',') === '躺着');
  const r12 = applyMemoryPatch(emptyMemory(), { addLikes: ['x'] }, cfg);
  // 4.9 机器人自己不是群友
  // 实测：QQ 里自己发的消息也带一行头部（含自己的名字），解析器曾把它当成
  // 别人的发送者行，于是记忆里多出一个叫「示例昵称」的群友，
  // 还把自己说过的话记成别人的经历。解析器修了，这里再加一道（记忆是永久的）。
  const cfgSelf = mkCfg();
  cfgSelf.trigger = { botNames: ['示例昵称', '小深'] };
  const r15 = applyMemoryPatch(emptyMemory(), {
    relations: [{ name: '示例昵称', note: '会@我' }, { name: '小深', note: 'x' }, { name: '群友乙', note: '真人' }],
  }, cfgSelf);
  check('机器人自己的名字不会被记成「群友」',
    r15.memory.relations.length === 1 && r15.memory.relations[0].name === '群友乙',
    JSON.stringify(r15.memory.relations.map((r) => r.name)));

  const r16 = applyMemoryPatch(emptyMemory(), {
    addEvents: [{ text: '复读我追问的话', who: '示例昵称' }, { text: '群友丙调侃我', who: '群友丙' }],
  }, cfgSelf);
  check('经历的「当事人」是机器人自己时被抹掉（不是"跟谁"）',
    r16.memory.events[0].who === '' && r16.memory.events[1].who === '群友丙',
    JSON.stringify(r16.memory.events.map((e) => [e.text, e.who])));

  check('没配 botNames 时不影响（不认识的都不拦）',
    applyMemoryPatch(emptyMemory(), { relations: [{ name: '示例昵称', note: 'x' }] }, mkCfg())
      .memory.relations.length === 1);

  // 4.8 名字像是被粘起来的 → 标记出来，但不删
  // 实测 UIA 会把相邻消息的发送者拼在一起（"群友丁示例群友搞完示例群友"）。
  // 记忆是按名字做键的，每个拼接变体都会变成一个新的"人"，把真人挤出上限。
  // 但不能靠长度一刀切删掉 —— 这个群里真有人叫 示例群友（15 字）。
  const longName = '群友丁示例群友搞完示例群友';
  const r13 = applyMemoryPatch(emptyMemory(), { relations: [{ name: longName, note: 'x' }] }, cfg);
  check('超长名字仍被收下（不误删真人）', r13.memory.relations.length === 1);
  check('但变更摘要里打了 (?) 标记，日志里看得见',
    r13.changes.some((c) => c.includes('(?)')), JSON.stringify(r13.changes));

  const realNick = '示例群友';            // 这个群里真实存在的昵称，15 字
  const r14 = applyMemoryPatch(emptyMemory(), { relations: [{ name: realNick, note: '真人' }] }, cfg);
  check('真实昵称 示例群友 被保留', r14.memory.relations[0].name === realNick);
  const shortName = applyMemoryPatch(emptyMemory(), { relations: [{ name: '群友乙', note: '群友' }] }, cfg);
  check('普通短名字不加标记', !shortName.changes.some((c) => c.includes('(?)')),
    JSON.stringify(shortName.changes));
}

// ------------------------------------------------------- 5. 读 / 写文件
section('5) 落盘：原子写、坏文件不许让机器人起不来');
{
  const cfg = mkCfg({ file: 'mem-a.json' });

  check('文件不存在 → 空记忆 + ok:false(missing)，不抛',
    (() => { const r = loadMemory(cfg, tmp); return r.ok === false && r.reason === 'missing' && r.memory.events.length === 0; })());

  // 写入
  const w = saveMemory(cfg, { mood: { label: '开心' }, likes: ['白饭'] }, tmp);
  check('写入成功', w.ok === true, w.error ?? '');
  check('写完没有留下 .tmp', !fs.existsSync(path.join(tmp, 'mem-a.json.tmp')));
  check('文件里带 $comment 说明（方便手工编辑）',
    fs.readFileSync(path.join(tmp, 'mem-a.json'), 'utf8').includes('$comment'));
  const back = loadMemory(cfg, tmp);
  check('读回来内容一致', back.ok && back.memory.mood.label === '开心' && back.memory.likes[0] === '白饭');
  check('写入时自动盖上 updatedAt', typeof back.memory.updatedAt === 'string' && back.memory.updatedAt.length > 0);

  // 坏 JSON
  const cfgB = mkCfg({ file: 'mem-b.json' });
  fs.writeFileSync(path.join(tmp, 'mem-b.json'), '{ 这不是 json', 'utf8');
  const bad = loadMemory(cfgB, tmp);
  check('文件是坏 JSON → 当成空记忆 + ok:false，不抛',
    bad.ok === false && String(bad.reason).startsWith('parse:') && bad.memory.events.length === 0,
    String(bad.reason));
  check('坏文件之后还能正常覆盖写入', saveMemory(cfgB, { likes: ['恢复'] }, tmp).ok === true);
  check('覆盖后能读回来', loadMemory(cfgB, tmp).memory.likes[0] === '恢复');

  // 带 BOM 的文件必须照读（**实测踩到**）
  //
  // Windows 记事本另存 UTF-8 默认带 BOM，而这些文件是鼓励用户手工改的
  //（"改完重启机器人"）。readJson 之前没去 BOM，于是带 BOM 的记忆文件
  // 会被判成 parse 失败 —— 控制台显示成"坏文件"、机器人当它不存在，
  // 但文件本身完全正常，用户根本不会想到是编码问题。
  const cfgBom = mkCfg({ file: 'mem-bom.json' });
  fs.writeFileSync(path.join(tmp, 'mem-bom.json'),
    '\uFEFF' + JSON.stringify({ likes: ['带 BOM 也要读得出来'], mood: { label: '好' } }), 'utf8');
  const bom = loadMemory(cfgBom, tmp);
  check('⚠ 带 BOM 的记忆文件照读（记事本另存就会带 BOM）',
    bom.ok === true && bom.memory.likes[0] === '带 BOM 也要读得出来',
    `${bom.ok} ${bom.reason ?? ''} ${JSON.stringify(bom.memory.likes)}`);
  check('带 BOM 也不会被当成"坏文件"', !String(bom.reason ?? '').startsWith('parse:'));
  const bomList = listConversations(mkCfg({ dir: '.' }), tmp).find((x) => x.file === 'mem-bom.json');
  check('列表里它是正常的一条，不是"读不出来"的那条', bomList && bomList.ok === true, JSON.stringify(bomList && bomList.reason));

  // 手工放一个超规格的记忆，读的时候要收敛
  const cfgC = mkCfg({ file: 'mem-c.json', limits: { events: 2 } });
  fs.writeFileSync(path.join(tmp, 'mem-c.json'), JSON.stringify({
    events: [{ text: '1' }, { text: '2' }, { text: '3' }, { text: '4' }],
    junk: 'should be dropped',
  }), 'utf8');
  const c = loadMemory(cfgC, tmp);
  check('读入时按上限收敛（不是等到写的时候才收）', c.memory.events.length === 2,
    JSON.stringify(c.memory.events.map((e) => e.text)));
  check('读入时丢掉未知字段', c.memory.junk === undefined);

  check('memoryFile 支持相对路径（相对项目根）',
    memoryFile(mkCfg({ file: 'x.json' }), 'C:\\proj').endsWith(path.join('proj', 'x.json')));
}

// ------------------------------------------------------------ 6. 节流
section('6) shouldUpdateMemory：节流要真的挡得住，也不能把自己锁死');
{
  check('enabled=false → 不更新', shouldUpdateMemory(mkCfg({ enabled: false }), {}).ok === false);

  // 按真实调用顺序模拟：**每次回复都先加计数，再问要不要整理**。
  // 这里正是第一版把节流写死的地方 —— 计数只在整理成功时才加，
  // 于是 updateEvery=3 前两次被挡下、n 永远是 1，永远等不到第 3 次。
  const every3 = mkCfg({ updateEvery: 3 });
  const st = { memoryReplyCount: 0 };
  const fired = [];
  for (let i = 1; i <= 6; i++) {
    st.memoryReplyCount++;                      // ← 契约：先加，再问
    if (shouldUpdateMemory(every3, st, 1000).ok) fired.push(st.memoryReplyCount);
  }
  check('updateEvery=3 在 6 次回复里正好触发 2 次（第 3、6 次）',
    fired.join(',') === '3,6', `触发于 ${fired.join(',') || '(一次都没触发)'}`);

  const every1 = mkCfg({ updateEvery: 1 });
  const st1 = { memoryReplyCount: 0 };
  const all = [];
  for (let i = 1; i <= 4; i++) {
    st1.memoryReplyCount++;
    if (shouldUpdateMemory(every1, st1, 1000).ok) all.push(i);
  }
  check('updateEvery=1（默认，需求原话「每次」）每次都触发', all.length === 4, all.join(','));

  const gap = mkCfg({ updateMinIntervalMs: 60000 });
  check('间隔不够 → 挡下', shouldUpdateMemory(gap, { memoryReplyCount: 1, memoryUpdatedAt: 1000 }, 2000).ok === false);
  check('间隔够了 → 放行', shouldUpdateMemory(gap, { memoryReplyCount: 2, memoryUpdatedAt: 1000 }, 61001).ok === true);
  check('从没更新过 → 第一次直接放行', shouldUpdateMemory(gap, { memoryReplyCount: 1 }, 999).ok === true);
  check('两个条件是「与」：every 满足了但间隔不够，仍然挡下',
    shouldUpdateMemory(mkCfg({ updateEvery: 1, updateMinIntervalMs: 60000 }),
      { memoryReplyCount: 1, memoryUpdatedAt: 59000 }, 60000).ok === false);
  check('挡下时 reason 会写明这是第几次（不然排查时看不出为什么没更新）',
    /第 \d+ 次/.test(shouldUpdateMemory(every3, { memoryReplyCount: 1 }, 1).reason),
    shouldUpdateMemory(every3, { memoryReplyCount: 1 }, 1).reason);

  // bot.js 必须遵守上面那条契约
  const botSrc = fs.readFileSync(path.join(ROOT, 'src', 'bot.js'), 'utf8');
  const iInc = botSrc.indexOf('state.memoryReplyCount = (Number(state.memoryReplyCount) || 0) + 1;');
  const iAsk = botSrc.indexOf('shouldUpdateMemory(cfg, state, Date.now())');
  check('bot.js 里「加计数」在「问 shouldUpdateMemory」之前', iInc > 0 && iAsk > iInc,
    `inc@${iInc} < ask@${iAsk}`);
  check('bot.js 里计数只加一次（加两次会让节流周期错位）',
    (botSrc.match(/memoryReplyCount = \(Number\(state\.memoryReplyCount\) \|\| 0\) \+ 1;/g) ?? []).length === 1,
    `${(botSrc.match(/memoryReplyCount = /g) ?? []).length} 处赋值`);
}

// ------------------------------------------------- 7. 提示词注入位置
section('7) buildMessages：记忆注入的位置不能砸掉提示词缓存');
{
  const cfg = mkCfg();
  const ctxBase = {
    text: '@示例昵称 说话', sender: '群友乙', mentioned: true,
    history: [{ side: 'incoming', sender: '群友丙', text: '来打' }],
  };

  const withMem = buildMessages(cfg, { ...ctxBase, memoryDigest: '【你的记忆】\n心情：困' });
  const without = buildMessages(cfg, ctxBase);

  check('不带记忆时，消息结构跟以前完全一样（不能回归）',
    JSON.stringify(without) === JSON.stringify(buildMessages(cfg, ctxBase)));

  const sysWith = withMem.find((m) => m.role === 'system').content;
  check('记忆**不在** system 里（放进去会每轮作废前缀缓存，实测差 50 倍价）',
    !sysWith.includes('【你的记忆】'));

  const users = withMem.filter((m) => m.role === 'user');
  check('仍然只有 1 条 user 消息（连续两条 user 语义含糊，踩过）', users.length === 1, `${users.length} 条`);
  check('记忆在那条 user 的开头', users[0].content.startsWith('【你的记忆】'));
  check('要回的那句话仍在 user 里', users[0].content.includes('@示例昵称 说话'));

  // 空记忆不许注入空块
  const empty = buildMessages(cfg, { ...ctxBase, memoryDigest: '' });
  check('memoryDigest 为空 → 不注入（不许塞「（暂无记忆）」白花 token）',
    JSON.stringify(empty) === JSON.stringify(without));

  // 历史为空时也要能注入
  const noHist = buildMessages(cfg, { text: '在吗', sender: '群友乙', memoryDigest: '【你的记忆】\n心情：困' });
  const nu = noHist.filter((m) => m.role === 'user');
  check('历史为空时也能注入，且仍只有 1 条 user',
    nu.length === 1 && nu[0].content.startsWith('【你的记忆】'), `${nu.length} 条`);
}

// ------------------------------------------------------- 8. JSON 解析
section('8) parseJsonLoose：整理器偶尔不听话也要能救回来');
{
  check('纯 JSON', parseJsonLoose('{"a":1}')?.a === 1);
  check('```json 围栏', parseJsonLoose('```json\n{"a":1}\n```')?.a === 1);
  check('无语言标记的围栏', parseJsonLoose('```\n{"a":1}\n```')?.a === 1);
  check('前后带寒暄', parseJsonLoose('好的，这是结果：{"a":1} 希望有帮助')?.a === 1);
  check('数组 → null（记忆必须是对象）', parseJsonLoose('[1,2]') === null);
  check('纯文本 → null', parseJsonLoose('我不知道') === null);
  check('空串 → null', parseJsonLoose('') === null);
  check('null → null', parseJsonLoose(null) === null);
  check('半个 JSON → null 而不是抛', parseJsonLoose('{"a":') === null);
}

// ------------------------------------------- 9. 真实配置 + 接线顺序
section('9) 真实 config.json 自检 + bot.js 接线顺序');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  check('config.json 有 memory 块', cfg.memory && typeof cfg.memory === 'object');
  check('memory.enabled 是布尔值', typeof cfg.memory?.enabled === 'boolean', String(cfg.memory?.enabled));
  check('memory.file 指向 memory.json', cfg.memory?.file === 'memory.json', String(cfg.memory?.file));
  // 用户明确要求"每 5 次回复整理一次"（本地模型做一次整理要 32 秒）。
  // 而 updateEvery 是那种"被顺手改回 1 也没人发现、只是变慢"的值，
  // 所以把它钉住。要改这个数就该同时改这条断言，改的人自然会看到这段注释。
  check('真实 config 的 updateEvery = 5（用户设定的节流）',
    cfg.memory?.updateEvery === 5, String(cfg.memory?.updateEvery));
  check('真实 config 的记忆预算够推理模型用（>=2000）',
    Number(cfg.memory?.maxTokens) >= 2000, String(cfg.memory?.maxTokens));
  check('updateEvery 是正整数', Number.isInteger(cfg.memory?.updateEvery) && cfg.memory.updateEvery >= 1,
    String(cfg.memory?.updateEvery));
  check('limits 全都在（少一个就会用默认值，但配置里看不出来）',
    ['events', 'relations', 'likes', 'dislikes', 'facts', 'topics', 'itemChars', 'digestChars']
      .every((k) => Number(cfg.memory?.limits?.[k]) > 0),
    JSON.stringify(cfg.memory?.limits));
  check('DEFAULT_LIMITS 和 config 里的键一致（防止两边漂移）',
    Object.keys(DEFAULT_LIMITS).every((k) => k in (cfg.memory?.limits ?? {})),
    Object.keys(DEFAULT_LIMITS).join(','));

  const src = fs.readFileSync(path.join(ROOT, 'src', 'bot.js'), 'utf8');

  // 顺序是硬要求：整理记忆必须在**发送之后**。
  // 放在发送前的话，每次回复都要多等一次 API 往返（实测 0.6~3 秒），
  // 群里看到的就是"它怎么半天不回"。
  const iSend = src.indexOf('const sendRes = await sendMessage(');
  // ⚠ 这里认的是调用本身，不是 "await updateMemoryAfterReply" ——
  //   本机实测一次整理要 64~100 秒，所以它已经改成**后台跑**（不再 await），
  //   否则那 100 秒里整个回复循环都停着、后面的 @ 消息只能干等。
  const iMem = src.indexOf('updateMemoryAfterReply(state');
  check('bot.js 里 updateMemoryAfterReply 在 sendMessage 之后', iSend > 0 && iMem > iSend,
    `send@${iSend} < mem@${iMem}`);
  check('整理记忆不再 await（后台跑，不堵住后面的回复）',
    !/await updateMemoryAfterReply\(/.test(src) && /Promise\.resolve\(\)[\s\S]{0,140}updateMemoryAfterReply/.test(src));
  check('后台跑有单飞保护（免得两边同时读-改-写同一份记忆）',
    src.includes('memoryRun.running') && src.includes('!memoryRun.running'));

  const iLoad = src.indexOf('loadStore(cfg, ROOT, conversation)');
  const iGen = src.indexOf('await generateReply(');
  check('bot.js 里读记忆在生成回复之前', iLoad > 0 && iGen > iLoad, `load@${iLoad} < gen@${iGen}`);
  check('记忆读取结果确实进了 ctx', src.includes('memoryDigest,'));
  check('读的是**当前会话**那一份（不能拿错会话名，否则会把别的会话的人和事读进来）',
    src.includes('loadStore(cfg, ROOT, conversation)') || src.includes('loadStore(cfg, ROOT,'),
    '');
  check('写记忆时也带上了会话名', /saveStore\(cfg, next, ROOT, conversation\)/.test(src));
  check('整理失败只记日志、不影响主循环',
    /catch\s*\(e\)\s*\{[\s\S]{0,200}?记忆整理异常/.test(src));

  // ---- 不许在"免费模式"里偷偷花钱 ----
  // 需求原话是「每次调用API时…修改一份 json 文件」。
  // 本地规则模式（非接管）本来就是为了不花钱，那种模式下还去调一次整理请求，
  // 等于在免费模式里计费。这个门必须挂在"这一轮真的调了 API"上。
  check('bot.js 里记忆整理被 calledApi 闸门挡住',
    /composed\.calledApi[\s\S]{0,200}?updateMemoryAfterReply/.test(src));
  check('composeReply 会把自己有没有调 API 报上来', src.includes('calledApi: apiCall.call'));
  check('config 里有 onlyWhenApiCalled 开关', cfg.memory?.onlyWhenApiCalled === true,
    String(cfg.memory?.onlyWhenApiCalled));
  check('onlyWhenApiCalled 带说明注释',
    Array.isArray(cfg.memory?.$comment_onlyWhenApiCalled) && cfg.memory.$comment_onlyWhenApiCalled.length > 0);
  check('闸门条件里给了 onlyWhenApiCalled=false 的逃生口（想改回去不用动代码）',
    src.includes('cfg.memory?.onlyWhenApiCalled === false'));
}

// ------------------------------------------- 11. 两层记忆：分文件 + 不串味
section('11) 两层记忆：总记忆 + 每个会话一份（用户要求）');
{
  const {
    emptyGlobal, emptyConversation, emptyStore, sanitizeStore, flattenStore,
    conversationSlug, conversationMemoryFile, globalMemoryFile,
    saveStore, loadStore, loadGlobal, loadConversation, listConversations,
    migrateLegacy, saveMemory,
  } = await import('../src/memory.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-two-'));
  const cfg = mkCfg({ file: 'memory.json', dir: 'memory' });
  cfg.trigger = { botNames: ['示例昵称'] };

  // ---- 形状 ----
  check('总记忆的形状（只有不分跟谁聊的东西）',
    JSON.stringify(Object.keys(emptyGlobal()).sort()) === JSON.stringify(['dislikes', 'facts', 'likes', 'updatedAt', 'version']),
    Object.keys(emptyGlobal()).join(','));
  const c0 = emptyConversation('某群');
  check('会话记忆的形状（心情/经历/关系/话题 + 会话名）',
    ['conversation', 'mood', 'events', 'relations', 'topics'].every((k) => k in c0),
    Object.keys(c0).join(','));

  // ---- 路径 ----
  check('总记忆在根目录', globalMemoryFile(cfg, dir).endsWith('memory.json'));
  check('会话记忆在 memory/ 子目录',
    conversationMemoryFile(cfg, dir, '某群').endsWith(path.join('memory', '某群.json')),
    path.relative(dir, conversationMemoryFile(cfg, dir, '某群')));
  check('会话名里的非法字符被换成 _',
    !/[\\/:*?"<>|]/.test(conversationSlug('a/b:c*d?e')), conversationSlug('a/b:c*d?e'));
  check('全是符号的会话名不会变成空文件名',
    conversationSlug('示例群友').length > 0 && !conversationSlug('示例群友').includes('/'),
    conversationSlug('示例群友'));
  check('不同会话名不会撞成同一个文件',
    conversationSlug('群A') !== conversationSlug('群B'));
  check('换过字符的名字带哈希后缀（保证唯一）',
    /-[a-z0-9]{4,}$/.test(conversationSlug('a/b')), conversationSlug('a/b'));

  // ---- 会话标识必须**稳定**（否则同一个群会被拆成好几份记忆）----
  // 实测踩到：同一个群的标题，不同时刻读出来是「示例群」和「示例群（10）」，
  // 于是记忆分文件之后凭空多出一份 —— 用户在控制台看到两份、关系分散在两处，
  // 正是"按会话分记忆"要解决的问题本身。
  const { conversationKey } = await import('../src/memory.js');
  check('去掉尾部的成员数后缀（全角）',
    conversationKey('示例群（10）') === '示例群', conversationKey('示例群（10）'));
  check('去掉尾部的成员数后缀（半角）',
    conversationKey('示例群(10)') === '示例群', conversationKey('示例群(10)'));
  check('成员数变了不影响标识',
    conversationKey('群（3）') === conversationKey('群（108）'), conversationKey('群（108）'));
  check('带成员数和不带成员数落**同一个文件**',
    conversationSlug('示例群') === conversationSlug('示例群（10）'),
    `${conversationSlug('示例群')} / ${conversationSlug('示例群（10）')}`);
  check('全角括号统一成半角（同一名字两种写法要归一）',
    conversationKey('带（括号）的名字') === conversationKey('带(括号)的名字'));
  check('名字本身别被改得认不出来（只在尾部去掉数字后缀）',
    conversationKey('示例群') === '示例群' && conversationKey('学习') === '学习');
  check('会话名里带「、」这种正常字符不受影响',
    conversationKey('示例群友、群友甲、示例昵称') === '示例群友、群友甲、示例昵称');
  check('读写的 conversation 字段存的是稳定标识',
    (() => {
      const c = emptyConversation('群（10）');
      return c.conversation === '群';
    })(), emptyConversation('群（10）').conversation);

  // ---- 读写：两个会话互不影响 ----
  const storeA = emptyStore('群A');
  storeA.global.facts = ['我喜欢白饭'];
  storeA.global.likes = ['打游戏'];
  storeA.conversation.mood = { label: '开心', why: '被夸了', at: 1 };
  storeA.conversation.relations = [{ name: '甲', role: '群友', note: '熟人', at: 1 }];
  storeA.conversation.events = [{ at: 1, text: '被夸了', who: '甲' }];
  storeA.conversation.topics = ['测试话题'];
  check('写两层', saveStore(cfg, storeA, dir, '群A').ok === true);

  const storeB = { conversation: emptyConversation('群B') };   // 故意不给 global
  storeB.conversation.mood = { label: '无聊', why: '没人说话', at: 2 };
  storeB.conversation.relations = [{ name: '乙', role: '群友', note: '另一个群的人', at: 2 }];
  check('写第二个会话时可以只给会话层', saveStore(cfg, storeB, dir, '群B').ok === true);

  // 这一条是**设计约束**：只给会话层时，总记忆不许被清空。
  // 踩过：saveStore 无脑写两层，于是传进来的空 global 把总记忆整个清掉了，
  // 而调用方只是"想更新某个会话的记忆"。
  check('只写会话层时，总记忆不受影响（不会被空对象清掉）',
    loadStore(cfg, dir, '群B').store.global.facts.includes('我喜欢白饭'),
    JSON.stringify(loadStore(cfg, dir, '群B').store.global.facts));

  const backA = loadStore(cfg, dir, '群A').store;
  const backB = loadStore(cfg, dir, '群B').store;
  check('会话A 的心情是自己的', backA.conversation.mood.label === '开心', backA.conversation.mood.label);
  check('会话B 的心情是自己的', backB.conversation.mood.label === '无聊', backB.conversation.mood.label);
  check('会话A 的关系里没有 B 的人',
    backA.conversation.relations.some((r) => r.name === '甲')
    && !backA.conversation.relations.some((r) => r.name === '乙'),
    JSON.stringify(backA.conversation.relations.map((r) => r.name)));
  check('会话B 的关系里没有 A 的人',
    !backB.conversation.relations.some((r) => r.name === '甲'),
    JSON.stringify(backB.conversation.relations.map((r) => r.name)));
  check('总记忆是共享的（两个会话都读到同一份事实）',
    backA.global.facts.includes('我喜欢白饭') && backB.global.facts.includes('我喜欢白饭'),
    JSON.stringify(backB.global.facts));

  // ---- 渲染：两层都进去，而且**标明是哪个会话** ----
  const digest = renderMemory(backA, cfg);
  check('渲染含总记忆（喜欢）', digest.includes('打游戏'));
  check('渲染含本会话的心情', digest.includes('开心'));
  check('渲染含本会话的人', digest.includes('甲'));
  check('渲染里点明了是哪个会话（模型才不会把别处的人和事搬过来）',
    digest.includes('群A'), '');
  const digestB = renderMemory(backB, cfg);
  check('B 的渲染里不出现 A 的人', !digestB.includes('甲'), '');
  check('B 的渲染里照样有共享的总记忆', digestB.includes('打游戏'));

  // ---- 只有一层为空时也能渲染 ----
  const onlyGlobal = { global: backA.global, conversation: emptyConversation('群C') };
  check('只有总记忆时也能渲染', renderMemory(onlyGlobal, cfg).includes('打游戏'));
  const onlyConv = { global: emptyGlobal(), conversation: backA.conversation };
  check('只有会话记忆时也能渲染', renderMemory(onlyConv, cfg).includes('开心'));
  check('两层都空 → 空串（不往提示词里塞废话）',
    renderMemory(emptyStore('群D'), cfg) === '');

  // ---- 列表 ----
  const list = listConversations(cfg, dir);
  check('能列出所有会话记忆', list.length === 2, JSON.stringify(list.map((x) => x.conversation)));
  check('列表里带会话名和条数',
    list.every((x) => x.conversation && x.counts), JSON.stringify(list[0]));

  // ---- 分层补丁：模型可以分别改两层 ----
  const r = applyMemoryPatch(backA, {
    global: { addLikes: ['躺着'] },
    conversation: { mood: { label: '得意', why: '被夸' }, addTopics: ['新话题'] },
  }, cfg);
  check('分层补丁：global 部分进总记忆', r.global.likes.includes('躺着'), JSON.stringify(r.global.likes));
  check('分层补丁：conversation 部分进会话记忆', r.conversation.mood.label === '得意');
  check('分层补丁：会话记忆没被总记忆的字段污染', r.conversation.likes === undefined);
  check('拍平视图兼顾两层（老调用方还能用）',
    r.memory.likes.includes('躺着') && r.memory.mood.label === '得意');

  // 只有一层变化时，别动另一层
  const r2 = applyMemoryPatch(r.store, { conversation: { addTopics: ['只动会话'] } }, cfg);
  check('只给 conversation 补丁时，总记忆不变', r2.global.likes.includes('躺着'));

  // ---- 旧扁平补丁照样认（模型偶尔会退回老格式） ----
  const r3 = applyMemoryPatch(emptyStore('群E'), {
    mood: { label: '平静', why: '随便聊聊' },
    addFacts: ['我是一个测试'], addLikes: ['测试'], relations: [{ name: '丙', note: 'x' }],
  }, cfg);
  check('旧扁平补丁：facts/likes 归总记忆',
    r3.global.facts.includes('我是一个测试') && r3.global.likes.includes('测试'),
    JSON.stringify(r3.global));
  check('旧扁平补丁：mood/relations 归会话记忆',
    r3.conversation.mood.label === '平静' && r3.conversation.relations.length === 1,
    JSON.stringify(r3.conversation.mood));

  // ---- 旧单文件迁移 ----
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-mig-'));
  const cfg2 = mkCfg({ file: 'memory.json', dir: 'memory' });
  cfg2.trigger = { botNames: ['示例昵称'] };
  // 造一份旧形状的单文件
  saveMemory(cfg2, {
    facts: ['我是示例昵称'], likes: ['白饭'],
    mood: { label: '困', why: '熬夜' },
    events: [{ text: '被点名', who: '甲' }],
    relations: [{ name: '甲', role: '群友', note: '熟人' }],
    topics: ['旧话题'],
  }, dir2);
  check('迁移前：memory/ 目录还不存在', !fs.existsSync(path.join(dir2, 'memory')));

  const mg = migrateLegacy(cfg2, dir2, '老群');
  check('迁移执行了', mg.migrated === true, mg.reason);
  check('迁移会先备份旧文件', Boolean(mg.backup) && fs.existsSync(mg.backup), String(mg.backup));
  check('迁移后 memory/ 里有那个会话的文件', Boolean(mg.conversationFile) && fs.existsSync(mg.conversationFile));

  const after = loadStore(cfg2, dir2, '老群').store;
  check('迁移：自我认知留在总记忆', after.global.facts.includes('我是示例昵称'), JSON.stringify(after.global.facts));
  check('迁移：喜好留在总记忆', after.global.likes.includes('白饭'));
  check('迁移：心情归到会话记忆', after.conversation.mood.label === '困');
  check('迁移：经历归到会话记忆', after.conversation.events.length === 1);
  check('迁移：关系归到会话记忆', after.conversation.relations[0]?.name === '甲');
  check('迁移：总记忆里不再有会话字段（真的分开了）',
    after.global.relations === undefined && after.global.mood === undefined);

  // 再迁一次应该什么都不做（已经分好了）
  const again = migrateLegacy(cfg2, dir2, '老群');
  check('已经分层的记忆不会被重复迁移', again.migrated === false, again.reason);

  // 没有旧文件时也不该动
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-fresh-'));
  const fresh = migrateLegacy(cfg2, dir3, '新群');
  check('没有旧文件时不迁移', fresh.migrated === false && fresh.reason === 'no-legacy', fresh.reason);

  for (const d of [dir, dir2, dir3]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log('\n' + '='.repeat(72));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(72));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);