/**
 * logger.js — 控制台 + JSONL 文件日志。
 * 不改 stdout 编码（Windows 控制台默认 GBK，Node 写 UTF-8 字节会被显示成乱码），
 * 所以重要产物一律同时落文件，文件用 UTF-8。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let opts = { level: 'info', dir: path.join(ROOT, 'logs'), silent: false };
let stream = null;
let streamPath = '';

export function initLogger(cfg = {}) {
  const lc = cfg.log ?? {};
  opts = {
    level: lc.level ?? 'info',
    dir: path.resolve(ROOT, lc.dir ?? 'logs'),
    silent: Boolean(cfg.cli?.json),
  };
  fs.mkdirSync(opts.dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  streamPath = path.join(opts.dir, `qq-bot-${stamp}.jsonl`);
  stream = fs.createWriteStream(streamPath, { flags: 'a', encoding: 'utf8' });
  return streamPath;
}

export function logPath() { return streamPath; }

function should(level) {
  return (LEVELS[level] ?? 20) >= (LEVELS[opts.level] ?? 20);
}

function write(level, msg, extra) {
  if (!should(level)) return;
  const rec = { ts: new Date().toISOString(), level, msg, ...(extra ? { data: extra } : {}) };
  if (stream) {
    try { stream.write(JSON.stringify(rec) + '\n'); } catch {}
  }
  if (opts.silent) return;
  const tag = { debug: '[dbg]', info: '[inf]', warn: '[wrn]', error: '[ERR]' }[level] ?? '[inf]';
  const line = `${tag} ${msg}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (m, e) => write('debug', m, e),
  info: (m, e) => write('info', m, e),
  warn: (m, e) => write('warn', m, e),
  error: (m, e) => write('error', m, e),
};

export function closeLogger() {
  if (stream) { try { stream.end(); } catch {} stream = null; }
}
