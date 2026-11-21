import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadSdk, publicConfig } from './config.mjs';

export const TOOLS = {
  inspect: ['read', 'grep', 'find', 'ls'],
  optimize: ['read', 'grep', 'find', 'ls', 'edit', 'write', 'powershell'],
  feature: ['read', 'grep', 'find', 'ls', 'edit', 'write', 'powershell'],
};

// 运行控制项，A/B 两组完全一致。
// 开启自动重试是为了抵御网关的瞬时传输错误：连接中断与实现质量无关，
// 不重试会随机淘汰某一组的某一轮，既浪费一次样本，也会给配对比较引入与自变量无关的噪声。
export const CONTROLS = {
  compaction: false,
  retries: true,
  maxRetries: 3,
  cacheWarming: false,
};

const roundCost = (value) => Math.round(value * 1e9) / 1e9;

function calculateCost(usage, pricing) {
  const amount = (tokens, price) => roundCost((tokens * price) / pricing.unitTokens);
  const cost = {
    currency: pricing.currency,
    input: amount(usage.input, pricing.input),
    output: amount(usage.output, pricing.output),
    cacheRead: amount(usage.cacheRead, pricing.cacheRead),
    cacheWrite: amount(usage.cacheWrite, pricing.cacheWrite),
  };
  cost.total = roundCost(cost.input + cost.output + cost.cacheRead + cost.cacheWrite);
  return cost;
}

async function isWorkspacePath(cwd, input) {
  const root = await realpath(cwd);
  let target = resolve(cwd, input);
  const missing = [];
  while (true) {
    try { target = resolve(await realpath(target), ...missing.reverse()); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(target);
      if (parent === target) throw error;
      missing.push(relative(parent, target));
      target = parent;
    }
  }
  const rel = relative(root, target);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

export async function runAgent({ config, cwd, outputDir, mode, prompt, systemPrompt, onText = () => {} }) {
  if (!TOOLS[mode]) throw new Error(`未知 Agent 模式：${mode}`);
  cwd = await realpath(cwd);
  await mkdir(outputDir, { recursive: true });
  const redact = (text) => config.apiKey ? text.replaceAll(config.apiKey, '[REDACTED]') : text;
  const saveJson = (name, value) => writeFile(join(outputDir, name), redact(JSON.stringify(value, null, 2)) + '\n');
  const record = (event) => appendFileSync(join(outputDir, 'events.jsonl'), redact(JSON.stringify({ time: new Date().toISOString(), ...event })) + '\n');
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let session;
  let termination;
  let failure;
  let requests = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let finalMessage;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const interrupt = () => { termination = 'interrupted'; session?.agent.abort(); };
  await saveJson('config.json', { ...publicConfig(config), mode, cwd, tools: TOOLS[mode], ...CONTROLS });
  await writeFile(join(outputDir, 'prompt.md'), redact(prompt));
  await writeFile(join(outputDir, 'system-prompt.md'), redact(systemPrompt));
  try {
    const sdk = await loadSdk(config);
    const agentDir = join(outputDir, 'runtime');
    await mkdir(agentDir, { recursive: true });
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'), modelsPath: null,
      modelsStorePath: join(agentDir, 'models.json'), refreshOnCreate: false,
    });
    modelRuntime.registerProvider('experiment', {
      api: config.api, baseUrl: config.baseUrl,
      models: [{
        id: config.model, name: config.model, api: config.api,
        // 必须声明 reasoning: true，SDK 才会把思考档位作为 reasoning_effort 发给服务商；
        // 声明为 false 时 SDK 一个参数都不发，网关按自己的默认值思考，档位实际不受控。
        reasoning: true, input: ['text'],
        // 网关用 none 表示关闭思考；其余档位原样透传，避免 SDK 折叠掉配置允许的档位。
        thinkingLevelMap: { off: 'none', xhigh: 'xhigh', max: 'max' },
        contextWindow: config.contextWindow, maxTokens: config.maxOutputTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    });
    await modelRuntime.setRuntimeApiKey('experiment', config.apiKey);
    const resourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => systemPrompt,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
      extendResources: () => {}, reload: async () => {},
    };
    ({ session } = await sdk.createAgentSession({
      cwd, agentDir, modelRuntime, model: modelRuntime.getModel('experiment', config.model),
      thinkingLevel: config.thinkingLevel, tools: TOOLS[mode], resourceLoader,
      sessionManager: sdk.SessionManager.inMemory(cwd),
      settingsManager: sdk.SettingsManager.inMemory({
        compaction: { enabled: false }, cacheWarming: 'off',
        retry: { enabled: CONTROLS.retries, provider: { maxRetries: CONTROLS.maxRetries } },
        enableAnalytics: false, enableInstallTelemetry: false,
      }),
    }));
    session.agent.toolExecution = 'sequential';
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, options) => {
      requests++;
      record({ type: 'model_request', request: requests });
      return stream(model, context, { ...options, temperature: config.temperature, maxTokens: config.maxOutputTokens });
    };
    const beforeToolCall = session.agent.beforeToolCall;
    session.agent.beforeToolCall = async (context, signal) => {
      const previous = await beforeToolCall?.(context, signal);
      if (previous?.block) return previous;
      if (context.toolCall.name !== 'powershell' && !(await isWorkspacePath(cwd, context.args.path || '.'))) {
        return { block: true, reason: 'File tools must stay inside the working copy.' };
      }
      return previous;
    };
    session.subscribe((event) => {
      if (event.type === 'message_update') {
        if (event.assistantMessageEvent.type === 'text_delta') onText(event.assistantMessageEvent.delta);
        return;
      }
      record(event);
      if (event.type === 'tool_execution_start') toolCalls++;
      if (event.type === 'tool_execution_end' && event.isError) toolErrors++;
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        finalMessage = event.message;
        for (const key of Object.keys(usage)) usage[key] += event.message.usage?.[key] || 0;
      }
    });
    process.once('SIGINT', interrupt);
    await session.prompt(prompt, { expandPromptTemplates: false });
    if (['error', 'aborted', 'length'].includes(finalMessage?.stopReason)) {
      failure = finalMessage.errorMessage || `Model stopped: ${finalMessage.stopReason}`;
    }
    if (!finalMessage) failure = 'No assistant response received';
  } catch (error) {
    failure = error.message;
  } finally {
    process.removeListener('SIGINT', interrupt);
    session?.dispose();
  }
  const finalText = finalMessage?.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') || '';
  await writeFile(join(outputDir, 'answer.md'), redact(finalText));
  const summary = {
    status: termination || (failure ? 'failed' : 'completed'),
    startedAt, finishedAt: new Date().toISOString(), wallTimeSeconds: (performance.now() - started) / 1000,
    model: config.model, api: config.api, mode, requests, toolCalls, toolErrors, usage,
    cost: calculateCost(usage, config.pricing), correctness: 'not_evaluated',
    error: failure ? redact(failure) : null,
  };
  await saveJson('summary.json', summary);
  return summary;
}
