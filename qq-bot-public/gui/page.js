/**
 * page.js — 控制台界面（内嵌 HTML，不依赖任何前端框架或 CDN）。
 *
 * 为什么内嵌而不是单独放 .html 文件：
 *   服务器只暴露一个 / 路由，不用管静态文件路径、MIME、缓存，
 *   也不用担心被人改坏一个文件就对不上。
 *
 * 为什么不用 CDN 的框架：
 *   这台机器不一定能访问外网 CDN，而且界面本身很简单，
 *   原生 JS 足够，少一层依赖少一类故障。
 */

export function renderPage({ port }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QQ 机器人控制台</title>
<style>
  :root {
    --bg: #0f1420;
    --card: #171e2e;
    --card2: #1d2637;
    --line: #2a3548;
    --fg: #e6ecf5;
    --dim: #8b9bb4;
    --accent: #4c9aff;
    --accent-dim: #2b5fa8;
    --ok: #35c98a;
    --warn: #e0a33e;
    --err: #f0616d;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 20px 20px 60px; }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
  header h1 { font-size: 19px; margin: 0; font-weight: 600; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--dim); flex: none; }
  .dot.on { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
  .dot.off { background: #55617a; }
  .sub { color: var(--dim); font-size: 13px; margin: 0 0 18px; }
  .card {
    background: var(--card); border: 1px solid var(--line);
    border-radius: 10px; padding: 16px 18px; margin-bottom: 16px;
  }
  .card h2 { font-size: 14px; margin: 0 0 4px; font-weight: 600; letter-spacing: .02em; }
  .card .hint { color: var(--dim); font-size: 12.5px; margin: 0 0 14px; }
  label.field { display: block; margin-bottom: 12px; }
  .lbl { display: block; color: var(--dim); font-size: 12.5px; margin-bottom: 5px; }
  input[type=text], input[type=password], input[type=number], select, textarea {
    width: 100%; background: var(--card2); color: var(--fg);
    border: 1px solid var(--line); border-radius: 7px; padding: 8px 10px;
    font: inherit; outline: none;
  }
  input:focus, select:focus, textarea:focus { border-color: var(--accent-dim); }
  textarea { resize: vertical; min-height: 84px; line-height: 1.55; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  .btnrow { display: flex; gap: 9px; flex-wrap: wrap; align-items: center; margin-top: 4px; }
  button {
    background: var(--accent-dim); color: #fff; border: 0; border-radius: 7px;
    padding: 8px 15px; font: inherit; font-weight: 500; cursor: pointer;
  }
  button:hover { filter: brightness(1.14); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.ghost { background: transparent; border: 1px solid var(--line); color: var(--fg); }
  button.ok { background: #227a56; }
  button.bad { background: #9c313c; }
  button.tiny { padding: 4px 10px; font-size: 12.5px; }
  .keybox { display: flex; gap: 8px; align-items: center; }
  .keybox input { font-family: ui-monospace, Consolas, monospace; letter-spacing: .02em; }
  .badge {
    display: inline-block; padding: 1px 8px; border-radius: 20px;
    font-size: 12px; border: 1px solid var(--line); color: var(--dim);
  }
  .badge.set { color: var(--ok); border-color: #2b6a53; }
  .badge.unset { color: var(--warn); border-color: #7a6130; }
  .switch { display: flex; align-items: center; gap: 9px; margin-bottom: 12px; cursor: pointer; user-select: none; }
  .switch input { width: auto; }
  .switch span { font-size: 13.5px; }
  pre.logs {
    background: #0b0f18; border: 1px solid var(--line); border-radius: 8px;
    padding: 11px 13px; margin: 0; height: 300px; overflow: auto;
    font: 12.5px/1.55 ui-monospace, Consolas, "Courier New", monospace;
    white-space: pre-wrap; word-break: break-all;
  }
  .ln-out { color: #cfd8e6; }
  .ln-err { color: var(--err); }
  .ln-sys { color: var(--accent); }
  .ln-cmd { color: var(--warn); }
  .toast {
    position: fixed; right: 20px; bottom: 20px; background: var(--card2);
    border: 1px solid var(--line); border-left: 3px solid var(--accent);
    border-radius: 8px; padding: 11px 15px; box-shadow: 0 8px 26px rgba(0,0,0,.45);
    opacity: 0; transform: translateY(10px); transition: .22s; pointer-events: none;
    max-width: 380px;
  }
  .toast.show { opacity: 1; transform: none; }
  .toast.err { border-left-color: var(--err); }
  .toast.ok { border-left-color: var(--ok); }
  .muted { color: var(--dim); font-size: 12.5px; }
  code { background: var(--card2); padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }
  .pool { border-top: 1px solid var(--line); padding-top: 12px; margin-top: 12px; }
  .pool:first-child { border-top: 0; margin-top: 0; padding-top: 0; }
  .pool .phead { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
  .pool .pname { font-weight: 600; font-size: 13px; }
  .pool textarea { min-height: 62px; font-size: 13px; }
  .pool .pcount { color: var(--dim); font-size: 12px; margin-left: auto; }

  /* 分层折叠：固定回复一共十几个池子，全摊开要滚好几屏 ——
     分组默认收起，summary 上就把「几项/几句话/有没有改过」说清楚。 */
  details.grp { border-top: 1px solid var(--line); margin-top: 10px; padding-top: 8px; }
  details.grp:first-of-type { border-top: 0; margin-top: 0; }
  details.grp > summary { cursor: pointer; font-weight: 600; font-size: 13px; padding: 4px 0; }
  details.grp > summary .muted { font-weight: 400; }
  details.grp[open] > summary { margin-bottom: 6px; }
  details.pool { border-top: 1px dashed var(--line); }
  details.pool:first-of-type { border-top: 0; }
  details.pool > summary { cursor: pointer; font-size: 13px; padding: 5px 0; display: flex; align-items: center; gap: 8px; }
  details.pool > summary .pcount { margin-left: auto; color: var(--dim); font-size: 12px; }
  details.pool[open] > summary { margin-bottom: 4px; }

  /* 开关（人生模拟那两个） */
  .switches { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; margin-bottom: 10px; }
  .sw { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; }
  .sw input { width: 16px; height: 16px; accent-color: #4a9; cursor: pointer; }
  .sw span { font-weight: 600; }
  .lifebar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
  .lifebar select { min-width: 160px; }
  .lifebar input[type=text] { padding: 4px 6px; }

  /* 代码过期提醒（跑着的控制台进程加载的是旧代码） */
  .stale {
    background: #4a2f17; border: 1px solid #a76b2a; color: #ffd9a8;
    padding: 10px 12px; border-radius: 8px; margin-bottom: 14px;
    font-size: 13px; line-height: 1.6;
  }
  .stale b { color: #ffb959; }
  .stale code { background: rgba(0,0,0,.25); padding: 1px 4px; border-radius: 4px; }
  .group-title {
    font-size: 12.5px; color: var(--dim); text-transform: none;
    margin: 16px 0 4px; padding-bottom: 4px; border-bottom: 1px dashed var(--line);
  }
  .savestate {
    margin-top: 12px; padding: 9px 12px; border-radius: 7px;
    font-size: 13px; border-left: 3px solid var(--dim);
    background: var(--card2); color: var(--fg);
  }
  .savestate.ok { border-left-color: var(--ok); }
  .savestate.err { border-left-color: var(--err); }

  /* ---- 分页 ----
     以前是一张长页面从头到尾七张卡，找一样东西要滚很久（用户原话「非常杂乱」）。
     现在拆成「主界面 / 未接入 API / 接入 API / 记忆」四页，一次只显示一页。 */
  .tabs {
    display: flex; gap: 4px; margin: 0 0 16px;
    border-bottom: 1px solid var(--line); flex-wrap: wrap;
  }
  .tabs button {
    background: transparent; color: var(--dim); border: 0; border-bottom: 2px solid transparent;
    border-radius: 0; padding: 9px 15px; font-weight: 500;
  }
  .tabs button:hover { color: var(--fg); filter: none; background: rgba(255,255,255,.03); }
  .tabs button.active { color: var(--fg); border-bottom-color: var(--accent); }
  .tabs .tabnote { margin-left: auto; align-self: center; color: var(--dim); font-size: 12px; }
  .page[hidden] { display: none; }

  /* 模式的正式说明：名词 + 说明的对照，比一整段话好扫 */
  .spec { margin: 0 0 16px; }
  .spec > div {
    display: grid; grid-template-columns: 76px 1fr; gap: 10px;
    padding: 6px 0; border-bottom: 1px dashed var(--line);
  }
  .spec > div:last-child { border-bottom: 0; }
  .spec dt { color: var(--dim); font-size: 12.5px; }
  .spec dd { margin: 0; font-size: 13px; line-height: 1.6; }

  /* 底部固定保存条：分页之后保存按钮不能只挂在最后一页的末尾 */
  .savebar {
    position: sticky; bottom: 0; z-index: 5;
    display: flex; gap: 9px; align-items: center; flex-wrap: wrap;
    background: linear-gradient(180deg, rgba(15,20,32,.6), var(--bg) 40%);
    padding: 12px 0 10px; margin-top: 4px;
  }
  .savebar .savestate { margin: 0; flex: 1 1 260px; }

  /* ---- 自定义规则编辑 ----
     一条规则 = 匹配写法 + 一组回复。做成"一张小卡"而不是一行表格：
     回复是多行文本（一行一句），表格里塞不下。 */
  .rule {
    border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px;
    margin-bottom: 10px; background: var(--card2);
  }
  .rulebar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
  .rulebar input[type=text] { flex: 1 1 auto; font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
  .rulebar .idx { color: var(--dim); font-size: 12px; min-width: 22px; }
  .rule textarea { min-height: 62px; font-size: 13px; }
  .rulestate { font-size: 12px; margin-top: 4px; min-height: 16px; }
  .rulestate.bad { color: var(--warn); }
  .sep { border: 0; border-top: 1px solid var(--line); margin: 16px 0; }
  .probeout { background: var(--card2); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-top: 10px; }
  .probeout .k { color: var(--dim); }
  .probeout .v { color: var(--fg); font-weight: 600; }
  .probeout .warnline { color: var(--warn); margin-top: 6px; }
</style>
</head>
<body>
<div class="wrap">

  <!-- 代码过期提醒：跑着的控制台进程加载的是旧代码时会亮起来（见脚本里的 renderStale）。
       为什么要有：控制台的 js 是 Node 启动时读一次就缓存的，改了代码刷新页面看到的
       还是旧的，而且一切正常、不报错。真实发生过「为什么打开控制台不是修改后的界面」。 -->
  <div id="staleWarn" class="stale" style="display:none"></div>

  <header>
    <div class="dot off" id="dot"></div>
    <h1>QQ 机器人控制台</h1>
    <span class="badge" id="modeBadge">—</span>
  </header>
  <p class="sub">
    改完记得点「保存」。密钥存在项目的 <code>.env</code> 里，
    其余设置存 <code>config.json</code>；保存后需要重启机器人才生效。
  </p>

  <!-- 分页：以前七张卡挤在一张长页面上（用户原话「非常杂乱」）。
       现在按"你在配哪一套"分开，一次只显示一页：
         主界面   —— 看状态、启停机器人、看日志（最常用的那几件事）
         未接入API —— 不花钱那一套：固定回复池 + 自定义规则
         接入API   —— 大模型：厂商/key/地址 + 接管模式与设人设
         记忆      —— 记忆文件 + 人生模拟
       「回复行为」（范围/白名单/概率）两边都要用，所以做成**同一张卡搬来搬去**，
       不是复制两份 —— 复制会有两个同名 id，改了一个另一个还是旧值。 -->
  <nav class="tabs" id="tabs">
    <button type="button" class="tab" data-tab="main">主界面</button>
    <button type="button" class="tab" data-tab="local">未接入 API</button>
    <button type="button" class="tab" data-tab="api">接入 API</button>
    <span class="tabnote" id="tabNote"></span>
  </nav>

  <!-- ============ 主界面 ============ -->
  <div class="page" id="page-main">
    <div class="card">
      <h2>运行控制</h2>
      <p class="hint">日志是机器人进程的实时输出。控制台关掉时机器人会一起停。</p>
      <div class="btnrow" style="margin-bottom:14px">
        <button class="ok" id="btnStart">启动机器人</button>
        <button class="bad" id="btnStop">停止机器人</button>
        <button class="ghost" id="btnClearLogs">清空日志</button>
        <span class="muted" id="runHint"></span>
      </div>
      <pre class="logs" id="logs"></pre>
    </div>

    <!-- ============ 自动轮询（会动鼠标，所以默认收起）============ -->
    <details class="card" id="cardPoll">
      <summary style="cursor:pointer;font-size:14px;font-weight:600">
        自动轮询其它聊天　<span class="muted" id="pollSummary"></span>
      </summary>
      <p class="hint" style="margin-top:12px">
        QQ 一次只渲染<b>一个</b>聊天，没有后台接口 —— 想看别的会话，只能替你去点会话列表
        （点进去 → 读 → 再点下一个）。所以这个功能<b>会移动你的鼠标、把 QQ 抢到前台</b>：
        <br>
        · 默认设成「你一动键鼠就暂停」，闲置够了才继续 —— 打字打一半被切走是最烦的
        <br>
        · 点完会把光标放回原处
        <br>
        · 回不回消息跟这里无关：<b>轮询只管"看"，白名单管"回"</b>
      </p>

      <label class="switch">
        <input type="checkbox" id="pollEnabled">
        <span>开启自动轮询</span>
      </label>

      <label class="field">
        <span class="lbl">轮询哪些聊天</span>
        <select id="pollScope">
          <option value="all">会话列表里的每一个（推荐：谁发消息都能看见）</option>
          <option value="whitelist">只有白名单里的会话</option>
          <option value="list">只有下面这个列表</option>
        </select>
      </label>
      <p class="hint" id="pollScopeHint"></p>

      <label class="field">
        <span class="lbl">指定列表（逗号分隔，只有选「只有下面这个列表」时才用）</span>
        <input type="text" id="pollList" placeholder="测试群, 示例群">
      </label>

      <div class="row3">
        <label class="field">
          <span class="lbl">切完等多久再读（毫秒）</span>
          <input type="number" id="pollSettleMs" min="200" step="100">
        </label>
        <label class="field">
          <span class="lbl">两次切换至少间隔（毫秒）</span>
          <input type="number" id="pollMinGapMs" min="500" step="500">
        </label>
        <label class="field">
          <span class="lbl">闲置多久算你不忙（毫秒）</span>
          <input type="number" id="pollIdleMs" min="0" step="500">
        </label>
      </div>

      <label class="switch">
        <input type="checkbox" id="pollPause">
        <span>我在用电脑时暂停轮询（推荐）</span>
      </label>
      <label class="switch">
        <input type="checkbox" id="pollRestore">
        <span>点完把鼠标光标放回原处</span>
      </label>
      <div class="btnrow">
        <button class="ghost tiny" id="btnPollTest" type="button">读一次会话列表看看会轮哪些</button>
        <span class="muted" id="pollTestOut"></span>
      </div>
    </details>
  </div>

  <!-- ============ 未接入 API ============ -->
  <div class="page" id="page-local" hidden>
    <div id="slotLocal"></div>

    <!-- 固定回复池 -->
    <div class="card">
      <h2>固定回复</h2>
      <p class="hint">
        这是<b>不接大模型时</b>用的回复（或模型调用失败时的兜底）。
        <b>一行一句</b>，会随机挑一句，并避开最近发过的 6 句。
        句子里可以用 <code>{sender}</code> 代指对方昵称、<code>{echo}</code> 复述对方的话。
        留空 = 恢复该项的默认值。
      </p>
      <div class="btnrow" style="margin-bottom:14px">
        <button class="ghost tiny" id="btnResetPools" type="button">全部恢复默认</button>
        <span class="muted" id="poolsHint"></span>
      </div>
      <div id="poolsEditor"></div>
    </div>

    <!-- 自定义规则：引擎里一直有，以前只能手改 config.json -->
    <div class="card">
      <h2>自定义规则</h2>
      <p class="hint">
        一条规则 = 一个<b>匹配写法</b> + 一组<b>回复</b>。消息命中就从这组里随机挑一句回。
        <b>顺序就是优先级</b>，从上往下试、命中就停。
        <br>
        匹配写法是<b>正则</b>；不会写正则就写关键词，用 <code>|</code> 隔开多个，例如
        <code>吃了|吃饭|吃啥</code>。大小写不敏感。
        <br>
        ⚠ 内置意图（打招呼/问句/感谢…）默认<b>先</b>匹配，所以给「在吗」写的规则永远轮不到
        —— 想要你的规则说了算，打开下面的开关。
      </p>

      <label class="switch">
        <input type="checkbox" id="customRulesFirst">
        <span>我的规则优先于内置意图</span>
      </label>

      <div id="rulesEditor"></div>
      <div class="btnrow">
        <button class="ghost tiny" id="btnAddRule" type="button">+ 添加一条规则</button>
        <button class="bad tiny" id="btnClearRules" type="button">全部删掉</button>
        <span class="muted" id="rulesHint"></span>
      </div>

      <hr class="sep">

      <label class="field">
        <span class="lbl">试打一句（用上面正在编辑的规则，不用先保存）</span>
        <div class="keybox">
          <input type="text" id="ruleTest" placeholder="比如：吃了吗">
          <button class="ghost tiny" id="btnRuleTest" type="button">试一下</button>
        </div>
      </label>
      <div id="ruleTestOut"></div>
    </div>
  </div>

  <!-- ============ 接入 API ============ -->
  <div class="page" id="page-api" hidden>
    <!-- 大模型 -->
    <div class="card">
      <h2>大模型</h2>
      <p class="hint">API key 按厂商分开存。没配 key 不会报错，但会退化成固定话术回复，质量差很多。</p>

      <div class="row">
        <label class="field">
          <span class="lbl">使用哪个厂商</span>
          <select id="provider"></select>
        </label>
        <label class="field">
          <span class="lbl">模型名</span>
          <input type="text" id="model" placeholder="deepseek-chat">
        </label>
      </div>
      <p class="muted" id="modelHint" style="margin:-6px 0 12px"></p>

      <label class="field">
        <span class="lbl">API Key <span class="badge" id="keyBadge">—</span></span>
        <div class="keybox">
          <input type="password" id="apiKey" placeholder="粘贴 key，留空表示不改">
          <button class="ghost tiny" id="toggleKey" type="button">显示</button>
          <button class="ghost tiny" id="clearKey" type="button">清空</button>
        </div>
      </label>
      <p class="muted" id="keyHint" style="margin:-6px 0 12px"></p>

      <label class="field">
        <span class="lbl">API 地址（一般不用改）</span>
        <div class="keybox">
          <input type="text" id="baseUrl" placeholder="https://api.deepseek.com">
          <button class="ghost tiny" id="btnProbe" type="button">检测服务</button>
        </div>
      </label>
      <p class="muted" id="probeHint" style="margin:-6px 0 12px"></p>
      <div id="probeHints" style="display:none;margin:-6px 0 12px"></div>

      <label class="field" id="modelPickWrap" style="display:none">
        <span class="lbl">检测到的模型（点一个填进上面）</span>
        <div class="btnrow" id="modelPick" style="flex-wrap:wrap"></div>
      </label>

      <!-- 思考模式：只对本地推理服务显示（见 renderThinking 的注释） -->
      <div id="thinkingWrap" style="display:none;margin-bottom:6px">
        <label class="switch">
          <input type="checkbox" id="enableThinking">
          <span>启用思考模式（推理模型先想再答）</span>
        </label>
        <p class="muted" id="thinkingHint" style="margin:-6px 0 14px"></p>
      </div>

      <div class="row3">
        <label class="field">
          <span class="lbl">发给模型的历史条数</span>
          <input type="number" id="contextMessages" min="0" max="60">
        </label>
        <label class="field">
          <span class="lbl">超时（毫秒）</span>
          <input type="number" id="timeoutMs" min="1000" step="1000">
        </label>
        <label class="field">
          <span class="lbl">单次最多生成 tokens</span>
          <input type="number" id="maxTokens" min="16" step="50">
        </label>
      </div>
    </div>

    <!-- AI 接管模式 -->
    <div class="card">
      <h2>AI 接管模式</h2>
      <dl class="spec">
        <div>
          <dt>作用</dt>
          <dd>开启后，回复由大模型按下方「人设提示词」生成；关闭后由本地固定回复池生成，
            不发起任何大模型请求、不产生费用。</dd>
        </div>
        <div>
          <dt>生效范围</dt>
          <dd>被 @ 的消息必回；其余消息仍按「回复行为」里的概率执行。</dd>
        </div>
        <div>
          <dt>切换方式</dt>
          <dd>此处勾选<b>立即生效</b>（不需要重启机器人）；也可以在会话里直接发指令切换：
            <code>你接管</code> 开启、<code>你下班</code> 关闭
            （关键词在 <code>persona.takeoverPatterns</code> / <code>releasePatterns</code> 里改）。</dd>
        </div>
        <div>
          <dt>状态存放</dt>
          <dd>运行时状态存在 <code>state.json</code> 的 <code>takeoverEnabled</code>
            （每轮现读，所以切换不用重启）；配置文件里的 <code>persona.enabled</code> 只是<b>默认值</b>。</dd>
        </div>
        <div>
          <dt>大模型调用</dt>
          <dd>只在开启本模式时才发起请求（<code>llm.callApiInTakeoverOnly=true</code>）；
            关闭时一次都不调，纯本地规则。</dd>
        </div>
        <div>
          <dt>调用失败</dt>
          <dd>由下面的「模型调不通时发一句兜底话」决定：开着就用本地池子顶一句，
            关掉就这条不回。</dd>
        </div>
      </dl>

      <label class="switch">
        <input type="checkbox" id="takeoverNow">
        <span>启用 AI 接管（写入 state.json，立即生效）</span>
      </label>

      <label class="switch">
        <input type="checkbox" id="fallbackWhenApiDown">
        <span>模型调不通时发一句兜底话（关掉＝宁可不回，也不发容易穿帮的罐头话）</span>
      </label>
      <p class="hint" id="fbHint" style="margin:-6px 0 14px"></p>

      <p class="hint" style="margin-bottom:0">
        提示词不在这里改 —— 它属于<b>下面那张「人设（身份）」卡</b>：
        一份人设自带它的说话方式、它的人生和它自己的记忆。
      </p>
    </div>

    <!-- ============ 人设（身份）：记忆与人生是它的子项 ============ -->
    <div class="card" id="cardPersona">
      <h2>人设（身份）</h2>
      <p class="hint">
        一份人设 = 一个<b>身份</b>：<b>说话方式（提示词）</b> + <b>它的人生</b> + <b>它自己的记忆</b>。
        切换人设会同时换掉这三样，而且<b>立刻生效</b>（不用重启机器人）。
        <br>
        记忆按人设分开存（<code>memory/&lt;人设名&gt;/</code>）：换一个身份就是换一套"我是谁、我经历过什么"，
        两边不会串味。人生同理（<code>lives/&lt;人设名&gt;.json</code>）。
      </p>

      <div class="lifebar">
        <label class="muted" for="personaPick">当前人设</label>
        <select id="personaPick"></select>
        <button class="ghost tiny" id="btnPersonaSwitch" type="button">切换</button>
        <span class="muted">新建：</span>
        <input type="text" id="personaNewName" placeholder="名字，比如 阿岚" style="width:130px">
        <label class="muted" style="display:flex;align-items:center;gap:4px">
          <input type="checkbox" id="personaSeed" checked> 克隆当前这份
        </label>
        <button class="ghost tiny" id="btnPersonaCreate" type="button">新建并切换</button>
        <button class="bad tiny" id="btnPersonaDelete" type="button">删除这个人设</button>
      </div>
      <div class="muted" id="personaHint" style="margin-bottom:12px"></div>

      <label class="field">
        <span class="lbl">这个人设的提示词（接管模式用它）</span>
        <textarea id="personaPrompt2" rows="10"></textarea>
      </label>
      <div class="btnrow" style="margin-bottom:6px">
        <button class="ok tiny" id="btnPersonaSavePrompt" type="button">保存提示词（立即生效，不用重启）</button>
        <button class="ghost tiny" id="btnPersonaSeedFromConfig" type="button">用 config.json 里那份提示词建一份人设</button>
        <span class="muted" id="personaSaveHint"></span>
      </div>

      <!-- 子项 1：记忆 -->
      <details class="grp" id="personaMemoryBox">
        <summary>
          它的记忆　<span class="muted" id="memSummary"></span>
        </summary>
        <p class="hint" style="margin-top:8px">
          <b>总记忆</b>是不分跟谁聊都成立的东西（我是谁、喜欢什么），
          <b>会话记忆</b>只在这个会话里成立（在这里的心情、经历、和这里的人的关系）。
          每次生成回复前会把两层一起读进提示词，回复发出后再让模型提出改动。
          <b>这里只读</b> —— 想改就直接编辑文件。
        </p>
        <div class="btnrow" style="margin-bottom:14px">
          <button class="ghost tiny" id="btnMemReload" type="button">重新读取</button>
          <button class="bad tiny" id="btnMemClear" type="button">清空这个会话的记忆</button>
          <button class="bad tiny" id="btnMemClearGlobal" type="button">清空总记忆</button>
          <span class="muted" id="memHint"></span>
        </div>
        <div id="memBody"></div>
      </details>

      <!-- 子项 2：人生 -->
      <details class="grp" id="personaLifeBox">
        <summary>
          它的人生　<span class="muted" id="lifeSummary"></span>
        </summary>
        <p class="hint" style="margin-top:8px">
          没人跟它说话的时候，让模型推演「此刻这个人在做什么、想什么」，记成一份<b>生活日志</b>，
          再作为「你最近在做什么」注入提示词 —— 这样两段对话之间有时间线，
          不会半小时后还在吃同一顿饭。
          <br>
          <b>主动分享</b>是它自己决定「这会儿值得在群里说一句」，然后<b>主动发出去</b> ——
          没人问它。开着的时候它会替你说话，不想要就关掉。
          <br>
          人生<b>跟着人设走</b>：切人设就切它的人生。下面这个选择框是临时切换用的
          （比如你想让这个人设换一份日子过）；两个开关存在 <code>state.json</code> 里，
          <b>点了立刻生效</b>，不用重启机器人。
        </p>

        <div class="switches">
          <label class="sw"><input type="checkbox" id="lifeEnabled"><span>人生模拟</span></label>
          <label class="sw"><input type="checkbox" id="shareEnabled"><span>主动发言</span></label>
          <span class="muted" id="lifeSwitchHint"></span>
        </div>

        <div class="lifebar">
          <label class="muted" for="lifePick">这份人生</label>
          <select id="lifePick"></select>
          <button class="ghost tiny" id="btnLifeSwitch" type="button">切换</button>
          <span class="muted">新建：</span>
          <input type="text" id="lifeNewName" placeholder="名字，比如 阿岚" style="width:130px">
          <label class="muted" style="display:flex;align-items:center;gap:4px">
            <input type="checkbox" id="lifeSeed" checked> 复制当前这份当起点
          </label>
          <button class="ghost tiny" id="btnLifeCreate" type="button">新建</button>
          <button class="bad tiny" id="btnLifeClear" type="button">清空生活日志</button>
        </div>
        <div class="muted" id="lifeHint" style="margin-bottom:10px"></div>

        <div id="lifeBody"></div>
      </details>
    </div>

    <div id="slotApi"></div>
  </div>

  <!-- ============ 记忆 + 人生 现在是「人设」的子项（见接入 API 页的人设卡）============ -->

  <!-- 共用的「回复行为」卡：只在「未接入 API」「接入 API」两页出现，
       切页时把这一整张卡搬进对应页的插槽里（不复制，避免两个同名 id）。 -->
  <div class="card" id="cardReply" style="display:none">
    <h2>回复行为</h2>

    <label class="field">
      <span class="lbl">回复范围</span>
      <select id="replyScope">
        <option value="whitelist">只回白名单里的会话（安全默认）</option>
        <option value="all">回复所有对话（白名单不生效）</option>
      </select>
    </label>
    <p class="hint" id="scopeHint"></p>

    <label class="field">
      <span class="lbl">白名单会话名（多个用英文逗号分隔）</span>
      <input type="text" id="whitelist" placeholder="示例群">
    </label>

    <div class="row3">
      <label class="field">
        <span class="lbl">未被 @ 时的回复概率（0~1）</span>
        <input type="number" id="replyProbability" min="0" max="1" step="0.05">
      </label>
      <label class="field">
        <span class="lbl">发送间隔（毫秒，0=不限）</span>
        <input type="number" id="cooldownMs" min="0" step="500">
      </label>
      <label class="field">
        <span class="lbl">每分钟上限（0=不限）</span>
        <input type="number" id="maxRepliesPerMinute" min="0">
      </label>
    </div>

    <label class="switch">
      <input type="checkbox" id="mentionAlwaysReplies">
      <span>被 @ 时一定回复</span>
    </label>

    <!-- 系统消息过滤（规则表在 src/system-msg.js，每条都有实测依据） -->
    <label class="switch">
      <input type="checkbox" id="ignoreSystemMessages">
      <span>不回 QQ 自己的系统提示（临时会话 / 防骗通知 / 撤回 / 拍一拍…）</span>
    </label>
    <label class="field">
      <span class="lbl">额外要屏蔽的关键词或正则（多个用逗号分隔）</span>
      <input type="text" id="systemPatterns" placeholder="某某公众号, ^系统提示">
    </label>
    <p class="muted" id="systemHint" style="margin:-6px 0 14px"></p>
    <label class="switch">
      <input type="checkbox" id="dryRun">
      <span>只报告不发送（dryRun）— <b>勾上就不会真的发消息</b></span>
    </label>

    <label class="field">
      <span class="lbl">回复长度上限（字符）</span>
      <input type="number" id="maxChars" min="1">
    </label>
  </div>

  <div class="savebar">
    <button id="btnSave">保存设置</button>
    <button class="ghost" id="btnReload">重新读取</button>
    <div class="savestate" id="saveState" style="display:none"></div>
  </div>

</div>
<div class="toast" id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
let VIEW = null;          // 最近一次读到的配置
let SHOWN_KEY = '';       // 明文 key 只在点了「显示」后才有

function toast(msg, kind) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, 3200);
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(await r.text().catch(() => ('HTTP ' + r.status)));
  return r.json();
}

// ---------------------------------------------------------------- 渲染 ----
const PROVIDER_HINTS = {
  deepseek: 'deepseek-chat 便宜稳定。申请：platform.deepseek.com/api_keys',
  kimi: '当前可用：kimi-k3 / kimi-k2.7-code / kimi-k2.7-code-highspeed / kimi-k2.6。注意旧的 moonshot-v1-* 和 kimi-k2-* 已下线。API 是计费的。',
  zhipu: 'glm-4.5-air 那档通常最便宜。申请：open.bigmodel.cn',
  local: '本地推理服务，不花钱也不联网。地址按你用的那个填：'
    + 'Ollama http://127.0.0.1:11434/v1 ｜ LM Studio http://127.0.0.1:1234/v1 ｜ '
    + 'llama.cpp http://127.0.0.1:8080/v1 ｜ vLLM http://127.0.0.1:8000/v1。'
    + '模型名点「检测服务」让它自己报出来。'
    + '注意：本地小模型常常不支持 JSON 模式，整理记忆报 400 时把 config.memory.jsonMode 设成 false。',
};

function renderProviders(view) {
  const sel = $('provider');
  sel.innerHTML = '';
  for (const name of Object.keys(view.providers)) {
    const o = document.createElement('option');
    o.value = name; o.textContent = name;
    sel.appendChild(o);
  }
  sel.value = view.active;

  const p = view.providers[view.active] || {};
  $('model').value = p.model || '';
  $('baseUrl').value = p.baseUrl || '';
  $('modelHint').textContent = PROVIDER_HINTS[view.active] || '';
  renderKeyState(p);
  renderThinking(p);
  $('apiKey').value = '';
  $('apiKey').type = 'password';
  $('toggleKey').textContent = '显示';
  SHOWN_KEY = '';
  $('probeHint').textContent = '';
  $('modelPickWrap').style.display = 'none';
}

// -------------------------------------------------------- 系统消息过滤 ----
//
// 为什么要有它（真实日志）：轮询那轮里 3 条回复是在回 QQ 自己的提示 ——
// 「临时会话」「该用户通过“临时会话谨防兼职刷单…」。回它既没意义，
// 又一眼能看出这边是机器人。
//
// 界面上把**内置规则名**列出来：让人知道到底筛了哪些，而不是盲信一个开关。
// 规则表本身在 src/system-msg.js，每条都注明了实测依据。
function renderSystemHint(view) {
  const names = (view.systemRules || []).map((r) => r.name).join(' · ');
  const off = $('ignoreSystemMessages').checked === false;
  $('systemHint').textContent = (off
    ? '现在是：**不过滤** —— QQ 的提示语也会被当成消息回。'
    : '现在是：过滤开着。内置规则：') + (off ? '' : names)
    + (off ? '' : '。这些都是机器拼出来的话，不是人打的字。');
}
//
// 「本地小模型太慢」这个问题，很多时候不是模型不行，是**它在"想"**：
// Qwen3 这类推理模型默认先输出一大段 reasoning，再给正文。
// 实测本机 qwen3-14b：开思考 → 端到端 55~65 秒、首字要等 50 秒左右；
// 关掉 → 首字 0.2 秒、端到端 15 秒上下。聊天这种短回复根本用不着想那么久。
//
// ⚠ 只对**本地服务**显示这个开关：这个参数走「chat_template_kwargs」，
//   那是 llama.cpp / vLLM 这一族的扩展字段，云端厂商（DeepSeek 等）不认它，
//   硬发过去可能直接 400 —— 所以别的厂商下这一块整个收起来，也不写那个键。
function renderThinking(p) {
  const wrap = $('thinkingWrap');
  if (!wrap) return;
  const local = p?.isLocal === true;
  wrap.style.display = local ? '' : 'none';
  if (!local) return;

  const on = p.enableThinking !== false;
  $('enableThinking').checked = on;
  $('thinkingHint').textContent = on
    ? '现在是：先推理再作答。回复质量更稳，但**慢得多**（实测本机 55~65 秒一条，首字要等 50 秒左右）。'
      + '嫌慢就把它关掉。'
    : '现在是：直接作答，不输出思考过程（实测本机首字 0.2 秒、端到端 15 秒上下）。'
      + '觉得回复变浅了再打开。';
}

// 「要不要 key」和「配没配」是两件事，界面上必须分开说。
// 本地推理服务本来就无需 key，显示成红色的"未配置"会让人以为坏了。
function renderKeyState(p) {
  const kb = $('keyBadge');
  const needKey = p.requiresKey !== false;
  if (p.key && p.key.set) {
    kb.textContent = '已配置 ' + p.key.masked;
    kb.className = 'badge set';
  } else if (!needKey) {
    kb.textContent = '这家不需要 key';
    kb.className = 'badge set';
  } else {
    kb.textContent = '未配置';
    kb.className = 'badge unset';
  }
  $('keyHint').textContent = needKey
    ? ('环境变量名：' + (p.apiKeyEnv || '') + '（写入项目根目录的 .env，不会提交到版本库）')
    : ('本地服务一般不校验 key，留空即可。要填的话写进 .env 的 ' + (p.apiKeyEnv || 'LOCAL_API_KEY') + '。');
  $('apiKey').placeholder = needKey ? '粘贴 key，留空表示不改' : '本地服务可以留空';
}

function renderAll(view) {
  VIEW = view;
  renderProviders(view);

  $('contextMessages').value = view.llm.contextMessages;
  $('timeoutMs').value = view.llm.timeoutMs;
  $('maxTokens').value = view.llm.maxTokens;

  $('whitelist').value = (view.trigger.whitelist || []).join(',');
  $('replyScope').value = view.trigger.replyScope === 'all' ? 'all' : 'whitelist';
  renderScopeHint();
  $('replyProbability').value = view.trigger.replyProbability ?? '';
  $('cooldownMs').value = view.trigger.cooldownMs;
  $('maxRepliesPerMinute').value = view.trigger.maxRepliesPerMinute;
  $('mentionAlwaysReplies').checked = !!view.trigger.mentionAlwaysReplies;
  $('ignoreSystemMessages').checked = view.trigger.ignoreSystemMessages !== false;
  $('systemPatterns').value = (view.trigger.systemPatterns || []).join(', ');
  renderSystemHint(view);
  $('dryRun').checked = !!view.reply.dryRun;
  $('maxChars').value = view.reply.maxChars;

  $('takeoverNow').checked = view.state.takeoverEnabled === true;
  // 人设提示词现在由 loadPersonas() 填（它读的是 personas/<名字>.json）
  $('fallbackWhenApiDown').checked = view.reply.fallbackWhenApiDown !== false;
  renderFbHint();

  renderPools(view);
  renderRules(view);
  renderPoll(view);
  // 人设要在记忆/人生**之前**读：那两块显示的是"当前人设的"记忆与人生，
  // 顺序反了会先画出上一个身份的内容再被覆盖（闪一下，而且容易看错）。
  loadPersonas();
  loadMemory();
  loadLife();
  renderStale(view.console);

  setRunning(view.state.running);
}

// ------------------------------------------------------------ 接管兜底 ----
//
// 用户问「为什么接管模式还有固定回复」之后加的开关。
// 这里要把它**什么时候管用**说清楚，否则很容易被误解成"接管时也在发固定回复"。
function renderFbHint() {
  const on = $('fallbackWhenApiDown').checked;
  $('fbHint').textContent = on
    ? '现在是：模型调不通时会用固定回复池顶一句（日志里写 来源=fallback:...:persona）。'
      + '模型正常时一次都用不到。'
    : '现在是：模型调不通时**这条就不回**（什么时候接上、下一轮再回）。'
      + '注意这个开关只管「请求发出去了却失败」——'
      + '没配 key、或者主动关掉了大模型，仍然按老规矩用固定回复池。';
}

// ---------------------------------------------------------------- 分页 ----
//
// 以前是一张长页面七张卡，用户说「非常杂乱」。现在四页，一次只显示一页。
//
// 「回复行为」那张卡在「未接入 API」「接入 API」两页都要用，做法是**搬节点**：
// 同一张卡在两个页面的插槽之间移动。不复制的原因很实在 ——
// 复制就有两个 id="whitelist"，改了一个、保存时读的是另一个，
// 会出现"我改了但没生效"，而且是静默的。
// 记忆现在是「接入 API → 人设」的子项，所以这一页没了（三个页签）
const TAB_KEYS = ['main', 'local', 'api'];
let CURRENT_TAB = 'main';

function showTab(name) {
  const t = TAB_KEYS.includes(name) ? name : 'main';
  CURRENT_TAB = t;
  for (const k of TAB_KEYS) {
    const el = $('page-' + k);
    if (el) el.hidden = (k !== t);
  }
  for (const b of document.querySelectorAll('#tabs .tab')) {
    b.classList.toggle('active', b.dataset.tab === t);
  }
  // 共用的回复行为卡：搬到当前页的插槽；主界面/记忆页没有插槽 → 收起来
  const slot = t === 'local' ? $('slotLocal') : (t === 'api' ? $('slotApi') : null);
  const card = $('cardReply');
  if (slot) {
    slot.appendChild(card);
    card.style.display = '';
  } else {
    card.style.display = 'none';
  }
  // 用 replaceState 而不是 location.hash = ...：后者会触发 hashchange，
  // 和下面的监听凑成一次来回跳转（页面会闪一下、还要多写一层防重入）。
  try {
    const url = t === 'main' ? location.pathname + location.search : ('#' + t);
    history.replaceState(null, '', url);
  } catch { /* file:// 之类不支持就算了，不影响功能 */ }
}

for (const b of document.querySelectorAll('#tabs .tab')) {
  b.addEventListener('click', () => showTab(b.dataset.tab));
}
window.addEventListener('hashchange', () => showTab(String(location.hash || '').replace(/^#/, '')));

// ---------------------------------------------------------------- 人设 ----
//
// 一份人设 = 一个身份：提示词 + 它的人生 + 它自己的记忆。切换**立刻生效**。
//
// 为什么这些操作不走上面那个「保存」按钮：
//   保存写的是 config.json，而机器人只在启动时读它 —— 等于"改完要重启"。
//   切人设显然不该重启（跟切人生、切接管开关是同一类操作），
//   所以它走独立接口 /api/personas，只写 state.json + 人设文件，机器人每轮现读。
let PERSONAS = null;

async function loadPersonas() {
  try {
    const v = await api('/api/personas');
    PERSONAS = v;
    renderPersonas(v);
  } catch (e) {
    $('personaHint').textContent = '读取人设失败：' + e.message;
  }
}

function renderPersonas(v) {
  const sel = $('personaPick');
  sel.textContent = '';
  for (const p of v.list || []) {
    const o = document.createElement('option');
    o.value = p.name;
    o.textContent = p.name + (p.isActive ? '（当前）' : '') + (p.lines ? ' · ' + p.lines + ' 行' : '');
    sel.appendChild(o);
  }
  if (v.active) sel.value = v.active;

  const n = (v.list || []).length;
  const hasActive = Boolean(v.active);
  sel.disabled = n === 0;
  $('personaPrompt2').value = (v.prompt || []).join('\\n');
  $('personaPrompt2').disabled = !hasActive;
  $('btnPersonaSavePrompt').disabled = !hasActive;
  $('btnPersonaDelete').disabled = !hasActive;
  $('btnPersonaSwitch').disabled = n === 0;
  $('btnPersonaSeedFromConfig').style.display =
    (n === 0 && v.promptSource && v.promptSource.from === 'config') ? '' : 'none';

  $('personaHint').textContent = hasActive
    ? ('当前是「' + v.active + '」。它的人生 = ' + v.life + '　它的记忆 = ' + v.memoryDir)
    : ('还没有人设。人设文件放在 ' + v.dir + '/ 下（一份一个文件）。'
      + '点「用 config.json 里那份提示词建一份人设」开始：会用你现在这份提示词和当前人生，'
      + '记忆也会拷一份到 memory/<名字>/ 下（原来的不动、不会删）。');
  $('personaSaveHint').textContent = '';
}

// 切换 / 新建 / 删除都是"立刻生效"，所以点完直接重读面板
async function personaPost(body, what) {
  const r = await api('/api/personas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { toast(what + '失败：' + r.error, 'err'); return null; }
  PERSONAS = r.view;
  renderPersonas(r.view);
  loadMemory();     // 换了人设 = 换了记忆，面板要跟着变
  loadLife();       // 人生也跟着人设走
  return r;
}

$('btnPersonaSwitch').addEventListener('click', async () => {
  const name = $('personaPick').value;
  if (!name) return;
  const r = await personaPost({ switch: name }, '切换人设');
  if (r) toast('已切到人设「' + name + '」' + (r.view && r.view.life ? '　人生：' + r.view.life : ''), 'ok');
});

$('btnPersonaCreate').addEventListener('click', async () => {
  const name = $('personaNewName').value.trim();
  if (!name) { toast('先给人设起个名字'); return; }
  const seed = $('personaSeed').checked;
  const r = await personaPost({ create: name, seed: seed }, '新建人设');
  if (r) {
    $('personaNewName').value = '';
    toast('已新建并切到「' + name + '」' + (seed ? '（克隆当前这份：提示词+记忆+人生）' : '（新身份）'), 'ok');
  }
});

$('btnPersonaSavePrompt').addEventListener('click', async () => {
  const name = (PERSONAS && PERSONAS.active) || '';
  const lines = $('personaPrompt2').value.split('\\n');
  const r = await personaPost({ savePrompt: lines, name: name }, '保存提示词');
  if (r) { $('personaSaveHint').textContent = '已保存（立即生效，不用重启机器人）'; toast('提示词已保存', 'ok'); }
});

$('btnPersonaSeedFromConfig').addEventListener('click', async () => {
  const r = await personaPost({ seedFromConfig: true }, '从 config 建人设');
  if (r) toast('已建好人设（提示词从 config.json 搬来）—— 想用它请点「切换」', 'ok');
});

$('btnPersonaDelete').addEventListener('click', async () => {
  const name = (PERSONAS && PERSONAS.active) || '';
  if (!name) return;
  if (!confirm('删掉人设「' + name + '」？\\n\\n它的提示词文件会被删除；\\n它的记忆（memory/' + name + '/）和人生（lives/' + name + '.json）会保留在磁盘上。')) return;
  const r = await personaPost({ remove: name }, '删除人设');
  if (r) toast('已删掉人设「' + name + '」（记忆和人生没动）', 'ok');
});

// ---------------------------------------------------------------- 记忆 ----
// 只读展示。注意这个文件整体是个模板字符串，**里面不能出现反引号**，
// 也不能写裸的反斜杠 n（两者都会把外层模板提前闭合，踩过两次）。
//
// 记忆分两层（总记忆 + 每个会话一份），所以这里可以指定要看哪个会话 ——
// 不指定时后端会给最近更新的那一份。
//
// MEM_VIEW 存最近一次拿到的记忆视图，清空按钮要知道当前在看哪个会话。
let MEM_VIEW = null;

function loadMemory(conversation) {
  const q = conversation ? ('?conversation=' + encodeURIComponent(conversation)) : '';
  api('/api/memory' + q).then((r) => {
    renderMemory(r);
  }).catch((e) => {
    $('memHint').textContent = '读取失败：' + e.message;
    $('memBody').textContent = '';
  });
}

function renderMemory(r) {
  MEM_VIEW = r;
  const host = $('memBody');
  host.textContent = '';

  const g = (r.global && r.global.memory) || {};
  const c = (r.conversation && r.conversation.memory) || {};
  const m = r.memory || {};
  const nRel = (c.relations || []).length;
  const nEvents = (c.events || []).length;

  const memLine = '总记忆：' + (g.facts || []).length + ' 条自我认知 · ' + (g.likes || []).length + ' 个喜好'
    + '　｜　会话记忆：' + ((r.conversations || []).length) + ' 份'
    + (r.conversation && r.conversation.name
      ? '，当前查看「' + r.conversation.name + '」（' + nEvents + ' 条经历 · ' + nRel + ' 个关系）'
      : '')
    + (r.persona ? '　｜　属于人设「' + r.persona + '」' : '');
  $('memHint').textContent = memLine;
  // 折叠着的子项标题上也写一句，不用展开就知道里面有没有东西
  $('memSummary').textContent = (r.persona ? '人设「' + r.persona + '」· ' : '')
    + (r.dir || '') + '　'
    + ((r.conversations || []).length) + ' 份会话记忆'
    + (r.global && r.global.exists ? ' · 有总记忆' : ' · 还没有总记忆');

  if (!r.exists) {
    const p = document.createElement('div');
    p.className = 'muted';
    p.textContent = '（暂时没有记忆 —— 机器人第一次回复之后会自动创建）';
    host.appendChild(p);
    return;
  }

  // 0) 会话切换 —— 记忆是按会话分开的，面板必须能一份份看
  if ((r.conversations || []).length > 0) {
    const t = document.createElement('div');
    t.className = 'group-title';
    t.textContent = '选一个会话查看（' + (r.dir || 'memory') + '/ 目录）';
    host.appendChild(t);

    const row = document.createElement('div');
    row.className = 'btnrow';
    row.style.flexWrap = 'wrap';
    row.style.marginBottom = '10px';
    for (const item of r.conversations) {
      const chip = document.createElement('span');
      chip.style.display = 'inline-flex';
      chip.style.alignItems = 'center';
      chip.style.gap = '2px';

      const b = document.createElement('button');
      b.type = 'button';
      b.className = (item.conversation === (r.conversation && r.conversation.name)) ? 'tiny' : 'ghost tiny';
      const cnt = item.counts ? (' · ' + item.counts.events + '/' + item.counts.relations) : '';
      b.textContent = (item.conversation || item.file) + cnt;
      b.addEventListener('click', function () { loadMemory(item.conversation); });
      chip.appendChild(b);

      // 每个会话旁边再挂一个「删」。
      // 为什么不能只靠上面那个「清空」：清空只是把内容抹掉，**条目还留在列表里**，
      // 于是用户会看到一排空壳、点不掉也没别的地方能删（实测就是这么反馈的）。
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'bad tiny';
      x.textContent = '删';
      x.title = '删除这份会话记忆（连文件一起删掉，列表里不再出现）';
      x.addEventListener('click', function () { deleteConversationMemory(item); });
      chip.appendChild(x);

      row.appendChild(chip);
    }
    host.appendChild(row);
  }

  // 1) 模型实际看到的那段文字 —— 排查「它怎么记不住」时最该看的就是这个
  const digestTitle = document.createElement('div');
  digestTitle.className = 'group-title';
  digestTitle.textContent = '模型实际读到的内容（＝ 总记忆 + 这个会话的记忆，拼进提示词的就是这段）';
  host.appendChild(digestTitle);

  const digest = document.createElement('pre');
  digest.className = 'logs';
  digest.style.maxHeight = '220px';
  digest.textContent = r.digest || '（空 —— 记忆里还没有任何内容，不会注入提示词）';
  host.appendChild(digest);

  // 2) 两层的原始 JSON 分开看
  const rawBlock = function (title, note, obj, pathText) {
    const t = document.createElement('div');
    t.className = 'group-title';
    t.textContent = title + (pathText ? '　' + pathText : '');
    host.appendChild(t);
    if (note) {
      const n = document.createElement('div');
      n.className = 'muted';
      n.style.marginBottom = '4px';
      n.textContent = note;
      host.appendChild(n);
    }
    const pre = document.createElement('pre');
    pre.className = 'logs';
    pre.style.maxHeight = '240px';
    const clone = JSON.parse(JSON.stringify(obj || {}));
    delete clone['$comment'];
    pre.textContent = JSON.stringify(clone, null, 2);
    host.appendChild(pre);
  };

  rawBlock('总记忆（不分跟谁聊的）', '我是谁、喜欢什么、讨厌什么',
    g, r.global && r.global.path ? '(' + r.global.path + ')' : '');
  rawBlock('这个会话的记忆' + (r.conversation && r.conversation.name ? '（' + r.conversation.name + '）' : ''),
    '在这里的心情、经历、和这里的人的关系、话题',
    c, r.conversation && r.conversation.path ? '(' + r.conversation.path + ')' : '');

  // 3) 关系列表单独列一下 —— 这是最容易出错（记错人/记出占位名）的地方
  if (nRel > 0) {
    const relTitle = document.createElement('div');
    relTitle.className = 'group-title';
    relTitle.textContent = '这个会话里认识的人';
    host.appendChild(relTitle);
    const ul = document.createElement('div');
    for (const x of c.relations) {
      const row = document.createElement('div');
      row.className = 'muted';
      row.style.margin = '2px 0';
      row.textContent = '· ' + x.name + (x.role ? '（' + x.role + '）' : '') + (x.note ? '：' + x.note : '');
      ul.appendChild(row);
    }
    host.appendChild(ul);
  }
}

// ------------------------------------------------------------ 回复范围 ----
// 这一项最容易搞错：以前只能靠"白名单填没填"表达"要不要限制范围"，
// 而"把白名单清空"的效果恰好是**谁也不回**（跟直觉相反）。
// 所以选完立刻把**后果**写在下面，而不是让人自己推。
function renderScopeHint() {
  const mode = $('replyScope').value;
  const wl = $('whitelist').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const hint = $('scopeHint');
  if (mode === 'all') {
    hint.textContent = '所有会话都会回。白名单这一栏不参与判定（留着不影响）。黑名单仍然生效。';
    return;
  }
  if (wl.length === 0) {
    hint.textContent = '⚠ 白名单是空的，这个模式下谁都不回。要么在上面填会话名，要么把回复范围改成「回复所有对话」。';
    return;
  }
  hint.textContent = '只回这些会话：' + wl.join('、') + '。';
}

function setRunning(on) {  $('dot').className = 'dot ' + (on ? 'on' : 'off');
  $('btnStart').disabled = on;
  $('btnStop').disabled = !on;
  $('runHint').textContent = on ? '运行中' : '未运行';
}

// ------------------------------------------------------------ 人生模拟 ----
// 开关和"当前是谁的人生"都在 state.json 里（机器人每轮现读），所以这里
// 改完**立刻生效**，不需要重启机器人。这也是它们不走 /api/config 的原因。
//
// ⚠ 和记忆面板一样：这个文件整体是个模板字符串，不能出现反引号，
//    也不能写裸的反斜杠 n（用 \\n）。
let LIFE_VIEW = null;

async function loadLife() {
  try {
    const view = await api('/api/life');
    renderLifeView(view);
  } catch (e) {
    $('lifeHint').textContent = '读取失败：' + e.message;
  }
}

function renderLifeView(v) {
  LIFE_VIEW = v;

  // 开关：勾上 = 生效中的值
  $('lifeEnabled').checked = v.enabled === true;
  $('shareEnabled').checked = !!(v.share && v.share.enabled);
  // 人生模拟关着时，主动分享必然是关的（没模拟就没东西可发）—— 直接禁用，
  // 免得用户在那儿反复点一个"点了也没用"的开关。
  $('shareEnabled').disabled = v.enabled !== true;

  const swHint = [];
  if (v.overridden && v.overridden.lifeEnabled) swHint.push('（人生模拟已被控制台覆盖：config 里是 ' + (v.configuredEnabled ? '开' : '关') + '）');
  if (v.overridden && v.overridden.shareEnabled) swHint.push('（主动分享已被控制台覆盖：config 里是 ' + (v.configuredShare ? '开' : '关') + '）');
  $('lifeSwitchHint').textContent = swHint.join(' ');

  // 人生下拉：默认那份 + lives/ 目录里的每一份
  const pick = $('lifePick');
  pick.textContent = '';
  const opts = v.lives && v.lives.length ? v.lives : [];
  if (opts.length === 0) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '（还没有任何人生文件）';
    pick.appendChild(o);
  }
  for (const L of opts) {
    const o = document.createElement('option');
    o.value = L.profile;
    const name = L.profile || '（默认那份）';
    o.textContent = name + ' · ' + L.total + ' 条' + (L.shared ? ' · 主动说过 ' + L.shared + ' 次' : '');
    pick.appendChild(o);
  }
  pick.value = v.profile || '';

  // 「复制当前这份当起点」：当前这份是空的就没东西可抄 —— 取消勾选并禁用，
  // 免得用户以为抄过去了、结果新建出一份空的还以为出错了。
  const canSeed = v.total > 0;
  $('lifeSeed').disabled = !canSeed;
  $('lifeSeed').checked = canSeed;

  const hint = [];
  hint.push('当前：' + (v.profile || '（默认那份）') + '　文件：' + v.file);
  if (v.enabled) {
    hint.push('每 ' + v.everyChecks + ' 次控制台检测试一次（期间调用过 API 就跳过）');
  }
  if (v.share && v.share.enabled) {
    const quiet = v.share.quietFrom !== v.share.quietTo ? '，静默 ' + v.share.quietFrom + '~' + v.share.quietTo + ' 点' : '';
    hint.push('主动分享：至少隔 ' + v.share.minIntervalMinutes + ' 分钟、每天最多 ' + v.share.maxPerDay + ' 次'
      + quiet + '，今天已 ' + v.share.sharesToday + ' 次');
    hint.push('允许的会话：' + ((v.share.allowed && v.share.allowed.length) ? v.share.allowed.join('、') : '（空 → 不会发）'));
  } else {
    hint.push('主动分享：关 —— 不会自己往群里说话');
  }
  hint.push('未选中的那份也存在 ' + v.livesDir + ' 里，随时切回去');
  $('lifeHint').textContent = hint.join('　｜　');
  // 折叠着的子项标题上写一句：现在过的是谁的日子、有几条记录
  // （字段名看 lifeView：total = 总条数，recent = 最近几条）
  $('lifeSummary').textContent = '当前：' + (v.profile || '(未命名)')
    + '　' + (v.total ?? (v.recent || []).length) + ' 条记录'
    + (v.enabled ? ' · 人生模拟开着' : ' · 人生模拟关着');

  renderLifeBody(v);
}

function renderLifeBody(v) {
  const host = $('lifeBody');
  host.textContent = '';

  const title = document.createElement('div');
  title.className = 'group-title';
  title.textContent = '生活日志' + (v.total ? '（共 ' + v.total + ' 条，最近更新 ' + (v.updatedAt || '未知') + '）' : '');
  host.appendChild(title);

  if (v.reason && v.reason !== 'missing') {
    const warn = document.createElement('div');
    warn.className = 'muted';
    warn.textContent = '文件读取有问题：' + v.reason;
    host.appendChild(warn);
  }

  if (!v.total) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = v.enabled
      ? '还没有记录 —— 等它空闲下来第一次模拟（约 ' + v.everyChecks + ' 次控制台检测之后）。'
      : '人生模拟关着，不会有记录。打开上面那个开关试试。';
    host.appendChild(empty);
  }

  for (const e of v.recent || []) {
    const row = document.createElement('div');
    row.className = 'muted';
    row.style.margin = '2px 0';
    const when = e.at ? new Date(e.at).toLocaleString('zh-CN', { hour12: false }) : '';
    const parts = [];
    if (e.mood) parts.push('心情：' + e.mood);
    if (e.doing) parts.push('在做：' + e.doing);
    if (e.thinking) parts.push('想着：' + e.thinking);
    row.textContent = '· ' + when + '　' + parts.join('　｜　');
    host.appendChild(row);

    // 主动发言的痕迹单独一行：它是发给真人看的话，
    // 混在生活记录里看不见就没法追查"它那天为什么冒那句"。
    if (e.share) {
      const srow = document.createElement('div');
      srow.className = 'muted';
      srow.style.margin = '0 0 4px 14px';
      if (e.shared && e.shared.sent) {
        srow.textContent = '　└ 主动发言 ✓ 「' + (e.shared.text || '') + '」'
          + (e.shared.conversation ? ' → ' + e.shared.conversation : '')
          + (e.shared.at ? '（' + new Date(e.shared.at).toLocaleTimeString('zh-CN', { hour12: false }) + '）' : '');
      } else if (e.share.suitable) {
        srow.textContent = '　└ 想说但没发：「' + (e.share.text || '（空）') + '」'
          + (e.shared && e.shared.reason ? '　原因：' + e.shared.reason : '');
      } else {
        srow.textContent = '　└ 判断：这会儿不说' + (e.share.why ? '（' + e.share.why + '）' : '');
      }
      host.appendChild(srow);
    }
  }

  if (v.share) {
    const stat = document.createElement('div');
    stat.className = 'muted';
    stat.style.marginTop = '8px';
    stat.textContent = '这份人生里：模型判断过 ' + v.share.totalConsidered + ' 次，'
      + '其中觉得适合分享 ' + v.share.totalSuitable + ' 次，实际发出 ' + v.share.totalShared + ' 条。';
    host.appendChild(stat);
  }

  const dt = document.createElement('div');
  dt.className = 'group-title';
  dt.textContent = '注入提示词的那段';
  host.appendChild(dt);
  const pre = document.createElement('pre');
  pre.className = 'logs';
  pre.style.maxHeight = '160px';
  pre.textContent = v.digest || '（空 —— 没有记录，不会注入）';
  host.appendChild(pre);
}

async function postLife(body, okMsg) {
  try {
    const view = await api('/api/life', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    renderLifeView(view);
    if (okMsg) toast(okMsg, 'ok');
  } catch (e) {
    toast('操作失败：' + e.message, 'err');
    loadLife();
  }
}

// ------------------------------------------------------------ 代码过期 ----
// 控制台的 server.js / page.js 是 Node 在 import 时读一次就缓存的 ——
// 改了代码之后，跑着的那个进程照旧发旧页面，刷新浏览器也没用（这不是缓存问题，
// 是进程内存里的就是旧代码）。启动器又只会在端口没人用时才启动新进程，
// 所以「双击启动器」也救不了。这一条就是让界面自己把话说清楚。
function renderStale(info) {
  const box = $('staleWarn');
  if (!box) return;
  if (!info || info.stale !== true) {
    box.style.display = 'none';
    box.textContent = '';
    return;
  }
  box.style.display = '';
  box.textContent = '';

  const l1 = document.createElement('div');
  l1.innerHTML = '<b>⚠ 这个控制台跑的是旧代码</b> —— 磁盘上的 <code>'
    + (info.newestFile || 'gui/') + '</code> 比它启动的时间新。';
  box.appendChild(l1);

  const l2 = document.createElement('div');
  l2.textContent = '它启动于 ' + (info.startedAtText || '未知')
    + '，之后 gui/ 下的文件被改过。所以你现在看到的界面**不是**最新的 —— '
    + '刷新浏览器也没用（旧代码在进程内存里）。';
  box.appendChild(l2);

  const l3 = document.createElement('div');
  l3.innerHTML = '修法：关掉那个控制台窗口，再双击一次 <code>机器人控制台.cmd</code>；'
    + '或者直接双击启动器，它会问你「要不要重启」——选 <b>Y</b> 就会自己换掉。';
  box.appendChild(l3);
}

// -------------------------------------------------------- 固定回复池编辑 ----
/** 接管模式那几项单独归一组，其余归普通组 —— 界面上分开摆放更好找。 */
const PERSONA_POOL_KEYS = ['personaGeneric', 'personaGreeting', 'personaQuestion',
  'personaThanks', 'personaComplaint', 'personaLaughter'];

function renderPools(view) {
  const host = $('poolsEditor');
  host.textContent = '';

  const entries = Object.entries(view.pools || {});
  const normal = entries.filter(([k]) => !PERSONA_POOL_KEYS.includes(k));
  const persona = entries.filter(([k]) => PERSONA_POOL_KEYS.includes(k));

  // 分层：卡片 → 分组（普通 / 接管）→ 单个池子 → 句子。
  //
  // 为什么要折叠：这里是十几个池子、每个一个多行输入框，全摊开要滚好几屏，
  // 而用户平时只会改其中一两个。改成"分组默认收起、summary 上写清有几项几句话、
  // 有没有改过"，一眼能看完全貌，要改哪个再点开。
  //
  // ⚠ 折叠**不能**让保存漏掉：textarea 在 <details> 收起时依然在 DOM 里，
  //   collectPools() 按 [data-pool-key] 取，照样取得到（这点很关键）。
  const makeGroup = (title, hint, list) => {
    if (list.length === 0) return;

    const grp = document.createElement('details');
    grp.className = 'grp';

    const sum = document.createElement('summary');
    const nameEl = document.createElement('span');
    nameEl.textContent = title;
    sum.appendChild(nameEl);

    const changed = list.filter(([, v]) => v.overridden).length;
    const sentences = list.reduce((n, [, v]) => n + ((v.effective || []).length), 0);
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = '　' + list.length + ' 项 · ' + sentences + ' 句'
      + (changed ? ' · 有 ' + changed + ' 项改过' : ' · 全是默认值')
      + (hint ? '　（' + hint + '）' : '');
    sum.appendChild(meta);
    grp.appendChild(sum);

    for (const [key, info] of list) {
      const det = document.createElement('details');
      det.className = 'pool';

      const s = document.createElement('summary');
      const nm = document.createElement('span');
      nm.className = 'pname';
      nm.textContent = info.label || key;
      s.appendChild(nm);

      const badge = document.createElement('span');
      badge.className = 'badge ' + (info.overridden ? 'set' : 'unset');
      badge.textContent = info.overridden ? '已自定义' : '默认';
      badge.dataset.role = 'badge';
      s.appendChild(badge);

      const count = document.createElement('span');
      count.className = 'pcount';
      s.appendChild(count);
      det.appendChild(s);

      const ta = document.createElement('textarea');
      ta.rows = Math.min(8, Math.max(2, (info.effective || []).length));
      ta.value = (info.effective || []).join('\\n');
      ta.dataset.poolKey = key;
      ta.spellcheck = false;
      det.appendChild(ta);

      const row = document.createElement('div');
      row.className = 'btnrow';
      row.style.margin = '4px 0 8px';
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'ghost tiny';
      reset.textContent = '恢复默认';
      reset.addEventListener('click', () => {
        ta.value = (info.builtin || []).join('\\n');
        updateCount();
      });
      row.appendChild(reset);
      det.appendChild(row);

      const updateCount = () => {
        const n = ta.value.split('\\n').map((x) => x.trim()).filter(Boolean).length;
        count.textContent = n + ' 句';
      };
      ta.addEventListener('input', updateCount);
      updateCount();

      grp.appendChild(det);
    }

    host.appendChild(grp);
    return grp;
  };

  const g1 = makeGroup('普通模式', '没开接管、或模型调不通时用的', normal);
  const g2 = makeGroup('接管模式', '可爱语气那一套', persona);

  // 有改动的那一组默认展开 —— 用户改过就说明他正在意它，
  // 藏起来反而要多点一次。
  for (const [grp, list] of [[g1, normal], [g2, persona]]) {
    if (grp && list.some(([, v]) => v.overridden)) grp.open = true;
  }

  const overriddenCount = entries.filter(([, v]) => v.overridden).length;
  $('poolsHint').textContent = overriddenCount
    ? '有 ' + overriddenCount + ' 项被改过（已自动展开）'
    : '当前全部使用默认值';
}

/** 收集编辑区的内容，返回 { 池名: [句子…] }。 */
function collectPools() {
  const out = {};
  for (const ta of document.querySelectorAll('#poolsEditor textarea[data-pool-key]')) {
    out[ta.dataset.poolKey] = ta.value.split('\\n').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

// ------------------------------------------------------------ 自定义规则 ----
//
// 引擎里一直支持 fallback.rules（匹配写法 → 一组回复），但控制台从来没有界面，
// 只能手改 config.json —— 用户报的「未接入 API 时的回复功能无法自主增加提示词」。
//
// 界面形状：一条规则一张小卡（匹配写法 + 多行回复），顺序就是优先级，能上下移。
function renderRules(view) {
  const fb = view.fallback || {};
  $('customRulesFirst').checked = fb.customRulesFirst === true;
  const host = $('rulesEditor');
  host.textContent = '';
  const rules = Array.isArray(fb.rules) ? fb.rules : [];
  rules.forEach((r, i) => host.appendChild(makeRuleCard(r, i)));
  updateRulesHint();
}

/** 造一条规则的编辑卡。返回元素（不插入），插入由调用方决定 —— 上移/下移要用到。 */
function makeRuleCard(rule, i) {
  const box = document.createElement('div');
  box.className = 'rule';
  box.dataset.rule = '1';

  const bar = document.createElement('div');
  bar.className = 'rulebar';

  const idx = document.createElement('span');
  idx.className = 'idx';
  idx.textContent = '#' + (i + 1);
  bar.appendChild(idx);

  const match = document.createElement('input');
  match.type = 'text';
  match.className = 'ruleMatch';
  match.placeholder = '匹配写法（正则或关键词）：吃了|吃饭|吃啥';
  match.value = String(rule?.match ?? '');
  match.spellcheck = false;
  bar.appendChild(match);

  const mkBtn = (text, cls, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.addEventListener('click', fn);
    return b;
  };
  bar.appendChild(mkBtn('↑', 'ghost tiny', () => moveRule(box, -1)));
  bar.appendChild(mkBtn('↓', 'ghost tiny', () => moveRule(box, +1)));
  bar.appendChild(mkBtn('删除', 'bad tiny', () => { box.remove(); renumberRules(); updateRulesHint(); }));
  box.appendChild(bar);

  const ta = document.createElement('textarea');
  ta.className = 'ruleReplies';
  ta.rows = Math.min(8, Math.max(2, (rule?.replies || []).length || 2));
  ta.placeholder = '一行一句，随机挑一句回';
  ta.value = (rule?.replies || []).join('\\n');
  ta.spellcheck = false;
  box.appendChild(ta);

  const state = document.createElement('div');
  state.className = 'rulestate';
  box.appendChild(state);

  // 正则合法性实时提示。不合法**不是**错误：引擎会退化成子串匹配（见 ruleMatcher），
  // 但用户必须知道这件事 —— 否则他会以为自己的正则生效了。
  const check = () => {
    const v = match.value.trim();
    if (!v) { state.textContent = '还没写匹配写法 —— 这条保存时会被丢掉'; state.className = 'rulestate bad'; return; }
    try {
      new RegExp(v, 'i');
      state.textContent = '正则有效';
      state.className = 'rulestate muted';
    } catch (e) {
      state.textContent = '不是合法正则 → 会按「包含这段字」来匹配：' + e.message;
      state.className = 'rulestate bad';
    }
  };
  match.addEventListener('input', check);
  ta.addEventListener('input', updateRulesHint);
  check();

  return box;
}

function moveRule(box, dir) {
  const host = $('rulesEditor');
  const all = Array.from(host.querySelectorAll('.rule'));
  const i = all.indexOf(box);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= all.length) return;
  if (dir < 0) host.insertBefore(box, all[j]);
  else host.insertBefore(all[j], box);
  renumberRules();
  updateRulesHint();
}

function renumberRules() {
  const all = $('rulesEditor').querySelectorAll('.rule');
  all.forEach((el, i) => {
    const t = el.querySelector('.idx');
    if (t) t.textContent = '#' + (i + 1);
  });
}

function addRule(rule) {
  const host = $('rulesEditor');
  const card = makeRuleCard(rule || { match: '', replies: [] }, host.children.length);
  host.appendChild(card);
  renumberRules();
  updateRulesHint();
  const input = card.querySelector('.ruleMatch');
  if (input) input.focus();
}

function collectRules() {
  const out = [];
  for (const box of document.querySelectorAll('#rulesEditor .rule')) {
    const match = (box.querySelector('.ruleMatch')?.value || '').trim();
    const replies = (box.querySelector('.ruleReplies')?.value || '')
      .split('\\n').map((s) => s.trim()).filter(Boolean);
    out.push({ match, replies });
  }
  return out;
}

function updateRulesHint() {
  const n = document.querySelectorAll('#rulesEditor .rule').length;
  const ready = collectRules().filter((r) => r.match && r.replies.length).length;
  $('rulesHint').textContent = n === 0
    ? '还没有规则 —— 点左边那行加一条'
    : (n + ' 条，其中 ' + ready + ' 条写得完整' + (ready < n ? '（不完整的保存时会被丢掉）' : ''));
}

$('btnAddRule').addEventListener('click', () => addRule());
$('btnClearRules').addEventListener('click', () => {
  if (!confirm('把自定义规则全部删掉？（保存后才真正生效）')) return;
  $('rulesEditor').textContent = '';
  updateRulesHint();
});

// 试打一句：用**界面上正在编辑的**规则问服务端，不用先保存。
$('btnRuleTest').addEventListener('click', async () => {
  const text = $('ruleTest').value.trim();
  const out = $('ruleTestOut');
  if (!text) { toast('先写一句要试的话'); return; }
  out.textContent = '读取中…';
  try {
    const r = await api('/api/fallback/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, rules: collectRules(), customRulesFirst: $('customRulesFirst').checked }),
    });
    renderRuleTest(r, out);
  } catch (e) {
    out.textContent = '试打失败：' + e.message;
  }
});

function renderRuleTest(r, out) {
  out.textContent = '';
  const box = document.createElement('div');
  box.className = 'probeout';

  const line = (k, v) => {
    const d = document.createElement('div');
    const ks = document.createElement('span');
    ks.className = 'k';
    ks.textContent = k;
    const vs = document.createElement('span');
    vs.className = 'v';
    vs.textContent = v;
    d.appendChild(ks);
    d.appendChild(vs);
    return d;
  };

  const srcText = (s) => ({
    rule: '自定义规则',
    intent: '内置意图：' + (s.intent || '?'),
    template: '复述模板',
    generic: '兜底池',
    default: '最后一道默认回复',
    disabled: '没开（fallback.enabled = false）',
  }[s.source] || s.source || '?');

  box.appendChild(line('普通语气：', '「' + (r.plain.reply || '(空)') + '」　来源 = ' + srcText(r.plain)));
  box.appendChild(line('接管语气：', '「' + (r.persona.reply || '(空)') + '」　来源 = ' + srcText(r.persona)));

  if (r.ruleIndex >= 0) {
    box.appendChild(line('第 ' + (r.ruleIndex + 1) + ' 条规则：', '匹配上了'));
  } else if (r.ruleCount > 0) {
    box.appendChild(line('自定义规则：', '一条都没匹配上'));
  }

  if (r.ruleShadowed) {
    const w = document.createElement('div');
    w.className = 'warnline';
    w.textContent = r.rulesFirst
      ? '⚠ 规则命中了，但回复不是它 —— 检查那条规则的回复是不是空的。'
      : '⚠ 规则命中了，但被内置意图抢先了（现在内置优先）。想让规则说了算：勾上「我的规则优先于内置意图」。';
    box.appendChild(w);
  }
  if (r.ruleError) {
    const w = document.createElement('div');
    w.className = 'warnline';
    w.textContent = '⚠ 有一条规则不是合法正则，已按「包含这段字」匹配：' + r.ruleError;
    box.appendChild(w);
  }
  out.appendChild(box);
}

// ---------------------------------------------------------------- 轮询 ----
function renderPoll(view) {
  const p = view.autoSwitch || {};
  $('pollEnabled').checked = p.enabled === true;
  $('pollScope').value = p.scope || 'whitelist';
  $('pollList').value = (p.conversations || []).join(', ');
  $('pollSettleMs').value = p.settleMs;
  $('pollMinGapMs').value = p.minGapMs;
  $('pollIdleMs').value = p.activeIdleMs;
  $('pollPause').checked = p.pauseWhenActive !== false;
  $('pollRestore').checked = p.restoreCursor !== false;
  renderPollSummary();
}

function renderPollSummary() {
  const on = $('pollEnabled').checked;
  const scope = $('pollScope').value;
  const scopeText = scope === 'all' ? '全部会话'
    : scope === 'whitelist' ? '白名单' : '指定列表';
  $('pollSummary').textContent = on ? ('已开启 · ' + scopeText) : '未开启';
  $('pollScope').disabled = !on;
  $('pollList').disabled = !on || scope !== 'list';
  $('pollScopeHint').textContent = scope === 'all'
    ? '会话列表里的每一个都会轮流点开看一眼（黑名单除外）。回不回仍然由上面的白名单决定。'
    : scope === 'whitelist'
      ? '只点白名单里的会话。注意：白名单只剩一个会话时，等于没有轮询。'
      : '只点下面这个列表里的会话（会跟当前会话列表取交集，列表里没有的不会瞎点）。';
}

for (const id of ['pollEnabled', 'pollScope', 'pollList']) {
  $(id).addEventListener('change', renderPollSummary);
  $(id).addEventListener('input', renderPollSummary);
}

$('btnPollTest').addEventListener('click', async () => {
  const out = $('pollTestOut');
  out.textContent = '读取中…';
  try {
    const r = await api('/api/poll/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: $('pollScope').value,
        conversations: $('pollList').value.split(',').map((s) => s.trim()).filter(Boolean),
        whitelist: $('whitelist').value.split(',').map((s) => s.trim()).filter(Boolean),
      }),
    });
    if (!r.ok) { out.textContent = '读不到：' + (r.error || '未知原因'); return; }
    out.textContent = r.targets.length
      ? ('会轮这 ' + r.targets.length + ' 个：' + r.targets.join('、')
        + '　（QQ 列表里现在有 ' + r.sessionCount + ' 个会话）')
      : ('一个都不会轮 —— QQ 列表里有 ' + r.sessionCount + ' 个会话：'
        + (r.sessions.slice(0, 8).join('、') || '空'));
  } catch (e) {
    out.textContent = '读不到：' + e.message;
  }
});

// ---------------------------------------------------------------- 加载 ----
async function load(reveal) {
  const view = await api('/api/config' + (reveal ? '?reveal=1' : ''));
  renderAll(view);
  return view;
}

$('provider').addEventListener('change', async () => {
  // 切厂商：只更新界面上的 model/baseUrl/key 显示，不立刻落盘
  const view = VIEW;
  const name = $('provider').value;
  const p = view.providers[name] || {};
  $('model').value = p.model || '';
  $('baseUrl').value = p.baseUrl || '';
  $('modelHint').textContent = PROVIDER_HINTS[name] || '';
  // ⚠ 这里以前**抄了一份** key 徽标的逻辑，于是加「本地服务不需要 key」时
  //    只改了 renderProviders 那一份，切换厂商时仍然显示"未配置" ——
  //    测试当场抓到了。同一个显示逻辑只能有一处。
  renderKeyState(p);
  renderThinking(p);
  $('apiKey').value = '';
  $('probeHint').textContent = '';
  $('modelPickWrap').style.display = 'none';
  toast('切到 ' + name + ' —— 记得点「保存」才会生效');
});

// 勾/不勾立刻把后果写清楚（不说话，等用户点保存才落盘）
$('ignoreSystemMessages').addEventListener('change', () => renderSystemHint(VIEW));
$('enableThinking').addEventListener('change', () => {
  renderThinking({ isLocal: true, enableThinking: $('enableThinking').checked });
});

$('toggleKey').addEventListener('click', async () => {
  if ($('apiKey').type === 'password') {
    if (!SHOWN_KEY) {
      const v = await load(true);
      const k = (v.providers[$('provider').value] || {}).key;
      SHOWN_KEY = (k && k.value) || '';
    }
    $('apiKey').value = SHOWN_KEY;
    $('apiKey').type = 'text';
    $('toggleKey').textContent = '隐藏';
  } else {
    $('apiKey').type = 'password';
    $('apiKey').value = '';
    $('toggleKey').textContent = '显示';
  }
});

// 改了范围或白名单，提示要立刻跟着变（不然上面写"谁都不回"、下面却填着名字）
$('replyScope').addEventListener('change', renderScopeHint);
$('whitelist').addEventListener('input', renderScopeHint);

$('clearKey').addEventListener('click', () => {  $('apiKey').value = '';
  $('apiKey').placeholder = '已标记清空 —— 点「保存」后该 key 会被置空';
  toast('点「保存」才会真的清空', 'err');
});

// ---------------------------------------------------------------- 保存 ----
$('btnSave').addEventListener('click', async () => {
  try {
    const provider = $('provider').value;
    const p = (VIEW.providers[provider] || {});
    const envName = p.apiKeyEnv || (provider.toUpperCase() + '_API_KEY');

    const keys = {};
    const typed = $('apiKey').value.trim();
    if (typed) keys[envName] = typed;
    else if ($('apiKey').placeholder.startsWith('已标记清空')) keys[envName] = '';

    const wl = $('whitelist').value.split(',').map(s => s.trim()).filter(Boolean);
    const num = (id) => { const v = $(id).value.trim(); return v === '' ? undefined : Number(v); };

    const config = {
      'llm.provider': provider,
      // 计算属性名要加方括号：'a' + b + 'c' 直接当键是语法错误（踩过）
      ['llm.providers.' + provider + '.model']: $('model').value.trim(),
      ['llm.providers.' + provider + '.baseUrl']: $('baseUrl').value.trim(),
      // 思考模式：**只在本地服务上写这个键**（见 renderThinking 的注释 ——
      // 云端厂商不认 chat_template_kwargs，硬发过去可能 400）。
      // 别的厂商下这个开关是藏着的，值也不能顺手写进去。
      ...((p.isLocal === true)
        ? { ['llm.providers.' + provider + '.enableThinking']: $('enableThinking').checked }
        : {}),
      'llm.timeoutMs': num('timeoutMs'),
      'llm.maxTokens': num('maxTokens'),
      'llm.contextMessages': num('contextMessages'),
      'trigger.whitelist': wl,
      'trigger.replyScope': $('replyScope').value,
      'trigger.replyProbability': num('replyProbability'),
      'trigger.cooldownMs': num('cooldownMs'),
      'trigger.maxRepliesPerMinute': num('maxRepliesPerMinute'),
      'trigger.mentionAlwaysReplies': $('mentionAlwaysReplies').checked,
      // 系统消息过滤：开关 + 用户自己加的关键词（逗号分隔，写正则也行）
      'trigger.ignoreSystemMessages': $('ignoreSystemMessages').checked,
      'trigger.systemPatterns': $('systemPatterns').value.split(',').map(s => s.trim()).filter(Boolean),
      'reply.dryRun': $('dryRun').checked,
      'reply.maxChars': num('maxChars'),
      // 这里必须写两个反斜杠加 n（即转义后的形态）。
      // page.js 本身是模板字符串，只写一个反斜杠会把**真实换行**输出到 HTML 里，
      // 字符串当场断掉（踩过两次，有测试守着；注释里也不能出现该转义序列）
      // 模型调不通时要不要发本地兜底话（关掉 = 宁可不回）。
      // 这个键以前是死的（写了没人读），所以这里也顺手把它接上线。
      'reply.fallbackWhenApiDown': $('fallbackWhenApiDown').checked,
      // 自定义回复规则（不接 API 时按关键词接话）。
      // 空条目由服务端清洗掉（见 gui/server.js），这里原样交上去。
      'fallback.rules': collectRules(),
      'fallback.customRulesFirst': $('customRulesFirst').checked,
      // 自动轮询：会动鼠标，所以每个值都要能看见、能关
      'autoSwitch.enabled': $('pollEnabled').checked,
      'autoSwitch.scope': $('pollScope').value,
      'autoSwitch.conversations': $('pollList').value.split(',').map(s => s.trim()).filter(Boolean),
      'autoSwitch.settleMs': num('pollSettleMs'),
      'autoSwitch.minGapMs': num('pollMinGapMs'),
      'autoSwitch.activeIdleMs': num('pollIdleMs'),
      'autoSwitch.pauseWhenActive': $('pollPause').checked,
      'autoSwitch.restoreCursor': $('pollRestore').checked,
    };
    // 去掉 undefined，避免把空输入写成 null
    for (const k of Object.keys(config)) if (config[k] === undefined) delete config[k];

    // 固定回复池单独传：服务端只把「和内置默认不同」的写进 config.json，
    // 留空或与默认一致的就删掉该键，配置文件不会被默认值撑大。
    const pools = collectPools();

    const r = await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys, config, pools }),
    });
    renderAll(r.view);
    $('apiKey').placeholder = '粘贴 key，留空表示不改';

    // 保存结果要留得住，不能只靠 3 秒就消失的 toast ——
    // 用户看不到反馈时会以为没保存成功（或以为被恢复默认了）。
    //
    // 注意：这里**不能用反引号模板字面量**（连注释里也不能出现反引号），
    // page.js 本身就是模板字符串，内层反引号会把它提前闭合
    // （踩过，跟之前那个反斜杠 n 是同一类坑）。所以下面用字符串拼接。
    const when = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const summary = (r.applied || []).join('、') || '没有变化';
    const el = $('saveState');
    el.textContent = when + ' 已保存：' + summary + '（重启机器人后生效）';
    el.className = 'savestate ok';
    el.style.display = 'block';

    toast('已保存：' + summary, 'ok');
  } catch (e) {
    const el = $('saveState');
    el.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' 保存失败：' + e.message;
    el.className = 'savestate err';
    el.style.display = 'block';
    toast('保存失败：' + e.message, 'err');
  }
});

// 检测服务：问一下这个地址到底通不通、有哪些模型。
// 本地 API 的模型名是用户自己拉的（ollama pull …），填错了报错很难懂，
// 所以让它自己报出来、点一下就填进去。
$('btnProbe').addEventListener('click', async () => {
  const btn = $('btnProbe');
  const hint = $('probeHint');
  btn.disabled = true;
  hint.textContent = '检测中…（会真的发一条消息试，慢的模型可能要等十几秒）';
  try {
    const r = await api('/api/llm/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: $('provider').value,
        baseUrl: $('baseUrl').value.trim(),
        model: $('model').value.trim(),
        apiKey: $('apiKey').value.trim(),
      }),
    });

    // ⚠ 以**真的发一条消息**的结果为准，不是"列得出模型"就算通。
    //    实测被这个骗过：本地服务 /models 不要 key，/chat/completions 要 key，
    //    于是控制台显示"✓ 通了"，机器人却一句话都没回过。
    if (!r.ok) {
      const why = r.needsKey
        ? '这个服务要 API key（它的 /models 恰好不校验，所以只看那个会被骗过去）'
        : ('聊天接口没通：' + ((r.chat && (r.chat.detail || r.chat.reason)) || '未知原因'));
      hint.textContent = '✗ ' + why;
      showProbeHints(r);
      toast('没通：' + why, 'err');
      $('modelPickWrap').style.display = 'none';
      return;
    }

    hint.textContent = '✓ 通了：真的发了一条，模型回了 ' + JSON.stringify(r.chat.sample)
      + '（' + r.chat.ms + 'ms，' + r.models.length + ' 个模型，'
      + (r.usedKey === '有' ? '带了 key' : '没带 key') + '）';
    toast('通了，模型回了 ' + JSON.stringify(r.chat.sample), 'ok');
    showProbeHints(r);

    const host = $('modelPick');
    host.textContent = '';
    const cur = $('model').value.trim();
    for (const m of r.models.slice(0, 40)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = (m === cur) ? 'tiny' : 'ghost tiny';
      b.textContent = m;
      b.addEventListener('click', function () {
        $('model').value = m;
        toast('已填入模型名：' + m + '（记得点保存）', 'ok');
        renderModelPick(r.models, m);
      });
      host.appendChild(b);
    }
    $('modelPickWrap').style.display = host.children.length ? '' : 'none';
  } catch (e) {
    hint.textContent = '✗ 检测失败：' + e.message;
    toast('检测失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

// 探测给出的"接下来该改什么"。这些建议来自后端（probeProvider），
// 因为它才知道失败的确切原因（要 key / 推理模型吃光预算 / 太慢 / 地址不对）。
function showProbeHints(r) {
  const host = $('probeHints');
  host.textContent = '';
  const hints = (r && r.hints) || [];
  if (hints.length === 0) { host.style.display = 'none'; return; }
  host.style.display = '';
  for (const h of hints) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.style.margin = '2px 0';
    d.textContent = '· ' + h;
    host.appendChild(d);
  }
}

function renderModelPick(models, current) {
  const host = $('modelPick');
  if (!host || host.children.length === 0) return;
  const list = models.slice(0, 40);
  host.textContent = '';
  for (const m of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = (m === current) ? 'tiny' : 'ghost tiny';
    b.textContent = m;
    b.addEventListener('click', function () { $('model').value = m; renderModelPick(list, m); });
    host.appendChild(b);
  }
}

$('btnMemReload').addEventListener('click', () => {
  loadMemory();
  loadLife();
  toast('已重新读取记忆与生活日志', 'ok');
});

// ---- 人生模拟：两个开关 + 切换/新建人生 ----
$('lifeEnabled').addEventListener('change', (e) => {
  postLife({ lifeEnabled: e.target.checked }, e.target.checked ? '人生模拟已开' : '人生模拟已关（立刻生效）');
});

$('shareEnabled').addEventListener('change', (e) => {
  const on = e.target.checked;
  if (on && !confirm('打开主动发言？\\n\\n它会**没人问就自己往群里发一句** —— 以你这个 QQ 号的身份。'
    + '\\n\\n有这些闸门：模型判断「值得说」+ 至少隔几分钟 + 每天有上限 + 静默时段 + 只发白名单会话。')) {
    e.target.checked = false;
    return;
  }
  postLife({ shareEnabled: on }, on ? '主动发言已开' : '主动发言已关（立刻生效）');
});

$('btnLifeSwitch').addEventListener('click', () => {
  const want = $('lifePick').value;
  if (want === (LIFE_VIEW && LIFE_VIEW.profile ? LIFE_VIEW.profile : '')) {
    toast('已经在过这份人生了', 'err');
    return;
  }
  postLife({ lifeProfile: want }, '已切到「' + (want || '默认那份') + '」的人生');
});

$('btnLifeCreate').addEventListener('click', async () => {
  const name = $('lifeNewName').value.trim();
  if (!name) { toast('先给它起个名字', 'err'); return; }
  const seed = $('lifeSeed').checked;
  try {
    const view = await api('/api/life', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ createLife: name, seed, seedFrom: LIFE_VIEW ? LIFE_VIEW.profile : '' }),
    });
    renderLifeView(view);
    $('lifeNewName').value = '';
    toast('已新建「' + name + '」的人生' + (seed ? '（从上一份抄来）' : '（空的）'), 'ok');
  } catch (e) {
    toast('新建失败：' + e.message, 'err');
  }
});

// 生活日志单独清：它是「人生模拟」的产物，和记下来的事实不是一回事。
// 想让它重新开始过日子就清这个，不用把记忆一起清掉。
$('btnLifeClear').addEventListener('click', async () => {
  if (!confirm('清空生活日志？\\n（机器人"最近在做什么"的记录会没掉，下次模拟重新开始）\\n两层记忆不受影响。')) return;
  try {
    const r = await api('/api/memory/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'life' }),
    });
    renderMemory(r);
    toast('生活日志已清空', 'ok');
  } catch (e) {
    toast('清空失败：' + e.message, 'err');
  }
});

// 记忆分两层，清空也必须分开：总记忆里是"我是谁、喜欢什么"，
// 跟某个会话的经历不是一回事 —— 一键全清会顺手把不该丢的也丢了。
$('btnMemClear').addEventListener('click', async () => {
  const name = MEM_VIEW && MEM_VIEW.conversation ? MEM_VIEW.conversation.name : '';
  if (!name) { toast('先在下面选一个会话', 'err'); return; }
  if (!confirm('清空「' + name + '」的会话记忆？\\n（心情、在这里的经历、和这里的人的关系、话题都会没掉）\\n总记忆不受影响。\\n\\n（只是清空内容，这个会话还会留在列表里；想连条目一起删掉，用列表里那个「删」）')) return;
  try {
    const r = await api('/api/memory/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'conversation', conversation: name }),
    });
    renderMemory(r);
    toast('「' + name + '」的会话记忆已清空', 'ok');
  } catch (e) {
    toast('清空失败：' + e.message, 'err');
  }
});

// 删除一个会话的记忆文件（连条目一起从列表里去掉）。
//
// 和「清空」的区别就一句：清空留个空壳，删除不留。
// 两件事都保留，是因为"我想让它忘掉这个会话的内容"和"我不想再看到这个会话"
// 是两种需求 —— 前者按一下清空更安全（文件结构还在，看得见清单）。
async function deleteConversationMemory(item) {
  const name = item.conversation || item.file;
  if (!confirm('删除「' + name + '」的会话记忆？\\n\\n· 这份记忆文件会被删掉，列表里不再有它\\n· 总记忆、其他会话、它的人生都不受影响\\n· 删了就找不回来了（想留个底就别点确定）')) return;
  try {
    const r = await api('/api/memory/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation: item.conversation, file: item.file }),
    });
    renderMemory(r);
    toast('已删除「' + name + '」的会话记忆', 'ok');
  } catch (e) {
    toast('删除失败：' + e.message, 'err');
  }
}

$('btnMemClearGlobal').addEventListener('click', async () => {
  if (!confirm('清空总记忆？\\n（我是谁、喜欢什么、讨厌什么都会没掉）\\n各个会话的记忆不受影响。')) return;
  try {
    const r = await api('/api/memory/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global' }),
    });
    renderMemory(r);
    toast('总记忆已清空', 'ok');
  } catch (e) {
    toast('清空失败：' + e.message, 'err');
  }
});

$('btnResetPools').addEventListener('click', async () => {
  if (!confirm('把所有固定回复恢复成默认值？（自定义的那些会丢掉）')) return;
  try {
    const r = await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetPools: true }),
    });
    renderAll(r.view);
    toast('已全部恢复默认', 'ok');
  } catch (e) {
    toast('恢复失败：' + e.message, 'err');
  }
});

$('btnReload').addEventListener('click', async () => {
  try { await load(false); toast('已重新读取'); }
  catch (e) { toast('读取失败：' + e.message, 'err'); }
});

// ------------------------------------------------------------ 接管模式 ----
$('takeoverNow').addEventListener('change', async () => {
  try {
    const r = await api('/api/takeover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: $('takeoverNow').checked }),
    });
    toast('接管模式：' + (r.takeoverEnabled ? '已开启' : '已关闭') + '（立即生效，不用重启）', 'ok');
  } catch (e) {
    toast('切换失败：' + e.message, 'err');
  }
});

// 兜底开关：跟其它配置一样要点保存、重启才生效，所以这里只更新说明文字
$('fallbackWhenApiDown').addEventListener('change', renderFbHint);

// ------------------------------------------------------------ 启停控制 ----
$('btnStart').addEventListener('click', async () => {
  try {
    const r = await api('/api/bot/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) { toast(r.error, 'err'); return; }
    setRunning(true);
    toast('机器人已启动', 'ok');
  } catch (e) { toast('启动失败：' + e.message, 'err'); }
});

$('btnStop').addEventListener('click', async () => {
  try {
    const r = await api('/api/bot/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) { toast(r.error, 'err'); return; }
    setRunning(false);
    toast('正在停止…', 'ok');
  } catch (e) { toast('停止失败：' + e.message, 'err'); }
});

$('btnClearLogs').addEventListener('click', () => { $('logs').textContent = ''; });

// ---------------------------------------------------------------- 日志 ----
function appendLog(rec) {
  const el = $('logs');
  const near = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  const span = document.createElement('span');
  span.className = 'ln-' + (rec.kind || 'out');
  const d = new Date(rec.t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  span.textContent = hh + ':' + mm + ':' + ss + '  ' + rec.line + '\\n';
  el.appendChild(span);
  while (el.childNodes.length > 1200) el.removeChild(el.firstChild);
  if (near) el.scrollTop = el.scrollHeight;
}

async function initLogs() {
  try {
    const r = await api('/api/logs');
    for (const rec of r.logs) appendLog(rec);
    setRunning(r.running);
  } catch { /* 首次可能还没日志 */ }

  const es = new EventSource('/api/stream');
  es.onmessage = (ev) => {
    try { appendLog(JSON.parse(ev.data)); } catch { /* 忽略坏帧 */ }
  };
  es.onerror = () => { /* 浏览器会自动重连 */ };

  // 兜底轮询：万一 SSE 被拦，状态也能更新
  setInterval(async () => {
    try { const r = await api('/api/logs'); setRunning(r.running); } catch { /* 忽略 */ }
  }, 5000);
}

// ---------------------------------------------------------------- 启动 ----
(async () => {
  // 先按地址栏里的 #tab 定页（刷新之后停在同一页，不用每次重新点）
  showTab(String(location.hash || '').replace(/^#/, ''));
  try { await load(false); } catch (e) { toast('读配置失败：' + e.message, 'err'); }
  initLogs();
})();
</script>
</body>
</html>`;
}
