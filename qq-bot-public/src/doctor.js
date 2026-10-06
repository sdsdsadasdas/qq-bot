/**
 * doctor.js — 上线前自检。按顺序跑一遍完整链路，每一步都给出明确的通过/失败。
 *
 * 用法：node src/doctor.js
 *
 * 检查项：
 *   1. 运行环境（Node 版本 / 平台）
 *   2. 所有 .ps1 的语法（用 PowerShell 自己的 parser，不执行）
 *   3. 能否找到可见的 QQ 窗口
 *   4. 截图是否成功
 *   5. OCR 是否成功、语言引擎是否是中文
 *   6. 解析出的会话名和消息
 *   7. 白名单是否命中
 *   8. 大模型 API 是否可用（不可用不影响运行，会走本地降级）
 *   9. 发送通道 dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from './config.js';
import { runPs, psQuote } from './ps.js';
import { captureAndOcr } from './capture.js';
import { parseChat } from './parse.js';
import { checkApi } from './llm.js';
import { sendMessage } from './sender.js';
import { isWhitelisted } from './config.js';
import { parseUia, findLayoutPanes, resolveChatColumn } from './parse-uia.js';

const cfg = loadConfig();
const results = [];

function record(name, ok, detail, fatal = false) {
  results.push({ name, ok, detail, fatal });
  const mark = ok === true ? 'PASS' : ok === false ? 'FAIL' : 'SKIP';
  console.log(`[${mark}] ${name}`);
  if (detail) console.log(`       ${detail}`);
}

async function checkScriptSyntax() {
  const toolsDir = path.join(ROOT, 'tools');
  const scripts = fs.readdirSync(toolsDir).filter((f) => f.endsWith('.ps1'));
  const inner = scripts
    .map((f) => {
      const full = path.join(toolsDir, f).replace(/\\/g, '\\\\');
      return `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${full}',[ref]$null,[ref]$e);` +
             `if($e -and $e.Count){"FAIL ${f}: "+$e[0].Message}else{"OK ${f}"}`;
    })
    .join(';');

  const tmp = path.join(ROOT, '.tmp-syntax-check.ps1');
  // 必须带 UTF-8 BOM：Windows PowerShell 5.1 会把无 BOM 的 UTF-8 当 ANSI(GBK) 解码，
  // 路径里的中文（如 D:\bots）会变成乱码，然后报「找不到路径」。
  fs.writeFileSync(tmp, '\uFEFF' + inner, 'utf8');
  try {
    const { execFile } = await import('node:child_process');
    const out = await new Promise((resolve) => {
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp],
        { encoding: 'utf8', windowsHide: true, timeout: 60000 },
        (err, stdout, stderr) => resolve(String(stdout || '') + String(stderr || '')));
    });
    const bad = out.split(/\r?\n/).filter((l) => l.startsWith('FAIL'));
    record('.ps1 语法', bad.length === 0, bad.length ? bad.join(' | ') : `${scripts.length} 个脚本全部通过`);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('qq-bot 自检');
  console.log('='.repeat(70));

  // 1 环境
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  record('运行环境', nodeMajor >= 18, `Node ${process.versions.node} / ${process.platform}`);
  if (process.platform !== 'win32') {
    record('平台', false, '本方案依赖 Windows（PrintWindow + WinRT OCR），非 Windows 无法运行', true);
    return finish();
  }

  // 2 脚本语法
  await checkScriptSyntax();

  // 3+4+5 截图与 OCR
  let cap = null;
  let parsed = null;
  try {
    cap = await captureAndOcr(cfg);
    record('窗口定位', true, `pid=${cap.target?.pid} handle=${cap.target?.handle} ` +
      `visible=${cap.target?.visible} minimized=${cap.target?.minimized} ${cap.target?.w}x${cap.target?.h}`);
    record('截图', true, `${cap.imageW}x${cap.imageH} → ${path.basename(cap.imagePath)}`);
    const isChinese = /zh/i.test(cap.engine ?? '');
    record('OCR', isChinese, `引擎=${cap.engine} 识别 ${cap.lines.length} 行${isChinese ? '' : '（不是中文引擎，中文识别会很差）'}`);
  } catch (err) {
    record('截图/OCR', false, err.message, true);
    return finish();
  }

  // 6a UIA 那一侧的布局与解析（**先跑**，因为下面要用它判定）
  //
  // 为什么要单独报这个：**私聊和群聊的布局不一样**（群聊右侧有成员列表，
  // 私聊没有，发送按钮位置差 250px）。以前这里看不出来，只能靠猜。
  // 出问题时第一眼看这一节：是群聊还是私聊、边界用的是哪种锚点、读到了什么。
  let uiaParsed = null;
  try {
    // ⚠ 参数必须跟 reader.js 的**真实读取**保持一致（含 -ProcessName）。
    //   以前这里写的是 runPs('uia-read.ps1', [])：读出来的东西和机器人实际读的
    //   不是同一个（少了一整类元素），于是 doctor 报的布局和机器人的行为对不上 ——
    //   「报告和实际不一致」是最容易把人带偏的那种体检结论。
    const raw = await runPs('uia-read.ps1', ['-ProcessName', cfg.process?.name ?? 'QQ'],
      { timeoutMs: 30000 });
    if (!raw || raw.ok !== true) {
      record('UIA 布局', false, raw?.error ?? 'uia-read.ps1 没返回 ok');
    } else {
      const panes = findLayoutPanes(raw);
      const col = resolveChatColumn(raw.sendButton, cfg, panes);
      uiaParsed = parseUia(raw, cfg);
      const kind = panes.member ? '群聊（右侧有成员列表）' : '私聊（没有成员列表）';
      record('UIA 布局', null,
        `${kind}　锚点=${col.anchor}　元素 ${raw.texts?.length ?? 0} / Pane ${raw.panes?.length ?? 0}`);
      console.log(`       消息带 x ${col.xMin}~${col.xMax}　自己 x≥${col.selfXMin} 右沿 ${col.selfXMax}`);
      console.log(`       标题带 x ${col.titleXMin}~${col.titleXMax} y ${col.titleYMin}~${col.titleYMax}`);
      console.log(`       消息列表面板 = ${col.pane ? `${col.pane.x}..${col.pane.x + col.pane.w}` : '（没读到，退回偏移方案）'}`);
      console.log(`       会话名="${uiaParsed.conversation}" 消息 ${uiaParsed.messages.length} 条　isGroup=${uiaParsed.isGroup}`);
      // 发送者行靠什么认：有的群**一个 LV 徽章都没有**（实测「测试群」就是这样），
      // 那时只能靠头像认出发送者。名字和正文粘连的故障就出在这里，所以直接报出来。
      console.log(`       发送者行锚点=${uiaParsed.senderAnchor}`
        + `（lv=LV 徽章／avatar=头像 ${uiaParsed.avatarCount ?? 0} 个／none=没有，只能按 y 断句）`);
      for (const m of uiaParsed.messages.slice(0, 6)) {
        const meta = [m.time, m.title, m.sender].filter(Boolean).join('|');
        console.log(`       [${m.side === 'self' ? '我' : '他'}] ${meta ? meta + '：' : ''}${m.text}`);
      }
      if (uiaParsed.conversation === '' && uiaParsed.messages.length === 0) {
        console.log('       提示：会话名和消息都读不到 —— QQ 是不是停在非聊天页、或者窗口刚被移动过？');
        console.log('             私聊/群聊都会自动适配，但需要窗口停在某个聊天上。');
      }
    }
  } catch (err) {
    record('UIA 布局', false, err.message);
  }

  // 6b 解析（**按配置里实际用的那条路判定**）
  //
  // ⚠ 这里以前一律拿 OCR 的结果去判：readSource=uia 的时候，
  //   UIA 明明读得好好的，doctor 还是报「解析 0 条 / 不在白名单」——
  //   报告和机器人的实际行为对不上，是最容易把人带偏的那种体检结论。
  const source = String(cfg.readSource ?? '').toLowerCase();
  const useUia = source === 'uia' && uiaParsed;
  try {
    if (useUia) {
      record('解析', uiaParsed.messages.length > 0 || uiaParsed.conversation !== '',
        `[UIA 路线] 会话名="${uiaParsed.conversation}" 消息 ${uiaParsed.messages.length} 条 ` +
        `(他人 ${uiaParsed.incoming.length} / 自己 ${uiaParsed.self.length})`);
      if (uiaParsed.messages.length === 0) {
        console.log(`       （这个会话当前没有可读的消息 —— 空会话是正常的，会话名读出来就说明布局对上了）`);
      }
    } else {
      parsed = parseChat(cap.lines, { w: cap.imageW, h: cap.imageH }, cfg);
      record('解析', parsed.messages.length > 0,
        `[OCR 路线] 会话名="${parsed.conversation}" 消息 ${parsed.messages.length} 条 ` +
        `(他人 ${parsed.incoming.length} / 自己 ${parsed.self.length})`);
      if (parsed.messages.length === 0) {
        console.log('\n提示：解析不到消息，通常是窗口没打开、没进入某个聊天，或者几何参数不匹配。');
        console.log('      先确认 QQ 主窗口可见且停在某个聊天上，再跑一次。');
      }
      for (const m of parsed.messages.slice(0, 6)) {
        console.log(`       [${m.side === 'self' ? '我' : '他'}] ${m.text}`);
      }
    }
  } catch (err) {
    record('解析', false, err.message);
  }

  // 7 白名单（同样按实际用的那条路判定）
  const wl = cfg.trigger?.whitelist ?? [];
  if (wl.length === 0) {
    record('白名单', null, '为空 → 不会回复任何会话（这是安全默认）。填入会话名后才生效。');
  } else {
    const seenName = useUia ? uiaParsed.conversation : (parsed?.conversation ?? '');
    const hit = isWhitelisted(cfg, seenName);
    record('白名单', hit,
      hit ? `当前会话「${seenName}」在白名单内` : `当前会话「${seenName}」不在白名单 ${JSON.stringify(wl)} 内`,
      false);
  }

  // 8 大模型
  const provName = cfg.llm?.providerName ?? cfg.llm?.provider ?? '?';
  const provInfo = `${provName}/${cfg.llm?.model}  key=${cfg.llm?.apiKeySource ?? 'none'}`;
  if (!cfg.llm?.apiKeySet) {
    const others = (cfg.llm?.providerList ?? []).filter((p) => p !== provName);
    record('大模型 API', null,
      `${provInfo}\n        没读到 API key，运行时会走本地规则回复。\n` +
      `        配 key：设环境变量 ${cfg.llm?.apiKeyEnv}，或写进 config.json 的 llm.providers.${provName}.apiKey` +
      (others.length ? `\n        也可以换厂商：把 llm.provider 改成 ${others.join(' / ')}` : ''));
  } else {
    const api = await checkApi(cfg);
    if (api.ok) {
      record('大模型 API', true, `${provInfo}\n        可用，${api.ms}ms，样例回复："${api.sample}"`);
    } else {
      record('大模型 API', null,
        `${provInfo}\n        调用失败（${api.reason}${api.detail ? ': ' + api.detail : ''}）→ 运行时会降级到本地规则。`);
    }
  }

  // 9 发送通道
  try {
    const send = await sendMessage(cfg, '【自检】这条消息不应该被真正发送', { dryRun: true });
    record('发送通道（dry-run）', send.ok === true, send.ok ? '通道正常，dry-run 未发送任何内容' : send.error);
  } catch (err) {
    record('发送通道（dry-run）', false, err.message);
  }

  finish();
}

function finish() {
  console.log('='.repeat(70));
  const fail = results.filter((r) => r.ok === false);
  const skip = results.filter((r) => r.ok === null);
  console.log(`结果：通过 ${results.filter((r) => r.ok === true).length} / 失败 ${fail.length} / 跳过 ${skip.length}`);
  if (fail.length) {
    console.log('\n失败项：');
    for (const f of fail) console.log(`  - ${f.name}: ${f.detail}`);
  }
  console.log('='.repeat(70));
  process.exitCode = fail.some((f) => f.fatal) ? 1 : 0;
}

main().catch((err) => {
  console.error('自检崩溃:', err.stack ?? err.message);
  process.exitCode = 2;
});
