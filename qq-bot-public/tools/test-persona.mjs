/**
 * test-persona.mjs — 人设（可切换的身份）：提示词 + 它过的人生 + 它自己的记忆。
 *
 * 用法：node tools/test-persona.mjs
 *
 * 需求原话：「可以切换人设提示词（相当于把人生模拟的人生切换改到人设身上），
 * 把人生模拟和记忆作为人设的子项，即根据不同的提示词切换不同的人生和记忆」。
 *
 * 这个测试盯着三件**错了会很难发现**的事：
 *
 *   1. **切换要立刻生效**。提示词放在 config.json 里是"启动读一次就缓存"的，
 *      放那儿等于"切一次人设要重启一次机器人"。所以这里专门造一个"不改 cfg 对象、
 *      只改 state"的用例 —— 它红了就说明有人把提示词又读回 config 去了。
 *   2. **记忆不能串**。两个人设必须落在两个目录里。串了的后果不是报错，
 *      而是"新身份记得旧身份的事" —— 用户看到的是角色扮演崩了，根本不会想到是路径。
 *   3. **删除不能连坐**。删人设 = 不想要这个说话方式了，不等于要把经历抹掉。
 *      记忆和人生必须留着（那不可逆）。
 *
 * ⚠ 全程不碰用户文件：人设目录/记忆目录都指向 os.tmpdir() 下的临时目录
 *   （也因此 tmp 在 C: 盘，rmSync 是真能删掉的；Z: 盘上它是静默无效的）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  personasDir, personaSlug, personaFile, activePersonaName,
  loadPersona, listPersonas, savePersona, copyPersona, deletePersona,
  seedFromConfig, planSwitch, promptSource,
} from '../src/persona.js';
import {
  activePersonaOf, personaMemoryDirOf, globalMemoryFile,
  conversationMemoryFile, seedPersonaMemory, isConversationFile, listConversations,
} from '../src/memory.js';
import { activeSystemPrompt } from '../src/takeover.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

console.log('='.repeat(72));
console.log('人设：提示词 + 人生 + 记忆');
console.log('='.repeat(72));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-test-'));
const CFG = { persona: { dir: 'personas' }, memory: { dir: 'memory', file: 'memory.json' } };

const wj = (p, o) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8');
};
const writeState = (root, obj) => wj(path.join(root, 'state.json'), obj);
const freshDir = (tag) => {
  const d = path.join(TMP, tag);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

// -------------------------------------------------- 1. 名字 → 文件名
section('1) 人设名 → 文件名（用户起的名字要认得出来，但不能跑出目录）');
{
  check('普通中文名原样保留', personaSlug('小深') === '小深');
  check('斜杠换成下划线（否则会跑到别的目录去）', personaSlug('a/b') === 'a_b', personaSlug('a/b'));
  check('反斜杠也是', personaSlug('a\\b') === 'a_b');
  check('Windows 文件名不允许的字符全换掉',
    personaSlug('a:b*c?d"e<f>g|h') === 'a_b_c_d_e_f_g_h', personaSlug('a:b*c?d"e<f>g|h'));
  check('开头的点去掉（别变成隐藏文件/上级目录）', personaSlug('...隐藏') === '隐藏', personaSlug('...隐藏'));
  check('前后空白去掉', personaSlug('  小深  ') === '小深');
  check('空名字 → 空串（调用方要靠它拦住）', personaSlug('') === '' && personaSlug(null) === '');
  check('太长会截断（文件名有上限）', personaSlug('x'.repeat(100)).length === 40);
  check('不会因为截断产生空名字', personaSlug('.'.repeat(50)) === '');
  check('personaFile 落在 personas 目录里',
    personaFile(CFG, TMP, '小深') === path.join(TMP, 'personas', '小深.json'),
    personaFile(CFG, TMP, '小深'));
  const absDir = path.join(TMP, 'abs-personas');
  check('配置里写绝对路径就用绝对路径（给测试/多开用）',
    personasDir({ persona: { dir: absDir } }, TMP) === absDir);
  check('没配就用默认 personas', personasDir({}, TMP) === path.join(TMP, 'personas'));
}

// -------------------------------------------------- 2. 存一份 / 读回来
section('2) 存一份、读回来（提示词能写成数组也能写成字符串）');
{
  const r1 = savePersona(CFG, TMP, '小深', { systemPrompt: ['你是小深', '说话短一点'] });
  check('新建成功', r1.ok === true, r1.error ?? '');
  const p1 = loadPersona(CFG, TMP, '小深');
  check('读回来名字对', p1 && p1.name === '小深');
  check('读回来两行提示词都在', p1 && p1.systemPrompt.length === 2 && p1.systemPrompt[0] === '你是小深');
  check('没给 life 就用自己的名字当人生名（一人一生，最直观）', p1 && p1.life === '小深', p1?.life);
  const rawText = fs.readFileSync(personaFile(CFG, TMP, '小深'), 'utf8');
  check('文件里写了 $comment（用户直接打开也知道每个字段是干嘛的）', rawText.includes('$comment'));
  check('文件里带了时间戳', rawText.includes('createdAt') && rawText.includes('updatedAt'));

  savePersona(CFG, TMP, '乙', { systemPrompt: '第一行\n第二行\r\n第三行' });
  const p2 = loadPersona(CFG, TMP, '乙');
  check('字符串提示词自动按行切开（\n 和 \r\n 都算）',
    p2.systemPrompt.length === 3, JSON.stringify(p2.systemPrompt));

  savePersona(CFG, TMP, '丙', { systemPrompt: ['1'], life: '丁' });
  check('给定了 life 就用给定的', loadPersona(CFG, TMP, '丙').life === '丁');
  savePersona(CFG, TMP, '丙', { systemPrompt: ['2'] });
  const p3 = loadPersona(CFG, TMP, '丙');
  check('再存一次不传 life，原来的 life 留着（别把人生弄丢）', p3.life === '丁', p3.life);
  check('提示词确实被换掉了', p3.systemPrompt.join() === '2', p3.systemPrompt.join());
  const a = savePersona(CFG, TMP, '戊', { systemPrompt: ['x'] }).persona;
  const b = savePersona(CFG, TMP, '戊', { systemPrompt: ['y'] }).persona;
  check('更新之后 createdAt 保持、updatedAt 变了',
    a.createdAt === b.createdAt && a.updatedAt !== null, `${a.createdAt} / ${b.updatedAt}`);

  check('没给名字 → 明确报错，不静默', savePersona(CFG, TMP, '  ', {}).ok === false);
  check('读不存在的人设 → null（不是抛异常）', loadPersona(CFG, TMP, '查无此人') === null);
  check('名字为空时读 → null', loadPersona(CFG, TMP, '') === null);

  wj(personaFile(CFG, TMP, '坏'), { name: '坏' });
  fs.writeFileSync(personaFile(CFG, TMP, '坏'), '{ 这不是 json', 'utf8');
  check('坏文件读 → null（人设坏了不该让机器人起不来）', loadPersona(CFG, TMP, '坏') === null);
  check('坏文件还能被覆盖着修好', savePersona(CFG, TMP, '坏', { systemPrompt: ['修好了'] }).ok === true);
  check('修好之后能读', loadPersona(CFG, TMP, '坏').systemPrompt[0] === '修好了');
}

// -------------------------------------------------- 3. 列出来
section('3) 列出来（控制台的下拉框靠它）');
{
  const empty = freshDir('list-empty');
  check('目录不存在 → 空数组（"还没用过多身份"是正常状态，不是错误）',
    Array.isArray(listPersonas(CFG, empty)) && listPersonas(CFG, empty).length === 0);

  const d = freshDir('list');
  savePersona(CFG, d, '张三', { systemPrompt: ['a', 'b'] });
  savePersona(CFG, d, '李四', { systemPrompt: ['c'] });
  fs.writeFileSync(path.join(d, 'personas', 'not-json.json'), '{ 坏', 'utf8');
  fs.writeFileSync(path.join(d, 'personas', 'readme.txt'), '我不是人设', 'utf8');
  const list = listPersonas(CFG, d);
  const names = list.map((x) => x.name);
  check('只列 json 人设，坏文件和非 json 不进来',
    !names.includes('not-json') && !names.includes('readme'), JSON.stringify(names));
  check('两份人设都在', names.includes('张三') && names.includes('李四'), JSON.stringify(names));
  check('顺序稳定（按名字排，中文按拼音）',
    JSON.stringify(names) === JSON.stringify([...names].sort((x, y) => x.localeCompare(y, 'zh'))), JSON.stringify(names));
  check('带着提示词行数（界面上能显示"这份有几行"）',
    list.find((x) => x.name === '张三').lines === 2);
}

// -------------------------------------------------- 4. 复制一份
section('4) 复制一份当起点（"克隆当前这份身份"）');
{
  const d = freshDir('copy');
  savePersona(CFG, d, '原版', { systemPrompt: ['你是原版'], life: '示例人生' });
  const c = copyPersona(CFG, d, '原版', '副本');
  check('复制成功', c.ok === true, c.error ?? '');
  const copy = loadPersona(CFG, d, '副本');
  check('提示词抄过来了', copy.systemPrompt.join() === '你是原版');
  check('人生也抄过来了', copy.life === '示例人生', copy.life);
  savePersona(CFG, d, '副本', { systemPrompt: ['改过了'] });
  check('改副本不影响原版（是复制不是同一个文件）',
    loadPersona(CFG, d, '原版').systemPrompt.join() === '你是原版');
  check('复制不存在的人设 → 明确报错',
    copyPersona(CFG, d, '查无此人', 'x').ok === false &&
    String(copyPersona(CFG, d, '查无此人', 'x').error).includes('找不到'));
}

// -------------------------------------------------- 5. 删除
section('5) 删除：只删"怎么说话"，不删"发生过什么"');
{
  const d = freshDir('del');
  savePersona(CFG, d, '旧身份', { systemPrompt: ['你是旧身份'] });
  const memDir = path.join(d, 'memory', '旧身份');
  wj(path.join(memDir, '_global.json'), { facts: ['我记得'] });
  wj(path.join(memDir, '测试群.json'), { conversation: '测试群' });
  const lifeFile = path.join(d, 'lives', '旧身份.json');
  wj(lifeFile, { note: '这段日子' });

  check('删除返回成功', deletePersona(CFG, d, '旧身份').ok === true);
  check('人设文件没了', loadPersona(CFG, d, '旧身份') === null);
  check('⚠ 它的记忆留着（删说话方式 ≠ 抹掉经历）', fs.existsSync(path.join(memDir, '_global.json')));
  check('⚠ 它的人生日志也留着', fs.existsSync(lifeFile));
  check('再删一次 → 明确说"不存在"',
    deletePersona(CFG, d, '旧身份').ok === false &&
    String(deletePersona(CFG, d, '旧身份').error).includes('不存在'));
}

// -------------------------------------------------- 6. 从 config 搬一份
section('6) 第一次用人设：把 config.json 里那份提示词搬过来');
{
  const d1 = freshDir('seed-empty');
  const noPrompt = { persona: { dir: 'personas', systemPrompt: [] } };
  const r1 = seedFromConfig(noPrompt, d1);
  check('config 里也没有提示词 → 明确说"没什么可搬的"（不是静默建个空的）',
    r1.ok === false && String(r1.error).includes('config.json'), r1.error);

  const d2 = freshDir('seed');
  const withPrompt = { persona: { dir: 'personas', systemPrompt: ['第一行', '第二行'] } };
  const r2 = seedFromConfig(withPrompt, d2);
  check('搬成功', r2.ok === true && r2.seeded === true, r2.error ?? '');
  check('默认名字叫「默认」', r2.name === '默认', r2.name);
  const seeded = loadPersona(withPrompt, d2, '默认');
  check('提示词完整搬过来了', seeded.systemPrompt.length === 2 && seeded.systemPrompt[1] === '第二行');
  check('文件里注明了来源（用户以后看到不会以为是凭空冒出来的）',
    fs.readFileSync(personaFile(withPrompt, d2, '默认'), 'utf8').includes('config.json'));

  savePersona(withPrompt, d2, '默认', { systemPrompt: ['我改过了'] });
  const r3 = seedFromConfig(withPrompt, d2);
  check('已经有人的时候不再搬（already）', r3.already === true);
  check('而且不会覆盖用户改过的内容', loadPersona(withPrompt, d2, '默认').systemPrompt.join() === '我改过了');

  const d3 = freshDir('seed-name');
  const r4 = seedFromConfig(withPrompt, d3, { name: '示例人生', life: '示例人生' });
  check('可以指定名字（一般取当前的人生名，一人设一人生）', r4.name === '示例人生' && r4.seeded === true);
  check('人生也跟着指过去了', loadPersona(withPrompt, d3, '示例人生').life === '示例人生');
}

// -------------------------------------------------- 7. 切换计划
section('7) 切人设要一起改的东西（少改一处就会"新身份过旧日子"）');
{
  const d = freshDir('switch');
  check('切不存在的人设 → 拦下来',
    planSwitch(CFG, d, '查无此人').ok === false);
  savePersona(CFG, d, '空壳', { systemPrompt: [] });
  const empty = planSwitch(CFG, d, '空壳');
  check('⚠ 空提示词的人设不许切过去（空提示词会让 API 报错 → 静默降级成本地规则）',
    empty.ok === false && String(empty.error).includes('空'), empty.error);
  savePersona(CFG, d, '小深', { systemPrompt: ['你是小深'], life: '示例人生' });
  const ok = planSwitch(CFG, d, '小深');
  check('正常切换有 patch', ok.ok === true && !!ok.patch, ok.error ?? '');
  check('patch 里有 personaProfile', ok.patch.personaProfile === '小深');
  check('patch 里同时带上 lifeProfile（人生跟着人设走）', ok.patch.lifeProfile === '示例人生', ok.patch.lifeProfile);
  check('patch 只有这两个键（state.json 不该被塞别的东西）',
    JSON.stringify(Object.keys(ok.patch).sort()) === '["lifeProfile","personaProfile"]',
    JSON.stringify(Object.keys(ok.patch)));

  wj(personaFile(CFG, d, '没人生'), { name: '没人生', systemPrompt: ['你是没人生'] });
  check('人设没写 life 时，人生名落到它自己的名字上',
    planSwitch(CFG, d, '没人生').patch.lifeProfile === '没人生');
}

// -------------------------------------------------- 8. 提示词现在是从哪来的
section('8) 提示词是从人设文件来的、还是从 config 来的（界面上要讲清楚）');
{
  const d = freshDir('source');
  const cfg = { persona: { dir: 'personas', systemPrompt: ['配置里的第一行', '配置里的第二行'] } };
  const a = promptSource(cfg, d, { personaProfile: '' });
  check('没切人设 → 说清是 config 来的', a.from === 'config' && a.path === null, JSON.stringify(a));
  check('行数是 config 那份的', a.lines === 2, String(a.lines));
  savePersona(cfg, d, '小深', { systemPrompt: ['你是小深'] });
  const b = promptSource(cfg, d, { personaProfile: '小深' });
  check('切了人设 → 说清是人设来的', b.from === 'persona' && b.name === '小深', JSON.stringify(b));
  check('并且给出文件路径（用户可以直接去改）', typeof b.path === 'string' && b.path.endsWith('小深.json'));
  const c = promptSource(cfg, d, { personaProfile: '人设被删了' });
  check('人设文件找不到了 → 老实说回落到 config（不炸、不假装有人设）',
    c.from === 'config', JSON.stringify(c));
}

// -------------------------------------------------- 9. 立刻生效（最关键的一条）
section('9) 换人设不用重启机器人（提示词现读文件，不读启动时缓存的 config）');
{
  // ⚠ 这里必须用**绝对路径**的 personas 目录：activeSystemPrompt 内部用的是项目根，
  //   而测试要把它指到临时目录去（不能去动用户真正的 personas/）。
  const absDir = path.join(TMP, 'live-personas');
  const cfg = {
    persona: { dir: absDir, enabled: true, systemPrompt: ['配置里的老提示词'] },
    llm: { systemPrompt: '不接管时的通用那句' },
  };
  savePersona(cfg, TMP, '甲', { systemPrompt: ['你是甲'] });
  savePersona(cfg, TMP, '乙', { systemPrompt: ['你是乙'] });

  check('没切人设时行为不变：还是 config 里那句（老用户升级上来不该有变化）',
    activeSystemPrompt({ personaProfile: '', takeoverEnabled: true }, cfg) === '配置里的老提示词');
  check('切到「甲」→ 用甲的提示词（不再是 config 那句）',
    activeSystemPrompt({ personaProfile: '甲', takeoverEnabled: true }, cfg) === '你是甲');
  check('⚠ 同一个 cfg 对象、只改 state 就能换掉结果 —— 这就是"点了立刻生效"',
    activeSystemPrompt({ personaProfile: '乙', takeoverEnabled: true }, cfg) === '你是乙');
  check('切回「甲」又变回来（不是单向的）',
    activeSystemPrompt({ personaProfile: '甲', takeoverEnabled: true }, cfg) === '你是甲');
  check('人设文件被删了 → 退回 config 那句，不抛异常',
    activeSystemPrompt({ personaProfile: '查无此人', takeoverEnabled: true }, cfg) === '配置里的老提示词');

  savePersona(cfg, TMP, '空壳', { systemPrompt: [] });
  check('人设提示词是空的 → 退回 config（空提示词不能真发出去）',
    activeSystemPrompt({ personaProfile: '空壳', takeoverEnabled: true }, cfg) === '配置里的老提示词');

  check('非接管模式：还是 llm.systemPrompt 优先（老取舍不变）',
    activeSystemPrompt({ personaProfile: '甲', takeoverEnabled: false }, cfg) === '不接管时的通用那句');
  const cfgNoLlm = { persona: { dir: absDir, enabled: true, systemPrompt: ['配置里的老提示词'] }, llm: { systemPrompt: '' } };
  check('非接管 + 没有通用提示词 → 用当前人设那份',
    activeSystemPrompt({ personaProfile: '甲', takeoverEnabled: false }, cfgNoLlm) === '你是甲');
  const cfgBare = { persona: { dir: absDir }, llm: {} };
  check('什么都没有 → 空串（调用方靠它决定不接管）',
    activeSystemPrompt({ personaProfile: '', takeoverEnabled: true }, cfgBare) === '');
  check('activePersonaName 只认 state（config 里没有这个字段）',
    activePersonaName(cfg, { personaProfile: ' 甲 ' }) === '甲' && activePersonaName(cfg, {}) === '');
}

// -------------------------------------------------- 10. 记忆按人设分开
section('10) 记忆按人设分开（串了的后果是"新身份记得旧身份的事"）');
{
  const d = freshDir('mem');
  writeState(d, { personaProfile: '' });
  check('没切人设 → 还是老路径 memory.json（老用户的文件结构原样不动）',
    globalMemoryFile(CFG, d) === path.join(d, 'memory.json'), globalMemoryFile(CFG, d));
  check('没切人设 → 会话记忆在 memory/ 根那层',
    conversationMemoryFile(CFG, d, '测试群') === path.join(d, 'memory', '测试群.json'));

  writeState(d, { personaProfile: '小深' });
  check('activePersonaOf 读的是 state.json 里的 personaProfile', activePersonaOf(d) === '小深');
  check('切了人设 → 总记忆收进 memory/<人设>/_global.json',
    globalMemoryFile(CFG, d) === path.join(d, 'memory', '小深', '_global.json'), globalMemoryFile(CFG, d));
  check('会话记忆也在人设目录里',
    conversationMemoryFile(CFG, d, '测试群') === path.join(d, 'memory', '小深', '测试群.json'));
  check('没人设时 personaMemoryDirOf 就是根那层',
    personaMemoryDirOf(CFG, d, '') === path.join(d, 'memory'));

  writeState(d, { personaProfile: '小深二号' });
  check('⚠ 换个人设 → 另一个文件（两个人的记忆不会互相污染）',
    globalMemoryFile(CFG, d) !== path.join(d, 'memory', '小深', '_global.json') &&
    globalMemoryFile(CFG, d) === path.join(d, 'memory', '小深二号', '_global.json'));
  check('state.json 读不到/坏了 → 当"没人设"处理，不抛',
    activePersonaOf(path.join(d, '没有这个目录')) === '');
  fs.writeFileSync(path.join(d, 'state.json'), '{ 坏', 'utf8');
  check('state.json 是坏 JSON 也不抛（记忆照旧能存）', activePersonaOf(d) === '');

  // 带 BOM 的 state.json 必须照读（**实测踩到**）
  //
  // 记事本另存 UTF-8 默认带 BOM，而 state.json 是用户会手工改的文件
  //（改回复范围、看队列）。带 BOM 时解析失败会**静默退回"没有人设"** ——
  // 记忆于是写去老位置，表面上什么都没报错，人设那份记忆却是空的。
  writeState(d, { personaProfile: '小深' });
  fs.writeFileSync(path.join(d, 'state.json'),
    '\uFEFF' + fs.readFileSync(path.join(d, 'state.json'), 'utf8'), 'utf8');
  check('⚠ 带 BOM 的 state.json 仍认得出当前人设',
    activePersonaOf(d) === '小深', JSON.stringify(activePersonaOf(d)));
  check('⚠ 记忆路径也跟着走人设目录（不会偷偷退回老位置）',
    globalMemoryFile(CFG, d) === path.join(d, 'memory', '小深', '_global.json'),
    globalMemoryFile(CFG, d));

  // 列会话：不能列出别人设的，也不能把 _global 当成一个"会话"
  const d2 = freshDir('mem-list');
  writeState(d2, { personaProfile: '小深' });
  wj(path.join(d2, 'memory', '根那层的老会话.json'), { conversation: '根那层的老会话' });
  wj(path.join(d2, 'memory', '小深', '_global.json'), { facts: ['我是小深'] });
  wj(path.join(d2, 'memory', '小深', '群A.json'), { conversation: '群A' });
  const l1 = listConversations(CFG, d2);
  const names1 = l1.map((x) => x.conversation);
  check('列出当前人设的会话', names1.includes('群A'), JSON.stringify(names1));
  check('⚠ 不把 _global.json 当成一个会话列出来', !names1.includes('_global'), JSON.stringify(names1));
  check('不列根那层（别人设的）会话', !names1.includes('根那层的老会话'), JSON.stringify(names1));
  writeState(d2, { personaProfile: '' });
  const names2 = listConversations(CFG, d2).map((x) => x.conversation);
  check('切回"没人设"就列根那层', names2.includes('根那层的老会话') && !names2.includes('群A'), JSON.stringify(names2));
  check('_global.json 始终不算一个会话',
    isConversationFile('_global.json') === false && isConversationFile('_GLOBAL.JSON') === false);
  check('.tmp 不算', isConversationFile('群A.json.tmp') === false);
  check('普通会话文件算', isConversationFile('群A.json') === true);
  check('非 json 不算', isConversationFile('readme.txt') === false);
}

// -------------------------------------------------- 11. 老记忆乔迁
section('11) 第一次启用多身份：把老记忆**拷**进第一个人设（拷，不是搬）');
{
  const d = freshDir('seed-mem');
  wj(path.join(d, 'memory.json'), { facts: ['老总记忆'] });
  wj(path.join(d, 'memory', '群A.json'), { conversation: '群A' });
  wj(path.join(d, 'memory', '群B.json'), { conversation: '群B' });
  wj(path.join(d, 'memory', '已有人设', '_global.json'), { facts: ['别人设的，不该被拷'] });

  const r = seedPersonaMemory(CFG, d, '小深');
  check('拷了', r.copied.length > 0, JSON.stringify(r.copied));
  check('老的总记忆变成了人设的总记忆（_global.json）', r.copied.includes('_global.json'));
  check('老会话都拷过来了', r.copied.includes('群A.json') && r.copied.includes('群B.json'));
  check('⚠ 不把别人设的目录整个拷过来', !r.copied.includes('已有人设'), JSON.stringify(r.copied));
  const target = path.join(d, 'memory', '小深');
  check('目标目录里真的有这些文件',
    fs.existsSync(path.join(target, '_global.json')) && fs.existsSync(path.join(target, '群A.json')));
  check('内容一致', JSON.parse(fs.readFileSync(path.join(target, '群A.json'), 'utf8')).conversation === '群A');
  check('⚠ 老文件原样留着（是拷不是搬 —— 搬错了就是不可逆的丢数据）',
    fs.existsSync(path.join(d, 'memory.json')) && fs.existsSync(path.join(d, 'memory', '群A.json')));

  fs.writeFileSync(path.join(target, '群A.json'), '{"conversation":"新记忆"}', 'utf8');
  const r2 = seedPersonaMemory(CFG, d, '小深');
  check('幂等：目标目录里已经有东西就不再拷', r2.skipped === true && r2.copied.length === 0);
  check('⚠ 而且没有把已经长出来的新记忆覆盖成旧副本',
    JSON.parse(fs.readFileSync(path.join(target, '群A.json'), 'utf8')).conversation === '新记忆');

  const r3 = seedPersonaMemory(CFG, d, '小深二号', { from: 'persona:小深' });
  check('可以从另一个人设那儿拷（克隆身份：接着同一段经历走）', r3.copied.length === 3, JSON.stringify(r3.copied));
  check('拷过来内容一样',
    JSON.parse(fs.readFileSync(path.join(d, 'memory', '小深二号', '群A.json'), 'utf8')).conversation === '新记忆');
  const r4 = seedPersonaMemory(CFG, d, '小深三号', { from: 'persona:查无此人' });
  check('源那边没有记忆 → 拷 0 个，不报错也不抛', r4.copied.length === 0 && !r4.error);
  check('没给人设名 → 什么都不做', seedPersonaMemory(CFG, d, '').skipped === true);

  const d2 = freshDir('seed-mem-empty');
  check('老位置什么都没有 → 拷 0 个、不报错', seedPersonaMemory(CFG, d2, '新身份').copied.length === 0);
  check('也不会凭空建出一个空目录出来报错', !fs.existsSync(path.join(d2, 'memory', '新身份')));
}

// -------------------------------------------------- 收尾
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* C: 盘上删不掉就算了 */ }

console.log('\n' + '='.repeat(72));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(72));
process.exit(fail > 0 ? 1 : 0);
