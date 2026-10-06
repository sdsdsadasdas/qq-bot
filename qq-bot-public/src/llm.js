/**
 * llm.js — 大模型回复生成（DeepSeek，OpenAI 兼容协议）。
 *
 * 关键设计：**任何失败都不抛异常，只返回 ok:false**。
 * 因为需求 2 要求「API 并未调用时」仍能回复，调用方拿到 ok:false 后走本地规则降级。
 * 失败原因分类保留，便于日志排查：timeout / http / network / no-key / disabled。
 */

const FAIL = (reason, detail, extra = {}) => ({ ok: false, reason, detail: String(detail ?? ''), ...extra });

/**
 * 这个进程里**真的发出去过**多少次 API 请求。
 *
 * 为什么要数它：人生模拟的触发条件是「这段时间里一次 API 都没调用过」
 * （见 life.js 的 createLifeTicker / bot.js 主循环）。判断依据必须是
 * 「有没有真的发请求」，而不是"有没有人想发" —— 没配 key、被开关挡下、
 * 服务连不上，这些都不算调用过，否则空闲时它永远不会去过日子。
 *
 * 所以埋点在**唯一那个 fetch 之前**（chatOnce），全项目只有这一处发请求。
 * 回复、记忆整理、人生模拟、控制台探测都从这里过，不会漏也不会重复计。
 */
export const apiCallStats = { total: 0, lastAt: 0 };

/**
 * 底层：发一次 chat/completions。
 *
 * 抽出来是因为现在有**两种**调用：生成回复、整理记忆。
 * 它们共用端点/鉴权/超时/错误分类这些最容易写歪的东西 ——
 * 复制一份的话，改了一处忘了另一处（本项目已经踩过好几次同类坑）。
 *
 * 和 generateReply 一样：**任何失败都不抛**，只返回 ok:false。
 *
 * @param {object} cfg
 * @param {{messages:Array, maxTokens?:number, temperature?:number,
 *          timeoutMs?:number, model?:string, jsonMode?:boolean}} opts
 * @returns {Promise<{ok:boolean, content?:string, reason?:string, detail?:string,
 *                    ms?:number, model?:string, usage?:object}>}
 */
export async function chatOnce(cfg, opts = {}) {
  const c = cfg.llm ?? {};
  if (!c.enabled) return FAIL('disabled', 'config.llm.enabled=false');
  // 本地推理服务（Ollama / LM Studio / llama.cpp / vLLM …）通常不校验 key，
  // 所以"要不要 key"由 provider.requiresKey 说了算（见 config.js 的 resolveProvider）。
  // 以前这里一刀切，接本地 API 会直接以 no-key 失败，而报错完全指不到真正的原因。
  if (!c.apiKey && c.apiKeyRequired !== false) {
    return FAIL('no-key', `缺少 API key（config.llm.apiKey 或环境变量 ${c.apiKeyEnv ?? 'DEEPSEEK_API_KEY'}）`);
  }

  const baseUrl = String(c.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;
  const timeoutMs = opts.timeoutMs ?? c.timeoutMs ?? 20000;
  // timeoutMs <= 0 = **不设超时**，一直等到服务返回。
  //
  // 为什么需要这一档：本地 CPU 推理跑「人生模拟」那种长提示词要几分钟，
  // 而 120 秒的超时表现是"每次都失败、日志里只有一行 warn" —— 用户看到的现象
  // 是"这个功能根本不动"，而且完全指不到超时头上。与其把数字往上顶（顶到多少都
  // 可能不够），不如给一个明确的"不超时"。
  //
  // 安全性：人生模拟是**后台单飞**跑的（bot.js 一次只允许一个在跑），
  // 所以就算请求永远挂着，后果也只是"生活日志不再增长"，扫描和回复照常。
  // 回复和记忆整理仍然各自有超时 —— 它们是要等结果的，不能无限挂。
  const noTimeout = !(Number(timeoutMs) > 0);

  const body = {
    model: opts.model ?? c.model ?? 'deepseek-chat',
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? c.maxTokens ?? 300,
    temperature: opts.temperature ?? c.temperature ?? 1.0,
    stream: false,
  };
  // json_object 让模型必须吐合法 JSON。整理记忆时非常有用 ——
  // 但**不是所有厂商/模型都支持**，不支持会直接 400。
  // 所以做成开关（config.memory.jsonMode），并且在 400 时把话说清楚。
  // 本地小模型尤其容易不支持，用了本地 API 记得留意这一条。
  if (opts.jsonMode) body.response_format = { type: 'json_object' };

  // 关闭“思考模式”（部分推理模型支持，如 Qwen3）。
  // 不关掉的话，模型会把 max_tokens 全花在 reasoning_content 上，
  // 正文 content 返回空字符串，看起来就像“模型没回话”。
  // 优先级：调用方 opts.enableThinking > 厂商 config.enableThinking。
  //   false -> 明确关闭；true -> 明确开启；undefined -> 用厂商设置
  // 这样记忆整理/人生模拟这类“输出 JSON”的任务可以单独关掉思考，
  // 而聊天回复照常开启。
  const thinking = opts.enableThinking ?? c.enableThinking;
  if (thinking === false) {
    body.chat_template_kwargs = { enable_thinking: false };
  } else if (thinking === true) {
    body.chat_template_kwargs = { enable_thinking: true };
  }

  // 有 key 才带 Authorization 头。
  // 空 key 也硬发一个 `Bearer ` 会让部分本地服务直接 400，
  // 而它们本来就不需要这个头。
  const headers = { 'Content-Type': 'application/json' };
  if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`;

  // noTimeout 时不建 AbortController，也不挂定时器 —— 不是"挂一个很大的数"，
  // 是真的没有超时这回事（一个很大的数早晚也会到）。
  const controller = noTimeout ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const started = Date.now();

  // 到这里才算"真的调用了一次 API"：前面的开关/key 检查都还没发请求。
  // 见 apiCallStats 的注释 —— 人生模拟靠这个数判断空闲与否。
  apiCallStats.total++;
  apiCallStats.lastAt = started;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });

    const ms = Date.now() - started;

    if (!res.ok) {
      let text = '';
      try { text = (await res.text()).slice(0, 400); } catch {}
      // 400 + jsonMode 是最容易踩的一个：模型/厂商不支持 response_format
      const hint = (res.status === 400 && opts.jsonMode && !/response_format/i.test(text))
        ? `（提示：可能是模型不支持 response_format，把 config.memory.jsonMode 设成 false 试试）`
        : '';
      return FAIL('http', `HTTP ${res.status} ${res.statusText} ${text}${hint}`, { ms });
    }

    let data;
    try { data = await res.json(); } catch (e) {
      return FAIL('parse', `响应不是合法 JSON: ${e.message}`, { ms });
    }

    const choice = data?.choices?.[0] ?? {};
    const content = choice?.message?.content;
    // 推理模型（DeepSeek-R1 系、Qwen3、各种蒸馏版）会先吐一段思考放在
    // reasoning_content 里，正文才在 content。
    //
    // ⚠ 这里踩过一个很坑的坑：本地跑推理模型时，max_tokens 给小了，
    //   思考就把预算吃光，content 直接是 null —— 于是项目判 empty、
    //   静默降级成本地固定回复，用户看到的现象是"本地服务没联通"。
    //   实测：max_tokens=16 → content=null, reasoning_content="用户说…所以我应该…"，
    //        max_tokens=200 → content="收到"。
    //
    // 所以这两种情况要**分开报**，而且给的动作要具体（调大 maxTokens）。
    // 另外：绝不能拿 reasoning_content 当回复 —— 那是模型的内心独白，
    // 发到群里等于把思维链泄出去了。
    const reasoning = choice?.message?.reasoning_content;
    const hasReasoning = typeof reasoning === 'string' && reasoning.trim() !== '';

    if (typeof content !== 'string' || content.trim() === '') {
      if (hasReasoning || choice?.finish_reason === 'length') {
        const budget = opts.maxTokens ?? c.maxTokens ?? 300;
        return FAIL('reasoning-only',
          `模型把 ${budget} tokens 全用在"思考"上了，正文一个字的没剩下`
          + `（finish_reason=${choice?.finish_reason ?? '?'}）。`
          + `这是个推理模型：把 config.json 的 llm.maxTokens 调大（本地推理模型建议 800~2000）。`
          + '注意别把它的思考当回复发出去，所以这里不兜底。',
          { ms, model: data?.model ?? body.model, usage: data?.usage, reasoning: String(reasoning ?? '').slice(0, 200) });
      }
      return FAIL('empty', '模型返回空内容', { ms, model: data?.model ?? body.model, usage: data?.usage });
    }

    return {
      ok: true, content: content.trim(), ms, model: data?.model ?? body.model, usage: data?.usage,
      // 顺便把思考带回去，日志/探测里能看出来"这是个推理模型"
      hadReasoning: hasReasoning,
    };
  } catch (err) {
    const ms = Date.now() - started;
    if (err?.name === 'AbortError') return FAIL('timeout', `超过 ${timeoutMs}ms 未返回`, { ms });
    return FAIL('network', err?.message ?? String(err), { ms, cause: err?.cause?.code ?? '' });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 组装发给模型的对话（导出是为了能单独测试轮次结构）。
 *
 * 上下文这块是本项目最容易做浅的地方（踩过两次）：
 *
 * 1. 早期只把「屏幕上可见的那几条」拼进去，滚出画面就没了，
 *    于是模型经常接不上话、反复问已经说过的事。
 *    现在消息来自 UIA 无障碍树（Chromium 会把滚出视口上方的内容也暴露出来，
 *    坐标为负），**并且跨轮累积进 state.history** —— 因为渲染范围有限，
 *    连机器人自己发的话也会滚出去，光靠一屏读不全。
 *
 * 2. 更早的版本把历史全塞进一条 user 消息，自己说过的话写成「我：xxx」。
 *    那样模型是在"读别人转述的对话记录"，不是在"延续自己的对话"。
 *    现在自己的话渲染成**真正的 assistant 轮次**，模型才能保持前后一致。
 */
/**
 * 消息格式说明（追加在 system 末尾，不写进用户的 persona 文本）。
 *
 * 为什么需要它（换小模型之后暴露的）：
 *   历史消息原来是 `昵称：内容` 拼的，而**解析出来的内容本身还粘着发送者**：
 *   实测 UIA 读到的正文以时间戳开头，紧跟发送者昵称、然后是 @ 和真正的内容，
 *   整条连在一起没有任何分隔。于是提交给 API 的成了
 *       「群主：20:55 + 昵称 + @某某 + 正文」
 *   名字出现两次、哪里是名字哪里是内容全糊在一起。大模型还能猜，小模型直接懵。
 *   改成 `昵称|内容` 之后，竖线给了模型一个**明确的分界符**，名字里带什么都不影响。
 *
 * ⚠ 这段注释里刻意不写那个真实昵称：它中间含「星号加斜杠」，写进块注释会
 *   提前把注释闭合掉，整个文件报语法错（这个坑这个项目踩过四次）。
 *
 * 放在 system 末尾而不是用户那一轮：system 是稳定前缀，能命中提示词缓存
 * （本项目实测命中约 0.003/M、未命中约 0.15/M），而这个说明每轮都一样。
 */
const HISTORY_FORMAT_NOTE = [
  '',
  '【消息格式】',
  '别人说的话按「时间|称号|昵称|内容」给出，一行 4 段，用竖线隔开：',
  '  第 1 段 = 发消息的时间（时:分），拿不到就是 -',
  '  第 2 段 = 群称号/头衔，没有就是 -',
  '  第 3 段 = 说话人的昵称（名字里带什么都不要紧，竖线是硬边界）',
  '  第 4 段 = 他真正说的话，只看最后一段',
  '所以「-|-|小明|在吗」的意思是：小明在「在吗」这句话里没带时间和称号。',
  '你自己说过的话不带这些前缀，直接就是内容。',
].join('\n');

/** 提示词里的空字段渲染成 '-'（见 HISTORY_FORMAT_NOTE）。 */
const field = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? '-' : s;
};

/** 把一条 incoming 消息渲染成 `时间|称号|昵称|内容`。 */
export function renderIncomingLine(h) {
  const who = h?.sender || h?.senderWithTitle || '某人';
  return `${field(h?.time)}|${field(h?.title)}|${who}|${String(h?.text ?? '')}`;
}

export function buildMessages(cfg, ctx) {
  const sys = (ctx?.systemPrompt
    || cfg.llm?.systemPrompt
    || '你是QQ上的一个用户，口语化简短回复，不要自称AI。') + HISTORY_FORMAT_NOTE;

  const history = Array.isArray(ctx.history) ? ctx.history : [];
  const window = history.slice(-(cfg.llm?.contextMessages ?? 16));

  const messages = [{ role: 'system', content: sys }];

  // 把历史拆成多轮：别人说的话攒成一条 user，自己说的话是 assistant。
  // 连续的 incoming 合并，避免产生大量碎片轮次。
  let pendingIncoming = [];
  const flushIncoming = () => {
    if (pendingIncoming.length === 0) return;
    messages.push({ role: 'user', content: pendingIncoming.join('\n') });
    pendingIncoming = [];
  };

  for (const h of window) {
    const text = String(h.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (h.side === 'self') {
      flushIncoming();
      // 连续多条**一模一样**的自述只保留一条。
      //
      // 为什么：实测机器人卡在复读时，历史里会积下三条相同的 assistant 消息
      // （「困到睡着了 (´·ω·`)」×3）。模型看到自己重复，就接着重复 ——
      // 提示词里写明「不要复述」也压不住。把重复的自述折叠掉，
      // 相当于拆掉它用来"续写"的样板，比在提示词里加规则可靠得多。
      //
      // ⚠ 必须**回溯找最近一条 assistant**再比较，不能只看 messages 的最后一条：
      //   重复的自述之间夹着 user 消息（[self][other][self][other][self]），
      //   拿 messages.at(-1) 比会永远不相等 —— 第一版就是这么写的，没生效。
      let lastSelf = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') { lastSelf = messages[i]; break; }
      }
      if (lastSelf && lastSelf.content === text) continue;
      messages.push({ role: 'assistant', content: text });
    } else {
      // 竖线分隔，不要用冒号：见 HISTORY_FORMAT_NOTE 的注释 ——
      // 正文里常常粘着昵称，冒号根本分不出边界。
      // 时间/称号也各占一段（用户要求）：小模型不需要去正文里翻"这人是谁、几点说的"。
      pendingIncoming.push(renderIncomingLine(h));
    }
  }

  // 当前要回的那条，接在同一轮 user 里，而不是另起一轮。
  // 两条连续的 user 轮次在部分 API 上是合法的但语义含糊 ——
  // 模型容易分不清哪句是"历史"、哪句是"要我回的那条"。
  const tail = [];
  // 要回的这一条也用同一种格式（时间|称号|昵称|内容），跟 system 里的说明、
  // 跟历史完全一致 —— 三种写法混用正是"模型分不清哪部分是名字"的来源。
  // @ 的提示单独一行。
  if (ctx.mentioned) tail.push('（这条 @ 了你）');
  tail.push(renderIncomingLine(ctx));
  tail.push('');
  // 收尾指示也放同一轮里。之前单独 push 成一条 user 消息，
  // 导致末尾出现多余的轮次（测试断言"只有 1 条 user"时抓到的）。
  tail.push('直接给出你要打的那句话。');

  // ---- 记忆放在最后一轮 user 的**开头** ----
  //
  // 为什么不能塞进 system：DeepSeek 是按**前缀**命中缓存的
  // （本项目实测：命中约 0.003/M，未命中约 0.15/M，差 50 倍）。
  // 记忆每轮都在变，放进 system 会让整个可缓存前缀作废 ——
  // 那是这个项目里最贵的一处改法。放在历史之后（非前缀部分），
  // system 那 256 token 照样命中。
  //
  // 为什么不另起一条 user 消息：连续两条 user 轮次语义含糊（见上面那段注释），
  // 而且会破坏既有测试里「只有 1 条 user」的断言。
  //
  // 空记忆不注入：不要往提示词里塞「（暂无记忆）」，白花 token 还会让模型
  // 无端提起"我还没有记忆"。
  const memBlock = ctx?.memoryDigest ? [String(ctx.memoryDigest), ''] : [];
  // 生活日志（人生模拟的产物）也放在这里，跟着记忆一起走。
  // 放同一处的理由完全一样：它每轮都在变，进 system 会把可缓存前缀作废。
  const lifeBlock = ctx?.lifeDigest ? [String(ctx.lifeDigest), ''] : [];

  if (pendingIncoming.length > 0) {
    pendingIncoming.push('');
    pendingIncoming.push('现在需要你回复最后这一条：');
    pendingIncoming.push(...tail);
    messages.push({ role: 'user', content: [...memBlock, ...lifeBlock, ...pendingIncoming].join('\n') });
    pendingIncoming = [];
  } else {
    // 历史为空（比如刚启动、第一轮）时也要能正常回
    messages.push({ role: 'user', content: [...memBlock, ...lifeBlock, '现在需要你回复这一条：', ...tail].join('\n') });
  }

  return messages;
}

/**
 * 调用大模型生成回复。
 * @param {object} cfg
 * @param {{text:string, sender?:string, mentioned?:boolean, history?:Array}} ctx
 * @returns {Promise<{ok:boolean, reply?:string, reason?:string, detail?:string, ms?:number}>}
 */
export async function generateReply(cfg, ctx) {
  const r = await chatOnce(cfg, { messages: buildMessages(cfg, ctx) });
  if (!r.ok) return r;
  return { ok: true, reply: r.content, ms: r.ms, model: r.model, usage: r.usage };
}

/**
 * 让模型提出一份「记忆差异」。
 *
 * 为什么单独一次调用，而不是让回复那次顺便吐 JSON：
 *   · 回复是要直接发到群里的。任何格式负担都可能让它把
 *     「MEMO: {...}」这种残留发出去 —— 在真群里一眼假，代价太大。
 *   · 记忆整理要的是低温度、结构化输出，跟聊天的参数正好相反。
 *   · 失败时互不影响：整理记忆挂了，回复照发。
 *
 * 代价是每次回复多一次请求。config.memory.updateEvery / updateMinIntervalMs
 * 可以调成「每 N 次更新一次」来省。
 *
 * 只收**变化**（差异），不收整份记忆：让模型重写全文的话，
 * 字段会被漏抄、格式会被改坏、output token 还会翻好几倍。
 *
 * @param {object} cfg
 * @param {{memoryJson:string, transcript:string}} ctx
 * @returns {Promise<{ok:boolean, patch?:object, reason?:string, detail?:string, ms?:number, usage?:object}>}
 */
export async function generateMemoryPatch(cfg, ctx) {
  const m = cfg.memory ?? {};
  const conversation = String(ctx?.conversation ?? '').trim();

  const system = [
    '你是一个「记忆整理器」。你只输出 JSON，不输出任何解释、前后缀或代码块标记。',
    '',
    '你要读**两层**记忆和刚刚发生的一小段对话，输出这次要改的地方。',
    '',
    '两层的区别是「换个人聊还成不成立」：',
    '  · global       —— 不分局的。我是谁、我喜欢什么、我讨厌什么。',
    '  · conversation —— 只在**这个会话**里成立的。',
    `                     在这里的心情、在这里经历的事、和这里的人的关系、聊过的话题。`,
    '  判断方法：如果这条信息只对"当前这个会话"有意义（提到具体某个人、某件事），',
    '  写进 conversation；如果是关于我自己的、换谁都成立，写进 global。',
    '',
    '规则：',
    `1. conversation.mood 是必填的。读完这段对话，你在这个会话里是什么心情？`,
    '   哪怕只是普通闲聊也要给一个。心情要跟着对话变（被夸了会高兴、',
    '   被嘲笑了会不服、被连着追问会有点烦）。label 用 2~6 个字，why 一句话说清。',
    '2. 其它字段只写**变化**。记忆里已经有的，不要重复写。',
    '3. 不要编造。记忆里没有、对话里也没出现的事，一个字都不许加。',
    '4. 「经历」只在真的发生了一件事时才记。日常寒暄、单纯打招呼不用记。',
    '5. 「关系」的 name 必须是对话里**真实出现过的昵称**。',
    '   绝对不要写「某人」「群友」「对方」这种占位名 —— 那说明你根本不知道是谁，就别记。',
    '   也不要写我自己的名字（那是我，不是别人）。',
    '6. 「话题」要是有内容的（聊了什么正事），不要写「打招呼」「闲聊」这种空词。',
    '7. 每条尽量短（20 字以内）。',
    '',
    '输出结构（conversation.mood 必须有，其余字段没有变化就省略）：',
    '{',
    '  "global": {',
    '    "addFacts": ["关于我自己的事实"],',
    '    "addLikes": ["新发现的喜欢"],',
    '    "removeLikes": ["不再喜欢的"],',
    '    "addDislikes": ["新发现的不喜欢"]',
    '  },',
    '  "conversation": {',
    '    "mood": { "label": "简短心情词", "why": "为什么" },',
    '    "addEvents": [ { "text": "发生了什么", "who": "跟谁" } ],',
    '    "relations": [ { "name": "这里某个人的昵称", "role": "群主/管理员/群友", "note": "你俩什么关系" } ],',
    '    "addTopics": ["在这里聊过的话题"]',
    '  }',
    '}',
  ].join('\n');

  const user = [
    `【当前会话】${conversation || '(未知)'}`,
    '',
    '【总记忆（不分局的，已经有这些，不要重复写）】',
    ctx.globalJson || '{}',
    '',
    `【这个会话的记忆（${conversation || '未知'}，已经有这些，不要重复写）】`,
    ctx.conversationJson || '{}',
    '',
    '【刚刚发生的对话（最后一行是你刚发出去的话）】',
    // 格式跟回复那边一致：`昵称|内容`。不写这一句的话，整理器会把
    // 竖线左边的昵称当成内容的一部分（「关系」字段就会记出歪名字）。
    '（每行的格式是「时间|称号|昵称|内容」共 4 段：最后一段才是他说的话，',
    '  昵称里的怪字符不影响分段；「你」表示你自己说的话。）',
    ctx.transcript || '（无）',
    '',
    '现在输出记忆差异 JSON。',
  ].join('\n');

  const r = await chatOnce(cfg, {
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    maxTokens: m.maxTokens ?? 400,
    temperature: m.temperature ?? 0.2,
    timeoutMs: m.timeoutMs ?? 60000,
    model: m.model || undefined,       // 想省钱可以给记忆整理单独配个便宜模型
    // 注意：这里**不**覆盖 enableThinking，跟随厂商设置。
    // 实测开思考后记忆提取更细（把三个活动拆成三条独立事实，而不是揉成一条），
    // JSON 也能正常解析。代价是耗时从 5.3s 涨到 19s，所以 timeoutMs 必须够大。
    // jsonMode 要**两层都同意**才开：config.memory.jsonMode 和 provider.jsonMode。
    // 本地推理服务（尤其 llama.cpp 的语法约束 + 推理模型）会 502
    // structured_output_failed，所以 provider 那边可以单独关掉。
    jsonMode: m.jsonMode !== false && cfg.llm?.jsonMode !== false,
  });
  if (!r.ok) return r;

  const patch = parseJsonLoose(r.content);
  if (!patch) return FAIL('bad-json', `整理器返回的不是 JSON：${r.content.slice(0, 160)}`, { ms: r.ms });
  return { ok: true, patch, ms: r.ms, usage: r.usage, raw: r.content };
}

/**
 * 人生模拟的默认提示词。config.life.prompt 可以整段覆盖（数组，一行一项）。
 *
 * 写法上刻意压住三件事，都是这类"让模型演一个人"最容易翻车的地方：
 *   · 别写成小说 —— 一旦放开，它会编地点、天气、配角，然后前后矛盾
 *   · 必须接着上一条往下走 —— 否则半小时后还在"正在吃饭"
 *   · 别提聊天/消息/AI —— 这是它自己的生活，不是"我在等消息"
 */
export const DEFAULT_LIFE_PROMPT = [
  '你在推演一个**真人**此刻的生活状态，不是在写小说，也不是在回复任何人。',
  '',
  '根据下面给出的人设和记忆，推断这个人现在这一刻最可能在做什么、在想什么、心情如何。',
  '',
  '要求：',
  '· 要是普通人的日常：吃饭、躺着刷手机、发呆、打游戏、犯困、走神、买东西、赶路',
  '· 具体一点，但别编多余细节（不要写地点、天气、配角、对话）',
  '· 要和「最近在做的事」**接得上**：刚才在吃饭，现在该是吃完了、在刷手机，',
  '  而不是又一次「正在吃饭」',
  '· 但生活得**真的在走**：同一个状态别连着写三四次。刷手机刷久了会起身、',
  '  会去倒水找吃的、会犯困睡着、会被窗外的动静吸引打断 ——',
  '  每次至少推进一点点，别一直停在同一个动作上',
  '  （推进的是"小事"，不是编大事：不要地点、天气、配角、对话）',
  '· 时间要对得上：半夜就别写"在公司开会"，凌晨就别写"在忙工作"',
  '· 不要提到聊天、消息、回复、AI、模型、程序',
  '· 不要输出任何要发给别人的话（分享的那句除外，见下）',
  '',
  '另外还要判断一件事：**此刻值不值得主动在群里冒个泡**。',
  '注意这是没人跟你说话的时候，你自己想不想说 —— 门槛要高，但也不是哑巴：',
  '· 日常状态（在刷手机、在发呆、在等饭、犯困）→ false，这些没什么好说的',
  '· 深夜或凌晨一律 false（这个点在群里说话很怪）',
  '· **有个具体由头就可以说**：泡面/外卖好了、手机快没电了、突然特别想吃某样东西、',
  '  被窗外或手机里的什么吸引住、莫名想起一件旧事、心情有明显起伏',
  '· 由头不一定来自外面 —— **脑子里冒出来的念头也算**：突然想吃什么、',
  '  突然想起个梗、单纯想说句话。真人就是这样，不是非要发生点什么才开口；',
  '  你 thinking 里那句想头，往往就是能直接说出口的那句',
  '· 但"报个状态"不算（在刷手机、在发呆、困了）—— 群里没人关心这个',
  '· 说 true 就得给一句**真人在群里随口说的话**：短、口语、',
  '  不要 @ 任何人、不要提问、不要等别人回应、不要解释你为什么说这个',
  '',
  '只输出 JSON，不要解释、不要代码块标记：',
  '{',
  '  "mood": "此刻心情，2~6 个字",',
  '  "doing": "此刻在做什么，20 字以内",',
  '  "thinking": "此刻在想什么，20 字以内，没什么可写就给空字符串",',
  '  "share": { "suitable": false, "why": "为什么，10 字以内", "text": "要说的话，suitable 为 true 时才给，30 字以内" }',
  '}',
].join('\n');

/** 把「上一次记录到现在隔了多久」说成人话。 */
function humanGap(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分钟前`;
}

/**
 * 组装人生模拟那一次的提示词。
 *
 * 导出是为了能单独测「给了哪些设定」—— 用户的需求原话是
 * 「通过给定的提示词以及设定推测真人行为」，所以"设定到底进没进去"
 * 是这件事的核心，必须有断言盯着。
 *
 * @param {object} cfg
 * @param {{now?:number, persona?:string, memoryDigest?:string, lifeDigest?:string,
 *          lastAt?:number, conversation?:string}} ctx
 */
export function buildLifeMessages(cfg, ctx = {}) {
  const now = Number(ctx.now) || Date.now();
  const custom = Array.isArray(cfg?.life?.prompt) ? cfg.life.prompt.filter((s) => typeof s === 'string' && s.trim()) : [];
  const system = custom.length ? custom.join('\n') : DEFAULT_LIFE_PROMPT;

  const d = new Date(now);
  const when = d.toLocaleString('zh-CN', {
    hour12: false, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', weekday: 'long',
  });
  const hour = d.getHours();
  // 把"现在是几点"说成一句人能直接用的话：模型对"23:40"的判断力
  // 远不如对"深夜"的判断力（它经常让这个人大中午的在睡觉）。
  const period = hour < 5 ? '凌晨（该睡了）'
    : hour < 9 ? '早上'
      : hour < 12 ? '上午'
        : hour < 14 ? '中午'
          : hour < 18 ? '下午'
            : hour < 23 ? '晚上' : '深夜（该睡了）';

  const user = [
    `【现在的时间】${when}（${period}）`,
    '',
    '【你的人设（你是谁）】',
    String(ctx.persona ?? '').trim() || '（没写人设，就按一个普通的年轻人来）',
    '',
    '【你记得的事】',
    String(ctx.memoryDigest ?? '').trim() || '（暂时没什么记忆）',
    '',
    '【你最近在做什么】',
    String(ctx.lifeDigest ?? '').trim() || '（还没有记录，这是第一次）',
    ctx.lastAt ? `\n上一次记录是${humanGap(now - Number(ctx.lastAt))}。` : '',
    '',
    // 分享那句会被**真的发到这个群里**，所以谁是听众必须说清楚 ——
    // 不写的话模型不知道自己在哪儿，容易说出"大家好我是新来的"这种话。
    `【你现在在哪个群】${String(ctx.conversation ?? '').trim() || '（不知道，就当是个普通群）'}`,
    '（share.text 会被真的发出去，宁可不发也别硬凑；suitable 是 false 时 text 留空即可。）',
    '',
    '现在推演：此刻你在做什么？并且判断这会儿值不值得在群里说一句。输出 JSON。',
  ].join('\n');

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/**
 * 人生模拟：让模型推演「此刻这个人在干什么、想什么、心情如何」，
 * 并判断「这会儿值不值得在群里说一句」。
 *
 * ⚠ 推演结果只进生活日志（life.json）；分享那句要不要真发，
 *   由 life.js 的 decideShare() 说了算，这里只是让模型**提议**。
 *
 * 格式要求比回复松一点：模型只给一句自然语言也收，
 * 由 life.js 的 sanitizeLifeEntry 兜成一条"在做的事"。
 *
 * @returns {Promise<{ok:boolean, entry?:object|string, reason?:string, detail?:string, ms?:number}>}
 */
export async function generateLifeSimulation(cfg, ctx = {}) {
  const l = cfg?.life ?? {};
  const r = await chatOnce(cfg, {
    messages: buildLifeMessages(cfg, ctx),
    maxTokens: l.maxTokens ?? 600,
    temperature: l.temperature ?? 1,
    timeoutMs: l.timeoutMs ?? 120000,
    model: l.model || undefined,
    // 同样跟随厂商的 enableThinking（不覆盖）。
    // 默认**不开** json_object：本地推理模型 + llama.cpp 的语法约束会 502
    // structured_output_failed（记忆整理那边实测过）。要开得显式写 true。
    jsonMode: l.jsonMode === true && cfg?.llm?.jsonMode !== false,
  });
  if (!r.ok) return r;

  const parsed = parseJsonLoose(r.content);
  // 半截 JSON 不能当成"一句话"收下。
  //
  // 实测：本地推理模型 + max_tokens 给小了，输出会在 JSON 中间被切断
  //（`{"mood":"困到发懵","doing":"...","share":{"suitable":false,"why":"困着没啥说","text":""` ← 就断在这儿）。
  // 那时 parseJsonLoose 必然失败，而"宽容地当成一句话"会把半截 JSON 当成
  // 「在做的事」写进生活日志 —— 日志里出现一条 {"mood":"... 的记录，比不写还糟。
  // 所以：看起来是 JSON（以 { 开头）却解析不出来 = 这次失败，什么都不记。
  // 只有**确实不是 JSON**（本地小模型常见的"只回一句话"）才走宽松那条路。
  if (!parsed && /^\s*\{/.test(String(r.content ?? ''))) {
    return FAIL('bad-json', `模型输出像是被截断了（JSON 不完整）：${r.content.slice(0, 120)}`, { ms: r.ms, raw: r.content });
  }

  return {
    ok: true,
    // 解析不出来就把原文交出去（sanitizeLifeEntry 认得字符串）
    entry: parsed ?? r.content,
    ms: r.ms,
    usage: r.usage,
    raw: r.content,
    hadReasoning: r.hadReasoning,
  };
}

/**
 * 宽容地解析模型返回的 JSON。
 *
 * 就算开了 json_object，模型偶尔还是会给 ```json 围栏或在前后加一句话。
 * 这里逐层退让：直接解析 → 剥围栏 → 取第一个 { 到最后一个 }。
 * 全都失败返回 null（调用方当成「这次没更新」，而不是崩）。
 */
export function parseJsonLoose(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;

  const tryParse = (t) => {
    try {
      const v = JSON.parse(t);
      return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
    } catch { return null; }
  };

  const direct = tryParse(s);
  if (direct) return direct;

  const unfenced = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const fromFence = tryParse(unfenced);
  if (fromFence) return fromFence;

  const a = unfenced.indexOf('{');
  const b = unfenced.lastIndexOf('}');
  if (a >= 0 && b > a) return tryParse(unfenced.slice(a, b + 1));

  return null;
}

/**
 * 问一个 OpenAI 兼容服务「你有哪些模型」。
 *
 * 用途：控制台上的「检测本地服务」按钮。本地推理服务的模型名是用户自己拉的
 * （ollama pull qwen2.5:7b 之类），猜不得；让它自己报最省事。
 *
 * 不抛异常 —— 探测失败是**正常结果**（服务没开、地址写错），
 * 调用方按 ok:false 显示原因。
 *
 * @param {string} baseUrl 形如 http://127.0.0.1:11434/v1
 * @returns {Promise<{ok:boolean, models:string[], error?:string, ms:number}>}
 */
export async function listModels(baseUrl, { apiKey = '', timeoutMs = 5000, fetchImpl = globalThis.fetch } = {}) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  const started = Date.now();
  if (!base) return { ok: false, models: [], error: '没填地址', ms: 0 };

  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;   // 本地服务通常不需要

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/models`, { headers, signal: controller.signal });
    const ms = Date.now() - started;
    if (!res.ok) {
      let text = '';
      try { text = (await res.text()).slice(0, 200); } catch { /* 忽略 */ }
      return { ok: false, models: [], error: `HTTP ${res.status} ${res.statusText} ${text}`.trim(), ms };
    }
    let data;
    try { data = await res.json(); } catch (e) {
      return { ok: false, models: [], error: `响应不是合法 JSON：${e.message}`, ms };
    }
    // OpenAI 形状：{ data: [{ id: 'model-name' }, ...] }
    // Ollama 的 /v1/models 也是这个形状。有的服务直接给数组，也一并认。
    const arr = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
    const models = arr
      .map((m) => (typeof m === 'string' ? m : (m?.id ?? m?.name ?? '')))
      .map((s) => String(s).trim())
      .filter(Boolean);
    return { ok: true, models, error: models.length ? undefined : '服务通了，但没报出任何模型', ms };
  } catch (e) {
    const ms = Date.now() - started;
    const code = e?.cause?.code ?? e?.code ?? '';
    const error = e?.name === 'AbortError'
      ? `超过 ${timeoutMs}ms 没响应`
      : (code === 'ECONNREFUSED' ? '连不上（服务没启动？地址或端口不对？）' : (e?.message ?? String(e)));
    return { ok: false, models: [], error, ms };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 完整探测一个厂商到底能不能**真的用来聊天**。
 *
 * 为什么不能只查 /models（实测被它骗过）：
 *   用户的 llama.cpp 服务 /v1/models **不需要 key**，而 /v1/chat/completions
 *   需要。于是探测显示"通了，1 个模型"，实际每句话都 401 ——
 *   用户看到的控制台提示是"✓ 通了"，机器人却一个字都没回过，
 *   反馈完全对不上（用户原话：「明明已经识别到API了」）。
 *
 * 所以这里两步都做，而且以**第二步的结果为准**：
 *   1. /models —— 拿模型列表（顺便验证地址对不对）
 *   2. 真发一条最小消息 —— 这才是机器人实际要做的事
 *
 * 结果里的 reason 直接来自 chatOnce，所以"要 key / 超时 / 推理模型吃光预算"
 * 这些原因能原样传到界面上，而不是被笼统的"失败"盖掉。
 *
 * @returns {Promise<{ok:boolean, models:string[], chat:object, needsKey:boolean, hints:string[]}>}
 */
export async function probeProvider({
  baseUrl, apiKey = '', model = '', requiresKey = true, timeoutMs = 30000, jsonMode = false,
} = {}) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  const hints = [];

  const models = await listModels(base, { apiKey, timeoutMs: Math.min(timeoutMs, 8000) });
  if (!models.ok) {
    return { ok: false, models: [], chat: { ok: false, reason: 'no-service', detail: models.error }, needsKey: false, hints };
  }

  // 选一个模型来试。没填就用服务报的第一个。
  const useModel = String(model ?? '').trim() || models.models[0] || '';
  if (!useModel) {
    return { ok: false, models: models.models, chat: { ok: false, reason: 'no-model', detail: '服务里没有任何模型' }, needsKey: false, hints };
  }
  if (model && models.models.length && !models.models.includes(model)) {
    hints.push(`你填的模型名「${model}」不在服务报出的列表里（有：${models.models.slice(0, 6).join('、')}）—— 很可能填错了。`);
  }

  // 真发一条。max_tokens 给宽一点：推理模型会先"思考"，给小了正文一个字都剩不下。
  //
  // ⚠ 这里故意把 apiKeyRequired 设成 false —— 探测的**目的**就是问服务
  //   "到底要不要 key"。如果按配置里的 requiresKey 提前短路，
  //   配错方向时探测会给出和机器人实际行为一模一样的错误答案，那就白探了。
  //   所以永远真发一次，让服务自己用 401/403 回答。
  const probeCfg = {
    llm: {
      enabled: true, baseUrl: base, model: useModel,
      apiKey, apiKeyRequired: false,
      timeoutMs, maxTokens: 400, temperature: 0,
      systemPrompt: '你是测试助手。',
      // 探测时也关掉思考模式：否则 400 token 会被 reasoning_content 吃光，
      // 探测会报“空内容”，看起来像服务坏了，其实只是没关 thinking。
      enableThinking: false,
    },
  };
  const chat = await chatOnce(probeCfg, {
    messages: [{ role: 'user', content: '只回复两个字：收到' }],
    maxTokens: 400,
    jsonMode,
  });

  if (chat.ok) {
    if (chat.hadReasoning) hints.push('这是个推理模型（会先输出思考）—— 建议把 llm.maxTokens 调到 800 以上，否则思考容易把预算吃光。');
    if (chat.ms > 8000) hints.push(`单次回复用了 ${(chat.ms / 1000).toFixed(1)}s。本地模型慢的话把 llm.timeoutMs 调大，否则会频繁超时并降级到固定回复。`);
    // 标着"要 key"但没带 key 也通了 → 这家其实不校验
    if (requiresKey !== false && !apiKey) {
      hints.push('没带 key 也通了 —— 这家其实不校验 key，可以把它的 requiresKey 设成 false（省得界面一直提醒你没配）。');
    }
    return { ok: true, models: models.models, chat, needsKey: false, hints };
  }

  // ---- 失败：把原因翻译成能照做的动作 ----
  const detail = String(chat.detail ?? '');
  // 只认**服务自己说的**鉴权失败，别用宽泛的 /API key/ 去匹配 ——
  // 那会把我们本地拼的 "缺少 API key（…）" 也当成服务拒绝（踩过）。
  const needsKey = chat.reason === 'http' && /\b(401|403)\b/.test(detail)
    || /authentication_error|unauthorized|invalid api key|missing or wrong api key/i.test(detail);

  if (needsKey) {
    hints.push('这个服务**要 API key**，而 /models 那个接口恰好不校验，所以只看它会被骗过去。');
    hints.push('去 .env 里设好 key（本地这家通常叫 LOCAL_API_KEY），或者把 key 填在下面的 API Key 栏里。');
    hints.push('如果命令里带了 --api-key 参数，key 就是你启动服务时设的那个值。');
  } else if (chat.reason === 'reasoning-only') {
    hints.push('模型是推理模型，思考把 max_tokens 吃光了 → 把 config.json 的 llm.maxTokens 调大（800~2000）。');
  } else if (chat.reason === 'timeout') {
    hints.push('服务太慢：把 llm.timeoutMs 调大（比如 60000），或者换个更小的模型。');
  } else if (chat.reason === 'network') {
    hints.push('连不上聊天接口。地址对不对？服务是不是只开了 /models 没开 /v1/chat/completions？');
  } else if (chat.reason === 'parse' || chat.reason === 'empty') {
    hints.push('服务有响应但内容不是预期的形状 —— 可能不是 OpenAI 兼容接口。');
  }

  return { ok: false, models: models.models, chat, needsKey, hints };
}

/** 不给网络就判断「API 能不能用」，用于 doctor 预检。 */
export async function checkApi(cfg) {
  const c = cfg.llm ?? {};
  if (!c.enabled) return { ok: false, reason: 'disabled' };
  if (!c.apiKey) return { ok: false, reason: 'no-key' };
  const r = await generateReply(cfg, { text: 'ping（只回复 pong 三个字以内）' });
  return r.ok
    ? { ok: true, sample: r.reply, ms: r.ms, model: r.model }
    : { ok: false, reason: r.reason, detail: r.detail, ms: r.ms };
}
