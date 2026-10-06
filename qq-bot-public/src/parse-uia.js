/**
 * parse-uia.js — 把 UIA 读出的元素列表还原成「会话名 + 消息列表」。
 *
 * 这是主路线（OCR 的 parse.js 退为兜底）。相比 OCR 的优势：
 *   - 文本精确，没有识别错字
 *   - 发送者昵称完整（OCR 基本读不准）
 *   - 元素坐标是真实屏幕坐标，不受 DPI 缩放影响
 *
 * 实测布局（窗口 960x640，屏幕坐标）：
 *   [Button] x=1641 y=543  '示例群'          ← 会话名（聊天面板标题）
 *   [Text]   x=1701 y=516  'LV'                  ← 等级徽章
 *   [Text]   x=1715 y=516  '100'                 ← 等级数字
 *   [Text]   x=1740 y=516  '群友丁'               ← 昵称
 *   [Text]   x=1787 y=515  '群友丁'        ← 昵称第二段（含特殊符号时拆开）
 *   [Text]   x=1709 y=551  '我没招了'              ← 消息内容
 *   [Button] x=2086 y=1215 '发送'                ← 发送按钮
 *   [Text]   x=2259 y=821  '群友己'              ← 右侧群成员列表（要排除）
 *
 * 关键判据：**消息在聊天列（x 大致等于发送按钮的 x 减 420），右侧群成员列表
 * 从发送按钮的 x 加 130 之后才开始**。两者中间有明显空隙，很好分。
 */

// 群聊判定用的字面量。用 \u 转义写成 ASCII，避免 PowerShell 那边再踩编码坑。
const MEMBER_HEADER = '\u7FA4\u804A\u6210\u5458';   // 群聊成员
const GROUP_OWNER   = '\u7FA4\u4E3B';               // 群主
const GROUP_ADMIN   = '\u7BA1\u7406\u5458';         // 管理员
const SESSION_LIST  = '\u4F1A\u8BDD\u5217\u8868';   // 会话列表
const MESSAGE_LIST  = '\u6D88\u606F\u5217\u8868';   // 消息列表

/**
 * 找布局用的那几个 Pane。
 *
 * 为什么需要它们（这是「私聊和群聊不一样」这件事的根子）：
 *   群聊右侧有成员列表，私聊没有 —— 所以**私聊的聊天面板更宽**。
 *   实测同一个窗口、同样大小：
 *       群聊  发送按钮 x=2086（面板被成员列表挤窄了）
 *       私聊  发送按钮 x=2338（没有成员列表，面板宽出去约 250px）
 *   而原来所有横向边界都是「相对发送按钮」算的，于是同一套偏移在私聊里
 *   整体偏右约 250px：消息一条都读不到，会话名也读不出来。
 *
 *   面板本身（消息列表 Pane）在两种布局里都是消息区，是**不随群/私聊变的锚点**，
 *   所以改成以它为基准。
 *
 * 成员列表的判定：贴着消息列表右沿、够高的另一个 Pane（它没有名字，只能靠几何）。
 */
export function findLayoutPanes(uia) {
  const panes = (Array.isArray(uia?.panes) ? uia.panes : [])
    .filter((p) => p && typeof p === 'object' && Number(p.w) > 0 && Number(p.h) > 0);

  const list = panes.find((p) => String(p.name).includes(SESSION_LIST)) ?? null;
  const msg = panes.find((p) => String(p.name).includes(MESSAGE_LIST)) ?? null;

  let member = null;
  if (msg) {
    const right = Number(msg.x) + Number(msg.w);
    const cands = panes.filter((p) => {
      if (p === msg || p === list) return false;
      const w = Number(p.w); const h = Number(p.h); const x = Number(p.x); const y = Number(p.y);
      if (h <= 200 || w < 100) return false;       // 成员列表是细高的
      if (y < 0) return false;                     // 窗口外的不管
      // 贴着消息列表右沿（成员列表一出现，消息区就被挤到它左边）
      return x >= right - 40 && x <= right + 60;
    });
    if (cands.length) member = cands.sort((a, b) => Number(b.w) - Number(a.w))[0];
  }
  return { list, msg, member };
}

/**
 * 从发送按钮位置推算聊天列的水平边界，避免依赖窗口绝对分辨率。
 *
 * ⚠ 有「消息列表」Pane 时**以面板为准**，不再用发送按钮的偏移 —— 见 findLayoutPanes
 *   的注释：私聊没有右侧成员列表，发送按钮的位置和群聊差 250px，
 *   同一套偏移不可能两边都对。偏移那套保留为兜底（拿不到 Pane 时用）。
 *
 * 纵向边界的关键（实测，两种布局通用）：
 *   · yMin 用较大的负偏移：Chromium 把滚出视口**上方**的内容也暴露出来，坐标是负的，
 *     一次能拿到十几条历史消息。收进来就是现成的长上下文。
 *   · yMax 必须卡得紧：输入区**正下方**的内容坐标是正的（实测能到 y=1021，
 *     而发送按钮在 1215），宽了会把输入框和下面的东西当消息。
 */
export function resolveChatColumn(sendButton, cfg = {}, panes = null) {
  const g = cfg.geometry?.uia ?? {};
  const sbx = sendButton?.x ?? 0;
  const sby = sendButton?.y ?? 0;
  const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

  const titleYMin = sby + numOr(g.titleYMinOffset, -680);
  const titleYMax = sby + numOr(g.titleYMaxOffset, -600);

  // ---- 首选：私聊（没有成员列表）以「消息列表」面板为准 ----
  //
  // 为什么只对私聊启用：群聊那条路是**标定过、实测能用**的（今天还在正常读），
  // 而私聊因为没有右侧成员列表，发送按钮比群聊靠右约 250px，标定值必然全错。
  // 所以只修需要修的那一边，不动已经在工作的那一边。
  //   anchor: auto（默认）= 私聊用面板、群聊用偏移
  //           panel       = 一律用面板（群聊也换成面板锚点，未实机验证过）
  //           offsets     = 一律用偏移（老行为）
  const mode = g.anchor === 'panel' ? 'panel' : (g.anchor === 'offsets' ? 'offsets' : 'auto');
  const msg = panes?.msg;
  const wantPanel = mode === 'panel' || (mode === 'auto' && msg && !panes.member);
  if (msg && wantPanel) {
    const pad = numOr(g.msgPad, 20);              // 面板左沿再往左留一点（气泡有内边距）
    const ratio = numOr(g.selfSplitRatio, 0.57);  // 面板宽度的多少以右算"他人"带
    const rightPad = numOr(g.selfRightPad, 10);
    const paneRight = Number(msg.x) + Number(msg.w);

    const xMin = Number(msg.x) - pad;
    const xMax = Math.round(Number(msg.x) + Number(msg.w) * ratio);
    return {
      anchor: 'panel',
      mode,
      pane: { x: Number(msg.x), y: Number(msg.y), w: Number(msg.w), h: Number(msg.h) },
      xMin,
      // xMax 同时是"他人带"的右界和"自己"的左界：自己发的气泡是靠右对齐的，
      // 起点必然在面板右半边，所以用比例切一刀，两种布局都成立。
      xMax,
      yMin: sby + numOr(g.chatYMinOffset, -2400),
      yMax: Math.min(sby + numOr(g.chatYMaxOffset, -200), Number(msg.y) + Number(msg.h) + 30),
      selfXMin: xMax,
      // 自己消息的右边界放宽：右对齐的长句会伸到接近面板右沿
      selfXMax: paneRight - rightPad,
      titleYMin,
      titleYMax,
      // 标题一律从面板左沿往右找，右界仍用相对发送按钮的偏移（两种布局里
      // 会话名都紧贴面板左沿，而右侧那排工具按钮靠排除法丢掉）
      titleXMin: xMin,
      titleXMax: sbx + numOr(g.titleXMaxOffset, -100),
    };
  }

  // ---- 兜底：原来的偏移方案（拿不到 Pane 时）----
  const xMin = g.chatXMinOffset !== undefined ? sbx + g.chatXMinOffset : sbx - 460;
  const xMax = g.chatXMaxOffset !== undefined ? sbx + g.chatXMaxOffset : sbx - 120;
  const yMin = g.chatYMinOffset !== undefined ? sby + g.chatYMinOffset : sby - 2400;
  const yMax = g.chatYMaxOffset !== undefined ? sby + g.chatYMaxOffset : sby - 200;

  // 自己发的内容右对齐（实测起笔 x≈1929），他人内容左对齐（x≈1709）。
  // 这个阈值相对发送按钮算，不随分辨率变。
  const selfXMin = g.selfXMinOffset !== undefined ? sbx + g.selfXMinOffset : sbx - 180;
  // 自己消息的右边界放宽：右对齐的长句会伸到 xMax 之外
  // （实测 x=1929 宽 193 → 右沿 2122，比 chatXMaxOffset 的 1966 还远）。
  const selfXMax = g.selfXMaxOffset !== undefined ? sbx + g.selfXMaxOffset : sbx + 120;

  // 标题栏（会话名）的边界。
  // **必须用相对发送按钮的偏移**，不能按窗口高算比例 —— UIA 坐标是物理空间，
  // GetWindowRect 报的是逻辑尺寸，两者混用会让会话名读成空。踩过。
  const titleXMin = g.titleXMinOffset !== undefined ? sbx + g.titleXMinOffset : sbx - 500;
  const titleXMax = g.titleXMaxOffset !== undefined ? sbx + g.titleXMaxOffset : sbx - 100;

  return {
    anchor: 'offsets', mode, pane: null, xMin, xMax, yMin, yMax, selfXMin, selfXMax,
    titleYMin, titleYMax, titleXMin, titleXMax,
  };
}

/** 会话名：聊天面板标题那个 Button。 */
/**
 * 标题栏里那些**按钮的固定文案**。
 *
 * 它们不是会话名，但和会话名一样是 Button、也在标题带里，所以必须显式排掉。
 *
 * 实测踩到的坑：QQ 切会话的瞬间，标题带里最宽的那个 Button 是「语音通话」，
 * 于是会话名被读成了「语音通话」——
 * 后果不只是显示错：
 *   · 记忆按会话分文件，于是凭空多出一份 memory/语音通话.json
 *   · 白名单按名字匹配，于是"不在白名单里"，机器人一条都不回
 * 这些文案是固定的，列出来最省事，也比调宽度阈值可靠。
 */
const TITLE_BUTTON_LABELS = new Set([
  '语音通话', '视频通话', '屏幕共享', '更多', '邀请加群', '群应用', '远程协助', '发起群聊',
  '文件', '截图', '表情', '图片', '相册', '礼物', '红包', '转账',
  '语音消息', '视频消息', '收藏', '我的手机', '邮箱', '空间', '频道', '游戏', '小程序',
  '腾讯文档', 'QQ游戏', '联系人', '切换为经典模式', '最小化', '最大化', '关闭',
  '表情弹出菜单', '截图弹出菜单', '文件弹出菜单', '更多弹出菜单',
]);

/**
 * 私聊标题栏里那个「在线状态 在线」按钮。
 *
 * 为什么单独一条规则：**私聊才有它**。它和会话名一样是 Button、一样在标题带里，
 * 而会话名是按"最宽的那个"挑的 —— 状态按钮的文案可能比好友昵称还长
 * （实测私聊里它就在昵称右边 160px 处），不排掉就会把会话名读成
 * 「在线状态 在线」，然后白名单不命中、记忆按这个名字建文件。
 * 群聊那边没有这个按钮，所以这条不会影响群聊。
 */
const TITLE_STATUS_RE = /^(在线状态|离线|忙碌|请勿打扰|隐身|离开|手机在线|电脑在线|WiFi在线|4G在线|5G在线)/;

export function extractConversationName(texts, col) {
  // 标题的纵向范围也**必须用相对发送按钮的偏移**，不能用按窗口高算的比例。
  // 踩过的坑：UIA 的坐标是物理空间（1200x800），而 GetWindowRect 报的是逻辑尺寸
  // （960x640），titleBarRatio.bottom = 0.17 按 640 算只有 108，
  // 而标题实际在 y≈558 —— 结果会话名一直读成空字符串。
  const inside = texts.filter((t) => {
    if (t.type !== 'Button') return false;
    const cx = t.x + t.w / 2;
    const cy = t.y + t.h / 2;
    if (cx < col.titleXMin || cx > col.titleXMax) return false;
    if (cy < col.titleYMin || cy > col.titleYMax) return false;
    const label = String(t.name).trim();
    if (TITLE_BUTTON_LABELS.has(label)) return false;   // 排掉工具栏按钮
    if (TITLE_STATUS_RE.test(label)) return false;      // 排掉私聊的「在线状态 在线」
    return true;
  });

  // 全被排掉了：说明标题带里确实没有会话名（窗口在过渡状态、或者会话名读不到）。
  // 这时宁可返回空 —— 空名字会让白名单不命中、机器人不回，
  // 但**总比随便认一个按钮当会话名好**：那会凭空造出一份错误命名的记忆文件，
  // 而且用户看名字完全想不到是怎么回事（实测「语音通话」就是这么来的）。
  if (inside.length === 0) return { name: '', candidates: [] };

  // 标题栏里最靠左的那个是会话名，其余是通话/更多之类的按钮。
  //
  // 但要排除**左侧侧栏**的按钮：实测「更多」在 x=1574，比会话名（x=1641）还靠左，
  // 不加判断就会把「更多」当成会话名。会话名是最宽的那个（157 宽 vs 33~40），
  // 所以取「宽度最大的」比取「最靠左的」稳。
  //
  // 群名可能很短（比如「学习」），所以不能只靠宽度下限，两个条件一起用：
  // 先按宽度排序，宽度相同再取靠左的。
  const sorted = [...inside].sort((a, b) => (b.w - a.w) || (a.x - b.x));
  return { name: String(sorted[0].name), candidates: inside.map((t) => t.name) };
}

/**
 * 判断是不是群聊。
 *
 * 不能只看会话名：OCR 读到的群名带成员数（「示例群（10）」），
 * 而 UIA 读到的标题**不带**（「示例群」）。踩过这个坑 —— 群聊被判成私聊，
 * 于是「群里只在被 @ 时回复」这道闸门形同虚设。
 *
 * 所以用 UIA 自己的证据判定（任一命中即为群聊）：
 *   - 出现「群聊成员」这类标题
 *   - 出现「群主 / 管理员」这类成员头衔
 *   - 会话名带成员数后缀
 *   - config.trigger.groupNames 里显式声明过
 */
export function detectGroupChat(uia, conversationName, cfg = {}) {
  // 同上：UIA 数据来自外部脚本，元素可能畸形。读 t.name 之前先滤一遍。
  const texts = (Array.isArray(uia?.texts) ? uia.texts : [])
    .filter((t) => t !== null && typeof t === 'object');
  const names = texts.map((t) => String(t.name).trim());

  if (names.some((n) => n.includes(MEMBER_HEADER))) return true;
  if (names.some((n) => n === GROUP_OWNER || n === GROUP_ADMIN)) return true;

  const n = String(conversationName ?? '');
  if (/[（(]\d{1,5}[)）]\s*$/.test(n)) return true;

  const declared = cfg.trigger?.groupNames ?? [];
  if (declared.some((g) => g && n.includes(g))) return true;

  return false;
}

/**
 * 剥掉消息内容**尾部**粘着的时间戳。
 *
 * 实测 QQ 有时会把时间戳和消息渲染在同一行（"打王者啊20:44"），
 * 于是它被当成正文发给了模型。上下文里混进这种东西会让模型莫名其妙。
 * 只在「时间戳紧贴结尾、且前面还有正文」时才剥，避免把纯时间戳的消息清空。
 */
export function stripTrailingTimestamp(text) {
  const t = String(text ?? '').trim();
  // 注意 .* 必须写成惰性的 .*? —— 贪婪匹配会把小时的第一位也吃进去
  // （实测 "打王者啊20:44" 被剥成 "打王者啊2"，那是错的）
  const m = /^(.*?\S)\s*(\d{1,2}:\d{2})$/.exec(t);
  if (!m) return t;
  const head = m[1];
  if (head.length < 2) return t;   // 前面没正文，说明这条本身就是时间戳，别动
  return head;
}

/** 正文**结尾**粘着的时间戳（`打王者啊20:44`），没有就返回 ''。 */
export function trailingTimestampOf(text) {
  const t = String(text ?? '').trim();
  if (/^\d{1,2}:\d{2}$/.test(t)) return '';        // 整条就是时间戳，见 stripTrailingTimestamp
  const m = /(\d{1,2}:\d{2})$/.exec(t);
  return m ? m[1] : '';
}

/** 正文**开头**粘着的时间戳（`20:55正文`），没有就返回 ''。 */
export function leadingTimestampOf(text) {
  const m = /^(\d{1,2}:\d{2})\s*(\S.*)$/.exec(String(text ?? '').trim());
  if (!m) return '';
  // 后面不足 2 个字符 = 整条就是个时间戳（QQ 的时间分隔线），不算"正文开头"
  if ([...m[2]].length < 2) return '';
  return m[1];
}

/**
 * 剥掉正文**开头**的时间戳。
 *
 * 和 stripTrailingTimestamp 是一对：QQ 把时间戳渲染在正文的哪一头，
 * 各版本/各布局都不一样（实测读到过开头 `20:55群主@某某 你在干嘛`，
 * 也读到过结尾 `打王者啊20:44`）。两头都剥，正文才干净。
 *
 * 剥出来的时间没丢：flush 会给这条消息写一个 `time` 字段，提交给 API 时
 * 是单独一段（`时间|称号|昵称|内容`），所以用户要的"时间也加|"是从这里来的。
 */
export function stripLeadingTimestamp(text) {
  const t = String(text ?? '').trim();
  const m = /^(\d{1,2}:\d{2})\s*(\S.*)$/.exec(t);
  if (!m) return t;
  if ([...m[2]].length < 2) return t;   // 后面没正文，说明整条就是时间戳，别动
  return m[2];
}

/**
 * 解析聊天内容。
 * @param {{texts:Array, sendButton:object, editBox:object}} uia
 * @param {object} cfg
 * @returns 与 parse.js 的 parseChat 相同形状的对象
 */
export function parseUia(uia, cfg = {}, options = {}) {
  const debug = Boolean(options.debug);
  const trace = [];
  // UIA 数据是 PowerShell 脚本吐出来的 JSON。元素畸形（null / 数字 / 缺字段）
  // 一律先在这里滤掉 —— 后面到处都在读 t.type / t.x，一个 null 就会打断整轮解析。
  const texts = (Array.isArray(uia?.texts) ? uia.texts : [])
    .filter((t) => t !== null && typeof t === 'object');
  trace.push(`BEGIN texts=${texts.length} sendButton=${uia?.sendButton ? uia.sendButton.x + ',' + uia.sendButton.y : 'none'}`);
  const sendButton = uia?.sendButton ?? null;
  // 布局先看清：群聊有右侧成员列表、私聊没有，两者的横向边界差 250px。
  // 以「消息列表」面板为锚点算边界，两种布局共用一套逻辑（见 findLayoutPanes）。
  const panes = findLayoutPanes(uia);
  const col = resolveChatColumn(sendButton, cfg, panes);
  const conv = extractConversationName(texts, col);

  // 聊天区元素分两部分取。
  //
  // 为什么不共用一套 x 范围：他人内容靠左（内容起笔 x≈1709，中心 ≤1966），
  // 而自己发的内容**右对齐**，长句会一直伸到 2122 —— 用中心点判会越界被丢掉。
  // 实测踩过：自己的消息一条都认不出来。
  //
  // yMin 允许负值：Chromium 的无障碍树把滚出视口**上方**的内容也暴露出来，
  // 坐标是负的（一次能拿到十几条历史消息）。主动收进来当上下文，这是现成的长上下文。
  //
  // ⚠ y 边界要按**行**来切，不能按元素切。
  //   同一条消息里各元素高度不同（头衔 h≈20、LV 徽章 h 很小），
  //   用「中心点在不在 yMin..yMax 之间」逐个判，会把最上面那一行**切成两半**：
  //   头衔进来、昵称和 LV 徽章被丢掉。实测结果就是第一条消息 sender 为空、
  //   头衔被当成正文（text="<头衔>没玩"）。
  //
  //   所以两遍：先看哪些行有元素落进范围，再把**整行**都收进来 ——
  //   一行只要露出一点，就当它整行可见。
  const inX = texts
    .filter((t) => t.type === 'Text')
    .filter((t) => {
      const cx = t.x + t.w / 2;
      if (cx < col.xMin) return false;                      // 左侧侧栏 + 会话列表
      if (cx > col.selfXMax) return false;                  // 右侧群成员列表
      // 落在「他人区间」或「自己区间」之一
      return cx <= col.xMax || t.x >= col.selfXMin;
    });

  const insideY = (t) => {
    const cy = t.y + t.h / 2;
    return cy >= col.yMin && cy <= col.yMax;
  };
  const rowsInRange = [];
  for (const t of inX) if (insideY(t) && !rowsInRange.includes(t.y)) rowsInRange.push(t.y);

  const inColumn = inX
    .filter((t) => insideY(t) || rowsInRange.some((ry) => Math.abs(ry - t.y) <= 2))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));

  const messages = [];
  /**
   * QQ 的**时间分隔线**（消息带左边一条居中的 `10:38`，实测 x=1534、列 xMin=1590）。
   *
   * 它本身不是消息（见 flush 里的 isBareTimestamp），但它带了一个信息：
   * "从这条线往下的消息都是这个时间"。QQ 只在间隔超过几分钟时才插线，
   * 所以紧跟其后的**第一条**消息，时间基本就等于它。
   *
   * 为什么只给第一条：这根线一直留到下一根线出现为止，中间那十几条消息
   * 可能是十几分钟之后说的 —— 给它们全盖上同一个时间就是在编。宁缺勿编，
   * 剩下的渲染成 `-`。
   */
  const timeMarks = texts
    .filter((t) => t.type === 'Text' && /^\d{1,2}:\d{2}$/.test(String(t.name).trim()))
    .filter((t) => {
      const cx = t.x + t.w / 2;                     // 只认消息带左边那一条，别把会话列表的时间当分隔线
      return cx >= col.xMin - 120 && cx <= col.xMax;
    })
    .map((t) => ({ y: t.y + t.h, time: String(t.name).trim() }))   // 用底边：消息要在线的**下方**
    .sort((a, b) => a.y - b.y);
  const usedMarks = new Set();

  let pendingSender = '';
  let pendingTitle = '';
  // 当前这一行发送者信息是**靠什么认出来的**：'lv'（LV 徽章）还是 'avatar'（头像）。
  // 下面有一段"行还没换、但这一行里还有别的元素"的兜底归类，它只对 LV 行成立
  //（要靠 LV 的 x 算偏移）—— 对头像行必须让开，否则同一行上的正文会被当成
  // 头部元素丢掉。这就是这个变量存在的唯一理由。
  let senderRowFrom = null;
  let senderRowY = null;
  // 上一个 LV 徽章行的 y（跨消息保留）。群头衔在元素序列里排在 LV 徽章之前，
  // 判定时必须靠它，不能用「当前发送者行」。
  let lastLvRowY = null;
  let content = [];
  let contentSide = 'incoming';

  const flush = () => {
    const rawText = content.map((c) => String(c.name)).join('').trim();
    // 时间戳可能在开头也可能在结尾，两头都剥（见 stripLeadingTimestamp 的注释）。
    // 剥出来的就是这条消息的 `time` 字段，按可信度排序取第一个：
    //   正文里粘着的（QQ 自己渲染在气泡上的）> 上一根时间分隔线（见 timeMarks）。
    let time = leadingTimestampOf(rawText) || trailingTimestampOf(rawText);
    let text = stripTrailingTimestamp(stripLeadingTimestamp(rawText));
    // 正文开头又粘了一遍称号（实测 `20:55群主@某某 你在干嘛` 里的那个「群主」）：
    // 称号已经是一个独立字段了，正文里再来一次会让小模型以为人名有两段。
    // 只在**紧跟着 @** 时才剥 —— 那基本只有一个来源：QQ 把称号渲染进了正文。
    // 万一有人真的打了「群主@某某」，代价是多剥一个词，比每轮名字粘连划算。
    if (pendingTitle && text.startsWith(pendingTitle) && text.slice(pendingTitle.length).trimStart().startsWith('@')) {
      text = text.slice(pendingTitle.length).trim();
    }
    // 「整条就是一个时间戳」的不要当成消息。
    //
    // 那是 QQ 插在消息之间的一条时间分隔线（实测独立成行、x 也偏右），
    // 不是一个消息。而 stripTrailingTimestamp 故意不处理这种情况
    //（它只剥"正文+时间戳"里的尾巴，怕把正常文本误伤），
    // 所以必须在调用方丢掉 —— 否则它会以「群友乙：10:39」的形式
    // 混进对话历史、提示词和记忆整理的输入里。
    const isBareTimestamp = /^\d{1,2}:\d{2}$/.test(text);
    if (text !== '' && !isBareTimestamp) {
      const first = content[0];
      // 正文里没粘时间戳，就退回到"上一根时间分隔线"，而且只给紧随其后的第一条
      //（见 timeMarks 的注释：给一片消息盖同一个时间就是编）。
      if (time === '') {
        const above = timeMarks.filter((m) => m.y <= first.y + 4).pop();
        if (above && !usedMarks.has(above) && first.y - above.y <= 1200) {
          time = above.time;
          usedMarks.add(above);
        }
      }
      messages.push({
        index: messages.length,
        side: contentSide,
        sender: contentSide === 'self' ? '' : pendingSender,
        title: contentSide === 'self' ? '' : pendingTitle,
        // 发消息的时间（HH:MM）。解析不出来就是空串 —— 提交给 API 时渲染成 '-'，
        // 绝不拿"当前时间"去填：那会把几分钟前的群聊说成刚刚发生的。
        time: contentSide === 'self' ? '' : time,
        // 有的客户端会把群头衔渲染在发送者的**前一行**（实测 y-1），
        // 所以把「头衔+昵称」拼起来一并提供，便于按发送者名匹配自己发的内容。
        senderWithTitle: contentSide === 'self' ? '' : (pendingTitle + pendingSender).trim(),
        text,
        rawLines: content.map((c) => String(c.name)),
        x: first.x,
        y: first.y,
        h: Math.max(...content.map((c) => c.h)),
        bottom: Math.max(...content.map((c) => c.y + c.h)),
      });
    }
    pendingSender = '';
    pendingTitle = '';
    senderRowY = null;
    senderRowFrom = null;
    content = [];
    contentSide = 'incoming';
  };

  // 预先收集所有 LV 徽章所在的行（y 和 x）。
  //
  // 必须"向前看"：元素按 (y, x) 排序，而头衔的 x 比 LV 徽章大，所以头衔会**排在
  // 它自己的 LV 行之前**（实测头衔 y=618、其 LV 行 y=619）。用「上一个 LV 行」判定
  // 会永远错开一行，这就是之前怎么改都不生效的原因。
  //
  // x 也要一起收：称号和名字的分界**只能相对 LV 徽章算**，见下面 nameOffset 的注释。
  //
  // ⚠ 这里故意**不用 inColumn，而是从 texts 重新筛**（只按 type 和 x，**不按 y**）。
  //   原因：同一条消息里各元素的高度不一样，y 边界会把同一行**切成两半**。
  //   实测踩到：聊天列 yMin=-1416 时，头衔(y=-1426, h≈20) 勉强算进来，
  //   而同行的 LV 徽章(y=-1425, h 很小) 中心点越界被丢掉 ——
  //   于是最上面那条消息找不到锚点，头衔被当成**正文**、sender 也空了
  //   （表现：第一条 text="头衔+没玩"）。
  //   锚点只靠 y 配对，多收几个界外的徽章没有副作用。
  const lvRows = texts
    .filter((t) => t.type === 'Text' && String(t.name).trim() === 'LV')
    .filter((t) => {
      const cx = t.x + t.w / 2;
      return cx >= col.xMin && cx <= col.selfXMax;
    })
    .map((t) => ({ y: t.y, x: t.x }));
  const lvRowYs = lvRows.map((r) => r.y);

  /** 这个 y 落在哪条发送者信息行上？返回该行 LV 徽章的 x；不在任何一行上返回 null。 */
  const lvAnchorX = (y) => {
    for (const r of lvRows) if (Math.abs(r.y - y) <= 2) return r.x;
    return null;
  };

  /**
   * 没有 LV 徽章时的发送者行锚点：**头像**。
   *
   * 为什么需要它（实测，换小模型之后暴露的）：
   *   有些群整屏一个 LV 徽章都没有（同一个人连续发言时 QQ 不重复渲染等级/名字行，
   *   有些群干脆不显示等级）。这时上面那套 LV 锚点全部失效，于是 ——
   *       y≈-296  G:"群友甲"@x1606  T:"群友甲"@x1656   ← 头像 + 昵称，**同一个 y**
   *       y≈-261  T:"想"@x1672                    ← 正文，下一行
   *   昵称元素被当成正文，解析出 "群友甲在干嘛呢"：名字和内容粘在一起，
   *   提交给 API 之后模型分不清哪部分是人名（用户报的就是这个）。
   *
   * 判据用**头像**（ControlType=Group，它的 Name 就是发送者昵称）：
   *   和头像同一个 y、紧跟在头像右侧的 Text，是这一行的发送者信息（昵称/称号），
   *   不是正文。
   */
  const avatarRows = texts
    .filter((t) => t.type === 'Group' && String(t.name).trim() !== '')
    .filter((t) => t.x < col.selfXMin)      // 自己那半边的头像是自己，不算"发送者行"
    .map((t) => {
      const name = String(t.name).trim();
      // 这一行里"昵称标签"的 x：名字和头像一样的那段文字。
      // 有了它才能分清「昵称左边的称号」和「昵称右边的正文」——
      // 没有它就只能靠猜宽度，某个客户端把正文放在头像同一行时会吃正文。
      const label = texts.find((o) => o.type === 'Text'
        && String(o.name).trim() === name
        && Math.abs(o.y - t.y) <= 14
        && o.x >= t.x);
      return { y: t.y, x: t.x, name, nameX: label ? label.x : null };
    });

  /**
   * 这个 (y,x) 是不是某条发送者信息行？是就返回那一行的信息。
   *
   * 注意返回的是**头像**，不只是名字：调用方要用 `nameX` 区分
   * "昵称左边的称号"和"昵称右边的正文"（见 avatarRows 里的注释）。
   */
  const avatarAt = (y, x) => {
    for (const a of avatarRows) {
      if (Math.abs(a.y - y) > 14) continue;      // 头像高约 41px，同一行给点容差
      if (x < a.x || x > a.x + 190) continue;    // 昵称/称号紧跟在头像右边
      return a;
    }
    return null;
  };

  /**
   * 称号与 QQ 名字的分界：相对 **LV 徽章**的横向偏移（像素）。
   *
   * ⚠ 方向别搞反（我搞反过一次，用户指出来的）：
   *   左边 = **称号**（含群头衔、青铜/白银这类等级称号）
   *   右边 = **QQ 名字**
   * 显示顺序就是「称号在前，名字在后」。
   *
   * 判据不是猜的，是拿**确定是名字的东西**验的：
   *   · 机器人的 QQ 昵称是「示例昵称」（群里 @ 的就是它）→ 它在发送者行里
   *     位于右侧 x=2164，左侧是「青铜」
   *   · 被 @ 的成员（一个颜文字昵称，形如 o( 星号 斜杠 斜杠… )q）也在右侧
   *     x=1865，左侧是「群友乙」
   *  所以 offset 大的那一段才是名字。
   *
   * （写注释时别把那个颜文字原样抄进来：它中间含「星号+斜杠」，
   *   会把块注释提前闭合、整个文件语法报错。这个坑我已经踩了三次。）
   *
   * 为什么不能写死绝对像素：这个偏移取决于**该用户有没有称号**。
   * 没有称号时名字起笔 x≈1732~1740；有称号时被推到 x≈1822~1830。
   * 原来写死 `x >= 1750 算名字`，于是"有称号"的人整行都算名字、
   * 而且昵称和称号还会跨消息粘成一串（实测 35 字）。
   *
   * 相对 LV 徽章就稳了，实测两种布局：
   *   称号 = LV.x + 31~39      名字 = LV.x + 74~116
   * 取 55 作分界，两边各留约 15px 余量。
   */
  const nameOffset = Number(cfg?.uia?.nameOffset) > 0 ? Number(cfg.uia.nameOffset) : 55;

  /**
   * 发送者信息行的**右边界**（相对 LV 徽章的偏移）。
   *
   * 一行头部就是贴着 LV 徽章的一小段：等级数字、称号、名字，实测最远 +116。
   * 再往右就是右侧的群成员面板了（实测 +561 起）。
   * 不设上限的话，只要面板里某个元素的 y 恰好撞上这一行，
   * 「群友己」「管理员」就会被粘进名字里 —— 实测抓到过。
   */
  const nameRowMaxOffset = Number(cfg?.uia?.nameRowMaxOffset) > 0
    ? Number(cfg.uia.nameRowMaxOffset)
    : 160;

  /** 自己发的内容右对齐（实测起笔 x≈1929），他人内容左对齐（x≈1709）。 */
  const isSelfX = (x) => x >= col.selfXMin;

  /**
   * 机器人自己的**名字标签**，不是消息。
   *
   * 实测（私聊/群聊都会出现）：自己发的那条消息旁边，QQ 会把自己的昵称渲染成一个
   * Text 元素，位置就在自己那半边（实测 x=2098、宽的 63，紧挨着自己的头像 x=2171）。
   * 它满足"右对齐 + 没有 LV 徽章"，于是被判成一条**自己发的消息**，正文就是自己的名字。
   *
   * 后果有三层，都不小：
   *   · 历史里混进一条 `[self] "示例昵称"`（真的发生过，占着上下文）
   *   · 记忆整理会把它当成一次经历
   *   · 「@ 漏判」自检拿它当证据：正文里有机器人名字、又没有 @ —— 于是每轮扫描
   *     都刷两行警告「疑似漏判@」，用户看到的就是「@ 文字丢了」，而 @ 其实好端端的。
   */
  const selfNames = new Set(
    (cfg.trigger?.botNames ?? []).map((n) => String(n ?? '').trim()).filter(Boolean),
  );

  /**
   * 1 个字的碎片不是消息。
   *
   * OCR 那条路线一直有这条规则（geometry.minMessageChars = 2，注释写着
   * 「丢掉 OCR 的 1 字符碎片（实测会出现 '0'、'1' 这种噪声）」），
   * UIA 这条路线却没有 —— 于是私聊里那串竖排的 "1".."9" 被当成了正文：
   * 实测解析出过一条 "12:06123456789" 的假消息（时间戳 + 九个数码粘在一起）。
   *
   * 代价和 OCR 那边一样：单独一个字的回复（有人就爱回个"1"）会被丢掉。
   * 两边保持一致，比一边丢一边不丢更好解释。
   */
  const minChars = Number(cfg?.geometry?.minMessageChars) > 0
    ? Math.floor(Number(cfg.geometry.minMessageChars))
    : 2;
  const tooShort = (name) => [...String(name).trim()].length < minChars;

  // 群聊判定要**在解析循环之前**就知道：私聊少一条收尾规则（见 breakIfFar）。
  // 先把布局线索拿出来（成员列表 Pane 是最硬的证据）。
  const panes0 = findLayoutPanes(uia);
  const isGroupEarly = Boolean(panes0.member) || detectGroupChat(uia, conv.name, cfg);

  /**
   * 按 y 断句：y 跳得远了就当成新的一条消息。
   *
   * 判据不是"群聊还是私聊"，而是**这一屏有没有发送者行（LV 徽章）**：
   *   · 有 LV 徽章 → 每条消息前面有一行头部会触发 flush，靠它断句就够了
   *     （群里已验证的路径，一行都不动）
   *   · 没有 LV 徽章 → 没有任何东西能把相邻消息断开，只能靠 y 间距
   *
   * 为什么不能用"是不是群聊"来判（上一版就是这么写的，踩到了）：
   *   群里**同一个人连续发言时 QQ 不重复渲染名字行**，系统消息（「修改了群名称」
   *   「加入了群聊」）更是没有头部 —— 于是那个群整屏一个 LV 徽章都没有，
   *   五六条消息被粘成一大坨（实测：一条正文里串了 2 个时间戳、3 个发送者名
   *   和 2 个 @）。而私聊那边确实也需要它（没有发送者行，会粘成「12:06在吗」）。
   *
   * 阈值 40px：同一条消息折行时行距约 20~30px，两条消息之间隔着一个头像（≥50px）。
   */
  const rowGapMax = Number(cfg?.geometry?.directRowGap) > 0 ? Number(cfg.geometry.directRowGap) : 40;
  const breakIfFar = (t) => {
    if (lvRows.length > 0) return;          // 有发送者行 → 交给 flush-on-sender-row
    if (content.length === 0) return;
    const lastY = content[content.length - 1].y;
    if (Math.abs(t.y - lastY) > rowGapMax) {
      if (debug) trace.push(`  row break y=${t.y} (上一条 y=${lastY})`);
      flush();
    }
  };

  for (const t of inColumn) {
    const name = String(t.name).trim();
    if (name === '') continue;

    // 自己发的消息：右对齐，且没有 LV 徽章。
    // 单起一条，避免被下面的发送者行判定误吞。
    if (isSelfX(t.x) && lvAnchorX(t.y) === null) {
      if (tooShort(name)) {
        if (debug) trace.push(`  skip self y=${t.y} x=${t.x} '${name}' 太短`);
        continue;
      }
      if (selfNames.has(name)) {
        if (debug) trace.push(`  skip self y=${t.y} x=${t.x} '${name}' 是自己的名字标签，不是消息`);
        continue;
      }
      breakIfFar(t);
      if (contentSide !== 'self' || content.length > 0) {
        if (content.length > 0) flush();
        contentSide = 'self';
      }
      content.push(t);
      if (debug) trace.push(`  self y=${t.y} x=${t.x} '${name}'`);
      continue;
    }
    // 内容已经在自己发的那条里，遇到非右对齐的元素就该收尾
    if (contentSide === 'self' && !isSelfX(t.x)) {
      flush();
    }

    // ---- 发送者信息行 ----
    // 一行 = 同一个 y（±2）上的一组元素：群头衔、LV 徽章、等级数字、昵称。
    //
    // ⚠ 关键：必须在**消费这一行之前**先把上一条消息收尾。
    //   Chromium 给的 y 是「头衔 618 / LV 619」，头衔排在 LV **之前**；
    //   而旧代码是"遇到 LV 就 flush"—— 那时新消息的头衔**已经被算进上一条**了。
    //   后果不是差一点点，是发送者名变成一串拼接：
    //   实测拿到过一个 35 字的发送者名（4 个名字粘一起），
    //   而且整个 sender 字段永远是空字符串（全被算成头衔）。
    //
    //   所以改成按行判断：y 离开了上一行 = 新的一行 = 上一条消息结束。
    const lvX = lvAnchorX(t.y);

    // ---- 机器人**自己**的头部行 ----
    // 自己发的消息也带一行头部（LV + 等级 + 称号 + 自己的名字），而且整体靠右。
    //
    // 必须在这里拦掉。原来的判断是「右对齐 **且没有 LV 徽章** 才算自己」，
    // 于是带了头部的自己消息落到下面的发送者行分支里，被当成**别人的**头部 ——
    // 自己的话就变成「示例昵称 说的」：
    //   · 记忆里凭空多出一个叫「示例昵称」的"群友"（用户先发现的）
    //   · 自己说过的话被记成别人的经历（"示例昵称复读我追问0.25的话"）
    //   · 历史里同一条话出现两次（一次自己、一次"示例昵称"）
    // 而「示例昵称」正好就是群里 @ 时出现的那个名字，所以看起来像"把@消息错认成人名"。
    if (lvX !== null && lvX >= col.selfXMin) {
      if (content.length > 0) flush();
      contentSide = 'self';
      // 头部那几个字（等级/称号/自己的名字）都不是消息内容，直接丢掉
      if (debug) trace.push(`  self header y=${t.y} lvX=${lvX} '${name}'`);
      continue;
    }

    if (lvX !== null) {
      if (senderRowY === null || Math.abs(t.y - senderRowY) > 2) {
        flush();                    // flush 会把 pendingSender/pendingTitle 一起清干净
        senderRowY = t.y;
        senderRowFrom = 'lv';
        if (debug) trace.push(`new sender row y=${t.y} lvX=${lvX}`);
      }
      if (name === 'LV') continue;              // 徽章本身不是名字
      if (/^\d{1,4}$/.test(name)) continue;      // 等级数字
      const offset = t.x - lvX;
      // 只认贴着 LV 徽章的那一小段（见 nameRowMaxOffset）。
      // 负偏移 = 在 LV 左边（聊天列最左边的时间戳就是这种），
      // 超出上限 = 右侧群成员面板。两者都不属于这一行，而且都不是消息内容，直接丢。
      if (offset <= 0 || offset > nameRowMaxOffset) {
        if (debug) trace.push(`  skip y=${t.y} x=${t.x} (${offset > 0 ? '+' : ''}${offset}) '${name}' 不属于头部行`);
        continue;
      }
      // 右边是 QQ 名字，左边是称号（见 nameOffset 的注释，方向别搞反）
      if (offset >= nameOffset) {
        pendingSender = (pendingSender + name).trim();
        if (debug) trace.push(`  name y=${t.y} x=${t.x} (+${offset}) '${name}'`);
      } else {
        pendingTitle = (pendingTitle + name).trim();
        if (debug) trace.push(`  title y=${t.y} x=${t.x} (+${offset}) '${name}'`);
      }
      continue;
    }

    // ---- 没有 LV 徽章时的发送者行：靠头像 ----
    //
    // 见 avatarRows 的注释：有的群整屏一个 LV 徽章都没有（同一个人连续发言、
    // 或者这个群本来就不显示等级），这时上面那套 LV 锚点全部失效，
    // 昵称元素会被当成正文，解析出 "群友甲在干嘛呢" 这种名字粘内容的结果 ——
    // 用户看到的就是"消息名字和内容粘连在一起"。
    //
    // 归类的边界用**昵称标签的 x**（avatarRows 里的 nameX）：
    //   · 和头像同名的那个文字  → 昵称，直接吃掉（它就是 pendingSender）
    //   · 昵称**左边**的短元素  → 称号
    //   · 昵称右边 / 更远的元素 → 不动，交给下面的正文分支
    // 最后这条是关键：QQ 的布局不止一种，万一某个客户端把正文放在头像同一行，
    // "右边就是正文"能让它照样读到；宁可正文多粘一点，也不能把正文当称号吃掉。
    const av = avatarAt(t.y, t.x);
    if (av !== null) {
      if (senderRowY === null || Math.abs(t.y - senderRowY) > 2) {
        flush();
        senderRowY = t.y;
        senderRowFrom = 'avatar';
        if (debug) trace.push(`new avatar sender row y=${t.y} x=${t.x} '${av.name}'`);
      }
      // 头像是这一行的主人：昵称直接来自它（Text 那个同名元素只是标签）
      pendingSender = av.name;
      if (name === av.name) continue;
      if (av.nameX !== null && t.x < av.nameX) {
        pendingTitle = (pendingTitle + name).trim();
        if (debug) trace.push(`  avatar title y=${t.y} x=${t.x} '${name}'`);
        continue;
      }
      if (debug) trace.push(`  avatar row 右侧 y=${t.y} x=${t.x} '${name}' → 当正文`);
    }
    // 行还没换、但这一行里还有别的元素（比如某些客户端把称号渲染在下一行）：
    // 按同样的相对偏移规则归类，不要漏掉。
    // ⚠ 只对 LV 行成立：这里的偏移是相对 LV 徽章算的，头像行没有这个锚点，
    //   而且头像行早就被上面那段处理完了 —— 放它进来会把同一行的正文丢掉。
    if (senderRowFrom === 'lv' && senderRowY !== null && Math.abs(t.y - senderRowY) <= 2) {
      if (/^\d{1,4}$/.test(name)) continue;
      const anchor = lvRows.find((r) => Math.abs(r.y - senderRowY) <= 2);
      const offset = anchor ? t.x - anchor.x : 0;
      // 同样的边界限制：LV 左边的时间戳、右边面板里的成员名，都不属于头部行
      if (offset <= 0 || offset > nameRowMaxOffset) continue;
      if (offset >= nameOffset) pendingSender = (pendingSender + name).trim();
      else pendingTitle = (pendingTitle + name).trim();
      continue;
    }

    // 其余都算消息内容
    if (tooShort(name)) {
      if (debug) trace.push(`  skip y=${t.y} x=${t.x} '${name}' 太短`);
      continue;
    }
    breakIfFar(t);
    content.push(t);
    if (debug) trace.push(`  content y=${t.y} x=${t.x} '${name}'`);
  }
  flush();

  // 注意：UIA 里自己的消息不容易靠坐标区分（QQ 在自己的消息上不显示 LV 徽章，
  // 且横向偏移受昵称长度影响）。真正的防自嗨靠 gate.js 的 sentReplies 比对，
  // 那里按文本匹配，比坐标可靠。
  // 自己发的消息现在能靠右对齐认出来了（实测起笔 x≈1929，阈值 selfXMin）。
  // 但仍不排除极端情况认错，所以防自嗨是**双保险**：
  // 这里的 side='self' 会被 gate.js 跳过，另有 sentReplies 文本比对兜底。
  const incoming = messages.filter((m) => m.side === 'incoming');
  const self = messages.filter((m) => m.side === 'self');

  // 群聊判定：有成员列表 Pane 就已经是铁证；没有再用会话名/成员头衔那些线索。
  // （循环开始前就算过了，私聊的收尾规则要用它）
  const isGroup = isGroupEarly;

  // ---- 私聊：把发送者补上 ----
  //
  // 群聊每条消息前面有一行发送者信息（LV 徽章 + 称号 + 昵称），私聊**没有**，
  // 所以 pendingSender 一直是空的，消息的 sender 也是空 ——
  // 表现是提示词里写成「某人：在吗」，记忆整理那边更糟：它会想给"某人"建一条关系
  //（好在 PLACEHOLDER_NAMES 把「某人」挡掉了，但等于白记）。
  // 私聊里说话的人就是会话名本人，直接补上。
  if (!isGroup && conv.name) {
    for (const m of messages) {
      if (m.side !== 'incoming' || m.sender) continue;
      m.sender = conv.name;
      m.senderWithTitle = conv.name;
      m.senderFrom = 'direct-peer';   // 标一下来源：这不是解析出来的名字，是推断的
    }
  }

  const contentBottom = messages.length
    ? Math.max(...messages.map((m) => m.bottom))
    : col.yMin;

  return {
    source: 'uia',
    parserVersion: 'uia-7-fields',
    trace,
    conversation: conv.name,
    conversationCandidates: conv.candidates,
    // 群聊判定由解析器给出（用 UIA 自己的证据）。gate.js 优先用它，
    // 因为「会话名带成员数」这条在 UIA 路线下不成立。
    isGroup,
    // 布局是从哪儿算出来的：panel（以消息列表面板为锚，私聊/群聊都适用）
    // 还是 offsets（拿不到 Pane 时的兜底）。出问题时先看这个。
    layoutAnchor: col.anchor,
    // 发送者行是**靠什么认出来的**：lv（LV 徽章）/ avatar（头像）/ none（这屏没有发送者行，
    // 只能靠 y 间距断句）。排错时先看这个 —— 名字和正文粘连的故障就出在这里。
    senderAnchor: lvRows.length > 0 ? 'lv' : (avatarRows.length > 0 ? 'avatar' : 'none'),
    avatarCount: avatarRows.length,
    hasMemberPane: Boolean(panes.member),
    column: col,
    timestamps: [],
    messages,
    incoming,
    self,
    contentBottom,
    size: { w: 0, h: 0 },
    // 其中有多少是在视口上方的（负 y）—— 用来判断上下文有多长
    offscreenAbove: messages.filter((m) => m.y < 0).length,
  };
}
