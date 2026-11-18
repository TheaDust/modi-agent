import { readConfig, publicConfig, loadSdk } from './config.mjs';

try {
  const config = readConfig(process.env, { requireModel: false });
  await loadSdk(config);
  console.log(JSON.stringify(publicConfig(config), null, 2));
  const missing = ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY'].filter((key) => !process.env[key]?.trim());
  console.log(missing.length ? `SDK 可用；待填写：${missing.join(', ')}` : 'SDK 与模型配置检查通过；此命令不发起模型请求。');
  if (missing.length) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
