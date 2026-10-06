/**
 * test-system.mjs — 系统消息过滤：该筛的筛掉，**不该筛的别误伤**。
 *
 * 用法：node tools/test-system.mjs
 *
 * 为什么这个测试的重点是"误伤"那一半：
 *   过滤规则写宽了不会报错，只会**悄悄不回** —— 而"机器人不回消息"这件事
 *   在这个项目里已经被排查过好几次了（白名单、@ 名字、只在@时回、去重……）。
 *   所以每加一条规则，都要同时给出"它不该吃掉的句子"。
 *
 * 用例来源：全部是**实测文本** ——
 *   · 用户那轮日志里被回过的三条（临时会话 / 防骗长通知 / 它的截断残句）
 *   · 夹具 uia-sessions.json 里的「你已被移出群聊」
 *   · 我自己写规则时误伤过的那句（「你拍了拍我的头？」）
 */
import { classifySystemMessage, isSystemMessage, SYSTEM_RULES, describeSystemRules } from '../src/system-msg.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

console.log('='.repeat(72));
console.log('系统消息过滤');
console.log('='.repeat(72));

const CFG = {};   // 默认配置（过滤开着）

// -------------------------------------------------- 1. 该筛掉的
section('1) 该筛掉的（每条都注明来自哪里）');
{
  const cases = [
    ['临时会话', '真实日志：被回过一条"示例昵称"'],
    ['该用户通过“临时会话谨防兼职刷单、游戏交易、投资荐股、色情招嫖、仿冒公检法及客服人员的网络骗局，如有资金往来请谨慎操作。',
      '真实日志：这条长通知也被回过'],
    ['该用户通过“', '真实日志：上面那条被截断后的残句（同一句话的不同读法）'],
    ['你已被移出群聊', '夹具 uia-sessions.json 的会话预览里抓到过'],
    ['群友甲加入了群聊', '同一类机器拼的群通知'],
    ['群主修改群名为「测试群」', '群设置通知'],
    ['以上是打招呼的内容', '加好友时的分隔提示'],
    ['张三撤回了一条消息', '撤回通知（消息本体没了）'],
    ['语音通话', '通话记录'],
    ['[图片]', '媒体消息的占位渲染，正文读不到'],
    ['群友甲拍了拍我', '动作提示'],
    ['10:38', '时间分隔线（OCR 路线偶尔漏过来）'],
  ];
  for (const [text, why] of cases) {
    const r = classifySystemMessage(text, CFG);
    check(`筛掉 ${JSON.stringify(text.slice(0, 30))}`, r.system === true, why);
  }
}

// -------------------------------------------------- 2. 不许误伤
section('2) 不许误伤的（真人会这么说话）');
{
  const cases = [
    ['图片', '真人真的会只发这两个字'],
    ['文件', '同上'],
    ['红包', '同上（和卡片消息 [红包] 区分开）'],
    ['我昨天加入了群聊，你呢', '带标点 = 人在聊天，不是系统通知'],
    ['我在临时会话里跟你说过', '含"临时会话"四个字，但不是那条提示本身'],
    ['视频通话质量好差啊', '含"视频通话"，但是人在吐槽'],
    ['你拍了拍我的头？', '实测误伤过：这是人在问话，得回'],
    ['你是谁', '真实日志里被回过两次的那句 —— 它该回'],
    ['你知道泰坦尼克号吗', '普通聊天'],
    ['谢谢', '普通聊天'],
    ['12:06123456789', 'OCR 噪声（1 字符碎片规则管它，别让系统消息规则背这个锅）'],
  ];
  for (const [text, why] of cases) {
    const r = classifySystemMessage(text, CFG);
    check(`不筛 ${JSON.stringify(text.slice(0, 30))}`, r.system === false,
      r.system ? `误伤：命中「${r.name}」（${why}）` : why);
  }
}

// -------------------------------------------------- 3. 开关
section('3) 总开关：关掉就一律不筛');
{
  const off = { trigger: { ignoreSystemMessages: false } };
  check('关掉之后，「临时会话」也不再被筛',
    classifySystemMessage('临时会话', off).system === false);
  check('关掉之后，普通消息照旧不筛',
    classifySystemMessage('你是谁', off).system === false);
  check('开着（默认）时照旧筛', classifySystemMessage('临时会话', {}).system === true);
  check('显式 true 也是筛', classifySystemMessage('临时会话', { trigger: { ignoreSystemMessages: true } }).system === true);
}

// -------------------------------------------------- 4. 用户自己加的规则
section('4) trigger.systemPatterns：用户自己加的关键词/正则');
{
  const cfg = { trigger: { systemPatterns: ['某某公众号', '^系统提示', '签到'] } };
  check('普通词按"包含"匹配', classifySystemMessage('来自某某公众号的消息', cfg).system === true);
  check('锚点正则也认', classifySystemMessage('系统提示：今日维护', cfg).system === true);
  check('命中的名字会带出来（日志里能看到是哪条规则）',
    classifySystemMessage('签到成功', cfg).name === '签到', classifySystemMessage('签到成功', cfg).name);
  check('没命中就不筛', classifySystemMessage('今天吃啥', cfg).system === false);
  check('来源标成 config（和内置规则区分开）',
    classifySystemMessage('签到成功', cfg).from === 'config');

  // 正则写错了不能崩、也不能把它的规则变成"永远不命中"的哑巴
  const bad = { trigger: { systemPatterns: ['签到（'] } };
  check('非法正则不抛异常', (() => { try { classifySystemMessage('签到（今天）', bad); return true; } catch { return false; } })());
  check('非法正则退化成子串匹配（规则还活着）',
    classifySystemMessage('签到（今天）', bad).system === true);

  check('systemPatterns 不是数组也不崩', classifySystemMessage('临时会话', { trigger: { systemPatterns: '签到' } }).system === true);
}

// -------------------------------------------------- 5. 规则表本身
section('5) 规则表自身');
{
  check('规则表非空', SYSTEM_RULES.length >= 8, `${SYSTEM_RULES.length} 条`);
  check('每条都有名字和理由（理由会进文档，方便以后判断能不能放宽）',
    SYSTEM_RULES.every((r) => r.name && r.why && r.re instanceof RegExp));
  check('describeSystemRules 给控制台/文档用',
    describeSystemRules().length === SYSTEM_RULES.length
    && typeof describeSystemRules()[0].name === 'string');

  // 关键：内置规则**不许**出现裸词（真人可能就发那两个字）
  const naked = ['图片', '文件', '视频', '语音', '位置', '名片', '红包', '转账'];
  const bad = naked.filter((w) => isSystemMessage(w, {}));
  check('裸词一律不筛（只认 [图片] 这种带方括号的形态）', bad.length === 0, JSON.stringify(bad));
}

// -------------------------------------------------- 6. 接线
section('6) 接线：gate.js 真的用了它，而且位置对');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const gate = fs.readFileSync(path.join(ROOT, 'src', 'gate.js'), 'utf8');

  check('gate.js 导入了 classifySystemMessage', gate.includes("from './system-msg.js'"));
  check('在 decide 里调用', /classifySystemMessage\(m\.text, cfg\)/.test(gate));
  check('拒绝理由写明了是哪类系统消息', /系统消息（\$\{sys\.name\}）/.test(gate));
  check('decision 上带了 system 标记（日志/调试能区分）', /reason: `系统消息（\$\{sys\.name\}）`, system: true/.test(gate));

  // 顺序：必须在"防自嗨"之后、"已处理过去重"之前 ——
  // 系统消息不该占去重名额，也不该走到 @/概率那几道闸门去
  const iSelf = gate.indexOf('isBotOwnMessage(m.text, state)');
  const iSys = gate.indexOf('classifySystemMessage(m.text, cfg)');
  const iSeen = gate.indexOf('if (seen.has(fp))');
  check('排在"防自嗨"之后、"去重"之前', iSelf > 0 && iSys > iSelf && iSeen > iSys,
    `self@${iSelf} sys@${iSys} seen@${iSeen}`);
}

console.log('\n' + '='.repeat(72));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(72));
process.exitCode = fail > 0 ? 1 : 0;
