/**
 * test-context.mjs — 验证「AI 记不记得自己上次说了什么」。
 *
 * 这是连贯性的核心，也是踩过两次的地方：
 *   1. 早期只把屏幕可见消息拼进去，滚出画面就没了
 *   2. 前几版把自己的话混在 user 消息里写成「我：xxx」，
 *      模型是在读"别人转述的记录"，不是在延续自己的对话
 *
 * 现在：自己在历史里的消息渲染成**真正的 assistant 轮次**，
 *       并且历史跨轮累积在 state.history 里（不依赖当前屏幕能读到多少）。
 *
 * 用法：node tools/test-context.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { buildMessages } from '../src/llm.js';
import { stripTrailingTimestamp } from '../src/parse-uia.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`); }
}

const cfg = loadConfig({ argv: [] });

console.log('='.repeat(72));
console.log('上下文连贯性测试');
console.log('='.repeat(72));

// --------------------------------------------- 1. 自己的话 = assistant 轮次
console.log('\n1) 自己说过的话要渲染成 assistant 轮次（不是混在 user 里）');
{
  const history = [
    { side: 'incoming', sender: '群友丙', text: '有人吗' },
    { side: 'self', text: '在的' },
    { side: 'incoming', sender: '群友乙', text: '我电脑又蓝屏了' },
    { side: 'self', text: '啊这 又蓝了？' },
    { side: 'incoming', sender: '群友乙', text: '你刚不是说不信吗' },
  ];
  const msgs = buildMessages(cfg, { text: '你刚不是说不信吗', sender: '群友乙', history });

  const assistants = msgs.filter((m) => m.role === 'assistant');
  check('产生了 assistant 轮次', assistants.length === 2, `${assistants.length} 条`);
  check('assistant 内容正是自己说过的话',
    assistants.map((m) => m.content).join('|') === '在的|啊这 又蓝了？',
    assistants.map((m) => m.content).join(' | '));

  // 关键：自己的话不能出现在 user 轮次里
  const userText = msgs.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  check('自己的话没有混进 user 轮次', !userText.includes('在的') || !/我：/.test(userText),
    userText.includes('我：') ? '仍出现「我：」前缀' : '');
  check('没有「我：」这种转述式前缀', !userText.includes('我：'));
}

// ---------------------------------------------- 2. 别人的话合并成 user 轮次
console.log('\n2) 别人连续说的话合并成一条 user（不产生碎片轮次）');
{
  // 这段历史里中间夹着自己的一句，所以「别人说的话」会被自然切成两轮 user：
  //   user: 甲：在吗 / 乙：问你个事
  //   assistant: 说
  //   user: 甲：那个脚本好了吗 + 当前要回的那条
  // 这是正确行为 —— 轮次边界必须跟着"谁在说话"走，不能为了凑一轮而乱合并。
  //
  // ⚠ 这里刻意用**编出来的名字**（甲/乙），不拿真实群友昵称当测试数据。
  //   踩过的后果有两个，都不小：
  //     · 真昵称会跟着仓库/发布包流出去（导出脱敏时还得专门为它们写替换规则）
  //     · 脱敏只改得动"整词"，几个不同的人改成同一个占位名之后，
  //       "两个不同的人"就变成一个名字，断言当场失效（公开包里就是这么红的）
  const history = [
    { side: 'incoming', sender: '甲', text: '在吗' },
    { side: 'incoming', sender: '乙', text: '问你个事' },
    { side: 'self', text: '说' },
    { side: 'incoming', sender: '甲', text: '那个脚本好了吗' },
  ];
  const msgs = buildMessages(cfg, { text: '那个脚本好了吗', sender: '甲', history });
  const users = msgs.filter((m) => m.role === 'user');
  check('切成 2 条 user（被中间的自己那句话隔开）', users.length === 2, `${users.length} 条`);
  check('第一条 user 合并了连续的两句',
    users[0].content.includes('甲|在吗') && users[0].content.includes('乙|问你个事'),
    JSON.stringify(users[0].content));
  check('最后一条 user 里带着当前要回的那条', users[users.length - 1].content.includes('那个脚本好了吗'));
  check('末尾指示要回哪条', users[users.length - 1].content.includes('现在需要你回复最后这一条'));
  check('收尾指示也在同一轮里（没有多余的 user 轮次）',
    users[users.length - 1].content.includes('直接给出你要打的那句话'));
  check('自己的话是 assistant，不是 user',
    msgs.some((m) => m.role === 'assistant' && m.content === '说'));

  // 另一种情形：历史里没有自己的话 → 应该只合成一条 user
  const msgs2 = buildMessages(cfg, {
    text: '那个脚本好了吗', sender: '群友丙',
    history: [
      { side: 'incoming', sender: '群友丙', text: '在吗' },
      { side: 'incoming', sender: '群友乙', text: '问你个事' },
    ],
  });
  const users2 = msgs2.filter((m) => m.role === 'user');
  check('没有自己的话时合并成 1 条 user', users2.length === 1, `${users2.length} 条`);
}

// --------------------------------------------------- 3. 历史为空也能正常工作
console.log('\n3) 历史为空（刚启动/第一次回复）不能出错');
{
  let threw = false;
  let msgs = null;
  try { msgs = buildMessages(cfg, { text: '你好', sender: '群友丙', history: [] }); } catch { threw = true; }
  check('不抛异常', !threw);
  check('仍能正常构造出 user 轮次', msgs && msgs.some((m) => m.role === 'user' && m.content.includes('你好')));
  check('没有 assistant 轮次', msgs && msgs.filter((m) => m.role === 'assistant').length === 0);
}

// ------------------------------------------------------ 4. 上下文条数会被裁剪
console.log('\n4) contextMessages 限制生效（不能把所有历史都发出去）');
{
  const history = [];
  for (let i = 0; i < 60; i++) {
    history.push({ side: 'incoming', sender: `用户${i}`, text: `消息${i}` });
  }
  const limit = cfg.llm.contextMessages;
  const msgs = buildMessages(cfg, { text: '最后一条', sender: '用户59', history });
  const joined = msgs.map((m) => m.content).join('\n');
  check(`只发了最后 ${limit} 条`, !joined.includes('消息0：') && !joined.includes(`消息${60 - limit - 1}：`),
    `含最早的消息0 ？${joined.includes('消息0')}`);
  check('最新的那些确实在', joined.includes(`消息${59}`) || joined.includes(`消息${60 - limit}`),
    `含消息${60 - limit}`);
}

// ------------------------------------------------------- 5. 时间戳噪声被剥掉
console.log('\n5) 消息尾部粘着的时间戳要剥掉（实测出现过「打王者啊20:44」）');
{
  const cases = [
    ['打王者啊20:44', '打王者啊'],
    ['在吗 15:24', '在吗'],
    ['呢', '呢'],
    ['20:44', '20:44'],          // 纯时间戳，前面没正文，不能清空
    ['1:2', '1:2'],              // 也不是合法时间戳格式
    ['好的21:47', '好的'],
  ];
  for (const [input, want] of cases) {
    const got = stripTrailingTimestamp(input);
    check(`"${input}" → "${got}"`, got === want, got === want ? '' : `期望 "${want}"`);
  }
}

// ------------------------------------------------- 6. 持久历史跨轮累积的结构
console.log('\n6) 持久历史的结构（模拟 recordHistory 的行为）');
{
  const cap = cfg.llm.historyBuffer ?? 60;
  check('historyBuffer 配置存在且合理', Number.isFinite(cap) && cap >= 20, `cap=${cap}`);

  // 复刻 recordHistory 的去重+裁剪逻辑
  const state = { history: [], histSeen: [] };
  const record = (messages) => {
    const seen = new Set(state.histSeen);
    for (const m of messages) {
      const text = String(m.text ?? '').trim();
      if (!text) continue;
      const fp = `${m.side}|${text}`;
      if (seen.has(fp)) continue;
      seen.add(fp);
      state.history.push({
        side: m.side === 'self' ? 'self' : 'incoming',
        // 镜像 bot.js 的 recordHistory：昵称优先、头衔兜底（见那边的注释）
        sender: m.side === 'self' ? '' : (m.sender || m.senderWithTitle || ''),
        text, at: Date.now(),
      });
    }
    if (state.history.length > cap) state.history = state.history.slice(-cap);
    state.histSeen = state.history.map((h) => `${h.side}|${h.text}`);
  };

  // 第一轮：读到两条
  record([
    { side: 'incoming', sender: '群友丙', text: '有人吗' },
    { side: 'self', text: '在的' },
  ]);
  check('第一轮记了 2 条', state.history.length === 2, JSON.stringify(state.history.map((h) => h.text)));

  // 第二轮：同两条又读到了（去重），外加一条新的
  record([
    { side: 'incoming', sender: '群友丙', text: '有人吗' },
    { side: 'self', text: '在的' },
    { side: 'incoming', sender: '群友乙', text: '在不在' },
  ]);
  check('重复读到的没有重复记', state.history.length === 3, JSON.stringify(state.history.map((h) => h.text)));

  // 第三轮：自己发的话滚出了屏幕，但历史里还在
  record([]);
  const selfMsgs = state.history.filter((h) => h.side === 'self');
  check('自己发的话即使滚出屏幕也留在历史里', selfMsgs.length === 1 && selfMsgs[0].text === '在的');

  // 超上限时裁剪最旧的
  for (let i = 0; i < cap + 10; i++) {
    record([{ side: 'incoming', sender: 'x', text: `填充${i}` }]);
  }
  check(`历史被裁到上限 ${cap} 条`, state.history.length === cap, `${state.history.length} 条`);
  check('裁掉的是最旧的', !state.history.some((h) => h.text === '有人吗'));
  check('histSeen 与 history 保持一致（不会无限增长）',
    state.histSeen.length === state.history.length, `${state.histSeen.length} vs ${state.history.length}`);
}

// ---------------------------------------------- 历史按会话分开（轮询之后必须的）
//
// recordHistory / historyWindow / pushSelfHistory 都是 bot.js 里的局部函数
// （bot.js 一 import 就跑主循环，测试导不进来），所以这里按本项目的惯例
// 做**源码级断言** —— 钉住"历史条目带会话名、取窗口时按会话过滤"这两件事。
//
// 为什么必须有：开了「轮询全部会话」之后，历史里会混着好几个会话的消息，
// 而提示词里的历史是"这个会话刚才聊了什么"。不分开的后果有两层：
//   · 串味：私聊里说的话被当成群里刚聊过的内容
//   · 越界：别人的私聊内容被递给群聊那一轮的模型
console.log('\n' + '【历史】按会话分开');
{
  const bot = fs.readFileSync(path.join(ROOT, 'src', 'bot.js'), 'utf8');

  check('历史条目带上会话名（conv）', /conv,\n\s+side: m\.side === 'self'/.test(bot),
    '看 recordHistory 里的 push');
  check('去重指纹也带会话名（否则两个会话里同样的"在吗"会互相顶掉）',
    /\$\{conv\}\|\$\{m\.side\}\|\$\{text\}/.test(bot));
  check('取历史窗口时按会话过滤', /function historyWindow\(state, conversation, n\)/.test(bot)
    && /sessionMatches\(histConv\(h\), conv\)/.test(bot));
  check('本轮历史窗口返回的是**这个会话**的（不是全局尾巴）',
    /return historyWindow\(state, conv, cfg\.llm\?\.contextMessages/.test(bot));
  check('三处写自己说过的话都走同一个入口（pushSelfHistory）',
    (bot.match(/^\s+pushSelfHistory\(state,/gm) ?? []).length === 2
    && /function pushSelfHistory/.test(bot),
    '两处调用：回复发出后、主动分享发出后（本轮读到的那些走 recordHistory）');
  check('记忆整理只拿这个会话的历史', /historyWindow\(state, conversation, cfg\.memory\?\.contextMessages/.test(bot));

  // 队列同理：不能拿队头就发（那是"回错人"级别的 bug）
  check('回复时按会话挑队列项（不拿队头）', /findPendingFor\(state, result\.conversationName/.test(bot));
  check('出队按挑中的位置', /shiftPendingAt\(state, slot\.index\)/.test(bot));
  check('不再有"直接 shift 队头"的写法', !/shiftPending\(state\)\s*;/.test(bot));
}

// ------------------------------------------------------ 提交格式：时间|称号|昵称|内容
//
// 换小模型之后暴露的问题（用户原话）：「提交给API的消息名字与信息粘连在一起」。
//
// 成因有两层：
//   1. UIA 解析出来的正文**本身就粘着发送者**（实测正文以时间戳开头，
//      紧跟昵称、然后是 @ 和内容，中间没有任何分隔）
//   2. 拼提示词时又用 `昵称：内容` 拼了一遍 → 名字出现两次，边界全糊
// 改法：一律用竖线分段，并在 system 末尾把这件事**告诉 API**。
// 后来又加了两段（用户要求「时间，称号也加|」）：现在是 4 段定长
//   `时间|称号|昵称|内容`，缺的写 '-'。
console.log('\n' + '【消息格式】时间|称号|昵称|内容');
{
  const cfg = { llm: { contextMessages: 16 }, trigger: {} };
  const ctx = {
    systemPrompt: '你是QQ用户小深。',
    history: [
      // 正文里粘着时间戳和昵称 —— 真实 UIA 读出来就是这样
      { side: 'incoming', sender: '群主', senderWithTitle: '群主', title: '群主', time: '20:55', text: '你在干嘛' },
      { side: 'self', sender: '', text: '刚要睡着' },
      { side: 'incoming', sender: '群友甲', text: '醒醒' },
    ],
    text: '@示例昵称 在干嘛', sender: '群主', title: '群主', time: '20:56', mentioned: true,
  };
  const m = buildMessages(cfg, ctx);
  const sys = m[0].content;
  const users = m.filter((x) => x.role === 'user');
  const last = users[users.length - 1].content;
  const all = m.map((x) => x.content).join('\n');

  check('system 里告诉了 API 消息格式', sys.includes('【消息格式】') && sys.includes('时间|称号|昵称|内容'));
  check('说明里讲清了 4 段各是什么，且内容在最后一段',
    /时间/.test(sys) && /称号/.test(sys) && /昵称/.test(sys) && /最后一段/.test(sys));
  check('历史里的他人消息是 4 段竖线格式', all.includes('20:55|群主|群主|你在干嘛'),
    JSON.stringify(all.split('\n').filter((l) => l.includes('群主'))));
  check('缺时间/称号时补 -（字段数恒定，小模型不会数错段）',
    all.includes('-|-|群友甲|醒醒') && !/\|\|/.test(all),
    JSON.stringify(all.split('\n').filter((l) => l.includes('群友甲'))));
  check('历史里不再出现「昵称：内容」那种拼法', !/群主：/.test(all) && !/群友甲：/.test(all));
  check('要回的那条也用同一种格式', last.includes('20:56|群主|群主|@示例昵称 在干嘛'), JSON.stringify(last));
  check('@ 的提示仍然保留（另起一行，不跟正文粘一起）', last.includes('（这条 @ 了你）'));
  check('自己说过的话没有昵称前缀（是 assistant 轮次）',
    m.some((x) => x.role === 'assistant' && x.content === '刚要睡着'));
  check('system 是稳定前缀：格式说明追加在末尾，不改用户的 persona 原文',
    sys.startsWith('你是QQ用户小深。') && sys.indexOf('【消息格式】') > sys.indexOf('你是QQ用户小深。'));

  // 记忆整理那边必须用同一种分隔符，否则「关系」字段会记出带前缀的歪名字
  const bot = fs.readFileSync(path.join(ROOT, 'src', 'bot.js'), 'utf8');
  const llmSrc = fs.readFileSync(path.join(ROOT, 'src', 'llm.js'), 'utf8');
  check('记忆整理的对话记录也走同一个渲染函数（不各写一套）',
    /renderIncomingLine\(h\)/.test(bot) && /export function renderIncomingLine/.test(llmSrc),
    '看 bot.js 里那行 map');
  check('记忆整理的提示词里也说明了这个格式', /每行的格式是「时间\|称号\|昵称\|内容」/.test(llmSrc));
}

console.log('\n' + '='.repeat(72));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(72));
process.exitCode = fail > 0 ? 1 : 0;
