/**
 * memory.js — 长期记忆，分两层存。
 *
 * 为什么要分两层（用户要求）：
 *   以前所有会话共用一份 memory.json。结果是**私聊里它会带着群里的关系和经历说话** ——
 *   明明是单独跟一个人聊，张口就是"群里那个谁谁"。反过来也一样。
 *
 * 现在：
 *   memory.json            —— **总记忆**：不分局的、跟谁聊都成立的东西
 *                             我是谁、我喜欢什么、我讨厌什么
 *   memory/<会话>.json      —— **会话记忆**：只在这个会话里成立的
 *                             在这里的心情、在这里经历的事、和这里的人的关系、聊过的话题
 *
 * 划分依据是"换个人聊还成不成立"：
 *   · "我喜欢白饭" 换谁都成立 → 总记忆
 *   · "搞完老爱逗我" 换个人聊就不该提 → 会话记忆
 *
 * 两条数据流（跟以前一样，只是各走两份）：
 *   读 → renderMemory() 把两层压成一段短文，塞进每次回复请求的提示词
 *   写 → applyMemoryPatch() 把模型返回的「差异」合并回两个文件
 *
 * 设计上刻意保留的几个选择（都有踩坑记录，别随手改）：
 *
 * 1. **模型返回的是差异，不是整份文件。**
 *    让模型每次重写整份 JSON 的后果：字段被漏抄、格式被改坏、
 *    output token 翻好几倍。合并、去重、截断、限长全部由本地代码做 —— 模型说了不算。
 *
 * 2. **一切都有上限。** 记忆要塞进每一轮提示词，不设上限只会越滚越长。
 *
 * 3. **任何脏数据都不许抛异常。** 记忆文件是模型间接写出来的，也可能被人手改坏。
 *
 * 4. **落盘用「临时文件 + rename」。** 直接覆写的话，写到一半被杀进程就留下半截 JSON。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 各项上限。config.memory.limits 可以覆盖其中任何一个。 */
export const DEFAULT_LIMITS = {
  events: 40,        // 「做过什么事」最多留几条
  relations: 20,     // 记住几个群友
  likes: 20,
  dislikes: 15,
  facts: 20,         // 关于自己的事实
  topics: 20,
  itemChars: 60,     // 单条最长多少字（超出截断加省略号）
  digestChars: 900,  // 渲染出来的整段最长多少字（硬上限）
};

/** 总记忆文件里的说明。 */
/** 人设目录里的总记忆文件名（跟会话文件同住一个目录，靠名字区分）。 */
const GLOBAL_IN_PERSONA = '_global.json';

export const MEMORY_COMMENT_GLOBAL = [
  '总记忆：不分跟谁聊都成立的东西（我是谁、喜欢什么、讨厌什么）。',
  '',
  '每个会话还有自己的一份，在 memory/ 目录下（心情、经历、和那里的人的关系、话题）。',
  '划分依据是「换个人聊还成不成立」。',
  '',
  '可以手工改：改完重启机器人（或点控制台「重新读取」）即可。',
  '注意每个列表都有条数上限，超出时旧的会被丢掉；单条过长会被截断。',
  '$comment 开头的键不会被读取。',
];

/** 会话记忆文件里的说明。 */
export const MEMORY_COMMENT_CONVERSATION = [
  '会话记忆：只在这个会话里成立的东西。',
  '心情、在这里经历的事、和这里的人的关系、聊过的话题。',
  '',
  '总记忆在上一层的 memory.json（我是谁、喜欢什么、讨厌什么）。',
  'conversation 字段记录这个文件对应的会话原名，别手改它 —— 改了就找不到对应关系了。',
  '',
  '可以手工改：改完重启机器人（或点控制台「重新读取」）即可。',
  '$comment 开头的键不会被读取。',
];

// ---------------------------------------------------------------- 形状 ----

/** 总记忆：跟谁聊都成立的东西。 */
export function emptyGlobal() {
  return { version: 1, updatedAt: null, facts: [], likes: [], dislikes: [] };
}

/** 会话记忆：只在这个会话里成立的东西。 */
export function emptyConversation(conversation = '') {
  return {
    version: 1,
    updatedAt: null,
    // 一律存**稳定标识**（见 conversationKey）：成员数之类的尾巴不能进标识，
    // 否则同一个群会因为成员数变化被当成两个会话。
    conversation: conversationKey(conversation),
    mood: { label: '', why: '', at: null },
    events: [],
    relations: [],
    topics: [],
  };
}

/** 两层一起给，调用方少写一点。 */
export function emptyStore(conversation = '') {
  return { global: emptyGlobal(), conversation: emptyConversation(conversation) };
}

/**
 * 把两层拍平成一层（老形状）。
 *
 * 存在的理由：一是让调用方偶尔只想看全部内容时方便，
 * 二是**旧的单文件形状就是这个**，兼容代码和迁移都靠它。
 */
export function flattenStore(store) {
  const g = store?.global ?? {};
  const c = store?.conversation ?? {};
  return {
    version: c.version ?? g.version ?? 1,
    updatedAt: c.updatedAt ?? g.updatedAt ?? null,
    conversation: c.conversation ?? '',
    facts: g.facts ?? [],
    likes: g.likes ?? [],
    dislikes: g.dislikes ?? [],
    mood: c.mood ?? { label: '', why: '', at: null },
    events: c.events ?? [],
    relations: c.relations ?? [],
    topics: c.topics ?? [],
  };
}

// ---------------------------------------------------------------- 路径 ----

/**
 * 现在生效的是哪个**人设**（身份）。
 *
 * 为什么会在这里读到 state.json：记忆按人设分目录存（`memory/<人设>/…`），
 * 所以每一次解析路径都得知道"现在是谁"。把它放在路径函数内部读一次，
 * 好处是**所有调用方一个字都不用改**（loadStore / saveStore / 控制台的记忆视图
 * 都会自动跟着当前人设走）；代价是每次多读一个小文件 ——
 * 记忆操作一轮就几次，这点开销可以忽略。
 *
 * 没建过人设（personaProfile 为空）→ 返回空串 → 走老路径
 *（`memory.json` + `memory/*.json`），老用户的文件结构原样不动。
 */
export function activePersonaOf(root) {
  try {
    const f = path.join(root ?? process.cwd(), 'state.json');
    // 同样去 BOM：state.json 用户也可能手工改（记事本另存就会带 BOM），
    // 带 BOM 时解析失败会**静默退回"没有人设"** —— 记忆于是写去了老位置，
    // 表面上什么都没报错，人设的记忆却是空的。
    const raw = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    return String(raw?.personaProfile ?? '').trim();
  } catch {
    return '';
  }
}

function memoryDirOf(cfg, root) {
  const name = String(cfg?.memory?.dir ?? 'memory');
  return path.isAbsolute(name) ? name : path.resolve(root ?? process.cwd(), name);
}

/** 某个人设的记忆目录（没给人设就是老的那一层）。 */
export function personaMemoryDirOf(cfg, root, persona) {
  const base = memoryDirOf(cfg, root);
  const p = String(persona ?? '').trim();
  return p ? path.join(base, p) : base;
}

export function memoryDir(cfg, root) {
  return memoryDirOf(cfg, root);
}

/**
 * 总记忆文件路径。cfg.memory.file 是相对项目根的。
 *
 * ⚠ 有当前人设时，总记忆也**收进人设目录**：`memory/<人设>/_global.json`。
 *   为什么连"总记忆"也要分：它按定义是"不分跟谁聊都成立的东西（我是谁、喜欢什么）"，
 *   而"我是谁"恰恰是人设决定的 —— 两个身份不该共用同一份自我认知。
 *   这跟"会话记忆按会话分"是同一条理由，只是维度从"跟谁聊"换成了"谁在聊"。
 */
export function globalMemoryFile(cfg, root) {
  const persona = activePersonaOf(root);
  if (persona) return path.join(personaMemoryDirOf(cfg, root, persona), GLOBAL_IN_PERSONA);
  const name = String(cfg?.memory?.file ?? 'memory.json');
  return path.isAbsolute(name) ? name : path.resolve(root ?? process.cwd(), name);
}

/** 旧名字，保留是为了不打断已有调用方。 */
export function memoryFile(cfg, root) {
  return globalMemoryFile(cfg, root);
}

/** 小哈希，只用来给不安全的会话名做后缀。 */
function hashSeed(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 会话名 → **稳定的标识**（记忆按它分文件、按它查）。
 *
 * 为什么需要它（实测踩到）：同一个群，标题在不同时刻会读出两种写法：
 *   「示例群」        纯群名
 *   「示例群（10）」   带成员数
 * 于是记忆按会话分文件之后，**同一个群被拆成了两份文件** ——
 * 用户在控制台看到两份、关系分散在两处，正是这次要解决的问题。
 *
 * 所以做两件事：
 *   · 去掉尾部的成员数后缀（成员数天天在变，不能进标识）
 *   · 全角括号统一成半角（输入法/客户端不同会导致同一名字有两种写法）
 *
 * 注意只处理会影响**身份**的部分，别顺手把名字改得认不出来 ——
 * 这个名字要显示给用户看。
 */
export function conversationKey(conversation) {
  let s = String(conversation ?? '').trim();
  s = s.replace(/[（(]\d{1,5}[)）]\s*$/, '').trim();   // 去掉 「（10）」 这类成员数
  s = s.replace(/（/g, '(').replace(/）/g, ')');        // 全角括号统一
  return s;
}

/**
 * 会话名 → 安全的文件名。
 *
 * 会话名是 QQ 里的昵称/群名，什么字符都可能有：
 * 实测这个群里就有人拿一串颜文字当昵称，**中间带斜杠**，
 * 直接当文件名会跑到别的目录去。
 *
 * （这条注释别把那串颜文字原样抄进来 —— 它中间含「星号+斜杠」，
 *   会把块注释提前闭合、整个文件语法报错。这个坑我已经踩了四次。）
 *
 * 规则：
 *   · 先取 conversationKey（去掉成员数这类会变的尾巴）
 *   · 保留中文/字母/数字/`-`/`_`，其余换成 `_`
 *   · 换过字符（也就是可能撞名）时补一个短哈希，保证不同会话不共用一个文件
 *   · 全是符号的（比如纯颜文字）只留哈希
 */
export function conversationSlug(conversation) {
  const s = conversationKey(conversation);
  if (!s) return 'unknown';
  const safe = s.replace(/[^\p{L}\p{N}\-_]/gu, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  const short = [...safe].slice(0, 40).join('');
  const changed = short !== s;
  const h = hashSeed(s).toString(36).slice(0, 6);
  if (!short) return `c-${h}`;
  return changed ? `${short}-${h}` : short;
}

export function conversationMemoryFile(cfg, root, conversation) {
  const persona = activePersonaOf(root);
  const dir = persona ? personaMemoryDirOf(cfg, root, persona) : memoryDirOf(cfg, root);
  return path.join(dir, `${conversationSlug(conversation)}.json`);
}

/**
 * 把"上一个人设/老位置"的记忆**拷**进新的人设目录，只在需要时做一次。
 *
 * 为什么是"拷"不是"搬"：老用户的 `memory.json` + `memory/*.json` 是攒下来的东西，
 * 搬一旦出错就是不可逆的丢数据。拷完老文件原样留着，代价只是多占几 KB。
 *
 * 两种来源，用途不同：
 *   · `from: 'legacy'`（默认）—— 从**项目根那层**拷。只在"第一次启用多身份"时用：
 *     用户原来就有一份记忆，切到第一个人设时不能让他看到"记忆全没了"。
 *   · `from: 'persona:<名字>'` —— 从**另一个人设**那儿拷。用于"克隆当前这份身份"
 *     （勾了"复制当前这份当起点"），新身份从同一段经历接着走。
 *
 * 幂等：目标目录里只要已经有文件就不动（避免把后来的新记忆覆盖成旧副本）。
 *
 * @returns {{copied:string[], skipped:boolean, error?:string}}
 */
export function seedPersonaMemory(cfg, root, persona, opts = {}) {
  const name = String(persona ?? '').trim();
  if (!name) return { copied: [], skipped: true };
  const target = personaMemoryDirOf(cfg, root, name);
  let existed = [];
  try {
    existed = fs.readdirSync(target).filter((f) => f.toLowerCase().endsWith('.json'));
  } catch { /* 目录还不存在 —— 正常，下面会建 */ }
  if (existed.length > 0) return { copied: [], skipped: true };

  const copied = [];
  const srcs = [];
  const from = String(opts.from ?? 'legacy');

  if (from.startsWith('persona:')) {
    // 从另一个人设的记忆目录拷（克隆身份）
    const srcPersona = from.slice('persona:'.length).trim();
    const srcDir = personaMemoryDirOf(cfg, root, srcPersona);
    try {
      for (const f of fs.readdirSync(srcDir)) {
        if (!f.toLowerCase().endsWith('.json')) continue;
        srcs.push([path.join(srcDir, f), f]);
      }
    } catch { /* 那边也没有记忆就算了 */ }
  } else {
    // 老的总记忆在项目根目录（config.memory.file），**不是** globalMemoryFile() ——
    // 那个函数有当前人设时会指向人设目录，正好是我们要往里拷的目标。
    const legacyGlobalFile = path.isAbsolute(String(cfg?.memory?.file ?? 'memory.json'))
      ? String(cfg?.memory?.file)
      : path.resolve(root ?? process.cwd(), String(cfg?.memory?.file ?? 'memory.json'));
    if (fs.existsSync(legacyGlobalFile)) srcs.push([legacyGlobalFile, GLOBAL_IN_PERSONA]);
    const legacyDir = memoryDirOf(cfg, root);
    try {
      for (const f of fs.readdirSync(legacyDir)) {
        if (!isConversationFile(f)) continue;      // 子目录（别人设的）和 _global 都不算
        srcs.push([path.join(legacyDir, f), f]);
      }
    } catch { /* 没有老目录就算了 */ }
  }

  if (srcs.length === 0) return { copied: [], skipped: false };
  try {
    fs.mkdirSync(target, { recursive: true });
    for (const [from, to] of srcs) {
      fs.copyFileSync(from, path.join(target, to));
      copied.push(to);
    }
  } catch (e) {
    return { copied, skipped: false, error: String(e?.message ?? e) };
  }
  return { copied, skipped: false };
}

// ---------------------------------------------------------------- 清洗 ----

function limitsOf(cfg) {
  const l = cfg?.memory?.limits ?? {};
  const out = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(DEFAULT_LIMITS)) {
    const v = Number(l[k]);
    if (Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
  }
  return out;
}

/** 把任意值压成一条短字符串。非字符串/空值返回 ''。 */
function str(v, max) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return '';          // 对象/数组不该出现在这里，直接丢掉
  let s = String(v).replace(/\s+/g, ' ').trim();
  if (max > 0 && [...s].length > max) s = [...s].slice(0, max).join('') + '…';
  return s;
}

/** 字符串数组：去空、去重、逐条截断、按上限保留**最新的**（尾部）。 */
function strList(v, maxItems, maxChars) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const s = str(item, maxChars);
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(-maxItems);
}

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** 总记忆的清洗。**永不抛、永不返回 undefined。** */
export function sanitizeGlobal(raw, cfg) {
  const L = limitsOf(cfg);
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const out = emptyGlobal();
  out.version = num(src.version) ?? 1;
  out.updatedAt = typeof src.updatedAt === 'string' ? src.updatedAt : null;
  out.facts = strList(src.facts, L.facts, L.itemChars);
  out.likes = strList(src.likes, L.likes, L.itemChars);
  out.dislikes = strList(src.dislikes, L.dislikes, L.itemChars);
  return out;
}

/** 会话记忆的清洗。**永不抛、永不返回 undefined。** */
export function sanitizeConversation(raw, cfg) {
  const L = limitsOf(cfg);
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  // 存**稳定标识**（去掉成员数那种会变的尾巴），不是原始读到的字符串 ——
  // 否则同一个群会因为成员数变化被当成两个会话（见 conversationKey）。
  const out = emptyConversation(conversationKey(typeof src.conversation === 'string' ? src.conversation : ''));

  out.version = num(src.version) ?? 1;
  out.updatedAt = typeof src.updatedAt === 'string' ? src.updatedAt : null;

  // ---- 心情 ----
  const m = (src.mood && typeof src.mood === 'object' && !Array.isArray(src.mood)) ? src.mood : {};
  out.mood = { label: str(m.label, 20), why: str(m.why, L.itemChars), at: num(m.at) };

  out.topics = strList(src.topics, L.topics, L.itemChars);

  // ---- 做过什么事（带时间和人）----
  const ev = Array.isArray(src.events) ? src.events : [];
  const events = [];
  for (const e of ev) {
    if (typeof e === 'string') {
      const text = str(e, L.itemChars);
      if (text) events.push({ at: null, text, who: '' });
      continue;
    }
    if (!e || typeof e !== 'object') continue;
    const text = str(e.text, L.itemChars);
    if (!text) continue;
    events.push({ at: num(e.at), text, who: str(e.who, 20) });
  }
  out.events = events.slice(-L.events);

  // ---- 和这个会话里的人的关系 ----
  // 用 Map 去重：同名的**后一条覆盖前一条**（模型可能在一次补丁里先写错再改对），
  // 但顺序按第一次出现的顺序保留。
  const rel = Array.isArray(src.relations) ? src.relations : [];
  const byName = new Map();
  for (const r of rel) {
    if (!r || typeof r !== 'object') continue;
    const name = str(r.name, 20);
    if (!name) continue;
    byName.set(name, { name, role: str(r.role, 20), note: str(r.note, L.itemChars), at: num(r.at) });
  }
  out.relations = [...byName.values()].slice(-L.relations);

  return out;
}

/**
 * 把外面给的东西整成 { global, conversation }。
 *
 * 关键兼容点：**旧形状（扁平的一份）会被正确拆成两层** ——
 * facts/likes/dislikes 归总记忆，mood/events/relations/topics 归会话记忆。
 * 迁移旧文件和兼容旧调用都靠它。
 */
export function sanitizeStore(raw, cfg, conversationName = '') {
  const isStoreShape = raw && typeof raw === 'object'
    && (raw.global !== undefined || raw.conversation !== undefined)
    && raw.conversation !== null && typeof raw.conversation === 'object';

  if (isStoreShape) {
    return {
      global: sanitizeGlobal(raw.global, cfg),
      conversation: sanitizeConversation(raw.conversation, cfg),
    };
  }

  const flat = (raw && typeof raw === 'object') ? raw : {};
  const conv = sanitizeConversation(flat, cfg);
  if (!conv.conversation && conversationName) conv.conversation = String(conversationName);
  return { global: sanitizeGlobal(flat, cfg), conversation: conv };
}

// ---------------------------------------------------------------- 读写 ----

/**
 * 原子落盘：先写 .tmp 再 rename。半截 JSON 等于记忆全丢，而且是静默的。
 *
 * 导出是为了让 life.js 复用同一套落盘方式 —— 生活日志同样怕写坏，
 * 而"每个模块各写一遍落盘"正是那种改了一处忘一处的坑。
 */
export function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);          // 同目录 rename 是原子的
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    return { ok: false, error: e?.message ?? String(e) };
  }
  return { ok: true };
}

/**
 * 读一个 JSON 文件。**永不抛**：不存在 / 读不动 / 解析失败都只回报原因。
 *
 * ⚠ 开头的 BOM 要去掉（`\uFEFF`）：Windows 记事本另存 UTF-8 时**默认带 BOM**，
 *   而这些记忆文件是鼓励用户手工改的（"改完重启机器人"）。带 BOM 时
 *   `JSON.parse` 直接抛，表现是"这份记忆读不出来"——
 *   控制台把它标成坏文件、机器人当它不存在，**但文件本身完全正常**，
 *   用户根本不会想到是编码的问题（实测踩到：我用 PowerShell 写了个验证文件就这样）。
 *   config.js / life.js / persona.js 早就去了，这里之前漏了。
 */
export function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, reason: e?.code === 'ENOENT' ? 'missing' : `read:${e?.code ?? e?.message}` };
  }
  try {
    return { ok: true, data: JSON.parse(text.replace(/^\uFEFF/, '')) };
  } catch (e) {
    return { ok: false, reason: `parse:${e.message}` };
  }
}

function withComment(memory, comment) {
  const out = { $comment: comment };
  for (const [k, v] of Object.entries(memory)) {
    if (k === '$comment') continue;
    out[k] = v;
  }
  return out;
}

export function loadGlobal(cfg, root) {
  const file = globalMemoryFile(cfg, root);
  const r = readJson(file);
  if (!r.ok) return { memory: emptyGlobal(), ok: false, reason: r.reason, path: file };
  // 兼容：如果这个文件其实是旧形状（含会话字段），仍然把属于总记忆的部分读出来
  return { memory: sanitizeGlobal(r.data, cfg), ok: true, path: file };
}

export function loadConversation(cfg, root, conversation) {
  const file = conversationMemoryFile(cfg, root, conversation);
  const r = readJson(file);
  if (!r.ok) return { memory: emptyConversation(conversation), ok: false, reason: r.reason, path: file };
  const mem = sanitizeConversation(r.data, cfg);
  if (!mem.conversation) mem.conversation = String(conversation ?? '');
  return { memory: mem, ok: true, path: file };
}

export function saveGlobal(cfg, memory, root) {
  const clean = sanitizeGlobal(memory, cfg);
  clean.updatedAt = new Date().toISOString();
  const file = globalMemoryFile(cfg, root);
  const w = writeJsonAtomic(file, withComment(clean, MEMORY_COMMENT_GLOBAL));
  return { ok: w.ok, memory: clean, error: w.error, path: file };
}

export function saveConversation(cfg, memory, root, conversation) {
  const clean = sanitizeConversation(memory, cfg);
  if (!clean.conversation) clean.conversation = String(conversation ?? '');
  clean.updatedAt = new Date().toISOString();
  const file = conversationMemoryFile(cfg, root, clean.conversation || conversation);
  const w = writeJsonAtomic(file, withComment(clean, MEMORY_COMMENT_CONVERSATION));
  return { ok: w.ok, memory: clean, error: w.error, path: file };
}

/** 两层一起读。 */
export function loadStore(cfg, root, conversation) {
  const g = loadGlobal(cfg, root);
  const c = loadConversation(cfg, root, conversation);
  return {
    store: { global: g.memory, conversation: c.memory },
    sources: {
      global: { ok: g.ok, reason: g.reason ?? null, path: g.path },
      conversation: { ok: c.ok, reason: c.reason ?? null, path: c.path },
    },
  };
}

/**
 * 两层一起写。
 *
 * ⚠ 只写**传进来的**那一层：`{ conversation: {...} }` 不会动总记忆。
 *
 * 为什么要有这条规则（实测踩到）：调用方常常只关心一层 ——
 * 比如"只更新某个会话的记忆"。如果这里无脑把两层都写一遍，
 * 那么传进来的 `global` 是空对象时会把**总记忆整个清掉**，
 * 而调用方根本不知道自己做了一件破坏性的事。
 * 现在只有显式给了某一层才会写它。
 */
export function saveStore(cfg, store, root, conversation) {
  const name = conversation || store?.conversation?.conversation || '';
  const hasGlobal = store?.global !== undefined && store?.global !== null;
  const hasConv = store?.conversation !== undefined && store?.conversation !== null;

  const g = hasGlobal ? saveGlobal(cfg, store.global, root) : null;
  const c = hasConv ? saveConversation(cfg, store.conversation, root, name) : null;

  if (!g && !c) return { ok: false, global: null, conversation: null, error: '两层都没给，什么都没写' };
  return {
    ok: (g?.ok ?? true) && (c?.ok ?? true),
    global: g,
    conversation: c,
    error: g?.error ?? c?.error,
  };
}

/**
 * 列出 memory/ 目录下所有会话记忆（控制台面板用）。
 * 读坏的文件也会列出来并标注，不要静默跳过 —— 那样用户会以为记忆丢了。
 */
/**
 * 这个文件名算不算"一个会话的记忆"。
 *
 * ⚠ `_global.json`（人设目录里的总记忆）**不算** —— 它跟会话文件住在同一个目录，
 *   但按 `.json` 一把捞会把"总记忆"显示成一个叫 `_global` 的会话
 *   （实测就是这么冒出来的：控制台的会话列表里多了一条 `_global`）。
 */
export function isConversationFile(name) {
  const f = String(name ?? '');
  return f.toLowerCase().endsWith('.json')
    && !f.toLowerCase().endsWith('.tmp')
    // ⚠ 小写比较：Windows 的文件系统不分大小写，扩展名判断本来也是小写比的，
    //   这里要是大小写敏感就会漏掉一个 `_GLOBAL.JSON`（那文件跟 _global.json 是同一个）。
    && f.toLowerCase() !== GLOBAL_IN_PERSONA.toLowerCase();
}

export function listConversations(cfg, root) {
  // 有当前人设时扫的是**它的**目录（memory/<人设>/），不是根那层 ——
  // 否则控制台会列出别人设的会话，甚至把 `memory/<人设>/` 这个子目录当成一个"会话文件"。
  const persona = activePersonaOf(root);
  const dir = persona ? personaMemoryDirOf(cfg, root, persona) : memoryDirOf(cfg, root);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(isConversationFile);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.sort()) {
    const full = path.join(dir, f);
    const r = readJson(full);
    if (!r.ok) {
      out.push({ file: f, conversation: '', ok: false, reason: r.reason, counts: null });
      continue;
    }
    const mem = sanitizeConversation(r.data, cfg);
    out.push({
      file: f,
      conversation: mem.conversation || f.replace(/\.json$/, ''),
      ok: true,
      updatedAt: mem.updatedAt,
      mood: mem.mood.label,
      counts: { events: mem.events.length, relations: mem.relations.length, topics: mem.topics.length },
    });
  }
  return out;
}

/**
 * 一次性迁移：把旧的单文件记忆拆成两层。
 *
 * 旧文件里 facts/likes/dislikes 属于总记忆；mood/events/relations/topics
 * 是**在那个会话里积累的**，所以归到 currentConversation 那一份。
 *
 * 只在「旧文件是旧形状」且「memory/ 目录还不存在」时动手，
 * 并且先备份旧文件 —— 迁移这种事做错一次就是数据没了。
 *
 * @returns {{migrated:boolean, reason:string, backup?:string, conversationFile?:string}}
 */
export function migrateLegacy(cfg, root, currentConversation) {
  const legacyFile = globalMemoryFile(cfg, root);
  const dir = memoryDirOf(cfg, root);
  const conv = String(currentConversation ?? '').trim();

  const r = readJson(legacyFile);
  if (!r.ok) return { migrated: false, reason: r.reason === 'missing' ? 'no-legacy' : r.reason };

  const looksLegacy = r.data && typeof r.data === 'object'
    && !r.data.global && !r.data.conversation
    && (Array.isArray(r.data.relations) || Array.isArray(r.data.events) || r.data.mood);
  if (!looksLegacy) return { migrated: false, reason: 'already-split' };
  if (fs.existsSync(dir)) return { migrated: false, reason: 'memory-dir-exists' };
  if (!conv) return { migrated: false, reason: 'no-conversation' };

  const backup = `${legacyFile}.legacy-${Date.now()}`;
  try {
    fs.copyFileSync(legacyFile, backup);
  } catch (e) {
    return { migrated: false, reason: `backup-failed:${e?.message ?? e}` };
  }

  const store = sanitizeStore(r.data, cfg, conv);
  store.conversation.conversation = conv;
  const g = saveGlobal(cfg, store.global, root);
  const c = saveConversation(cfg, store.conversation, root, conv);
  if (!g.ok || !c.ok) return { migrated: false, reason: 'write-failed', backup };

  return { migrated: true, reason: 'ok', backup, conversationFile: c.path };
}

// -------------------------------------------------------------- 渲染 ----

/**
 * 把两层记忆渲染成一段短文，塞进提示词。
 *
 * 为什么不用 JSON：给模型看的 JSON 又占 token 又难读，
 * 而这些内容本来就是「自然语言记忆」。渲染成短文，同样的信息量 token 少一截。
 *
 * 空记忆返回 ''，调用方据此跳过注入 —— 不要往提示词里塞「（暂无记忆）」，
 * 那既浪费 token 又会让模型无端提起"我还没有记忆"。
 */
export function renderMemory(input, cfg) {
  const L = limitsOf(cfg);
  const store = sanitizeStore(input, cfg);
  const g = store.global;
  const c = store.conversation;
  const lines = [];

  // ---- 总记忆那部分 ----
  if (g.facts.length) lines.push(`关于你自己：${g.facts.join('；')}`);
  if (g.likes.length) lines.push(`你喜欢：${g.likes.join('、')}`);
  if (g.dislikes.length) lines.push(`你不喜欢：${g.dislikes.join('、')}`);

  // ---- 这个会话里的那部分 ----
  const here = c.conversation ? `在「${c.conversation}」里` : '在这里';
  if (c.mood.label) {
    lines.push(`${here}你现在的心情：${c.mood.label}${c.mood.why ? `（${c.mood.why}）` : ''}`);
  }

  if (c.events.length) {
    lines.push(`你${here}经历的事（新的在后面）：`);
    // 最多渲染 10 条，按时间倒序（新的在上）——记忆里存的是全部，渲染是有选择的
    for (const e of c.events.slice(-10).reverse()) {
      const when = e.at
        ? `${new Date(e.at).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} `
        : '';
      const who = e.who ? `（跟${e.who}）` : '';
      lines.push(`  · ${when}${e.text}${who}`);
    }
  }

  if (c.relations.length) {
    lines.push(`${here}你认识的人：`);
    for (const r of c.relations.slice(-12)) {
      const role = r.role ? `（${r.role}）` : '';
      lines.push(`  · ${r.name}${role}${r.note ? `：${r.note}` : ''}`);
    }
  }

  if (c.topics.length) lines.push(`${here}聊过的话题：${c.topics.join('、')}`);

  if (lines.length === 0) return '';

  const body = lines.join('\n');
  const truncated = [...body].length > L.digestChars;
  const capped = truncated ? [...body].slice(0, L.digestChars).join('') + '…' : body;

  const head = [
    '【你的记忆】下面是你记得的事。聊天时可以自然用上，但注意：',
    '· 不要一条条念出来，也不要主动炫耀你记得什么',
    '· 被问到时可以自然地提，不确定的别硬说',
    '· 这里面「哪个会话」分得很清楚：别的会话里的人和事，在这个会话里不要提',
  ];
  if (truncated) head.push('（你的记忆太长，下面只截取了前面一部分）');
  return [...head, capped].join('\n');
}

// -------------------------------------------------------------- 合并 ----

/**
 * 机器人自己的名字不算「群友」。
 *
 * 实测踩过：QQ 里自己发的消息**也带**一行头部（LV + 称号 + 自己的名字），
 * 解析器把它当成了"别人的发送者行"，于是记忆里凭空多出一个叫「示例昵称」的群友，
 * 还把自己说过的话记成别人的经历。解析器已经修了，这里再加一道：
 * 记忆是**永久**的，一条假关系会一直占着名额，把真人挤出去。
 */
function selfNamesOf(cfg) {
  return new Set((cfg?.trigger?.botNames ?? []).map((n) => String(n).trim()).filter(Boolean));
}

/**
 * 关系里一律拒收的占位名。
 *
 * 为什么需要：解析器拿不到发送者昵称时会把发送者写成「某人」，
 * 整理器看到「某人：@示例昵称 早」就真的会建一条「某人」的关系 ——
 * 一条永远没用的记忆，还长期占着 relations 的名额。
 */
const PLACEHOLDER_NAMES = new Set([
  '某人', '有人', '某群友', '群友', '对方', '未知', '不详', '匿名', '一个群友',
  '你', '我', '他', '她', '它', '大家', '所有人', '管理员', '群主', '某人说',
]);

/** 太短的话题是噪音（「早」「哦」这种）。 */
const TOPIC_MIN_CHARS = 2;

/**
 * 名字长到不太像单个昵称时给个标记。
 *
 * 为什么不删：光靠长度判断不可靠 —— 这个群里真有人拿一长串颜文字当昵称。
 * 标出来用户能在控制台面板里一眼看到，自己决定留不留。
 * （写注释时别把那个颜文字原样抄进来：它中间含「星号+斜杠」，会提前闭合块注释。）
 */
function warnIfSuspiciousName(name) {
  return [...String(name)].length > 12;
}

function findRelation(relations, name) {
  const key = String(name).trim();
  if (!key) return -1;
  return relations.findIndex((r) => r.name === key);
}

/** 追加型列表的公共逻辑。minChars 用来滤噪音。 */
function appendList(target, field, value, label, limit, itemChars, changes, minChars = 1) {
  const add = strList(value, limit, itemChars).filter((s) => [...s].length >= minChars);
  let n = 0;
  for (const s of add) {
    if (!target[field].includes(s)) { target[field].push(s); n++; }
  }
  if (target[field].length > limit) target[field] = target[field].slice(-limit);
  if (n > 0) changes.push(`+${label}${n}`);
  return n;
}

function removeFromList(target, field, value, label, limit, itemChars, changes) {
  const del = strList(value, limit, itemChars);
  let n = 0;
  for (const s of del) {
    const i = target[field].indexOf(s);
    if (i >= 0) { target[field].splice(i, 1); n++; }
  }
  if (n > 0) changes.push(`-${label}${n}`);
}

/** 总记忆部分的补丁。 */
function applyGlobalPatch(global, patch, cfg, now, changes) {
  const L = limitsOf(cfg);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
  appendList(global, 'facts', patch.addFacts, '自己的事', L.facts, L.itemChars, changes);
  appendList(global, 'likes', patch.addLikes, '喜欢', L.likes, L.itemChars, changes);
  appendList(global, 'dislikes', patch.addDislikes, '讨厌', L.dislikes, L.itemChars, changes);
  removeFromList(global, 'likes', patch.removeLikes, '喜欢', L.likes, L.itemChars, changes);
  removeFromList(global, 'dislikes', patch.removeDislikes, '讨厌', L.dislikes, L.itemChars, changes);
}

/** 会话记忆部分的补丁。 */
function applyConversationPatch(conversation, patch, cfg, now, prefix, changes) {
  const L = limitsOf(cfg);
  const selfNames = selfNamesOf(cfg);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;

  // ---- 心情 ----
  const pm = patch.mood;
  if (pm && typeof pm === 'object' && !Array.isArray(pm)) {
    const label = str(pm.label, 20);
    const why = str(pm.why, L.itemChars);
    // 心情没变就不记一条变更（不然每轮都刷"心情已更新"，日志全是噪音）
    if (label && (label !== conversation.mood.label || why !== conversation.mood.why)) {
      conversation.mood = { label, why, at: now };
      changes.push(`${prefix}心情→${label}`);
    }
  }

  appendList(conversation, 'topics', patch.addTopics, `${prefix}话题`, L.topics, L.itemChars, changes, TOPIC_MIN_CHARS);
  removeFromList(conversation, 'topics', patch.removeTopics, `${prefix}话题`, L.topics, L.itemChars, changes);

  // ---- 做过什么事 ----
  const rawEvents = Array.isArray(patch.addEvents) ? patch.addEvents : [];
  let addedEvent = 0;
  for (const e of rawEvents) {
    const text = str(typeof e === 'string' ? e : e?.text, L.itemChars);
    if (!text) continue;
    let who = str(typeof e === 'string' ? '' : e?.who, 20);
    // 当事人写成机器人自己 → 那不是"跟谁"，抹掉（见 selfNamesOf 的注释）
    if (selfNames.has(who)) who = '';
    // 同一条事不重复记（模型经常会重复汇报同一件事）
    if (conversation.events.some((x) => x.text === text)) continue;
    conversation.events.push({ at: num(e?.at) ?? now, text, who });
    addedEvent++;
  }
  if (conversation.events.length > L.events) conversation.events = conversation.events.slice(-L.events);
  if (addedEvent > 0) changes.push(`${prefix}经历+${addedEvent}`);

  // ---- 和这里的人的关系（按名字 upsert）----
  const rawRel = Array.isArray(patch.relations) ? patch.relations : [];
  for (const r of rawRel) {
    if (!r || typeof r !== 'object') continue;
    const name = str(r.name, 20);
    if (!name) continue;
    if (PLACEHOLDER_NAMES.has(name)) continue;   // 占位名一律不收
    if (selfNames.has(name)) continue;           // 机器人自己不是群友
    const role = str(r.role, 20);
    const note = str(r.note, L.itemChars);
    if (!role && !note) continue;                // 什么都没有就别建一条空关系
    const i = findRelation(conversation.relations, name);
    if (i >= 0) {
      const cur = conversation.relations[i];
      if (cur.role === role && cur.note === note) continue;   // 没变
      conversation.relations[i] = { name, role: role || cur.role, note: note || cur.note, at: now };
      changes.push(`${prefix}关系~${name}`);
    } else {
      conversation.relations.push({ name, role, note, at: now });
      changes.push(warnIfSuspiciousName(name) ? `${prefix}关系+${name}(?)` : `${prefix}关系+${name}`);
    }
  }
  if (conversation.relations.length > L.relations) {
    // 到上限就得丢最旧的。丢的时候要吭一声，否则「它怎么把我忘了」没法排查
    const dropped = conversation.relations.length - L.relations;
    conversation.relations = conversation.relations.slice(-L.relations);
    if (dropped > 0) changes.push(`${prefix}关系已满${L.relations}，忘了${dropped}个最旧的`);
  }
}

/**
 * 把模型返回的「差异」合并进记忆。
 *
 * 模型说什么都要过一遍这里：类型不对就忽略、超长就截断、
 * 重复就不加、超上限就丢最旧的。模型只负责"提建议"。
 *
 * 补丁可以有两种形状：
 *   · 分层：{ global: {...}, conversation: {...} }   ← 现在用的
 *   · 扁平：{ mood, addEvents, relations, addTopics, addFacts, ... }  ← 旧形状，照样认
 *     （扁平时 addFacts/addLikes 归总记忆，其余归会话记忆）
 *
 * @returns {{store:{global,conversation}, global, conversation, memory, changes:string[]}}
 *   memory 是拍平后的视图，方便调用方/测试直接用
 */
export function applyMemoryPatch(input, patch, cfg, now = Date.now()) {
  const store = sanitizeStore(input, cfg);
  const changes = [];

  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { store, global: store.global, conversation: store.conversation, memory: flattenStore(store), changes };
  }

  const layered = patch.global !== undefined || patch.conversation !== undefined;
  const gPatch = layered ? patch.global : patch;
  const cPatch = layered ? patch.conversation : patch;

  applyGlobalPatch(store.global, gPatch, cfg, now, changes);
  applyConversationPatch(store.conversation, cPatch, cfg, now, '', changes);

  return {
    store,
    global: store.global,
    conversation: store.conversation,
    memory: flattenStore(store),
    changes,
  };
}

// -------------------------------------------------------------- 节流 ----

/**
 * 该不该在这次回复后更新记忆。
 *
 * 两种节流，都是为了让「每次都更新」不至于把 token 烧光：
 *   updateEvery         每 N 次回复更新一次（默认 1 = 每次都更新）
 *   updateMinIntervalMs 两次更新之间至少隔多久（默认 0 = 不限）
 *
 * ⚠ 契约：**调用方必须先把 state.memoryReplyCount 加 1，再问这里。**
 *    那个计数是「一共回了多少条」，不是「成功整理过几次」。
 *    一开始写成了后者：计数只在整理成功时才加，于是 updateEvery=3 时
 *    前两次被挡下、计数没动，n 永远是 1，n%3 永远不等于 0 ——
 *    节流把自己锁死，记忆永远不更新（而且是静默的）。测试抓到的。
 *
 * @returns {{ok:boolean, reason:string}}
 */
export function shouldUpdateMemory(cfg, state, now = Date.now()) {
  const c = cfg?.memory ?? {};
  if (!c.enabled) return { ok: false, reason: 'disabled' };

  const every = Number(c.updateEvery);
  if (Number.isFinite(every) && every > 1) {
    const step = Math.floor(every);
    const n = Number(state?.memoryReplyCount) || 0;
    if (n <= 0 || n % step !== 0) {
      return { ok: false, reason: `每 ${step} 次整理一次（这是第 ${n} 次）` };
    }
  }

  const gap = Number(c.updateMinIntervalMs);
  if (Number.isFinite(gap) && gap > 0) {
    const last = Number(state?.memoryUpdatedAt) || 0;
    if (last && now - last < gap) {
      return { ok: false, reason: `距上次更新才 ${Math.round((now - last) / 1000)}s（下限 ${Math.round(gap / 1000)}s）` };
    }
  }
  return { ok: true, reason: 'ok' };
}

/** 变更摘要写成一行日志。空摘要返回 ''（调用方据此跳过日志）。 */
export function summarizeChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) return '';
  return changes.join('、');
}

// ============================================================================
// 旧「单文件」格式的兼容层
// ============================================================================
// 分层之前所有内容挤在一份 memory.json 里。下面这几个函数保留下来，
// 是因为有两处真的还需要它们：
//   1. migrateLegacy() 迁移旧文件时要按旧形状读写
//   2. 已有测试是按旧形状写的，保持可用可以少改五十来处断言
//
// ⚠ 机器人主循环（bot.js）**不用**这几个 —— 它走 loadStore/saveStore。
//    把它们当成"旧格式的读写工具"，不要在新代码里用。

/** 旧形状的一份空记忆（拍平视图）。 */
export function emptyMemory() {
  return flattenStore(emptyStore());
}

/** 把任意输入整成旧形状的合法记忆。永不抛、永不返回 undefined。 */
export function sanitizeMemory(raw, cfg) {
  return flattenStore(sanitizeStore(raw, cfg));
}

/**
 * 按**旧格式**读总记忆文件（拍平视图）。
 * 新代码请用 loadStore / loadGlobal。
 */
export function loadMemory(cfg, root) {
  const file = globalMemoryFile(cfg, root);
  const r = readJson(file);
  if (!r.ok) return { memory: emptyMemory(), ok: false, reason: r.reason, path: file };
  return { memory: flattenStore(sanitizeStore(r.data, cfg)), ok: true, path: file };
}

/**
 * 按**旧格式**写总记忆文件（拍平视图），供迁移和旧测试用。
 * 新代码请用 saveStore / saveGlobal + saveConversation。
 */
export function saveMemory(cfg, memory, root) {
  const flat = flattenStore(sanitizeStore(memory, cfg));
  flat.updatedAt = new Date().toISOString();
  const file = globalMemoryFile(cfg, root);
  const w = writeJsonAtomic(file, withComment(flat, MEMORY_COMMENT_GLOBAL));
  return { ok: w.ok, memory: flat, error: w.error, path: file };
}
