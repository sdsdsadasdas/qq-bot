/**
 * console-guard.js — 「控制台没打开，就不许跑机器人」。
 *
 * 用户要求原话：「在控制台没打开的时候不要打开机器人」。
 *
 * 为什么这条值得单独做个模块：机器人是往**真群**里发消息的。
 * 没有控制台的时候，用户看不到它在干什么、也没法一键停 ——
 * 那是最糟的状态：它在替你说话，而你不知道它说了什么。
 * 所以这不是"顺手加个检查"，是一条安全约束。
 *
 * 三道防线：
 *   1. 启动时探测控制台；探不到就拒绝启动（不是警告一下就继续）
 *   2. 运行中持续探测；控制台没了就自己停（避免留下孤儿机器人）
 *   3. 命令行方式启动也被这条规则管住（start-bot.cmd 同样会被拒）
 *
 * 为什么探测的是 HTTP 而不是"端口有没有人监听"：
 *   端口上可能是**别的程序**（比如你恰好用 7788 跑了别的东西）。
 *   所以控制台暴露了 /api/ping，带一个应用标记，必须对得上才算数。
 *
 * 唯一放行的方式（都得显式写出来）：
 *   · 命令行加 --allow-no-console
 *   · 或 config.json 里 console.required = false
 */

/** 控制台 /api/ping 里的应用标记。两边必须一致。 */
export const CONSOLE_APP = 'qq-bot-console';

/**
 * 控制台端口。
 *
 * 优先级：环境变量 GUI_PORT > config.console.port > 7788。
 * GUI_PORT 优先是有原因的：控制台启动子进程时会把 process.env 传下去，
 * 而 .cmd 里设了 GUI_PORT —— 所以机器人拿到的就是**控制台实际绑定的那个端口**。
 * 用户改了端口也不会出现"控制台在 8899、机器人去敲 7788"这种错配。
 */
export function consolePort(cfg, env = process.env) {
  const fromEnv = Number(env?.GUI_PORT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  const fromCfg = Number(cfg?.console?.port);
  if (Number.isFinite(fromCfg) && fromCfg > 0) return Math.floor(fromCfg);
  return 7788;
}

/** 这次运行要不要强制要求控制台在线。 */
export function consoleRequired(cfg, cli = {}) {
  if (cli?.allowNoConsole === true) return false;
  return cfg?.console?.required !== false;
}

/**
 * 探测控制台。
 *
 * 绝不抛异常 —— 探测失败是**正常结果**（控制台本来就可能没开），
 * 不是错误。调用方按 reason 决定怎么办。
 *
 * @returns {Promise<{alive:boolean, reason:string, detail?:string}>}
 *   reason:
 *     ok                      探到了，而且确认是本项目的控制台
 *     not-running             端口没人监听（控制台没开）
 *     port-occupied-by-other  端口有东西，但不是本项目的控制台
 *     timeout                 超时（控制台卡住了）
 *     error                   其他网络错误
 */
export async function probeConsole(port, { timeoutMs = 1500, fetchImpl = globalThis.fetch } = {}) {
  const url = `http://127.0.0.1:${port}/api/ping`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) {
      return { alive: false, reason: 'port-occupied-by-other', detail: `HTTP ${res.status}` };
    }
    let data = null;
    try { data = await res.json(); } catch { /* 下面按 null 处理 */ }
    if (data?.app !== CONSOLE_APP) {
      return {
        alive: false, reason: 'port-occupied-by-other',
        detail: `端口 ${port} 上有响应，但不是本项目的控制台（app=${JSON.stringify(data?.app ?? null)}）`,
      };
    }
    return { alive: true, reason: 'ok', detail: `pid=${data.pid} port=${data.port ?? port}` };
  } catch (e) {
    if (e?.name === 'AbortError') return { alive: false, reason: 'timeout', detail: `超过 ${timeoutMs}ms` };
    // Node 的 fetch 把连接失败包在 cause 里，code 才是真正有用的信息
    const code = e?.cause?.code ?? e?.code ?? '';
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
      return { alive: false, reason: 'not-running', detail: code };
    }
    return { alive: false, reason: 'error', detail: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 启动该不该被拒。**纯函数**，方便单独测（真正的探测在上面）。
 *
 * @returns {{ok:boolean, title:string, hints:string[]}}
 */
export function startupVerdict({ alive, required, reason, detail, port }) {
  if (!required) {
    return { ok: true, title: `控制台检查已跳过（端口 ${port}）`, hints: [] };
  }
  if (alive) {
    return { ok: true, title: `控制台在线：127.0.0.1:${port}`, hints: [] };
  }

  const why = {
    'not-running': `127.0.0.1:${port} 没人监听 —— 控制台没打开`,
    'port-occupied-by-other': `127.0.0.1:${port} 上有别的程序，但不是本项目的控制台`,
    timeout: `127.0.0.1:${port} 有响应但超时了（控制台可能卡住）`,
    error: `探测 127.0.0.1:${port} 出错`,
  }[reason] ?? `探测失败（${reason}）`;

  return {
    ok: false,
    title: `拒绝启动：${why}`,
    hints: [
      '机器人是往真群里发消息的，没有控制台你就看不到它在说什么、也没法一键停。',
      '所以「控制台没打开时不许跑」是硬规则。',
      '',
      '要正常使用：双击项目里的「机器人控制台.cmd」（它会连机器人一起起来）。',
      `要换端口：确认控制台用的是这个端口（当前探测 ${port}）。`,
      '确实需要在没有控制台的终端里跑（调试/自动化）：加 --allow-no-console。',
      '想永久关掉这条检查：config.json 里 console.required 设成 false。',
      detail ? `（技术细节：${detail}）` : '',
    ].filter(Boolean),
  };
}

/**
 * 运行中的看门狗。**有状态但纯逻辑**（不碰网络），方便测。
 *
 * 为什么要连续失败才算数：控制台偶尔忙一下（比如正在写大文件）会让
 * 一次探测超时。一次就自杀的话，正常使用中会被误杀。
 * 默认连续 2 次探不到才判死。
 */
export function createConsoleWatch({ threshold = 2 } = {}) {
  const limit = Number.isFinite(threshold) && threshold > 0 ? Math.floor(threshold) : 2;
  let failures = 0;
  let warned = false;

  return {
    get failures() { return failures; },
    get limit() { return limit; },
    /**
     * 喂一次探测结果。
     * @returns {{shouldExit:boolean, failures:number, limit:number, justWarned:boolean, reason:string}}
     */
    note(result) {
      if (result?.alive) {
        const recovered = failures > 0;
        failures = 0;
        warned = false;
        return { shouldExit: false, failures, limit, justWarned: false, recovered, reason: 'ok' };
      }
      failures++;
      const justWarned = !warned;
      warned = true;
      return {
        shouldExit: failures >= limit,
        failures, limit, justWarned,
        recovered: false,
        reason: result?.reason ?? 'error',
      };
    },
  };
}
