/**
 * test-local-api.mjs — 回归测试：接入 OpenAI 兼容的**本地** API。
 *
 * 用户要求：「改下控制台，要能接入本地API」。
 *
 * 本地推理服务（Ollama / LM Studio / llama.cpp / vLLM …）有两个和云端不同的地方，
 * 而这个项目以前有**两个地方会直接卡死**：
 *
 *   1. 它们通常**不校验 API key**，而 chatOnce 原来是一刀切要求 key，
 *      没有 key 直接返回 no-key —— 报错写着"缺少 API key"，
 *      完全指不到"这是本地服务、本来就不用 key"上。
 *   2. 本地服务的模型名是用户自己拉的（ollama pull qwen2.5:7b），
 *      猜不得；填错了报错很难懂。所以要能问它的 /models 列出来。
 *
 * 这个文件两头都测：先是纯函数层面的判定，然后**真的起一个假的 OpenAI 兼容服务**
 * 走完整链路（列模型 + 发一条消息拿回复）。
 *
 * 用法：node tools/test-local-api.mjs
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

import { resolveProvider } from '../src/config.js';
import { chatOnce, listModels, generateReply, probeProvider } from '../src/llm.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

console.log('='.repeat(72));
console.log('接入本地 API（OpenAI 兼容）');
console.log('='.repeat(72));

// ------------------------------------------------------ 1. 要不要 key
section('1) 「这家要不要 key」由 provider.requiresKey 决定');
{
  const base = {
    llm: {
      enabled: true,
      provider: 'local',
      providers: {
        local: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', requiresKey: false },
        cloud: { baseUrl: 'https://api.example.com', model: 'x', apiKeyEnv: 'CLOUD_KEY' },
        forced: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'y', requiresKey: true },
      },
    },
  };

  const local = resolveProvider(base, {}, []);
  check('本地厂商：apiKeyRequired=false', local.apiKeyRequired === false);
  check('本地厂商：没 key 也不算"该配没配"', local.needsKeyConfig === false);

  const cloud = resolveProvider({ ...base, llm: { ...base.llm, provider: 'cloud' } }, {}, []);
  check('云端厂商：apiKeyRequired=true', cloud.apiKeyRequired === true);
  check('云端厂商：没 key → needsKeyConfig=true（界面要提醒）', cloud.needsKeyConfig === true);

  const forced = resolveProvider({ ...base, llm: { ...base.llm, provider: 'forced' } }, { FORCED_API_KEY: 'k' }, []);
  check('显式 requiresKey=true 的本地服务（如 vLLM --api-key）照样认', forced.needsKeyConfig === false && forced.apiKeySet === true);

  const withKey = resolveProvider(base, { LOCAL_API_KEY: 'abc123' }, ['LOCAL_API_KEY']);
  check('不需要 key 的厂商也允许配 key（有的服务会校验）',
    withKey.apiKeySet === true && withKey.apiKeySource === '.env:LOCAL_API_KEY');

  check('默认（没写 requiresKey）仍然要求 key —— 云端漏配不能静默跑不通',
    resolveProvider({ llm: { enabled: true, provider: 'x', providers: { x: { baseUrl: 'http://a' } } } }, {}, []).apiKeyRequired === true);
}

// ------------------------------------------------ 2. 真的起一个假服务
section('2) 端到端：起一个假的 OpenAI 兼容服务，走完整链路');
{
  const seenRequests = [];
  const server = http.createServer((req, res) => {
    seenRequests.push({ url: req.url, auth: req.headers.authorization ?? null, method: req.method });
    if (req.url === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen2.5:7b' }, { id: 'llama3.1:8b' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* 忽略 */ }
        seenRequests[seenRequests.length - 1].body = parsed;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: parsed.model,
          choices: [{ message: { role: 'assistant', content: '本地模型回你一句' } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }));
      });
      return;
    }
    res.writeHead(404); res.end('nope');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  const mkCfg = (over = {}) => ({
    llm: {
      enabled: true, baseUrl, model: 'qwen2.5:7b', timeoutMs: 5000, maxTokens: 300,
      apiKey: '', apiKeyRequired: false,
      contextMessages: 16, systemPrompt: 'sys',
      ...over,
    },
  });

  // ---- 列模型 ----
  const models = await listModels(baseUrl, { apiKey: '' });
  check('listModels 通', models.ok === true, models.error ?? '');
  check('parse 出两个模型', models.models.join(',') === 'qwen2.5:7b,llama3.1:8b', models.models.join(','));
  check('没 key 也能列（本地服务不校验）', seenRequests[0].auth === null, String(seenRequests[0].auth));

  // 换个形状：有的服务直接返回数组
  const arrServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ id: 'a' }, { name: 'b' }, 'c']));
  });
  await new Promise((r) => arrServer.listen(0, '127.0.0.1', r));
  const arrModels = await listModels(`http://127.0.0.1:${arrServer.address().port}`, {});
  check('裸数组 / name 字段 / 纯字符串也能认出来',
    arrModels.ok && arrModels.models.join(',') === 'a,b,c', arrModels.models.join(','));
  arrServer.close();

  // ---- 发一条消息 ----
  const rep = await chatOnce(mkCfg(), { messages: [{ role: 'user', content: 'hi' }] });
  check('没有 key 也能调通（这是以前卡死的地方）', rep.ok === true, rep.ok ? '' : `${rep.reason}: ${rep.detail}`);
  check('拿回了内容', rep.content === '本地模型回你一句', String(rep.content));
  check('请求里没有 Authorization 头（空 key 硬发会让部分本地服务 400）',
    seenRequests.find((r) => r.url.endsWith('/chat/completions')).auth === null);
  check('请求打到了 {baseUrl}/chat/completions',
    seenRequests.some((r) => r.url === '/v1/chat/completions'));

  // ---- 有 key 时要带上 ----
  seenRequests.length = 0;
  await chatOnce(mkCfg({ apiKey: 'sk-local-123' }), { messages: [{ role: 'user', content: 'hi' }] });
  check('配了 key 就带上 Authorization',
    seenRequests[0].auth === 'Bearer sk-local-123', String(seenRequests[0].auth));

  // ---- 完整回复链路（buildMessages + generateReply） ----
  seenRequests.length = 0;      // 先清空，否则下面 find 会抓到上一条测试的请求
  const full = await generateReply(mkCfg(), {
    text: '@机器人 在吗', sender: '某人', mentioned: true,
    history: [], systemPrompt: 'sys', memoryDigest: '【你的记忆】\n你喜欢白饭',
  });
  check('generateReply 走本地服务也能出回复', full.ok && full.reply === '本地模型回你一句', full.ok ? full.reply : full.reason);
  const sentBody = seenRequests.filter((r) => r.body?.messages).pop()?.body;
  check('system + 记忆都进了请求', Boolean(sentBody
    && sentBody.messages[0].role === 'system'
    && JSON.stringify(sentBody.messages).includes('你喜欢白饭')),
    sentBody ? JSON.stringify(sentBody.messages.map((m) => m.role)) : '(没抓到请求)');
  check('模型名用的是配置里的', sentBody?.model === 'qwen2.5:7b', String(sentBody?.model));

  // ---- 云端仍然必须配 key ----
  const noKeyCloud = await chatOnce(mkCfg({ apiKeyRequired: true }), { messages: [{ role: 'user', content: 'hi' }] });
  check('云端（requiresKey）没 key 时仍然明确失败', noKeyCloud.ok === false && noKeyCloud.reason === 'no-key', noKeyCloud.reason);

  // ---- 服务没开时的报错要看得懂 ----
  server.close();
  await new Promise((r) => setTimeout(r, 100));
  const dead = await listModels(baseUrl, { timeoutMs: 800 });
  check('服务没开时 listModels 不抛，报错是人话',
    dead.ok === false && /连不上/.test(String(dead.error)), String(dead.error));
  const deadCall = await chatOnce(mkCfg(), { messages: [{ role: 'user', content: 'hi' }] });
  check('服务没开时 chatOnce 返回 network 而不是崩',
    deadCall.ok === false && ['network', 'timeout'].includes(deadCall.reason), deadCall.reason);
}

// ------------------------------------------------ 3. 推理模型与真实探测
section('3) 推理模型：思考吃光预算时要报清楚，而不是笼统的"空回复"');
{
  // 实测踩到：本地跑推理模型（swift-1.5-iq2_xs），max_tokens 给小了，
  // 思考占满预算、content 直接是 null → 项目判 empty → 静默降级成本地固定回复，
  // 用户看到的现象是"本地服务没联通"。报错必须能指到这个原因上。
  const mkServer = (payload) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    return s;
  };

  const reasoningSrv = mkServer({
    model: 'm',
    choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null, reasoning_content: '用户说只回复两个字，所以我应该…' } }],
    usage: { completion_tokens: 16 },
  });
  await new Promise((r) => reasoningSrv.listen(0, '127.0.0.1', r));
  const rc = await chatOnce(
    { llm: { enabled: true, baseUrl: `http://127.0.0.1:${reasoningSrv.address().port}`, model: 'm', apiKey: '', apiKeyRequired: false, maxTokens: 16, timeoutMs: 5000 } },
    { messages: [{ role: 'user', content: 'x' }] },
  );
  reasoningSrv.close();
  check('思考吃光预算 → reason=reasoning-only（不是笼统的 empty）',
    rc.ok === false && rc.reason === 'reasoning-only', String(rc.reason));
  check('报错里点名了是推理模型 + 给出了要调哪个值',
    /推理模型/.test(rc.detail) && /maxTokens/.test(rc.detail), String(rc.detail).slice(0, 80));
  check('绝不拿思考当回复（那等于把思维链发进群）',
    !String(rc.content ?? '').includes('所以我应该'), String(rc.content ?? ''));

  // finish_reason=length 但没有 reasoning 字段：也算被截断
  const truncSrv = mkServer({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }] });
  await new Promise((r) => truncSrv.listen(0, '127.0.0.1', r));
  const tc = await chatOnce(
    { llm: { enabled: true, baseUrl: `http://127.0.0.1:${truncSrv.address().port}`, model: 'm', apiKey: '', apiKeyRequired: false, maxTokens: 16, timeoutMs: 5000 } },
    { messages: [{ role: 'user', content: 'x' }] },
  );
  truncSrv.close();
  check('被截断也算 reasoning-only（都要提示调大预算）', tc.reason === 'reasoning-only', String(tc.reason));

  // 真空回复（没有 reasoning、finish_reason 正常）仍然是 empty
  const emptySrv = mkServer({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '' } }] });
  await new Promise((r) => emptySrv.listen(0, '127.0.0.1', r));
  const ec = await chatOnce(
    { llm: { enabled: true, baseUrl: `http://127.0.0.1:${emptySrv.address().port}`, model: 'm', apiKey: '', apiKeyRequired: false, timeoutMs: 5000 } },
    { messages: [{ role: 'user', content: 'x' }] },
  );
  emptySrv.close();
  check('真正的空回复仍然是 empty（别把两种混为一谈）', ec.reason === 'empty', String(ec.reason));

  // 带思考但正文正常：正常返回，并标出这是推理模型
  const bothSrv = mkServer({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '收到', reasoning_content: '想了一下' } }] });
  await new Promise((r) => bothSrv.listen(0, '127.0.0.1', r));
  const bc = await chatOnce(
    { llm: { enabled: true, baseUrl: `http://127.0.0.1:${bothSrv.address().port}`, model: 'm', apiKey: '', apiKeyRequired: false, timeoutMs: 5000 } },
    { messages: [{ role: 'user', content: 'x' }] },
  );
  bothSrv.close();
  check('有思考但正文正常 → 成功，并标记 hadReasoning',
    bc.ok === true && bc.content === '收到' && bc.hadReasoning === true);
}

section('4) probeProvider：必须真的发一条消息，不能只看 /models');
{
  // 这一段复现用户报的那个坑：
  //   /v1/models 不要 key（探测显示"通了"），/v1/chat/completions 要 key（401）。
  //   旧探测只看 /models → 控制台报"✓ 通了"，机器人却一句话都没回过。
  const srv = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'swift-1.5-iq2_xs' }] }));
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'missing or wrong API key' } }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/v1`;

  const modelsOnly = await listModels(base, {});
  check('光看 /models 会以为"通了"（这正是会骗人的地方）', modelsOnly.ok === true);

  const probe = await probeProvider({ baseUrl: base, model: 'swift-1.5-iq2_xs', requiresKey: false, timeoutMs: 5000 });
  srv.close();
  check('probeProvider 判为**不通**（以真实聊天为准）', probe.ok === false);
  check('认出是"要 key"', probe.needsKey === true, String(probe.chat.detail).slice(0, 60));
  check('提示里解释了"为什么只看 /models 会被骗"',
    probe.hints.some((h) => h.includes('/models')), JSON.stringify(probe.hints.slice(0, 1)));
  check('提示里告诉了去哪儿配 key',
    probe.hints.some((h) => /\.env|API Key/.test(h)), '');
  check('模型列表照样带回来了（列表本身是对的）',
    probe.models.join(',') === 'swift-1.5-iq2_xs', probe.models.join(','));

  // 正常服务：探通 + 给出样例回复
  const okSrv = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'good-model' }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '收到', reasoning_content: '嗯' } }] }));
  });
  await new Promise((r) => okSrv.listen(0, '127.0.0.1', r));
  const okProbe = await probeProvider({ baseUrl: `http://127.0.0.1:${okSrv.address().port}/v1`, timeoutMs: 5000 });
  okSrv.close();
  check('正常服务：探通', okProbe.ok === true, okProbe.chat.detail ?? '');
  check('把模型的样例回复带回来（界面上能看到它真回了什么）', okProbe.chat.content === '收到');
  check('认出是推理模型并提醒调 maxTokens',
    okProbe.hints.some((h) => /推理模型/.test(h) && /maxTokens/.test(h)), JSON.stringify(okProbe.hints));

  // 模型名填错时要提醒
  const mismatch = await probeProvider({
    baseUrl: 'http://127.0.0.1:1', model: 'not-there', timeoutMs: 800,
  });
  check('服务连不上时不抛，chat.reason 有值', mismatch.ok === false && Boolean(mismatch.chat.reason), String(mismatch.chat.reason));
}

section('5) 每家厂商可以有自己的超时 / JSON 模式');
{
  const base = {
    llm: {
      enabled: true, provider: 'local', timeoutMs: 20000, jsonMode: true,
      providers: {
        local: { baseUrl: 'http://127.0.0.1:8080/v1', model: 'm', requiresKey: false, timeoutMs: 120000, jsonMode: false },
        cloud: { baseUrl: 'https://api.example.com', model: 'c' },
      },
    },
  };
  const l = resolveProvider(base, {}, []);
  check('厂商级超时覆盖全局（本地慢，要给大）', l.timeoutMs === 120000, String(l.timeoutMs));
  check('厂商级 jsonMode 覆盖全局', l.jsonMode === false);
  const c = resolveProvider({ ...base, llm: { ...base.llm, provider: 'cloud' } }, {}, []);
  check('没写就用全局超时', c.timeoutMs === 20000, String(c.timeoutMs));
  check('没写就默认支持 jsonMode（云端本来支持）', c.jsonMode === true);
}

// ------------------------------------------------------ 6. 配置与界面
section('6) 真实 config.json + 控制台接线');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const local = cfg.llm?.providers?.local;
  check('config 里有 local 厂商', Boolean(local));
  // ⚠ 不要写死 requiresKey 的值：那取决于用户接的是哪家本地服务
  //   （llama.cpp / Ollama 一般不校验 key，但有些自建服务要）。
  //   实测踩过：用户把小模型换到 127.0.0.1:8090 并把 requiresKey 改成 true 之后，
  //   这里断言 === false 就红了 —— 而配置本身完全正确。
  //   该守的是"这个字段存在且是布尔"，不是"它是 false"。
  check('local 的 requiresKey 是个布尔值（值随所接服务而定）',
    typeof local?.requiresKey === 'boolean', String(local?.requiresKey));
  check('local 的 baseUrl 指向本机',
    /^https?:\/\/(127\.0\.0\.1|localhost)/.test(String(local?.baseUrl)), String(local?.baseUrl));
  check('local 带说明注释（列了各家默认端口）',
    Array.isArray(local?.$comment) && local.$comment.some((s) => s.includes('11434')));
  check('local 关掉了 jsonMode（llama.cpp 语法模式 + 推理模型会 502）',
    local?.jsonMode === false, String(local?.jsonMode));
  check('local 有自己的超时（本地推理慢）',
    Number(local?.timeoutMs) >= 60000, String(local?.timeoutMs));
  check('云端厂商没有被顺手改成不需要 key',
    cfg.llm?.providers?.deepseek?.requiresKey === undefined
    && cfg.llm?.providers?.kimi?.requiresKey === undefined);
  check('记忆预算按推理模型定（maxTokens >= 2000）',
    Number(cfg.memory?.maxTokens) >= 2000, String(cfg.memory?.maxTokens));
  check('记忆超时也放宽了（本地那条任务实测 32 秒）',
    Number(cfg.memory?.timeoutMs) >= 60000, String(cfg.memory?.timeoutMs));

  const server = fs.readFileSync(path.join(ROOT, 'gui', 'server.js'), 'utf8');
  check('控制台有 /api/llm/probe 接口', server.includes("'/api/llm/probe'"));
  check('探测接口走 probeProvider（而不是只 listModels）', server.includes('probeProvider({'));
  check('探测接口把 requiresKey/isLocal 一起给页面',
    server.includes('requiresKey: p.requiresKey !== false') && server.includes('isLocal:'));
  check('探测结果带 hints 给界面', server.includes('hints: r.hints'));
  const page = fs.readFileSync(path.join(ROOT, 'gui', 'page.js'), 'utf8');
  check('页面有「检测服务」按钮', page.includes('id="btnProbe"'));
  check('页面有模型选择区', page.includes('id="modelPick"'));
  check('页面有"接下来该改什么"的区域', page.includes('id="probeHints"'));
  check('本地厂商有单独的提示文案', page.includes('local:'));
  check('「不需要 key」和「未配置」在界面上分开显示',
    page.includes('这家不需要 key') && page.includes('未配置'));
  check('界面上说清了"以真的发一条为准，不是列出模型就算通"',
    /真的发一条消息/.test(page), '');
}

// ------------------------------------------------ 8. 思考模式开关（控制台那个按钮）
//
// 用户要求：「在控制台搞个按钮，能关闭本地模型的思考功能」。
//
// 为什么它值得有：本地推理模型（Qwen3 这类）默认**先输出一大段推理再给正文**。
// 实测本机 qwen3-14b：开思考 → 端到端 55~65 秒、首字等 50 秒左右；
// 关掉 → 首字 0.2 秒、端到端 15 秒上下。聊天这种短回复根本不需要想那么久。
//
// 这一节做两件事：
//   1. 端到端验「开关真的改变了发给模型的请求体」（起个假服务，把 body 抓下来看）
//   2. 验「这个键只在本地服务上写」—— 云端厂商不认 chat_template_kwargs，
//      硬发过去可能直接 400，所以界面对非本地厂商是**藏起来且不提交**的
section('8) 思考模式：开关真的进了请求体，而且只对本地服务生效');
{
  // fs/path/ROOT 在上面的块里是块内变量，这里要自己取一份（各块互不可见）
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  const bodies = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (raw) { try { bodies.push(JSON.parse(raw)); } catch { bodies.push({ _raw: raw }); } }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '嗯' } }], usage: {} }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  // ⚠ 这里必须走 resolveProvider（就像 loadConfig 那样），不能直接塞 {llm:{...}}：
  //   chatOnce 读的是**已经解析过**的 cfg.llm，`providers.local.enableThinking`
  //   要经过 resolveProvider 才会变成 cfg.llm.enableThinking。
  //   第一版我直接塞了 providers 形状，于是开关看起来"没生效" —— 其实是测试没接对，
  //   而那条断言恰好也证明了"这根线真的只有一条"。
  const mkCfg = (enableThinking) => ({
    llm: resolveProvider({
      llm: {
        enabled: true, provider: 'local', timeoutMs: 5000, maxTokens: 50,
        providers: {
          local: {
            baseUrl: `http://127.0.0.1:${port}/v1`, model: 'qwen3-14b',
            requiresKey: false, enableThinking,
          },
        },
      },
    }, {}, []),
  });

  const run = async (enableThinking) => {
    bodies.length = 0;
    await chatOnce(mkCfg(enableThinking), { messages: [{ role: 'user', content: 'hi' }] });
    return bodies[0] ?? {};
  };

  const off = await run(false);
  check('关了思考 → 请求体里 enable_thinking=false',
    off.chat_template_kwargs?.enable_thinking === false, JSON.stringify(off.chat_template_kwargs ?? null));

  const on = await run(true);
  check('开着思考 → 请求体里 enable_thinking=true',
    on.chat_template_kwargs?.enable_thinking === true, JSON.stringify(on.chat_template_kwargs ?? null));

  const unset = await run(undefined);
  check('没配过 → 不带这个字段（让模型用自己的默认，不替它做主）',
    unset.chat_template_kwargs === undefined, JSON.stringify(unset.chat_template_kwargs ?? null));

  await new Promise((r) => srv.close(r));

  // 控制台接线：控件在、只在本地显示、切厂商时跟着刷新、保存时只对本地写
  const page = fs.readFileSync(path.join(ROOT, 'gui', 'page.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'gui', 'server.js'), 'utf8');
  check('页面上有这个开关', page.includes('id="enableThinking"'));
  check('服务端把 enableThinking 给到页面', /enableThinking: p\.enableThinking !== false/.test(server));
  check('只在本地服务上显示（isLocal 判定）',
    /wrap\.style\.display = local \? '' : 'none'/.test(page) && /p\?\.isLocal === true/.test(page));
  check('切厂商时也会刷新这块（不是只在加载时渲一次）',
    page.indexOf('renderThinking(p)') > 0
    && (page.match(/renderThinking\(p\)/g) ?? []).length >= 2,
    `${(page.match(/renderThinking\(p\)/g) ?? []).length} 处调用`);
  check('保存时**只对本地服务**写这个键（云端不认 chat_template_kwargs）',
    /p\.isLocal === true\)\s*\?\s*\{ \['llm\.providers\.' \+ provider \+ '\.enableThinking'\]/.test(page));
  check('开关旁边写了实测数字（用户要知道代价）',
    /55~65 秒/.test(page) && /0\.2 秒/.test(page));
}

console.log('\n' + '='.repeat(72));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(72));
process.exit(fail === 0 ? 0 : 1);
