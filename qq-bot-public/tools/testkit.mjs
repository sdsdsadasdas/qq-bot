/**
 * testkit.mjs — 测试用的临时工程沙盒。
 *
 * 为什么需要：
 *   一批测试（回复池、优先级、规则）会读写 config.json。
 *   而用户会真的去改那个文件（实测：他自己往 fallback.pools.generic 里
 *   加了「示例自定义句」「示例自定义句，等下」「⊙▽⊙」）。
 *   于是那些测试**撞上用户的配置就失败** —— 测试不该依赖用户状态。
 *
 * 做法：把 src/ 复制到临时目录，写入一份我们掌控的 config.json，
 *       然后在那个沙盒里跑断言。用户的项目文件只读不写。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 建一个沙盒：复制 src/，写入给定配置，返回可导入的模块地址。
 *
 * @param {object} opts.config         写进沙盒 config.json 的内容
 * @param {boolean} opts.copyRealConfig 是否以真实 config.json 为基底（默认 false，用最小配置）
 */
export function makeSandbox({ config = {}, copyRealConfig = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-test-'));

  // 复制源码（测试直接 import 这些路径）
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  for (const f of fs.readdirSync(path.join(REAL_ROOT, 'src'))) {
    fs.copyFileSync(path.join(REAL_ROOT, 'src', f), path.join(srcDir, f));
  }

  // 配置基底
  let base;
  if (copyRealConfig) {
    base = JSON.parse(fs.readFileSync(path.join(REAL_ROOT, 'config.json'), 'utf8'));
  } else {
    base = {
      readSource: 'uia',
      process: { name: 'QQ' },
      geometry: {},
      trigger: { whitelist: [], replyProbability: 1, mentionAlwaysReplies: true },
      reply: { dryRun: true },
      llm: {
        enabled: true,
        provider: 'deepseek',
        timeoutMs: 20000,
        maxTokens: 300,
        temperature: 1,
        contextMessages: 16,
        historyBuffer: 60,
        systemPrompt: '测试用系统提示词',
        providers: {
          deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKeyEnv: 'DEEPSEEK_API_KEY' },
        },
      },
      persona: {
        enabled: false,
        takeoverPatterns: ['你接管'],
        releasePatterns: ['你下班'],
        systemPrompt: ['测试用人设'],
        fallbackGeneric: [],
      },
      fallback: { enabled: true, defaultReply: '兜底', rules: [], generic: [] },
      ocr: { lang: 'zh-Hans-CN' },
      watch: {},
      log: { dir: 'logs', level: 'error' },
    };
  }

  const merged = { ...base, ...config };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(merged, null, 2), 'utf8');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });

  return {
    dir,
    configPath: path.join(dir, 'config.json'),
    /** 动态导入沙盒里的模块（走 file URL，绕开路径解析问题） */
    async load(rel) {
      const abs = path.join(dir, rel);
      return import(pathToFileURL(abs).href + `?t=${Date.now()}`);
    },
    readConfig() {
      return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    },
    writeConfig(cfg) {
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
    },
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    },
  };
}

/**
 * 这份 config.json 是不是"已经配好的"？
 *
 * 用途：有些断言是**拿真实配置交叉验证**的 —— 「白名单命中吗」「@自己的消息认得出来吗」
 * 「人生模拟开着吗」。这些在人自己机器上很有价值（它们能抓到"我改的配置没生效"），
 * 但在一份**刚克隆下来、还没配**的副本上，它们必然失败 —— 而那不是坏了。
 *
 * 所以这类断言要先问一句：这份配置配过了吗？没配就 [SKIP]，
 * 别把"还没开始用"显示成"测试是红的"（第一次接触这个项目的人只会看到红的）。
 */
export function configLooksConfigured(cfg) {
  const names = (cfg?.trigger?.botNames ?? [])
    .map((n) => String(n ?? '').trim())
    .filter((n) => n && !/你的QQ昵称|示例昵称/.test(n));
  return names.length > 0;
}

/** 打印一句跳过（统一格式，便于 grep）。 */
export function skipNote(what) {
  console.log(`  [SKIP] ${what}（这份配置还没配好，跳过与真实配置的交叉验证）`);
}

export function makeChecker() {
  const state = { pass: 0, fail: 0 };
  return {
    state,
    check(name, cond, detail = '') {
      if (cond) { state.pass++; console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`); }
      else { state.fail++; console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`); }
    },
    done(title) {
      console.log('\n' + '='.repeat(70));
      console.log(`结果：通过 ${state.pass} / 失败 ${state.fail}`);
      console.log('='.repeat(70));
      process.exitCode = state.fail > 0 ? 1 : 0;
    },
  };
}

/**
 * 「这个测试要写用户的 config.json，但**必须还回去**」的护栏。
 *
 * 为什么需要它（真出过事，而且很隐蔽）：
 *   有几个测试要通过控制台的 /api/config 接口写真实配置（验证"空人设被拦住"
 *   "回复池只写改动过的那一项"这类行为），然后自己还原。
 *   原来的还原是**脚本最后一句** `fs.writeFileSync(CFG, original)`：
 *     · 中途抛异常（比如控制台刚好在重启，fetch 失败）
 *     · Ctrl+C / 进程被杀
 *   都会让还原**永远不执行** —— 用户的 config.json 里就永久留下了
 *   `persona.systemPrompt = ["【改过了】1791262384554","第二行"]`。
 *
 *   更坏的是它会"传染"：下一次再跑这个测试时，`original` 读到的就是这份坏了的内容，
 *   于是测试**照样全绿**，坏值却被当成基准一直留着。实测就是这样，
 *   直到另一个测试（人设长度、回复池键集合）莫名其妙地红了才发现。
 *
 * 所以护栏做三件事：
 *   1. 立刻把原文抓在手里（不是"最后再读"）
 *   2. finally / exit / SIGINT / SIGTERM / uncaughtException 都还原
 *   3. 如果**一开始读到的就是测试痕迹**，大声警告 —— 不能把坏值当基准
 *
 * @param {string} file config.json 的绝对路径
 * @returns {{restore:()=>void, dirty:boolean}}
 */
export function guardConfigFile(file) {
  const original = fs.readFileSync(file, 'utf8');
  let restored = false;

  const restore = () => {
    if (restored) return;
    restored = true;
    try { fs.writeFileSync(file, original, 'utf8'); } catch { /* 尽力而为 */ }
  };

  process.on('exit', restore);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { restore(); process.exit(sig === 'SIGINT' ? 130 : 143); });
  }
  process.on('uncaughtException', (err) => { restore(); console.error(err); process.exit(1); });

  // 一开始就是测试痕迹 → 说明上一次跑坏了，别把坏值当基准
  const marks = ['【改过了】', '【基准人设】', '测试甲', '测试乙', '测试丙'];
  const hit = marks.filter((m) => original.includes(m));
  if (hit.length > 0) {
    console.warn(`\n⚠ ${path.basename(file)} 里残留着测试痕迹 ${JSON.stringify(hit)}；`);
    console.warn('  这是上一次测试被打断留下的。本次会以它为基准还原 —— ');
    console.warn('  请从 config.json.bak-* 里恢复这个文件（这个警告本身就是要让你看到）。\n');
  }

  return { restore, dirty: hit.length > 0 };
}

/**
 * 「测试动过的文件，无论怎么结束都要还回去」的护栏 —— 通用版。
 *
 * 为什么需要（真出过事）：
 *   控制台那套测试要临时改 state.json、还要新建一份"测试人生"的文件。
 *   还原原本写在脚本最后一句，可只要断言里抛一个异常（比如读了个 undefined），
 *   进程就带着**改过的 state.json 和那个临时文件**退出了。
 *   实测后果：用户的 state.json 里 lifeProfile 永远指向一份已经被删掉的
 *   "控制台测试人生943717"，界面上看起来"人生没了"，而文件其实早删了。
 *
 * 行为：
 *   · 文件原来**存在** → 退出时按原字节写回
 *   · 文件原来**不存在**（测试新建的）→ 退出时删掉
 *   覆盖 exit / SIGINT / SIGTERM / SIGHUP / uncaughtException 五种结束方式。
 *
 * ⚠ 删除用 unlinkSync：fs.rmSync 在 Z: 盘上是**静默无效**的（踩过）。
 */
export function guardFile(file) {
  const existed = fs.existsSync(file);
  const original = existed ? fs.readFileSync(file) : null;
  let done = false;

  const restore = () => {
    if (done) return;
    done = true;
    try {
      if (existed) fs.writeFileSync(file, original);
      else if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch { /* 尽力而为 */ }
  };

  process.on('exit', restore);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { restore(); process.exit(sig === 'SIGINT' ? 130 : 143); });
  }
  process.on('uncaughtException', (err) => { restore(); console.error(err); process.exit(1); });

  return { restore, existed };
}

/**
 * 这个端口上的控制台，服务的是**我这份代码**吗？
 *
 * 为什么必须问：控制台的测试全都通过 HTTP 操作"真实 config.json"，
 * 而机器上可能跑着**另一个副本**的控制台（实测：导出发布包之后，
 * 包里的测试连的是主项目那个控制台 —— 它写自己那份 config，读到的却是别人的，
 * 于是红的莫名其妙，查半天）。
 * `/api/ping` 现在会报出 root，这里比对一下就知道该跑还是该跳过。
 *
 * @returns {Promise<{ok:boolean, reason:string, pid?:number}>}
 */
export async function consoleServes(root, port = 7788) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { ok: false, reason: `控制台返回 HTTP ${r.status}` };
    const j = await r.json();
    if (j?.app !== 'qq-bot-console') return { ok: false, reason: '端口上不是本项目的控制台' };
    const same = String(j.root ?? '').replace(/[\\/]+$/, '').toLowerCase()
      === String(root).replace(/[\\/]+$/, '').toLowerCase();
    if (!same) {
      return { ok: false, reason: `控制台服务的是另一个目录（${j.root}），不是这份代码`, pid: j.pid };
    }
    return { ok: true, reason: 'ok', pid: j.pid };
  } catch (e) {
    return { ok: false, reason: `控制台没在跑（${e?.message ?? e}）` };
  }
}

/** 控制台相关的一节跑不了时，统一打印这么一句。 */
export function skipConsole(what, reason) {
  console.log(`  [SKIP] ${what} —— ${reason}`);
}