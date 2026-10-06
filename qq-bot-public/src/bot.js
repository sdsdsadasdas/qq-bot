/**
 * bot.js — 主循环。
 *
 * 两条需求的落点：
 *   需求 1「启动时监测消息并恰当回复」
 *       → --watch 持续轮询；captureAndOcr → parseChat → decide → generateReply → sendMessage
 *   需求 2「API 并未调用时，被 @ 也要给出简单回复」
 *       → generateReply 失败（超时/报错/没配 key/被关）时自动降级到 fallbackReply 本地规则，
 *         群里被 @ 的判定在 gate.js 里，与 API 是否可用完全解耦。
 *
 * 用法：
 *   node src/bot.js --once                扫描一次，只报告不发送（dryRun 默认开）
 *   node src/bot.js --watch               持续监测（仍然受 config.reply.dryRun 控制）
 *   node src/bot.js --watch --send        真正发送（危险，确认白名单和话术后再用）
 *   node src/bot.js --once --verbose      打印解析细节
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig, isWhitelisted, replyScopeOf, ROOT } from './config.js';
import { initLogger, log, closeLogger, logPath } from './logger.js';
import { readConversation } from './reader.js';
import { generateReply, generateMemoryPatch, generateLifeSimulation, apiCallStats, renderIncomingLine } from './llm.js';
import { fallbackReply, clampReply } from './fallback.js';
import {
  loadStore, saveStore, renderMemory, applyMemoryPatch, shouldUpdateMemory, summarizeChanges,
  migrateLegacy, listConversations, loadGlobal,
} from './memory.js';
import {
  createLifeTicker, loadLifeLog, renderLife, appendLifeEntry, lifeDigestFor, lifeConfig,
  decideShare, recordShare, updateLifeEntry, countSharesToday,
  lifeEnabled, shareEnabled, activeProfile, nextLifeClock, lifeClockGate,
} from './life.js';
import { sendMessage, verifySentByOcr } from './sender.js';
import {
  loadState, saveState, decide, markSeen, markSent, markReplied, isGroupConversation, rateLimitCheck,
  pruneSeenToWindow,
  enqueuePending, peekPending, shiftPending,
  findPendingFor, shiftPendingAt, pendingConversations,
} from './gate.js';
import {
  detectTakeoverCommand, isTakeoverActive, activeSystemPrompt as activeSystemPromptOf, commandAck, shouldCallApi,
  effectiveReplyProbability, planTakeoverCommand, fallbackAllowedAfterApiFailure,
} from './takeover.js';
import { mentionSelfCheck, isMentioned, looksLikeMissedMention } from './parse.js';
import { readSessions, switchToConversation, readCurrentConversation, readUserIdleMs } from './switch.js';
import { targetConversations, pickNextConversation, shouldSwitchNow, sessionMatches, autoScopeOf, shouldPauseForUser } from './sessions.js';
import { consolePort, consoleRequired, probeConsole, startupVerdict, createConsoleWatch } from './console-guard.js';

const cfg = loadConfig();

/**
 * 控制台探测结果，给 banner 用。
 * 探测发生在 acquireLock 之前（被拒时不该去抢锁），显示在 banner 里所以要存一下。
 */
let consoleInfo = null;

/**
 * 被@自检的累计计数（只在本进程内存里，不落盘）。
 * 攒够样本还是零命中才警告一次，避免刚启动没有历史时误报。
 */
const mentionWatch = { sawAt: 0, hit: 0, warned: false };

/**
 * 旧版单文件记忆只迁移一次。
 * 迁移需要知道"当前是哪个会话"，所以要等第一次扫描读到会话名才能做 ——
 * 启动时读不到，这就是它不放在 main() 里的原因。
 */
let legacyMigrated = false;

/**
 * 当前 QQ 上开着的是哪个会话。
 *
 * 两个来源：扫描读到的（真相）、以及自动切换点完之后记下的（预期）。
 * 两者都要，因为：
 *   · 用户可能自己手动换了会话 —— 那时只有"读到的"才是真的
 *   · 刚点完还没扫描时，只有"记下的"能用
 * 自动切换用它来避免"已经在目标会话上还去点一下"（每次点击都会抢焦点）。
 */
let currentConversationName = '';
function setCurrentConversation(name) {
  currentConversationName = String(name ?? '').trim();
}
function getCurrentConversation() {
  return currentConversationName;
}

/** 自动切换那个"只提醒一次"的标记（没有可切换目标时别每轮刷日志）。 */
const switchWatch = { warned: false };

/**
 * 单实例锁。
 *
 * 为什么需要：两个实例同时跑会**重复回复同一条消息** —— 它们共享 state.json，
 * 谁先写谁算数，另一个的 markSeen 可能被覆盖，于是同一条消息被回两次。
 * 实测踩过：旧实例没退干净时启动了新实例。
 *
 * 用 pid 文件 + 存活检查。进程被杀掉后残留的锁文件会被自动接管。
 */
const LOCK_FILE = path.join(ROOT, '.bot.lock');

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const old = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
      if (old && old !== process.pid) {
        let alive = false;
        try { process.kill(old, 0); alive = true; } catch { alive = false; }
        if (alive) {
          log.error(`已有实例在运行（PID ${old}）。同时跑两个会重复回复同一条消息。`);
          log.error(`先停掉它：Ctrl+C，或 taskkill /PID ${old} /F`);
          closeLogger();
          process.exit(3);
        }
        log.warn(`发现残留的锁文件（PID ${old} 已不存在），接管。`);
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
  } catch (err) {
    log.warn(`写锁文件失败（不影响运行）: ${err.message}`);
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const cur = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
      if (cur === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

function banner() {
  const dry = cfg.reply?.dryRun ?? true;
  const wl = cfg.trigger?.whitelist ?? [];
  log.info('='.repeat(64));
  log.info('QQ 消息监测 / 自动回复');
  log.info(`  日志        : ${logPath()}`);
  log.info(`  模式        : ${dry ? '只报告（dryRun）' : '真实发送（会真的发出去！）'}`);
  log.info(`  读取方式    : ${cfg.readSource === 'ocr' ? 'OCR（兜底路线）' : 'UIA 无障碍树（推荐，失败自动降级 OCR）'}`);
  if (consoleInfo) {
    // 这一行很重要：用户看到机器人跑着，第一件事就是确认"控制台是连着的吗"。
    log.info(`  控制台      : ${consoleInfo.text}`);
  }
  log.info(`  大模型      : ${cfg.llm?.enabled ? `${cfg.llm.providerName ?? cfg.llm.provider}/${cfg.llm.model}` : '已关闭'}  key=${cfg.llm?.apiKeySource ?? 'none'}`);
  log.info(`  调用时机    : ${cfg.llm?.callApiInTakeoverOnly !== false ? '仅接管模式（不接管时用本地规则，不花钱）' : '所有模式（不接管也会调 API）'}`);
  if (cfg.llm?.enabled && !cfg.llm?.apiKeySet) {
    const others = (cfg.llm.providerList ?? []).filter((p) => p !== cfg.llm.providerName);
    log.warn(`  没读到 API key → 回复会走本地规则。`);
    log.warn(`    配 key：设环境变量 ${cfg.llm.apiKeyEnv}，或把 key 写进 config.json 的 llm.providers.${cfg.llm.providerName}.apiKey`);
    if (others.length) log.warn(`    换厂商：改 config.json 的 llm.provider（可选 ${others.join(' / ')}）`);
  }
  log.info(`  降级规则    : ${cfg.fallback?.enabled ? `开启（${(cfg.fallback.rules ?? []).length} 条规则 + ${(cfg.fallback.generic ?? []).length} 条通用）` : '关闭'}`);
  {
    // 记忆这块启动时必须说清楚三件事：开没开、文件在哪、多久整理一次。
    // 「它怎么不记得我」这类问题，九成是 file 指错了或者节流把它挡了。
    const mc = cfg.memory ?? {};
    if (!mc.enabled) {
      log.info('  记忆        : 关闭');
    } else {
      const lim = mc.limits ?? {};
      const every = Number(mc.updateEvery);
      const gap = Number(mc.updateMinIntervalMs);
      const when = [
        Number.isFinite(every) && every > 1 ? `每 ${Math.floor(every)} 次回复整理一次` : '每次回复后整理',
        Number.isFinite(gap) && gap > 0 ? `间隔≥${Math.round(gap / 1000)}s` : '',
      ].filter(Boolean).join('，');
      // 记忆现在分两层：总记忆一份 + 每个会话一份。
      // 启动时把**有几份**说清楚 —— "它怎么不记得我了"多半是会话名对不上，
      // 而这件事光看配置看不出来。
      const g = loadGlobal(cfg, ROOT);
      const convs = listConversations(cfg, ROOT);
      const gState = g.ok ? `${g.memory.facts.length} 条自我认知/${g.memory.likes.length} 个喜好` : (
        g.reason === 'missing' ? '还没有，首次更新时创建' : `读取失败(${g.reason})`
      );
      log.info(`  记忆        : 开启（总记忆 ${mc.file ?? 'memory.json'} · 会话记忆 ${(mc.dir ?? 'memory')}/ · ${when}）`);
      log.info(`                上限 经历${lim.events ?? 40}/关系${lim.relations ?? 20}/单条${lim.itemChars ?? 60}字`);
      log.info(`                总记忆：${gState}`);
      log.info(`                会话记忆：${convs.length} 份${convs.length ? `（${convs.slice(-4).map((c) => c.conversation || c.file).join('、')}${convs.length > 4 ? ' …' : ''}）` : ''}`);
    }
  }
  // 「回复范围」是用户最容易搞错的一项：以前只能靠「白名单填没填」来表达
  // 「要不要限制范围」，而「把白名单清空」的效果恰好是**谁也不回**（跟直觉相反）。
  // 所以这里把模式本身和它的最终后果一起说清楚。
  {
    const scope = replyScopeOf(cfg);
    const bl = cfg.trigger?.blacklist ?? [];
    if (scope === 'all') {
      log.info('  回复范围    : 所有会话（白名单不参与判定）');
    } else if (wl.length === 0) {
      log.info('  回复范围    : 仅白名单，但白名单是空的 → 不会回复任何会话');
    } else {
      log.info(`  回复范围    : 仅白名单 → ${wl.join(', ')}`);
    }
    if (bl.length) log.info(`  黑名单      : ${bl.join(', ')}（两种模式下都生效）`);
  }
  log.info(`  群内只在@时 : ${cfg.trigger?.replyInGroupOnlyWhenMentioned !== false ? '是' : '否'}`);

  // 人生模拟的状态也报一下。它默认是开的、而且会持续调 API ——
  // 用户不看日志的话根本不知道有东西在花钱/占显卡（不报的话它就是隐形的）。
  {
    // 现读一次 state：控制台可能已经把开关改过了，banner 不能照着 config 念
    const rt = refreshLifeRuntime();
    const lc = lifeConfig(cfg);
    const lifeName = rt.profile ? `「${rt.profile}」` : '（默认那份）';
    if (!rt.enabled) {
      log.info('  人生模拟    : 关（不聊天的时候它不会自己去过日子）');
    } else {
      const { log: lifeLog } = loadLifeLog(cfg, ROOT, rt.profile);
      const last = lifeLog.entries.length ? lifeLog.entries[lifeLog.entries.length - 1] : null;
      const ago = last ? `，上次 ${Math.round((Date.now() - last.at) / 60000)} 分钟前` : '，还没有记录';
      // 角色时钟单独报一句：它跟真实时间不是一回事（每次模拟往前推 stepMinutes），
      // 不报的话用户看到日志里的时间会觉得"怎么对不上系统时间"。
      const clk = lifeConfig(cfg).clock;
      const clockNote = clk.stepMinutes > 0
        ? (clk.maxAheadMinutes > 0
          ? `｜生活时钟每次 +${clk.stepMinutes} 分钟（最多领先现实 ${clk.maxAheadMinutes} 分钟）`
          : `｜生活时钟每次 +${clk.stepMinutes} 分钟，不许跑到现实前面`
            + `（世界还在未来时就不模拟 —— 那段时间不调用 API）`)
        : '｜生活时钟：关（用真实时间）';
      log.info(`  人生模拟    : 每 ${lc.everyChecks} 次控制台检测试一次（期间没调用过 API 才动）`
        + `｜正在过 ${lifeName} 的人生：${lifeLog.entries.length} 条${ago}${clockNote}`);
    }

    // 主动分享要单独、显眼地报 —— 它是唯一会**主动跟真人说话**的功能。
    // 混在上一行里被忽略的话，用户某天会突然发现机器人在群里自己冒话。
    const sh = lc.share;
    if (!rt.share) {
      log.info(`  主动分享    : 关（${rt.enabled ? '人生模拟只写日志，不往群里说话' : '人生模拟也是关的'}）`);
    } else {
      const sharesToday = countSharesToday(loadState(), Date.now());
      const quiet = sh.quietFrom !== sh.quietTo ? `｜静默 ${sh.quietFrom}~${sh.quietTo} 点` : '';
      log.info(`  主动分享    : 开 —— 模型说"值得说"时才会开口`
        + `｜至少隔 ${Math.round(sh.minIntervalMs / 60000)} 分钟｜每天最多 ${sh.maxPerDay} 次`
        + `｜今天已 ${sharesToday} 次${quiet}`);
      log.warn('主动分享是**无人触发就说话**：它会在没人跟它讲话时，自己往群里发一句。');
    }
  }
  {
    // 显示**生效**概率而不是配置值 —— 接管期间会自动升到 100%，
    // 只显示配置里的 25% 会让人以为没生效。
    const on = takeoverActive();
    const eff = effectiveReplyProbability(loadState(), cfg);
    const configured = cfg.trigger?.replyProbability;
    const fmt = (v) => (v === undefined ? '未设置（=全部回复）' : `${(Number(v) * 100).toFixed(0)}%`);
    const mentionText = cfg.trigger?.mentionAlwaysReplies === false ? fmt(eff) : '必回';

    // ⚠ truth-in-advertising：「群内只在@时」这道闸门在 gate.js 里排在概率**之前**
    // （见 gate.js 的 mentionOnly 判断），所以它开着的时候，概率再高也轮不到非@消息。
    // 以前这里照直写「其他消息 100%」「接管模式：每条都回」，两条都是假的，
    // 会让人以为机器人坏了 —— 实际是被只在@时挡下的。
    const mentionOnly = cfg.trigger?.replyInGroupOnlyWhenMentioned !== false;

    let probLine = `  回复概率    : 被@ ${mentionText} ／ 其他消息 ${fmt(eff)}`;
    if (on && configured !== undefined && Number(configured) !== Number(eff)) {
      probLine += `  ← 接管模式自动提升（配置值 ${fmt(configured)}）`;
    }
    if (mentionOnly) probLine += '  【非@消息在概率之前就被「群内只在@时」挡下，上面的概率对它们无效】';
    log.info(probLine);

    // ⚠ 这两个开关会打架，而且打得很难看。
    //
    // gate.js 里「群内只在@时」排在掷骰子**之前**：它一开，replyProbability
    // 对群里的非@消息就永远用不上了 —— 整段概率代码成了死代码。
    // 而用户既然配了非 0 概率，本意就是"随机回一些"。
    // 实测踩过：只在@时=true + 概率 25%，200 条普通群消息回 0 条，
    // 用户的感受就是"随机回复没生效"。
    //
    // 这里必须用 warn 而不是 info：这行如果混在启动 banner 里，
    // 根本没人会注意到，问题会一直挂着。
    const probConfigured = Number(configured);
    if (mentionOnly && Number.isFinite(probConfigured) && probConfigured > 0) {
      log.warn(`  ⚠ 「群内只在@时」开着 → 上面那个 ${fmt(configured)} 概率对群消息**完全不会生效**（非@消息在概率之前就被挡下了）。`);
      log.warn('     想让「被@必回 + 其他消息随机回一些」生效：把 config.json 的 trigger.replyInGroupOnlyWhenMentioned 改成 false。');
      log.warn('     只想被@时回、不要随机：把 trigger.replyProbability 改成 0，两个开关的意思就一致了。');
    }

    log.info(`  发送限速    : 冷却 ${cfg.trigger?.cooldownMs ?? 0}ms，每分钟上限 ${cfg.trigger?.maxRepliesPerMinute ?? 0}（0 = 不限）`);

    // 「接管模式」这行的措辞必须跟着**实际行为**走。
    //
    // 之前只看了 mentionOnly，于是把 replyAllWhenActive 设成 false
    // （接管期间也按概率回）时，这行仍在喊「每条都回」—— 又是一句假话。
    // 这一片代码已经因为"显示的跟做的不一致"坑过两次了，所以这里三个条件都摊开写。
    const replyAll = cfg.persona?.replyAllWhenActive !== false;
    let takeDesc;
    if (!on) {
      takeDesc = '未开启（被@时用本地固定回复，不调 API）';
    } else if (replyAll && !mentionOnly) {
      takeDesc = '已开启（每条都回，回复由大模型生成，可爱语气）';
    } else {
      const why = !replyAll
        ? `按配置概率回（${fmt(eff)}），不是每条都回`
        : '群内非@消息仍被「只在@时」挡下';
      takeDesc = `已开启（回复由大模型生成，可爱语气；但${why}）`;
    }
    log.info(`  接管模式    : ${takeDesc}`);
    if (cfg.persona?.takeoverPatterns?.length) {
      log.info(`               发「${cfg.persona.takeoverPatterns[0]}」开启，发「${cfg.persona.releasePatterns?.[0] ?? '你下班'}」关闭`);
    }
    // 指令只在最近几条里找（老指令会一直留在聊天窗里，扫全窗口会被反复触发）
    log.info(`  指令识别窗  : 最近 ${cfg.persona?.commandWindow ?? 3} 条他人消息（persona.commandWindow 可调）`);
  }
  log.info('='.repeat(64));
  if (replyScopeOf(cfg) === 'whitelist' && wl.length === 0) {
    log.warn('回复范围是「仅白名单」，而白名单是空的 → 脚本只会「看」不会「回」。');
    log.warn('  想只在指定会话里回：把会话名填进 config.json 的 trigger.whitelist。');
    log.warn('  想所有会话都回：把 trigger.replyScope 改成 "all"（白名单就不用管了）。');
  }
  if (!dry) log.warn('当前是真实发送模式。回复会以这个 QQ 号的身份发出去，请确认对象都知道这是自动回复。');
}

/**
 * 接管的 systemPrompt：接管模式用 persona 的，否则用 llm 的。
 * 逻辑在 src/takeover.js —— 抽出去是为了能单独测试（bot.js 一 import 就跑主循环）。
 */
function activeSystemPrompt() {
  return activeSystemPromptOf(loadState(), cfg);
}

/** 当前是否处于接管模式。state 优先（运行时切换），其次看 config.persona.enabled。 */
function takeoverActive() {
  return isTakeoverActive(loadState(), cfg);
}

/** 上一次人生模拟为什么没成 —— 同一个原因只说一次，别每 30 秒刷一行。 */
const lifeWatch = { lastError: '', clockWaiting: false, warned: false };

/** 发送失败是「窗口激活不了」时，同一条只报一次（见发送失败分支）。 */
const focusWatch = { key: '' };

/**
 * 「模型调不通 → 按配置不回」的报错节流（见发送循环里那条分支）。
 *
 * 为什么必须节流：模型服务没起来的时候，**每一条**消息都会走到那条分支。
 * 不节流的话日志会被同一句话刷满，而真正要看的信息（模型为什么调不通）反而被淹掉。
 */
let silentWatch = { key: '', at: 0 };

/** 记忆整理在后台跑时的单飞标记（见发送之后那段）。 */
const memoryRun = { running: false };

/**
 * 人生模拟这一块的**运行时状态**。
 *
 * 为什么不能只看 cfg：cfg 是启动时读的一次，控制台改了它不知道。
 * 而这几个值用户会想"点了立刻生效"（尤其那两个开关 —— 一个花钱，
 * 一个会主动跟真人说话）。所以每轮循环现读一次 state.json，
 * 和「AI 接管」开关走同一条路（它也是存在 state 里、每轮现读）。
 */
const lifeRuntime = { enabled: false, share: false, profile: '', loaded: false };

/** 每轮主循环开头刷一次。读一个本地小文件，代价可以忽略。 */
function refreshLifeRuntime() {
  let s = {};
  try { s = loadState(); } catch { s = {}; }
  lifeRuntime.enabled = lifeEnabled(cfg, s);
  lifeRuntime.share = shareEnabled(cfg, s);
  lifeRuntime.profile = activeProfile(cfg, s);
  lifeRuntime.loaded = true;
  return lifeRuntime;
}

/**
 * 人生模拟：没人跟它说话的时候，让它自己在心里过一会儿日子。
 *
 * 用户的需求原话：「每5次控制台检测后，如果此时API没有被调用，使用该API进行人生模拟，
 * 即通过给定的提示词以及设定推测真人行为，并记成日志保存」。
 * 后来又加了一条：「在人生模拟中加入一个额外判断：这个时候是否适合向群友分享，
 * 如果适合，主动进行一次输出」—— 见下面 shareLifeEntry()。
 *
 * 触发条件在 life.js 的 createLifeTicker 里（纯逻辑、可测），这里只负责：
 *   1. 把「设定」凑齐交给模型 —— 人设 + 记忆 + 最近的生活 + 上一次记录的时间 + 在哪个群
 *   2. 把结果过一遍清洗，追加进 life.json
 *   3. 记一行日志，让人能看见它"活"了
 *   4. 模型说"这会儿值得在群里说一句"时，交给 shareLifeEntry() 再拦一遍
 */
async function runLifeSimulation(state) {
  const now = Date.now();
  const conversation = getCurrentConversation();

  // 「设定」之一：人设（接管模式下那份）+ 两层的记忆。
  // 记忆用**当前会话**那一份：里面是"刚刚跟谁聊了什么"，正是此刻的上下文。
  const { store } = loadStore(cfg, ROOT, conversation);
  const memoryDigest = renderMemory(store, cfg);
  const persona = activeSystemPrompt();

  // 「设定」之二：最近在做什么。note:false —— 那次不需要"别念出来"这种交代。
  // 读的是**当前这份人生**（控制台上切了谁就过谁）。
  const rt = refreshLifeRuntime();
  const { log: lifeLog } = loadLifeLog(cfg, ROOT, rt.profile);
  const lifeDigest = renderLife(lifeLog, cfg, { note: false });

  // ---- 给这次模拟一个「现在」----
  // 不是真实时间，而是**角色的时钟**：在上一条的基础上往前推 stepMinutes。
  // 拿真实时间会怎样（实测）：两次模拟只隔几十秒，提示词里那句
  // 「上一次记录是 1 分钟前」等于告诉模型"什么都没变"——于是它的生活永远停在
  // 同一秒，30 多条全是「窝着刷手机/犯困」，既没有事可分享，日志也是重复的状态。
  const clock = nextLifeClock(cfg, lifeLog, now);

  const r = await generateLifeSimulation(cfg, {
    now: clock.lifeAt,
    persona,
    memoryDigest,
    lifeDigest,
    lastAt: clock.prevLifeAt ?? 0,
    conversation,
  });

  if (!r.ok) {
    // 同一个原因只说一次。本地服务没开的时候，这里会每 30 秒失败一次，
    // 不加这道闸日志会被刷屏（而且是有价值的日志被冲掉）。
    const why = `${r.reason}：${r.detail ?? ''}`;
    if (why !== lifeWatch.lastError) {
      lifeWatch.lastError = why;
      log.warn(`人生模拟失败（${why}）—— 跳过这次，不影响聊天`);
    }
    return { ok: false, reason: r.reason };
  }
  lifeWatch.lastError = '';

  // ⚠ 记录里存的 lifeAt 必须是**刚才喂给模型的那个时间**。
  //   不显式传的话，appendLifeEntry 会按"此刻"再算一次 —— 而本地模型一次要跑
  //   一两分钟，于是出现"跟它说现在是 20:23，日志里写成 20:25"的错位。
  const entryIn = (r.entry && typeof r.entry === 'object') ? { ...r.entry, lifeAt: clock.lifeAt } : r.entry;
  const saved = appendLifeEntry(cfg, ROOT, entryIn, now, rt.profile);
  if (!saved.ok) {
    log.warn(`人生模拟写了但没存上：${saved.error}`);
    return { ok: false, reason: 'write-failed' };
  }

  const e = saved.entry;
  const parts = [];
  if (e.mood) parts.push(`心情=${e.mood}`);
  if (e.doing) parts.push(`在做=${e.doing}`);
  if (e.thinking) parts.push(`想着=${e.thinking}`);
  log.info(`  人生模拟: ${parts.join('  ')}  （${r.ms}ms，生活日志第 ${saved.total} 条）`);

  // 分享判断：模型已经给了意见（e.share），这里决定要不要真发。
  // 失败绝不影响生活日志 —— 那条已经存好了。
  try {
    await shareLifeEntry(e, state);
  } catch (err) {
    log.warn(`主动分享异常（已忽略）：${err?.message ?? err}`);
  }

  return { ok: true, entry: e, ms: r.ms };
}

/**
 * 「要不要主动跟群友说一句」—— 模型提议之后的本地复核 + 真发。
 *
 * 这是**全项目唯一会主动跟真人说话**的地方：没有消息触发，它自己就开口了。
 * 所以每一步都保守：
 *
 *   1. 模型说 suitable，才往下走（prompt 里已经反复强调大部分时候该是 false）
 *   2. decideShare() 再过一遍本地闸门（开关/名单/静默时段/间隔/每日上限/概率）
 *   3. **发之前重读一次当前会话**：模拟是异步跑的，几十秒里自动切换可能已经
 *      把界面换到别的群了。发进哪个群必须现查，不能拿几十秒前的会话名当数
 *   4. 发送走 sendMessage（内部有串行锁，不会和主循环的回复撞进同一个输入框）
 *   5. 结果写回生活日志那条记录里 —— 事后要能查清"它那天为什么在群里冒一句"
 *
 * 发失败也照样记一次分享（看 recordShare 的注释）：宁可少说，也不要每 25 秒
 * 去试一次打字。
 */
async function shareLifeEntry(entry, state) {
  const now = Date.now();
  // 现读一次开关：控制台上刚关掉就该立刻停手（这是会跟真人说话的功能，
  // 不能等下一轮循环才知道）
  const rt = refreshLifeRuntime();

  // 先看模型怎么说，再决定值不值得去读界面（读一次 UIA 要一秒左右）
  if (!rt.share) return { ok: false, reason: '主动分享没开' };
  if (!entry.share || entry.share.suitable !== true) {
    const why = entry.share?.why ? `（${entry.share.why}）` : '';
    log.debug(`主动分享：模型判断这会儿不说${why}`);
    if (entry.share) log.info(`  分享判断: 不说${why}`);
    return { ok: false, reason: 'model-said-no' };
  }

  // 现查当前会话（见上面第 3 点）
  const cur = await readCurrentConversation({ cfg });
  const conversation = cur.ok ? cur.name : '';

  const d = decideShare(cfg, { entry, conversation, now, state, enabled: rt.share });
  if (!d.ok) {
    log.info(`  分享判断: 想说但没发 —— ${d.reason}`);
    await updateLifeEntry(cfg, ROOT, entry.at, {
      shared: { at: now, ok: false, sent: false, reason: d.reason, text: entry.share?.text ?? '', conversation },
    }, rt.profile);
    return { ok: false, reason: d.reason };
  }

  log.info(`  主动分享 →「${d.conversation}」: "${d.text}"`);

  // 先记账再发：这条路径最坏的情况是"发了但没记上"（下次少说一句），
  // 反过来"没发却以为发了"会导致它反复去打字。
  recordShare(state, now, d.text);
  saveState(state);

  const sendRes = await sendMessage(cfg, d.text);

  const record = {
    at: now,
    ok: sendRes.ok === true,
    sent: sendRes.sent === true,
    reason: sendRes.ok ? '' : String(sendRes.error ?? sendRes.reason ?? '发送失败'),
    text: d.text,
    conversation: d.conversation,
  };
  await updateLifeEntry(cfg, ROOT, entry.at, { shared: record }, rt.profile);

  if (!sendRes.ok) {
    log.warn(`  主动分享发送失败：${record.reason}`);
    return { ok: false, reason: record.reason };
  }

  // 自己和别人都要能看见这句话 —— 补进持久历史，否则下一轮回复里
  // 它根本不知道自己刚在群里说过什么（滚出渲染范围就没了）。
  if (sendRes.dryRun || sendRes.sent) {
    pushSelfHistory(state, d.text, d.conversation);
    markSent(state, d.text);
    markReplied(state, now);
    saveState(state);
    log.info(`  主动分享已发出 ✓（${d.conversation}）`);
  } else {
    log.info('  [dryRun] 主动分享未实际发送。');
  }

  return { ok: true, text: d.text, conversation: d.conversation };
}

/**
 * 回复发出去之后，让模型提出一份记忆差异并合并回记忆文件。
 *
 * 记忆分两层（见 src/memory.js）：
 *   memory.json         总记忆 —— 不分局的（我是谁、喜欢什么）
 *   memory/<会话>.json   会话记忆 —— 只在这个会话里成立的
 *
 * 位置很关键：**必须在发送之后**。放在生成回复之前的话，每次回复都要多等
 * 一次 API 往返（实测 1~3 秒），群里看到的就是"它怎么半天不回"。
 * 发完再整理，用户完全感知不到。
 *
 * 失败一律吞掉，只记日志：整理记忆挂了不该影响聊天，更不该让主循环崩。
 *
 * @param {string} conversation 当前会话名 —— 决定读写哪一份会话记忆
 * @returns {Promise<{updated:boolean, changes:string[], reason:string}>}
 */
async function updateMemoryAfterReply(state, { reply, trigger, conversation }) {
  const skip = (reason) => ({ updated: false, changes: [], reason });
  try {
    // 先把「回了多少条」加 1，再问要不要整理。
    // 顺序不能反：shouldUpdateMemory 的 updateEvery 是按**回复条数**算的，
    // 只在整理成功时才加计数的话，前 N-1 次被挡下就永远等不到第 N 次（踩过）。
    state.memoryReplyCount = (Number(state.memoryReplyCount) || 0) + 1;

    const decision = shouldUpdateMemory(cfg, state, Date.now());
    if (!decision.ok) return skip(decision.reason);

    // dryRun 时不写记忆：那时候回复根本没发出去，
    // 按"说过的话"去改记忆会把测试内容记成真实经历。
    if (cfg.reply?.dryRun) return skip('dryRun 模式，不写记忆');

    // 两层一起读：总记忆 + **这个会话**的记忆。
    // 会话名从当前这轮扫描来 —— 记忆是按会话分的，拿错会话名就会把别人的事读进来。
    const { store: before } = loadStore(cfg, ROOT, conversation);

    // 给整理器看的对话：最近几条历史 + 刚发出的那句话。
    // 不要把所有历史都塞进去 —— 整理器只关心"刚刚发生了什么"，
    // 给多了既费 token 又容易让它去重写很久以前的事。
    //
    // ⚠ 必须**只取这个会话的**历史（historyWindow）：开了轮询之后历史里
    //   混着好几个会话的消息，把私聊的内容整理进群聊的记忆文件里，
    //   既是串味，也等于把别人的私聊写进了另一个会话的关系里。
    const hist = historyWindow(state, conversation, cfg.memory?.contextMessages ?? 8);
    // 格式跟给回复模型的一致：`时间|称号|昵称|内容`（见 llm.js 的 HISTORY_FORMAT_NOTE）。
    // 两边不一致的话，整理器会把"名字里带冒号/竖线"这类事记歪。
    // 自己那几行没有前缀（`你|内容`）—— 自己的话本来就不需要时间/称号。
    const lines = hist.map((h) => (h.side === 'self' ? `你|${h.text}` : renderIncomingLine(h)));
    if (reply) lines.push(`你|${reply}`);
    if (trigger?.text) lines.unshift(`（触发这次回复的是：${renderIncomingLine(trigger)}）`);

    const r = await generateMemoryPatch(cfg, {
      conversation,
      globalJson: JSON.stringify(before.global),
      conversationJson: JSON.stringify(before.conversation),
      transcript: lines.join('\n'),
    });
    if (!r.ok) {
      log.warn(`记忆整理失败（${r.reason}）：${r.detail ?? ''}`);
      return skip(r.reason);
    }

    const { store: next, changes } = applyMemoryPatch(before, r.patch, cfg);
    if (changes.length === 0) {
      // 没变化是**正常**的（闲聊本来就不该进记忆），所以不写盘、也不刷日志。
      // 注意：计数已经在函数开头加过了，这里不要再加。
      return skip('无变化');
    }

    const saved = saveStore(cfg, next, ROOT, conversation);
    if (!saved.ok) {
      log.warn(`记忆写盘失败：${saved.error}（内容没丢，下次更新会重试）`);
      return skip('写入失败');
    }

    state.memoryUpdatedAt = Date.now();
    log.info(`  记忆已更新: ${summarizeChanges(changes)}  （${r.ms}ms）`);
    return { updated: true, changes, reason: 'ok' };
  } catch (e) {
    // 兜底：整理记忆这条路上任何意外都不许冒泡到主循环
    log.warn(`记忆整理异常（已忽略）：${e?.message ?? e}`);
    return skip('exception');
  }
}

/**
 * 生成一条回复。
 *
 * 两条路线：
 *   · 接管模式   → 调大模型（persona 提示词），失败才降级本地规则
 *   · 非接管模式 → **直接**走本地规则，不调 API（默认行为）
 *
 * 为什么默认「非接管 = 不调 API」：接管开关的语义就该是「小深上线 / 小深不在」。
 * 不在的时候还偷偷调 API，一来白花钱，二来控制台里那份人设提示词本来也
 * 只在接管模式下生效（见 takeover.js 的 activeSystemPrompt），
 * 于是非接管时的回复既不像小深、又要花钱 —— 两头不占。
 *
 * 想改回「两种模式都调 API」：把 config.json 的 llm.callApiInTakeoverOnly 设成 false。
 */
async function composeReply(decision, history, state, conversation) {
  const m = decision.message;
  const takeover = takeoverActive();

  // ---- 读记忆（两层：总记忆 + 这个会话的）----
  // 每次生成回复前都重新读一遍文件，而不是启动时读一次缓存在内存里。
  // 理由：记忆是**边聊边改**的，而且用户可能手工编辑这些文件；
  // 缓存住的话，改了文件不重启就看不到效果，很容易被当成"记忆没生效"。
  // 一次本地文件读的代价可以忽略（几十微秒），换来的确定性划算。
  //
  // ⚠ 会话名必须传对。以前只有一份记忆，读哪份都一样；
  //   现在按会话分文件，拿错会话名就会把**别的会话**的人和事读进提示词 ——
  //   正是这次要修的问题（私聊里张口就是群里那个谁）。
  const { store: mem, sources } = loadStore(cfg, ROOT, conversation);
  for (const [layer, s] of Object.entries(sources)) {
    if (!s.ok && s.reason !== 'missing') {
      log.warn(`记忆（${layer}）读取失败（${s.reason}），本轮按"没有记忆"处理：${s.path}`);
    }
  }
  const memoryDigest = renderMemory(mem, cfg);
  // 生活日志（人生模拟的产物）跟着记忆一起进提示词 —— 这样它上一轮说过的
  // 「我在吃饭」和这一轮之间有时间线，不会半小时后还在吃同一顿饭。
  // 没开人生模拟、或者还没有记录时返回 ''，等于不注入。
  // 现读一次 state：控制台上刚切了人生 / 刚关了开关，这里就该跟着变。
  const lifeDigest = lifeDigestFor(cfg, ROOT, loadState());

  const ctx = {
    text: m.text,
    // 跟 recordHistory 同一个取舍：昵称优先，头衔兜底。
    // 这行会渲染成提示词里的「正在跟你说话的人是「X」」，用干净昵称更准。
    sender: m.sender || m.senderWithTitle,
    // 时间和称号：提示词里这一条渲染成 `时间|称号|昵称|内容`，
    // 缺了它们就只剩 `-|-|昵称|内容`（见 llm.js 的 renderIncomingLine）。
    time: m.time || '',
    title: m.title || '',
    mentioned: Boolean(decision.mentioned),
    history,
    recentReplies: state?.sentReplies ?? [],
    counter: state?.counters?.replies ?? 0,
    systemPrompt: activeSystemPrompt(),
    memoryDigest,
    lifeDigest,
    // 接管模式把 persona 配置传下去，让本地兜底也用可爱语气
    persona: takeover ? cfg.persona : null,
  };

  // ---- 这次要不要调大模型？----
  // 默认只在接管模式下调；非接管 = 纯本地规则模式（不花钱、也不会有人设）。
  // 判断逻辑抽在 takeover.js 里，这样能单独测（bot.js 一 import 就跑主循环）。
  const apiCall = shouldCallApi(loadState(), cfg);

  const llmRes = apiCall.call
    ? await generateReply(cfg, ctx)
    : { ok: false, reason: apiCall.reason };
  let reply = '';

  let source = '';
  let apiNote = '';

  if (llmRes.ok) {
    reply = llmRes.reply;
    source = takeover ? 'llm:persona' : 'llm';
    apiNote = `${llmRes.ms}ms model=${llmRes.model ?? cfg.llm.model}`;
  } else if (!fallbackAllowedAfterApiFailure(cfg, { apiAttempted: apiCall.call === true })) {
    // 用户选了「模型调不通就别发罐头话」：这条**不回**。
    //
    // 为什么是"不回"而不是"留在队列里等模型回来"：留在队列里会让下一轮
    // （4 秒后）再发一次请求 —— 模型正挂着的时候那等于每 4 秒敲一次门，
    // 而消息本身有 10 分钟 TTL，最后还是会被丢掉。不如当场说清、安静跳过。
    // 消息已经在 markSeen 里，所以不会下一轮又冒出来重复处理。
    source = 'silent';
    apiNote = `API 不可用(${llmRes.reason}) → 按配置不发兜底话（reply.fallbackWhenApiDown=false）`;
  } else {
    const fb = fallbackReply(cfg, { ...ctx, reason: llmRes.reason });
    reply = fb.reply;
    source = `fallback:${fb.source}${fb.personaMode ? ':persona' : ''}`;
    // 'not-takeover' 是**主动**不调 API，不是故障 —— 日志里必须跟真故障分开写，
    // 否则每次本地回复都顶着「API 不可用」，看着像坏了，实际是设计如此。
    apiNote = llmRes.reason === 'not-takeover'
      ? '非接管模式 → 本地规则（未调用 API）'
      : `API 不可用(${llmRes.reason}) → 本地规则`;
    if (fb.rule) apiNote += ` 命中 /${fb.rule}/`;
    if (fb.variant) apiNote += ` 变体#${fb.variant}`;
  }

  const finalText = clampReply(reply, cfg.reply?.maxChars, cfg.reply?.prefix ?? '');
  // calledApi 要往上传：记忆整理要不要跑，取决于这一轮**到底有没有调 API**。
  // 不传的话，本地规则模式下每条回复都会白跑一次整理请求 ——
  // 那就等于在"不花钱"的模式里偷偷花钱（这正是需求原话
  //「每次调用API时…修改一份json文件」要排除的情况）。
  return { reply: finalText, source, apiNote, rawReply: reply, calledApi: apiCall.call };
}

/**
 * 把本轮读到的消息记进持久历史，并返回生效的历史窗口。
 *
 * 为什么需要「持久历史」而不是直接用本轮读到的消息：
 *   UIA 只能读到当前渲染的那一批（实测一轮 12~14 条，视口上方的也算）。
 *   一旦消息滚出渲染范围就再也看不到 —— **包括机器人自己发的话**。
 *   结果就是模型完全不知道上一句自己说了什么，前后接不上。
 *   实测过：某一轮里 self 消息数是 0，自己的回复一条都不在上下文里。
 *
 * 持久历史存在 state.json，跨轮累积，所以「上次说了什么」它自己看得到。
 *
 * ⚠ 历史是**按会话分开**的（条目上的 `conv` 字段）。
 *   以前只有一条全局历史，因为那时候只监测**当前打开的那一个**聊天。
 *   开了「轮询全部会话」之后就不行了：私聊里说的话会被当成"刚才聊过的内容"
 *   塞进群聊那一轮的提示词里 —— 既是串味，也是把别人的私聊内容递给群里的模型。
 *   所以：写入时打上会话名，取窗口时只取这个会话的。
 *   （老条目没有 conv，按空串算 —— 匹配不上任何会话名，自然就不会串味。）
 *
 * @returns {Array} 历史窗口（时间顺序，早 → 晚），**只含这个会话**
 */
function recordHistory(state, parsed) {
  const conv = String(parsed.conversation ?? '');
  state.history = Array.isArray(state.history) ? state.history : [];
  state.histSeen = Array.isArray(state.histSeen) ? state.histSeen : [];
  const seen = new Set(state.histSeen);
  const cap = Math.max(20, Number(cfg.llm?.historyBuffer ?? 60) || 60);

  for (const m of parsed.messages) {
    const text = String(m.text ?? '').trim();
    if (!text) continue;
    const fp = `${conv}|${m.side}|${text}`;
    if (seen.has(fp)) continue;          // 已经在历史里了，不重复记
    seen.add(fp);
    state.history.push({
      conv,
      side: m.side === 'self' ? 'self' : 'incoming',
      // 优先用**昵称**（sender），头衔只作兜底。
      //
      // 原来的顺序是 senderWithTitle 优先，本意是"头衔+昵称"便于匹配自己发的内容。
      // 但解析器修好之后 sender 已经是干净的单个人名，而 senderWithTitle 是
      // "头衔+昵称"粘起来的（实测 "示例群友搞完"）。历史里存那个的话：
      //   · 模型看到的人名变长、难认，还多花 token
      //   · 记忆模块按名字建关系，头衔一变就会多出一个"新人"
      sender: m.side === 'self' ? '' : (m.sender || m.senderWithTitle || ''),
      // 称号和时间也一起存：提示词里是 `时间|称号|昵称|内容` 四段（见 llm.js），
      // 只存昵称的话历史那几行会全变成 `-|-|`，模型就分不清谁在什么时候说的。
      title: m.side === 'self' ? '' : (m.title || ''),
      time: m.side === 'self' ? '' : (m.time || ''),
      text,
      at: Date.now(),
    });
  }

  // 裁剪：历史太长既费 token 又会让很久以前的话题干扰当前对话
  if (state.history.length > cap) {
    state.history = state.history.slice(-cap);
  }
  // 重建 histSeen，只保留还在历史里的指纹，避免这个数组无限增长
  state.histSeen = state.history.map((h) => `${h.conv ?? ''}|${h.side}|${h.text}`);

  return historyWindow(state, conv, cfg.llm?.contextMessages ?? 16);
}

/** 这条历史属于哪个会话（老条目没有这个字段，按空串算）。 */
const histConv = (h) => String(h?.conv ?? '');

/**
 * 取某个会话的历史窗口（时间顺序，早 → 晚）。
 *
 * 用 sessionMatches 而不是全等：群名会带成员数（「示例群（10）」）、
 * 多人会话名会随成员变化，全等比会莫名其妙地"读不到历史"。
 */
function historyWindow(state, conversation, n) {
  const conv = String(conversation ?? '');
  const all = Array.isArray(state.history) ? state.history : [];
  if (!conv) return [];
  const mine = all.filter((h) => (
    sessionMatches(histConv(h), conv) || sessionMatches(conv, histConv(h))
  ));
  return mine.slice(-(Number(n) > 0 ? Number(n) : 16));
}

/**
 * 追加一条自己说过的话（回复或主动分享）。
 *
 * 单独抽出来是因为**有三处**在写历史（本轮读到、刚发出的回复、主动分享），
 * 以前每处都各写一遍 push + 裁剪 + 重建 histSeen —— 加 conv 的时候漏掉任何一处，
 * 就等于那个会话的历史"缺一半"。集中一处改，漏不掉。
 */
function pushSelfHistory(state, text, conversation) {
  const t = String(text ?? '').trim();
  if (!t) return;
  const conv = String(conversation ?? '');
  state.history = Array.isArray(state.history) ? state.history : [];
  state.history.push({ conv, side: 'self', sender: '', title: '', time: '', text: t, at: Date.now() });
  const cap = Math.max(20, Number(cfg.llm?.historyBuffer ?? 60) || 60);
  if (state.history.length > cap) state.history = state.history.slice(-cap);
  state.histSeen = state.history.map((h) => `${h.conv ?? ''}|${h.side}|${h.text}`);
}

/**
 * 「看起来是在跟机器人说话，但没被当成 @」的诊断。
 *
 * 用户报过：「被@的消息有时候不会回，连队列都没进」，而且在群里补了一句
 * 「单独@不会回消息」。这种症状有**两种完全不同的成因**，光看结果分不出来：
 *
 *   A. 闸门判错 —— 正文里确实有「@示例昵称」，但 isMentioned 说 false
 *      （botNames / mentionPatterns 配错，或者全角/@ 被换成别的字符）
 *   B. 解析把 @ 丢了 —— QQ 的 @ 是个特殊渲染的元素，万一它没被收进正文，
 *      文本里只剩「示例昵称」，于是「根本没被@"，只能靠 25% 概率碰运气
 *
 * 所以这里在**丢掉一条消息**时，把文本原文和"@ 还在不在"直接打出来。
 * 一行的区别就能定位到完全不同的两个模块，省掉一轮来回猜。
 *
 * 只在文本里真的出现了机器人名字时才喊，不会刷屏。
 */
function warnIfMissedMention(d, cfg) {
  // 判断抽在 parse.js 里（纯函数，能单测）—— 这段曾经因为把自己的名字标签
  // 当成消息而每轮刷两行误报，只有测试守得住。
  if (!looksLikeMissedMention(d?.message, cfg)) return;

  const text = String(d.message.text ?? '');
  const names = (cfg.trigger?.botNames ?? []).filter((n) => n && text.includes(n));
  const hasAt = text.includes('@') || text.includes('＠');
  log.warn(`疑似漏判@：正文里有「${names.join('/')}」但没被当成@  丢弃原因=${d.reason}`);
  log.warn(`  正文原文: ${JSON.stringify(text)}`);
  log.warn(`  原文里还有 @ 吗: ${hasAt ? '有 → 那是 botNames/mentionPatterns 匹配的问题' : '没有 → 多半是解析把 @ 元素丢了'}`);
}

async function scanOnce(state, { verbose = false } = {}) {
  const { parsed, used, fellBack, uiaError } = await readConversation(cfg, { debug: verbose });

  // 记下"读到的"会话名 —— 这才是真相。自动切换记的是"点完的预期"，
  // 用户手动换会话时只有这里能纠正过来（否则会以为已经在目标上，就不切了）。
  if (parsed.conversation) setCurrentConversation(parsed.conversation);

  // ---- 一次性迁移：旧的单文件记忆拆成两层 ----
  // 放在这里而不是启动时，是因为迁移要知道"当前是哪个会话" ——
  // 那得等第一次扫描读到会话名。已有会话记忆时它什么都不会做。
  if (!legacyMigrated) {
    legacyMigrated = true;
    const mg = migrateLegacy(cfg, ROOT, parsed.conversation);
    if (mg.migrated) {
      log.info(`记忆已从旧版单文件拆成两层：总记忆（memory.json）+ 「${parsed.conversation}」的会话记忆`);
      log.info(`  旧文件已备份：${mg.backup}`);
      log.info(`  会话记忆文件：${mg.conversationFile}`);
    } else if (!['no-legacy', 'already-split', 'memory-dir-exists', 'no-conversation'].includes(mg.reason)) {
      log.warn(`记忆迁移没做成（${mg.reason}），旧文件保持原样，不影响运行`);
    }
  }

  if (verbose) {
    const size = parsed.source === 'uia'
      ? `聊天列 x ${Math.round(parsed.column.xMin)}~${Math.round(parsed.column.xMax)}`
      : `图像 ${parsed.size.w}x${parsed.size.h}`;
    log.debug(`来源=${used}${fellBack ? '（UIA 降级）' : ''}  ${size}  → ${parsed.messages.length} 条消息`);
    for (const m of parsed.messages) {
      log.debug(`  [${m.sender || '(无发送者)'}] y=${Math.round(m.y)} "${m.text}"`);
    }
  }

  const result = decide(cfg, state, parsed);

  // ---- 被@自检 ----
  // 「群内只在@时回复」模式下，isMentioned 是第一道闸门：认不出名字 = 一条都不回，
  // 而且全程静默（不报错、不抛异常）。所以这里累计着看，攒够样本还一条都没认出
  // 就大声警告一次 —— 把「机器人怎么没反应」这种玄学问题变成一行明确的修复指引。
  if (cfg.trigger?.replyInGroupOnlyWhenMentioned !== false) {
    const mc = mentionSelfCheck(parsed.messages, cfg);
    mentionWatch.sawAt += mc.sawAt;
    mentionWatch.hit += mc.hit;
    if (!mentionWatch.warned && mentionWatch.sawAt >= 8 && mentionWatch.hit === 0) {
      mentionWatch.warned = true;
      log.warn(`被@自检失败：读到 ${mentionWatch.sawAt} 条带 @ 的消息，没有一条认出是在@你。`);
      log.warn(`  → 群里 @ 你时显示的那个名字，必须写进 config.json 的 trigger.botNames`);
      log.warn(`     当前 botNames = ${JSON.stringify(cfg.trigger?.botNames ?? [])}`);
      log.warn('  → 在这个模式下「认不出来」= 机器人一条都不会回，而且不会报错。改完重启生效。');
      for (const s of mc.samples) log.warn(`     看到的@消息: ${JSON.stringify(s)}`);
    }
  }

  // 先把本轮读到的消息记进持久历史（含自己发的话），
  // 再走下面的指令检测和发送 —— 这样刚发出去的回复，下一轮就出现在上下文里。
  const history = recordHistory(state, parsed);

  // ---- 0) 接管/下班指令 ----
  // 指令消息不当普通消息回，而是切换模式并回一句应答。
  // 必须放在入队之前，否则「你接管」这句话本身也会被排进待回复队列。
  //
  // ⚠ 这里踩过一个把机器人整个搞死的坑：
  //   老指令会一直留在聊天窗里，每一轮扫描都被重新检测到。而当时的代码在
  //   「已经处于该状态」时**也**提前 return 了 —— 于是每一轮扫描都在这里掉头，
  //   后面「把消息放进待回复队列」那段永远走不到，机器人再也不回任何消息。
  //   症状：日志里刷满「接管指令 → 已经是开启状态，忽略」，
  //         两条之间**一条扫描汇总都没有**（因为汇总在 return 之后）。
  //
  //   所以现在只有**真的切换了状态**才提前 return；没切换就继续往下走。
  const takeoverCmd = detectTakeoverCommand(parsed, cfg);
  const cmdPlan = planTakeoverCommand(
    { ...state, conversation: parsed.conversation },
    { cmd: takeoverCmd.cmd, message: takeoverCmd.message },
    cfg,
  );

  if (cmdPlan.action !== 'none') {
    // 指令消息永远登记掉，否则它会被当成普通消息回（自问自答）
    if (cmdPlan.fingerprint) markSeen(state, cmdPlan.fingerprint);
  }

  if (cmdPlan.action === 'apply') {
    state.takeoverEnabled = cmdPlan.willBe;
    log.info(`接管指令: "${takeoverCmd.message.text}" → ${cmdPlan.willBe ? '开启' : '关闭'}接管模式`);
    const ack = commandAck(takeoverCmd.cmd, cfg);
    if (ack) {
      const sendRes = await sendMessage(cfg, ack);
      markSent(state, ack);
      markReplied(state, Date.now());
      log.info(`  → "${ack}"  ${sendRes.sent ? '已发送 ✓' : `发送失败: ${sendRes.error}`}`);
    }
    saveState(state);
    // 真正切换的这一轮不处理其他消息，避免同一轮里既切模式又回一堆消息
    return { parsed, result, replied: 0, queued: 0, takeover: takeoverCmd.cmd };
  }

  if (cmdPlan.action === 'ignore') {
    // 老指令被重复检测到是正常的（它就摆在聊天窗里），这里只记 debug——
    // 用 info 的话每 4 秒刷一行，日志会被淹掉（踩过）。
    // 关键：**不 return**，继续处理别的消息。
    log.debug(`接管指令: "${takeoverCmd.message.text}" → ${cmdPlan.reason}，忽略`);
  }

  // ---- 1) 决策：把通过闸门的消息放进待回复队列 ----
  let queued = 0;
  for (const d of result.decisions) {
    // 指令消息本身不参与回复（上面刚把它登记掉了，但 decide 是在此之前跑的，
    // 所以这一步的排除不能省）
    if (cmdPlan.fingerprint && d.fingerprint === cmdPlan.fingerprint) {
      markSeen(state, d.fingerprint);
      continue;
    }
    if (d.reply) {
      if (enqueuePending(state, d)) queued++;
      // 已在本轮或前轮登记过，不重复入队
      markSeen(state, d.fingerprint);
    } else {
      // 白名单未命中 / 自己发的 / 已处理 / 群里没被 @ → 直接登记
      warnIfMissedMention(d, cfg);
      markSeen(state, d.fingerprint);
    }
  }

  const now = Date.now();
  // 顺手清掉队列里过期的那几条（peekPending 的副作用就是按 TTL 过滤）。
  // 具体"这一轮该发哪条"由下面按会话挑，见 findPendingFor。
  peekPending(state, now);

  // 概率闸门挡掉了多少条 —— 不显示的话运行时看不出闸门在工作
  const skippedByProbability = result.decisions.filter(
    (d) => !d.reply && typeof d.reason === 'string' && d.reason.startsWith('概率未命中'),
  );
  const probNote = skippedByProbability.length
    ? ` | 概率挡下 ${skippedByProbability.length} 条`
    : '';

  // 会话范围那一段跟着**实际模式**说，不要一律写「白名单命中」——
  // all 模式下根本没有白名单这回事，照写会让人以为白名单还在起作用。
  const scopeText = result.scope === 'all'
    ? '范围=所有会话'
    : (result.whitelisted
      ? '范围=白名单(命中)'
      : `范围=白名单(${result.scopeWhy === 'whitelist-empty' ? '名单为空' : '未命中'})`);

  log.info(`会话「${result.conversationName || '(未识别到)'}」${result.isGroup ? '群聊' : '私聊'} | ` +
           `${scopeText} | 消息 ${parsed.messages.length} 条 | ` +
           `本轮新入队 ${queued} 条 | 队列剩余 ${(state.pending ?? []).length} 条${probNote}`);

  if (verbose) {
    for (const d of result.decisions) {
      log.debug(`  ${d.reply ? '→ 入队' : '  -'} "${d.message.text}" (${d.reason})`);
    }
  }

  // ---- 2) 发送：排空队列（限速关闭时一轮全发完）----
  // 保持先后顺序：按 queuedAt 先进先出，早的消息先回，对话读起来才自然。
  let replied = 0;
  const maxPerScan = cfg.reply?.maxRepliesPerScan ?? 20;

  while (true) {
    // ⚠ 只取**属于当前这一屏会话**的那一条（不是队头）。
    //   开了轮询之后队列里会同时压着好几个会话的消息，而发送是往当前显示的
    //   聊天里发的 —— 拿队头会把这句回错人。见 gate.js 的 findPendingFor。
    const slot = findPendingFor(state, result.conversationName, Date.now());
    if (!slot) {
      const others = pendingConversations(state);
      if (others.length > 0) {
        // 说清楚"为什么这一轮没发"：不是没消息，是那些消息属于别的会话。
        log.debug(`队列里还有 ${others.length} 个会话的消息（${others.join('、')}），`
          + `当前在「${result.conversationName || '未识别'}」，等轮询转回去再发`);
      }
      break;
    }
    const head = slot.item;
    if (replied >= maxPerScan) {
      log.warn(`本轮已达发送上限 ${maxPerScan} 条，剩余 ${(state.pending ?? []).length} 条留到下一轮`);
      break;
    }

    const rl = rateLimitCheck(cfg, state, Date.now());
    if (!rl.ok) {
      log.warn(`限速中，暂不发（${rl.reason}${rl.waitMs ? ` 还需等 ${Math.round(rl.waitMs / 1000)}s` : ''}）` +
               `，队列还剩 ${(state.pending ?? []).length} 条`);
      break;
    }

    // 队列头部就是这次要回的（可能是前几轮积压的）
    // 会话名用本轮扫描的 —— 记忆按会话分文件，这个参数决定读/写哪一份
    //
    // ⚠ 已经生成过的那句话要**复用**，不能重新生成。
    //   实测踩到：发送失败（例如 QQ 窗口没法激活，见下面的 stage=focus）时这条会留在
    //   队列里重试，而重试会把 composeReply 整个再跑一遍 —— 于是每失败一次就多花
    //   一次 API 调用（本机一条 67~120 秒），日志里同一句话刷了 7 遍、句子还都不一样：
    //       回复（被@）"…在干嘛"（队列中等待了 354s）→ "刚要睡着…" 发送失败
    //       回复（被@）"…在干嘛"（队列中等待了 390s）→ "嗯嗯嗯"     发送失败
    //   而且重试越多次，句子越偏离原本要回的那句。
    //   所以：生成结果存进队列项（state.json 里持久化），重试直接用它。
    const composed = head.composed
      ? { reply: head.composed, source: head.composedSource ?? 'cached', apiNote: '（沿用上次生成的那句，没有重新调用 API）', calledApi: false }
      : await composeReply(
        { message: { text: head.text, sender: head.sender }, mentioned: head.mentioned },
        history,
        state,
        result.conversationName,
      );

    if (!composed.reply) {
      // 「模型调不通就不发」跟「真的一句都生成不出来」是两件事，日志要分开写。
      // 前者是用户自己选的策略，会**每次都发生**（模型挂着的时候），所以只报一次，
      // 否则日志会被同一条刷满、真正的问题反而看不见（踩过：焦点失败的重复刷屏）。
      if (composed.source === 'silent') {
        const key = String(composed.apiNote ?? '');
        if (silentWatch.key !== key || Date.now() - silentWatch.at > 5 * 60 * 1000) {
          silentWatch = { key, at: Date.now() };
          log.warn(`这条不回："${head.text}" —— ${composed.apiNote}`);
          log.warn('  （不想看到这种情况：把接管模式的模型服务起起来，或者把'
            + '「模型调不通时不发兜底话」关掉。日志里 5 分钟内不再重复报这一条。）');
        } else {
          log.debug(`  又一次按配置静默跳过："${head.text}"`);
        }
      } else {
        log.warn(`没有可用的回复内容，出队跳过："${head.text}"`);
      }
      shiftPendingAt(state, slot.index);
      continue;
    }

    // 把这次生成的结果记回队列项：发送失败要重试时直接复用，不再花一次 API。
    head.composed = composed.reply;
    head.composedSource = composed.source;

    const tag = head.mentioned ? '（被@）' : '';
    const age = Math.round((Date.now() - (head.queuedAt ?? Date.now())) / 1000);
    log.info(`回复${tag} ${head.sender ? `[${head.sender}] ` : ''}"${head.text}"` +
             `${age > 2 ? `  （队列中等待了 ${age}s）` : ''}`);
    log.info(`  → "${composed.reply}"   来源=${composed.source}  ${composed.apiNote}`);

    const sendRes = await sendMessage(cfg, composed.reply);
    shiftPendingAt(state, slot.index);   // 出队（按会话挑出来的那一条，不是队头）
    markSent(state, composed.reply);
    markReplied(state, Date.now());

    // 立刻把自己刚说的话补进持久历史。
    // 不能等下一轮读回来：消息可能已经滚出渲染范围，那就永远记不住了，
    // 表现就是模型不知道上一句自己说了什么、前后接不上。
    if (sendRes.dryRun || sendRes.sent) {
      pushSelfHistory(state, composed.reply, result.conversationName);
    }

    // 记忆整理：放在发送**之后**，不占回复的等待时间（详见 updateMemoryAfterReply）。
    //
    // 只在**这一轮真的调用了 API** 时才整理。需求原话是「每次调用API时…修改这份 json」，
    // 而本地规则模式（非接管）本来就是为了不花钱 —— 那种模式下还去调一次整理，
    // 等于在免费模式里偷偷计费。而且本地回复是模板拼的，本身也没什么值得记的。
    //
    // ⚠ 改成**后台跑**（原来是 await）：本机实测一次整理要 64~100 秒，
    //   而这段时间整个回复循环都停在这儿 —— 后面来的 @ 消息只能干等。
    //   记忆是"锦上添花"，不该挡住回话。
    //   单飞保护：上一次还在跑就跳过这次，免得两边同时读-改-写同一份记忆文件。
    if ((composed.calledApi || cfg.memory?.onlyWhenApiCalled === false) && !memoryRun.running) {
      memoryRun.running = true;
      Promise.resolve()
        .then(() => updateMemoryAfterReply(state, {
          reply: composed.reply,
          trigger: { text: head.text, sender: head.sender },
          conversation: result.conversationName,
        }))
        .catch((e) => log.warn(`记忆整理异常（已忽略）：${e?.message ?? e}`))
        .finally(() => {
          try { memoryRun.running = false; } catch { /* 忽略 */ }
        });
    } else if (memoryRun.running) {
      log.debug('记忆整理还在跑，这次跳过（不影响回复）');
    }

    if (sendRes.dryRun) {
      log.info('  [dryRun] 未实际发送。加 --send 或把 config.reply.dryRun 设为 false 才会发出去。');
    } else if (sendRes.sent) {
      if (cfg.reply?.verifyByOcr) {
        const v = await verifySentByOcr(cfg, composed.reply, {
          attempts: cfg.reply?.verifyAttempts ?? 3,
          delayMs: cfg.reply?.verifyDelayMs ?? 1200,
        });
        if (v.found) {
          log.info(`  已发送 ✓ OCR 复核通过（第 ${v.attempts} 次尝试）`);
        } else {
          log.warn(`  ⚠ 已提交但 OCR 复核 ${v.attempts} 次都没读到，请看一眼 QQ 窗口确认。`);
        }
      } else {
        log.info(`  已发送 ✓ 输入 ${sendRes.typedChars ?? '?'} 字，发送后输入框已清空=${sendRes.inputClearedAfter}`);
      }
    } else {
      // 发送失败时留在队列里，下一轮重试。
      //
      // ⚠ stage=focus = QQ 窗口激活不了。这不是故障：**你正在用别的窗口时，
      //   Windows 会拒绝一个后台进程抢焦点**（实测就是这样）。它会一直重试到
      //   你能腾出窗口为止 —— 但同一条只报一次，否则每 5 秒刷一遍同样的错。
      const isFocus = String(sendRes.stage ?? '') === 'focus';
      if (isFocus && focusWatch.key === head.fingerprint) {
        log.debug(`  还是激活不了 QQ 窗口，这条继续留着`);
      } else {
        log.error(`  发送失败：${sendRes.error ?? sendRes.reason}`);
        if (isFocus) {
          focusWatch.key = head.fingerprint;
          log.warn('  ↑ QQ 窗口现在激活不了（你在用别的窗口时系统会拒绝抢焦点）。'
            + '这条留在队列里等下次；**生成好的那句话已经缓存，重试不会再调用 API**。');
        }
      }
      state.pending.unshift(head);
      break;   // 避免失败后疯狂重试
    }
    replied++;
  }

  state.scannedAt = new Date().toISOString();
  state.counters = state.counters ?? {};
  state.counters.scans = (state.counters.scans ?? 0) + 1;
  state.counters.replies = (state.counters.replies ?? 0) + replied;

  // 去重记录只保留「当前还在窗口里」的（详见 pruneSeenToWindow 的注释）。
  // 必须在决策循环**之后**做：循环里刚登记的那些消息本来就在窗口里，
  // 不会被误清；而滚出窗口的老记录会被丢掉，让「新发的同一句话」能正常回。
  const pruned = pruneSeenToWindow(state, parsed);
  if (pruned.dropped > 0) {
    log.debug(`去重记录收敛：${pruned.before} → ${pruned.after}（丢掉 ${pruned.dropped} 条已滚出窗口的）`);
  }

  saveState(state);

  return { parsed, result, replied, queued };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  initLogger(cfg);

  // ---- 第一道防线：没有控制台就不许启动 ----
  //
  // 这是硬规则（用户要求）：机器人往真群发消息，没有控制台意味着
  // 用户看不到它在说什么、也没法一键停。所以这里**拒绝启动**，
  // 而不是"警告一下继续跑"。
  //
  // 放在 acquireLock 之前：被拒的时候不该去抢锁，否则会在磁盘上
  // 留下一个锁文件，让下一次正常启动以为"有残留锁"。
  const guardPort = consolePort(cfg, process.env);
  const guardRequired = consoleRequired(cfg, cfg.cli);
  if (guardRequired) {
    const probe = await probeConsole(guardPort, { timeoutMs: cfg.console?.probeTimeoutMs ?? 1500 });
    const verdict = startupVerdict({ ...probe, required: true, port: guardPort });
    if (!verdict.ok) {
      log.error(verdict.title);
      for (const h of verdict.hints) log.error(`  ${h}`);
      closeLogger();
      process.exitCode = 3;
      return;
    }
    consoleInfo = { text: `在线 127.0.0.1:${guardPort}（${probe.detail}）`, alive: true };
  } else {
    const why = cfg.cli.allowNoConsole ? '--allow-no-console' : 'config.console.required=false';
    consoleInfo = { text: `检查已跳过（${why}）—— 注意：没人看着它`, alive: false };
    log.warn(`控制台检查已跳过（${why}）。机器人会在没人看着的情况下往群里发消息。`);
  }

  acquireLock();
  banner();

  const state = loadState();
  const watch = cfg.cli.watch && !cfg.cli.once;

  if (!watch) {
    await scanOnce(state, { verbose: cfg.cli.verbose });
    saveState(state);
    closeLogger();
    return;
  }

  let running = true;
  // why 是给日志看的：看门狗那条路**没有收到任何信号**，
  // 一律写「收到停止信号」会让人以为是自己 Ctrl+C 停的，
  // 排查时会往完全错误的方向找（"谁按了 Ctrl+C？"）。
  const stop = (exitCode = 0, why = '收到停止信号') => {
    running = false;
    log.info(`${why}，收尾中…`);
    saveState(state);
    releaseLock();
    closeLogger();
    process.exit(exitCode);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('exit', releaseLock);
  if (process.stdin.isTTY) {
    readline.createInterface({ input: process.stdin, terminal: false })
      .on('line', (line) => { if (line.trim() === 'q') stop(); });
  }

  // ---- 第二道防线：控制台没了就自己停 ----
  //
  // 只靠"启动时检查一次"不够：控制台可能被强杀（任务管理器 / job 被回收），
  // 那种情况下控制台的 process.on('exit') 根本来不及跑，
  // 机器人就变成孤儿 —— 还在群里说话，但没有任何界面能看到它、停它。
  //
  // 连续 N 次探不到才算数（默认 2）：控制台偶尔忙一下会让一次探测超时，
  // 一次就自杀会在正常使用中误杀。
  const watchdog = guardRequired ? createConsoleWatch({ threshold: cfg.console?.failThreshold ?? 2 }) : null;

  /**
   * 控制台还活着吗。返回 true 表示"该继续跑"。
   *
   * 抽成函数是为了能在**每一轮**都调用 —— 包括扫描连续失败后的退避分支。
   * 之前把这段写在扫描之后，而扫描失败 ≥5 次时会 `continue` 跳过它，
   * 于是"QQ 窗口被关掉"这种本来就会连续失败的场景里，
   * 控制台死了机器人反而不会停 —— 最需要看门狗的时候它睡着了。
   */
  async function consoleStillThere() {
    if (!watchdog) return true;
    const probe = await probeConsole(guardPort, { timeoutMs: cfg.console?.probeTimeoutMs ?? 1500 });
    const w = watchdog.note(probe);
    if (w.shouldExit) {
      log.error(`控制台已经没了（${probe.reason}${probe.detail ? `: ${probe.detail}` : ''}），连续 ${w.failures} 次探测失败。`);
      log.error('机器人自动停止 —— 没有控制台就没人能看到它在群里说什么。');
      stop(4, '控制台已断开');
      return false;
    }
    if (w.justWarned) {
      log.warn(`控制台探测失败（${w.failures}/${w.limit}）: ${probe.reason}${probe.detail ? ` ${probe.detail}` : ''}`);
      log.warn(`再失败 ${w.limit - w.failures} 次就自动停止。`);
    } else if (w.recovered) {
      log.info('控制台又连上了，继续运行。');
    }
    return true;
  }

  const interval = cfg.watch?.intervalMs ?? 4000;
  const jitter = cfg.watch?.jitterMs ?? 800;
  log.info(`开始监测，每 ${interval}ms 一次（抖动 ±${jitter}ms）。按 Ctrl+C 停止。`);

  // ---- 自动切换聊天 ----
  //
  // 以前机器人只读**当前打开的那个**聊天，要覆盖多个会话就得手动一个个点开。
  // 开了这个之后，每轮扫描之前先看看该不该换会话，需要换就去点一下会话列表。
  //
  // ⚠ 这是整个项目里唯一会**动用户鼠标**的东西。所以：
  //   · 默认关闭（config.autoSwitch.enabled）
  //   · 只在确实需要换的时候才点（已经在目标上就不动）
  //   · 点完把光标位置还原
  //   · 刚切过就不马上再切（minGapMs），否则界面还没刷完又点，容易点空
  let autoSwitchOn = cfg.autoSwitch?.enabled === true;
  let lastSwitchedTo = '';
  let lastSwitchAt = 0;
  let lastSwitchFailed = '';
  // "以为切过去了、其实没切"的连续次数。攒够了就停自动切换 ——
  // 不然会每一轮都去点一下用户的鼠标，比不切更烦人。
  let switchMisses = 0;
  // 这一轮我们打算切到哪个会话（'' 表示没打算切）。扫描之后要拿它和
  // 界面里真正读到的会话核对 —— 点击成功不等于切过去了。
  let switchIntent = '';
  // 上一次因为"你在用电脑"而暂停轮询的原因（用来去重日志，别每轮刷）
  let busyPaused = '';
  if (autoSwitchOn) {
    log.warn('自动切换聊天：已开启 —— 会去点 QQ 的会话列表，可能抢走你的鼠标和焦点。');
    const scope = autoScopeOf(cfg);
    log.info(`  轮询范围  : ${scope === 'all' ? '会话列表里的每一个（回不回仍看白名单）'
      : scope === 'list' ? `指定列表（${(cfg.autoSwitch?.conversations ?? []).join('、') || '空'}）`
        : `白名单（${(cfg.trigger?.whitelist ?? []).join('、') || '空'}）`}`);
    if (cfg.autoSwitch?.pauseWhenActive !== false) {
      log.info(`  忙碌暂停  : 你一动键鼠就暂停，闲置 ${((Number(cfg.autoSwitch?.activeIdleMs) > 0 ? Number(cfg.autoSwitch.activeIdleMs) : 4000) / 1000).toFixed(1)}s 后继续`);
    }
  }

  /**
   * 该换就换。返回是否真的切了（切了的话这一轮的扫描内容就变了）。
   * 任何失败都只记日志、不抛 —— 切换失败不该让整个监测停掉。
   */
  async function maybeSwitchConversation() {
    if (!autoSwitchOn) return '';

    const gate = shouldSwitchNow(cfg, lastSwitchAt, Date.now());
    if (!gate.ok && gate.reason !== '自动切换没开') {
      log.debug(`暂不切换：${gate.reason}`);
      return '';
    }

    // ---- 你正在用电脑就这一轮不切 ----
    //
    // 放在读会话列表**之前**：这一步只跑一个很轻的 PowerShell 探测，
    // 而读会话列表 + 点击要动界面。闸门在最前面，代价最小。
    const idleMs = await readUserIdleMs({ timeoutMs: 8000 });
    const busy = shouldPauseForUser(cfg, idleMs);
    if (!busy.ok) {
      // 每轮都刷会淹掉日志，所以换个说法只报一次（恢复时再报一次）
      if (busyPaused !== busy.reason) {
        busyPaused = busy.reason;
        log.info(`轮询暂停：${busy.reason}。你停手之后会自动继续。`);
      }
      return '';
    }
    if (busyPaused) {
      busyPaused = '';
      log.info('轮询恢复：键鼠已闲置，继续切会话。');
    }

    const read = await readSessions({ timeoutMs: 30000 });
    if (!read.ok) {
      if (read.error !== lastSwitchFailed) {
        lastSwitchFailed = read.error;
        log.warn(`自动切换：读会话列表失败（${read.error}）—— 这一轮保持当前会话`);
      }
      return '';
    }
    lastSwitchFailed = '';

    const targets = targetConversations(cfg, read.sessions);
    if (targets.length === 0) {
      // 只在第一次说一声，别每轮刷
      if (!switchWatch.warned) {
        switchWatch.warned = true;
        log.warn(`自动切换：没有可切换的目标（白名单/autoSwitch.conversations 都没匹配上当前列表：${read.sessions.map((s) => s.name).join('、') || '空'}）`);
      }
      return '';
    }

    const current = getCurrentConversation();
    const pick = pickNextConversation(targets, current, lastSwitchedTo);
    if (!pick) {
      log.debug(`自动切换：已经在目标会话「${current}」上，不动`);
      return '';
    }

    const r = await switchToConversation(pick.name, {
      sessions: read.sessions,
      handle: read.handle,
      cfg,
      restoreCursor: cfg.autoSwitch?.restoreCursor !== false,
      waitMs: cfg.autoSwitch?.settleMs ?? 1500,
    });
    if (!r.ok) {
      log.warn(`自动切换：「${pick.name}」没切成（${r.error}）`);
      return '';
    }

    lastSwitchedTo = r.name;
    lastSwitchAt = Date.now();
    setCurrentConversation(r.name);
    const driftNote = r.drift > 0 ? `，落点差 ${r.drift}px` : '';
    if (r.verified) {
      // 点击脚本说落点可疑，但读了界面确认切过去了。说一声，
      // 免得下次看日志又以为是失败。
      log.info(`已切到「${r.name}」（${pick.reason}${driftNote}，已读界面复核${r.restored ? '，光标已还原' : ''}）`);
    } else {
      log.info(`已切到「${r.name}」（${pick.reason}${driftNote}${r.restored ? '，光标已还原' : ''}）`);
    }
    return r.name;
  }

  // 人生模拟的节拍器。判定是纯逻辑（life.js），这里只负责"什么时候问它一次"。
  const lifeTicker = createLifeTicker(cfg);

  /**
   * 问一次「该不该让它自己去过日子了」。
   *
   * 调用点在**控制台检测之后** —— 用户要的节拍就是「每 5 次控制台检测」，
   * 而上面那行 `consoleStillThere()` 正是那次检测。挪到别处计数就对不上了。
   *
   * 不 await 是故意的：模拟要调一次 API，本地模型能跑几十秒，
   * await 会把扫描节奏拖垮（这段时间来的消息就得排队等它）。
   * 它是背景活动 —— 没赶上就没赶上，下一轮再说。
   */
  function maybeSimulateLife() {
    // state 现给一份"开关快照"：tick 里只关心开没开
    const decision = lifeTicker.tick(apiCallStats.total, Date.now(), { lifeEnabled: lifeRuntime.enabled });
    if (!decision.ok) {
      // 节流原因只写 debug：每 4 秒一轮，写 info 会把日志刷满
      log.debug(`人生模拟：暂不模拟（${decision.reason}）`);
      return;
    }

    // 角色时钟的刹车：模拟世界不许跑到现实前面（用户要求的那条）。
    // 世界还在未来时就不模拟 —— 这段期间**一次 API 都不调用**。
    const gate = lifeClockGate(cfg, loadLifeLog(cfg, ROOT, lifeRuntime.profile).log, Date.now());
    if (!gate.ok) {
      // 只报一次"开始等"，之后降成 debug：这段等待最长 15 分钟，
      // 每轮都写 info 会刷屏（倒计时每分钟都会变一次）。
      if (!lifeWatch.clockWaiting) {
        lifeWatch.clockWaiting = true;
        log.info(`人生模拟：${gate.reason}`);
      } else {
        log.debug(`人生模拟：仍在等（${gate.reason}）`);
      }
      return;
    }
    if (lifeWatch.clockWaiting) log.debug('人生模拟：现实追上来了，恢复模拟');
    lifeWatch.clockWaiting = false;

    lifeTicker.beginRun();
    Promise.resolve()
      .then(() => runLifeSimulation(state))
      .catch((e) => log.warn(`人生模拟异常（已忽略）：${e?.message ?? e}`))
      .finally(() => {
        // 收尾也要护住：机器人可能刚好在这期间被停掉、日志已经关了，
        // 这里再抛就成了未捕获的 rejection。
        try {
          lifeTicker.endRun();
          // 这次模拟自己也算一次 API 调用，但它**不该**算进"这段检测里调用过 API"
          // —— 不抬基准的话，下一个窗口永远显示"调用过"，人生模拟只会发生一次。
          lifeTicker.rebaseline(apiCallStats.total);
        } catch { /* 忽略 */ }
      });
  }

  let consecutiveErrors = 0;
  while (running) {
    // 先看控制台，再看 QQ。这样无论扫描成功还是失败，每一轮都会检查。
    if (!(await consoleStillThere())) return;

    // 人生模拟的触发点（见上面那段注释）。
    refreshLifeRuntime();
    maybeSimulateLife();

    // 换会话放在扫描之前：这样这一轮读到的就是新会话的内容
    switchIntent = '';
    try {
      switchIntent = (await maybeSwitchConversation()) || '';
    } catch (err) {
      log.warn(`自动切换出错（已忽略）：${err?.message ?? err}`);
    }

    try {
      await scanOnce(state, { verbose: cfg.cli.verbose });
      consecutiveErrors = 0;

      // 切换复核。点击脚本说成功，只代表"那一下点出去了"；
      // 到底切没切过去只有界面说了算（scanOnce 会把读到的会话记下来）。
      // 没切过去就立刻重试，别干等一个 minGapMs。
      if (switchIntent) {
        const actual = getCurrentConversation();
        if (actual && !sessionMatches(actual, switchIntent)) {
          switchMisses++;
          log.warn(
            `自动切换：本以为切到「${switchIntent}」，界面其实还在「${actual}」` +
              `（第 ${switchMisses} 次）`
          );
          if (switchMisses >= 3) {
            autoSwitchOn = false;
            log.warn('自动切换：连续 3 次没切过去，已自动停用（免得反复去点鼠标）。可在控制台改回开启。');
          } else {
            lastSwitchAt = 0; // 绕过最小间隔，下一轮马上重试
            lastSwitchedTo = '';
          }
        } else if (actual) {
          switchMisses = 0;
          log.debug(`自动切换复核：界面确实在「${actual}」`);
        }
      }
    } catch (err) {
      consecutiveErrors++;
      log.error(`扫描失败(${consecutiveErrors}): ${err.message}`);
      if (err.info) log.debug('失败详情', err.info);
      // 连续失败时逐步退避，避免窗口被关掉后疯狂刷日志
      if (consecutiveErrors >= 5) {
        const backoff = Math.min(60000, interval * consecutiveErrors);
        log.warn(`连续失败 ${consecutiveErrors} 次，退避 ${Math.round(backoff / 1000)}s`);
        await sleep(backoff);
        continue;
      }
    }
    await sleep(interval + Math.random() * jitter);
  }
  closeLogger();
}

main().catch((err) => {
  log.error(`致命错误: ${err.stack ?? err.message}`);
  closeLogger();
  process.exitCode = 1;
});
