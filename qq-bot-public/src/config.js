/**
 * config.js — 载入 config.json，叠加环境变量与命令行开关。
 *
 * 关键行为：
 *  - whitelist 为空时，trigger 层会拒绝一切回复（安全默认）。
 *  - apiKey 留空时读 config.llm.apiKeyEnv 指定的环境变量。
 *  - 命令行开关（--watch/--once/--send/--dry/--yes）优先级最高。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function deepMerge(base, over) {
  if (over === undefined || over === null) return base;
  if (Array.isArray(over)) return over;
  if (typeof over !== 'object') return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? deepMerge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

/** 去掉所有 $comment 键，避免污染后续逻辑。 */
function stripComments(v) {
  if (Array.isArray(v)) return v.map(stripComments);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === '$comment') continue;
      out[k] = stripComments(val);
    }
    return out;
  }
  return v;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = { watch: false, once: false, send: false, dry: false, yes: false, verbose: false, json: false, allowNoConsole: false };
  for (const a of argv) {
    switch (a) {
      case '--watch': flags.watch = true; break;
      case '--once': flags.once = true; break;
      case '--send': flags.send = true; break;
      case '--dry': flags.dry = true; break;
      case '--yes': flags.yes = true; break;
      case '--verbose': case '-v': flags.verbose = true; break;
      case '--json': flags.json = true; break;
      // 显式放行「不带控制台也跑」。默认**不允许** —— 见 console-guard.js。
      // 只有调试/自动化测试才该用它，所以名字写得难听一点，避免被顺手加上。
      case '--allow-no-console': flags.allowNoConsole = true; break;
      default: break;
    }
  }
  return flags;
}

/**
 * 载入项目根目录的 .env（简单的 KEY=VALUE）。
 *
 * 为什么需要：API key 起初是从 DSH 的凭据目录读的
 * （%APPDATA%\dsh-desktop\harness\.credentials.yaml）。
 * 那样 DSH 一卸载、或被清掉配置，机器人就退回本地规则、回复质量掉一大截。
 * 把 key 放进项目自己的 .env，机器人就**完全独立**，不依赖 DSH 是否安装。
 *
 * 格式：KEY=VALUE，支持 # 注释、可选的引号、export 前缀。
 * 不覆盖已存在的环境变量（环境变量优先）。
 */
export function loadEnvFile(file) {
  if (!fs.existsSync(file)) return { loaded: false, keys: [] };
  const keys = [];
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const name = m[1];
      let value = m[2].trim();
      // 去掉成对引号
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!value) continue;
      if (process.env[name] === undefined) {
        process.env[name] = value;
        keys.push(name);
      }
    }
  } catch {
    return { loaded: false, keys: [] };
  }
  return { loaded: true, keys };
}

/**
 * 多厂商解析：把 llm.provider 指定的那家提升成 cfg.llm。
 *
 * 抽成纯函数（不读文件）是为了能直接测试 —— 之前这段藏在 loadConfig 里，
 * 只能靠写临时配置文件来测，很容易写出假测试。
 *
 * @param {object} cfg 已经 stripComments 过的配置
 * @param {object} env 环境变量（默认 process.env，可注入便于测试）
 */
export function resolveProvider(cfg, env = process.env, envFileKeys = []) {
  const providers = cfg.llm?.providers ?? {};
  const activeName = cfg.llm?.provider ?? 'deepseek';
  const active = providers[activeName] ?? {};

  // key 优先级：provider.apiKey（写在配置里）> provider.apiKeyEnv 指定的环境变量
  //             > 顶层的 apiKey / apiKeyEnv（兼容单厂商的老配置）
  const envName = active.apiKeyEnv || cfg.llm?.apiKeyEnv || `${String(activeName).toUpperCase()}_API_KEY`;
  const envKey = env[envName] || '';
  const fileKey = String(active.apiKey ?? cfg.llm?.apiKey ?? '').trim();
  const key = fileKey || envKey;

  // 标注来源时区分「系统环境变量」和「项目 .env」：两者都进了 process.env，
  // 但对排错来说差别很大（.env 是自己配的，环境变量可能是别处注入的）。
  let source = 'none';
  if (fileKey) source = `config.json(${activeName})`;
  else if (envKey && envFileKeys.includes(envName)) source = `.env:${envName}`;
  else if (envKey) source = `env:${envName}`;

  // 这家厂商**要不要** key。
  //
  // 本地推理服务（Ollama / LM Studio / llama.cpp / vLLM …）通常不校验 key，
  // 但它们的接口是 OpenAI 兼容的，看起来跟云端一模一样。
  // 以前这里一刀切要求 key，于是"接本地 API"会直接以 no-key 失败 ——
  // 而报错信息（"缺少 API key"）完全指不到真正的原因上。
  //
  // 所以由配置说了算：provider.requiresKey === false 就允许没有 key。
  // 默认仍是 true（云端必须配 key，不能因为漏配就静默跑不通）。
  const requiresKey = active.requiresKey !== false;

  return {
    ...cfg.llm,
    providerName: activeName,
    providerList: Object.keys(providers),
    baseUrl: active.baseUrl ?? cfg.llm?.baseUrl,
    model: active.model ?? cfg.llm?.model,
    // 超时也允许**按厂商**设：云端 20 秒够了，本地 CPU 推理动辄十几秒到一分钟，
    // 用同一个值必然有一边不合适（实测本地跑一条简单消息就要 13~19 秒，
    // 而记忆整理那次直接 15 秒超时 —— 记忆于是永远不更新，还看不出原因）。
    timeoutMs: Number(active.timeoutMs) > 0 ? Number(active.timeoutMs) : (cfg.llm?.timeoutMs ?? 20000),
    apiKeyEnv: envName,
    apiKey: key,
    apiKeySet: key.length > 0,
    apiKeySource: source,
    apiKeyRequired: requiresKey,
    // 这家支不支持 response_format=json_object（整理记忆时用）。
    //
    // 实测：llama.cpp 的 JSON 语法模式 + 推理模型 = 直接 502
    //   structured_output_failed（结构化输出没完成，finish_reason=length）。
    //   关掉之后同一个模型就正常吐 JSON 了（parseJsonLoose 本来就容错）。
    // 所以给厂商一个开关，本地遇到就关，云端照旧开着。
    jsonMode: active.jsonMode !== false,
    // 这家要不要关掉“思考模式”（Qwen3 等推理模型）。
    // 默认 undefined = 不干预厂商默认行为；设 false 才发
    // chat_template_kwargs.enable_thinking=false。见 llm.js 里的说明。
    enableThinking: active.enableThinking,
    // 「这家不需要 key」和「需要但没配」在界面上要分得开，否则用户看到
    // "未配置"会以为坏了，而其实本地服务本来就不用配。
    needsKeyConfig: requiresKey && key.length === 0,
  };
}

export function loadConfig({ argv } = {}) {
  const flags = parseArgs(argv);

  // 先读 .env 注入环境变量，这样 key 不依赖 DSH 是否安装
  const envResult = loadEnvFile(path.join(ROOT, '.env'));

  const file = path.join(ROOT, 'config.json');

  let raw = {};
  if (fs.existsSync(file)) {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  // 本地覆盖文件（不进版本库）
  const localFile = path.join(ROOT, 'config.local.json');
  if (fs.existsSync(localFile)) {
    raw = deepMerge(raw, JSON.parse(fs.readFileSync(localFile, 'utf8')));
  }

  const cfg = stripComments(raw);

  // 多厂商：把选中的 provider 提升成 cfg.llm
  cfg.llm = resolveProvider(cfg, process.env, envResult.keys);
  cfg.envFile = envResult;

  // 命令行开关
  if (flags.dry) cfg.reply = { ...cfg.reply, dryRun: true };
  if (flags.send) cfg.reply = { ...cfg.reply, dryRun: false };
  cfg.cli = flags;
  cfg.root = ROOT;

  return cfg;
}

/** 只要「当前生效的配置」这种轻量读取，用于不关心 CLI 开关的场景。 */
export function loadLite() {
  return loadConfig({ argv: [] });
}

/** 白名单匹配：空数组视为「什么都不回」。 */
export function isWhitelisted(cfg, conversationName) {
  const list = cfg.trigger?.whitelist ?? [];
  if (list.length === 0) return false;
  const name = String(conversationName ?? '');
  return list.some((w) => w && name.includes(w));
}

export function isBlacklisted(cfg, conversationName) {
  const list = cfg.trigger?.blacklist ?? [];
  const name = String(conversationName ?? '');
  return list.some((w) => w && name.includes(w));
}

/**
 * 「回复范围」的两种模式。
 *
 *   whitelist（默认）—— **只回白名单里的会话**。白名单为空 = 谁也不回（安全默认）。
 *   all            —— **所有会话都回**，白名单完全不参与判定。
 *
 * 以前没有这个开关，只能靠"白名单填没填"隐式表达"要不要限制范围"，
 * 于是「让它在别的群也能用」这个动作变成了"把白名单删掉" ——
 * 而删掉的效果恰好是相反的（谁也不回）。做成显式模式就不会再误解。
 */
export const REPLY_SCOPES = ['whitelist', 'all'];

/** 当前生效的回复范围模式。认不出来的值一律回退成 whitelist（安全的那一侧）。 */
export function replyScopeOf(cfg) {
  const v = String(cfg?.trigger?.replyScope ?? '').trim().toLowerCase();
  return REPLY_SCOPES.includes(v) ? v : 'whitelist';
}

/**
 * 会话级总闸门：这个会话该不该回。
 *
 * 黑名单在**两种模式下都生效** —— 它是一条明确的「别回这个」，
 * 不该被"回复所有对话"绕过去，否则"所有"就真的是所有了。
 *
 * 返回对象而不是布尔值，是为了让调用方能给出**精确**的拒绝原因。
 * 这里踩过：原来只有一句「会话不在白名单（或命中黑名单）」，
 * 白名单为空、名字拼错、命中黑名单三种情况长得一模一样，
 * 排查时只能靠猜。
 *
 * @returns {{ok:boolean, why:string, mode:'whitelist'|'all'}}
 *   why: ok | all | whitelist | not-in-whitelist | whitelist-empty | blacklist
 */
export function isReplyTarget(cfg, conversationName) {
  const mode = replyScopeOf(cfg);
  if (isBlacklisted(cfg, conversationName)) return { ok: false, why: 'blacklist', mode };
  if (mode === 'all') return { ok: true, why: 'all', mode };
  if (isWhitelisted(cfg, conversationName)) return { ok: true, why: 'whitelist', mode };
  const empty = (cfg?.trigger?.whitelist ?? []).length === 0;
  return { ok: false, why: empty ? 'whitelist-empty' : 'not-in-whitelist', mode };
}

/** 拒绝原因给人看的中文。集中在这里，免得日志和界面各写一套。 */
export const REPLY_REJECT_TEXT = {
  'blacklist': '会话命中黑名单',
  'whitelist-empty': '回复范围是「仅白名单」，但白名单是空的 → 谁也不回',
  'not-in-whitelist': '会话不在白名单里（回复范围=仅白名单）',
};
