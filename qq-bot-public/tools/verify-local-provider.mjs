/**
 * 验证 qq-bot 的 local 厂商配置能否真正调通 Qwen3-14B。
 * 复用机器人自己的模块，所以测的是真实代码路径，不是另写一遍。
 */
import { loadConfig } from '../src/config.js';
import { probeProvider } from '../src/llm.js';

const cfg = loadConfig({ argv: [] });
const llm = cfg.llm;

console.log('=== 解析后的 llm 配置 ===');
console.log('  provider      :', llm.providerName);
console.log('  baseUrl       :', llm.baseUrl);
console.log('  model         :', llm.model);
console.log('  apiKeyEnv     :', llm.apiKeyEnv);
console.log('  apiKey 已加载 :', llm.apiKeySet, llm.apiKeySet ? `(${llm.apiKey.slice(0, 12)}...)` : '');
console.log('  key 来源      :', llm.apiKeySource);
console.log('  requiresKey   :', llm.apiKeyRequired);
console.log('  enableThinking:', llm.enableThinking);
console.log('  jsonMode      :', llm.jsonMode);
console.log('  timeoutMs     :', llm.timeoutMs);
console.log('  needsKeyConfig:', llm.needsKeyConfig);

console.log('\n=== 实调验证 ===');
try {
  const r = await probeProvider({
    baseUrl: llm.baseUrl,
    apiKey: llm.apiKey,
    model: llm.model,
    enableThinking: llm.enableThinking,
    timeoutMs: llm.timeoutMs,
  });
  console.log('  结果:', JSON.stringify(r, null, 2));
} catch (err) {
  console.log('  失败:', err?.message ?? err);
}
