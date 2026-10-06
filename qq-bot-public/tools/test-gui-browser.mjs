/**
 * test-gui-browser.mjs — 用真实浏览器自动跑一遍"改人设 → 点保存 → 看结果"。
 *
 * 为什么需要它：接口测试全绿，但那是**直接调 HTTP**，没跑页面里的 JS。
 * 用户在界面里操作却出问题，只有在真实浏览器里点一遍才能复现。
 *
 * 做法：用 Chrome 的 DevTools Protocol（CDP）——
 *   Node 24 自带 WebSocket，所以不用装 puppeteer。
 *
 * 用法：node tools/test-gui-browser.mjs [控制台端口] [CDP端口]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { guardConfigFile, consoleServes, skipConsole } from './testkit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUI_PORT = Number(process.argv[2]) || 7788;
const CDP_PORT = Number(process.argv[3]) || 9333;
const URL_ = `http://127.0.0.1:${GUI_PORT}/`;
const CFG = path.join(ROOT, 'config.json');
// 页面源码：有几条断言要验的是"分支真的存在"，而不是"用户当前配成了哪一边"。
const PAGE_SRC = fs.readFileSync(path.join(ROOT, 'gui', 'page.js'), 'utf8');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`); }
}

const exe = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!exe) {
  console.log('没找到 Chrome/Edge，跳过浏览器测试');
  process.exit(0);
}

const profile = path.join(os.tmpdir(), `dsh-cdp-${Date.now()}`);
let browser = null;

/** 极简 CDP 客户端：连上 WebSocket，发命令，收结果。 */
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(new Error('ws error: ' + (e.message ?? 'unknown'))));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 20000);
    });
  }

  /** 在页面里跑一段表达式并取回结果。 */
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面里抛异常: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    }
    return r.result?.value;
  }

  close() { try { this.ws.close(); } catch { /* 忽略 */ } }
}

async function waitFor(fn, { timeout = 15000, interval = 250, what = '条件' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`等待超时: ${what}`);
}

console.log('='.repeat(70));
console.log('真实浏览器交互测试（改人设 → 保存 → 复查）');
console.log('='.repeat(70));
console.log(`  浏览器: ${exe}`);

// ⚠ 先确认 7788 上那个控制台**服务的就是这份代码**。
//
// 为什么这一句非加不可（代价很大的一个坑，真踩了两次）：
//   这个测试点「保存」，而保存是 POST 给控制台的 —— 控制台只认**自己项目**的
//   config.json。如果本测试是从**另一个副本**（比如导出出来的发布包）跑的，
//   端口上那个控制台仍然是主项目的，于是：测试以为自己只改了自己那份，
//   实际把**主项目的 persona 和回复池**写成了测试标记值
//   （实测：`persona.systemPrompt = ["【改过了】<时间戳>","第二行"]`、
//     `fallback.pools.greeting = ["测试甲",...]` —— 而且两份文件各看各的，
//     "还原"还原的也是错的那一份）。
//   guardConfigFile 兜不住这种情况：它保护的是**本副本**的文件，不是别人的。
const consolePre = await consoleServes(ROOT, GUI_PORT);
if (!consolePre.ok) {
  skipConsole('真实浏览器交互测试（整节）', consolePre.reason);
  console.log('\n  想跑这一节：先在**本目录**起控制台（node gui/server.js），再跑一次。');
  process.exit(0);
}

const originalCfg = fs.readFileSync(CFG, 'utf8');
// 护栏：这个测试会点「保存」，载荷是整张表单 —— 中途崩了/被 Ctrl+C
// 都会把测试值留进用户的 config.json。finally 只能兜异常和正常返回，
// 兜不住信号，所以交给 guardConfigFile（它还顺带检查"进来时是不是已经脏了"）。
const cfgGuard = guardConfigFile(CFG);
// ⚠ state.json 也要护栏：人设是"当前是谁"，存在这里。
//   测试会新建一份人设再删掉，中途崩了/被 Ctrl+C 就会把测试身份留在用户机器上。
const STATE_FILE = path.join(ROOT, 'state.json');
const stateGuard = guardConfigFile(STATE_FILE);

try {
  browser = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    URL_,
  ], { stdio: 'ignore', windowsHide: true });

  // 等 CDP 起来
  const version = await waitFor(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }, { what: 'CDP 端口就绪' });
  check('浏览器可连接', Boolean(version), version?.Browser ?? '');

  // 找到页面目标的 WebSocket 地址
  const target = await waitFor(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      return list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1')) ?? null;
    } catch { return null; }
  }, { what: '找到控制台页面目标' });

  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  // ---------------------------------------------------------- 1. 页面加载
  console.log('\n1) 页面加载与初始渲染');
  // ⚠ 必须等**配置真的加载完**，不能只等元素出现。
  //
  // 踩过：这里原本等的是 `!!document.getElementById("personaPrompt")` ——
  // 那个 textarea 是静态 HTML 里就有的，脚本一跑就为真，
  // 于是测试可能在 api('/api/config') 还没回来时就去读输入框，
  // 读到一堆空值、一次性挂掉 5 条断言（控制台刚重启时尤其容易出现）。
  // 现在等的是 renderPools 渲染出来的池子节点 —— 它在 renderAll 里，
  // 只有配置拿到手之后才会存在。
  await waitFor(
    () => cdp.evaluate('document.querySelectorAll("#poolsEditor .pool").length > 0'),
    { what: '配置加载完成（回复池已渲染）' },
  );
  // ⚠ 人设是**另一个异步请求**（/api/personas），它可能在回复池渲染完之后才回来。
  //   不等它就会读到"还没填的"提示词框 —— 实测就是这么红的：
  //   拿到 [disabled=false, 长度=0, 提示=空]，看着像"人设没了"，其实是还没到。
  await waitFor(
    () => cdp.evaluate('(document.getElementById("personaHint") || {}).textContent.length > 0'),
    { what: '人设加载完成（人设提示行已渲染）' },
  );

  const initial = await cdp.evaluate(`(() => {
    const ta = document.getElementById('personaPrompt2');
    return {
      taLen: ta ? ta.value.length : -1,
      taDisabled: ta ? ta.disabled : null,
      personaHint: document.getElementById('personaHint') ? document.getElementById('personaHint').textContent : '',
      hasPersonaCard: !!document.getElementById('cardPersona'),
      hasMemSub: !!document.getElementById('personaMemoryBox'),
      hasLifeSub: !!document.getElementById('personaLifeBox'),
      pools: document.querySelectorAll('#poolsEditor textarea[data-pool-key]').length,
      opts: document.getElementById('provider').options.length,
      cm: document.getElementById('contextMessages').value,
      wl: document.getElementById('whitelist').value,
      scope: document.getElementById('replyScope') ? document.getElementById('replyScope').value : '(没有)',
      scopeHint: document.getElementById('scopeHint') ? document.getElementById('scopeHint').textContent : '',
    };
  })()`);
  // 记忆和人生现在是**人设的子项**：这两个折叠块必须挂在那张卡里
  check('人设卡在，且记忆/人生是它的子项',
    initial.hasPersonaCard && initial.hasMemSub && initial.hasLifeSub,
    JSON.stringify([initial.hasPersonaCard, initial.hasMemSub, initial.hasLifeSub]));
  // 提示词框的内容取决于"现在有没有人设"：有人设就是它那份，没人设是空且禁用。
  // 只断言"两种状态都说得通"，不写死是哪一种（写死就会随用户状态变红）。
  check('提示词框要么有人设的内容、要么禁用并给出建人设的提示',
    (initial.taDisabled === false && initial.taLen > 100)
    || (initial.taDisabled === true && initial.personaHint.length > 0),
    JSON.stringify([initial.taDisabled, initial.taLen, String(initial.personaHint).slice(0, 40)]));
  check('回复池编辑框已渲染', initial.pools > 0, `${initial.pools} 个`);
  check('厂商下拉已填充', initial.opts > 0, `${initial.opts} 个`);
  check('历史条数已填充', initial.cm !== '', `"${initial.cm}"`);
  check('白名单已填充', initial.wl !== '', `"${initial.wl}"`);

  // 回复范围：新加的选择框，以及它会**即时说明当前模式的后果**
  check('回复范围选择框已填充', initial.scope === 'all' || initial.scope === 'whitelist', initial.scope);
  check('回复范围下面有后果提示', initial.scopeHint.length > 0, initial.scopeHint.slice(0, 40));

  const scopeSwitch = await cdp.evaluate(`(() => {
    const sel = document.getElementById('replyScope');
    const hint = document.getElementById('scopeHint');
    const orig = sel.value;                    // 记住原值，别用"再翻一次"来还原
    const before = orig + ' | ' + hint.textContent;
    sel.value = orig === 'all' ? 'whitelist' : 'all';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const after = sel.value + ' | ' + hint.textContent;
    sel.value = orig;                          // 明确还原
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { orig, before, after, restored: sel.value };
  })()`);
  check('切换回复范围后提示会立刻跟着变（不能还写着"谁都不回"）',
    scopeSwitch.before !== scopeSwitch.after,
    `"${scopeSwitch.before.slice(0, 30)}" → "${scopeSwitch.after.slice(0, 30)}"`);
  check('切换之后必须还原（否则后面的保存会把测试值写进你的配置）',
    scopeSwitch.restored === scopeSwitch.orig, `${scopeSwitch.orig} → ${scopeSwitch.restored}`);

  // -------------------------------------------------- 本地 API 的界面
  // 「这家不需要 key」和「该配没配」必须分开显示：
  // 本地推理服务本来就无需 key，显示成红色的"未配置"会让人以为坏了。
  const localUi = await cdp.evaluate(`(() => {
    const sel = document.getElementById('provider');
    const orig = sel.value;
    const hasLocal = Array.from(sel.options).some(o => o.value === 'local');
    sel.value = 'local';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const badge = document.getElementById('keyBadge').textContent;
    const hint = document.getElementById('keyHint').textContent;
    const modelHint = document.getElementById('modelHint').textContent;
    const hasProbe = !!document.getElementById('btnProbe');
    const hasPick = !!document.getElementById('modelPick');
    sel.value = orig;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { hasLocal, badge, hint, modelHint, hasProbe, hasPick, restored: sel.value === orig };
  })()`);
  check('厂商下拉里有「local」', localUi.hasLocal === true);
  // 要验的不变量是「本地服务不会被显示成缺 key 的错误状态」。
  // 具体文案取决于用户有没有配 LOCAL_API_KEY（两种都对）：
  //   · 配了   → 「已配置 sk-…」
  //   · 没配   → 「这家不需要 key」
  // 只有 requiresKey=true 且没配才会是「未配置」。
  check('选到 local 时不会显示成"未配置"',
    /已配置/.test(localUi.badge) || /不需要 key/.test(localUi.badge),
    JSON.stringify(localUi.badge));
  // ⚠ 这条**不能**写死"留空"：用户给 local 填了 key 之后 requiresKey=true，
  //   文案就变成「环境变量名：LOCAL_API_KEY…」。要验的是**提示跟着那个开关走**，
  //   不是用户当前配成了哪一边（写死用户配置的测试最脆，改一下配置就红）。
  check('local 的 key 提示两副文案都合理（要么说可留空，要么给环境变量名）',
    /留空/.test(localUi.hint) || /环境变量名/.test(localUi.hint), localUi.hint.slice(0, 60));
  check('两副文案都在页面源码里（开关真的在做分支）',
    /留空即可/.test(PAGE_SRC) && /环境变量名：/.test(PAGE_SRC));
  check('「检测服务」按钮在', localUi.hasProbe === true);
  check('模型选择区在', localUi.hasPick === true);
  check('切完厂商要还原（否则保存会把 local 写进配置）', localUi.restored === true);

  // ------------------------------------------------ 2. 人设：新建 → 改提示词 → 保存
  //
  // 需求原话：「可以切换人设提示词（相当于把人生模拟的人生切换改到人设身上），
  // 把人生模拟和记忆作为人设的子项，即根据不同的提示词切换不同的人生和记忆」。
  //
  // 这一段走**真实浏览器**：新建一份测试人设（不克隆，免得拷走用户的记忆）→
  // 改提示词 → 点「保存提示词」→ 查磁盘上的 personas/<名字>.json。
  // 收尾必须清干净：删人设 + 删它那几个目录 + 还原 state.json（见 finally 的护栏）。
  console.log('\n2) 人设：新建 → 改提示词 → 保存（立即生效）');
  const MARK = '【浏览器测试标记】' + Date.now();
  const TEST_PERSONA = '__测试人设__';
  const newPrompt = `${MARK}\n第二行\n第三行`;

  const personaFlow = await cdp.evaluate(`(async () => {
    document.querySelector('#tabs .tab[data-tab="api"]').click();
    await new Promise(r => setTimeout(r, 150));

    // 新建一份测试人设（取消勾选"克隆"，免得把用户的记忆拷过去）
    document.getElementById('personaNewName').value = ${JSON.stringify(TEST_PERSONA)};
    const seedBox = document.getElementById('personaSeed');
    if (seedBox) seedBox.checked = false;
    document.getElementById('btnPersonaCreate').click();
    await new Promise(r => setTimeout(r, 1200));

    const ta = document.getElementById('personaPrompt2');
    const afterCreate = {
      taEnabled: !ta.disabled,
      taLen: ta.value.length,
      hint: document.getElementById('personaHint').textContent,
    };

    // 改提示词 → 点「保存提示词」
    ta.value = ${JSON.stringify(newPrompt)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btnPersonaSavePrompt').click();
    await new Promise(r => setTimeout(r, 1200));

    return {
      afterCreate,
      afterSave: ta.value,
      saveHint: document.getElementById('personaSaveHint').textContent,
      toast: document.getElementById('toast') ? document.getElementById('toast').textContent : '',
      hintNow: document.getElementById('personaHint').textContent,
    };
  })()`);

  check('新建人设之后提示词框可编辑了', personaFlow.afterCreate.taEnabled === true,
    JSON.stringify(personaFlow.afterCreate));
  check('界面提示写明了这个人设的人生与记忆目录',
    /它的人生/.test(personaFlow.hintNow) && /它的记忆/.test(personaFlow.hintNow),
    JSON.stringify(personaFlow.hintNow.slice(0, 60)));
  check('保存后界面显示的仍是改过的内容',
    personaFlow.afterSave.includes(MARK), JSON.stringify(String(personaFlow.afterSave).slice(0, 40)));
  check('保存按钮给了"立即生效"的回执', /立即生效/.test(personaFlow.saveHint),
    JSON.stringify(personaFlow.saveHint));
  console.log(`      toast: ${JSON.stringify(personaFlow.toast)}`);

  // -------------------------------------------------- 3. 落盘复查
  console.log('\n3) 人设文件里是不是真的写进去了');
  const personaFileOnDisk = path.join(ROOT, 'personas', `${TEST_PERSONA}.json`);
  check('人设文件建出来了', fs.existsSync(personaFileOnDisk), personaFileOnDisk);
  const personaJson = fs.existsSync(personaFileOnDisk)
    ? JSON.parse(fs.readFileSync(personaFileOnDisk, 'utf8')) : {};
  check('提示词写进了 personas/<名字>.json（不是 config.json）',
    JSON.stringify(personaJson.systemPrompt ?? '').includes(MARK),
    `数组 ${(personaJson.systemPrompt ?? []).length} 条`);
  check('人设文件里记着它自己那份人生', typeof personaJson.life === 'string' && personaJson.life.length > 0,
    JSON.stringify(personaJson.life));

  // state.json 里"现在是谁"也换了
  const stNow = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  check('state.json 的 personaProfile 指向这份人设', stNow.personaProfile === TEST_PERSONA,
    JSON.stringify(stNow.personaProfile));
  check('它的人生也跟着写进 lifeProfile', stNow.lifeProfile === TEST_PERSONA,
    JSON.stringify(stNow.lifeProfile));

  // ------------------------------------------ 4. 刷新页面看内容还在不在
  console.log('\n4) 刷新页面后（人设从文件现读，不该"恢复默认"）');
  await cdp.send('Page.enable');
  await cdp.send('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 2000));
  await waitFor(
    () => cdp.evaluate('document.querySelectorAll("#poolsEditor .pool").length > 0'),
    { what: '重载完成（回复池已重新渲染）' },
  );

  const afterReload = await cdp.evaluate(`document.getElementById('personaPrompt2').value`);
  check('刷新后显示的仍是保存的内容',
    String(afterReload).includes(MARK),
    String(afterReload).includes(MARK) ? '' : `实际开头: ${JSON.stringify(String(afterReload).slice(0, 40))}`);

  // ------------------------------------------ 4b. 收尾：把测试人设删掉、状态还原
  console.log('\n4b) 收尾：删掉测试人设（不能把测试身份留在用户机器上）');
  const cleanup = await cdp.evaluate(`(async () => {
    const origConfirm = window.confirm;
    window.confirm = () => true;          // 删除要确认，测试里直接过
    document.getElementById('btnPersonaDelete').click();
    await new Promise(r => setTimeout(r, 1200));
    window.confirm = origConfirm;
    return {
      hint: document.getElementById('personaHint').textContent,
      pick: document.getElementById('personaPick').options.length,
    };
  })()`);
  check('删除后界面上没有这份人设了', !/__测试人设__/.test(cleanup.hint), JSON.stringify(cleanup.hint.slice(0, 60)));

  // 手工清掉测试人设留下的目录（人设文件由接口删；记忆/人生目录接口**故意**不删）
  const rmDirDeep = (d) => {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) rmDirDeep(p);
      else fs.unlinkSync(p);            // ⚠ rmSync 在 Z: 盘上是静默无效的
    }
    fs.rmdirSync(d);
  };
  rmDirDeep(path.join(ROOT, 'memory', TEST_PERSONA));
  try { fs.unlinkSync(path.join(ROOT, 'lives', `${TEST_PERSONA}.json`)); } catch { /* 没有就算了 */ }
  check('测试人设的文件已清干净', !fs.existsSync(personaFileOnDisk)
    && !fs.existsSync(path.join(ROOT, 'memory', TEST_PERSONA)), TEST_PERSONA);

  // ------------------------------------------ 5. 顺带验回复池也能存
  console.log('\n5) 回复池编辑是否也能存住');
  const POOLMARK = '池测试句' + Date.now();
  await cdp.evaluate(`(async () => {
    const ta = document.querySelector('#poolsEditor textarea[data-pool-key="greeting"]');
    if (ta) { ta.value = ${JSON.stringify(POOLMARK + '\n另一句')}; ta.dispatchEvent(new Event('input', { bubbles: true })); }
    document.getElementById('btnSave').click();
    await new Promise(r => setTimeout(r, 1500));
    return true;
  })()`);
  const cfg2 = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  check('回复池写进了 config.json',
    JSON.stringify(cfg2.fallback?.pools ?? {}).includes(POOLMARK),
    JSON.stringify(cfg2.fallback?.pools?.greeting ?? null));

  // ⚠ 这个测试会点「保存」，而保存的载荷是**整张表单**——
  // 页面上任何一个被测试动过的控件都会被写进用户的 config.json。
  // 实测踩到：这里点保存时「回复范围」被留在了 all，于是白名单失效、
  // 机器人开始回复所有会话（而且测试结束后文件被 finally 还原，
  // 表面上看不出任何异常 —— 只有机器人启动日志里的「回复范围」那一行露馅）。
  //
  // 所以这里专门检查「设置类」的字段有没有被顺手改掉。
  const origObj = JSON.parse(originalCfg);
  check('测试没有顺手改掉「回复范围」这个设置',
    cfg2.trigger?.replyScope === origObj.trigger?.replyScope,
    `${origObj.trigger?.replyScope} → ${cfg2.trigger?.replyScope}`);

  // ------------------------------------------ 6. 记忆面板
  // 这一段是新加的界面，只有真实浏览器才会跑到它的 JS。
  // 之前踩过「接口测试全绿、页面里的脚本却是死的」——那段脚本有语法错误时
  // 整个页面静默失效，所有输入框都是空的，HTTP 测试根本看不出来。
  console.log('\n6) 记忆面板（只读展示）');
  const mem = await cdp.evaluate(`(async () => {
    await new Promise(r => setTimeout(r, 1200));   // 等 renderAll 里的 loadMemory 回来
    const hint = document.getElementById('memHint');
    const body = document.getElementById('memBody');
    return {
      hasHint: !!hint,
      hint: hint ? hint.textContent : '',
      blocks: body ? body.querySelectorAll('.group-title').length : -1,
      preCount: body ? body.querySelectorAll('pre').length : -1,
      text: body ? body.textContent : '',
      cleared: document.getElementById('btnMemClear') ? true : false,
    };
  })()`);

  check('记忆面板存在（提示行已渲染）', mem.hasHint && mem.hint.length > 0, JSON.stringify(mem.hint));
  check('面板里有两块：模型读到的内容 + 原始 JSON', mem.blocks >= 2, `${mem.blocks} 块`);
  check('面板里有 pre 区域（digest / 原始 JSON）', mem.preCount >= 2, `${mem.preCount} 个 pre`);
  check('提示行分别报出两层和条数',
    /总记忆/.test(mem.hint) && /会话记忆/.test(mem.hint) && /\d+\s*条经历/.test(mem.hint),
    JSON.stringify(mem.hint));
  check('清空按钮存在', mem.cleared === true);

  // 「清空」是破坏性操作，必须有 confirm 兜着 —— 否则点一下记忆就没了
  const guard = await cdp.evaluate(`(() => {
    const orig = window.confirm;
    let asked = 0;
    window.confirm = () => { asked++; return false; };   // 用户点"取消"
    document.getElementById('btnMemClear').click();
    const n = asked;
    window.confirm = orig;
    return n;
  })()`);
  check('点「清空记忆」会先弹确认框', guard >= 1, `confirm 被调用 ${guard} 次`);

  // ------------------------------------------ 6b. 删除会话（用户报的需求）
  //
  // 「要能删除会话，现在清空记忆后无法删除会话」—— 清空只抹内容，条目还在，
  // 所以列表里得有一个真能删的按钮。这一段在**浏览器里点它**，
  // 因为按钮是 renderMemory 动态造出来的：接口测试看不见"按钮压根没渲染"。
  console.log('\n6b) 删除一个会话（连文件一起）');
  {
    const TESTNAME = '__测试会话-浏览器__';
    const memInfo = await fetch(`http://127.0.0.1:${GUI_PORT}/api/memory`).then((r) => r.json());
    const dirAbs = path.join(ROOT, memInfo.dir || 'memory');
    const testFile = path.join(dirAbs, `${TESTNAME}.json`);
    fs.mkdirSync(dirAbs, { recursive: true });
    fs.writeFileSync(testFile, JSON.stringify({
      conversation: TESTNAME, mood: { label: '测试', why: '', at: null }, events: ['浏览器测试造的'],
    }, null, 2), 'utf8');

    // 让页面重新拉一次记忆，测试会话才会出现在列表里
    const chips = await cdp.evaluate(`(async () => {
      const r = await fetch('/api/memory').then(x => x.json());
      renderMemory(r);
      await new Promise(r2 => setTimeout(r2, 120));
      const mine = Array.from(document.querySelectorAll('#memBody .btnrow span'))
        .find(sp => sp.textContent.indexOf(${JSON.stringify(TESTNAME)}) >= 0);
      if (!mine) return { found: false, html: document.getElementById('memBody').textContent.slice(0, 120) };
      const btns = Array.from(mine.querySelectorAll('button'));
      return { found: true, labels: btns.map(b => b.textContent.trim()), titles: btns.map(b => b.title) };
    })()`);
    check('会话旁边出现了「删」按钮', chips.found && chips.labels.includes('删'),
      JSON.stringify(chips.labels ?? chips.html));
    check('「删」按钮写着它会连文件一起删（不是模棱两可的"清理"）',
      (chips.titles || []).some((t) => t && t.includes('删除')), JSON.stringify(chips.titles));

    // 点「删」但用户点"取消" → 必须什么都不做
    const cancelled = await cdp.evaluate(`(async () => {
      const orig = window.confirm;
      let asked = 0;
      window.confirm = () => { asked++; return false; };
      const sp = Array.from(document.querySelectorAll('#memBody .btnrow span'))
        .find(s => s.textContent.indexOf(${JSON.stringify(TESTNAME)}) >= 0);
      const x = sp && Array.from(sp.querySelectorAll('button')).find(b => b.textContent.trim() === '删');
      if (x) x.click();
      await new Promise(r => setTimeout(r, 400));
      window.confirm = orig;
      return { asked: asked };
    })()`);
    check('点「删」会先弹确认框', cancelled.asked >= 1, `confirm 被调用 ${cancelled.asked} 次`);
    check('用户点"取消"之后文件还在（破坏性操作不能被误点掉）', fs.existsSync(testFile));

    // 点「删」+ 确认 → 文件真的没了，列表里也不再有它
    const deleted = await cdp.evaluate(`(async () => {
      const orig = window.confirm;
      window.confirm = () => true;
      const sp = Array.from(document.querySelectorAll('#memBody .btnrow span'))
        .find(s => s.textContent.indexOf(${JSON.stringify(TESTNAME)}) >= 0);
      const x = sp && Array.from(sp.querySelectorAll('button')).find(b => b.textContent.trim() === '删');
      if (x) x.click();
      await new Promise(r => setTimeout(r, 700));
      window.confirm = orig;
      const left = Array.from(document.querySelectorAll('#memBody .btnrow span')).map(s => s.textContent);
      return { stillThere: left.some(t => t.indexOf(${JSON.stringify(TESTNAME)}) >= 0), chips: left.length };
    })()`);
    check('⚠ 确认之后文件真的被删了', !fs.existsSync(testFile));
    check('页面上也不再列出这个会话（列表当场就刷新了，不用手动重开）', deleted.stillThere === false);
    check('其他会话还在（没有顺手清一大片）', deleted.chips >= 1, `${deleted.chips} 个会话按钮`);

    try { if (fs.existsSync(testFile)) fs.unlinkSync(testFile); } catch { /* 忽略 */ }
  }

  // ------------------------------------------ 7. 分页（主界面 / 未接入 API / 接入 API / 记忆）
  //
  // 用户报的第三个问题：「控制台的 UI 非常杂乱，做成几个二级界面，主界面保持整洁」。
  // 这一段必须真开浏览器验，因为分页全靠 JS 切 hidden 和搬节点 ——
  // 接口测试和静态检查都看不出"点了没反应"。
  console.log('\n7) 分页');
  const tabs = await cdp.evaluate(`(async () => {
    const keys = ['main', 'local', 'api'];   // 记忆页没了：它成了「接入 API → 人设」的子项
    const btns = Array.from(document.querySelectorAll('#tabs .tab'));
    const out = { tabCount: btns.length, labels: btns.map(b => b.textContent.trim()) };

    const visible = () => keys.filter(k => {
      const el = document.getElementById('page-' + k);
      return el && !el.hidden;
    });

    // ⚠ 先明确切回主界面再断言"初始只显示一页"：
    //   前面的小节（人设、回复池）会点「接入 API」，于是这里"当前页"取决于上文 ——
    //   写死成 main 就会随测试顺序变化而红（实测踩到过）。
    document.querySelector('#tabs .tab[data-tab="main"]').click();
    await new Promise(r => setTimeout(r, 120));
    out.startVisible = visible();
    // 切到「接入 API」
    document.querySelector('#tabs .tab[data-tab="api"]').click();
    await new Promise(r => setTimeout(r, 120));
    out.apiVisible = visible();
    out.replyCardInApi = !!document.querySelector('#page-api #cardReply');
    out.replyCardVisible = document.getElementById('cardReply').style.display !== 'none';
    out.whitelistCount = document.querySelectorAll('#whitelist').length;   // 必须只有 1 个
    out.apiActive = document.querySelector('#tabs .tab[data-tab="api"]').classList.contains('active');

    // 切到「未接入 API」：同一张卡应该跟着搬过去（不是复制）
    document.querySelector('#tabs .tab[data-tab="local"]').click();
    await new Promise(r => setTimeout(r, 120));
    out.localVisible = visible();
    out.replyCardInLocal = !!document.querySelector('#page-local #cardReply');
    out.replyCardStillOne = document.querySelectorAll('#cardReply').length;
    out.whitelistCount2 = document.querySelectorAll('#whitelist').length;

    // 主界面：回复行为卡收起来（共用卡不属于主界面）
    document.querySelector('#tabs .tab[data-tab="main"]').click();
    await new Promise(r => setTimeout(r, 120));
    out.mainVisible = visible();
    out.replyCardHiddenOnMain = document.getElementById('cardReply').style.display === 'none';
    out.logsStillVisible = !!document.querySelector('#page-main #logs');
    out.pollCardInMain = !!document.querySelector('#page-main #cardPoll');
    return out;
  })()`);

  check('三个分页标签都在（记忆并进了「接入 API」）', tabs.tabCount === 3 && tabs.labels.join(',') === '主界面,未接入 API,接入 API',
    JSON.stringify(tabs.labels));
  check('一次只显示一页', tabs.startVisible.length === 1 && tabs.startVisible[0] === 'main',
    JSON.stringify(tabs.startVisible));
  check('点「接入 API」后只有那一页显示', tabs.apiVisible.length === 1 && tabs.apiVisible[0] === 'api',
    JSON.stringify(tabs.apiVisible));
  check('标签有选中态', tabs.apiActive === true);
  check('回复行为卡搬进了当前页（不是复制成两份）',
    tabs.replyCardInApi === true && tabs.whitelistCount === 1 && tabs.replyCardStillOne === 1
      && tabs.whitelistCount2 === 1,
    JSON.stringify([tabs.replyCardInApi, tabs.whitelistCount, tabs.replyCardStillOne, tabs.whitelistCount2]));
  check('切到「未接入 API」时它跟着搬过去', tabs.replyCardInLocal === true
    && tabs.localVisible.length === 1 && tabs.localVisible[0] === 'local', JSON.stringify(tabs.localVisible));
  check('主界面：日志在、轮询卡在、回复行为卡收起',
    tabs.mainVisible[0] === 'main' && tabs.logsStillVisible && tabs.pollCardInMain
      && tabs.replyCardHiddenOnMain === true,
    JSON.stringify([tabs.logsStillVisible, tabs.pollCardInMain, tabs.replyCardHiddenOnMain]));

  // ------------------------------------------ 8. 自定义规则编辑器（自主增加提示词）
  //
  // 用户报的第一个问题：「未接入 API 时的回复功能无法自主增加提示词」。
  // 引擎一直支持 fallback.rules，缺的就是这个界面。
  console.log('\n8) 自定义规则编辑器');
  const rulesUi = await cdp.evaluate(`(async () => {
    document.querySelector('#tabs .tab[data-tab="local"]').click();
    await new Promise(r => setTimeout(r, 100));
    const before = document.querySelectorAll('#rulesEditor .rule').length;

    // 加一条规则：匹配写法 + 两句回复
    document.getElementById('btnAddRule').click();
    await new Promise(r => setTimeout(r, 60));
    const cards = document.querySelectorAll('#rulesEditor .rule');
    const last = cards[cards.length - 1];
    last.querySelector('.ruleMatch').value = 'ZZMARK|测试专用词';
    last.querySelector('.ruleMatch').dispatchEvent(new Event('input', { bubbles: true }));
    last.querySelector('.ruleReplies').value = '第一条回复\\n第二条回复';
    last.querySelector('.ruleReplies').dispatchEvent(new Event('input', { bubbles: true }));

    const state = last.querySelector('.rulestate').textContent;
    const hint = document.getElementById('rulesHint').textContent;

    // 试打一句：走服务端的鉴权/匹配逻辑，但用界面上没保存的这份规则
    document.getElementById('ruleTest').value = 'ZZMARK 你好';
    document.getElementById('btnRuleTest').click();
    await new Promise(r => setTimeout(r, 1200));
    const out = document.getElementById('ruleTestOut').textContent;

    // 非法正则的提示
    const bad = document.querySelector('#rulesEditor .rule:last-child .ruleMatch');
    bad.value = 'ZZMARK(';
    bad.dispatchEvent(new Event('input', { bubbles: true }));
    const badState = document.querySelector('#rulesEditor .rule:last-child .rulestate').textContent;

    // 收尾：把加的那条删掉，别留在界面上（保存时才落盘，这里只是干净）
    document.querySelectorAll('#rulesEditor .rule')[cards.length - 1].querySelector('button.bad').click();
    await new Promise(r => setTimeout(r, 60));
    return {
      before, after: cards.length, state, hint, out, badState,
      afterDelete: document.querySelectorAll('#rulesEditor .rule').length,
      rulesFirstToggle: !!document.getElementById('customRulesFirst'),
      clearBtn: !!document.getElementById('btnClearRules'),
    };
  })()`);

  check('能加一条规则', rulesUi.after === rulesUi.before + 1, `${rulesUi.before} → ${rulesUi.after}`);
  check('规则卡上有匹配框和回复框，并实时说正则是否合法',
    /正则有效/.test(rulesUi.state), JSON.stringify(rulesUi.state));
  check('非法正则会明确说"按包含这段字匹配"（不能静默改语义）',
    /不是合法正则/.test(rulesUi.badState), JSON.stringify(rulesUi.badState));
  check('有「我的规则优先于内置意图」开关', rulesUi.rulesFirstToggle === true);
  check('有「全部删掉」按钮', rulesUi.clearBtn === true);
  check('条数提示会跟着变', /条/.test(rulesUi.hint), JSON.stringify(rulesUi.hint));
  check('「试一下」用的是**没保存的**规则也能命中（否则用户会以为规则不生效）',
    /自定义规则/.test(rulesUi.out) && /ZZMARK|第一条回复|第二条回复/.test(rulesUi.out),
    JSON.stringify(rulesUi.out));
  check('删掉之后回到原来的条数', rulesUi.afterDelete === rulesUi.before,
    `${rulesUi.afterDelete} vs ${rulesUi.before}`);

  // ------------------------------------------ 9. 轮询卡（会动鼠标，必须能看清会轮哪些）
  console.log('\n9) 自动轮询卡');
  const pollUi = await cdp.evaluate(`(async () => {
    document.querySelector('#tabs .tab[data-tab="main"]').click();
    await new Promise(r => setTimeout(r, 100));
    const has = !!document.getElementById('cardPoll');
    const enabled = document.getElementById('pollEnabled').checked;
    const scope = document.getElementById('pollScope').value;
    const summary = document.getElementById('pollSummary').textContent;
    const pause = document.getElementById('pollPause').checked;
    const restore = document.getElementById('pollRestore').checked;
    // 空跑一次目标计算（只读会话列表，不点任何东西）
    document.getElementById('btnPollTest').click();
    await new Promise(r => setTimeout(r, 4000));
    const out = document.getElementById('pollTestOut').textContent;
    return { has, enabled, scope, summary, pause, restore, out };
  })()`);

  check('轮询卡在主界面', pollUi.has === true);
  check('轮询卡把当前状态显示在标题上', /开启|未开启/.test(pollUi.summary), JSON.stringify(pollUi.summary));
  check('轮询范围是个下拉（全部/白名单/指定列表）', ['all', 'whitelist', 'list'].includes(pollUi.scope),
    pollUi.scope);
  check('「我用电脑时暂停」默认开着', pollUi.pause === true);
  check('「点完把光标放回原处」默认开着', pollUi.restore === true);
  check('空跑会报出会轮哪些（或说清为什么读不到）',
    pollUi.out.includes('会轮') || pollUi.out.includes('读不到'), JSON.stringify(pollUi.out.slice(0, 120)));

  // ------------------------------------------ 10. 「模型调不通时发不发兜底话」
  //
  // 用户问「为什么接管模式还有固定回复」之后加的开关。
  // 这个键（reply.fallbackWhenApiDown）在接上线之前是**死配置**：
  // config.json 里写着、没有任何代码读它，改成 false 行为一点不变也不报错。
  // 所以这里要验三件事：控件在、说明会跟着勾选变、保存时会带上它。
  console.log('\n10) 兜底开关（模型挂了发不发罐头话）');
  const fbUi = await cdp.evaluate(`(async () => {
    document.querySelector('#tabs .tab[data-tab="api"]').click();
    await new Promise(r => setTimeout(r, 120));
    const box = document.getElementById('fallbackWhenApiDown');
    const hint = document.getElementById('fbHint');
    if (!box) return { exists: false };
    const before = { checked: box.checked, hint: hint ? hint.textContent : '' };
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    const after = { hint: hint ? hint.textContent : '' };
    box.checked = !box.checked;                      // 还原
    box.dispatchEvent(new Event('change', { bubbles: true }));
    const restored = hint ? hint.textContent : '';
    return { exists: true, before, after, restored };
  })()`);

  check('接管卡里有这个开关', fbUi.exists === true);
  // 注意：初始勾选状态取决于**用户自己的配置**，所以只验"两种状态的说明不一样、
  // 且两种后果都写清楚了"，不写死哪一边是勾上的（写死就会随用户改配置变红）。
  check('说明会跟着勾选变（两种状态都讲清了后果）',
    fbUi.exists && fbUi.before.hint !== fbUi.after.hint
      && (/顶一句/.test(fbUi.before.hint) || /顶一句/.test(fbUi.after.hint))
      && (/不回/.test(fbUi.before.hint) || /不回/.test(fbUi.after.hint)),
    JSON.stringify([fbUi.before?.hint?.slice(0, 26), fbUi.after?.hint?.slice(0, 26)]));
  check('切回去之后说明也还原', fbUi.exists && fbUi.restored === fbUi.before.hint);
  // 保存载荷里必须带上它（否则界面上改了、保存时不写，等于又一个死开关）
  check('保存时会提交这个键',
    /'reply\.fallbackWhenApiDown': \$\('fallbackWhenApiDown'\)\.checked/.test(PAGE_SRC));

  // ------------------------------------------ 11. 思考模式开关（只对本地服务显示）
  //
  // 用户要求：「在控制台搞个按钮，能关闭本地模型的思考功能」。
  // 这里验**界面行为**：切到本地服务时它出现、并显示当前值；
  // 切到云端厂商时整块收起来 —— 那个参数云端不认，露出来只会让人误点。
  console.log('\n11) 思考模式开关');
  const thinkUi = await cdp.evaluate(`(async () => {
    const sel = document.getElementById('provider');
    const orig = sel.value;
    const wrap = document.getElementById('thinkingWrap');
    const box = document.getElementById('enableThinking');

    const seen = {};
    for (const o of Array.from(sel.options)) {
      sel.value = o.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 90));
      seen[o.value] = {
        visible: wrap.style.display !== 'none',
        checked: box ? box.checked : null,
        isLocal: !!(VIEW.providers[o.value] || {}).isLocal,
      };
    }

    // 收尾：还原厂商选择（否则后面的保存会把别的厂商写进配置）
    sel.value = orig;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 90));
    return { seen, restored: sel.value === orig, orig };
  })()`);

  const rows = Object.entries(thinkUi.seen);
  const locals = rows.filter(([, v]) => v.isLocal);
  const clouds = rows.filter(([, v]) => !v.isLocal);
  check('挨个切过厂商都没报错', rows.length > 0, JSON.stringify(Object.keys(thinkUi.seen)));
  check('本地服务：开关可见', locals.length > 0 && locals.every(([, v]) => v.visible === true),
    JSON.stringify(locals.map(([k, v]) => [k, v.visible])));
  check('云端厂商：这一块收起来（云端不认 chat_template_kwargs）',
    clouds.every(([, v]) => v.visible === false), JSON.stringify(clouds.map(([k, v]) => [k, v.visible])));
  check('本地服务的开关反映了配置里的当前值（不是恒 true/false）',
    locals.every(([, v]) => typeof v.checked === 'boolean'),
    JSON.stringify(locals.map(([k, v]) => [k, v.checked])));
  check('切完厂商还原了原选择（不能把测试值留在界面上）', thinkUi.restored === true);
  check('保存时只对本地服务提交这个键',
    /p\.isLocal === true\)\s*\?\s*\{ \['llm\.providers\.' \+ provider \+ '\.enableThinking'\]/.test(PAGE_SRC));

  // ------------------------------------------ 12. 系统消息过滤开关
  //
  // 用户要求：「制作过滤系统消息」。界面上要能看见它筛了哪些、并且能自己加规则。
  console.log('\n12) 系统消息过滤');
  const sysUi = await cdp.evaluate(`(async () => {
    document.querySelector('#tabs .tab[data-tab="api"]').click();
    await new Promise(r => setTimeout(r, 120));
    const box = document.getElementById('ignoreSystemMessages');
    const hint = document.getElementById('systemHint');
    const pat = document.getElementById('systemPatterns');
    if (!box) return { exists: false };
    const before = { checked: box.checked, hint: hint.textContent };
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    const after = { hint: hint.textContent };
    box.checked = !box.checked;                 // 还原
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      exists: true, before, after, restored: hint.textContent,
      hasPatternInput: !!pat,
      patternPlaceholder: pat ? pat.placeholder : '',
    };
  })()`);

  check('回复行为卡里有这个开关', sysUi.exists === true);
  check('说明会跟着开关变（开着列出筛了哪些、关掉说清"不过滤"）',
    sysUi.exists && sysUi.before.hint !== sysUi.after.hint
      && (/临时会话/.test(sysUi.before.hint) || /临时会话/.test(sysUi.after.hint))
      && (/不过滤/.test(sysUi.before.hint) || /不过滤/.test(sysUi.after.hint)),
    JSON.stringify([sysUi.before?.hint?.slice(0, 30), sysUi.after?.hint?.slice(0, 30)]));
  check('切回去之后说明也还原', sysUi.exists && sysUi.restored === sysUi.before.hint);
  check('有"自己加规则"的输入框', sysUi.hasPatternInput === true);
  check('保存时会提交开关和自加的规则',
    /'trigger\.ignoreSystemMessages': \$\('ignoreSystemMessages'\)\.checked/.test(PAGE_SRC)
    && /'trigger\.systemPatterns': \$\('systemPatterns'\)\.value\.split/.test(PAGE_SRC));

  cdp.close();
} catch (e) {
  check('浏览器测试执行完成', false, e.message);
} finally {
  // 还原配置
  cfgGuard.restore();
  stateGuard.restore();
  check('配置已还原（测试没有把你的设置留下）',
    fs.readFileSync(CFG, 'utf8') === originalCfg,
    fs.readFileSync(CFG, 'utf8') === originalCfg ? '' : '文件内容和测试前不一致！');
  try { browser?.kill(); } catch { /* 忽略 */ }
  await new Promise((r) => setTimeout(r, 500));
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log('\n' + '='.repeat(70));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(70));
process.exitCode = fail > 0 ? 1 : 0;
