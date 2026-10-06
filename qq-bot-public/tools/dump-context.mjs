/** dump 回复时实际注入的三段上下文：记忆 / 人生状态 / 待回消息。 */
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { renderLife } from '../src/life.js';
import { activeSystemPrompt } from '../src/takeover.js';

const cfg = loadConfig({ argv: [] });
let state = {};
try { state = JSON.parse(fs.readFileSync('state.json', 'utf8')); } catch {}

const lifeLog = JSON.parse(fs.readFileSync('life.json', 'utf8'));
const digest = renderLife(lifeLog, cfg, { note: false });

console.log('========== 1. 【你最近在做什么】lifeDigest ==========');
console.log(digest || '(空)');
console.log('');

console.log('========== 2. memory.json（总记忆）==========');
try {
  const mem = JSON.parse(fs.readFileSync('memory.json', 'utf8'));
  console.log(JSON.stringify(mem, null, 2).slice(0, 1200));
} catch (e) { console.log('读取失败:', e.message); }
console.log('');

console.log('========== 3. 会话记忆（memory/ 目录）==========');
try {
  const dir = 'memory';
  for (const f of fs.readdirSync(dir)) {
    const p = `${dir}/${f}`;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    console.log(`--- ${f} ---`);
    console.log(JSON.stringify(j, null, 2).slice(0, 700));
    console.log('');
  }
} catch (e) { console.log('读取失败:', e.message); }

console.log('========== 4. 回复用的 system（前 200 字）==========');
console.log(activeSystemPrompt(state, cfg).slice(0, 200));
