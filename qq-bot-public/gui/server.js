/**
 * server.js — 机器人控制台（本地网页 GUI）。
 *
 * 为什么是「本地网页」而不是原生窗口：
 *   这台机器没有 npm，装不了 Electron / Tauri / node-gui 之类。
 *   所以用 Node 内置的 http 模块起一个只监听 127.0.0.1 的小服务，
 *   界面是内嵌的 HTML（零依赖、跨平台、不用编译）。
 *
 * 它能做什么：
 *   · 改 API key（按厂商分开存，写进 .env）
 *   · 切换模型厂商、改模型名、上下文字数
 *   · 改白名单、回复概率、接管模式、发送模式
 *   · 启动 / 停止机器人，实时看日志
 *
 * 安全边界：
 *   · 只绑 127.0.0.1，外部访问不到
 *   · key 默认打码返回，要看全文必须显式点「显示」
 *   · 写 config.json 时只改指定字段，其余键（含注释）原样保留
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderPage } from './page.js';
import { BUILTIN_POOLS, POOL_LABELS, resolvePools, previewFallback } from '../src/fallback.js';
import { autoScopeOf, parseSessions, targetConversations } from '../src/sessions.js';
import { describeSystemRules } from '../src/system-msg.js';
// 人设：可切换的身份（提示词 + 它的人生 + 它的记忆）
import {
  personasDir, listPersonas, loadPersona, savePersona, copyPersona, deletePersona,
  activePersonaName, planSwitch, promptSource, seedFromConfig,
} from '../src/persona.js';
import { readSessions } from '../src/switch.js';
import {
  loadStore, saveStore, renderMemory, flattenStore, emptyGlobal, emptyConversation,
  loadGlobal, loadConversation, listConversations, memoryDir,
  saveGlobal, saveConversation,
  // 人设相关：记忆按人设分目录（memory/<人设>/），这两个用来算目录、喂初始记忆
  activePersonaOf, personaMemoryDirOf, seedPersonaMemory,
} from '../src/memory.js';
import { listModels, probeProvider } from '../src/llm.js';
import { lifeConfig, loadLifeLog, renderLife, emptyLifeLog, saveLifeLog, listLives, livesDir, lifeEnabled, shareEnabled, activeProfile, countSharesToday, createLifeProfile } from '../src/life.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');
const CFG_FILE = path.join(ROOT, 'config.json');
const STATE_FILE = path.join(ROOT, 'state.json');
// 新建人设时的占位提示词（用户还没写）。文件顶部集中一处，避免散落在逻辑里。
const PLACEHOLDER_PROMPT = '（在这里写这个人设的说话方式。空提示词会让 API 报错，所以先留一行占位。）';
const PORT = Number(process.env.GUI_PORT) || 7788;
// 进程起来的时刻。用来判断"我这个进程加载的控制台代码是不是已经过期"。
const PROCESS_STARTED_AT = Date.now();

// ---------------------------------------------------------------- 状态 ----
let child = null;                 // 正在跑的机器人进程
const logs = [];                  // 日志环形缓冲
const MAX_LOGS = 800;
const sseClients = new Set();

function pushLog(line, kind = 'out') {
  const rec = { t: Date.now(), line, kind };
  logs.push(rec);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  const payload = `data: ${JSON.stringify(rec)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { /* 客户端断了，下次心跳会清 */ }
  }
}

// ------------------------------------------------------------- .env IO ----
/** 读取 .env（保留原始行，改的时候只替换目标行，注释和顺序都不动）。 */
function readEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return { exists: false, lines: [] };
  const text = fs.readFileSync(ENV_FILE, 'utf8').replace(/^\uFEFF/, '');
  return { exists: true, lines: text.split(/\r?\n/) };
}

function readEnvMap() {
  const { lines } = readEnvFile();
  const map = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    map[m[1]] = v;
  }
  return map;
}

/** 写回一个 key，尽量只动那一行；没有就追加。 */
function writeEnvVar(name, value) {
  const { exists, lines } = readEnvFile();
  const work = exists ? [...lines] : [
    '# qq-bot 的 API key。这个文件不要提交到版本库。',
    '# 格式说明见 .env.example',
    '',
  ];
  const re = new RegExp(`^(\\s*(?:export\\s+)?${name}\\s*=\\s*).*$`);
  let done = false;
  for (let i = 0; i < work.length; i++) {
    if (re.test(work[i])) {
      work[i] = work[i].replace(re, `$1${value}`);
      done = true;
      break;
    }
  }
  if (!done) {
    if (work.length && work[work.length - 1].trim() !== '') work.push('');
    work.push(`${name}=${value}`);
  }
  // 用 BOM 写入更稳：某些编辑器/工具在 Windows 上会按 ANSI 猜测无 BOM 文件
  fs.writeFileSync(ENV_FILE, work.join('\r\n'), 'utf8');
  return true;
}

// ------------------------------------------------------------ config IO ----
function readConfigRaw() {
  return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
}

/**
 * 记忆模块只需要 cfg.memory，而 cfg 每次请求现读 —— 这样在控制台改了配置
 * （比如关掉记忆、换记忆文件名）不用重启控制台就生效。
 *
 * 读失败时退回默认配置（记忆默认开启、文件 memory.json），
 * 不能因为 config.json 一时读不到就让整个记忆面板报错。
 */
function cfgForMemory() {
  try {
    const raw = readConfigRaw();
    return {
      memory: raw.memory ?? { enabled: true, file: 'memory.json' },
      // life 也要带上：生活日志是同一个面板里的东西，lifeConfig() 要读 cfg.life。
      // 只传 memory 的话它会按"没配置"处理 → 面板上显示成「已关闭」，
      // 而 config.json 里明明是 true（这个 bug 真的出现了：
      // 测试读到 enabled=false，去查文件却是 true）。
      life: raw.life ?? {},
      // persona 也要带上：人设面板要读 config.persona（第一次用时从它播种，
      // 以及"没有当前人设时提示词来自哪"）。少这一个字段的表现是
      // 「config.json 里也没有提示词，没什么可搬的」—— 而文件里明明有。
      persona: raw.persona ?? {},
      llm: raw.llm ?? {},
      trigger: raw.trigger ?? {},
    };
  } catch {
    return { memory: { enabled: true, file: 'memory.json' }, life: {}, persona: {}, llm: {}, trigger: {} };
  }
}

/**
 * 记忆面板的数据。
 *
 * 同时返回 **渲染后的 digest** 和 **原始 JSON**：
 * 排查「它怎么记不住刚才的事」时，真正该看的是 digest ——
 * 那才是拼进提示词的东西。只看原始 JSON 会漏掉"字段有值但被上限截掉了"这类问题。
 */
/**
 * 记忆面板的数据。
 *
 * 记忆现在是两层：总记忆一份 + 每个会话一份。面板要能：
 *   · 看到**模型实际读到的**那段文字（两层的合成）
 *   · 在多个会话之间切换查看
 *   · 分别看两层的原始 JSON
 *
 * 注意 digest 要按选中的会话渲染 —— 只渲染总记忆的话，
 * "私聊里带着群里的事"这类问题在面板上根本看不出来。
 */
function memoryView(conversation) {
  const cfg = cfgForMemory();
  const g = loadGlobal(cfg, ROOT);
  const list = listConversations(cfg, ROOT);

  // 没指定会话就用最近更新的那一份；一份都没有就空着
  const names = list.filter((c) => c.ok).map((c) => c.conversation).filter(Boolean);
  const pick = conversation
    || list.filter((c) => c.updatedAt).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]?.conversation
    || names[0]
    || '';

  const c = loadConversation(cfg, ROOT, pick);
  const store = { global: g.memory, conversation: c.memory };

  return {
    ok: true,
    global: {
      exists: g.ok,
      reason: g.reason ?? null,
      path: path.relative(ROOT, g.path),
      memory: g.memory,
    },
    conversation: {
      name: pick,
      exists: c.ok,
      reason: c.reason ?? null,
      path: path.relative(ROOT, c.path),
      memory: c.memory,
    },
    conversations: list,
    // 显示的是**当前人设那份**记忆的目录（memory/<人设>/）——
    // 记忆现在是人设的子项，面板上得让人看出"这份属于谁"。
    dir: path.relative(ROOT, (() => {
      const who = activePersonaOf(ROOT);
      return who ? personaMemoryDirOf(cfg, ROOT, who) : memoryDir(cfg, ROOT);
    })()),
    persona: activePersonaOf(ROOT),
    digest: renderMemory(store, cfg),
    // 生活日志（人生模拟的产物）。它是记忆的一部分 —— 「我最近在做什么」，
    // 所以放在同一个面板里给用户看：不然那功能对它来说就是黑箱。
    life: lifeView(cfg),
    // 兼容旧字段（老版本的页面/测试读的是 memory / exists）
    exists: c.ok || g.ok,
    memory: flattenStore(store),
    path: path.relative(ROOT, g.path),
  };
}

/**
 * 生活日志的只读视图（人生模拟那一块）。
 *
 * 「最近几条」按时间倒序给出来，页面直接铺开就能看；digest 是真正注入
 * 提示词的那段文字 —— 让用户能一眼看到"模型到底读到了什么"，
 * 而不是只看到日志文件里的一堆字段。
 */
function lifeView(cfg) {
  const conf = lifeConfig(cfg);
  // 现读 state：开关和"当前是谁的人生"都存在那里（机器人每轮也这么读）
  const st = readState();
  const profile = activeProfile(cfg, st);
  const { log, ok, reason, path: file } = loadLifeLog(cfg, ROOT, profile);
  const entries = [...log.entries].reverse();
  const allowed = conf.share.conversations.length
    ? conf.share.conversations
    : (cfg?.trigger?.whitelist ?? []);
  return {
    // enabled 报的是**当前生效**的值（state 覆盖 config），不是配置里那个
    enabled: lifeEnabled(cfg, st),
    configuredEnabled: conf.enabled,
    configuredShare: conf.share.enabled,
    overridden: {
      lifeEnabled: typeof st.lifeEnabled === 'boolean',
      shareEnabled: typeof st.shareEnabled === 'boolean',
      profile: typeof st.lifeProfile === 'string' && st.lifeProfile.trim() !== '',
    },
    everyChecks: conf.everyChecks,
    profile,
    profileIsDefault: profile === '',
    lives: listLives(cfg, ROOT),
    livesDir: path.relative(ROOT, livesDir(cfg, ROOT)),
    file: path.relative(ROOT, file),
    exists: ok,
    reason: reason ?? null,
    total: log.entries.length,
    updatedAt: log.updatedAt,
    recent: entries.slice(0, 20),
    digest: renderLife(log, cfg),
    // 主动分享的状态也报出来：它是唯一会主动跟真人说话的功能，
    // 用户在面板上看不到它开没开、发过几次，就等于不知道机器人在替他说话。
    share: {
      enabled: shareEnabled(cfg, st),
      probability: conf.share.probability,
      minIntervalMinutes: Math.round(conf.share.minIntervalMs / 60000),
      maxPerDay: conf.share.maxPerDay,
      quietFrom: conf.share.quietFrom,
      quietTo: conf.share.quietTo,
      allowed,
      totalShared: log.entries.filter((e) => e.shared && e.shared.sent).length,
      totalConsidered: log.entries.filter((e) => e.share).length,
      totalSuitable: log.entries.filter((e) => e.share && e.share.suitable).length,
      sharesToday: countSharesToday(st, Date.now()),
    },
  };
}

/** 深拷贝后按路径设值，返回是否真的改动了。 */
function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (JSON.stringify(cur[last]) === JSON.stringify(value)) return false;
  cur[last] = value;
  return true;
}

/**
 * 只改指定字段，其余键（含 $comment 注释）原样保留。
 * 用 JSON 全量重写会丢掉注释 —— 那些注释是给人看的说明，不能丢。
 */
function patchConfig(patch) {
  const raw = readConfigRaw();
  const before = JSON.stringify(raw);
  let changed = 0;
  for (const [k, v] of Object.entries(patch)) {
    if (setPath(raw, k, v)) changed++;
  }
  if (changed === 0) return { ok: true, changed: 0 };
  fs.writeFileSync(CFG_FILE, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return { ok: true, changed };
}

// --------------------------------------------------------------- state -----

/**
 * 这个进程加载的控制台代码，比磁盘上的新还是旧。
 *
 * 为什么需要它（这是本项目反复踩的一个坑）：
 *   server.js / page.js 是 Node 在 import 时**读一次就缓存住**的。
 *   于是「改了控制台代码 → 刷新浏览器」看到的还是旧界面，一切正常、毫无报错，
 *   而人只会以为"我改的没生效"。真实发生过的对话：
 *     「为什么我打开控制台不是修改后的界面」
 *   ——因为跑着的那个进程是几个小时前起的，双击启动器又只会打开它（端口探测
 *     发现已占用就不再启动），所以怎么刷新都没用。
 *
 * 判断方式很直接：**文件比进程新，就说明这个进程加载的是旧代码**。
 * 拿到这个标志，页面就能自己告诉用户"去重启控制台"，不用靠记性。
 */
function consoleFreshness() {
  const files = ['server.js', 'page.js'].map((f) => path.join(ROOT, 'gui', f));
  const startedAt = PROCESS_STARTED_AT;
  let newest = null;
  let newestMtime = 0;
  for (const f of files) {
    try {
      const m = fs.statSync(f).mtimeMs;
      if (m > newestMtime) { newestMtime = m; newest = path.basename(f); }
    } catch { /* 文件没了就算了 */ }
  }
  return {
    startedAt,
    startedAtText: new Date(startedAt).toLocaleString('zh-CN', { hour12: false }),
    newestFile: newest,
    newestMtime,
    // 留 1 秒余量：写文件和起进程在同一秒内很容易撞上，误报会让人白白重启一次
    stale: newestMtime > startedAt + 1000,
  };
}

function readState() {
  try {
    // 去 BOM（同 gate.loadState）：state.json 被记事本另存过的话，
    // 带 BOM 会解析失败 → 这里返回 {} → 控制台读到的"当前人设/人生"全是空的，
    // 而机器人那边读的是同一份文件 —— 两边看到的不是一个状态，最难查。
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

function writeTakeover(on) {
  const s = readState();
  s.takeoverEnabled = Boolean(on);
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
  return s.takeoverEnabled;
}

/**
 * 写人生模拟那一组的运行时开关 / 当前人生。
 *
 * 为什么写 state.json 而不是 config.json：
 *   机器人只在启动时读一次 config，改了 config 得重启才生效；
 *   而这三个值用户点了就想立刻看到效果 —— 尤其是那两个开关，
 *   一个在花钱、一个在**主动跟真人说话**。state.json 是机器人每轮现读的
 *   （「AI 接管」开关也是这么做的，理由一样）。
 *
 * patch 里只认这三个键，其余一律忽略（别让控制台变成"什么都能改"的后门）。
 */
function writeLifeRuntime(patch = {}) {
  const s = readState();
  if (patch.lifeEnabled === true || patch.lifeEnabled === false) s.lifeEnabled = patch.lifeEnabled;
  if (patch.shareEnabled === true || patch.shareEnabled === false) s.shareEnabled = patch.shareEnabled;
  if (typeof patch.lifeProfile === 'string') s.lifeProfile = patch.lifeProfile.trim();
  // 人设（身份）：空串 = 没有当前人设（回到 config.json 里那份提示词）
  if (typeof patch.personaProfile === 'string') s.personaProfile = patch.personaProfile.trim();
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
  return s;
}

// ---------------------------------------------------------------- 人设 ----

/**
 * 人设面板的数据。
 *
 * 这里把"当前是谁"和"它有哪些子项"一起给出去：
 *   提示词（人设自己的） · 它的人生（lifeProfile） · 它的记忆目录（memory/<名字>/）
 * 让界面能一眼看出"切人设到底会切走什么"，而不是只看到一个下拉框。
 */
function personasView() {
  const cfgP = cfgForMemory();
  const st = readState();
  const active = activePersonaName(cfgP, st);
  const list = listPersonas(cfgP, ROOT);
  const src = promptSource(cfgP, ROOT, st);
  const persona = active ? loadPersona(cfgP, ROOT, active) : null;
  const memDir = active
    ? path.relative(ROOT, personaMemoryDirOf(cfgP, ROOT, active))
    : path.relative(ROOT, memoryDir(cfgP, ROOT));

  return {
    ok: true,
    active,
    list: list.map((p) => ({ ...p, isActive: p.name === active })),
    // 提示词：有当前人设就给它的（可编辑），没有就给 config 里那份（只读提示，供"搬过来"）
    prompt: persona ? persona.systemPrompt : (Array.isArray(cfgP?.persona?.systemPrompt) ? [] : []),
    promptFrom: src.from,        // persona | config
    promptSource: src,           // { from, name, lines, path }
    dir: path.relative(ROOT, personasDir(cfgP, ROOT)),
    memoryDir: memDir,
    life: active ? (persona?.life || active) : activeProfile(cfgP, st),
  };
}

/**
 * 真正把"切换人设"落到 state.json（+ 需要时把人设的记忆目录喂上）。
 *
 * 为什么这两件事必须绑在一起：记忆是按人设分目录的，切过去之后如果那个目录是空的，
 * 用户会看到"记忆突然全没了" —— 其实只是换了一份。所以：
 *   · 第一个人设（多身份的总入口）→ 把老位置那份记忆**拷**过去（不然"记忆没了"）
 *   · 之后新建的人设默认**空白开始**；显式要求克隆时才从当前人设那儿拷
 *   （`memoryFrom`）—— 一个新身份继承别人的经历是说不通的，除非用户就是要克隆。
 */
function applyPersonaSwitch(cfgP, plan, opts = {}) {
  writeLifeRuntime(plan.patch);
  const from = opts.memoryFrom ? `persona:${opts.memoryFrom}` : 'legacy';
  // 只有"第一个人设"才从老位置迁移。已经有多个人设了，再切来切去不该反复迁移。
  const isFirst = listPersonas(cfgP, ROOT).length <= 1;
  const useFrom = from.startsWith('persona:') ? from : (isFirst ? 'legacy' : '');
  if (!useFrom) return { copied: [], skipped: true, reason: '不是第一个人设，记忆从空白开始' };
  return seedPersonaMemory(cfgP, ROOT, plan.persona.name, { from: useFrom });
}

// ------------------------------------------------------------ bot 控制 -----
function botRunning() {
  return child !== null && child.exitCode === null;
}

function startBot(extraArgs = []) {
  if (botRunning()) return { ok: false, error: '机器人已经在运行了' };

  const args = ['src/bot.js', '--watch', ...extraArgs];
  pushLog(`$ node ${args.join(' ')}`, 'cmd');

  child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: process.env,          // .env 由 bot 自己读，这里不用注入
    windowsHide: true,
  });

  child.stdout.on('data', (b) => {
    for (const line of String(b).split(/\r?\n/)) {
      if (line.trim()) pushLog(line, 'out');
    }
  });
  child.stderr.on('data', (b) => {
    for (const line of String(b).split(/\r?\n/)) {
      if (line.trim()) pushLog(line, 'err');
    }
  });
  child.on('exit', (code, signal) => {
    pushLog(`[进程退出] code=${code} signal=${signal ?? '-'}`, 'sys');
    child = null;
  });

  return { ok: true };
}

function stopBot() {
  if (!botRunning()) return { ok: false, error: '机器人没有在运行' };
  pushLog('[控制台] 正在停止机器人…', 'sys');
  try {
    // Windows 上 child.kill('SIGTERM') 对 node 子进程不一定干净，
    // 但 node 收到 SIGTERM 会走 releaseLock + 退出，实测有效。
    child.kill('SIGTERM');
  } catch (e) {
    pushLog(`[控制台] 停止失败: ${e.message}`, 'err');
    return { ok: false, error: e.message };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- HTTP -----
function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

/** 组装给界面的配置视图。key 默认打码。 */
function configView(revealKey = false) {
  const cfg = readConfigRaw();
  const envMap = readEnvMap();
  const providers = cfg.llm?.providers ?? {};
  const active = cfg.llm?.provider ?? 'deepseek';

  const mask = (v) => {
    if (!v) return { set: false, masked: '', value: '' };
    const shown = `${v.slice(0, 5)}${'*'.repeat(Math.max(0, Math.min(12, v.length - 9)))}${v.slice(-4)}`;
    return { set: true, masked: shown, value: revealKey ? v : '' };
  };

  const providerViews = {};
  for (const [name, p] of Object.entries(providers)) {
    const envName = p.apiKeyEnv || `${name.toUpperCase()}_API_KEY`;
    providerViews[name] = {
      baseUrl: p.baseUrl ?? '',
      model: p.model ?? '',
      apiKeyEnv: envName,
      key: mask(envMap[envName] || p.apiKey || ''),
      // 这家要不要 key。本地推理服务（Ollama / LM Studio …）不要，
      // 界面上必须把「本来就不用配」和「该配没配」分开显示 ——
      // 否则用户看到"未配置"会以为坏了。
      requiresKey: p.requiresKey !== false,
      isLocal: /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)/i.test(String(p.baseUrl ?? '')),
      // 思考模式（Qwen3 这类推理模型支持）。
      //   true  = 先推理再作答（默认，质量好但慢很多）
      //   false = 直接作答（快很多）
      // 没配过就按 true 显示：模型自己的默认就是"思考开着"。
      //
      // ⚠ 这个参数走的是 `chat_template_kwargs`，那是 llama.cpp / vLLM 这一族的
      //   扩展字段，**云端厂商（DeepSeek 等）不认它**，硬发过去可能直接 400。
      //   所以控制台只对"本地服务"显示这个开关（isLocal），别的地方不写这个键。
      enableThinking: p.enableThinking !== false,
    };
  }

  return {
    active,
    providers: providerViews,
    llm: {
      timeoutMs: cfg.llm?.timeoutMs ?? 20000,
      maxTokens: cfg.llm?.maxTokens ?? 300,
      contextMessages: cfg.llm?.contextMessages ?? 16,
      systemPrompt: cfg.llm?.systemPrompt ?? '',
    },
    trigger: {
      whitelist: cfg.trigger?.whitelist ?? [],
      // 回复范围：whitelist（只回白名单） | all（所有会话都回）
      replyScope: cfg.trigger?.replyScope === 'all' ? 'all' : 'whitelist',
      replyProbability: cfg.trigger?.replyProbability,
      mentionAlwaysReplies: cfg.trigger?.mentionAlwaysReplies !== false,
      cooldownMs: cfg.trigger?.cooldownMs ?? 0,
      maxRepliesPerMinute: cfg.trigger?.maxRepliesPerMinute ?? 0,
      // 系统消息过滤：QQ 自己的提示语不当作消息回（规则表在 src/system-msg.js）
      ignoreSystemMessages: cfg.trigger?.ignoreSystemMessages !== false,
      systemPatterns: Array.isArray(cfg.trigger?.systemPatterns) ? cfg.trigger.systemPatterns : [],
    },
    // 内置的系统消息规则名（给界面显示"到底筛了哪些"，不用它去匹配）
    systemRules: describeSystemRules(),
    reply: {
      dryRun: cfg.reply?.dryRun !== false,
      maxChars: cfg.reply?.maxChars ?? 200,
      // 模型调不通时要不要发本地兜底话。以前这个键**没有任何代码读**（死开关），
      // 现在真的生效了，所以也得让用户能看见、能改（默认 true = 发）。
      fallbackWhenApiDown: cfg.reply?.fallbackWhenApiDown !== false,
    },
    // 控制台自己的新鲜度（页面会据此提醒"代码更新了，该重启控制台"）
    console: consoleFreshness(),
    persona: {
      enabled: cfg.persona?.enabled === true,
      takeoverPatterns: cfg.persona?.takeoverPatterns ?? [],
      systemPrompt: Array.isArray(cfg.persona?.systemPrompt)
        ? cfg.persona.systemPrompt.join('\n')
        : (cfg.persona?.systemPrompt ?? ''),
    },
    // 固定回复池：把「当前生效的值」和「内置默认」都给界面，
    // 前者用来预填编辑框，后者用来标出哪些被改过、以及支持「恢复默认」。
    pools: (() => {
      const effective = resolvePools(cfg);          // 已经合并过用户覆盖
      const overrides = cfg.fallback?.pools ?? {};
      const out = {};
      for (const key of Object.keys(BUILTIN_POOLS)) {
        const isOverridden = Array.isArray(overrides[key]) && overrides[key].length > 0;
        out[key] = {
          label: POOL_LABELS[key] ?? key,
          effective: effective[key] ?? [],
          builtin: BUILTIN_POOLS[key] ?? [],
          overridden: isOverridden,
        };
      }
      return out;
    })(),
    state: {
      running: botRunning(),
      takeoverEnabled: readState().takeoverEnabled,
      envFileExists: fs.existsSync(ENV_FILE),
    },
    // 自定义回复规则（fallback.rules）。
    //
    // 引擎里一直有这个功能，控制台却一直没有界面 —— 用户只能手改 config.json，
    // 反馈就是「未接入 API 时的回复功能无法自主增加提示词」。
    // 现在把它原样交给界面编辑（match 是正则，replies 是一行一句）。
    fallback: {
      enabled: cfg.fallback?.enabled !== false,
      customRulesFirst: cfg.fallback?.customRulesFirst === true,
      defaultReply: String(cfg.fallback?.defaultReply ?? ''),
      rules: (Array.isArray(cfg.fallback?.rules) ? cfg.fallback.rules : []).map((r) => ({
        match: String(r?.match ?? ''),
        replies: Array.isArray(r?.replies)
          ? r.replies.map((s) => String(s))
          : (r?.reply ? [String(r.reply)] : []),
      })),
    },
    // 自动轮询（会动用户的鼠标，所以界面上要说清楚）
    autoSwitch: {
      enabled: cfg.autoSwitch?.enabled === true,
      scope: autoScopeOf(cfg),
      conversations: Array.isArray(cfg.autoSwitch?.conversations) ? cfg.autoSwitch.conversations : [],
      settleMs: Number(cfg.autoSwitch?.settleMs) > 0 ? Number(cfg.autoSwitch.settleMs) : 1500,
      minGapMs: Number(cfg.autoSwitch?.minGapMs) > 0 ? Number(cfg.autoSwitch.minGapMs) : 3000,
      restoreCursor: cfg.autoSwitch?.restoreCursor !== false,
      pauseWhenActive: cfg.autoSwitch?.pauseWhenActive !== false,
      activeIdleMs: Number(cfg.autoSwitch?.activeIdleMs) > 0 ? Number(cfg.autoSwitch.activeIdleMs) : 4000,
    },
  };
}

/**
 * 轮询范围的三档，做一次归一。
 *
 * 归一的规则**只有一份**，在 src/sessions.js 的 autoScopeOf 里 ——
 * 控制台和机器人必须用同一套语义，否则界面显示"全部会话"而引擎按白名单跑，
 * 用户看到的和实际发生的对不上（这个项目里最容易把人带偏的一类 bug）。
 */

/**
 * 规范化 persona.systemPrompt 的写入值。
 *
 * 保护：界面里把提示词清空后保存，会得到 `[""]` 或 `[]`。
 * 直接写进去的后果不只是"没人设" —— 空 content 会让 API 报错，
 * 机器人静默降级到本地规则，看起来就是"回复突然变机械了"。
 * （src/takeover.js 里也有回落兜底，这里是第二道，避免把坏值落盘。）
 *
 * 返回 undefined 表示"这个字段不该写"。
 */
function normalizePromptPatch(value) {
  const arr = Array.isArray(value) ? value : [value];
  const lines = arr.map((s) => String(s ?? ''));
  if (lines.join('').trim() === '') return undefined;
  return lines;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // 只允许本机访问：即便绑定了 127.0.0.1，也再挡一次
  const remote = req.socket.remoteAddress ?? '';
  if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) {
    res.writeHead(403); res.end('forbidden'); return;
  }

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(renderPage({ port: PORT }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      json(res, configView(url.searchParams.get('reveal') === '1'));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req);
      const applied = [];

      // key 写进 .env
      if (body.keys && typeof body.keys === 'object') {
        for (const [envName, value] of Object.entries(body.keys)) {
          if (typeof value !== 'string') continue;
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
            writeEnvVar(envName, value.trim());
            applied.push(`key:${envName}`);
          }
        }
      }

      // 固定回复池：只写「和内置默认不同」的那些，config.json 才不会被默认值撑大。
      // 传空数组表示「恢复默认」，此时把该键从 config 里删掉，而不是写个空数组
      // （空数组会让 resolvePools 继续用内置默认，但留着等于埋了个没用的键）。
      const raw = readConfigRaw();
      let poolChanged = 0;

      if (body.pools && typeof body.pools === 'object') {
        const pools = { ...(raw.fallback?.pools ?? {}) };
        for (const [key, list] of Object.entries(body.pools)) {
          if (!(key in BUILTIN_POOLS)) continue;                 // 不认识的池子名忽略
          if (!Array.isArray(list)) continue;
          const clean = list.map((s) => String(s).trim()).filter(Boolean);
          const builtin = BUILTIN_POOLS[key] ?? [];
          const same = clean.length === builtin.length && clean.every((v, i) => v === builtin[i]);
          if (clean.length === 0 || same) {
            if (pools[key] !== undefined) { delete pools[key]; poolChanged++; }
          } else {
            if (JSON.stringify(pools[key]) !== JSON.stringify(clean)) { pools[key] = clean; poolChanged++; }
          }
        }
        if (Object.keys(pools).length === 0) delete raw.fallback.pools;
        else raw.fallback.pools = pools;
        if (poolChanged) applied.push(`回复池(${poolChanged} 项)`);
      }

      // 单独「恢复全部默认」
      if (body.resetPools === true) {
        if (raw.fallback?.pools !== undefined) { delete raw.fallback.pools; applied.push('回复池已恢复默认'); }
      }

      // 其余字段改 config.json（只动指定路径）
      if (body.config && typeof body.config === 'object') {
        const patch = { ...body.config };

        // 自定义回复规则：清洗一遍再落盘。
        //
        // 为什么要清：这是**用户自己写**的一串条目，界面上加一条空行、
        // 或者删掉了回复只剩匹配词，都会留下垃圾。垃圾条目的危害不是"没用"，
        // 而是每条消息都要为它跑一次正则；空 match 的条目更糟 ——
        // `new RegExp('')` 匹配一切，会把**所有**消息都吃掉。
        if ('fallback.rules' in patch) {
          const rawRules = Array.isArray(patch['fallback.rules']) ? patch['fallback.rules'] : [];
          const clean = [];
          let dropped = 0;
          for (const r of rawRules) {
            const match = String(r?.match ?? '').trim();
            const replies = (Array.isArray(r?.replies) ? r.replies : [])
              .map((s) => String(s).trim()).filter(Boolean);
            if (!match || replies.length === 0) { dropped++; continue; }
            clean.push({ match, replies });
          }
          patch['fallback.rules'] = clean;
          if (dropped) applied.push(`规则里 ${dropped} 条没写全（缺匹配词或回复），已丢弃`);
        }

        // 人设提示词单独规范化：清空后不写盘，避免落下一个空 content。
        // 空 content 会让 API 报错、机器人静默降级到本地规则，
        // 用户看到的现象是"回复突然变机械了"，很难联想到是自己清空了提示词。
        if ('persona.systemPrompt' in patch) {
          const normalized = normalizePromptPatch(patch['persona.systemPrompt']);
          if (normalized === undefined) {
            delete patch['persona.systemPrompt'];
            applied.push('人设提示词为空，已忽略（保留原值）');
          } else {
            patch['persona.systemPrompt'] = normalized;
          }
        }

        if (Object.keys(patch).length > 0) {
          const r = patchConfig(patch);
          applied.push(`config(${r.changed} 项)`);
        }
      }

      // pools 的改动是直接改 raw 的，patchConfig 会另读一份文件 —— 所以先落盘
      if (poolChanged || body.resetPools === true) {
        fs.writeFileSync(CFG_FILE, JSON.stringify(raw, null, 2) + '\n', 'utf8');
      }

      json(res, { ok: true, applied, view: configView(false) });
      return;
    }

    // 机器人靠这个端点确认「控制台真的在线」。
    // 不能只判断端口有没有人监听 —— 端口上可能是别的程序。
    // 所以带一个应用标记，机器人必须对得上才算数（见 src/console-guard.js）。
    if (req.method === 'GET' && url.pathname === '/api/ping') {
      // root 也报出去：这个端点是"你是我要找的那个控制台吗"的唯一凭据，
      // 而**光有 app 标记不够** —— 机器上可能同时跑着另一个副本的控制台
      //（实测：导出发布包之后，包里的测试连的还是主项目的控制台，
      //  于是它读到的配置和自己写的那份不是同一份，红得莫名其妙且难查）。
      // 带上 root，调用方就能判断"这个控制台服务的是不是我这份代码"。
      json(res, {
        ok: true,
        app: 'qq-bot-console',
        pid: process.pid,
        port: PORT,
        root: ROOT,
        botRunning: botRunning(),
        console: consoleFreshness(),
      });
      return;
    }

    // 检测一个厂商到底能不能**真的用来聊天**。
    //
    // 不能只查 /models：实测用户的 llama.cpp 服务 /v1/models 不要 key、
    // /v1/chat/completions 要 key，于是探测报"通了"，机器人却一句话都没回过。
    // 所以 probeProvider 会真的发一条最小消息，并以它的结果为准。
    if (req.method === 'POST' && url.pathname === '/api/llm/probe') {
      const body = await readBody(req);
      const cfg = readConfigRaw();
      const provider = String(body?.provider ?? cfg.llm?.provider ?? 'deepseek');
      const p = cfg.llm?.providers?.[provider] ?? {};

      // 地址/key/model 优先用页面上当前填的（用户可能刚改还没保存）
      const baseUrl = String(body?.baseUrl ?? p.baseUrl ?? cfg.llm?.baseUrl ?? '').trim();
      const model = String(body?.model ?? p.model ?? '').trim();
      let apiKey = String(body?.apiKey ?? '').trim();
      if (!apiKey) {
        const envName = p.apiKeyEnv || `${provider.toUpperCase()}_API_KEY`;
        apiKey = String(p.apiKey ?? '').trim() || readEnvMap()[envName] || process.env[envName] || '';
      }

      const r = await probeProvider({
        baseUrl,
        apiKey,
        model,
        requiresKey: p.requiresKey !== false,
        timeoutMs: Number(cfg.llm?.timeoutMs) > 0 ? Number(cfg.llm.timeoutMs) : 30000,
      });

      pushLog(`[控制台] 检测 ${provider} ${baseUrl} → ${r.ok ? `通了（${r.chat.ms}ms，回复=${JSON.stringify(r.chat.content)}）` : `失败：${r.chat.reason ?? ''} ${r.chat.detail ?? ''}`}`, 'sys');
      json(res, {
        ok: r.ok,
        provider,
        baseUrl,
        model: model || (r.models[0] ?? ''),
        models: r.models,
        chat: { ok: r.chat.ok, reason: r.chat.reason ?? null, detail: r.chat.detail ?? null, ms: r.chat.ms ?? null, sample: r.chat.content ?? null },
        hints: r.hints,
        needsKey: r.needsKey,
        usedKey: apiKey ? '有' : '没有',
      });
      return;
    }

    // 空跑一次轮询的目标计算：告诉用户"会轮哪几个"，但**一次都不点**。
    //
    // 为什么要它：轮询会动鼠标，用户在按下开关之前必须能先看到后果。
    // 只读会话列表（GetLastInputInfo / UIA 读取都是只读的），不碰 qq-click.ps1。
    if (req.method === 'POST' && url.pathname === '/api/poll/list') {
      const body = await readBody(req);
      const cfgP = readConfigRaw();
      const tmp = {
        ...cfgP,
        trigger: { ...(cfgP.trigger ?? {}), whitelist: Array.isArray(body?.whitelist) ? body.whitelist : cfgP.trigger?.whitelist },
        autoSwitch: {
          ...(cfgP.autoSwitch ?? {}),
          scope: String(body?.scope ?? '').trim() || cfgP.autoSwitch?.scope,
          conversations: Array.isArray(body?.conversations) ? body.conversations : cfgP.autoSwitch?.conversations,
        },
      };
      const read = await readSessions({ timeoutMs: 30000 });
      if (!read.ok) { json(res, { ok: false, error: read.error }); return; }
      const targets = targetConversations(tmp, read.sessions);
      json(res, {
        ok: true,
        scope: autoScopeOf(tmp),
        targets,
        sessionCount: read.sessions.length,
        sessions: read.sessions.map((s) => s.name),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/memory') {
      json(res, memoryView(url.searchParams.get('conversation') || ''));
      return;
    }

    // 试打一句：这句话会被哪条规则/哪个意图接走。
    //
    // ⚠ 规则用**页面上当前编辑着的**那一份（body.rules），不是磁盘上的 ——
    //   否则用户"加一条规则 → 点试一下"会看到旧结果，然后以为规则不生效。
    //   这是这个项目里反复出现的一类坑：界面显示的和实际跑的不是同一个东西。
    if (req.method === 'POST' && url.pathname === '/api/fallback/preview') {
      const body = await readBody(req);
      const cfgP = readConfigRaw();
      const rules = Array.isArray(body?.rules)
        ? body.rules.map((r) => ({
          match: String(r?.match ?? ''),
          replies: (Array.isArray(r?.replies) ? r.replies : []).map((s) => String(s)),
        })).filter((r) => r.match.trim() && r.replies.length)
        : (cfgP.fallback?.rules ?? []);

      const tmp = {
        ...cfgP,
        fallback: {
          ...(cfgP.fallback ?? {}),
          rules,
          customRulesFirst: body?.customRulesFirst !== undefined
            ? body.customRulesFirst === true
            : cfgP.fallback?.customRulesFirst === true,
        },
      };
      json(res, previewFallback(tmp, { text: String(body?.text ?? ''), sender: String(body?.sender ?? '') }));
      return;
    }

    // 人生模拟那一组：看状态 + 改开关 / 换人生。
    //
    // 为什么单独一个接口而不是走 /api/config：这两个开关和"当前是谁的人生"
    // 存在 state.json 里（机器人每轮现读），改 config 得重启才生效。
    // 用户点开关的期望是"立刻生效"，所以它们不是一个"配置项"。
    // ---- 人设：可切换的身份（提示词 + 它的人生 + 它的记忆）----
    //
    // 为什么是独立接口而不是走 /api/config：切换要**立刻生效**，
    // 所以它跟「人生」「接管开关」一样存在 state.json 里（机器人每轮现读），
    // 而不是写进 config.json（那个只有重启才生效）。
    if (req.method === 'GET' && url.pathname === '/api/personas') {
      json(res, personasView());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/personas') {
      const body = await readBody(req);
      const cfgP = cfgForMemory();

      // 从 config.json 里那份提示词播种（第一次用「人设」时的手工入口）
      if (body?.seedFromConfig) {
        const r = seedFromConfig(cfgP, ROOT, { life: activeProfile(cfgP, readState()) });
        if (!r.ok) { json(res, { ok: false, error: r.error }); return; }
        pushLog(`[控制台] 从 config.json 建了一份人设「${r.name}」`, 'sys');
        json(res, { ok: true, view: personasView() });
        return;
      }

      // 新建一份人设，并**直接切过去** —— 建而不切的话用户还得再点一次，
      // 而且新身份到底长什么样看不出来。
      //
      // 勾了"复制当前这份当起点" = **克隆整个身份**：提示词 + 记忆（从当前人设那份拷）。
      // 不勾 = 新身份从空白开始：提示词给一行占位、记忆和人生都是空的。
      // （这是"新开一个身份"和"把当前这个复制一份"的区别，界面上写清楚。）
      if (body?.create) {
        const st = readState();
        const cur = activePersonaName(cfgP, st);
        const want = String(body.create).trim();
        const first = listPersonas(cfgP, ROOT).length === 0;
        const clone = body.seed === true && Boolean(cur);

        // 三种情况，提示词来源不同：
        //   1. 克隆当前人设      → 抄它的提示词 + 记忆 + 人生
        //   2. **第一个人设**    → 从 config.json 那份提示词播种（那才是用户本来在用的）
        //      ⚠ 这里踩过：第一份人设写成了占位符，而它一建就立刻生效 ——
        //        等于把用户的人设换成了「（在这里写……）」，机器人下一句就变味了。
        //   3. 之后的新人设      → 占位符，等用户自己写
        const cfgPrompt = Array.isArray(cfgP?.persona?.systemPrompt) ? cfgP.persona.systemPrompt : [];
        const hasCfgPrompt = cfgPrompt.join('').trim() !== '';

        const r = clone
          ? copyPersona(cfgP, ROOT, cur, want)
          : savePersona(cfgP, ROOT, want, {
            systemPrompt: (first && hasCfgPrompt) ? cfgPrompt : [PLACEHOLDER_PROMPT],
            // 人生：克隆时先跟随源人设，下面会把那份人生**拷**成它自己的；
            // 其余情况用自己的名字（一人一生）。
            life: clone ? String(loadPersona(cfgP, ROOT, cur)?.life ?? cur) : want,
          });
        if (!r.ok) { json(res, { ok: false, error: r.error }); return; }

        // 克隆：把源人设的**人生文件**也拷一份成它自己的。
        // 不拷的话两份人设会共用同一个生活日志（各自的经历交叉写进同一份文件），
        // 那不是"克隆"，是"两个人共用一个大脑"。
        let lifeCopied = null;
        if (clone) {
          const srcLife = String(loadPersona(cfgP, ROOT, cur)?.life ?? cur);
          const cp = createLifeProfile(cfgP, ROOT, want, { seedFrom: srcLife });
          lifeCopied = cp.ok ? want : null;
          if (cp.ok) savePersona(cfgP, ROOT, want, { life: want });
        }

        const plan = planSwitch(cfgP, ROOT, want);
        if (!plan.ok) { json(res, { ok: false, error: plan.error }); return; }
        const seeded = applyPersonaSwitch(cfgP, plan, clone ? { memoryFrom: cur } : {});
        pushLog(`[控制台] 新建并切到人设「${want}」`
          + `${clone ? `（克隆自「${cur}」：提示词 + 记忆 + 人生）`
            : (first && hasCfgPrompt ? '（提示词从 config.json 搬来）' : '（新身份，提示词待写）')}`
          + `　它的人生：${plan.patch.lifeProfile}`, 'sys');
        json(res, { ok: true, view: personasView(), seeded, lifeCopied });
        return;
      }

      // 切换
      if (body?.switch) {
        const plan = planSwitch(cfgP, ROOT, body.switch);
        if (!plan.ok) { json(res, { ok: false, error: plan.error }); return; }
        const seeded = applyPersonaSwitch(cfgP, plan);
        pushLog(`[控制台] 切到人设「${plan.persona.name}」　人生：${plan.patch.lifeProfile}`
          + (seeded.copied?.length
            ? `　（第一次用它的记忆，已把原来的 ${seeded.copied.length} 份拷进 memory/${plan.persona.name}/）`
            : ''), 'sys');
        json(res, { ok: true, view: personasView(), seeded });
        return;
      }

      // 改提示词（写人设文件 → 下一次生成就用新的，不用重启）
      if (body?.savePrompt) {
        const name = String(body.name ?? '').trim() || activePersonaName(cfgP, readState());
        if (!name) { json(res, { ok: false, error: '现在没有当前人设，先建一份' }); return; }
        const lines = Array.isArray(body.savePrompt) ? body.savePrompt : String(body.savePrompt).split(/\r?\n/);
        const clean = lines.map((s) => String(s ?? ''));
        if (clean.join('').trim() === '') {
          json(res, { ok: false, error: '提示词不能为空 —— 空的会让 API 报错（接管时会静默降级成本地规则）' });
          return;
        }
        const r = savePersona(cfgP, ROOT, name, { systemPrompt: clean });
        if (!r.ok) { json(res, { ok: false, error: r.error }); return; }
        pushLog(`[控制台] 人设「${name}」的提示词已更新（${clean.length} 行，立即生效、不用重启）`, 'sys');
        json(res, { ok: true, view: personasView() });
        return;
      }

      // 删掉一份人设（**不动**它的记忆和人生，见 persona.js 的注释）
      if (body?.remove) {
        const r = deletePersona(cfgP, ROOT, body.remove);
        if (!r.ok) { json(res, { ok: false, error: r.error }); return; }
        const st = readState();
        if (activePersonaName(cfgP, st) === String(body.remove).trim()) writeLifeRuntime({ personaProfile: '' });
        pushLog(`[控制台] 删掉人设「${body.remove}」（它的记忆和人生还在磁盘上，没跟着删）`, 'sys');
        json(res, { ok: true, view: personasView() });
        return;
      }

      json(res, { ok: false, error: '没给要做什么（switch / create / savePrompt / remove / seedFromConfig）' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/life') {
      json(res, lifeView(cfgForMemory()));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/life') {
      const body = await readBody(req);
      const cfgL = cfgForMemory();

      // 新建一份人生（可选把当前这份抄过去当起点）
      if (body?.createLife) {
        const seed = body.seed === true ? (body.seedFrom !== undefined ? body.seedFrom : activeProfile(cfgL, readState())) : undefined;
        const r = createLifeProfile(cfgL, ROOT, String(body.createLife), { seedFrom: seed });
        if (!r.ok) { json(res, { ok: false, error: r.error }); return; }
        writeLifeRuntime({ lifeProfile: r.profile });
        pushLog(`[控制台] 新建了一份人生：「${r.profile}」（${r.total} 条${seed !== undefined ? '，从上一份抄来' : ''}）`, 'sys');
        json(res, lifeView(cfgForMemory()));
        return;
      }

      const patch = {};
      for (const k of ['lifeEnabled', 'shareEnabled', 'lifeProfile']) {
        if (body?.[k] !== undefined) patch[k] = body[k];
      }
      if (Object.keys(patch).length === 0) {
        json(res, { ok: false, error: '没给要改的东西（lifeEnabled / shareEnabled / lifeProfile）' });
        return;
      }

      // 切到一个不存在的人生就直接拒绝 —— 静默建空文件会让用户以为"人生丢了"
      if (typeof patch.lifeProfile === 'string' && patch.lifeProfile.trim()) {
        const want = patch.lifeProfile.trim();
        const has = listLives(cfgL, ROOT).some((x) => x.profile === want);
        if (!has) {
          json(res, { ok: false, error: `没有叫「${want}」的人生。要新建就用「新建人生」。` });
          return;
        }
      }

      writeLifeRuntime(patch);
      if (patch.lifeEnabled !== undefined) pushLog(`[控制台] 人生模拟 → ${patch.lifeEnabled ? '开' : '关'}`, 'sys');
      if (patch.shareEnabled !== undefined) pushLog(`[控制台] 主动分享 → ${patch.shareEnabled ? '开' : '关'}`, 'sys');
      if (patch.lifeProfile !== undefined) pushLog(`[控制台] 切换人生 → ${patch.lifeProfile || '（默认那份）'}`, 'sys');
      json(res, lifeView(cfgForMemory()));
      return;
    }

    // 清空记忆。scope='global' 只清总记忆；scope='conversation' 只清指定会话那一份。
    // 必须分开 —— 总记忆里是"我是谁、喜欢什么"，跟某个会话的经历不是一回事，
    // 一键全清会顺手把不该丢的也丢了。
    if (req.method === 'POST' && url.pathname === '/api/memory/clear') {
      const body = await readBody(req);
      const cfgM = cfgForMemory();
      const scopeRaw = String(body?.scope ?? 'conversation');
      const scope = scopeRaw === 'global' ? 'global' : (scopeRaw === 'life' ? 'life' : 'conversation');
      const conv = String(body?.conversation ?? '');

      // 生活日志单独一个 scope：它是「人生模拟」的产物，
      // 和"记下来的事实"不是一回事 —— 想让它重新开始过日子时清这个就行，
      // 不用把记忆一起清掉。
      if (scope === 'life') {
        // 清的只是**当前这份人生**（不是所有人的人生）—— 切到别人那份去清，
        // 就能单独清那一个。别在这里一把全清：那是别人积累的时间线。
        const prof = activeProfile(cfgM, readState());
        const w = saveLifeLog(cfgM, ROOT, emptyLifeLog(prof), prof);
        if (!w.ok) { json(res, { ok: false, error: w.error }); return; }
        pushLog(`[控制台] 生活日志已清空（${prof || '默认那份'}）`, 'sys');
        json(res, memoryView(''));
        return;
      }

      let w;
      if (scope === 'global') {
        w = saveGlobal(cfgM, emptyGlobal(), ROOT);
        pushLog('[控制台] 总记忆已清空', 'sys');
      } else {
        if (!conv) { json(res, { ok: false, error: '没指定要清哪个会话' }); return; }
        w = saveConversation(cfgM, emptyConversation(conv), ROOT, conv);
        pushLog(`[控制台] 「${conv}」的会话记忆已清空`, 'sys');
      }
      json(res, w.ok ? memoryView(scope === 'conversation' ? conv : '') : { ok: false, error: w.error });
      return;
    }

    // 删掉一个会话的记忆文件 —— 这一条从列表里**彻底消失**。
    //
    // 为什么「清空」和「删除」要分成两个动作（用户报的原话：
    // 「要能删除会话，现在清空记忆后无法删除会话」）：
    //   清空 = 把内容抹掉，但这个会话**还在列表里**（留个空壳，看得见"我清过它"）
    //   删除 = 连文件一起删掉，列表里不再有它
    // 之前只有清空，于是清完那个条目还杵在那儿，点不掉、也没别的地方能删。
    //
    // ⚠ 安全：请求里带来的名字**不能直接拼路径**。删除不可逆，这一层必须自己守：
    //   只认"服务端自己刚列出来的那些文件"（listConversations 的结果），
    //   再取 basename 拼路径并确认它确实落在记忆目录里 ——
    //   否则一个 `../../config.json` 就能把配置删了。
    if (req.method === 'POST' && url.pathname === '/api/memory/delete') {
      const body = await readBody(req);
      const cfgM = cfgForMemory();
      const wantConv = String(body?.conversation ?? '').trim();
      const wantFile = String(body?.file ?? '').trim();
      if (!wantConv && !wantFile) { json(res, { ok: false, error: '没说删哪个会话' }); return; }

      const list = listConversations(cfgM, ROOT);
      const hit = list.find((c) => (wantFile && c.file === wantFile)
        || (wantConv && c.conversation === wantConv));
      if (!hit) {
        json(res, { ok: false, error: '列表里没有这个会话（可能已经删掉了，刷新一下看看）' });
        return;
      }

      const who = activePersonaOf(ROOT);
      const dir = path.resolve(who ? personaMemoryDirOf(cfgM, ROOT, who) : memoryDir(cfgM, ROOT));
      const file = path.resolve(dir, path.basename(hit.file));   // basename：再挡一次路径穿越
      if (!file.startsWith(dir + path.sep)) {
        json(res, { ok: false, error: '这个路径不在记忆目录里，拒绝删除' });
        return;
      }
      try {
        // ⚠ unlinkSync，不是 rmSync：rmSync 在 Z: 盘上是**静默无效**的（不抛错也不删）
        fs.unlinkSync(file);
      } catch (e) {
        json(res, { ok: false, error: `删除失败：${e?.message ?? e}` });
        return;
      }
      const label = hit.conversation || hit.file;
      pushLog(`[控制台] 已删除「${label}」的会话记忆（${path.relative(ROOT, file)}）`, 'sys');
      json(res, memoryView(''));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/takeover') {
      const body = await readBody(req);
      const on = writeTakeover(body.on);
      json(res, { ok: true, takeoverEnabled: on });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/bot/start') {
      const body = await readBody(req);
      json(res, startBot(Array.isArray(body.args) ? body.args : []));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/bot/stop') {
      json(res, stopBot());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/logs') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ logs, running: botRunning() }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ t: Date.now(), line: '[控制台] 已连接日志流', kind: 'sys' })}\n\n`);
      sseClients.add(res);
      // 心跳，防止中间层掐断空闲连接
      const hb = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* 下面清理 */ }
      }, 20000);
      req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (err) {
    pushLog(`[控制台] 请求出错: ${err.message}`, 'err');
    json(res, { ok: false, error: err.message }, 500);
  }
});

// 控制台退出时顺手把机器人停掉，避免留下孤儿进程
function shutdown() {
  if (botRunning()) {
    try { child.kill('SIGTERM'); } catch { /* 忽略 */ }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  if (botRunning()) { try { child.kill('SIGTERM'); } catch { /* 忽略 */ } }
});

/**
 * 打开浏览器。
 * 用 cmd 的 start，让系统选默认浏览器。空字符串是 start 的窗口标题占位。
 */
function openBrowser(url) {
  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch (e) {
    pushLog(`[控制台] 打开浏览器失败（请手动访问）: ${e.message}`, 'err');
    return false;
  }
}

const shouldOpen = process.argv.includes('--open') || process.env.GUI_OPEN === '1';

/**
 * 端口被占用时的处理。
 *
 * 这是双击打不开的根因（实测）：
 *   控制台已经在跑，用户又双击了一次 .cmd
 *   → node 想再起一个实例 → EADDRINUSE → 崩掉
 *   → 浏览器那一刻打开，撞上崩溃或空窗，看起来就是"打不开"
 *
 * 正确行为：识别出"已经有一个控制台在跑"，直接打开浏览器指向它，然后正常退出。
 * 这样双击是**幂等**的 —— 点几次都能到达一个能用的界面。
 */
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const url = `http://127.0.0.1:${PORT}`;
    console.log('');
    console.log(`  A console is already running on port ${PORT}.`);
    console.log('  已有控制台在运行，直接打开它。');
    console.log(`  ${url}`);
    console.log('  (Do not start a second one. Close the previous window to stop it.)');
    console.log('');
    if (shouldOpen) openBrowser(url);
    process.exit(0);
  }
  console.error(`[控制台] 启动失败: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  pushLog(`[控制台] 已启动: ${url}`, 'sys');

  // 控制台里的输出只用 ASCII。
  // 原因：.cmd 启动器是 ASCII 的（cmd 按 GBK 读批处理，中文会乱），
  // 如果这里再打中文，同一个窗口里就是英文标题 + 中文正文，看着别扭，
  // 而且在非 UTF-8 代码页下还可能显示成乱码。日志文件里仍是中文。
  console.log('');
  console.log(`  Console ready: ${url}`);
  console.log('  Press Ctrl+C to stop (this also stops the bot).');
  console.log('');

  // 监听成功后再开浏览器。
  // 之前是 .cmd 里先开浏览器再起服务，服务要一两秒才就绪，
  // 浏览器可能先看到「无法连接」—— 这个竞态在这里消除掉。
  if (shouldOpen) {
    if (openBrowser(url)) pushLog('[控制台] 已请求打开浏览器', 'sys');
  } else {
    console.log(`  Open this in your browser: ${url}`);
  }
});
