/**
 * switch.js — 真正去点会话列表，把 QQ 切到另一个聊天。
 *
 * 为什么要单独一个文件：这是整个项目里**唯一会动用户鼠标**的地方
 * （见 tools/qq-click.ps1）。把它隔离出来，好处有两个：
 *   · 一眼能看到"哪些代码会去点用户的界面"
 *   · 测试里可以只测 sessions.js 的判定，不必真去点
 *
 * 流程：读会话列表（拿最新坐标）→ 找到目标 → 点它的中心 → 等界面刷新
 *
 * ⚠ 坐标必须先读再点。窗口位置、列表滚动都会让坐标过期，
 *   拿旧坐标去点等于随机点界面上的某个东西。
 */

import { runPs } from './ps.js';
import { parseSessions, findSessionPoint, judgeClick, sessionMatches } from './sessions.js';
import { parseUia } from './parse-uia.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * 读一次会话列表。
 * @returns {Promise<{ok:boolean, sessions:Array, error?:string}>}
 */
export async function readSessions({ timeoutMs = 30000 } = {}) {
  try {
    const raw = await runPs('uia-read.ps1', [], { timeoutMs });
    if (!raw || raw.ok !== true) {
      return { ok: false, sessions: [], error: raw?.error ?? 'UIA 读取失败' };
    }
    // handle 也要带回去：点之前得先把 QQ 窗口提到前台，
    // 否则那一下点击会被"激活窗口"吃掉，列表项收不到（实测）。
    return { ok: true, sessions: parseSessions(raw), handle: Number(raw.handle) || 0 };
  } catch (e) {
    return { ok: false, sessions: [], error: e?.message ?? String(e) };
  }
}

/**
 * 读一次"当前打开的是哪个会话"。
 *
 * 这是判断切换成没成功的唯一可靠依据：点击脚本只能说光标落在哪，
 * 界面切没切过去只有读一下才知道。实测两种情况都出现过 ——
 * 落点分毫不差但界面没动（窗口没到前台），以及落点偏了几像素
 * 但界面好好地切过去了。
 *
 * @returns {Promise<{ok:boolean, name:string, error?:string}>}
 */
export async function readCurrentConversation({ cfg = {}, timeoutMs = 30000 } = {}) {
  try {
    const raw = await runPs('uia-read.ps1', [], { timeoutMs });
    if (!raw || raw.ok !== true) {
      return { ok: false, name: '', error: raw?.error ?? 'UIA 读取失败' };
    }
    const parsed = parseUia(raw, cfg);
    return { ok: true, name: String(parsed?.conversation ?? '').trim() };
  } catch (e) {
    return { ok: false, name: '', error: e?.message ?? String(e) };
  }
}

/**
 * 系统级空闲时间（毫秒）：用户最后一次动键鼠到现在过了多久。
 *
 * 失败一律返回 -1，调用方按"用户不忙"处理 —— 见 shouldPauseForUser 的注释：
 * 因为一个探测失败就让轮询永久停摆，比偶尔抢一次焦点更难排查。
 */
export async function readUserIdleMs({ timeoutMs = 8000 } = {}) {
  try {
    const r = await runPs('user-idle.ps1', [], { timeoutMs });
    if (r && r.ok === true) {
      const n = Number(r.idleMs);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch { /* 探测失败不拦，见上 */ }
  return -1;
}

/**
 * 点到指定会话上。
 *
 * @param {string} name 目标会话名
 * @param {{restoreCursor?:boolean, waitMs?:number, sessions?:Array, cfg?:object}} opts
 *   sessions 可以传进来复用刚读过的那份（省一次 UIA 读取），
 *   但**不传就现读** —— 坐标新鲜比省那一次读取重要得多。
 *   cfg 只在需要复核界面时用得上（解析会话名要按同一套列范围）。
 * @returns {Promise<{ok:boolean, name?:string, point?:object, waited?:number, error?:string}>}
 */
export async function switchToConversation(name, opts = {}) {
  const want = String(name ?? '').trim();
  if (!want) return { ok: false, error: '没给会话名' };

  let sessions = Array.isArray(opts.sessions) ? opts.sessions : null;
  let handle = Number(opts.handle) || 0;
  if (!sessions) {
    const r = await readSessions();
    if (!r.ok) return { ok: false, error: `读会话列表失败：${r.error}` };
    sessions = r.sessions;
    handle = r.handle ?? 0;
  } else if (!(handle > 0)) {
    // 有会话列表、却没有窗口句柄：没有句柄就没法把 QQ 提到前台，
    // 而对着一个**不在前台**的窗口点击，那一下只会"激活"它，
    // 列表项根本收不到点击（实测：脚本报成功、界面纹丝不动）。
    // 所以这里宁可多读一次，也要把句柄拿到手 —— 白点一次的代价更大。
    const r = await readSessions();
    handle = r.handle ?? 0;
  }

  const hit = findSessionPoint(sessions, want);
  if (!hit) {
    return {
      ok: false,
      error: `会话列表里找不到「${want}」（当前有：${sessions.map((s) => s.name).join('、') || '空'}）`,
    };
  }

  const args = ['-X', String(hit.cx), '-Y', String(hit.cy)];
  if (opts.restoreCursor !== false) args.push('-Restore');
  if (handle > 0) {
    args.push('-ForegroundHandle', String(handle));
  } else {
    // 走到这里说明连一次 UIA 读取都没给出句柄。不点会更安全，但也不该
    // 静默返回成功 —— 说清楚，好让日志里能看出"是没句柄，不是没切成功"。
    return { ok: false, error: '拿不到 QQ 窗口句柄，没法把窗口提到前台（盲点会白点一次）' };
  }

  let clicked;
  try {
    clicked = await runPs('qq-click.ps1', args, { timeoutMs: 20000 });
  } catch (e) {
    return { ok: false, error: `点击失败：${e?.message ?? e}` };
  }

  const judged = judgeClick(clicked, { tolerance: opts.tolerance });

  // 等界面刷出这个会话的内容。切过去是一瞬间的事，但无障碍树要慢一步 ——
  // 不等就立刻读，读到的还是上一个会话的消息（那比不切还糟：会回错人）。
  const waitMs = Number.isFinite(Number(opts.waitMs)) ? Number(opts.waitMs) : 1500;

  if (!judged.ok && judged.suspect) {
    // 落点可疑：先等界面刷完，再读一次当前会话定论。
    // 为此多花一次 UIA 读取是值得的 —— 上一次就是在这里把成功的切换
    // 判成了失败，机器人于是原地不动。
    await sleep(waitMs);
    const now = await readCurrentConversation({ cfg: opts.cfg, timeoutMs: opts.verifyTimeoutMs ?? 30000 });
    if (now.ok && sessionMatches(now.name, want)) {
      return {
        ok: true,
        name: hit.name,
        point: { x: hit.cx, y: hit.cy },
        waited: waitMs,
        restored: clicked?.restored,
        verified: true,
        drift: judged.drift,
        note: `${judged.reason}，但读了界面确认已经切过去`,
      };
    }
    return {
      ok: false,
      error: now.ok
        ? `${judged.reason}，复核后界面还停在「${now.name || '读不出会话名'}」`
        : judged.reason,
    };
  }

  if (!judged.ok) return { ok: false, error: judged.reason };

  await sleep(waitMs);

  return {
    ok: true,
    name: hit.name,
    point: { x: hit.cx, y: hit.cy },
    waited: waitMs,
    restored: clicked?.restored,
    drift: judged.drift,
  };
}
