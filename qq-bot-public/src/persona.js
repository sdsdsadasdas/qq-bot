/**
 * persona.js — 人设（一个"身份"）：提示词 + 它的人生 + 它的记忆。
 *
 * 需求原话：「可以切换人设提示词（相当于把人生模拟的人生切换改到人设身上），
 * 把人生模拟和记忆作为人设的子项，即根据不同的提示词切换不同的人生和记忆」。
 *
 * 也就是说：**人设不再是一段配置文本，而是一个可以切换的身份**。
 *   personas/<名字>.json  → { name, systemPrompt: [...], life: "<人生名>" }
 *   切人设 = 换提示词 + 换它的人生 + 换它那份记忆（记忆在 memory/<名字>/ 下）
 *
 * 为什么提示词要放到**文件**里、而不是继续留在 config.json：
 *   config.json 是启动时读一次就缓存的（`const cfg = loadConfig()`）。
 *   提示词放在那里 = 每次切换都得重启机器人。而"切换人设"这件事
 *   跟"切换人生"是同一类操作 —— 用户期望的是**点了立刻生效**。
 *   所以人设跟人生一样：一个文件一份，用到的时候现读。
 *   兼容：没建过任何人生/人设时，仍然用 config.json 里那份（老行为不变）。
 *
 * ⚠ 切换只写 state.json（`personaProfile`），不改 config.json。
 *   理由和 life/人设一样：config 是"设置"，这是"现在是谁在说话"。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 人设文件放在哪。 */
export function personasDir(cfg, root) {
  const d = String(cfg?.persona?.dir ?? 'personas');
  return path.isAbsolute(d) ? d : path.resolve(root ?? process.cwd(), d);
}

/**
 * 人设名 → 文件名。
 *
 * 为什么不像记忆那样加短哈希：人设是**用户自己起的名字**，而且会显示在控制台的
 * 下拉框里、还会出现在 memory/<名字>/ 这种目录名上 —— 名字得能认出来。
 * 所以只做最基本的替换（去掉路径分隔符和 Windows 不允许的字符），
 * 不改名字本身；真撞了名字（同一个名字两份人设）本来就是用户该避免的事。
 */
export function personaSlug(name) {
  const s = String(name ?? '').trim();
  if (!s) return '';
  return s
    .replace(/[\\/:*?"<>|]/g, '_')     // Windows 文件名不允许的字符
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')               // 别让它变成隐藏文件 / 上级目录
    .slice(0, 40);
}

export function personaFile(cfg, root, name) {
  return path.join(personasDir(cfg, root), `${personaSlug(name)}.json`);
}

/** 当前是哪个身份。空串 = 没建过人设，用 config.json 里那份（老行为）。 */
export function activePersonaName(cfg, state) {
  const s = String(state?.personaProfile ?? '').trim();
  if (s) return s;
  return '';
}

const readJson = (file) => {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
};

/** 读一份人设。返回 null 表示没有/读不出来。 */
export function loadPersona(cfg, root, name) {
  const want = String(name ?? '').trim();
  if (!want) return null;
  const raw = readJson(personaFile(cfg, root, want));
  if (!raw) return null;
  const prompts = Array.isArray(raw.systemPrompt)
    ? raw.systemPrompt
    : (typeof raw.systemPrompt === 'string' ? raw.systemPrompt.split(/\r?\n/) : []);
  return {
    name: String(raw.name ?? want),
    systemPrompt: prompts.map((s) => String(s ?? '')),
    // 这个身份过的是谁的日子。留空 → 用它自己的名字当人生名（一人一生，最直观）。
    life: String(raw.life ?? '').trim() || String(raw.name ?? want),
    note: String(raw.note ?? ''),
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
    path: personaFile(cfg, root, want),
  };
}

/**
 * 列出所有人设（按名字排序）。
 * 目录不存在就返回空数组 —— 这是"还没用过多身份"的正常状态，不是错误。
 */
export function listPersonas(cfg, root) {
  const dir = personasDir(cfg, root);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    const raw = readJson(path.join(dir, f));
    if (!raw) continue;
    const name = String(raw.name ?? f.replace(/\.json$/i, ''));
    const p = loadPersona(cfg, root, name);
    if (p) out.push({ name: p.name, life: p.life, lines: p.systemPrompt.length, updatedAt: p.updatedAt });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

/** 写一份人设（存在就覆盖提示词/人生，不存在就新建）。 */
export function savePersona(cfg, root, name, patch = {}) {
  const want = String(name ?? '').trim();
  if (!want) return { ok: false, error: '没给人设名字' };
  const file = personaFile(cfg, root, want);
  const prev = readJson(file) ?? {};
  const now = new Date().toISOString();

  const lines = patch.systemPrompt !== undefined
    ? (Array.isArray(patch.systemPrompt) ? patch.systemPrompt : String(patch.systemPrompt).split(/\r?\n/))
      .map((s) => String(s ?? ''))
    : (Array.isArray(prev.systemPrompt) ? prev.systemPrompt : []);

  const data = {
    $comment: [
      '一份人设 = 一个"身份"：提示词 + 它过的人生 + 它自己的记忆。',
      'systemPrompt 是它的说话方式和设定（接管模式用它，一篇一行更好读）。',
      'life 指向 lives/<名字>.json 那份生活日志；留空就用自己的名字。',
      '它那份记忆在 memory/<名字>/ 下（跟别人设是分开的）。',
      '控制台里可以随时切换人设；切换只改 state.json，不用重启机器人。',
    ],
    name: want,
    systemPrompt: lines,
    life: String(patch.life ?? prev.life ?? '').trim(),
    note: String(patch.note ?? prev.note ?? ''),
    createdAt: prev.createdAt ?? now,
    updatedAt: now,
  };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (e) {
    return { ok: false, error: `写人设文件失败：${e?.message ?? e}` };
  }
  return { ok: true, persona: loadPersona(cfg, root, want) };
}

/** 把一份人设的内容抄给另一份（新建时的"复制当前这份当起点"）。 */
export function copyPersona(cfg, root, from, to) {
  const src = loadPersona(cfg, root, from);
  if (!src) return { ok: false, error: `找不到人设「${from}」` };
  return savePersona(cfg, root, to, { systemPrompt: src.systemPrompt, life: src.life, note: src.note });
}

/**
 * 删除一份人设文件。
 *
 * ⚠ **不动它的记忆和人生**：memory/<名字>/ 和 lives/<名字>.json 原样留着。
 *   人设是"怎么说话"，记忆和经历是"发生过什么" —— 删掉说话方式不等于
 *   要把这段经历也抹掉（那不可逆，而且用户多半只是不想要这个身份了）。
 */
export function deletePersona(cfg, root, name) {
  const file = personaFile(cfg, root, name);
  if (!fs.existsSync(file)) return { ok: false, error: '这份人设不存在' };
  try {
    fs.unlinkSync(file);   // ⚠ 用 unlinkSync：fs.rmSync 在 Z: 盘上是静默无效的（踩过）
  } catch (e) {
    return { ok: false, error: `删除失败：${e?.message ?? e}` };
  }
  return { ok: true };
}

/**
 * 第一次用「人设」时，把 config.json 里那份提示词搬成一份人设。
 *
 * 为什么要搬：用户已经有一份写好的人设（config.persona.systemPrompt），
 * 不搬的话他一进控制台看到的是"一份人设都没有"，会以为东西丢了。
 *
 * @param {object} opts.life 这份人设对应的人生名（一般取当前的人生）
 * @returns {{ok:boolean, name?:string, error?:string, already?:boolean}}
 */
export function seedFromConfig(cfg, root, opts = {}) {
  const existing = listPersonas(cfg, root);
  if (existing.length > 0) return { ok: true, already: true, name: existing[0].name };

  const lines = Array.isArray(cfg?.persona?.systemPrompt)
    ? cfg.persona.systemPrompt
    : String(cfg?.persona?.systemPrompt ?? '').split(/\r?\n/);
  const clean = lines.map((s) => String(s ?? ''));
  if (clean.join('').trim() === '') return { ok: false, error: 'config.json 里也没有提示词，没什么可搬的' };

  const name = String(opts.name ?? '默认').trim() || '默认';
  const r = savePersona(cfg, root, name, {
    systemPrompt: clean,
    life: String(opts.life ?? '').trim(),
    note: '从 config.json 的 persona.systemPrompt 搬过来的（第一次使用人设功能时自动创建）',
  });
  return r.ok ? { ok: true, name, seeded: true } : r;
}

/**
 * 切换人设要写进 state.json 的那几个字段。
 *
 * 为什么要单独一个函数：切换**不只是换个名字** —— 记忆是按人设分目录的，
 * 人生也跟着人设走。三处必须一起改，分散在界面代码里迟早会漏一个
 * （比如切了人设却没切人生，于是新身份过着旧身份的日子）。
 *
 * @returns {{ok:boolean, error?:string, patch?:object, persona?:object}}
 */
export function planSwitch(cfg, root, name) {
  const want = String(name ?? '').trim();
  if (!want) return { ok: false, error: '没给人设名字' };
  const p = loadPersona(cfg, root, want);
  if (!p) return { ok: false, error: `找不到人设「${want}」` };
  if (p.systemPrompt.join('').trim() === '') {
    return { ok: false, error: `人设「${want}」的提示词是空的 —— 空提示词会让 API 报错（接管时会静默降级成本地规则）` };
  }
  return {
    ok: true,
    persona: p,
    patch: {
      personaProfile: p.name,
      // 人生跟着人设走。注意 lifeProfile 是老字段，人生模拟模块读的就是它，
      // 所以这里**复用它**而不是另起一套 —— 少一处状态就少一处能不同步的地方。
      lifeProfile: p.life || p.name,
    },
  };
}

/** 给控制台/文档用：现在生效的提示词是从哪来的。 */
export function promptSource(cfg, root, state) {
  const name = activePersonaName(cfg, state);
  if (name) {
    const p = loadPersona(cfg, root, name);
    if (p && p.systemPrompt.join('').trim() !== '') {
      return { from: 'persona', name: p.name, lines: p.systemPrompt.length, path: p.path };
    }
  }
  const n = Array.isArray(cfg?.persona?.systemPrompt)
    ? cfg.persona.systemPrompt.length
    : String(cfg?.persona?.systemPrompt ?? '').split(/\r?\n/).length;
  return { from: 'config', name: '', lines: n, path: null };
}
