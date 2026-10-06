/**
 * capture.js — 抓取 QQ 窗口截图并 OCR，返回结构化行。
 *
 * 两个 PowerShell 脚本串联：
 *   tools/capture-window.ps1  GDI PrintWindow -> PNG（不依赖窗口是否被遮挡）
 *   tools/ocr-image.ps1       Windows.Media.Ocr -> 文本行 + 像素坐标
 *
 * 为什么不用 UI Automation：实测 QQ NT（Chromium）不暴露网页内容，
 * 激活无障碍后 UIA 只有 9 个无名 Pane，MSAA 只有 11 个节点且无文本。
 * 详见 README 的「为什么是 OCR」。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runPs } from './ps.js';
import { ROOT } from './config.js';

export class CaptureError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'CaptureError';
    this.info = info;
  }
}

function tmpImage() {
  const dir = path.join(ROOT, '.shots');
  fs.mkdirSync(dir, { recursive: true });
  const name = `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  return path.join(dir, name);
}

/**
 * 抓取并 OCR。
 * @param {object} cfg
 * @returns {Promise<{imagePath:string, imageW:number, imageH:number, target:object, lines:Array, engine:string}>}
 */
export async function captureAndOcr(cfg) {
  const proc = cfg.process ?? {};
  const ocr = cfg.ocr ?? {};
  const imagePath = tmpImage();

  const capArgs = [
    '-ProcessName', proc.name ?? 'QQ',
    '-OutImage', imagePath,
  ];
  if (proc.titleMatch) capArgs.push('-TitleMatch', proc.titleMatch);
  if (proc.bringToFront !== false) capArgs.push('-BringToFront');

  const cap = await runPs('capture-window.ps1', capArgs, { timeoutMs: ocr.timeoutMs ?? 45000 });
  if (!cap.ok) {
    throw new CaptureError(`截图失败 (${cap.stage}): ${cap.error}`, cap);
  }

  const ocrRes = await runPs('ocr-image.ps1', [
    '-ImagePath', imagePath,
    '-Language', ocr.lang ?? 'zh-Hans-CN',
  ], { timeoutMs: ocr.timeoutMs ?? 45000 });

  if (!ocrRes.ok) {
    throw new CaptureError(`OCR 失败 (${ocrRes.stage}): ${ocrRes.error}`, ocrRes);
  }

  if (!ocr.cacheImage) {
    // 保留最近一张便于排查，其余删掉
    pruneShots();
  }

  return {
    imagePath,
    imageW: ocrRes.imageW,
    imageH: ocrRes.imageH,
    target: cap.target,
    engine: ocrRes.engine,
    lines: (ocrRes.lines ?? []).map((l) => ({
      text: l.text,
      x: l.x, y: l.y, w: l.w, h: l.h,
      words: l.words,
    })),
  };
}

function pruneShots(keep = 5) {
  try {
    const dir = path.join(ROOT, '.shots');
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  } catch {}
}

/** 只找窗口，不截图（用于 doctor / 预检）。 */
export async function findWindow(cfg) {
  const proc = cfg.process ?? {};
  const args = ['-ProcessName', proc.name ?? 'QQ'];
  if (proc.titleMatch) args.push('-TitleMatch', proc.titleMatch);
  const res = await runPs('capture-window.ps1', [...args, '-OutImage', path.join(os.tmpdir(), 'qq-probe-unused.png')], { timeoutMs: 20000 });
  return res;
}
