/**
 * test-provider.mjs — 验证多厂商切换（DeepSeek / Kimi / 智谱）。
 *
 * 测的是 config.resolveProvider 这个纯函数，不写临时文件 ——
 * 之前靠改 config.json 再读回来的写法很容易写出假测试。
 *
 * 用法：node tools/test-provider.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProvider, ROOT } from '../src/config.js';

const ROOTDIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`); }
}

const raw = JSON.parse(fs.readFileSync(path.join(ROOTDIR, 'config.json'), 'utf8'));

console.log('='.repeat(70));
console.log('多厂商配置测试');
console.log('='.repeat(70));

console.log('\n1) 每个 provider 都能正确解析出 baseUrl / model / keyEnv');
{
  const expect = {
    deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', env: 'DEEPSEEK_API_KEY' },
    kimi: { baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3', env: 'KIMI_API_KEY' },
    zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.5-air', env: 'ZHIPU_API_KEY' },
  };
  for (const [name, want] of Object.entries(expect)) {
    const resolved = resolveProvider({ llm: { ...raw.llm, provider: name } }, {});
    const ok = resolved.baseUrl === want.baseUrl
      && resolved.model === want.model
      && resolved.apiKeyEnv === want.env
      && resolved.providerName === name;
    check(`${name} → ${resolved.model}`, ok, `${resolved.baseUrl} / ${resolved.apiKeyEnv}`);
  }
}

console.log('\n2) key 来源判定');
{
  const cfgKimi = { llm: { ...raw.llm, provider: 'kimi' } };

  // 环境变量里的 key 能被读到
  let r = resolveProvider(cfgKimi, { KIMI_API_KEY: 'sk-from-env' });
  check('从环境变量读到 key', r.apiKey === 'sk-from-env' && r.apiKeySet === true, `source=${r.apiKeySource}`);
  check('来源标注为 env:KIMI_API_KEY', r.apiKeySource === 'env:KIMI_API_KEY', r.apiKeySource);

  // 配置里写的 key 优先于环境变量
  const withFileKey = {
    llm: {
      ...raw.llm,
      provider: 'kimi',
      providers: { ...raw.llm.providers, kimi: { ...raw.llm.providers.kimi, apiKey: 'sk-in-config' } },
    },
  };
  r = resolveProvider(withFileKey, { KIMI_API_KEY: 'sk-from-env' });
  check('配置里的 key 优先', r.apiKey === 'sk-in-config' && r.apiKeySource === 'config.json(kimi)', r.apiKeySource);

  // 都没有 → none，且不抛异常（要能静默降级）
  let threw = false;
  try { r = resolveProvider(cfgKimi, {}); } catch { threw = true; }
  check('没有 key 时不抛异常', !threw);
  check('key=none 且 apiKeySet=false', r.apiKey === '' && r.apiKeySet === false, `source=${r.apiKeySource}`);

  // 关键：切到 kimi 时**不能**误用 DEEPSEEK_API_KEY
  r = resolveProvider(cfgKimi, { DEEPSEEK_API_KEY: 'sk-deepseek-should-not-be-used' });
  check('切到 kimi 不会误用 DEEPSEEK_API_KEY', r.apiKey === '', `apiKey="${r.apiKey}" envName=${r.apiKeyEnv}`);
}

console.log('\n3) 没有 providers 段时向后兼容（老的单厂商配置）');
{
  const legacy = { llm: { provider: 'deepseek', baseUrl: 'https://x.test', model: 'm', apiKeyEnv: 'OLD_KEY', apiKey: '' } };
  const r = resolveProvider(legacy, { OLD_KEY: 'sk-old' });
  check('沿用顶层 baseUrl / model / apiKeyEnv',
    r.baseUrl === 'https://x.test' && r.model === 'm' && r.apiKeyEnv === 'OLD_KEY' && r.apiKey === 'sk-old',
    `${r.baseUrl} / ${r.model} / ${r.apiKeyEnv}`);
}

console.log('\n4) model 名要是当前在售的（写已下线的会直接报模型不存在）');
{
  const kimi = resolveProvider({ llm: { ...raw.llm, provider: 'kimi' } }, {});
  const retired = ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-auto', 'kimi-k2', 'kimi-k2-thinking', 'kimi-latest'];
  check(`当前用的是在售模型 ${kimi.model}`, !retired.includes(kimi.model), `model=${kimi.model}`);
  check('配置里没写已下线的 Kimi 模型',
    !retired.includes(String(raw.llm.providers.kimi.model)),
    raw.llm.providers.kimi.model);
}

console.log('\n' + '='.repeat(70));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(70));
process.exitCode = fail > 0 ? 1 : 0;
