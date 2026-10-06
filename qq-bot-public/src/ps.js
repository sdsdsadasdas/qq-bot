/**
 * ps.js — PowerShell 桥。
 *
 * 为什么用 PowerShell 而不是 npm 原生模块：
 *   读窗口、截图、OCR 都需要 Win32/WinRT。走原生模块要 node-gyp + VS Build Tools，
 *   在目标机器上很可能装不上。PowerShell 是系统自带的，零依赖。
 *
 * 重要：所有 .ps1 都是 ASCII-only 源码。Windows PowerShell 5.1 会把无 BOM 的 UTF-8
 * 当 ANSI(GBK) 解码，中文源码会乱码并导致语法错误 —— 这是实测踩过的坑。
 * 脚本内部自己设 [Console]::OutputEncoding = UTF8，所以 stdout 里的中文能正确回来。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const PS = 'powershell.exe';
const TOOLS = path.join(ROOT, 'tools');

export class PsError extends Error {
  constructor(message, { stderr = '', code = null, script = '' } = {}) {
    super(message);
    this.name = 'PsError';
    this.stderr = stderr;
    this.code = code;
    this.script = script;
  }
}

/** 去掉可能出现在 stdout 前的 BOM / 空白。 */
function clean(s) {
  return String(s ?? '').replace(/^\uFEFF/, '').trim();
}

function extractJson(text) {
  const s = clean(text);
  if (!s) return null;
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  return s.slice(start, end + 1);
}

export function psScriptPath(name) {
  const p = path.join(TOOLS, name);
  if (!fs.existsSync(p)) throw new PsError(`script not found: ${p}`, { script: name });
  return p;
}

/**
 * 跑一个 .ps1 并解析它输出的 JSON。
 * @returns {Promise<object>} 解析后的对象
 */
export function runPs(script, args = [], { timeoutMs = 60000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  const file = psScriptPath(script);
  const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args];

  return new Promise((resolve, reject) => {
    execFile(PS, argv, { timeout: timeoutMs, maxBuffer, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const jsonText = extractJson(stdout);
        if (jsonText) {
          try {
            const parsed = JSON.parse(jsonText);
            // 脚本自身用 ok:false 报告业务失败；这里仍算「调用成功」，交给上层判断
            resolve(parsed);
            return;
          } catch (parseErr) {
            reject(new PsError(`${script}: JSON 解析失败 (${parseErr.message})`, { stderr, script }));
            return;
          }
        }
        const detail = clean(stderr) || clean(stdout) || (err ? err.message : '无输出');
        reject(new PsError(`${script}: ${detail}`, { stderr, code: err?.code ?? null, script }));
      });
  });
}

/** 把 JS 值转成 PowerShell 单引号字面量（内部单引号翻倍）。 */
export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
