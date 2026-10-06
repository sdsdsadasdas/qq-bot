/**
 * sender.js — 通过 tools/qq-send-message.ps1 把回复真正发出去。
 *
 * 该脚本基于 UIA 读取 + Unicode SendInput 打字 + 点击「发送」按钮，
 * 全部行为都已实测（详见 README 的「已验证 / 未验证」）。
 *
 * 安全边界（别拆掉）：
 *  - dryRun 时不碰键盘，只报告将要发送的内容
 *  - 发送前读 UIA 确认输入框为空；非空则先清空（End + 连续退格），清不掉就拒绝发送
 *  - 打字后必须能从 UIA 读回这段文字，读不回就不点发送
 *  - 提交后用 UIA 确认输入框已清空
 */
import { runPs } from './ps.js';
import { log } from './logger.js';

/**
 * 发送串行化。**所有**往 QQ 打字都必须从这里过。
 *
 * 为什么非有不可（「主动分享」上线后才出现的风险）：
 *   在此之前只有一件事会往输入框里打字 —— 主循环回消息，一次一个，天然串行。
 *   现在人生模拟也会主动发一句，而它是**异步**跑的（不 await，否则会把扫描
 *   节奏拖垮）。于是完全可能出现：主循环正在打字发回复，模拟同时在打字发分享 ——
 *   两段文字搅进同一个输入框，发出去的是乱七八糟的拼接。
 *   这不是理论风险：本项目的发送是 SendInput 逐字打进去的，中间隔着好几百毫秒。
 *
 * 放在 sender.js 里而不是让每个调用方自觉排队，是因为"自觉"这种东西迟早会漏 ——
 * 从这里走就自动排队，不用记得。
 */
let sendChain = Promise.resolve();

export function withSendLock(fn) {
  // 上一个失败也要继续跑下一个（then 的两个分支都给 fn）
  const run = sendChain.then(fn, fn);
  sendChain = run.then(() => {}, () => {});
  return run;
}

/**
 * @param {object} cfg
 * @param {string} text 要发的内容
 * @param {{dryRun?:boolean}} opts
 */
export function sendMessage(cfg, text, opts = {}) {
  return withSendLock(() => sendMessageRaw(cfg, text, opts));
}

async function sendMessageRaw(cfg, text, opts = {}) {
  const dryRun = opts.dryRun ?? cfg.reply?.dryRun ?? true;
  const proc = cfg.process ?? {};

  if (!text || !String(text).trim()) {
    return { ok: false, sent: false, reason: 'empty', error: '回复内容为空，未发送' };
  }

  const args = ['-ProcessName', proc.name ?? 'QQ', '-Text', String(text)];
  if (dryRun) args.push('-DryRun');
  if (cfg.reply?.submit !== false) args.push('-Submit');

  try {
    const res = await runPs('qq-send-message.ps1', args, { timeoutMs: 60000 });

    if (!res.ok) {
      log.warn(`发送失败（stage=${res.stage ?? '?'}）: ${res.error}`);
      return {
        ok: false, sent: false, stage: res.stage, error: res.error, raw: res,
      };
    }
    if (res.dryRun) {
      return { ok: true, sent: false, dryRun: true, wouldSend: res.wouldSend, raw: res };
    }
    return {
      ok: true,
      sent: res.sent === true,
      submitted: res.submitted === true,
      verifiedInBox: res.verifiedInBoxBeforeSubmit === true,
      inputClearedAfter: res.inputClearedAfter === true,
      method: res.method,
      typedChars: res.typedChars,
      raw: res,
    };
  } catch (err) {
    log.error(`发送异常: ${err.message}`);
    return { ok: false, sent: false, reason: 'exception', error: err.message };
  }
}

/**
 * 发送后复核：机器人刚发的那句话有没有出现在聊天里。
 *
 * UIA 路线其实已经能读回发送前输入框的内容（verifiedInBoxBeforeSubmit），
 * 这个 OCR 复核是额外的一层保险，用于确认「点发送按钮之后」真的落到了聊天区。
 *
 * @returns {Promise<{found:boolean, matched:string|null, attempts:number}>}
 */
export async function verifySentByOcr(cfg, text, { attempts = 3, delayMs = 1200 } = {}) {
  const { captureAndOcr } = await import('./capture.js');
  const { parseChat, normalizeText } = await import('./parse.js');

  const key = normalizeText(text);
  if (!key) return { found: false, matched: null, attempts: 0 };

  for (let i = 1; i <= attempts; i++) {
    try {
      const cap = await captureAndOcr(cfg);
      const parsed = parseChat(cap.lines, { w: cap.imageW, h: cap.imageH }, cfg);
      const all = [...parsed.self, ...parsed.incoming];
      const hit = all.find((m) => {
        const t = normalizeText(m.text);
        return t && (t.includes(key) || key.includes(t));
      });
      if (hit) return { found: true, matched: hit.text, side: hit.side, attempts: i };
    } catch (err) {
      log.debug(`OCR 复核第 ${i} 次失败: ${err.message}`);
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { found: false, matched: null, attempts };
}
