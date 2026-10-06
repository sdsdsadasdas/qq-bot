/** 清理 life.json 里连续的完全重复条目（保留第一条）。 */
import fs from 'node:fs';

const file = 'life.json';
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
const before = j.entries.length;

const kept = [];
let removed = 0;
for (const e of j.entries) {
  const prev = kept[kept.length - 1];
  const same = prev
    && String(prev.doing ?? '') === String(e.doing ?? '')
    && String(prev.thinking ?? '') === String(e.thinking ?? '')
    && String(prev.mood ?? '') === String(e.mood ?? '');
  if (same) { removed++; continue; }
  kept.push(e);
}

j.entries = kept;
fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n', 'utf8');

console.log(`清理前 ${before} 条 -> 清理后 ${kept.length} 条（移除 ${removed} 条连续重复）`);
console.log('');
console.log('剩余最近的记录:');
kept.slice(-4).forEach((e) => {
  console.log(`  · 在做：${e.doing} ｜ 想着：${e.thinking} ｜ 心情：${e.mood}`);
});
