/**
 * takeover.js — 「AI 接管模式」：指令识别、模式状态、提示词与语气池。
 *
 * 抽成独立模块而不是留在 bot.js 里，是为了能单独测试 ——
 * bot.js 一 import 就会跑主循环，没法当库用。
 *
 * 设计要点：
 *   · 开关存在 state.json 的 takeoverEnabled，**运行时切换不用重启**
 *   · 指令消息本身不当普通消息回，而是回一句应答（否则成了自问自答）
 *   · 接管模式下，本地降级池也换成可爱语气 ——
 *     这样 API 断了语气不会突然掉回客服腔
 */
import { ROOT } from './config.js';
// 人设 = 可切换的身份：提示词在 personas/<名字>.json 里，切换后**立刻生效**（见 persona.js）
import { activePersonaName, loadPersona } from './persona.js';

/** 把文本压平用于匹配（去掉所有空白，全角空格也去掉）。 */
function flatten(s) {
  return String(s ?? '').replace(/[\s\u3000]+/g, '').trim();
}

/**
 * 在解析出的消息里找接管/下班指令。
 *
 * 只看他人消息，且**从新到旧**——后说的指令应该盖过前面的。
 *
 * ⚠ 必须限制在「最近的几条」里找，不能扫全窗口。
 * 原因：一条老指令会**永远留在聊天窗里**，每一轮扫描都会被重新检测到。
 * 检测到之后调用方要处理（切模式 + 应答 + 本轮不处理别的消息），
 * 于是「你接管」这一句话会让机器人每一轮都在这里掉头，永远不再回任何别的消息。
 * 实测踩过：日志里刷了上百行「接管指令 → 已经是开启状态，忽略」，
 * 而两条之间**一条扫描汇总都没有** —— 说明每一轮都提前 return 了。
 *
 * 限成最近 3 条之后，滚出窗口的老指令自然失效。
 * 代价：如果发完指令、还没到下一轮扫描（约 4 秒）又来了 3 条以上新消息，
 * 这条指令会被漏掉。真漏了不会静默 —— 没有应答消息，重发一次即可。
 *
 * @param {{messages:Array}} parsed
 * @param {object} cfg
 * @param {{window?:number}} [opts] 覆盖 persona.commandWindow
 * @returns {{cmd:'enable'|'disable'|null, message:object|null}}
 */
export function detectTakeoverCommand(parsed, cfg, opts = {}) {
  const p = cfg?.persona;
  if (!p) return { cmd: null, message: null };

  const enablePats = (p.takeoverPatterns ?? []).map(flatten).filter(Boolean);
  const releasePats = (p.releasePatterns ?? []).map(flatten).filter(Boolean);
  if (enablePats.length === 0 && releasePats.length === 0) {
    return { cmd: null, message: null };
  }

  const rawWin = opts.window ?? p.commandWindow ?? 3;
  const n = Number(rawWin);
  const win = Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;

  const incoming = (parsed?.messages ?? [])
    .filter((m) => m.side !== 'self')
    .slice(-win)          // 只保留最近 win 条
    .slice()
    .reverse();           // 再翻成从新到旧

  for (const m of incoming) {
    const t = flatten(m.text);
    if (t === '') continue;
    if (enablePats.some((pat) => t.includes(pat))) return { cmd: 'enable', message: m };
    if (releasePats.some((pat) => t.includes(pat))) return { cmd: 'disable', message: m };
  }
  return { cmd: null, message: null };
}

/**
 * 决定「检测到的这条指令该怎么处理」——**只算，不发送、不落盘**。
 *
 * 抽出来是为了能回归测试那个真踩过的坑：
 * 老指令会被反复检测到，而当时的实现在「已经处于该状态」时**也**提前 return，
 * 于是每一轮扫描都在这里掉头，机器人再也不会处理任何别的消息（看起来就是"卡死了"）。
 *
 * 调用方（bot.js）的约定：
 *   action === 'apply'  → 切状态 + 回应答 + 本轮不再处理别的消息（return）
 *   action === 'ignore' → **什么都不做，但必须继续往下走**，处理别的消息
 *   action === 'none'   → 没检测到指令
 *
 * @returns {{action:'none'|'apply'|'ignore', willBe:boolean, fingerprint:string|null, reason:string}}
 */
export function planTakeoverCommand(state, detected, cfg) {
  const msg = detected?.message ?? null;
  const cmd = detected?.cmd ?? null;
  if (!cmd || !msg) {
    return { action: 'none', willBe: false, fingerprint: null, reason: '没有指令' };
  }

  const willBe = cmd === 'enable';
  const fingerprint = `${state?.conversation ?? ''}|${msg.side}|${msg.text}`;
  const wasOn = isTakeoverActive(state, cfg);

  if (wasOn === willBe) {
    return {
      action: 'ignore', willBe, fingerprint,
      reason: `已经是${willBe ? '开启' : '关闭'}状态`,
    };
  }
  return {
    action: 'apply', willBe, fingerprint,
    reason: `切换到${willBe ? '开启' : '关闭'}`,
  };
}

/**
 * 算出**当前生效**的回复概率。
 *
 * 接管期间默认变成「每条都回」——接管的意义就是我在替你聊，
 * 只回四分之一会让对话断断续续的。
 * 想保留概率就把 persona.replyAllWhenActive 设为 false。
 *
 * 注意这里不 import gate.js：gate.js 已经 import 了 config/parse，
 * 反向 import 会形成环。所以状态由调用方传进来。
 *
 * @param {object} state 运行状态（含 takeoverEnabled）
 * @param {object} cfg
 * @returns {number|undefined} 0~1；undefined 表示没配概率（=全回）
 */
export function effectiveReplyProbability(state, cfg) {
  const raw = cfg?.trigger?.replyProbability;
  if (isTakeoverActive(state, cfg) && cfg?.persona?.replyAllWhenActive !== false) {
    return 1;
  }
  if (raw === undefined || raw === null) return undefined;
  const n = Number(raw);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * 当前是否处于接管模式。
 * state 里显式设过就用 state（运行时切换），否则看 config 的初始值。
 */
export function isTakeoverActive(state, cfg) {
  if (typeof state?.takeoverEnabled === 'boolean') return state.takeoverEnabled;
  return cfg?.persona?.enabled === true;
}

/**
 * 把 systemPrompt 规范成字符串。
 *
 * 坑：config.json 里写成字符串数组更好读（按行分行），但 API 的 content
 * 必须是字符串。直接传数组会让 API 报错 → 悄悄降级到本地规则，
 * 表现成「接管开着但回复不是模型生成的」。这里统一拼起来。
 */
export function normalizePrompt(p) {
  if (Array.isArray(p)) return p.map((l) => String(l ?? '')).join('\n').trim();
  return String(p ?? '').trim();
}

/**
 * 接管模式下用 persona.systemPrompt，否则用 llm.systemPrompt。
 *
 * 踩过的坑：`persona.systemPrompt` 被保存成**空数组**时，`[]` 在 JS 里是 truthy，
 * 于是这里判断通过、`normalizePrompt([])` 返回空字符串，**默认提示词被丢掉**。
 * 后果不只是"没人设" —— 空 content 会让 API 直接报错，
 * 机器人于是静默降级到本地规则，看起来就是"回复突然变机械了"。
 *
 * 所以两个提示词都规范化后，**谁非空用谁**，都空才用兜底。
 */
export function activeSystemPrompt(state, cfg) {
  const llmPrompt = normalizePrompt(cfg?.llm?.systemPrompt);

  // ⚠ 优先用**当前人设**那份提示词（见 src/persona.js）。
  //
  // 为什么现读文件、而不是继续用 config 里的那句：人设是"可切换的身份"，
  // 切换要**立刻生效**；而 config.json 是启动时读一次就缓存住的 ——
  // 放在那里就等于"切一次人设要重启一次机器人"（用户要的恰恰不是这个）。
  // 没建过 personas/ 时这里返回空串 → 落回下面的老逻辑，行为完全不变。
  const personaPrompt = personaPromptFor(state, cfg);
  if (personaPrompt) {
    if (isTakeoverActive(state, cfg)) return personaPrompt;
    // 非接管模式：仍然 llm.systemPrompt 优先（那是"不接管时的通用回复"那套），
    // 没有它才用当前人设 —— 跟老代码同一个取舍，只是把"哪份人设提示词"换成了现读的。
    return llmPrompt || personaPrompt;
  }

  const configPrompt = normalizePrompt(cfg?.persona?.systemPrompt);
  if (isTakeoverActive(state, cfg) && configPrompt) return configPrompt;
  return llmPrompt || configPrompt || '';
}

/**
 * 当前人设的提示词（没建人设 / 文件读不出来时返回空串）。
 *
 * ⚠ 这里**故意吞掉异常**：人设文件坏了不该让机器人整个起不来，
 *   返回空串就会落到 config.json 那份（老逻辑），最坏结果是"人设没切过去"。
 */
function personaPromptFor(state, cfg) {
  try {
    const name = activePersonaName(cfg, state);
    if (!name) return '';
    const p = loadPersona(cfg, ROOT, name);
    return p ? normalizePrompt(p.systemPrompt) : '';
  } catch {
    return '';
  }
}

/** 接管/关闭时应答一句。随机取，空池返回空串（表示不该答）。 */
export function commandAck(cmd, cfg) {
  const p = cfg?.persona;
  if (p?.replyToCommands === false) return '';
  const pool = cmd === 'enable'
    ? (p?.onEnableReplies ?? ['来了来了'])
    : (p?.onDisableReplies ?? ['那我撤了']);
  if (!Array.isArray(pool) || pool.length === 0) return '';
  return String(pool[Math.floor(Math.random() * pool.length)]);
}

/**
 * 这次到底要不要发 API 请求。
 *
 * 默认策略：**只有接管模式才调 API**。
 *   接管   = 小深上线，用大模型 + persona 人设
 *   不接管 = 小深不在，本地固定回复池顶班（最初的需求 2：没调 API 时被 @ 也能回两句）
 *
 * 为什么不做成「两种模式都调」：
 *   1. 非接管时 activeSystemPrompt 给的是 llm.systemPrompt 那句通用话，
 *      控制台里精心写的 persona 根本用不上 —— 花了钱还不像小深，两头不占。
 *   2. 接管开关的语义应该跟使用者的直觉一致：「关掉」= 不花这份钱。
 *
 * 想回到旧行为：config.json 里 llm.callApiInTakeoverOnly = false。
 *
 * @returns {{call: boolean, reason: string}} reason 会原样进日志，别写含糊。
 */
export function shouldCallApi(state, cfg) {
  const c = cfg?.llm ?? {};
  // 这两条 generateReply 自己也会判，但先在这里判掉能少一次无意义的调用，
  // 而且 reason 跟 generateReply 的 FAIL 码保持一致，日志看起来是同一套。
  if (!c.enabled) return { call: false, reason: 'disabled' };
  if (!c.apiKey) return { call: false, reason: 'no-key' };
  if (isTakeoverActive(state, cfg)) return { call: true, reason: 'takeover' };
  if (c.callApiInTakeoverOnly === false) return { call: true, reason: 'always' };
  return { call: false, reason: 'not-takeover' };
}

/**
 * 这一次调用**失败**之后，要不要退回本地固定回复？
 *
 * 背景（用户问的「为什么接管模式还有固定回复」+ 他选的方案）：
 *   接管模式的回复是两级 —— 先让模型生成，失败才用本地池子顶一句。
 *   留这套兜底的理由是别在被人 @ 的时候装死，而且用的是接管语气的池子
 *   （不会从「诶嘿」突然掉成「收到，我看看」）。
 *   但用户的选择是：**模型调不通就别发罐头话** —— 宁可不回，也别发容易穿帮的那句。
 *
 * 所以 `config.reply.fallbackWhenApiDown` 现在是**真的生效**的。
 * ⚠ 在这之前它是个死开关：config.json 里写着、全项目没有任何代码读它 ——
 *   改成 false 行为一点不变、也不报错，是最坏的那种配置。
 *
 * 哪些算「模型调不通」（受这个开关管）：
 *   请求**发出去了**但失败/超时/返回空 → 算。开关为 false 时一个字都不发。
 * 哪些不算（不受影响，照旧用本地回复）：
 *   · 非接管模式          —— 本来就不调 API，本地回复是设计如此（需求 2）
 *   · llm.enabled = false —— 用户主动关掉了大模型，那本来就是要用本地那一套
 *   · 没配 key            —— 控制台一直明说「没配 key 会退化成固定话术回复」，
 *                            这是**预告过的降级**，不是故障，不该突然变成不回
 *
 * @param {object} cfg
 * @param {{apiAttempted?:boolean}} opts apiAttempted = 这一次真的把请求发出去了
 */
export function fallbackAllowedAfterApiFailure(cfg, opts = {}) {
  if (opts.apiAttempted !== true) return true;
  return cfg?.reply?.fallbackWhenApiDown !== false;
}

