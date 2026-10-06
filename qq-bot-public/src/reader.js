/**
 * reader.js — 统一的「读当前会话」入口。
 *
 * 两条路线：
 *   uia  —— 主路线。发 WM_GETOBJECT 激活 Chromium 无障碍树后走 UI Automation。
 *            精确、有真实坐标、不受 DPI 影响，还能拿到 OCR 读不准的发送者昵称。
 *   ocr  —— 兜底。截图 + Windows 内置中文 OCR，再按几何位置解析。
 *            几乎不出错了，但文本识别有错字、昵称基本读不准。
 *
 * 由 config.readSource 选择，失败时自动降级。
 */
import { runPs } from './ps.js';
import { captureAndOcr } from './capture.js';
import { parseChat } from './parse.js';
import { parseUia } from './parse-uia.js';
import { log } from './logger.js';

export class ReadError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'ReadError';
    this.info = info;
  }
}

/** UIA 路线：读窗口 + 解析。 */
export async function readByUia(cfg, opts = {}) {
  const proc = cfg.process ?? {};
  const uia = await runPs('uia-read.ps1', ['-ProcessName', proc.name ?? 'QQ'], {
    timeoutMs: opts.timeoutMs ?? 60000,
  });

  if (!uia.ok) {
    throw new ReadError(`UIA 读取失败: ${uia.error}`, { stage: 'uia', uia });
  }
  if (!uia.sendButton) {
    throw new ReadError('UIA 树里找不到发送按钮，界面可能不在聊天页', { stage: 'uia', uia });
  }

  const parsed = parseUia(uia, cfg, opts);
  parsed.descendantCount = uia.descendantCount;
  parsed.activated = uia.activated;
  return parsed;
}

/** OCR 路线：截图 + OCR + 几何解析。 */
export async function readByOcr(cfg, opts = {}) {
  const cap = await captureAndOcr(cfg);
  const parsed = parseChat(cap.lines, { w: cap.imageW, h: cap.imageH }, cfg);
  parsed.source = 'ocr';
  parsed.imagePath = cap.imagePath;
  parsed.ocrLines = cap.lines.length;
  return parsed;
}

/**
 * 按配置读一次，UIA 失败自动降级到 OCR。
 * @returns {Promise<{parsed:object, used:string, fellBack:boolean}>}
 */
export async function readConversation(cfg, opts = {}) {
  const want = cfg.readSource ?? 'uia';

  if (want === 'uia') {
    try {
      const parsed = await readByUia(cfg, opts);
      return { parsed, used: 'uia', fellBack: false };
    } catch (err) {
      log.warn(`UIA 读取失败，降级到 OCR: ${err.message}`);
      const parsed = await readByOcr(cfg, opts);
      return { parsed, used: 'ocr', fellBack: true, uiaError: err.message };
    }
  }

  const parsed = await readByOcr(cfg, opts);
  return { parsed, used: 'ocr', fellBack: false };
}
