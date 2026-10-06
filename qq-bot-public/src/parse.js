/**
 * parse.js — 把 OCR 的原始文本行还原成「会话名 + 消息列表」。
 *
 * 全部参数来自对真实 QQ 窗口的实测标定（960x640 截图）：
 *   标题栏       y≈0.11   对话名「示例群（10）」
 *   他人消息     x≈0.48~0.83  左对齐，内容在气泡里
 *   发送者标签   x≈0.48   （渲染成 LV100搞完 这种，OCR 常糊，不做强依赖）
 *   时间戳       "16:24" / "17:00"，居中，单独一行
 *   输入框提示   y≈0.93  「按住 Win+Alt，使用语音输入文字」→ 在消息区下方，被裁掉
 *
 * 判据是**左右对齐**，不是颜色：
 *   - 他人消息的文本行中心在窗口左侧偏中 → incoming
 *   - 自己发的消息右对齐，文本行起点很靠右 → self
 * 这样既能排除自己的消息，也能排除会话列表（会话列表整体在 messageArea.left 左边）。
 */

const FULLWIDTH_MAP = { '（': '(', '）': ')', '：': ':', '，': ',', '。': '.', '！': '!', '？': '?' };

/** OCR 会在汉字之间插空格，比较前必须去掉。 */
export function normalizeText(s) {
  return String(s ?? '')
    .replace(/\s+/g, '')
    .trim();
}

/** 用于「会话名匹配」的归一化：去空格 + 全角括号统一。 */
export function normalizeName(s) {
  let out = normalizeText(s);
  for (const [k, v] of Object.entries(FULLWIDTH_MAP)) out = out.split(k).join(v);
  return out;
}

export function nameMatches(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

/**
 * 纯时间戳判定，容忍 OCR 的空格与全角冒号。
 * 实测 OCR 把 15:24 读成 "1 5 ： 24"，所以必须先归一化再匹配。
 * @returns {{isTs:boolean, text:string}} text 是归一化后的时间戳
 */
export function parseTimestamp(rawText, strict = false) {
  const t = normalizeText(rawText).replace(/[：]/g, ':');
  if (t.length < 4 || t.length > 6) return { isTs: false, text: t };
  if (!/^\d{1,2}:\d{2}$/.test(t)) return { isTs: false, text: t };
  // QQ 的时间戳都是 :00 / :24 这种真实分钟数；00:00 之类的噪声在精确模式下排除
  if (strict && t === '00:00') return { isTs: false, text: t };
  return { isTs: true, text: t };
}

function region(abs, ratio, total) {
  return abs !== undefined ? abs : ratio * total;
}

export function resolveGeometry(cfg, w, h) {
  const g = cfg.geometry ?? {};
  const ma = g.messageAreaRatio ?? {};
  const tb = g.titleBarRatio ?? {};
  return {
    msgLeft: region(g.messageAreaLeftPx, ma.left ?? 0.31, w),
    msgTop: region(g.messageAreaTopPx, ma.top ?? 0.14, h),
    msgRight: region(g.messageAreaRightPx, ma.right ?? 1.0, w),
    msgBottom: region(g.messageAreaBottomPx, ma.bottom ?? 0.82, h),
    titleTop: region(g.titleBarTopPx, tb.top ?? 0.0, h),
    titleBottom: region(g.titleBarBottomPx, tb.bottom ?? 0.17, h),
    // 标题栏左半部分是自己的昵称/头像，会话名在右侧聊天面板上方。
    // 实测：群名 x≈0.42，自己的昵称 x≈0.13。0.22 是安全的分界线。
    titleLeft: region(g.titleLeftPx, g.titleLeftRatio ?? 0.22, w),
    selfLeft: (g.selfLeftRatio ?? 0.82) * w,
    incomingCenter: (g.incomingCenterRatio ?? 0.72) * w,
    lineMergeGapPx: g.lineMergeGapPx ?? 6,
    minMessageChars: g.minMessageChars ?? 2,
    timestampStrict: g.timestampStrict !== false,
    incomingMinX: region(g.incomingMinXPx, g.incomingMinXRatio ?? 0.34, w),
    noisePatterns: (g.noiseTextPatterns ?? []).map((p) => new RegExp(p)),
  };
}

/** 过滤纯噪声行：OCR 对头像、LV 徽章、温度/状态条产生的碎片。 */
function isNoise(line, geo) {
  const t = normalizeText(line.text);
  if (!t) return true;
  return geo.noisePatterns.some((re) => re.test(t));
}

/**
 * 从标题栏区域取会话名。
 *
 * 坑：标题栏横跨整个窗口，左上角是**自己的昵称**（实测「示例昵称编辑个性签名」）。
 * 如果只按「最宽的行」取，会把昵称当成会话名。所以必须限定在右侧聊天面板上方。
 */
export function extractConversation(lines, geo) {
  const inTitle = lines.filter((l) => {
    const cy = l.y + l.h / 2;
    const cx = l.x + l.w / 2;
    return cy >= geo.titleTop && cy <= geo.titleBottom &&
           cx >= geo.titleLeft &&
           normalizeText(l.text).length > 0;
  });
  if (inTitle.length === 0) return { name: '', raw: '', candidates: [] };
  const sorted = [...inTitle].sort((a, b) => b.w - a.w);
  return {
    name: normalizeText(sorted[0].text),
    raw: sorted[0].text,
    candidates: inTitle.map((l) => l.text),
  };
}

/**
 * 把消息区内的行合并成块。
 * 同一侧（都靠左或都靠右）、水平位置接近、垂直间距小的行，属于同一条消息。
 */
function groupBlocks(rows, geo) {
  const blocks = [];
  for (const r of rows) {
    const side = r.x >= geo.selfLeft ? 'self' : 'incoming';
    const last = blocks[blocks.length - 1];
    if (
      last &&
      last.side === side &&
      r.y - last.bottom <= geo.lineMergeGapPx &&
      Math.abs(r.x - last.x) <= Math.max(24, r.h * 2)
    ) {
      last.rows.push(r);
      last.bottom = r.y + r.h;
      last.x = Math.min(last.x, r.x);
      continue;
    }
    blocks.push({ side, x: r.x, rows: [r], top: r.y, bottom: r.y + r.h });
  }
  return blocks;
}

/**
 * 主解析入口。
 * @param {Array<{text:string,x:number,y:number,w:number,h:number}>} lines OCR 行
 * @param {{w:number,h:number}} size 图像尺寸
 * @param {object} cfg 配置
 */
export function parseChat(lines, size, cfg) {
  const geo = resolveGeometry(cfg, size.w, size.h);
  const all = (lines ?? []).filter((l) => normalizeText(l.text).length > 0);

  const title = extractConversation(all, geo);

  // 消息区
  const inArea = all.filter((l) => {
    const cy = l.y + l.h / 2;
    return cy >= geo.msgTop && cy <= geo.msgBottom && l.x >= geo.msgLeft;
  });

  const timestamps = [];
  const body = [];
  for (const l of inArea) {
    if (isNoise(l, geo)) continue;
    const ts = parseTimestamp(l.text, geo.timestampStrict);
    if (ts.isTs) {
      timestamps.push(ts.text);
      continue;
    }
    body.push(l);
  }

  // 只保留真正属于消息区的行：起笔位置要靠近消息区左侧（他人）
  // 或者足够靠右（自己）。夹在中间的多半是头像/装饰/系统提示，丢掉。
  const relevant = body.filter((l) => {
    const startsNearLeft = l.x >= geo.incomingMinX && l.x <= geo.msgLeft + size.w * 0.19;
    const startsFarRight = l.x >= geo.selfLeft;
    return startsNearLeft || startsFarRight;
  });

  const blocks = groupBlocks(relevant, geo);

  const messages = blocks.map((b, i) => {
    const sorted = [...b.rows].sort((p, q) => p.y - q.y);
    // 发送者标签是块内起笔最靠左的行；QQ 群聊里它在气泡上方
    let sender = '';
    let contentRows = sorted;
    if (b.side === 'incoming' && sorted.length > 1) {
      const minX = Math.min(...sorted.map((r) => r.x));
      const first = sorted[0];
      if (first.x <= minX + 1) {
        sender = normalizeText(first.text);
        contentRows = sorted.slice(1);
      }
    }
    const text = contentRows.map((r) => normalizeText(r.text)).join('');
    const y = sorted[0]?.y ?? b.top;
    const maxBottom = Math.max(...sorted.map((r) => r.y + r.h));
    return {
      index: i,
      side: b.side,
      sender,
      text,
      rawLines: sorted.map((r) => r.text),
      x: b.x,
      y,
      h: Math.max(...sorted.map((r) => r.h)),
      bottom: maxBottom,
    };
  }).filter((m) => m.text.length >= geo.minMessageChars);

  // 可见消息区的像素下沿，用于「新消息」定位
  const contentBottom = messages.length
    ? Math.max(...messages.map((m) => m.bottom))
    : geo.msgTop;

  return {
    geometry: geo,
    conversation: title.name,
    conversationCandidates: title.candidates,
    timestamps,
    messages,
    incoming: messages.filter((m) => m.side === 'incoming'),
    self: messages.filter((m) => m.side === 'self'),
    contentBottom,
    size,
  };
}

/** 生成一条消息的指纹：用于去重（同一屏重复扫描 / 自己的回复被读到）。 */
export function fingerprint(message) {
  return `${message.side}|${message.text}`;
}

/**
 * 判断是否被 @。
 * OCR 可能把 @ 识别成全角 ＠ 或丢掉空格，所以两边都归一化。
 */
export function isMentioned(message, cfg) {
  const trigger = cfg.trigger ?? {};
  const names = trigger.botNames ?? [];
  const raw = String(message.text ?? '');
  const flat = normalizeText(raw).replace(/＠/g, '@');

  const patterns = trigger.mentionPatterns ?? [];
  for (const name of names) {
    if (!name) continue;
    for (const p of patterns) {
      const needle = normalizeText(String(p).replace(/\{bot\}/g, name)).replace(/＠/g, '@');
      if (needle && flat.includes(needle)) return true;
    }
    // 兜底：直接出现 @名字
    if (flat.includes('@' + name)) return true;
  }
  return false;
}

/**
 * 该不该喊「疑似漏判 @」。
 *
 * 抽成纯函数是为了能测 —— 它曾经每轮扫描刷两行警告，而真相是**误报**：
 * QQ 会把自己的昵称渲染成一个元素（在自己的消息旁边），解析器一度把它当成
 * 一条自己发的消息（正文就是自己的名字），于是：
 *   正文里有「示例昵称」✓、文本里没有 @ ✓ → 自检判定"漏判" → 报警。
 * 用户看到日志里反复出现「原文里还有 @ 吗: 没有 → 多半是解析把 @ 元素丢了」，
 * 于是以为 @ 被解析丢了 —— 而真正的 @ 消息好端端地在正文里。
 *
 * 三条排除：自己的消息、整条就是一个名字、以及真的认出来了（那不算漏判）。
 */
export function looksLikeMissedMention(message, cfg) {
  const text = String(message?.text ?? '');
  if (!text) return false;
  if (message?.side === 'self') return false;            // 自己的话不需要 @
  const names = (cfg?.trigger?.botNames ?? []).filter((n) => n && text.includes(n));
  if (names.length === 0) return false;                  // 没提名字，不关 @ 的事
  const bare = text.trim();
  if (names.some((n) => bare === String(n).trim())) return false;  // 整条就是个名字标签
  return !isMentioned(message, cfg);                     // 认出来了 → 不是漏判
}

/**
 * 「机器人到底认不认得出自己被 @」自检。
 *
 * 为什么需要它：`trigger.replyInGroupOnlyWhenMentioned = true` 时，
 * isMentioned() 是整条回复链路的**第一道闸门**。如果 trigger.botNames 里
 * 没写群友实际 @ 的那个名字（通常是 QQ 昵称，而不是人设名），
 * isMentioned 永远返回 false —— 于是机器人**一条都不回**，
 * 不报错、不抛异常、日志上一片正常，唯一症状是「它没反应」。
 *
 * 这个坑真踩过：botNames 写成 ["小深","D老师"]，群里 @ 的是「示例昵称」，
 * 拿 35 条真实带 @ 的消息去喂，认出 0 条。而且因为当时接管模式强制全回、
 * 被@规则压根不参与决策，这个错误藏了好几天没暴露。
 *
 * 判据故意放宽：只要**认出过一条**就算 ok。群里 @ 别人的消息占多数是正常的，
 * 要求命中率高会误报。
 *
 * @returns {{sawAt:number, hit:number, ok:boolean, samples:string[]}}
 */
export function mentionSelfCheck(messages, cfg, { minSamples = 8 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  let sawAt = 0;
  let hit = 0;
  const samples = [];

  for (const m of list) {
    const text = String(m?.text ?? '');
    if (!text.includes('@') && !text.includes('＠')) continue;
    sawAt++;
    if (isMentioned(m, cfg)) {
      hit++;
    } else if (samples.length < 3) {
      samples.push(text.length > 40 ? text.slice(0, 40) + '…' : text);
    }
  }

  return { sawAt, hit, ok: sawAt < minSamples || hit > 0, samples };
}
