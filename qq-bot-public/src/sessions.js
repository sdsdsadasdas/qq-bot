/**
 * sessions.js — 会话列表与「自动切换聊天」的判定。
 *
 * 用户要求：「加入可以自动切换每一个聊天的功能，而非手动抓取」。
 *
 * 背景：以前机器人只能读**当前打开的那个**聊天，要覆盖 N 个会话就得手动一个个点开。
 * 自动切换就是替用户去点会话列表。
 *
 * ⚠ 这个功能会**动用户的鼠标**（点会话列表靠的是真实点击，见 tools/qq-click.ps1）。
 *   所以：
 *     · 默认关闭，要显式打开
 *     · 点完把光标位置还原（Restore），别把人家光标丢在会话列表上
 *     · 只在**确实需要换**的时候才点（已经在目标会话上就不动）
 *
 * 这个文件只放**纯逻辑**（不碰网络、不跑 PowerShell），所以能直接单测。
 * 真正去点是 src/switch.js 的事。
 */

/** 会话名匹配：跟白名单保持同一套规则（子串匹配），别出现两套语义。 */
export function sessionMatches(name, target) {
  const n = String(name ?? '');
  const t = String(target ?? '').trim();
  if (!t) return false;
  return n === t || n.includes(t);
}

/**
 * 从 uia-read.ps1 的输出里取会话列表，并算出每一项的**点击点**。
 *
 * 点击点取元素中心：会话列表项是 Text 元素，点它的中心就等于点那一行。
 *
 * @returns {Array<{name:string, x:number, y:number, w:number, h:number, cx:number, cy:number}>}
 */
export function parseSessions(uia) {
  const list = Array.isArray(uia?.conversations) ? uia.conversations : [];
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const name = String(c.name ?? '').trim();
    if (!name) continue;
    const x = Number(c.x);
    const y = Number(c.y);
    const w = Number(c.w);
    const h = Number(c.h);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(w > 0) || !(h > 0)) continue;
    out.push({
      name, x, y, w, h,
      cx: Math.round(x + w / 2),
      cy: Math.round(y + h / 2),
    });
  }
  return out;
}

/**
 * 轮询范围的三档，做一次归一。
 *
 * 为什么要归一：`scope` 是后加的字段，老配置里没有它，只有 conversations / whitelist。
 * 直接用 `cfg.autoSwitch.scope ?? 'whitelist'` 会让老配置的语义**悄悄变掉**
 * （本来拿 conversations 当目标的，突然变成按白名单）。
 * 所以：没写 scope 时按老规矩推 —— 有 conversations 就用列表，否则用白名单。
 *
 * @returns {'all'|'whitelist'|'list'}
 */
export function autoScopeOf(cfg) {
  const s = String(cfg?.autoSwitch?.scope ?? '').trim();
  if (s === 'all' || s === 'whitelist' || s === 'list') return s;
  return (Array.isArray(cfg?.autoSwitch?.conversations) && cfg.autoSwitch.conversations.length)
    ? 'list'
    : 'whitelist';
}

/**
 * 这一轮该去哪些会话。
 *
 * 三档（autoSwitch.scope）：
 *   all       —— 会话列表里的**每一个**都轮询（默认推荐：谁发消息都能看见，
 *                回不回仍由白名单决定，见 gate.js）
 *   whitelist —— 只轮询白名单里的（最省事，但白名单只剩一个时等于不轮询）
 *   list      —— 只轮询 autoSwitch.conversations 里列的
 *
 * 只保留**当前列表里真实存在**的，这样写了个已退出的群也不会白跑一趟。
 * 黑名单里的会话永远不轮询（那是明确说"别回这个"的，看它没有意义）。
 */
export function targetConversations(cfg, sessions) {
  const auto = cfg?.autoSwitch ?? {};
  const scope = autoScopeOf(cfg);
  const list = Array.isArray(sessions) ? sessions : [];
  const black = cfg?.trigger?.blacklist ?? [];
  const blocked = (name) => black.some((b) => sessionMatches(name, b));

  if (scope === 'all') {
    return list.map((s) => s.name).filter((n) => n && !blocked(n));
  }

  const wanted = scope === 'list'
    ? (auto.conversations ?? [])
    : (cfg?.trigger?.whitelist ?? []);

  const found = [];
  for (const w of wanted) {
    const t = String(w ?? '').trim();
    if (!t) continue;
    const hit = list.find((s) => sessionMatches(s.name, t));
    if (hit && !blocked(hit.name) && !found.includes(hit.name)) found.push(hit.name);
  }
  return found;
}

/**
 * 轮询挑下一个要看的会话。
 *
 * @param {string[]} targets 目标会话名（顺序固定）
 * @param {string} current 当前**已经打开**的会话名（不知道就给 ''）
 * @param {string} lastVisited 上一次主动切过去的会话（用来推进轮询）
 * @returns {{name:string, reason:string}|null} null = 一个都不用切
 */
export function pickNextConversation(targets, current, lastVisited) {
  const list = (targets ?? []).filter(Boolean);
  if (list.length === 0) return null;

  // 只有 1 个目标：已经在上面就别动（省一次点击 —— 每次点击都会抢焦点）
  if (list.length === 1) {
    return sessionMatches(current, list[0])
      ? null
      : { name: list[0], reason: '只有这一个目标，且当前不在上面' };
  }

  // 多个目标：从上次去过的下一个开始轮。
  // 这样即使中途有人手点开了别的会话，轮询也不会卡在同一个上。
  let idx = 0;
  if (lastVisited) {
    const i = list.findIndex((n) => n === lastVisited);
    if (i >= 0) idx = (i + 1) % list.length;
  } else {
    // 还没切过：如果当前就在某个目标上，从它的下一个开始，别白点一次
    const i = list.findIndex((n) => sessionMatches(current, n));
    if (i >= 0) idx = (i + 1) % list.length;
  }

  const name = list[idx];
  return { name, reason: `轮询第 ${idx + 1}/${list.length} 个` };
}

/**
 * 从会话列表里按名字找点击点。
 *
 * 名字可能有多种写法（QQ 给多人聊天起的默认名会随成员变，群名可能带成员数），
 * 所以两边都做一次规整再比。找不到就返回 null —— 调用方要跳过，不能瞎点。
 */
export function findSessionPoint(sessions, name) {
  const want = String(name ?? '').trim();
  if (!want) return null;
  const exact = sessions.find((s) => s.name === want);
  if (exact) return exact;
  const loose = sessions.find((s) => sessionMatches(s.name, want) || sessionMatches(want, s.name));
  return loose ?? null;
}

/**
 * 判断"这一下点击值不值得信"。
 *
 * 为什么要单独一个判定，而不是让 PowerShell 自己说成败：
 * 点击脚本只能测出光标落点，而落点**不是**成败的可靠信号 ——
 * 实测有几次落点差了 1~4px（多半是指针加速，或者别的进程碰了鼠标），
 * 但界面其实切过去了。旧版脚本用"完全相等"判断，于是把这几次
 * 成功报成了失败，机器人以为没切成功、不再往下走。
 * 反过来，落点分毫不差也可能是白点（窗口没到前台时，那一下点击
 * 会被"激活窗口"吃掉）—— 这个 bug 也真的踩过。
 *
 * 所以这里只回答一件事：落点偏移大到"坐标空间不对"的程度了吗？
 * 真正切没切过去，由 src/switch.js 读一次界面来定。
 *
 * @param {{ok?:boolean, drift?:number, error?:string}} clicked qq-click.ps1 的输出
 * @param {{tolerance?:number}} opts
 * @returns {{ok:boolean, drift:number, suspect:boolean, reason:string}}
 *   suspect:true 表示"可疑但可能已经成功了"，调用方该去读界面复核，而不是直接放弃
 */
export function judgeClick(clicked, opts = {}) {
  const tolerance = Number.isFinite(Number(opts.tolerance)) ? Number(opts.tolerance) : 4;
  if (!clicked) return { ok: false, drift: 0, suspect: false, reason: '点击脚本没有输出' };
  if (clicked.ok !== true) {
    return {
      ok: false, drift: 0, suspect: false,
      reason: clicked.error ? `点击脚本报错：${clicked.error}` : '点击脚本没返回成功',
    };
  }
  const drift = Number(clicked.drift);
  if (!Number.isFinite(drift) || drift <= tolerance) {
    return { ok: true, drift: Number.isFinite(drift) ? drift : 0, suspect: false, reason: 'ok' };
  }
  return {
    ok: false,
    drift,
    suspect: true,
    reason: `光标落点偏移 ${drift}px（超过 ${tolerance}px），坐标空间可能不对`,
  };
}

/**
 * 该不该真的去点。两道闸门：
 *   · 开关关着 → 不点
 *   · 距上次切换太近 → 不点（界面还没刷完就再点，容易点空）
 *
 * @returns {{ok:boolean, reason:string}}
 */
export function shouldSwitchNow(cfg, lastSwitchAt, now = Date.now()) {
  const auto = cfg?.autoSwitch ?? {};
  if (auto.enabled !== true) return { ok: false, reason: '自动切换没开' };
  const gap = Number(auto.minGapMs);
  if (Number.isFinite(gap) && gap > 0 && lastSwitchAt > 0 && now - lastSwitchAt < gap) {
    return { ok: false, reason: `距上次切换才 ${Math.round((now - lastSwitchAt) / 1000)}s（下限 ${Math.round(gap / 1000)}s）` };
  }
  return { ok: true, reason: 'ok' };
}

/**
 * 「你正在用电脑」的闸门：空闲时间不够就不去点鼠标。
 *
 * 为什么必须有它：轮询要点击 QQ 的会话列表，而 Windows **不允许**后台进程
 * 在用户活跃时抢前台（实测：抢不到，那一下点击只会变成"激活窗口"，
 * 列表项根本没收到）。后果不是切不过去那么轻 —— 是**你正在打字的时候
 * 光标被挪走、焦点被抢**，字打进了 QQ 里。用户明确要求「一动键鼠就暂停」。
 *
 * @param {object} cfg
 * @param {number} idleMs 系统级空闲时间（毫秒，来自 GetLastInputInfo）
 * @returns {{ok:boolean, reason:string, idleMs:number, needMs:number}}
 */
export function shouldPauseForUser(cfg, idleMs) {
  const auto = cfg?.autoSwitch ?? {};
  const needMs = Number(auto.activeIdleMs) > 0 ? Number(auto.activeIdleMs) : 4000;
  if (auto.pauseWhenActive === false) return { ok: true, reason: '没开空闲暂停', idleMs: 0, needMs: 0 };
  // 读不到空闲时间（脚本失败、非 Windows）：**不拦**。宁可偶尔抢一下焦点，
  // 也不要因为一个探测失败就让轮询永久停摆 —— 那更难排查。
  if (!Number.isFinite(idleMs) || idleMs < 0) {
    return { ok: true, reason: '读不到空闲时间，按不忙处理', idleMs: -1, needMs };
  }
  if (idleMs >= needMs) return { ok: true, reason: 'ok', idleMs, needMs };
  return {
    ok: false,
    reason: `你 ${(idleMs / 1000).toFixed(1)}s 前还在动键鼠（要闲置 ${(needMs / 1000).toFixed(1)}s）`,
    idleMs,
    needMs,
  };
}
