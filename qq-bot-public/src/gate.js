/**
 * gate.js — 决定「这条消息该不该回」。
 *
 * 五道闸门，任何一道不过就不回复：
 *   1. 会话白名单/黑名单         —— 白名单为空时全部拒绝（安全默认）
 *   2. 只回他人消息             —— 自己发的（含机器人自己刚发出去的）跳过
 *   3. 去重                     —— 同一条消息不重复回
 *   4. 冷却 + 频率上限           —— 防止刷屏、防止代码出 bug 时无限回
 *   5. 群里必须被 @            —— 私聊直接回
 *
 * 另外防自嗨：机器人发出去的文本会登记到 sentReplies，扫描时读到同样的文本一律跳过，
 * 否则「我回复 → 截到自己的回复 → 再回复」会形成死循环。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, isReplyTarget, REPLY_REJECT_TEXT } from './config.js';
import { isMentioned, normalizeText } from './parse.js';
import { effectiveReplyProbability } from './takeover.js';
// 会话名匹配只有这一处实现（sessions.js 是纯逻辑、不 import 任何东西，不会有循环依赖）。
// 队列按会话挑（findPendingFor）必须和"切会话时怎么算同一个会话"用同一套规则 ——
// 两套规则不一致的后果是：明明在同一个群里，队列却认为"不是这个会话"，一条都不发。
import { sessionMatches } from './sessions.js';
// 系统消息过滤（QQ 自己的提示语，不是人说的话）—— 规则表在 system-msg.js
import { classifySystemMessage } from './system-msg.js';

const STATE_FILE = path.join(ROOT, 'state.json');
const MAX_SEEN = 500;
const MAX_SENT = 200;
const MAX_TIMES = 200;
const MAX_PENDING = 50;
const MAX_HANDLED = 300;   // 「这句话刚回过」的记录条数上限（约 10 分钟内的量）

export function loadState() {
  const base = {
    seen: [], sentReplies: [], replyTimes: [], pending: [], handled: [],
    scannedAt: null, counters: {},
    // 「AI 接管模式」开关。存在这里而不是 config，是为了运行时切换不用重启。
    takeoverEnabled: undefined,
  };
  try {
    if (fs.existsSync(STATE_FILE)) {
      // ⚠ 去 BOM：state.json 用户可能手工改过（记事本另存 UTF-8 默认带 BOM）。
      //   带 BOM 时这里会解析失败 → 落到 base（空状态）→
      //   **去重台账和待回复队列全丢**，表现就是"同一条消息被回了两三次"。
      //   这条踩过：这正是之前那个"轮询时重复回复"的复发路径之一。
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, ''));
      return { ...base, ...raw };
    }
  } catch {}
  return base;
}

export function saveState(state) {
  try {
    const trimmed = {
      ...state,
      seen: state.seen.slice(-MAX_SEEN),
      sentReplies: state.sentReplies.slice(-MAX_SENT),
      replyTimes: state.replyTimes.slice(-MAX_TIMES),
      pending: (state.pending ?? []).slice(-MAX_PENDING),
      handled: (state.handled ?? []).slice(-MAX_HANDLED),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
  } catch {}
}

// ------------------------------------------------- 「这句话刚回过」------------
//
// 为什么在 `seen` 之外还要单独记一份（用户报的「轮询时同一条被回多次」）：
//
// `seen` 的去重键是 `会话|方向|文本`，而且**会被 pruneSeenToWindow 按窗口清理**。
// 轮询把这件事的两处软肋同时放大了：
//   1. **同一条消息在不同轮会解析出不同的文本**。实测（真实日志）：
//      QQ 的长系统消息一次读到全文「该用户通过“临时会话谨防兼职刷单…」，
//      另一次只剩前半段「该用户通过“」—— 指纹一变，旧记录被当成"已滚出窗口"清掉，
//      于是新指纹被当成新消息，**同一条消息又回了一遍**。
//   2. 轮询会读到**部分窗口**（界面正在重画、UIA 偶尔少给几个元素），
//      那一轮里"刚才还在"的消息不在窗口里 → 它的 seen 记录同样被清掉 →
//      下一轮读全了又是"新消息"。
//
// 结果就是用户看到的现象：同一条消息隔几分钟被回第二次（实测「你是谁」被回了两次）。
//
// 所以：**只要回过一次，就单独记一笔**（不受窗口清理影响，按时间过期），
// 决策时先看这一笔。判定要点是"同一个会话 + 同一句话"，
// 并且能认出"被截断的同一句"（归一化后一个是另一个的前缀）。
//
// ⚠ 不能简单地"这句话回过就永不回"：真人会**故意重复发同一句**
//   （连发两次「在吗」很常见）。所以还要求：窗口里**只看得见一次**这个文本 ——
//   如果窗口里明明白白有两条一样的，那第二条就是新发的，该回。
const HANDLED_TTL_MS = 10 * 60 * 1000;

/** 归一化：空白、换行、全半角差异都不该影响"是不是同一句"。 */
const normForDedupe = (t) => String(t ?? '').replace(/\s+/g, '').trim();

/** 记一笔"这句话我回过了"。由 enqueuePending 调用（进了队列就算回过了）。 */
function rememberHandled(state, conversation, side, text, now = Date.now()) {
  const t = normForDedupe(text);
  if (!t) return;
  state.handled = (state.handled ?? []).filter((h) => now - (h.at ?? 0) < HANDLED_TTL_MS);
  const conv = String(conversation ?? '');
  if (state.handled.some((h) => h.conv === conv && h.side === side && h.text === t)) return;
  state.handled.push({ conv, side, text: t, at: now });
  if (state.handled.length > MAX_HANDLED) state.handled = state.handled.slice(-MAX_HANDLED);
}

/**
 * 这句话是不是"刚才已经回过的那一条"？
 *
 * 除了完全相同，还认一种情况：**同一条消息被读成了不同长度**（见上面那段注释）。
 * 要求"较长的那一侧 ≥ 8 字"，免得把「你好」和「你好啊」这种真的两句短话并成一句 ——
 * 短消息最容易互为前缀，误判的代价是"漏回一句"，比重复刷屏更隐蔽。
 */
function alreadyHandled(state, conversation, side, text, now = Date.now()) {
  const t = normForDedupe(text);
  if (!t) return false;
  const conv = String(conversation ?? '');
  for (const h of state.handled ?? []) {
    if (now - (h.at ?? 0) >= HANDLED_TTL_MS) continue;
    if (h.conv !== conv || h.side !== side) continue;
    if (h.text === t) return true;
    const longer = h.text.length >= t.length ? h.text : t;
    const shorter = h.text.length >= t.length ? t : h.text;
    if (shorter.length >= 8 && longer.startsWith(shorter)) return true;
  }
  return false;
}

/**
 * 待回复队列。
 *
 * 为什么需要它（这里踩过一个真实的坑）：
 * 冷却闸门原本只在「本轮扫描」里生效，被冷却挡下的消息直接丢弃。
 * 但下一轮扫描会**重新**发现同一条消息、**重新**撞冷却、**再**丢弃 ——
 * 结果冷却永远重置，这些消息永远发不出去。
 * 单轮扫描看不出来，只有连续扫描才会暴露。
 *
 * 所以被冷却挡下的消息要入队，等冷却过了再发。
 */
export function enqueuePending(state, decision) {
  state.pending = state.pending ?? [];
  const exists = state.pending.some((p) => p.fp === decision.fingerprint);
  if (exists) return false;
  // 进了队列就算"回过"：记进独立账本，供 decide 的第二道去重闸门用
  //（见 alreadyHandled 的注释：轮询下 seen 会被窗口清理误清）。
  rememberHandled(state, decision.conversation, decision.message.side, decision.message.text);
  state.pending.push({
    fp: decision.fingerprint,
    conversation: decision.conversation,
    side: decision.message.side,
    sender: decision.message.sender ?? '',
    text: decision.message.text,
    mentioned: Boolean(decision.mentioned),
    queuedAt: Date.now(),
  });
  return true;
}
export function peekPending(state, now = Date.now(), ttlMs = 10 * 60 * 1000) {
  state.pending = state.pending ?? [];
  // 太旧的丢掉：消息可能已经滚出屏幕，或者本来就过期了
  state.pending = state.pending.filter((p) => now - (p.queuedAt ?? 0) < ttlMs);
  return state.pending[0] ?? null;
}

export function shiftPending(state) {
  state.pending = state.pending ?? [];
  return state.pending.shift() ?? null;
}

/**
 * 取下一条**属于这个会话**的待回复消息（不改动队列）。
 *
 * 为什么不能永远拿队头（改这里的原因）：
 *   以前只监测**当前打开的那一个**聊天，队列里必然全是这个会话的消息，
 *   拿队头没问题。现在开了「轮询全部会话」（autoSwitch.scope = all），
 *   队列里会同时积压好几个会话的消息 —— 而发送是往**当前屏幕显示的那个**聊天发的。
 *   拿队头就会把这句回错人：在「测试群」排队的那句话，会在轮到私聊那一屏时发进私聊。
 *   （`conversation` 一直存在队列项里，只是以前没有第二个会话，所以从没暴露。）
 *
 * 只跳过、不丢弃：别的会话那条留在队列里，等轮询转回去再发。
 * 队列本身有 10 分钟 TTL（见 peekPending），所以不会永远卡住。
 *
 * @returns {{item:object, index:number}|null}
 */
export function findPendingFor(state, conversation, now = Date.now(), ttlMs = 10 * 60 * 1000) {
  state.pending = state.pending ?? [];
  state.pending = state.pending.filter((p) => now - (p.queuedAt ?? 0) < ttlMs);
  const conv = String(conversation ?? '');
  // 会话名读不出来时**不猜**：拿不准这一屏是谁，就不发（宁可晚一轮，也不能回错人）
  if (!conv) return null;
  const index = state.pending.findIndex((p) => (
    sessionMatches(conv, p.conversation) || sessionMatches(p.conversation, conv)
  ));
  return index < 0 ? null : { item: state.pending[index], index };
}

/** 出队指定位置的那一条（用 findPendingFor 给的 index）。 */
export function shiftPendingAt(state, index) {
  state.pending = state.pending ?? [];
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= state.pending.length) return null;
  return state.pending.splice(i, 1)[0] ?? null;
}

/** 队列里当前压着哪些会话（日志用：说清楚"为什么这一轮没发"）。 */
export function pendingConversations(state) {
  const list = (state.pending ?? []).map((p) => String(p.conversation ?? '(未知会话)'));
  return [...new Set(list)];
}

/** 群聊判定：QQ 群名常带成员数，如「示例群（10）」。 */
export function isGroupConversation(name, cfg) {
  const n = normalizeText(name);
  if (!n) return false;
  if (/[（(]\d{1,5}[)）]$/.test(n)) return true;
  return (cfg.trigger?.groupNames ?? []).some((g) => g && n.includes(normalizeText(g)));
}

/**
 * 判断这行是不是机器人自己刚发出去的内容（防自嗨）。
 *
 * 阈值从 4 改成 2 是踩坑后的修正：发送出 bug 时机器人只发出了一个字符 "v"，
 * 因为 `sn.length >= 4` 不成立而被当成「别人的新消息」，于是又回一个 "v"，
 * 形成自循环刷屏。短回复（"在的"、"早"）本来就必须支持，所以下限放宽到 2。
 */
export function isBotOwnMessage(text, state) {
  const t = normalizeText(text);
  if (!t) return false;
  return state.sentReplies.some((s) => {
    const sn = normalizeText(s);
    if (!sn) return false;
    if (sn === t) return true;
    return sn.length >= 2 && (t.includes(sn) || sn.includes(t));
  });
}

/** 频率闸门。任一阈值设为 0 表示该项不限制。 */
export function rateLimitCheck(cfg, state, now = Date.now()) {
  const trig = cfg.trigger ?? {};
  const cooldown = Number(trig.cooldownMs ?? 0);
  const perMin = Number(trig.maxRepliesPerMinute ?? 0);

  if (cooldown > 0) {
    const last = state.replyTimes.length ? state.replyTimes[state.replyTimes.length - 1] : 0;
    if (last && now - last < cooldown) {
      return { ok: false, reason: 'cooldown', waitMs: cooldown - (now - last) };
    }
  }

  if (perMin > 0) {
    const recent = state.replyTimes.filter((t) => now - t < 60000);
    if (recent.length >= perMin) {
      return { ok: false, reason: 'rate-limit', count: recent.length, limit: perMin };
    }
  }

  return { ok: true };
}

/**
 * 对一组消息做决策。
 * @returns {{conversationName:string, isGroup:boolean, whitelisted:boolean, decisions:Array}}
 */
export function decide(cfg, state, parsed, now = Date.now()) {  const conversationName = parsed.conversation ?? '';
  // 群聊判定优先用解析器给出的结论（UIA 路线能拿到「群聊成员」「群主/管理员」这类证据，
  // 而 OCR 路线的群名带成员数）。只有解析器没给的时候才回退到按名字猜。
  // 踩过坑：UIA 读到的群名不带成员数，靠名字猜会把群聊判成私聊，
  // 于是「群里只在被 @ 时回复」这道闸门形同虚设。
  const isGroup = (typeof parsed.isGroup === 'boolean')
    ? parsed.isGroup
    : isGroupConversation(conversationName, cfg);
  // 会话级总闸门（白名单模式 / 回复所有对话）—— 见 config.js 的 isReplyTarget。
  // 以前这里是一句 `isWhitelisted && !isBlacklisted`，拒绝原因也只写
  // 「会话不在白名单（或命中黑名单）」，于是"白名单为空""名字拼错""命中黑名单"
  // 三种情况长得一模一样，排查只能靠猜。现在原因分开报。
  const target = isReplyTarget(cfg, conversationName);
  const allow = target.ok;
  const trig = cfg.trigger ?? {};

  const decisions = [];
  const seen = new Set(state.seen);

  // 这一屏里每个「方向+文本」出现了第几次（从 0 数）。
  //
  // 为什么需要它：判断"这句话刚回过"必须区分两种情况 ——
  //   · 窗口里只有一条「在吗」，而我刚回过一条「在吗」 → 是同一条被重复读到了，别回
  //   · 窗口里有**两条**「在吗」（有人连发两次）       → 第二条是新发的，该回
  // 所以一边遍历一边数出现次数：第 0 次算"旧的那条"，第 1 次及以后算新的。
  const occSoFar = new Map();
  const occurrenceOf = (side, text) => {
    const key = `${side}|${normForDedupe(text)}`;
    const n = occSoFar.get(key) ?? 0;
    occSoFar.set(key, n + 1);
    return n;
  };

  for (const m of parsed.messages) {
    const fp = `${parsed.conversation}|${m.side}|${m.text}`;
    const base = { message: m, conversation: conversationName, isGroup, fingerprint: fp };
    const occ = occurrenceOf(m.side, m.text);

    if (!allow) {
      decisions.push({ ...base, reply: false, reason: REPLY_REJECT_TEXT[target.why] ?? '会话不在允许范围内' });
      continue;
    }
    if (m.side === 'self') {
      decisions.push({ ...base, reply: false, reason: '自己发的消息' });
      continue;
    }
    if (m.side === 'incoming' && isBotOwnMessage(m.text, state)) {
      decisions.push({ ...base, reply: false, reason: '这行是机器人自己刚发出去的回复（防自嗨）' });
      continue;
    }

    // ---- 系统消息：QQ 自己的提示语，不是人说的话 ----
    //
    // 为什么要单独一道闸门（真实日志）：
    //   轮询那轮里有 3 条回复是在回 QQ 的提示 ——
    //     「临时会话」「该用户通过“临时会话谨防兼职刷单…」「该用户通过“」（截断的同一句）
    //   回它既没意义，又一眼能看出这边是机器人。规则表在 src/system-msg.js，
    //   每条都注明了实测依据和"为什么不误伤真人"。
    const sys = classifySystemMessage(m.text, cfg);
    if (sys.system) {
      decisions.push({ ...base, reply: false, reason: `系统消息（${sys.name}）`, system: true });
      continue;
    }
    if (seen.has(fp)) {
      decisions.push({ ...base, reply: false, reason: '已处理过（去重）' });
      continue;
    }

    // ---- 「这句话刚回过」的第二道闸门 ----
    //
    // 为什么不靠上面那道 `seen` 就够：`seen` 会被 pruneSeenToWindow 按窗口清理，
    // 而轮询下同一句话在不同轮可能**解析成不同的文本**（长消息被截断）、
    // 或者某一轮只读到部分窗口 —— 两种都会让 seen 记录被误清，
    // 于是一条老消息又被当成新的回一遍（实测：同一条「你是谁」隔 3 分钟被回了两次）。
    //
    // `handled` 是"回过就记一笔"的独立账本（按时间过期，不受窗口清理影响）。
    // ⚠ 但只有**窗口里只看得见一条**这个文本时才拦：看得见两条 = 人家真的发了两次。
    if (occ === 0 && alreadyHandled(state, conversationName, m.side, m.text, now)) {
      decisions.push({ ...base, reply: false, reason: '同一句话刚回过（去重）' });
      continue;
    }

    const mentioned = isMentioned(m, cfg);

    // 群里「只在被 @ 时回复」：命中就直接通过，不再看概率
    const mentionOnly = trig.replyInGroupOnlyWhenMentioned !== false;
    if (mentionOnly && !mentioned && (isGroup || trig.applyMentionRuleToPrivate === true)) {
      decisions.push({ ...base, reply: false, reason: '群消息但没被 @', mentioned });
      continue;
    }

    // ---- 回复概率 ----
    // 被 @ 一定回（除非显式关掉）；其他消息按概率。
    //
    // 生效概率由 takeover.effectiveReplyProbability 计算：
    // 接管模式期间默认变成 1（每条都回），退出后恢复配置值。
    //
    // 掷骰子**只在这里做一次**，结果随 decision 带进 pending 队列冻结下来。
    // 如果放到发送阶段每次重掷，同一条消息会被反复抽签 —— 概率失真，
    // 低概率时甚至可能永远抽不中，表现成"消息被吞了"。
    const prob = effectiveReplyProbability(state, cfg);
    let roll = 1;
    let rollSkipped = false;
    if (!Number.isNaN(prob) && prob !== undefined) {
      const needRoll = mentioned ? trig.mentionAlwaysReplies === false : true;
      if (needRoll && prob < 1) {
        roll = Math.random();
        if (roll >= prob) rollSkipped = true;
      }
    }

    if (rollSkipped) {
      decisions.push({
        ...base, reply: false, mentioned,
        reason: `概率未命中（${(prob * 100).toFixed(0)}%）`,
        roll,
      });
      continue;
    }

    decisions.push({
      ...base, reply: true, mentioned, roll,
      reason: mentioned ? '被 @，必回' : '通过全部闸门',
    });
  }

  return { conversationName, isGroup, whitelisted: allow, scope: target.mode, scopeWhy: target.why, decisions };
}

/** 登记一条已处理的消息，避免重复回复。 */
export function markSeen(state, fingerprint) {
  if (!state.seen.includes(fingerprint)) state.seen.push(fingerprint);
}

/**
 * 把 seen 收敛成「**当前还在窗口里**的消息」。
 *
 * 为什么必须做这件事（用户报的「被@的消息有时候不会回，连队列都没进」）：
 *
 * 去重键是 `${会话}|${side}|${文本}` —— 没有时间、没有发送者、没有位置。
 * 它本来只想解决一个问题：窗口每 4 秒被重读一次，同一条消息会被反复决策，
 * 所以处理过就登记下来。但它分不清这两种情况：
 *   · 同一条消息被重复读到        → 应该去重
 *   · **新发的一句话，文本一模一样** → 不该去重（那是人刚说的）
 * 结果第二种被当成第一种杀掉：`已处理过（去重）`，既不回也不进队列。
 * 而 seen 能留 500 条，小群里等于"这句话你这辈子别再想让它回了"。
 *
 * 实测复现：
 *   第 1 次「@示例昵称 测试一下」→ 被 @，必回
 *   第 2 次一模一样的新消息      → 已处理过（去重）  ← 队列都没进
 *
 * 收敛的依据很直接：**滚出窗口的消息不可能被重复读到**，
 * 所以它的去重记录已经没有用了，留着只会误伤。清掉之后，
 * "同一条还在屏幕上"照样去重，"新发的同一句话"能正常回。
 *
 * @returns {{before:number, after:number, dropped:number}}
 */
export function pruneSeenToWindow(state, parsed) {
  const before = (state.seen ?? []).length;
  const conv = parsed?.conversation ?? '';
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];

  // ⚠ 窗口读空了不许清。解析失败（QQ 最小化、UIA 降级失败）时 parsed.messages 是空的，
  // 照清的话 seen 会被整个抹掉，等窗口恢复时所有消息都会被当成"新的"回一遍。
  if (messages.length === 0) return { before, after: before, dropped: 0 };

  const live = new Set(messages.map((m) => `${conv}|${m.side}|${m.text}`));
  const prefix = `${conv}|`;

  state.seen = (state.seen ?? []).filter((fp) => {
    // 别的会话的记录不动 —— 它们不在这个窗口里，不能拿这个窗口去判断
    if (typeof fp !== 'string' || !fp.startsWith(prefix)) return true;
    return live.has(fp);
  });

  const after = state.seen.length;
  return { before, after, dropped: before - after };
}

/** 登记一条机器人发出的回复文本，用于防自嗨。 */
export function markSent(state, text) {
  const t = normalizeText(text);
  if (t && !state.sentReplies.includes(t)) state.sentReplies.push(t);
}

export function markReplied(state, now = Date.now()) {
  state.replyTimes.push(now);
}
