/**
 * life.js — 「人生模拟」：没在聊天的时候，它自己在过日子。
 *
 * 用户的需求（原话）：
 *   「每5次控制台检测后，如果此时API没有被调用，使用该API进行人生模拟，
 *     即通过给定的提示词以及设定推测真人行为，并记成日志保存」
 *
 * 翻译成这套代码里的事：
 *   · 每 N 次「控制台检测」（就是主循环每轮开头那次探活）检查一次
 *   · 这段时间里**一次 API 都没调用过**（没人跟它说话、也没整理过记忆）才动手
 *   · 用配置里的提示词 + 人设 + 记忆，让模型推演「这个人在此刻会干什么、想什么」
 *   · 结果按时间顺序存成日志（life.json），并注入后续回复的提示词
 *
 * 为什么要做这件事：不聊天的时候它是个空壳 —— 上一句说「我在吃饭」，
 * 半小时后接着说「我在吃饭」，一眼假。有了生活日志，两句话之间就有了时间线。
 *
 * 三个刻意的设计选择（都有理由，别随手改）：
 *
 * 1. **只写自己的 life.json，绝不碰 memory.json。**
 *    生活模拟是**异步**跑的（见 bot.js），而记忆整理在发完回复后同步跑。
 *    两边都去读-改-写同一份 memory.json 的话，早晚互相覆盖。
 *    分开文件 = 没有竞态，代价只是多一个文件。
 *
 * 2. **决策逻辑是纯函数式的小状态机（createLifeTicker），不碰 IO。**
 *    "第几次检测""这窗口里调过 API 吗"这种判断最容易写错，而且错了很难看出来
 *    （表现只是"它怎么不模拟"或"它怎么一直在模拟"）。抽出来才能单测。
 *
 * 3. **不管模型返回什么脏东西都不许抛。** 和 memory.js 同一条规矩：
 *    内容由模型产生，格式由本地代码说了算。
 */

import path from 'node:path';
import fs from 'node:fs';
import { readJson, writeJsonAtomic, conversationSlug } from './memory.js';
import { sessionMatches } from './sessions.js';

/** 生活日志文件的说明（写进 json 里，用户手改时能看懂）。 */
export const LIFE_COMMENT = [
  '生活日志：机器人不聊天的时候，自己去「过日子」的记录（人生模拟）。',
  '',
  '每条是模型根据人设 + 记忆推演出来的：此刻的心情、在做什么、在想什么。',
  '按时间从旧到新排列，超过上限时丢最旧的（上限见 config.life.maxEntries）。',
  '',
  '这份日志会作为「你最近在做什么」注入回复的提示词 ——',
  '目的是让两次对话之间有连贯的时间线，不会半小时后还在做同一件事。',
  '',
  '★ 一份文件 = 一个人的一生。',
  '  切换不同的人的人生就是切换读哪个文件（控制台「人生」那一栏可以切）。',
  '  没被选中的那份**原样躺在磁盘上**，切回去接着过 —— 不需要额外保存。',
  '  profile 字段记的是这个人叫什么，别手改（改了就认不出来了）。',
  '',
  '可以手工改：改完重启机器人（或点控制台「重新读取」）即可。',
  '$comment 开头的键不会被读取。',
];

/** 兜底上限。config.life 里的同名项可以覆盖。 */
export const DEFAULT_LIFE_LIMITS = {
  maxEntries: 200,     // 日志最多留几条
  itemChars: 80,       // 单条字段最长多少字
  digestChars: 400,    // 渲染进提示词的整段硬上限
  contextEntries: 3,   // 渲染进提示词用最近几条
  shareChars: 40,      // 主动分享那句最长多少字
};

/**
 * 「生活时钟」的默认值。
 *
 * 为什么需要它（用户：每次模拟时传递时间）：
 *   原来每次模拟都拿**真实时间**去问模型"你现在在干嘛"，而两次模拟之间只隔
 *   几十秒，提示词里那句「上一次记录是 1 分钟前」等于告诉它"什么都没变" ——
 *   于是它的生活**永远停在同一秒**：实测连续 30 多条全是「窝着刷手机/犯困」。
 *   现在每次模拟把角色的时钟往前推 stepMinutes，模型才有了"过了一段时间"这个前提。
 *
 * maxAheadMinutes 是配套的刹车，用户原话：
 *   「模拟的世界流速与现实不同，如果模拟完后的时间超过现在的时间，
 *     期间可以不用调用API」
 *   也就是：模拟一次就把世界推到 15 分钟之后，那么**接下来的 15 分钟现实里
 *   什么都不用做** —— 世界已经在未来了，等现实追上来再模拟。
 *
 *   这一条的收益比听上去大：
 *     · API 调用从"每 90 秒一次"降到"每 15 分钟一次"（本机实测一次 67~120 秒，
 *       等于原来一直在占着 CPU）
 *     · 角色的时间跟现实基本重合（最多领先一步），主动分享判断"是不是深夜"
 *       才不会失真
 *   0 = 一步都不许领先（默认，就是上面这条规则）。
 *   >0 = 允许领先这么多分钟（想让它多跑一点时用）。
 */
export const DEFAULT_LIFE_CLOCK = {
  stepMinutes: 15,     // 每次模拟推进多少分钟（0 = 关掉，用真实时间）
  maxAheadMinutes: 0,  // 0 = 不许多跑到现实前面；>0 = 最多领先这么多分钟
};

/**
 * 「主动分享」的默认闸门。
 *
 * 为什么一个功能要这么多闸门：这是全项目里**唯一会主动跟真人说话**的地方 ——
 * 没有消息触发它，它自己就会往群里发一句。模型（尤其本地小模型）说"适合分享"
 * 一点都不可靠，所以模型只负责**提议**，发不发由下面这些本地规则说了算
 * （和记忆合并同一条哲学：模型提建议，程序说了算）。
 */
export const DEFAULT_SHARE = {
  enabled: false,        // 默认关：要显式打开（它会跟真人说话）
  probability: 1,        // 模型说适合之后再抽一次（1 = 完全听模型的）
  minIntervalMs: 1800000, // 两次主动分享至少隔 30 分钟
  maxPerDay: 5,          // 一天最多主动说几次（0 = 不限）
  maxChars: 40,          // 那句话的最长字数
  quietFrom: 0,          // 静默时段（小时，0~23）。from===to 表示不启用
  quietTo: 0,
  conversations: [],     // 只在这些会话里分享；留空 = 用 trigger.whitelist
};

/**
 * 把 config.life 整成一份规范值。
 * 缺项一律用默认值 —— 用户只写 `{"enabled": true}` 也该能跑。
 */
export function lifeConfig(cfg) {
  const c = cfg?.life ?? {};
  const L = { ...DEFAULT_LIFE_LIMITS };
  for (const k of Object.keys(DEFAULT_LIFE_LIMITS)) {
    const v = Number(c.limits?.[k]);
    if (Number.isFinite(v) && v > 0) L[k] = Math.floor(v);
  }
  const every = Number(c.everyChecks);
  const gap = Number(c.minIntervalMs);
  const sh = c.share ?? {};
  const clk = { ...DEFAULT_LIFE_CLOCK };
  const step = Number(c.stepMinutes);
  if (Number.isFinite(step) && step >= 0) clk.stepMinutes = step;
  const ahead = Number(c.maxAheadMinutes);
  if (Number.isFinite(ahead) && ahead >= 0) clk.maxAheadMinutes = ahead;  const share = { ...DEFAULT_SHARE };
  share.enabled = sh.enabled === true;
  const p = Number(sh.probability);
  if (Number.isFinite(p)) share.probability = Math.min(1, Math.max(0, p));
  const shGap = Number(sh.minIntervalMs);
  if (Number.isFinite(shGap) && shGap >= 0) share.minIntervalMs = shGap;
  const perDay = Number(sh.maxPerDay);
  if (Number.isFinite(perDay) && perDay >= 0) share.maxPerDay = Math.floor(perDay);
  const maxChars = Number(sh.maxChars);
  if (Number.isFinite(maxChars) && maxChars > 0) share.maxChars = Math.floor(maxChars);
  const from = Number(sh.quietHours?.from);
  const to = Number(sh.quietHours?.to);
  if (Number.isFinite(from) && from >= 0 && from <= 23) share.quietFrom = Math.floor(from);
  if (Number.isFinite(to) && to >= 0 && to <= 23) share.quietTo = Math.floor(to);
  if (Array.isArray(sh.conversations)) {
    share.conversations = sh.conversations.map((s) => String(s ?? '').trim()).filter(Boolean);
  }

  return {
    // enabled 默认 **关**：它会持续调 API，属于"要显式打开"的功能。
    // （用户这次明确要求打开，所以 config.json 里写的是 true。）
    enabled: c.enabled === true,
    everyChecks: Number.isFinite(every) && every >= 1 ? Math.floor(every) : 5,
    file: String(c.file ?? 'life.json'),
    minIntervalMs: Number.isFinite(gap) && gap > 0 ? gap : 0,
    // timeoutMs: **0（或负数）= 不设超时**，一直等本地服务返回。
    // 本地 CPU 推理跑这个长提示词要几分钟，给一个"够大"的数只是把问题往后推；
    // 所以明确支持 0 这一档。没配时才用 60 秒的默认值。
    timeoutMs: Number.isFinite(Number(c.timeoutMs)) ? Number(c.timeoutMs) : 60000,
    maxTokens: Number(c.maxTokens) > 0 ? Number(c.maxTokens) : 600,
    temperature: Number.isFinite(Number(c.temperature)) ? Number(c.temperature) : 1,
    model: String(c.model ?? ''),
    limits: L,
    share,
    clock: clk,
  };
}

/** 生活日志文件路径。cfg.life.file 是相对项目根的。 */
export function lifeFile(cfg, root, profile) {
  const base = root ?? process.cwd();
  const name = String(profile ?? cfg?.life?.profile ?? '').trim();
  // 没指定"这是谁的人生" → 用那份默认的单文件（老行为，兼容已有日志）。
  if (!name) {
    const f = String(cfg?.life?.file ?? 'life.json');
    return path.isAbsolute(f) ? f : path.resolve(base, f);
  }
  const dir = String(cfg?.life?.dir ?? 'lives');
  const abs = path.isAbsolute(dir) ? dir : path.resolve(base, dir);
  return path.join(abs, `${conversationSlug(name)}.json`);
}

/** 多重人生存放的目录。 */
export function livesDir(cfg, root) {
  const d = String(cfg?.life?.dir ?? 'lives');
  return path.isAbsolute(d) ? d : path.resolve(root ?? process.cwd(), d);
}

/**
 * 当前该过谁的人生。
 *
 * 优先级：**state.json 的 lifeProfile** > config.life.profile > '' （默认那份）。
 * 为什么 state 优先：控制台上切换要能立刻作用于**正在跑的**机器人，
 * 而机器人只在启动时读一次 config.json（改了 config 得重启才生效）。
 * 这和「AI 接管」开关存在 state 里是同一个理由。
 */
export function activeProfile(cfg, state) {
  const fromState = state?.lifeProfile;
  if (typeof fromState === 'string' && fromState.trim()) return fromState.trim();
  const fromCfg = cfg?.life?.profile;
  return typeof fromCfg === 'string' ? fromCfg.trim() : '';
}

/**
 * 人生模拟开着吗。state 里的开关优先于 config（理由同上）。
 * state.lifeEnabled 没设过（undefined）时才看 config。
 */
export function lifeEnabled(cfg, state) {
  const v = state?.lifeEnabled;
  if (v === true || v === false) return v;
  return lifeConfig(cfg).enabled;
}

/** 主动分享开着吗。人生模拟关着时它必然也是关的（没模拟就没有可分享的东西）。 */
export function shareEnabled(cfg, state) {
  if (!lifeEnabled(cfg, state)) return false;
  const v = state?.shareEnabled;
  if (v === true || v === false) return v;
  return lifeConfig(cfg).share.enabled;
}

export function emptyLifeLog(profile = '') {
  return { version: 1, updatedAt: null, profile: String(profile ?? ''), entries: [] };
}

function str(v, max) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return '';
  let s = String(v).replace(/\s+/g, ' ').trim();
  if (max > 0 && [...s].length > max) s = [...s].slice(0, max).join('') + '…';
  return s;
}

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * 「要不要主动跟群友说一句」的清点结果。写在生活日志的每条里。
 *
 * 为什么要存进日志（而不是只打一行日志）：这是机器人**主动跟真人说话**的记录。
 * 事后想搞清楚"它那天为什么在群里冒那一句"「为什么一整天没说话」，
 * 就得能看到当时的判断和理由 —— 日志会滚动，生活日志不会。
 */
function sanitizeShare(raw, cfg) {
  const L = lifeConfig(cfg).limits;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const suitable = raw.suitable === true || raw.ok === true || raw.share === true;
  const text = str(raw.text ?? raw.say ?? raw.message, lifeConfig(cfg).share.maxChars);
  const why = str(raw.why ?? raw.reason, 40);
  if (!suitable && !text && !why) return null;
  return { suitable, why, text };
}

/**
 * 下一次模拟该用哪个「现在」。
 *
 * 规则（都在用户的「每次模拟时传递时间」这条要求下定的）：
 *   1. 有上一条记录 → 在它的 lifeAt 上往前推 stepMinutes（这就是"过日子"）
 *   2. 现实时间已经跑到前面去了（机器人停过一段、或时钟落后）→ 以现实为准
 *   3. 没有上一条 → 直接用现实时间（第一天从真实时间开始）
 *
 * 返回的是**角色自己的时钟**，只用于喂给模型和日志显示；记录里另外存真实时间 at。
 *
 * @returns {{lifeAt:number, prevLifeAt:number|null, stepped:boolean}}
 */
export function nextLifeClock(cfg, log, now = Date.now()) {
  const c = lifeConfig(cfg).clock;
  const entries = Array.isArray(log?.entries) ? log.entries : [];
  const prev = entries.length ? entries[entries.length - 1] : null;

  // ⚠ 这里必须显式判 null，不能用 Number.isFinite(Number(x)) ——
  //   Number(null) === 0，而 0 是 finite，于是"没设过 lifeAt"会被当成
  //   "lifeAt = 0"（1970 年），时钟就永远不走了。这个坑我踩了两次（见 CLAUDE 的教训）。
  const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const prevLifeAt = prev ? (numOrNull(prev.lifeAt) ?? numOrNull(prev.at)) : null;

  if (c.stepMinutes <= 0) return { lifeAt: now, prevLifeAt, stepped: false };  // 关掉了：老行为
  if (prevLifeAt === null) return { lifeAt: now, prevLifeAt: null, stepped: false };

  const advanced = prevLifeAt + c.stepMinutes * 60000;
  // 现实更快就以现实为准（否则停了一夜再开，角色还停在昨晚）
  const lifeAt = Math.max(advanced, now);
  return { lifeAt, prevLifeAt, stepped: lifeAt > prevLifeAt };
}

/**
 * 现在该不该模拟 —— 也就是**该不该花这一次 API 调用**。
 *
 * 用户观察到的现象与要求（原话）：
 *   「模拟的世界流速与现实不同，如果模拟完后的时间超过现在的时间，
 *     期间可以不用调用API」
 *
 * 翻译成规则：模拟一次会把角色的世界推到 stepMinutes 之后；只要那个世界
 * **还在现实的前面**，接下来这段时间就什么都不用做 —— 世界已经"过"到那里了，
 * 等现实追上来再模拟。这段时间一次 API 都不调。
 *
 * 副作用正好是我们想要的：调用频率从"每 90 秒一次"变成"每 stepMinutes 一次"，
 * 而且角色的时间跟现实基本重合（最多领先一步），
 * 主动分享判断"是不是深夜"也才靠得住。
 *
 * @returns {{ok:boolean, aheadMinutes:number, waitMinutes:number, reason:string}}
 */
export function lifeClockGate(cfg, log, now = Date.now()) {
  const c = lifeConfig(cfg).clock;
  if (c.stepMinutes <= 0) return { ok: true, aheadMinutes: 0, waitMinutes: 0, reason: 'ok' };

  const { lifeAt: nextLifeAt, prevLifeAt } = nextLifeClock(cfg, log, now);
  if (prevLifeAt === null) return { ok: true, aheadMinutes: 0, waitMinutes: 0, reason: 'ok' };  // 还没有历史

  const aheadMin = (prevLifeAt - now) / 60000;          // 当前这个时钟领先现实多少
  const nextAheadMin = (nextLifeAt - now) / 60000;      // 再模拟一次会领先多少

  if (c.maxAheadMinutes <= 0) {
    // 一步都不许跑到现实前面
    if (aheadMin > 0) {
      const wait = Math.ceil(aheadMin);
      return {
        ok: false,
        aheadMinutes: Math.floor(aheadMin),
        waitMinutes: wait,
        reason: `模拟世界已经走到 ${fmtClock(prevLifeAt)}（领先现实 ${wait} 分钟）`
          + `—— 等现实追上来再模拟，这期间不调用 API`,
      };
    }
    return { ok: true, aheadMinutes: 0, waitMinutes: 0, reason: 'ok' };
  }

  if (nextAheadMin > c.maxAheadMinutes) {
    return {
      ok: false,
      aheadMinutes: Math.floor(nextAheadMin),
      waitMinutes: Math.ceil(nextAheadMin - c.maxAheadMinutes),
      reason: `再模拟一次会领先现实 ${Math.ceil(nextAheadMin)} 分钟（上限 ${c.maxAheadMinutes}）`
        + `—— 等现实追上来`,
    };
  }
  return { ok: true, aheadMinutes: Math.floor(Math.max(0, nextAheadMin)), waitMinutes: 0, reason: 'ok' };
}

/** 把毫秒时间点格式化成 HH:MM，给日志用。 */
function fmtClock(ms) {
  try {
    return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  } catch {
    return String(ms);
  }
}

/** 实际发出去没有（发失败也要留痕，不然"它到底发没发"没法查）。 */function sanitizeShared(raw, cfg) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = str(raw.text, lifeConfig(cfg).share.maxChars);
  return {
    at: num(raw.at) ?? null,
    ok: raw.ok === true,
    sent: raw.sent === true,
    reason: str(raw.reason, 60),
    text,
    conversation: str(raw.conversation, 40),
  };
}

/**
 * 清洗一条生活记录。**永不抛、永不返回 undefined**，全空的返回 null（调用方丢掉）。
 *
 * 只留三个字段是有意的：心情 / 在做 / 在想。
 * 字段一多，模型就会开始编细节（地点、天气、配角），反而更容易前后矛盾。
 * （share/shared 是另外两件事：一个"要不要说"，一个"说了没有"。）
 */
export function sanitizeLifeEntry(raw, cfg, now = Date.now()) {
  const L = lifeConfig(cfg).limits;
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};

  // 模型偶尔只给一句话而不是 JSON（本地小模型尤其常见）。
  // 那种情况当成"在做的事"，总比整条丢掉强 —— 至少时间线是连着的。
  if (typeof raw === 'string') {
    const doing = str(raw, L.itemChars);
    return doing ? { at: num(now) ?? Date.now(), lifeAt: null, mood: '', doing, thinking: '', share: null, shared: null } : null;
  }

  const entry = {
    at: num(src.at) ?? num(now) ?? Date.now(),
    // 角色自己的时钟（"过着日子"的时间），跟真实时间 at 分开存：
    // at 是"这条什么时候记的"（审计用），lifeAt 是"它的世界里现在几点"（喂模型/显示用）。
    lifeAt: num(src.lifeAt),
    mood: str(src.mood, 20),
    doing: str(src.doing ?? src.action ?? src.what, L.itemChars),
    thinking: str(src.thinking ?? src.thought, L.itemChars),
    share: sanitizeShare(src.share, cfg),
    shared: sanitizeShared(src.shared, cfg),
  };
  if (!entry.mood && !entry.doing && !entry.thinking) return null;
  return entry;
}

/** 清洗整份日志。坏的条目丢掉，不是整份丢掉。 */
export function sanitizeLifeLog(raw, cfg, profile = '') {
  const L = lifeConfig(cfg).limits;
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const out = emptyLifeLog(typeof src.profile === 'string' && src.profile ? src.profile : profile);
  out.version = num(src.version) ?? 1;
  out.updatedAt = typeof src.updatedAt === 'string' ? src.updatedAt : null;

  const list = Array.isArray(src.entries) ? src.entries : [];
  const entries = [];
  for (const e of list) {
    const clean = sanitizeLifeEntry(e, cfg, 0);
    if (clean) entries.push(clean);
  }
  // 按时间排序后再截断：手工编辑过的文件顺序可能是乱的，
  // 而"最旧的先丢"依赖顺序正确。
  entries.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  out.entries = entries.slice(-L.maxEntries);
  return out;
}

export function loadLifeLog(cfg, root, profile) {
  const name = String(profile ?? cfg?.life?.profile ?? '').trim();
  const file = lifeFile(cfg, root, name);
  const r = readJson(file);
  if (!r.ok) return { log: emptyLifeLog(name), ok: false, reason: r.reason, path: file, profile: name };
  return { log: sanitizeLifeLog(r.data, cfg, name), ok: true, path: file, profile: name };
}

export function saveLifeLog(cfg, root, log, profile) {
  const name = String(profile ?? log?.profile ?? cfg?.life?.profile ?? '').trim();
  const clean = sanitizeLifeLog(log, cfg, name);
  if (name) clean.profile = name;
  clean.updatedAt = new Date().toISOString();
  const file = lifeFile(cfg, root, name);
  const w = writeJsonAtomic(file, { $comment: LIFE_COMMENT, ...clean });
  return { ok: w.ok, log: clean, error: w.error, path: file };
}

/**
 * 追加一条并落盘。
 *
 * 读-改-写：同一个"人生"只有一个写入方（模拟器本身，而且有单飞保护），
 * 所以这里不需要锁。**别在别处也写这个文件**，否则就要开始考虑并发了。
 *
 * lifeAt（角色时钟）在这里补上：调用方只给真实时间和内容，
 * 时钟的推进规则集中在 nextLifeClock，避免每个调用点各推一次。
 */
export function appendLifeEntry(cfg, root, entry, now = Date.now(), profile) {
  const name = String(profile ?? cfg?.life?.profile ?? '').trim();
  const clean = sanitizeLifeEntry(entry, cfg, now);
  if (!clean) return { ok: false, error: '这条生活记录是空的，没写', total: 0 };

  const { log } = loadLifeLog(cfg, root, name);

  // 去重：doing / thinking / mood 三项与上一条**完全相同**就丢弃。
  //
  // 为什么要在代码里硬拦：提示词里已经写了「同一个状态别连着写三四次」
  // 「每次至少推进一点点」，但实测模型根本不听 —— 生成了三条一字不差的
  // 「躺着刷手机 ｜ 眼皮越来越沉 ｜ 昏昏欲睡」。后果不只是日志难看：
  // 这份日志会注入回复提示词，于是机器人每条回复都复述"困"，
  // 连续三条都是「困到睡着了」。提示词约束失效时，只能靠代码。
  const prev = log.entries.length ? log.entries[log.entries.length - 1] : null;
  if (prev
    && String(prev.doing ?? '') === String(clean.doing ?? '')
    && String(prev.thinking ?? '') === String(clean.thinking ?? '')
    && String(prev.mood ?? '') === String(clean.mood ?? '')) {
    return {
      ok: false,
      duplicate: true,
      error: '与上一条生活记录完全相同，已丢弃',
      total: log.entries.length,
    };
  }

  const clock = nextLifeClock(cfg, log, now);
  // 同上：clean.lifeAt 是 null（没给）时要补上；用 Number.isFinite(Number(null)) 判会漏。
  if (clean.lifeAt === null || clean.lifeAt === undefined) clean.lifeAt = clock.lifeAt;
  log.entries.push(clean);
  log.profile = name;
  const saved = saveLifeLog(cfg, root, log, name);
  return { ok: saved.ok, entry: clean, total: saved.log.entries.length, error: saved.error, path: saved.path };
}

/**
 * 列出所有"人生"（lives/ 目录下一份一个）。
 *
 * 顺带把默认那份（config.life.file，profile 为空）也算进来，
 * 这样用户能一眼看到"当前这份是不是默认那份"。
 */
export function listLives(cfg, root) {
  const dir = livesDir(cfg, root);
  const out = [];

  const mk = (profile, file) => {
    const r = readJson(file);
    if (!r.ok) {
      return {
        profile, file: path.relative(root ?? process.cwd(), file),
        ok: false, reason: r.reason, total: 0, updatedAt: null, lastDoing: '', mood: '',
      };
    }
    const log = sanitizeLifeLog(r.data, cfg, profile);
    const last = log.entries.length ? log.entries[log.entries.length - 1] : null;
    return {
      profile: log.profile || profile,
      file: path.relative(root ?? process.cwd(), file),
      ok: true,
      total: log.entries.length,
      updatedAt: log.updatedAt,
      lastDoing: last?.doing ?? '',
      lastAt: last?.at ?? null,
      mood: last?.mood ?? '',
      // 有多少条是"主动分享过"的 —— 用户最关心的就是它到底在群里说过话没有
      shared: log.entries.filter((e) => e.shared && e.shared.sent).length,
    };
  };

  // 默认那份
  if (!String(cfg?.life?.profile ?? '').trim()) {
    const f = lifeFile(cfg, root, '');
    if (fs.existsSync(f)) out.push(mk('', f));
  }

  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));
  } catch {
    files = [];
  }
  for (const f of files.sort()) out.push(mk('', path.join(dir, f)));

  // 名字相同的去重（默认那份可能刚好也在 lives/ 里）
  const seen = new Set();
  return out.filter((x) => {
    const key = `${x.profile}|${x.file}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 新建一份人生。已存在就拒绝（**绝不覆盖** —— 那是别人积累的时间线）。
 *
 * @param {{seedFrom?:string}} opts seedFrom 给一个人生名，就把那份的内容抄过来当起点
 */
export function createLifeProfile(cfg, root, name, opts = {}) {
  const want = String(name ?? '').trim();
  if (!want) return { ok: false, error: '没给名字' };

  const file = lifeFile(cfg, root, want);
  if (fs.existsSync(file)) return { ok: false, error: `「${want}」已经有一份人生了（${path.relative(root, file)}）`, path: file };

  let log = emptyLifeLog(want);
  if (opts.seedFrom !== undefined) {
    const src = loadLifeLog(cfg, root, opts.seedFrom);
    if (src.ok) log = { ...src.log, profile: want };
  }
  const saved = saveLifeLog(cfg, root, log, want);
  if (!saved.ok) return { ok: false, error: saved.error ?? '写盘失败', path: file };
  return { ok: true, profile: want, path: file, total: saved.log.entries.length };
}

/** 今天已经主动分享过几次。 */
export function countSharesToday(state, now = Date.now()) {
  const list = Array.isArray(state?.shareTimes) ? state.shareTimes : [];
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return list.filter((t) => Number(t) >= start.getTime()).length;
}

/**
 * 这个会话允许被主动分享吗。
 *
 * 名单来源两选一：life.share.conversations（写了就用它）> trigger.whitelist。
 * 白名单为空 = **谁也不发** —— 和回复那条路同一条安全默认：
 * 空名单不是"没限制"，而是"什么都没配，那就别说话"。
 */
export function shareAllowedIn(cfg, conversation) {
  const name = String(conversation ?? '').trim();
  if (!name) return false;

  const sh = lifeConfig(cfg).share;
  if (sh.conversations.length) return sh.conversations.some((w) => sessionMatches(name, w));

  const scope = String(cfg?.trigger?.replyScope ?? 'whitelist').trim().toLowerCase();
  if (scope === 'all') return true;

  const wl = cfg?.trigger?.whitelist ?? [];
  if (wl.length === 0) return false;
  return wl.some((w) => sessionMatches(name, w));
}

/** 记一次分享（调用方负责 saveState）。**发失败也记** —— 见 decideShare 的注释。 */
export function recordShare(state, now, text = '') {
  if (!state || typeof state !== 'object') return state;
  state.lastShareAt = now;
  state.shareTimes = Array.isArray(state.shareTimes) ? state.shareTimes : [];
  state.shareTimes.push(now);
  state.shareTimes = state.shareTimes.slice(-50);
  state.shares = (Number(state.shares) || 0) + 1;
  state.lastShareText = String(text ?? '');
  return state;
}

/**
 * 该不该主动跟群友说一句。
 *
 * 用户的需求原话：「在人生模拟中加入一个额外判断：这个时候是否适合向群友分享，
 * 如果适合，主动进行一次输出」。
 *
 * 所以判断分两层，缺一不可：
 *   1. **模型**读了人设、记忆和"最近在做什么"，说这会儿值不值得说一句（entry.share）
 *   2. **本地规则**再拦一遍：开关、名单、静默时段、间隔、每日上限、概率
 *
 * 为什么不能只信模型：这是全项目唯一会**主动跟真人说话**的地方，
 * 而模型（尤其本地小模型）对"这话该不该说"几乎没什么判断力 ——
 * 它会在凌晨三点说"我在想要不要睡觉"、会把"在刷手机"当新鲜事分享。
 * 让它提议，让规则拍板。
 *
 * @param {object} cfg
 * @param {{entry?:object, conversation?:string, now?:number, state?:object, enabled?:boolean}} ctx
 *   enabled 由调用方显式给（bot.js 用它传"控制台刚改过的开关"）；
 *   不给就按 state/config 现算。
 * @returns {{ok:boolean, reason:string, text?:string, conversation?:string}}
 */
export function decideShare(cfg, ctx = {}) {
  const sh = lifeConfig(cfg).share;
  const now = Number(ctx.now) || Date.now();
  const state = ctx.state ?? {};
  const entry = ctx.entry ?? {};
  const conversation = String(ctx.conversation ?? '').trim();

  const on = ctx.enabled === undefined ? shareEnabled(cfg, state) : ctx.enabled === true;
  if (!on) return { ok: false, reason: '主动分享没开' };
  if (cfg.reply?.dryRun) return { ok: false, reason: 'dryRun 模式，不真发' };

  const s = entry.share;
  if (!s) return { ok: false, reason: '模型没给分享判断' };
  if (!s.suitable) return { ok: false, reason: `模型判断这会儿不适合说${s.why ? `（${s.why}）` : ''}` };

  const text = str(s.text, sh.maxChars);
  if (!text) return { ok: false, reason: '模型说适合，但没给出要说的话' };

  // 只发给"此刻打开着的那个会话"，且它必须在允许名单里。
  // 这既是安全线（绝不发进不该发的群），也解决一个实际问题：
  // 自动切换每隔几秒就换一个聊天，模拟跑完时"当时那个会话"可能早就换掉了。
  if (!shareAllowedIn(cfg, conversation)) {
    return { ok: false, reason: conversation ? `「${conversation}」不在允许分享的名单里` : '读不到当前会话名' };
  }

  if (sh.quietFrom !== sh.quietTo) {
    const h = new Date(now).getHours();
    const quiet = sh.quietFrom < sh.quietTo
      ? (h >= sh.quietFrom && h < sh.quietTo)
      : (h >= sh.quietFrom || h < sh.quietTo);   // 跨零点，比如 23~8
    if (quiet) return { ok: false, reason: `静默时段（${sh.quietFrom}~${sh.quietTo} 点）` };
  }

  const last = Number(state.lastShareAt) || 0;
  if (sh.minIntervalMs > 0 && last && now - last < sh.minIntervalMs) {
    const mins = Math.round((now - last) / 60000);
    return { ok: false, reason: `距上次主动分享才 ${mins} 分钟（下限 ${Math.round(sh.minIntervalMs / 60000)} 分钟）` };
  }
  if (sh.maxPerDay > 0 && countSharesToday(state, now) >= sh.maxPerDay) {
    return { ok: false, reason: `今天已经主动说过 ${sh.maxPerDay} 次了` };
  }
  if (sh.probability <= 0) return { ok: false, reason: '分享概率是 0' };
  if (sh.probability < 1 && Math.random() >= sh.probability) {
    return { ok: false, reason: `抽概率没中（${Math.round(sh.probability * 100)}%）` };
  }

  return { ok: true, reason: '适合分享', text, conversation };
}

/**
 * 改一条已经写进日志的记录（按 at 定位）。
 *
 * 用途：分享发完之后，把"发了什么、成没成"补写回那条记录。
 * 为什么不在发之前就把结果一起写：发一次要几秒，中间要是崩了，
 * 那条生活记录就跟着丢了 —— 而它本身跟分享成不成没关系。
 */
export function updateLifeEntry(cfg, root, at, patch = {}, profile) {
  const { log } = loadLifeLog(cfg, root, profile);
  const i = log.entries.findIndex((e) => e.at === at);
  if (i < 0) return { ok: false, error: '没找到那条生活记录' };
  log.entries[i] = { ...log.entries[i], ...patch };
  const saved = saveLifeLog(cfg, root, log, profile);
  return { ok: saved.ok, entry: sanitizeLifeEntry(log.entries[i], cfg), error: saved.error };
}

/**
 * 把生活日志渲染成一段短文。
 *
 * 两个用途共用它，所以要分清楚读者是谁：
 *   · 回复的提示词（opts.note !== false，默认）—— 末尾要交代"怎么用"，
 *     否则模型会把日志一条条念出来当回复
 *   · 人生模拟自己的提示词（opts.note === false）—— 那次它只是要读自己的
 *     近况接着往下演，"聊天时别念出来"这种话对它是噪音
 *
 * 空日志返回 ''（调用方据此跳过注入）—— 和 renderMemory 同一条规矩：
 * 不要往提示词里塞「（暂无）」，白花 token 还会让模型无端提起它。
 */
export function renderLife(input, cfg, opts = {}) {
  const L = lifeConfig(cfg).limits;
  const log = sanitizeLifeLog(input, cfg);
  if (log.entries.length === 0) return '';

  const head = '【你最近在做什么】你自己过的日子（新的在后面）：';
  const entryLines = [];
  for (const e of log.entries.slice(-L.contextEntries)) {
    // 显示**角色时钟**（lifeAt）：它才是"它的世界里几点"。
    // 老记录没有 lifeAt，退回真实时间，不会显示成空白。
    // ⚠ 判空要显式判 null：Number(null) === 0 会让"没有 lifeAt"显示成 1970。
    const t = (e.lifeAt === null || e.lifeAt === undefined) ? e.at : Number(e.lifeAt);
    const when = t
      ? new Date(t).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
    const parts = [];
    if (e.doing) parts.push(`在做：${e.doing}`);
    if (e.thinking) parts.push(`想着：${e.thinking}`);
    if (e.mood) parts.push(`心情：${e.mood}`);
    if (parts.length === 0) continue;
    entryLines.push(`  · ${when} ${parts.join(' ｜ ')}`);
  }

  const noteLines = [];
  if (opts.note !== false) {
    noteLines.push('（以上只是背景，**不是台词**。回复时不要念这些内容：');
    noteLines.push('  别提你"躺着刷手机"，别答"困""睡了""眼皮沉"这类词，');
    noteLines.push('  也别劝对方"早点睡"——除非对方正好在聊这个。');
    noteLines.push('  只有对方直接问"你在干嘛"时才用得上，那时也只用一次。');
    noteLines.push('  跟这上面别自相矛盾就行：说你刚吃完，就别立刻说还没吃。）');
  }

  // ---- limits.digestChars：整段的硬上限 ----
  //
  // 这里的取舍值得写清楚（改过两版）：
  //   · 曾经"完全不截断"，理由是截断会切掉末尾那段「不要念这些内容」的约束，
  //     而那段正是防复读的关键（实测丢掉它之后连续三条回复都是"困到睡着了"）。
  //   · 但 digestChars 是**配置里承诺过的**硬上限，不执行等于配了没用
  //     （用户配了 40 却拿到 300 字的注入，只会以为功能坏了）。
  //
  // 所以现在两头都要：**先保证说明在，再往里塞记录**，实在放不下才硬截。
  // 说明比多一条记录重要得多 —— 记录少一条只是少一点背景，说明丢了会当场复读。
  const cap = Number(L.digestChars) > 0 ? Number(L.digestChars) : 0;
  if (cap > 0) {
    const noteText = noteLines.join('\n');
    const noteCost = noteLines.length ? [...noteText].length + 1 : 0;   // +1 = 换行
    const parts = [head];
    let used = [...head].length;
    for (const l of entryLines) {
      const cost = [...l].length + 1;
      if (used + cost + noteCost > cap) break;
      parts.push(l);
      used += cost;
    }
    let body = [...parts, ...noteLines].join('\n');
    if ([...body].length > cap) {
      // 连「标题 + 说明」都超了（上限配得极小）：只能硬截，尾巴留省略号
      body = [...body].slice(0, Math.max(1, cap - 1)).join('') + '…';
    }
    return body;
  }

  return [head, ...entryLines, ...noteLines].join('\n');
}

/** 读+渲染，给只用一次的地方省两行。任何失败都返回 ''（提示词少一段不算故障）。 */
export function lifeDigestFor(cfg, root, state) {
  try {
    if (!lifeEnabled(cfg, state)) return '';
    const { log } = loadLifeLog(cfg, root, activeProfile(cfg, state));
    return renderLife(log, cfg);
  } catch {
    return '';
  }
}

/**
 * 「该不该做人生模拟」的小状态机。不碰 IO、不看时钟（now 由调用方给），所以能单测。
 *
 * 判定规则就是用户那句话：
 *   每 everyChecks 次控制台检测 → 看这段时间里有没有调过 API → 没有才模拟
 *
 * ⚠ 最容易写错的一处：**模拟自己那次 API 调用不能算数**。
 *    模拟是靠 apiTotal 的增量判断"有没有调用过"的，而模拟跑完会让 apiTotal 涨 1；
 *    不把它扣掉的话，下一个窗口永远显示"调用过 API"，人生模拟只会发生一次。
 *    所以跑完要调 rebaseline()（bot.js 的 finally 里做了）。
 */
export function createLifeTicker(cfg) {
  let checks = 0;
  let apiMark = null;      // 上次判定时的 API 调用总数
  let lastAt = 0;          // 上次真的模拟是什么时候
  let running = false;     // 上一次模拟还在跑吗（单飞保护）

  return {
    /** 一次控制台检测。state 传进来时以它的开关为准（控制台能实时改）。 */
    tick(apiTotal, now = Date.now(), state = null) {
      const c = lifeConfig(cfg);
      if (!lifeEnabled(cfg, state)) return { ok: false, reason: '人生模拟没开' };

      checks++;
      if (apiMark === null) apiMark = Number(apiTotal) || 0;

      if (checks < c.everyChecks) {
        return { ok: false, reason: `第 ${checks}/${c.everyChecks} 次检测` };
      }
      checks = 0;

      // 这个窗口里调过 API（有人在跟它说话、或刚整理过记忆）→ 它已经在"过日子"了
      const usedApi = (Number(apiTotal) || 0) > apiMark;
      apiMark = Number(apiTotal) || 0;
      if (usedApi) return { ok: false, reason: `这 ${c.everyChecks} 次检测里调用过 API` };

      if (running) return { ok: false, reason: '上一次人生模拟还在跑' };

      if (c.minIntervalMs > 0 && lastAt && now - lastAt < c.minIntervalMs) {
        return { ok: false, reason: `距上次模拟才 ${Math.round((now - lastAt) / 1000)}s（下限 ${Math.round(c.minIntervalMs / 1000)}s）` };
      }

      return { ok: true, reason: `空闲了 ${c.everyChecks} 次检测` };
    },

    /** 派发一次模拟之前调。没调 beginRun 就 endRun 不会出错（幂等）。 */
    beginRun(now = Date.now()) { running = true; lastAt = now; },
    endRun() { running = false; },
    /** 模拟那次 API 调用不该算进"有没有调用过"，跑完把基准抬到当前值。 */
    rebaseline(apiTotal) { apiMark = Number(apiTotal) || 0; },

    /** 只读快照，测试和日志用。 */
    snapshot() { return { checks, apiMark, lastAt, running }; },
  };
}
