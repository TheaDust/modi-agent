import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SDK_VERSION = '1.2.0';

export function readConfig(env = process.env, { requireModel = true } = {}) {
  const required = (key) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`请在 .env 中填写 ${key}`);
    return value;
  };
  const positiveInteger = (key, fallback) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} 必须为正整数`);
    return value;
  };
  const api = env.LLM_API || 'openai-completions';
  if (!['openai-completions', 'anthropic-messages', 'openai-responses'].includes(api)) {
    throw new Error('LLM_API 必须为 openai-completions、anthropic-messages 或 openai-responses');
  }
  const thinkingLevel = env.LLM_THINKING_LEVEL || 'off';
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinkingLevel)) {
    throw new Error('LLM_THINKING_LEVEL 不合法');
  }
  const temperature = Number(env.LLM_TEMPERATURE ?? 0);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error('LLM_TEMPERATURE 必须在 0–2 之间');
  }
  const config = {
    sdkPath: resolve(ROOT, required('PI_SDK_PATH')),
    api,
    baseUrl: requireModel ? required('LLM_BASE_URL') : env.LLM_BASE_URL?.trim(),
    model: requireModel ? required('LLM_MODEL') : env.LLM_MODEL?.trim(),
    apiKey: requireModel ? required('LLM_API_KEY') : env.LLM_API_KEY?.trim(),
    contextWindow: positiveInteger('LLM_CONTEXT_WINDOW', 128000),
    maxOutputTokens: positiveInteger('LLM_MAX_OUTPUT_TOKENS', 8192),
    temperature,
    thinkingLevel,
    maxRequests: positiveInteger('AGENT_MAX_REQUESTS', 40),
    timeoutSeconds: positiveInteger('AGENT_TIMEOUT_SECONDS', 1800),
  };
  if (config.maxOutputTokens >= config.contextWindow) {
    throw new Error('LLM_MAX_OUTPUT_TOKENS 必须小于 LLM_CONTEXT_WINDOW');
  }
  if (config.baseUrl) {
    const url = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search) {
      throw new Error('LLM_BASE_URL 应为 HTTP(S) 地址，密钥请单独放入 LLM_API_KEY');
    }
  }
  return config;
}

export function publicConfig(config) {
  const { apiKey, ...publicValues } = config;
  return { ...publicValues, apiKeyConfigured: Boolean(apiKey), sdkVersion: SDK_VERSION };
}

export async function loadSdk(config) {
  const pkg = JSON.parse(await readFile(join(config.sdkPath, 'package.json'), 'utf8'));
  if (pkg.name !== '@earendil-works/pi-coding-agent' || pkg.version !== SDK_VERSION) {
    throw new Error(`实验固定使用 @earendil-works/pi-coding-agent ${SDK_VERSION}，实际为 ${pkg.name} ${pkg.version}`);
  }
  return import(pathToFileURL(join(config.sdkPath, 'dist/index.js')).href);
}
