/**
 * test-life.mjs — 人生模拟（生活日志）的测试。
 *
 * 用户的需求原话：
 *   「每5次控制台检测后，如果此时API没有被调用，使用该API进行人生模拟，
 *     即通过给定的提示词以及设定推测真人行为，并记成日志保存」
 *
 * 所以这里盯的是四条：
 *   1. 节拍对不对（每 5 次检测、期间没调用 API 才动）
 *   2. 送给模型的「提示词 + 设定」到底有没有进去
 *   3. 记成日志了没有、有没有上限、脏数据会不会崩
 *   4. 有没有偷偷写别人的文件、有没有偷偷发消息
 *
 * ⚠ 测试规矩（踩过多次）：不依赖用户当前的配置，自己钉住前提。
 *   需要 config 的地方一律现造一份，读真实 config.json 只用来断言"字段在不在"。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  lifeConfig, lifeFile, emptyLifeLog, sanitizeLifeEntry, sanitizeLifeLog,
  loadLifeLog, saveLifeLog, appendLifeEntry, renderLife, lifeDigestFor, createLifeTicker,
  decideShare, recordShare, countSharesToday, shareAllowedIn, updateLifeEntry, DEFAULT_SHARE,
  livesDir, listLives, createLifeProfile, activeProfile, lifeEnabled, shareEnabled,
  nextLifeClock, lifeClockGate, DEFAULT_LIFE_CLOCK,
} from '../src/life.js';
import {
  buildLifeMessages, generateLifeSimulation, apiCallStats, DEFAULT_LIFE_PROMPT, chatOnce,
} from '../src/llm.js';
import { loadConfig } from '../src/config.js';
import { configLooksConfigured, skipNote } from './testkit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`); }
}

// 「真实 config」开头的那些断言，验的是**用户这份配置配对了没有**
// （超时是不是 0、时钟开没开、人生模拟有没有打开）。它们在开发机上有意义
// （改完配置忘了生效就会被抓到），但在刚导出的副本上必然是红的 ——
// 那份配置还没配。所以配没配好先问一句，没配就 [SKIP]。
//
// 为什么用 loadConfig 而不是裸 JSON.parse：真实 config 里有些值要过一遍
// config.js 的归一化才算数（比如 apiKey 从 .env 解析进来），裸读会失真。
const REAL_READY = configLooksConfigured(loadConfig({ argv: [] }));
const checkReal = (name, cond, detail = '') => {
  if (!REAL_READY) { skipNote(name); return; }
  check(name, cond, detail);
};
function section(t) { console.log(`\n${t}`); }

/** 每个用例一个干净的临时目录，免得上一个用例的日志影响下一个。 */
function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-life-'));
}

console.log('='.repeat(72));
console.log('人生模拟 / 生活日志');
console.log('='.repeat(72));

// ------------------------------------------------------------------ 配置 ----
section('配置（lifeConfig）');
{
  const d = lifeConfig({});
  check('缺省 everyChecks = 5（用户要求）', d.everyChecks === 5, String(d.everyChecks));
  check('缺省是关的（要显式打开才会调 API）', d.enabled === false);
  check('缺省文件名 life.json', d.file === 'life.json');
  check('缺省 minIntervalMs = 0（不额外限流）', d.minIntervalMs === 0);
  check('缺省 jsonMode = false（本地推理模型不支持语法约束）', lifeConfig({ life: {} }).limits.maxEntries === 200);

  const c = lifeConfig({ life: { enabled: true, everyChecks: 12, minIntervalMs: 60000, model: 'small', limits: { maxEntries: 7, contextEntries: 2 } } });
  check('everyChecks 可配', c.everyChecks === 12);
  check('enabled 可配', c.enabled === true);
  check('minIntervalMs 可配', c.minIntervalMs === 60000);
  check('model 可配', c.model === 'small');
  check('limits 可配', c.limits.maxEntries === 7 && c.limits.contextEntries === 2);
  check('没配的 limits 保留默认值', c.limits.digestChars === 400);

  // 脏配置不许崩，也不许把 everyChecks 变成 0（那会每轮都模拟）
  check('everyChecks=0 回落到 5', lifeConfig({ life: { everyChecks: 0 } }).everyChecks === 5);
  check('everyChecks="abc" 回落到 5', lifeConfig({ life: { everyChecks: 'abc' } }).everyChecks === 5);
  check('everyChecks=1 合法（每轮都试）', lifeConfig({ life: { everyChecks: 1 } }).everyChecks === 1);
  check('life 整块缺失也不崩', lifeConfig(undefined).everyChecks === 5);
}

// ------------------------------------------------------------------ 文件 ----
section('生活日志的读写');
{
  const cfg = { life: { enabled: true, file: 'life.json' } };
  const root = tmpRoot();

  const f = lifeFile(cfg, root);
  check('路径落在项目根下', f === path.join(root, 'life.json'), f);

  const missing = loadLifeLog(cfg, root);
  check('文件不存在时返回空日志且 ok=false', missing.ok === false && missing.log.entries.length === 0);

  const a = appendLifeEntry(cfg, root, { mood: '好奇', doing: '翻群里的旧消息', thinking: '这人怎么这么能说' }, 1000);
  check('追加一条成功', a.ok === true && a.total === 1, JSON.stringify(a.entry));
  const b = appendLifeEntry(cfg, root, { mood: '困', doing: '躺着刷手机' }, 2000);
  check('再追加一条，总数变 2', b.ok === true && b.total === 2);

  const back = loadLifeLog(cfg, root);
  check('读回来是 2 条', back.ok === true && back.log.entries.length === 2);
  check('顺序是旧的在前', back.log.entries[0].doing === '翻群里的旧消息' && back.log.entries[1].doing === '躺着刷手机');
  check('落盘带 $comment（用户手改时看得懂）',
    JSON.parse(fs.readFileSync(f, 'utf8')).$comment !== undefined);
  check('没有留下 .tmp 残file', !fs.existsSync(`${f}.tmp`));

  // 上限：超出丢最旧的
  const small = { life: { enabled: true, file: 'cap.json', limits: { maxEntries: 3 } } };
  for (let i = 1; i <= 6; i++) appendLifeEntry(small, root, { doing: `第${i}件事` }, i * 1000);
  const capped = loadLifeLog(small, root);
  check('超过 maxEntries 时丢最旧的', capped.log.entries.length === 3, String(capped.log.entries.length));
  check('留下的是最新的 3 条',
    capped.log.entries.map((e) => e.doing).join(',') === '第4件事,第5件事,第6件事',
    capped.log.entries.map((e) => e.doing).join(','));

  // 手工把文件改坏：不许崩，按空日志处理
  fs.writeFileSync(path.join(root, 'life.json'), '{ 这不是 JSON', 'utf8');
  const broken = loadLifeLog(cfg, root);
  check('文件被改坏时不抛异常，按空日志处理', broken.ok === false && broken.log.entries.length === 0);
  check('坏文件之后仍然能继续追加', appendLifeEntry(cfg, root, { doing: '照样能写' }, 5000).ok === true);
}

// ------------------------------------------------------------------ 清洗 ----
section('清洗（模型说什么都要过这一关）');
{
  const cfg = { life: { limits: { itemChars: 10 } } };

  const e = sanitizeLifeEntry({ mood: '困', doing: '躺床上刷手机', thinking: '明天要早起' }, cfg, 123);
  check('正常对象原样收下', e.mood === '困' && e.doing === '躺床上刷手机' && e.at === 123);

  const s = sanitizeLifeEntry('在吃泡面', cfg, 9);
  check('模型只给一句话时当成「在做的事」', s && s.doing === '在吃泡面' && s.at === 9);

  check('全空的返回 null（调用方丢掉）', sanitizeLifeEntry({}, cfg) === null);
  check('null 返回 null', sanitizeLifeEntry(null, cfg) === null);
  check('数组返回 null', sanitizeLifeEntry([1, 2], cfg) === null);
  check('数字返回 null', sanitizeLifeEntry(12345, cfg) === null);
  check('空字符串返回 null', sanitizeLifeEntry('   ', cfg) === null);

  const long = sanitizeLifeEntry({ doing: '啊'.repeat(50) }, cfg, 1);
  check('超长字段被截断并加省略号', [...long.doing].length === 11 && long.doing.endsWith('…'), long.doing);

  const alias = sanitizeLifeEntry({ action: '在打游戏', thought: '好菜啊' }, cfg, 1);
  check('字段别名也认（action/thought）', alias.doing === '在打游戏' && alias.thinking === '好菜啊');

  const obj = sanitizeLifeEntry({ doing: { nested: true }, mood: '困' }, cfg, 1);
  check('字段里塞了对象就丢掉那个字段，其余保留', obj.doing === '' && obj.mood === '困');

  const log = sanitizeLifeLog({
    version: 1,
    entries: [
      { doing: 'B', at: 200 },
      { doing: 'A', at: 100 },
      12345,                      // 数字 = 垃圾，丢
      null,                       // 空 = 丢
      { doing: 'C', at: 300 },
    ],
  }, cfg);
  check('坏的条目丢掉，好的留下', log.entries.length === 3, String(log.entries.length));
  check('按时间排序（手工改乱顺序也不怕）',
    log.entries.map((x) => x.doing).join('') === 'ABC', log.entries.map((x) => x.doing).join(''));

  // 裸字符串是有意收下的：本地小模型经常只回一句话而不是 JSON，
  // 丢掉它等于把这次模拟白跑（时间线断了）。当成「在做的事」。
  const withBare = sanitizeLifeLog({ entries: [{ doing: 'B', at: 200 }, '在吃泡面'] }, cfg);
  check('裸字符串当成「在做的事」收下（本地小模型经常只回一句话）',
    withBare.entries.length === 2 && withBare.entries.some((x) => x.doing === '在吃泡面'));

  check('整份是垃圾时返回空日志', sanitizeLifeLog('garbage', cfg).entries.length === 0);
  check('entries 不是数组时返回空日志', sanitizeLifeLog({ entries: 'x' }, cfg).entries.length === 0);
  check('emptyLifeLog 形状对', emptyLifeLog().entries.length === 0 && emptyLifeLog().version === 1);
}

// ------------------------------------------------------------------ 渲染 ----
section('渲染进提示词（renderLife）');
{
  const cfg = { life: { limits: { contextEntries: 2, digestChars: 400 } } };
  const log = {
    entries: [
      { at: 1000, mood: '好奇', doing: '翻旧消息', thinking: '好能说' },
      { at: 2000, mood: '困', doing: '刷手机', thinking: '' },
      { at: 3000, mood: '饿', doing: '找吃的', thinking: '泡面' },
    ],
  };
  const r = renderLife(log, cfg);
  check('空日志返回空串（不注入）', renderLife(emptyLifeLog(), cfg) === '');
  check('有内容时非空', r.length > 0);
  check('带标题', r.includes('你最近在做什么'));
  check('只渲染最近 contextEntries 条（老的不要）', !r.includes('翻旧消息') && r.includes('刷手机') && r.includes('找吃的'));
  check('心情/在做/在想 都在', r.includes('心情：饿') && r.includes('在做：找吃的') && r.includes('想着：泡面'));
  check('默认带上「别念出来/别自相矛盾」的交代', r.includes('别') && r.includes('矛盾'));

  const forSim = renderLife(log, cfg, { note: false });
  check('人生模拟自己那次不带那段交代', !forSim.includes('自相矛盾'));

  const tight = renderLife(log, { life: { limits: { contextEntries: 3, digestChars: 40 } } });
  check('超过 digestChars 会截断', [...tight].length <= 41 && tight.endsWith('…'), String([...tight].length));

  // lifeDigestFor：没开就什么都不给
  const root = tmpRoot();
  check('没开人生模拟时不注入（返回空串）',
    lifeDigestFor({ life: { enabled: false } }, root) === '');
  const on = { life: { enabled: true } };
  appendLifeEntry(on, root, { doing: '在打游戏' }, 1000);
  check('开了而且有记录时给出内容', lifeDigestFor(on, root).includes('在打游戏'));
  check('开了但还没记录时返回空串（不写「暂无」）',
    lifeDigestFor({ life: { enabled: true, file: 'none.json' } }, root) === '');
}

// ---------------------------------------------------------------- 节拍器 ----
section('节拍器（每 5 次检测 + 期间没调用过 API）');
{
  const cfg = { life: { enabled: true, everyChecks: 5 } };
  const t = createLifeTicker(cfg);

  check('没开 → 不模拟', createLifeTicker({ life: { enabled: false } }).tick(0).ok === false);

  const r1 = t.tick(0); const r2 = t.tick(0); const r3 = t.tick(0); const r4 = t.tick(0);
  check('第 1~4 次检测都不动', !r1.ok && !r2.ok && !r3.ok && !r4.ok);
  check('第 4 次的原因写明进度', r4.reason.includes('4/5'), r4.reason);

  const r5 = t.tick(0);
  check('第 5 次检测 → 该模拟了', r5.ok === true, r5.reason);
  check('第 5 次的理由说明是空闲', r5.reason.includes('空闲'), r5.reason);

  // 判完要重新数，不然每轮都会触发
  const s = t.snapshot();
  check('判完计数归零', s.checks === 0, JSON.stringify(s));
  check('紧接着的下一轮不会立刻再模拟', t.tick(0).ok === false);
  check('再数到 5 才动', [t.tick(0), t.tick(0), t.tick(0)].every((x) => !x.ok) && t.tick(0).ok === true);

  // 期间调用过 API → 跳过
  const t2 = createLifeTicker(cfg);
  t2.tick(100); t2.tick(101); t2.tick(101); t2.tick(101);
  const used = t2.tick(101);
  check('这 5 次检测里调用过 API → 不模拟', used.ok === false, used.reason);
  check('理由写明是调用过 API', used.reason.includes('API'), used.reason);
  check('跳过之后同样重新计数', t2.snapshot().checks === 0);

  // 模拟自己那次调用不该算数 —— 这是最容易写错的一处
  const t3 = createLifeTicker(cfg);
  for (let i = 0; i < 4; i++) t3.tick(0);
  const first = t3.tick(0);               // 第 5 次检测 → 判定成立
  check('第一次空闲判定成立', first.ok === true, first.reason);
  t3.beginRun();                          // 判定成立之后才派发
  const afterSim = 0 + 1;                 // 模拟自己发了一次请求
  t3.endRun();
  t3.rebaseline(afterSim);                // bot.js 在 finally 里做的就是这个
  for (let i = 0; i < 4; i++) t3.tick(afterSim);
  const second = t3.tick(afterSim);
  check('扣掉模拟自己的调用后，第二个窗口照样能模拟', second.ok === true, second.reason);

  // 不扣会怎样（把这条也钉住，说明为什么要 rebaseline）
  const t4 = createLifeTicker(cfg);
  for (let i = 0; i < 4; i++) t4.tick(0);
  t4.tick(0);
  for (let i = 0; i < 4; i++) t4.tick(1);
  check('不 rebaseline 的话第二个窗口会被误判成「调用过 API」', t4.tick(1).ok === false);

  // 单飞保护
  const t5 = createLifeTicker(cfg);
  for (let i = 0; i < 4; i++) t5.tick(0);
  t5.beginRun();
  const busy = t5.tick(0);
  check('上一次还在跑时不重复派发', busy.ok === false, busy.reason);
  check('理由写明还在跑', busy.reason.includes('还在跑'), busy.reason);
  t5.endRun();
  for (let i = 0; i < 4; i++) t5.tick(0);
  check('跑完之后的窗口恢复正常', t5.tick(0).ok === true);

  // minIntervalMs
  const t6 = createLifeTicker({ life: { enabled: true, everyChecks: 1, minIntervalMs: 60000 } });
  check('第一次不受间隔限制', t6.tick(0, 1_000_000).ok === true);
  t6.beginRun(1_000_000); t6.endRun();
  check('间隔没过 → 不模拟', t6.tick(0, 1_030_000).ok === false, t6.tick(0, 1_030_000).reason);
  const later = t6.tick(0, 1_100_000);
  check('间隔过了 → 再模拟', later.ok === true, later.reason);

  // everyChecks = 1（每轮都试，只是"试"）
  const t7 = createLifeTicker({ life: { enabled: true, everyChecks: 1 } });
  check('everyChecks=1 时每轮都判定', t7.tick(0).ok === true);
}

// ---------------------------------------------------------------- 提示词 ----
section('提示词与设定（送进去的到底是什么）');
{
  const cfg = { life: {} };
  const msgs = buildLifeMessages(cfg, {
    now: new Date('2026-10-06T23:40:00').getTime(),
    persona: '你是一个QQ用户小深，网名是示例昵称',
    memoryDigest: '【你的记忆】你喜欢白饭',
    lifeDigest: '  · 10/6 22:00 在做：刷手机',
    lastAt: new Date('2026-10-06T22:00:00').getTime(),
  });

  check('两条消息：system + user', msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user');
  check('system 是内置的那份提示词', msgs[0].content.includes('真人'));
  check('user 里带人设（用户说的「设定」）', msgs[1].content.includes('示例昵称'));
  check('user 里带记忆', msgs[1].content.includes('你喜欢白饭'));
  check('user 里带最近在做什么', msgs[1].content.includes('刷手机'));
  check('user 里带现在的时间', /23:40/.test(msgs[1].content), '');
  check('把时间点翻译成人话（深夜该睡了）', msgs[1].content.includes('深夜'), '');
  check('带「上一次记录是多久前」', msgs[1].content.includes('1 小时 40 分钟前'), '');
  check('要求输出 JSON 且有 mood/doing/thinking 三个字段',
    msgs[0].content.includes('"mood"') && msgs[0].content.includes('"doing"') && msgs[0].content.includes('"thinking"'));
  check('明确要求别提聊天/消息/AI', msgs[0].content.includes('不要提到聊天'));
  check('明确要求接得上上一条记录', msgs[0].content.includes('接得上'));

  // 自定义提示词整段覆盖
  const custom = buildLifeMessages({ life: { prompt: ['只输出：{\"doing\":\"x\"}', '别废话'] } }, {});
  check('config.life.prompt 能整段覆盖', custom[0].content === '只输出：{"doing":"x"}\n别废话', custom[0].content);
  check('覆盖后不再用内置提示词', !custom[0].content.includes('真人行为模拟器'));

  // 空提示词数组 → 回到内置（不能变成空 system，那会让模型自由发挥）
  const empty = buildLifeMessages({ life: { prompt: [] } }, {});
  check('prompt 为空数组时用内置的', empty[0].content === DEFAULT_LIFE_PROMPT);
  const whitespace = buildLifeMessages({ life: { prompt: ['   ', ''] } }, {});
  check('prompt 全是空白时也用内置的', whitespace[0].content === DEFAULT_LIFE_PROMPT);

  // 什么都没有也要能出一份完整提示词
  const bare = buildLifeMessages({}, {});
  check('没给记忆/生活记录时也有占位说明', bare[1].content.includes('第一次'));
  check('没给人设时有兜底', bare[1].content.includes('普普通通') || bare[1].content.includes('没写人设'));

  // 早上/中午的判断
  const morning = buildLifeMessages({}, { now: new Date('2026-10-06T08:00:00').getTime() });
  check('早上 8 点 → 判成早上', morning[1].content.includes('早上'));
  const noon = buildLifeMessages({}, { now: new Date('2026-10-06T12:30:00').getTime() });
  check('中午 12:30 → 判成中午', noon[1].content.includes('中午'));
}

// ------------------------------------------------------------ 真的调 API ----
section('调用（用假 fetch，不碰真网络）');
{
  const realFetch = globalThis.fetch;
  const realTotal = apiCallStats.total;

  const cfg = {
    life: { enabled: true, timeoutMs: 1000, maxTokens: 100 },
    llm: { enabled: true, baseUrl: 'http://127.0.0.1:1/v1', model: 'fake', apiKey: 'k', temperature: 1 },
  };

  let seen = null;
  globalThis.fetch = async (url, opts) => {
    seen = { url, body: JSON.parse(opts.body) };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '```json\n{"mood":"困","doing":"躺着刷手机","thinking":"明天要早起"}\n```' } }], usage: { total_tokens: 42 } }),
    };
  };

  const r = await generateLifeSimulation(cfg, { persona: '小深', now: Date.now() });
  check('调用成功', r.ok === true, JSON.stringify(r).slice(0, 120));
  check('围栏里的 JSON 也能解析出来', r.entry.doing === '躺着刷手机' && r.entry.mood === '困');
  check('解析出的 entry 交给上层清洗', typeof r.entry === 'object');
  check('发了 chat/completions', seen.url.endsWith('/chat/completions'), seen.url);
  check('带上了人设', JSON.stringify(seen.body.messages).includes('小深'));
  check('默认不开 response_format（本地推理模型会 502）', seen.body.response_format === undefined);
  check('maxTokens 走 life 自己的配置', seen.body.max_tokens === 100, String(seen.body.max_tokens));
  check('数到了一次 API 调用', apiCallStats.total === realTotal + 1, String(apiCallStats.total - realTotal));

  // 模型不给 JSON 也不许崩 —— 原文当「在做的事」收下
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '在窗边发呆' } }] }) });
  const plain = await generateLifeSimulation(cfg, {});
  check('模型不吐 JSON 时原文也收下', plain.ok === true && plain.entry === '在窗边发呆', JSON.stringify(plain.entry));

  // 服务报错 → ok:false，不是抛异常
  globalThis.fetch = async () => ({ ok: false, status: 500, statusText: 'boom', text: async () => 'server error' });
  const bad = await generateLifeSimulation(cfg, {});
  check('HTTP 失败时返回 ok:false 而不是抛', bad.ok === false && bad.reason === 'http');
  check('失败也带回了原因明细', String(bad.detail).includes('500'));

  // 没配 key 时**不该**发请求（否则"有没有调用过 API"的判定会被污染）
  globalThis.fetch = async () => { throw new Error('不该走到这里'); };
  const noKey = await chatOnce({ llm: { enabled: true, baseUrl: 'http://127.0.0.1:1/v1', model: 'x', apiKeyRequired: true } }, { messages: [] });
  check('缺 key 时不发请求，直接 no-key', noKey.ok === false && noKey.reason === 'no-key');
  check('缺 key 不算调用过 API', apiCallStats.total === realTotal + 3, String(apiCallStats.total - realTotal));

  globalThis.fetch = realFetch;
}

// ------------------------------------------------------------ 主动分享 ----
section('主动分享：该不该自己开口（模型提议 + 本地拍板）');
{
  // 自己钉前提，不继承用户当前设置
  const base = {
    life: { enabled: true, share: { enabled: true, probability: 1, minIntervalMs: 0, maxPerDay: 0, maxChars: 40 } },
    trigger: { replyScope: 'whitelist', whitelist: ['测试群', '另一个群'] },
    reply: { dryRun: false },
  };
  const said = (text = '诶我泡面好了', why = '突然想说') => ({ doing: '煮泡面', share: { suitable: true, why, text } });
  const quiet = { doing: '刷手机', share: { suitable: false, why: '没什么好说的' } };

  check('默认是关的（会跟真人说话，必须显式打开）', DEFAULT_SHARE.enabled === false);
  check('没开时一律不发', decideShare({ ...base, life: { enabled: true, share: { enabled: false } } },
    { entry: said(), conversation: '测试群' }).ok === false);
  check('没开时的理由是「没开」',
    decideShare({ ...base, life: { enabled: true, share: { enabled: false } } },
      { entry: said(), conversation: '测试群' }).reason === '主动分享没开');

  const ok = decideShare(base, { entry: said(), conversation: '测试群', now: 1_800_000_000_000 });
  check('模型说适合 + 白名单会话 → 可以发', ok.ok === true, ok.reason);
  check('给出的就是要发的那句话', ok.text === '诶我泡面好了', ok.text);
  check('带上了要发到哪个会话', ok.conversation === '测试群');

  // 模型说"不适合" —— 这是最主要的一道闸门（大部分时候应该是这个结果）
  const no = decideShare(base, { entry: quiet, conversation: '测试群' });
  check('模型判断不适合 → 不发', no.ok === false);
  check('理由带上模型给的原因', no.reason.includes('没什么好说的'), no.reason);

  check('模型压根没给判断 → 不发', decideShare(base, { entry: { doing: '发呆' }, conversation: '测试群' }).ok === false);
  check('说适合但没给话 → 不发',
    decideShare(base, { entry: { share: { suitable: true, why: '想说' } }, conversation: '测试群' }).reason.includes('没给出'));
  check('空字符串的话 → 不发',
    decideShare(base, { entry: { share: { suitable: true, text: '   ' } }, conversation: '测试群' }).ok === false);

  // ---- 发到哪儿：绝不出白名单 ----
  check('不在白名单的会话 → 不发', decideShare(base, { entry: said(), conversation: '陌生群' }).ok === false);
  check('不在白名单时理由说清楚',
    decideShare(base, { entry: said(), conversation: '陌生群' }).reason.includes('不在允许分享'));
  check('读不到会话名 → 不发（宁可不发，也不发到不知道哪里）',
    decideShare(base, { entry: said(), conversation: '' }).ok === false);
  check('replyScope=all 时任意会话都允许',
    decideShare({ ...base, trigger: { replyScope: 'all', whitelist: [] } }, { entry: said(), conversation: '随便哪个群' }).ok === true);
  check('白名单为空 → 谁也不发（空名单不是「没限制」）',
    decideShare({ ...base, trigger: { replyScope: 'whitelist', whitelist: [] } }, { entry: said(), conversation: '测试群' }).ok === false);
  check('share.conversations 写了就优先用它',
    shareAllowedIn({ ...base, life: { share: { conversations: ['只发这个群'] } } }, '只发这个群') === true
    && shareAllowedIn({ ...base, life: { share: { conversations: ['只发这个群'] } } }, '测试群') === false);

  // ---- dryRun ----
  check('dryRun 模式不发（配置说别真发就别真发）',
    decideShare({ ...base, reply: { dryRun: true } }, { entry: said(), conversation: '测试群' }).ok === false);

  // ---- 静默时段 ----
  const night = new Date('2026-10-05T02:30:00').getTime();
  const noon = new Date('2026-10-05T12:30:00').getTime();
  const quietCfg = { ...base, life: { enabled: true, share: { ...base.life.share, quietHours: { from: 23, to: 8 } } } };
  check('凌晨 2:30 在静默时段（跨零点也算）', decideShare(quietCfg, { entry: said(), conversation: '测试群', now: night }).ok === false);
  check('静默的理由写明时段', decideShare(quietCfg, { entry: said(), conversation: '测试群', now: night }).reason.includes('静默'));
  check('中午 12:30 不在静默时段', decideShare(quietCfg, { entry: said(), conversation: '测试群', now: noon }).ok === true);
  check('from===to 表示不启用静默',
    decideShare({ ...base, life: { enabled: true, share: { ...base.life.share, quietHours: { from: 0, to: 0 } } } },
      { entry: said(), conversation: '测试群', now: night }).ok === true);
  check('22 点不算静默（边界：23 点才开始）',
    decideShare(quietCfg, { entry: said(), conversation: '测试群', now: new Date('2026-10-05T22:59:00').getTime() }).ok === true);
  check('23 点整算静默（边界含起点）',
    decideShare(quietCfg, { entry: said(), conversation: '测试群', now: new Date('2026-10-05T23:00:00').getTime() }).ok === false);

  // ---- 间隔 ----
  const gapCfg = { ...base, life: { enabled: true, share: { ...base.life.share, minIntervalMs: 1800000 } } };
  const t0 = 1_800_000_000_000;
  check('第一次不受间隔限制', decideShare(gapCfg, { entry: said(), conversation: '测试群', now: t0, state: {} }).ok === true);
  const state1 = recordShare({}, t0, '上一句');
  check('刚发完 → 被间隔挡住', decideShare(gapCfg, { entry: said(), conversation: '测试群', now: t0 + 60000, state: state1 }).ok === false);
  check('间隔的理由写明分钟数',
    decideShare(gapCfg, { entry: said(), conversation: '测试群', now: t0 + 60000, state: state1 }).reason.includes('分钟'));
  check('过了间隔就能再发', decideShare(gapCfg, { entry: said(), conversation: '测试群', now: t0 + 1800001, state: state1 }).ok === true);

  // ---- 每日上限 ----
  const dayCfg = { ...base, life: { enabled: true, share: { ...base.life.share, maxPerDay: 2 } } };
  const day = new Date('2026-10-05T12:00:00').getTime();
  let st = {};
  st = recordShare(st, day, 'a');
  st = recordShare(st, day + 1000, 'b');
  check('今天已经发满 → 不再发', decideShare(dayCfg, { entry: said(), conversation: '测试群', now: day + 2000, state: st }).ok === false);
  check('满额的理由写明次数上限', decideShare(dayCfg, { entry: said(), conversation: '测试群', now: day + 2000, state: st }).reason.includes('今天已经'));
  check('countSharesToday 只数今天', countSharesToday(st, day + 2000) === 2);
  check('昨天的记录不算今天', countSharesToday(st, day + 86400000) === 0);
  check('跨到第二天又能发了', decideShare(dayCfg, { entry: said(), conversation: '测试群', now: day + 86400000, state: st }).ok === true);
  check('maxPerDay=0 表示不限', decideShare({ ...base, life: { enabled: true, share: { ...base.life.share, maxPerDay: 0 } } },
    { entry: said(), conversation: '测试群', now: day + 2000, state: st }).ok === true);

  // ---- 概率 ----
  const zero = { ...base, life: { enabled: true, share: { ...base.life.share, probability: 0 } } };
  check('概率 0 → 永不发', decideShare(zero, { entry: said(), conversation: '测试群' }).ok === false);
  check('概率 0 的理由写明', decideShare(zero, { entry: said(), conversation: '测试群' }).reason.includes('概率'));
  const half = { ...base, life: { enabled: true, share: { ...base.life.share, probability: 0.5 } } };
  let hits = 0;
  for (let i = 0; i < 400; i++) if (decideShare(half, { entry: said(), conversation: '测试群' }).ok) hits++;
  check('概率 0.5 大概抽中一半（不是永远中/永远不中）', hits > 120 && hits < 280, `${hits}/400`);

  // ---- recordShare ----
  const rs = recordShare({}, 12345, '文本');
  check('recordShare 记了时间和文本', rs.lastShareAt === 12345 && rs.lastShareText === '文本');
  check('recordShare 有计数', rs.shares === 1);
  check('recordShare 追加进 shareTimes', Array.isArray(rs.shareTimes) && rs.shareTimes.length === 1);
  check('recordShare 列表有上限（不会无限长）',
    recordShare({ shareTimes: new Array(80).fill(1) }, 1, 'x').shareTimes.length <= 50);
  check('recordShare 传 null 也不崩', recordShare(null, 1, 'x') === null);

  // ---- 日志里的 share / shared ----
  const e = sanitizeLifeEntry({ doing: '煮泡面', share: { suitable: true, why: '想说', text: '诶我泡面好了' } }, base, 1000);
  check('生活记录里保留模型的分享判断', e.share && e.share.suitable === true && e.share.text === '诶我泡面好了');
  const e2 = sanitizeLifeEntry({ doing: '发呆', share: { suitable: false, why: '没事' } }, base, 1000);
  check('说不适合也留着（事后能查它为什么没说话）', e2.share && e2.share.suitable === false && e2.share.why === '没事');
  check('没给 share 时是 null', sanitizeLifeEntry({ doing: '发呆' }, base, 1).share === null);
  check('share 里塞垃圾不崩', sanitizeLifeEntry({ doing: 'x', share: 'yes' }, base, 1).share === null);
  const long = sanitizeLifeEntry({ doing: '煮泡面', share: { suitable: true, text: '啊'.repeat(80) } }, base, 1);
  check('分享那句话按 maxChars 截断', [...long.share.text].length <= 41, String([...long.share.text].length));

  // 只有 share、没有任何生活内容的记录会被整条丢掉。
  // 这是**故意的**：说明模型这次没好好推演（连在做什么都没说），
  // 那么它顺带说的"值得分享"也不可信 —— 宁可不发。
  check('只有 share 没内容 → 整条丢掉（顺带也不发那句话）',
    sanitizeLifeEntry({ share: { suitable: true, text: '诶' } }, base, 1) === null);
  const e3 = sanitizeLifeEntry({ doing: 'x', shared: { at: 5, ok: true, sent: true, text: '发出去了', conversation: '测试群' } }, base, 1);
  check('发出去的记录也留着', e3.shared && e3.shared.sent === true && e3.shared.conversation === '测试群');

  // ---- 发完回写日志 ----
  const root = tmpRoot();
  const cfgF = { life: { enabled: true, file: 'life.json', share: { enabled: true } } };
  const a1 = appendLifeEntry(cfgF, root, { doing: '煮泡面', share: { suitable: true, text: '诶我泡面好了' } }, 777);
  check('先写进日志', a1.ok === true && a1.entry.at === 777);
  const up = updateLifeEntry(cfgF, root, 777, { shared: { at: 888, ok: true, sent: true, text: '诶我泡面好了', conversation: '测试群' } });
  check('回写分享结果成功', up.ok === true && up.entry.shared.sent === true);
  const reread = loadLifeLog(cfgF, root);
  check('重新读回来的记录里有发送痕迹', reread.log.entries[0].shared.text === '诶我泡面好了');
  check('原来那条生活内容没被回写冲掉', reread.log.entries[0].doing === '煮泡面');
  check('按不存在的 at 回写时返回失败而不是乱写', updateLifeEntry(cfgF, root, 999, { shared: {} }).ok === false);
}

// ------------------------------------------------------------ 多重人生 ----
section('多重人生（一份文件 = 一个人的一生）');
{
  const root = tmpRoot();
  const cfg = { life: { enabled: true, file: 'life.json', dir: 'lives' } };

  check('没指定人名 → 用默认那份 life.json', lifeFile(cfg, root, '') === path.join(root, 'life.json'));
  check('指定了人名 → 落到 lives/ 目录',
    lifeFile(cfg, root, '小深') === path.join(root, 'lives', '小深.json'),
    lifeFile(cfg, root, '小深'));
  check('名字里有斜杠也不会跑出目录（复用 memory 的文件名规整）',
    lifeFile(cfg, root, 'a/b').startsWith(path.join(root, 'lives')),
    lifeFile(cfg, root, 'a/b'));
  check('不传 profile 时看 config.life.profile',
    lifeFile({ life: { file: 'life.json', dir: 'lives', profile: '阿肥' } }, root) === path.join(root, 'lives', '阿肥.json'));

  // activeProfile：state 覆盖 config（控制台切人在不重启的情况下生效）
  check('state 里有人名就用它',
    activeProfile({ life: { profile: '配置里的' } }, { lifeProfile: '控制台切的' }) === '控制台切的');
  check('state 里没有就退回 config', activeProfile({ life: { profile: '配置里的' } }, {}) === '配置里的');
  check('都没有就是空（= 默认那份）', activeProfile({ life: {} }, {}) === '');
  check('state 里是空白字符串不算数', activeProfile({ life: { profile: '配置里的' } }, { lifeProfile: '  ' }) === '配置里的');

  // 新建
  const c1 = createLifeProfile(cfg, root, '小深');
  check('新建成功', c1.ok === true && c1.total === 0, JSON.stringify(c1));
  check('文件真的在 lives/ 下', fs.existsSync(path.join(root, 'lives', '小深.json')));
  check('文件里记了这个人叫什么', JSON.parse(fs.readFileSync(path.join(root, 'lives', '小深.json'), 'utf8')).profile === '小深');
  check('同名再建被拒绝（绝不覆盖）', createLifeProfile(cfg, root, '小深').ok === false);
  check('空名字被拒绝', createLifeProfile(cfg, root, '  ').ok === false);

  const c2 = createLifeProfile(cfg, root, '阿肥', { seedFrom: '小深' });
  check('可以从别的人生复制当起点', c2.ok === true);

  // 两个人各过各的，互不串台
  appendLifeEntry(cfg, root, { doing: '小深在煮泡面' }, 1000, '小深');
  appendLifeEntry(cfg, root, { doing: '阿肥在打游戏' }, 2000, '阿肥');
  appendLifeEntry(cfg, root, { doing: '小深在刷手机' }, 3000, '小深');

  const shen = loadLifeLog(cfg, root, '小深');
  const fei = loadLifeLog(cfg, root, '阿肥');
  check('小深那份只有小深的事', shen.log.entries.length === 2, String(shen.log.entries.length));
  check('阿肥那份只有阿肥的事', fei.log.entries.length === 1 && fei.log.entries[0].doing === '阿肥在打游戏');
  check('两人的日志不共用文件', shen.path !== fei.path);
  check('读出来的日志带着人名', shen.log.profile === '小深' && fei.log.profile === '阿肥');

  // 切回来还在（这就是"未被选中的人的人生被保存并下次调用"）
  const back = loadLifeLog(cfg, root, '小深');
  check('切走再切回来，那份人生还在', back.log.entries.length === 2
    && back.log.entries.map((e) => e.doing).join('|') === '小深在煮泡面|小深在刷手机');

  // 默认那份和 lives/ 互不影响
  appendLifeEntry(cfg, root, { doing: '默认那份的事' }, 4000, '');
  check('默认那份单独一个文件', fs.existsSync(path.join(root, 'life.json')));
  check('默认那份不影响小深那份', loadLifeLog(cfg, root, '小深').log.entries.length === 2);

  // 列表
  const lives = listLives(cfg, root);
  check('列表里能看到所有人（含默认那份）', lives.length === 3, JSON.stringify(lives.map((x) => x.profile)));
  const shenRow = lives.find((x) => x.profile === '小深');
  check('列表里带条数', shenRow && shenRow.total === 2, JSON.stringify(shenRow));
  check('列表里带在做什么（一眼看出这份人生到哪儿了）', shenRow && shenRow.lastDoing === '小深在刷手机');
  check('列表里带主动分享过几次', shenRow && typeof shenRow.shared === 'number');
  check('列表里带文件路径', shenRow && typeof shenRow.file === 'string' && shenRow.file.includes('lives'));
  check('列表里每份都 ok', lives.every((x) => x.ok === true));

  // 回写分享结果也要落到正确的那份
  const at = loadLifeLog(cfg, root, '阿肥').log.entries[0].at;
  updateLifeEntry(cfg, root, at, { shared: { at: 9, ok: true, sent: true, text: '冒个泡' } }, '阿肥');
  check('分享结果写回了阿肥那份', loadLifeLog(cfg, root, '阿肥').log.entries[0].shared.text === '冒个泡');
  check('没串到小深那份', loadLifeLog(cfg, root, '小深').log.entries.every((e) => !e.shared));

  // 空日志也带人名
  check('emptyLifeLog 记人名', emptyLifeLog('小深').profile === '小深');
  check('sanitizeLifeLog 保留文件里的人名', sanitizeLifeLog({ profile: '阿肥', entries: [] }, cfg).profile === '阿肥');
}

// ------------------------------------------------------------ 运行时开关 ----
section('运行时开关（控制台点了立刻生效）');
{
  const cfg = { life: { enabled: true, share: { enabled: true } }, trigger: { whitelist: ['测试群'] }, reply: {} };
  check('没覆盖时按 config：人生模拟开', lifeEnabled(cfg, {}) === true);
  check('没覆盖时按 config：主动分享开', shareEnabled(cfg, {}) === true);
  check('state 说关就是关（覆盖 config）', lifeEnabled(cfg, { lifeEnabled: false }) === false);
  check('state 说开就是开（能把 config 里关的打开）',
    lifeEnabled({ life: { enabled: false } }, { lifeEnabled: true }) === true);
  check('主动分享可以单独关掉', shareEnabled(cfg, { shareEnabled: false }) === false);
  check('人生模拟关着时，主动分享必然也是关的（没模拟就没东西可发）',
    shareEnabled(cfg, { lifeEnabled: false, shareEnabled: true }) === false);
  check('state 里放个垃圾值不会生效（只认真正的布尔）',
    lifeEnabled(cfg, { lifeEnabled: 'yes' }) === true);

  // 节拍器也要听 state 的
  const t = createLifeTicker({ life: { enabled: true, everyChecks: 1 } });
  check('节拍器：state 说关 → 不动', t.tick(0, 1, { lifeEnabled: false }).ok === false);
  check('节拍器：state 说开 → 照常判', createLifeTicker({ life: { enabled: false, everyChecks: 1 } }).tick(0, 1, { lifeEnabled: true }).ok === true);

  // decideShare 的 enabled 由调用方显式给（bot.js 传控制台刚改的值）
  const entry = { doing: '煮泡面', share: { suitable: true, text: '诶泡面好了' } };
  check('decideShare：显式 enabled=false 时不发',
    decideShare(cfg, { entry, conversation: '测试群', enabled: false }).ok === false);
  check('decideShare：显式 enabled=true 时正常判',
    decideShare(cfg, { entry, conversation: '测试群', enabled: true }).ok === true);
  check('decideShare：state 里关了也不发',
    decideShare(cfg, { entry, conversation: '测试群', state: { shareEnabled: false } }).ok === false);
}

// ------------------------------------------------------------ 超时设置 ----
section('人生模拟的超时：0 = 不设超时（本地模型慢，120 秒不够）');
{
  check('没配 timeoutMs 时用 60 秒默认值',
    lifeConfig({ life: {} }).timeoutMs === 60000, String(lifeConfig({ life: {} }).timeoutMs));
  check('配 0 → 原样传下去（0 表示不超时，不能被"兜底"成 60 秒）',
    lifeConfig({ life: { timeoutMs: 0 } }).timeoutMs === 0, String(lifeConfig({ life: { timeoutMs: 0 } }).timeoutMs));
  check('配正数就照用', lifeConfig({ life: { timeoutMs: 600000 } }).timeoutMs === 600000);

  // 行为验证：给假 fetch 一个"比 timeoutMs 慢很多"的响应
  //   timeoutMs = 50  → 应该以 timeout 失败
  //   timeoutMs = 0   → 应该正常成功（说明真的没有定时器在掐它）
  //
  // ⚠ 这个假 fetch **必须实现 signal 中断**：第一版直接 setTimeout 后就 resolve，
  //   于是 abort 了也没人理，timeoutMs=50 照样成功 —— 测试看起来"失败"，其实是假实现不忠实。
  const slowFetch = (url, opts) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"doing":"慢慢来"}' } }] }),
    }), 200);
    const sig = opts?.signal;
    if (sig) {
      const onAbort = () => {
        clearTimeout(t);
        const e = new Error('The operation was aborted.');
        e.name = 'AbortError';
        reject(e);
      };
      if (sig.aborted) onAbort();
      else sig.addEventListener('abort', onAbort);
    }
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = slowFetch;

  const cfgBase = {
    life: {},
    // apiKeyRequired:false = 本地服务那种"不需要 key"的情形，否则会先以 no-key 短路，
    // 根本走不到超时那段逻辑（第一次就是这么写错的）
    llm: { enabled: true, baseUrl: 'http://127.0.0.1:1/v1', model: 'x', temperature: 1, maxTokens: 10, apiKeyRequired: false },
  };
  const timedOut = await generateLifeSimulation(
    { ...cfgBase, life: { timeoutMs: 50 } }, {},
  );
  check('超时设小了确实会超时（证明这个开关是活的）',
    timedOut.ok === false && timedOut.reason === 'timeout', JSON.stringify(timedOut.reason));

  const noTimeout = await generateLifeSimulation(
    { ...cfgBase, life: { timeoutMs: 0 } }, {},
  );
  check('timeoutMs=0 时不会被掐断（200ms 的响应照常收下）',
    noTimeout.ok === true && noTimeout.entry.doing === '慢慢来', JSON.stringify(noTimeout).slice(0, 120));

  globalThis.fetch = realFetch;

  // 配置里就该是 0（用户要求：人生模拟走本地 + 去掉超时）
  const realCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  checkReal('真实 config：life.timeoutMs = 0（不超时）', realCfg.life.timeoutMs === 0, String(realCfg.life.timeoutMs));
  checkReal('真实 config：人生模拟走本地（provider=local、life.model 留空=跟回复同一个模型）',
    realCfg.llm.provider === 'local' && !realCfg.life.model,
    `${realCfg.llm.provider} / ${JSON.stringify(realCfg.life.model)}`);
  checkReal('回复和记忆整理**没有**被顺手去掉超时（它们要等结果，不能无限挂）',
    Number(realCfg.llm.timeoutMs) > 0 && Number(realCfg.memory.timeoutMs) > 0,
    `llm=${realCfg.llm.timeoutMs} memory=${realCfg.memory.timeoutMs}`);
}

// ------------------------------------------------------------ 生活时钟 ----
section('生活时钟：每次模拟传递的时间（用户的「每次模拟时传递时间」）');
{
  const cfg = { life: { enabled: true, file: 'life.json', stepMinutes: 15, maxAheadMinutes: 120 } };
  const root = tmpRoot();
  const MIN = 60000;

  // 1) 没有上一条 → 用现实时间
  const first = nextLifeClock(cfg, { entries: [] }, 1_000_000_000_000);
  check('第一条记录用现实时间', first.lifeAt === 1_000_000_000_000 && first.prevLifeAt === null, JSON.stringify(first));

  // 2) 有上一条 → 往前推 stepMinutes（不是停在原地）
  let log = { entries: [{ at: 1_000_000_000_000, lifeAt: 1_000_000_000_000, doing: 'a' }] };
  const second = nextLifeClock(cfg, log, 1_000_000_000_000 + 30_000);   // 现实只过了 30 秒
  check('推进 15 分钟（不因为现实只过 30 秒就停住）',
    second.lifeAt === 1_000_000_000_000 + 15 * MIN, String((second.lifeAt - 1_000_000_000_000) / MIN) + ' 分钟');
  check('报出上一条的时钟（模型要靠它算"过了多久"）',
    second.prevLifeAt === 1_000_000_000_000);

  // 3) 现实跑到前面去了 → 以现实为准（机器人停过一夜再开，不能还停在昨晚）
  const afterOffline = nextLifeClock(cfg, log, 1_000_000_000_000 + 600 * MIN);
  check('现实时间领先时以现实为准（停机后再开不会停在旧时间）',
    afterOffline.lifeAt === 1_000_000_000_000 + 600 * MIN, String((afterOffline.lifeAt - 1_000_000_000_000) / MIN) + ' 分钟');

  // 4) 关掉时钟 → 退回老行为（用真实时间）
  const offCfg = { life: { stepMinutes: 0 } };
  check('stepMinutes=0 → 用真实时间（老行为）',
    nextLifeClock(offCfg, log, 1_234_567).lifeAt === 1_234_567);

  // 5) 刹车：模拟世界不许跑到现实前面（用户观察到的"流速不同"那条要求）
  const now = 1_000_000_000_000;
  const aheadLog = { entries: [{ at: now, lifeAt: now + 200 * MIN, doing: 'a' }] };
  const cfgAhead = { life: { stepMinutes: 15, maxAheadMinutes: 120 } };
  const g1 = lifeClockGate(cfgAhead, aheadLog, now);
  check('（允许领先 120 分钟时）领先超过上限 → 拦下', g1.ok === false && g1.aheadMinutes > 120, JSON.stringify(g1));
  const closeLog = { entries: [{ at: now, lifeAt: now + 10 * MIN, doing: 'a' }] };
  check('（允许领先 120 分钟时）领先不多 → 放行', lifeClockGate(cfgAhead, closeLog, now).ok === true);

  // 默认这一档：0 = 一步都不许领先
  const strict = { life: { stepMinutes: 15, maxAheadMinutes: 0 } };
  check('maxAheadMinutes=0：世界还在未来 → 不模拟（这段时间不花 API）',
    lifeClockGate(strict, closeLog, now).ok === false,
    lifeClockGate(strict, closeLog, now).reason);
  check('maxAheadMinutes=0：现实已经追上来 → 该模拟',
    lifeClockGate(strict, { entries: [{ at: now, lifeAt: now - 1, doing: 'a' }] }, now).ok === true);
  check('拦下时会告诉还要等多久',
    lifeClockGate(strict, closeLog, now).waitMinutes === 10,
    String(lifeClockGate(strict, closeLog, now).waitMinutes));
  check('时钟关掉时不拦（用真实时间就没有领先问题）',
    lifeClockGate({ life: { stepMinutes: 0 } }, aheadLog, now).ok === true);
  check('还没有历史时不拦（第一条总要记）',
    lifeClockGate(strict, { entries: [] }, now).ok === true);

  // 用户要的完整节奏：模拟一次 → 世界 +15 分钟 → 接下来 15 分钟一次 API 都不调
  {
    const t0 = 1_800_000_000_000;
    const lg = { entries: [{ at: t0, lifeAt: t0, doing: '起点' }] };
    check('起点该模拟', lifeClockGate(strict, lg, t0).ok === true);
    const after = nextLifeClock(strict, lg, t0);
    lg.entries.push({ at: t0, lifeAt: after.lifeAt, doing: '刚模拟过' });
    check('模拟后世界时间 = 现实 +15 分钟', after.lifeAt - t0 === 15 * MIN,
      `+${(after.lifeAt - t0) / MIN} 分钟`);
    const blocked = [1, 5, 14].every((m) => lifeClockGate(strict, lg, t0 + m * MIN).ok === false);
    check('接下来 1/5/14 分钟都不模拟（= 不调用 API）', blocked);
    check('第 15 分钟现实追上 → 又能模拟了', lifeClockGate(strict, lg, t0 + 15 * MIN).ok === true);
  }

  // 6) 真的写进日志：连续追加时时钟会往前走，而不是跟真实时间重合
  const t0 = Date.now();
  const a = appendLifeEntry(cfg, root, { doing: '起身倒水' }, t0, '');
  const b = appendLifeEntry(cfg, root, { doing: '泡面好了' }, t0 + 5000, '');
  const c = appendLifeEntry(cfg, root, { doing: '吃完了' }, t0 + 10000, '');
  // ⚠ 断言也要显式判 null：Number(null)===0 是 finite，
  //   一开始用 Number.isFinite(Number(x)) 写，结果"lifeAt 根本没写进去"也能假通过。
  const hasClock = (x) => x.entry.lifeAt !== null && x.entry.lifeAt !== undefined && Number.isFinite(Number(x.entry.lifeAt));
  check('每条都带上了角色时钟', [a, b, c].every(hasClock),
    JSON.stringify([a, b, c].map((x) => x.entry.lifeAt)));
  check('三条记录的时钟是递增的',
    a.entry.lifeAt < b.entry.lifeAt && b.entry.lifeAt < c.entry.lifeAt,
    [a, b, c].map((x) => Math.round((x.entry.lifeAt - t0) / MIN) + 'min').join(' → '));
  check('第二条比第一条晚 15 分钟', b.entry.lifeAt - a.entry.lifeAt === 15 * MIN);
  check('真实时间 at 仍然是真实的（两套时间分开存）',
    b.entry.at === t0 + 5000 && b.entry.lifeAt > b.entry.at, `at=${b.entry.at - t0} lifeAt=${b.entry.lifeAt - t0}`);

  // 7) 渲染用角色时钟（否则提示词里显示的时间跟它自己的时间线不一致）
  const rendered = renderLife(loadLifeLog(cfg, root, '').log, cfg);
  const shown = new Date(c.entry.lifeAt).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  check('注入提示词的时间用的是角色时钟', rendered.includes(shown), shown);
  check('渲染出来的三条都有', ['起身倒水', '泡面好了', '吃完了'].every((x) => rendered.includes(x)));

  // 8) 老记录（没有 lifeAt）不能显示成空白或 1970
  const oldLog = { entries: [{ at: t0, doing: '老记录' }] };
  const r2 = renderLife(oldLog, cfg);
  check('老记录没有 lifeAt 时退回真实时间（不显示 1970）',
    r2.includes('老记录') && !r2.includes('1970'), r2.split('\n').find((l) => l.includes('老记录')) || '');

  // 9) 真实配置：时钟是开着的
  const realCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  checkReal('真实 config：生活时钟开着（stepMinutes > 0）', Number(realCfg.life.stepMinutes) > 0, String(realCfg.life.stepMinutes));
  checkReal('真实 config：模拟世界不许跑到现实前面（0 = 最严那一档，用户要求）',
    Number(realCfg.life.maxAheadMinutes) === 0, String(realCfg.life.maxAheadMinutes));

  // 10) 接线：bot.js 传给模型的必须是角色时钟，不是 Date.now()
  const bot = fs.readFileSync(path.join(ROOT, 'src', 'bot.js'), 'utf8');
  check('bot.js 用 nextLifeClock 算这次模拟的"现在"', bot.includes('nextLifeClock(cfg, lifeLog, now)'));
  check('传给模型的是角色时钟', /now: clock\.lifeAt/.test(bot));
  check('"上一次记录"传的是角色时钟而不是真实时间', /lastAt: clock\.prevLifeAt/.test(bot));
  check('主循环里有领先上限这道闸门', bot.includes('lifeClockGate(cfg,'));
}

// ------------------------------------------------------------ 接进主循环 ----
section('接进机器人（源码级断言：这些接线错了很难发现）');
{
  const bot = fs.readFileSync(path.join(ROOT, 'src', 'bot.js'), 'utf8');
  const llm = fs.readFileSync(path.join(ROOT, 'src', 'llm.js'), 'utf8');
  const life = fs.readFileSync(path.join(ROOT, 'src', 'life.js'), 'utf8');

  check('主循环里建了节拍器', bot.includes('createLifeTicker(cfg)'));
  check('节拍器用的是真的 API 调用计数', bot.includes('lifeTicker.tick(apiCallStats.total'));
  check('触发点在控制台检测之后（用户要的节拍就是它）',
    /consoleStillThere\(\)\)\)\s*return;[\s\S]{0,400}maybeSimulateLife\(\)/.test(bot),
    '');
  check('模拟不阻塞扫描（不 await，它是背景活动）',
    /\.then\(\(\) => runLifeSimulation\(state\)\)/.test(bot) && !/await runLifeSimulation\(/.test(bot));
  check('模拟异常不会冒到主循环', bot.includes('人生模拟异常（已忽略）'));
  check('跑完会 rebaseline（否则只会模拟一次）', bot.includes('lifeTicker.rebaseline(apiCallStats.total)'));
  check('失败只报一次同样的原因（不刷屏）', bot.includes('lifeWatch.lastError'));
  check('结果写进生活日志', bot.includes('appendLifeEntry(cfg, ROOT'));
  check('生活日志注入回复的提示词',
    bot.includes('lifeDigestFor(cfg, ROOT, loadState())') && bot.includes('lifeDigest,'));
  check('buildMessages 会用 lifeDigest', llm.includes('lifeBlock'));

  // ---- 主动分享的接线（这一段是全项目唯一会主动跟真人说话的地方）----
  //
  // 断言要看**代码**而不是注释：这两段的文档注释里本来就写着 sendMessage、
  // decideShare 这些词，直接对源码切片做匹配会被自己的注释骗过去（踩过）。
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const simBody = stripComments(bot.slice(bot.indexOf('async function runLifeSimulation'), bot.indexOf('async function shareLifeEntry')));
  const shareBody = stripComments(bot.slice(bot.indexOf('async function shareLifeEntry'), bot.indexOf('async function updateMemoryAfterReply')));

  check('runLifeSimulation 自己**不**发消息（只写日志 + 交给分享那条路）',
    simBody.length > 100 && !/sendMessage/.test(simBody));
  check('分享那条路确实会发', /sendMessage\(/.test(shareBody));
  check('但发之前必须先过 decideShare 的本地闸门', /decideShare\(cfg/.test(shareBody));
  check('本地闸门在发送之前（顺序不能反）',
    shareBody.indexOf('decideShare(cfg') < shareBody.indexOf('sendMessage(cfg'));
  check('模型说不适合时直接返回，连界面都不去读',
    /suitable !== true\)[\s\S]{0,400}return/.test(shareBody));
  check('发送之前会**现读**当前会话（模拟跑了几十秒，自动切换可能已经换群了）',
    /readCurrentConversation\(\{ cfg \}\)/.test(shareBody)
    && shareBody.indexOf('readCurrentConversation') < shareBody.indexOf('sendMessage(cfg'));
  check('发送走 sender.js 的 sendMessage（内部有串行锁，不会和回复撞进同一个输入框）',
    bot.includes("import { sendMessage, verifySentByOcr } from './sender.js'")
    && !/runPs\(['"]qq-send-message/.test(bot));
  check('发送结果会写回生活日志（事后能查"它那天为什么冒那句"）',
    /updateLifeEntry\(cfg, ROOT, entry\.at, \{ shared/.test(shareBody));
  // ⚠ 2026-10-06 改：写历史的入口统一成 pushSelfHistory（历史按会话分开了，
  //   条目必须带会话名 —— 见 bot.js 里的注释和 test-context.mjs 的断言）。
  //   这里断言"走的是那个入口、并带上了会话名"，而不是死盯某一行 push 写法。
  check('发了之后补进持久历史（否则它不知道自己刚说过什么）',
    /pushSelfHistory\(state, d\.text, d\.conversation\)/.test(shareBody)
    && /state\.history\.push\(\{ conv, side: 'self'/.test(bot));
  check('分享失败不影响生活日志（先写日志再分享）',
    bot.indexOf('appendLifeEntry(cfg, ROOT') < bot.indexOf('await shareLifeEntry('));

  // sender.js 那把锁
  const sender = fs.readFileSync(path.join(ROOT, 'src', 'sender.js'), 'utf8');
  check('sender.js 有发送串行锁', sender.includes('withSendLock') && sender.includes('sendChain'));
  check('sendMessage 会走那把锁（不用调用方自觉）', /export function sendMessage\([\s\S]{0,200}withSendLock/.test(sender));
  check('sendMessageRaw 不再被直接导出（绕过锁的入口必须封掉）',
    sender.includes('async function sendMessageRaw') && !/export async function sendMessageRaw/.test(sender));

  check('LLM 那侧写明"要不要真发由 life.js 拍板"',
    llm.includes('decideShare') && llm.includes('生活日志'));
  check('提示词里明确要求了分享判断', llm.includes('"share"') && llm.includes('suitable'));
  check('提示词把门槛压高了（大多数时候该是 false）',
    llm.includes('大多数时候应该是 false') || llm.includes('一律 false'));
  check('提示词要求夜里别说', llm.includes('深夜或凌晨一律 false'));
  check('提示词告诉模型 share.text 会被真的发出去',
    llm.includes('会被真的发出去') && llm.includes('宁可不发也别硬凑'));

  // ---- 发送失败重试时不许重新生成（实测：同一句话刷了 7 遍、每遍都花一次 API）----
  //
  // 现场：QQ 窗口激活不了（用户在用别的窗口，Windows 拒绝后台进程抢焦点）→
  // 这条留在队列里重试 → 重试又把 composeReply 整个跑一遍 →
  //   回复（被@）"…在干嘛"（等待 354s）→ "刚要睡着…" 发送失败
  //   回复（被@）"…在干嘛"（等待 390s）→ "嗯嗯嗯"     发送失败
  // 三个后果：白花 API 调用、句子越试越偏、日志里像是"重复回复同一条"。
  check('发送失败重试时复用已生成的那句（不重新调用 API）',
    /head\.composed\s*\?/.test(bot) && /apiNote: '（沿用上次生成的那句，没有重新调用 API）'/.test(bot));
  check('生成完就存回队列项（否则重试无从复用）',
    /head\.composed = composed\.reply/.test(bot));
  check('窗口激活不了时只报一次（否则每 5 秒刷一遍同样的错）',
    bot.includes('focusWatch') && /isFocus && focusWatch\.key === head\.fingerprint/.test(bot));
  check('报错文案说明了原因和"已缓存不会再调 API"',
    bot.includes('你在用别的窗口时系统会拒绝抢焦点') && bot.includes('重试不会再调用 API'));

  // 不许偷偷写别人的记忆文件（两边并发写会互相覆盖）
  check('life.js 只复用 memory.js 的读/原子写/文件名规整，不碰记忆的保存函数',
    /import \{ readJson, writeJsonAtomic[^}]*\} from '\.\/memory\.js'/.test(life)
    && !/\b(saveGlobal|saveStore|saveConversation|applyMemoryPatch)\b/.test(life));
  check('life.js 复用了 memory.js 的原子落盘', life.includes('writeJsonAtomic'));
  check('life.js 不 import llm.js（避免循环依赖）', !/from '\.\/llm\.js'/.test(life));

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  check('config 里有 life 块', Boolean(cfg.life));
  check('config 里 everyChecks = 5（用户明确要求）', cfg.life.everyChecks === 5, String(cfg.life.everyChecks));
  // 「用户要求打开」是**用户偏好**，不是代码行为：刚导出的副本里默认就是关的
  // （导出脚本强制 life.enabled=false，不然新用户一跑就在花钱）。这条也跟着 SKIP。
  checkReal('config 里是开着的（用户要求打开）', cfg.life.enabled === true);
  check('config 里注明了"结果不会发到 QQ"', JSON.stringify(cfg.life.$comment).includes('不会'));
  check('config 里提示了费用/频率', JSON.stringify(cfg.life.$comment).includes('费用'));

  // bot.js 是全项目唯一**不能**被 import 的模块（一 import 就跑主循环，
  // 会去扫 QQ、动鼠标、发消息）。所以它的 import 路径没人能靠运行发现写错 ——
  // 这里静态查一遍：每个 .js 相对路径都要真的存在。
  // （模块名写错 = 启动直接崩，而那时用户已经在指望它干活了。）
  for (const f of ['bot.js', 'life.js', 'llm.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    const missing = [];
    for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
      if (!fs.existsSync(path.resolve(path.join(ROOT, 'src'), m[1]))) missing.push(m[1]);
    }
    check(`src/${f} 里的相对 import 都能找到文件`, missing.length === 0, missing.join(', '));
  }
}

console.log('\n' + '='.repeat(72));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(72));
process.exit(fail === 0 ? 0 : 1);
