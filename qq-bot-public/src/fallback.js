/**
 * fallback.js — 大模型不可用时的本地回复。
 *
 * 设计目标：**看起来像个随手打字的真人，而不是客服机器人。**
 *
 * 具体手段：
 *   1. 按意图分类（问句/打招呼/感谢/吐槽/约时间/被认出是机器人…）
 *   2. 每个意图配一组回复，随机取，避免固定文案
 *   3. 排除最近发过的 6 句，不连着重复
 *   4. 种子里混入「已发送条数」，同一句话被反复问会轮转而不是雷同
 *   5. 一部分回复短到只有两三个字或一个表情 —— 真人就是这样，
 *      不会每句都"收到，我看看"这种完整句子
 *
 * 刻意**不用**的写法（这些是"客服腔"，一眼假）：
 *   - "感谢您的耐心等待"
 *   - "收到，我看看"（完整、礼貌、机械）
 *   - 每句都带感叹号
 *
 * 但要说清楚：本地规则再扩也是**有限短语池**，理解不了上下文，
 * 重复率也降不到 LLM 那种水平。想要真正自然的回复，配 DEEPSEEK_API_KEY。
 */

const INTENTS = [
  {
    id: 'ask_if_bot',
    // 被认出是机器人。必须排在 question 之前，否则「你是不是机器人」会被问句规则抢走。
    test: (t) => /(机器人|是不是ai|自动回复|gpt|deepseek|脚本)/i.test(t),
    replies: ['嗯是', '被发现了', '哈哈是', '嗯，自动的', '让你看出来了 (・∀・)'],
  },
  {
    id: 'meeting',
    // 约时间。同样必须排在 question 之前（「明天几点」既是问句又是约时间）。
    test: (t) => /(几点|什么时候|明天|后天|今晚|下午|上午|晚上|周末|有空|约)/.test(t),
    replies: ['我看下', '都行，你定', '回头给你个准话', '我应该都成', 'emmm 让我想想'],
  },
  {
    id: 'greeting',
    // 打招呼。也要排在 question 之前，否则「你好吗」会被问句规则抢走。
    // 注意 \b 是零宽断言，不能写成 \b?（那会是非法正则，实测会让整个模块加载失败）。
    //
    // 「早」必须锚到行尾/语气符号：只写 `早` 的话「早点睡」「早上开会」「早说啊」全被
    // 当成打招呼，回一句「在」—— 牛头不对马嘴（实测踩到）。所以写成 早[!！~～]*$。
    test: (t) => /^(你好|您好|哈喽|哈啰|嗨|hi|hello|在吗|在么|在不在|早上好|早安|早[!！~～]*$|晚上好)/i.test(t),
    replies: ['在', '嗯在', '在的', '(・∀・)', '嗨', '来了来了'],
  },
  {
    id: 'thanks',
    test: (t) => /(谢谢|多谢|感谢|辛苦了|3q|thx|thanks)/i.test(t),
    replies: ['客气', '没事', '不谢不谢', '小事', '(๑•̀ㅂ•́)و'],
  },
  {
    id: 'apology',
    test: (t) => /(对不起|抱歉|不好意思|我的锅|我错了)/.test(t),
    replies: ['没事', '不至于', '没事没事', '别别别'],
  },
  {
    id: 'goodnight',
    test: (t) => /(晚安|睡了啊|睡了|先睡了|我去睡|早点睡|早睡|该睡了)/.test(t),
    replies: ['晚安', '晚安晚安', '睡了睡了', '晚安 (｡･ω･｡)'],
  },
  {
    id: 'laughter',
    test: (t) => /(哈哈|笑死|233|hhh|😄|😂|🤣)/i.test(t),
    replies: ['哈哈', '笑死', '草', '乐', '哈哈哈哈哈', '(≧▽≦)'],
  },
  {
    id: 'complaint',
    test: (t) => /(烦|难受|崩了|麻了|好累|累死|无语|离谱|寄了)/.test(t),
    replies: ['唉', '确实', '摸摸', '太难了', '我也麻了', '(´･_･`)'],
  },
  {
    id: 'agreement',
    test: (t) => /^(行|好|好的|ok|可以|没问题|收到|嗯嗯|嗯|中|成)/i.test(t),
    replies: ['嗯嗯', '好', '行', 'ok', '嗯'],
  },
  {
    id: 'question',
    // 笼统的问句放最后：前面那些具体意图都没命中，才轮到它。
    test: (t) => /[?？]$/.test(t) || /(吗|呢|怎么|为什么|为啥|咋|多少|哪个|哪儿|哪里|是不是|能不能|可不可以|有没有)/.test(t),
    replies: [
      '我想想',
      '我看看啊',
      '好像是吧',
      '不太确定',
      'emmm',
      '等我查下',
      '应该可以',
      '(・_・?)',
    ],
  },
];

/**
 * 通用兜底池。
 *
 * 有意混入很短、很不正式、带颜文字或表情的回复 —— 真人不会每句都打成完整句子。
 * 之前这池子全是"收到，我看看""在忙，稍后回你"这种，五句里有四句是客服腔。
 */
const GENERIC = [
  '嗯嗯',
  '收到',
  '嗯',
  '在忙，等下',
  '诶我看看',
  '回头说',
  '好嘞',
  '了解',
  '行',
  'hh',
  '(・∀・)',
  '草',
  '？',
  '懂了',
  '晚点聊',
  '嗯嗯知道了',
  '好',
  '哦哦',
];

/**
 * 带模板的接话：会带上对方昵称或复述对方的话，读起来像在接话。
 *
 * 复述类都有 maxLen，这个限制不是洁癖：
 *   短句被念回来像在确认（「吃了吗」→「吃了吗…让我想想」），
 *   长句被原样念回来就是复读机（整句问话被完整重复一遍，一眼假）。
 *   所以只对短消息开放复述。
 */
const TEMPLATED = [
  { text: '{sender}，等下回你', need: 'sender' },
  { text: '{sender}说啥？刚没看清', need: 'sender' },
  { text: '{echo}…让我想想', need: 'echo', maxLen: 8 },
  { text: '嗯？{echo}', need: 'echo', maxLen: 6 },
];

/**
 * 接管模式的默认可爱语气池。
 *
 * 键名和 persona 配置里的字段名一致（fallbackGeneric 等），
 * 这样合并逻辑可以直接对应上，不用再写一层映射。
 */
const PERSONA_DEFAULTS = {
  fallbackGeneric: [
    '嗯嗯', '诶', '哦哦', '啊这', '草', '笑死', 'hh', '来了来了',
    '？', '？？', '在在在', '啥', '咋了', '嗯？', '诶嘿',
    '(・∀・)', '(´･_･`)', '嗯嗯嗯', '好耶', '我不道啊',
  ],
  fallbackGreeting: ['诶', '在在在', '来了', '嗯？', '咋了', '(・∀・)'],
  fallbackQuestion: ['不知道诶', '我想想', '？？', 'emmm', '等我看看', '我也不清楚'],
  fallbackThanks: ['客气啥', '没事没事', '诶嘿', '小事'],
  fallbackComplaint: ['抱抱', '诶呀', '摸摸', '太难了', '(´･_･`)', '别难过嘛'],
  fallbackLaughter: ['哈哈', '笑死', '草', 'hhh', '(≧▽≦)'],
};

/** 意图 id → persona 配置里的池子名。接管模式下用它换语气。 */
const PERSONA_POOLS = {
  greeting: 'fallbackGreeting',
  question: 'fallbackQuestion',
  thanks: 'fallbackThanks',
  complaint: 'fallbackComplaint',
  laughter: 'fallbackLaughter',
};

/**
 * 内置的默认回复池（**唯一的事实来源**）。
 *
 * 这些留在代码里，而不是全量写进 config.json —— 否则配置文件会多出几百行
 * 重复的默认值，改一个默认值还要同步两处。
 *
 * config.json 的 fallback.pools 只存**用户改过的覆盖**：
 * 键存在就用它，不存在就用这里的内置默认。
 *
 * 导出来是为了让控制台能拿到「当前生效的值」做预填。
 */
export const BUILTIN_POOLS = {
  // 兜底池：任何意图都没命中时用
  generic: GENERIC,
  // 各意图的回复池，键名和 INTENTS 的 id 对应
  ask_if_bot: INTENTS.find((i) => i.id === 'ask_if_bot')?.replies ?? [],
  meeting: INTENTS.find((i) => i.id === 'meeting')?.replies ?? [],
  greeting: INTENTS.find((i) => i.id === 'greeting')?.replies ?? [],
  thanks: INTENTS.find((i) => i.id === 'thanks')?.replies ?? [],
  apology: INTENTS.find((i) => i.id === 'apology')?.replies ?? [],
  goodnight: INTENTS.find((i) => i.id === 'goodnight')?.replies ?? [],
  laughter: INTENTS.find((i) => i.id === 'laughter')?.replies ?? [],
  complaint: INTENTS.find((i) => i.id === 'complaint')?.replies ?? [],
  agreement: INTENTS.find((i) => i.id === 'agreement')?.replies ?? [],
  question: INTENTS.find((i) => i.id === 'question')?.replies ?? [],
  // 接管模式用的可爱语气池
  personaGeneric: PERSONA_DEFAULTS.fallbackGeneric,
  personaGreeting: PERSONA_DEFAULTS.fallbackGreeting,
  personaQuestion: PERSONA_DEFAULTS.fallbackQuestion,
  personaThanks: PERSONA_DEFAULTS.fallbackThanks,
  personaComplaint: PERSONA_DEFAULTS.fallbackComplaint,
  personaLaughter: PERSONA_DEFAULTS.fallbackLaughter,
};

/** 每个池子的中文说明，控制台用它给编辑框加标题。 */
export const POOL_LABELS = {
  generic: '兜底（任何意图都没命中）',
  greeting: '打招呼（你好／在吗／早）',
  question: '问句（…吗／怎么／几点）',
  meeting: '约时间（明天／几点／有空）',
  thanks: '感谢',
  apology: '道歉',
  goodnight: '晚安',
  laughter: '笑（哈哈／笑死）',
  complaint: '吐槽（烦／累／麻了）',
  agreement: '附和（行／好／收到）',
  ask_if_bot: '被认出是机器人',
  personaGeneric: '接管模式·兜底',
  personaGreeting: '接管模式·打招呼',
  personaQuestion: '接管模式·问句',
  personaThanks: '接管模式·感谢',
  personaComplaint: '接管模式·吐槽',
  personaLaughter: '接管模式·笑',
};

/**
 * 合并「用户覆盖」与「内置默认」，得到当前生效的池子。
 *
 * 优先级（高 → 低）：
 *   1. config.fallback.pools.<键>   —— 新版，控制台写的就是这里
 *   2. config.fallback.generic      —— 老的配置项，只对应「兜底池」
 *   3. BUILTIN_POOLS.<键>           —— 内置默认
 *
 * 第 2 条是兼容性要求：`fallback.generic` 是早期版本就有的配置项，
 * 重构时漏掉它会让老配置静默失效（测试抓到过）。
 *
 * 空数组一律视为「没改」，回退到下一优先级 —— 避免误把某个池清空成
 * 一句话都发不出。
 */
export function resolvePools(cfg) {
  const overrides = cfg?.fallback?.pools ?? {};
  const legacyGeneric = cfg?.fallback?.generic;
  const out = {};
  for (const [key, def] of Object.entries(BUILTIN_POOLS)) {
    const candidates = [overrides[key]];
    if (key === 'generic') candidates.push(legacyGeneric);
    const use = candidates.find((c) => Array.isArray(c) && c.length > 0);
    out[key] = use
      ? use.map((s) => String(s)).filter((s) => s.trim() !== '')
      : def;
  }
  return out;
}

function normalize(s) {
  return String(s ?? '').replace(/\s+/g, '').trim();
}

/**
 * FNV-1a + 一轮 avalanche 混合。
 *
 * 只做 FNV-1a 不够：对「只差一个字符的短字符串」（zzz…0 / zzz…1 / …）
 * 算出来的哈希值彼此接近，取模后反复落到同一个位置 ——
 * 表现就是"轮转失效、永远回同一句"。实测踩过。
 * 这里补一轮 xorshift 把低位打散。
 */
function hashSeed(s) {
  let h = 2166136261;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // avalanche
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * 从候选池里挑一句，尽量不与「最近发过的」重复。
 *
 * 选择 = FNV(消息文本) + counter，再取模。
 *
 * 为什么要把 counter **加在哈希之后**而不是拼进字符串再哈希：
 * 拼进字符串时 `text#0`…`text#9` 会算出彼此接近甚至相同的哈希，
 * 取模后落到同一个位置，结果就是"轮转失效、永远同一句"——实测踩过。
 * 加在哈希之后保证了 counter 每 +1，挑选位置就前进一格。
 */
function pickVaried(pool, seedBase, counter, recent = []) {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  const recentSet = new Set(recent.slice(-6).map(normalize));
  const fresh = pool.filter((p) => !recentSet.has(normalize(p)));
  const use = fresh.length > 0 ? fresh : pool;

  const idx = (hashSeed(seedBase) + (Number(counter) || 0)) % use.length;
  return { reply: use[idx], variant: idx + 1, poolSize: use.length };
}

/** 复述对方的话：截断，去掉开头的 @某某。 */
function echoOf(text, max = 10) {
  let t = String(text ?? '').replace(/^@\S+\s*/, '').trim();
  if ([...t].length > max) t = [...t].slice(0, max).join('') + '…';
  return t;
}

/**
 * 摘掉消息里 @机器人自己 的那一段（只给判断/复述用，不改原文）。
 *
 * 只能用**已知的**名字来摘（trigger.botNames），不能用 /@\S+/ 这种贪婪写法：
 * 群里真实存在「@示例昵称没有@你的话不用接」这种 @ 后面没空格的句子，
 * 贪婪匹配会把整句一起吃掉，比不摘还糟。
 *
 * 顺带摘掉 @ 在句尾的情况（「你叫啥名字@示例昵称」），
 * 并清掉可能撞在一起的多余空格（"@云出@示例昵称 hi" → " hi"）。
 */
function stripSelfMention(text, cfg) {
  const names = cfg?.trigger?.botNames ?? [];
  let t = String(text ?? '');
  for (const n of names) {
    if (!n) continue;
    const name = String(n);
    t = t.split('@' + name).join(' ');
    t = t.split('＠' + name).join(' ');
  }
  return t.trim();
}

/**
 * 生成降级回复。
 * @param {object} cfg
 * @param {{text:string, sender?:string, mentioned?:boolean, reason?:string,
 *          recentReplies?:string[], counter?:number}} ctx
 */
/**
 * 把一条规则的 match 编译成一个"能不能命中"的判定。
 *
 * 为什么不直接 `new RegExp`：用户是**自己往控制台里写**这一行的，
 * 写错正则（比如 `吃了(`）是常态。这里不抛异常，退化成子串包含 ——
 * 宁可他写了个笨规则能命中，也不要因为一个括号把整条规则变成死代码。
 * 出错信息带出去，控制台会把它显示在那条规则旁边。
 *
 * @returns {{src:string, error:string, test:(text:string)=>boolean}}
 */
export function ruleMatcher(match) {
  const src = String(match ?? '').trim();
  if (!src) return { src, error: '', test: () => false };
  let re = null;
  let error = '';
  try {
    re = new RegExp(src, 'i');
  } catch (e) {
    error = String(e?.message ?? e);
  }
  return {
    src,
    error,
    test: (text) => (re ? re.test(String(text ?? '')) : String(text ?? '').includes(src)),
  };
}

/**
 * 匹配一条配置规则。
 * @returns {null | {reply:string, rule:string, variant:number}}
 */
function tryRules(rules, text, counter, recent) {
  for (const rule of rules ?? []) {
    if (!rule || !rule.match) continue;
    const m = ruleMatcher(rule.match);
    if (!m.test(text)) continue;
    const pool = Array.isArray(rule.replies) && rule.replies.length ? rule.replies
      : (rule.reply ? [rule.reply] : []);
    const r = pickVaried(pool, text, counter, recent);
    if (r && r.reply) {
      return { reply: r.reply, rule: String(rule.match), variant: r.variant };
    }
  }
  return null;
}

/**
 * 试打一句：告诉用户"这句话会被谁接走"。
 *
 * 为什么需要它（用户报的「无法自主增加提示词」的另一半）：
 *   自定义规则的优先级是**可以被内置意图抢走**的 —— 给「在吗」写规则，
 *   greeting 意图先命中，那条规则永远不生效。光看界面看不出来，
 *   只能靠"我写的规则到底算不算数"试一次才知道。
 *   所以这里把两条路（普通语气 / 接管语气）的结果和**规则是否被抢**都报出来。
 *
 * @param {object} cfg
 * @param {{text:string, sender?:string, counter?:number}} ctx
 */
export function previewFallback(cfg, ctx = {}) {
  const text = String(ctx.text ?? '');
  const sender = String(ctx.sender ?? '');
  const counter = Number(ctx.counter) || 0;

  const rules = Array.isArray(cfg?.fallback?.rules) ? cfg.fallback.rules : [];
  // 逐条试，报出"命中的是第几条"（不命中就是 -1）
  let ruleIndex = -1;
  let ruleError = '';
  for (let i = 0; i < rules.length; i++) {
    const m = ruleMatcher(rules[i]?.match);
    if (m.error && !ruleError) ruleError = `${m.src}：${m.error}`;
    if (m.test(text)) { ruleIndex = i; break; }
  }

  const run = (persona) => {
    const r = fallbackReply(cfg, { text, sender, recentReplies: [], counter, persona });
    return {
      reply: r.reply ?? '',
      source: r.source ?? '',
      intent: r.intent ?? '',
      rule: r.rule ?? '',
      variant: r.variant ?? 0,
    };
  };

  return {
    ok: true,
    text,
    rulesFirst: cfg?.fallback?.customRulesFirst === true,
    ruleCount: rules.length,
    ruleIndex,
    ruleError,
    // 规则命中了、但最终回复不是它 → 被内置意图抢走了。这一条最值得提醒。
    ruleShadowed: ruleIndex >= 0 && run(false).source !== 'rule',
    plain: run(null),
    persona: run(cfg?.persona ?? null),
  };
}

/**
 * 生成降级回复。
 * @param {object} cfg
 * @param {{text:string, sender?:string, mentioned?:boolean, reason?:string,
 *          recentReplies?:string[], counter?:number, persona?:object|null}} ctx
 *   ctx.persona —— 传 persona 配置块时按人设语气回（「AI 接管模式」）。
 *                  API 断掉时也能保持可爱语气，不会突然掉回客服腔。
 */
export function fallbackReply(cfg, ctx) {
  const fb = cfg.fallback ?? {};
  if (!fb.enabled) return { reply: '', source: 'disabled' };

  const text = String(ctx?.text ?? '');
  // 判断用的文本要先把「@机器人自己」摘掉。
  //
  // 为什么必须摘：greeting 意图是锚定在行首的（/^(你好|您好|...)/）。
  // 「@示例昵称 你好」不摘前缀就永远匹配不上，打招呼那一池成了死代码 ——
  // 而在「群内只在@时回复」模式下，**100% 的消息都带着这个前缀**。
  // （踩过：@示例昵称 你好 → 掉到复述模板 → 「你好」emmm）
  const stripped = stripSelfMention(text, cfg);
  const flat = normalize(stripped);
  const recent = ctx?.recentReplies ?? [];
  const counter = Number(ctx?.counter) || 0;
  const persona = ctx?.persona ?? null;

  // 生效的池子 = 内置默认 ← 被 config.fallback.pools 覆盖（resolvePools 里合并）
  //              ← 再被 persona 字段覆盖
  // 这样控制台改过的回复能生效，而接管模式仍然优先用可爱的语气池。
  const pools = resolvePools(cfg);
  if (persona) {
    for (const k of Object.keys(PERSONA_DEFAULTS)) {
      const v = persona[k];
      if (Array.isArray(v) && v.length > 0) pools[k] = v;
    }
  }

  /** 意图对应的池子：接管模式换成可爱池，否则用普通池。 */
  const poolForIntent = (intentId, fallbackPool) => {
    if (persona) {
      const pk = PERSONA_POOLS[intentId];
      if (pk && pools[pk]?.length) return pools[pk];
      const genericKey = `persona${intentId.charAt(0).toUpperCase()}${intentId.slice(1)}`;
      if (pools[genericKey]?.length) return pools[genericKey];
    }
    const key = intentId.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    return pools[key]?.length ? pools[key] : fallbackPool;
  };

  // ---- 自定义规则的匹配时机 ----
  // 默认（customRulesFirst 未开）先跑内置意图，再跑配置规则。
  // 但那样的话，你在 config.json 里给「在吗」写规则**不会生效** ——
  // greeting 意图会先把它抢走。想要覆盖内置意图，就打开 customRulesFirst。
  const rulesFirst = fb.customRulesFirst === true;

  if (rulesFirst) {
    const hit = tryRules(fb.rules, text, counter, recent);
    if (hit) return { reply: hit.reply, source: 'rule', rule: hit.rule, variant: hit.variant };
  }

  // 1) 意图分类（具体意图在前，笼统的问句在最后）
  for (const intent of INTENTS) {
    let hit = false;
    try { hit = intent.test(flat); } catch { hit = false; }
    if (hit) {
      const pool = poolForIntent(intent.id, intent.replies);
      const r = pickVaried(pool, text, counter, recent);
      if (r && r.reply) {
        return {
          reply: r.reply, source: 'intent', intent: intent.id,
          variant: r.variant, personaMode: Boolean(persona),
        };
      }
    }
  }

  // 2) 配置里的自定义规则（非 rulesFirst 模式下的位置）
  if (!rulesFirst) {
    const hit = tryRules(fb.rules, text, counter, recent);
    if (hit) return { reply: hit.reply, source: 'rule', rule: hit.rule, variant: hit.variant };
  }

  // 3) 偶尔用带模板的接话（让对方感觉被回应了）
  //
  // 接管模式下跳过模板：persona 的语气池本身就是可爱风格，
  // 而模板文案是「随手打的普通语气」，混进来会破坏人设一致性。
  if (!persona && fb.useTemplates !== false && (hashSeed(text) + counter) % 5 === 0) {
    const usable = TEMPLATED.filter((t) => {
      if (t.need === 'sender') return Boolean(ctx?.sender);
      if (t.need === 'echo') return flat.length >= 2 && (!t.maxLen || flat.length <= t.maxLen);
      return true;
    });
    if (usable.length > 0) {
      const t = usable[(hashSeed(text) + counter) % usable.length];
      const reply = t.text
        .replace('{sender}', String(ctx?.sender ?? '').slice(0, 12))
        // 复述的是**摘掉自己@之后**的话，不然会出现「@示例昵称 吃了吗…让我想想」
        .replace('{echo}', echoOf(stripped));
      if (normalize(reply) && !recent.map(normalize).includes(normalize(reply))) {
        return { reply, source: 'template' };
      }
    }
  }

  // 4) 通用兜底
  //
  // 接管模式下必须优先用**可爱池**，否则就掉回客服腔 —— 那正是这个项目
  // 一开始要避免的事（"API 断了语气突然从「诶嘿」变成「收到，我看看」"）。
  //
  // ⚠ 这里踩过一个**只在默认配置下才暴露**的坑（2026-10-06 发现并修）：
  //   池子有两个来源，键名不一样：
  //     · `pools.fallbackGeneric` —— persona 配置里**手写**的那份（可选）
  //     · `pools.personaGeneric`  —— 代码里的内置可爱池（BUILTIN_POOLS）
  //   老代码只看前者，后者压根没查。于是**没单独写过 persona.fallbackGeneric 的
  //   配置，接管模式就一直用的是普通 GENERIC 池**（实测取到"收到 / 在忙，等下"）。
  //   开发机上为什么没发现：那份 config.json 里有 `fallback.generic`（16 条，
  //   内容恰好和内置 GENERIC 一样）把问题盖住了，断言照样全绿 —— **假绿**。
  //   删掉那份覆盖（导出发布包时的默认配置）之后才露出来。
  const fallbackGeneric = (Array.isArray(fb.generic) && fb.generic.length) ? fb.generic : GENERIC;
  const genericPool = persona
    ? (pools.fallbackGeneric?.length
      ? pools.fallbackGeneric                      // 1. 用户手写的接管语气池
      : (pools.personaGeneric?.length
        ? pools.personaGeneric                     // 2. 代码里的内置可爱池 ← 老代码漏了这一档
        : fallbackGeneric))                        // 3. 实在没有才退回普通池
    : (pools.generic?.length ? pools.generic : fallbackGeneric);
  const r = pickVaried(genericPool, text, counter, recent);
  if (r && r.reply) {
    return { reply: r.reply, source: 'generic', variant: r.variant, personaMode: Boolean(persona) };
  }

  return { reply: String(fb.defaultReply ?? '嗯嗯'), source: 'default' };
}

/** 截断到配置的最大长度，按字符（中文按字算）。 */
export function clampReply(text, maxChars, prefix = '') {
  let out = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (prefix) out = prefix + out;
  const max = Number(maxChars) || 0;
  if (max > 0 && [...out].length > max) {
    out = [...out].slice(0, max).join('');
  }
  return out;
}
