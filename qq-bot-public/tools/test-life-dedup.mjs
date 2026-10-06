/**
 * test-life-dedup.mjs — 诊断：生活记录的"重复丢弃"是否生效。
 *
 * ⚠ 这不是离线测试，是**跑在本机真实数据上**的诊断脚本：
 *     · 没有日志 → 直接跳过（退出码 0），不当成失败
 *       （发布包里不含运行数据，拿它当失败会让人以为项目坏了）
 *     · 需要写一条测试条目 → 写完立刻按"写入前的条数"截回去，不留痕迹
 *
 * 用法：node tools/test-life-dedup.mjs
 *
 * 为什么最近改过：生活日志现在按「人生」分文件（`lives/<名字>.json`），
 * 根目录那个 `life.json` 在启用多重人生之后是**空的**。老版本直接读 life.json，
 * 于是 `log.entries` 是空数组、取最后一条时抛 TypeError —— 看着像项目坏了，
 * 其实只是读错了文件。现在跟着 `state.json` 的 `lifeProfile` 走，
 * 跟机器人运行时读的是**同一份**。
 */
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { renderLife, appendLifeEntry, loadLifeLog, saveLifeLog, activeProfile } from '../src/life.js';

const cfg = loadConfig({ argv: [] });

function readState() {
  try {
    return JSON.parse(fs.readFileSync('state.json', 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};   // 没有/坏了就当"没设过"，会落到 config.life.profile（老行为）
  }
}

const profile = activeProfile(cfg, readState());
const { log, ok, path: file, reason } = loadLifeLog(cfg, '.', profile);

console.log('====== 当前这份人生 ======');
console.log(`  人设/人生：${profile || '(默认那份)'}`);
console.log(`  文件：${file}`);

if (!ok || log.entries.length === 0) {
  console.log(`\n跳过：这份日志还没有条目${ok ? '' : `（读不出来：${reason}）`}。`);
  console.log('      想跑这个诊断：先让机器人跑一阵人生模拟，或 node src/bot.js --once 生成。');
  process.exit(0);
}
console.log(`  条数：${log.entries.length}`);

/** 把日志截回写入前的条数（测试条目一律不留）。 */
function restore(before) {
  const { log: cur } = loadLifeLog(cfg, '.', profile);
  cur.entries = cur.entries.slice(0, before);
  const w = saveLifeLog(cfg, '.', cur, profile);
  console.log(w.ok
    ? `  （测试条目已移除，${file} 回到 ${before} 条，未污染真实日志）`
    : `  ⚠ 测试条目没删干净（${w.error}）—— 请手动检查 ${file}`);
}

console.log('\n========== 1. 注入说明是否改对 ==========');
console.log(renderLife(log, cfg));

console.log('\n========== 2. 去重是否生效 ==========');
const before = log.entries.length;
const last = log.entries[before - 1];
console.log('上一条:', JSON.stringify({ doing: last.doing, thinking: last.thinking, mood: last.mood }));

// 写一条与上一条完全相同的内容 → 应该被丢弃
const r1 = appendLifeEntry(cfg, '.', {
  doing: last.doing, thinking: last.thinking, mood: last.mood,
  share: { suitable: false, why: '', text: '' },
}, Date.now(), profile);
console.log('写入重复条目 ->', r1.ok ? `❌ 被写进去了（去重没生效）` : `✅ 已拒绝：${r1.error}`);
if (r1.ok) restore(before);

// 再写一条不同的内容 → 应该成功（顺便证明"不是把所有写入都拦了"）
const r2 = appendLifeEntry(cfg, '.', {
  doing: '起身去倒了杯水', thinking: '嗓子有点干', mood: '清醒了点',
  share: { suitable: false, why: '', text: '' },
}, Date.now(), profile);
console.log('写入新条目 ->', r2.ok ? `✅ 写入成功（共 ${r2.total} 条）` : `❌ 失败：${r2.error}`);
if (r2.ok) restore(before);
