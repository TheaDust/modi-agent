import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, readConfig, publicConfig } from '../agent/config.mjs';
import { runAgent } from '../agent/runtime.mjs';
import { agentSpec, prepareRun, manifest } from '../bench/run.mjs';

const sdkPath = process.env.PI_SDK_PATH;
const key = 'local-smoke-secret-not-a-real-key';

async function fixture(t, handler, overrides = {}) {
  await mkdir(join(ROOT, '.cache'), { recursive: true });
  const dir = await mkdtemp(join(ROOT, '.cache', 'agent-smoke-'));
  const cwd = join(dir, 'workspace');
  await mkdir(cwd);
  await writeFile(join(cwd, 'input.txt'), 'fixture input\n');
  await writeFile(join(dir, 'outside.txt'), 'must stay outside model context');
  const bodies = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, `Bearer ${key}`);
      let body = '';
      for await (const chunk of request) body += chunk;
      bodies.push(JSON.parse(body));
      handler(response, bodies.at(-1), bodies.length);
    } catch (error) {
      response.writeHead(500); response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  const config = readConfig({
    PI_SDK_PATH: sdkPath, LLM_API: 'openai-completions',
    LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    LLM_MODEL: 'local-smoke-model', LLM_API_KEY: key,
    AGENT_MAX_REQUESTS: '6', AGENT_TIMEOUT_SECONDS: '30', ...overrides,
  });
  const outputDir = join(dir, 'output');
  const run = (mode = 'feature') => runAgent({ config, cwd, outputDir, mode,
    systemPrompt: 'Complete the task using the supplied tools.', prompt: 'Read input.txt and write output.txt.' });
  return { cwd, dir, outputDir, bodies, config, run };
}

function sse(response, { name, args, text = 'Smoke complete.' } = {}) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (choices, extra = {}) => response.write(`data: ${JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', created: 1, model: 'local-smoke-model', choices, ...extra })}\n\n`);
  const delta = name
    ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
    : { role: 'assistant', content: text };
  chunk([{ index: 0, delta, finish_reason: null }]);
  chunk([{ index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }]);
  chunk([], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  response.end('data: [DONE]\n\n');
}

test('SDK calls a local endpoint, reads and writes files, and records usage', async (t) => {
  const f = await fixture(t, (response, body, n) => {
    if (n === 1) sse(response, { name: 'read', args: { path: 'input.txt' } });
    else if (n === 2) {
      assert.ok(body.messages.some((message) => message.role === 'tool' && JSON.stringify(message).includes('fixture input')));
      sse(response, { name: 'write', args: { path: 'output.txt', content: 'SDK tool loop works\n' } });
    } else if (n === 3) {
      sse(response, { name: 'edit', args: { path: 'output.txt', oldText: 'SDK tool loop works', newText: 'SDK coding tools work' } });
    } else if (n === 4) {
      sse(response, { name: 'powershell', args: { command: 'Get-Content output.txt', timeout: 10 } });
    } else {
      assert.ok(body.messages.some((message) => message.role === 'tool' && JSON.stringify(message).includes('SDK coding tools work')));
      sse(response, { text: `Smoke complete. ${key}` });
    }
  });
  const result = await f.run();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.requests, 5);
  assert.equal(result.toolCalls, 4);
  assert.equal(result.toolErrors, 0);
  assert.ok(result.usage.totalTokens > 0);
  assert.equal(result.correctness, 'not_evaluated');
  assert.equal(result.monetaryCost, null);
  assert.equal(await readFile(join(f.cwd, 'output.txt'), 'utf8'), 'SDK coding tools work\n');
  assert.ok(f.bodies.every((body) => body.temperature === 0));
  assert.ok(f.bodies.every((body) => (body.max_tokens ?? body.max_completion_tokens) === 8192));
  for (const file of ['config.json', 'events.jsonl', 'answer.md', 'summary.json']) {
    assert.ok(!(await readFile(join(f.outputDir, file), 'utf8')).includes(key), file);
  }
});

test('request limit stops further model calls', async (t) => {
  const f = await fixture(t, (response) => sse(response, { name: 'read', args: { path: 'input.txt' } }), { AGENT_MAX_REQUESTS: '1' });
  const result = await f.run();
  assert.equal(result.status, 'request_limit', JSON.stringify(result));
  assert.equal(f.bodies.length, 1);
});

test('provider error is a failed run and is not retried', async (t) => {
  const f = await fixture(t, (response) => { response.writeHead(401); response.end(JSON.stringify({ error: { message: 'invalid fixture credential' } })); });
  const result = await f.run();
  assert.equal(result.status, 'failed', JSON.stringify(result));
  assert.equal(f.bodies.length, 1);
});

test('timeout aborts an outstanding model request', async (t) => {
  const f = await fixture(t, () => {}, { AGENT_TIMEOUT_SECONDS: '1' });
  const result = await f.run();
  assert.equal(result.status, 'timeout', JSON.stringify(result));
  assert.ok(result.wallTimeSeconds < 10);
});

test('inspect mode is read-only and blocks files outside its working copy', async (t) => {
  const f = await fixture(t, (response, body, n) => {
    const tools = body.tools.map((tool) => tool.function.name);
    assert.deepEqual(tools.sort(), ['find', 'grep', 'ls', 'read']);
    if (n === 1) sse(response, { name: 'read', args: { path: '../outside.txt' } });
    else {
      assert.ok(!JSON.stringify(body).includes('must stay outside model context'));
      sse(response);
    }
  });
  const result = await f.run('inspect');
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.ok((await readFile(join(f.outputDir, 'events.jsonl'), 'utf8')).includes('File tools must stay inside'));
});

test('experiment runner copies sources and only extracts the agent-facing requirement', async () => {
  const requirement = await readFile(join(ROOT, 'benchmarks/bookkeeping/requirements/R1.md'), 'utf8');
  const prompt = agentSpec(requirement);
  assert.ok(prompt.includes('业务需求'));
  assert.ok(!prompt.includes('中文说明'));
  assert.ok(!prompt.includes('预期架构敏感点'));
  const source = join(ROOT, 'benchmarks/cron-utils/source');
  const before = await manifest(source);
  const run = await prepareRun({ benchmark: 'cron-utils', mode: 'inspect', prompt });
  assert.deepEqual(run.before, before);
  await writeFile(join(run.cwd, 'smoke-only.txt'), 'working copy');
  assert.deepEqual(await manifest(source), before);
});

test('configuration validates budgets and excludes the API key from metadata', () => {
  const env = { PI_SDK_PATH: sdkPath, LLM_API_KEY: key, LLM_BASE_URL: 'http://localhost:1234/v1', LLM_MODEL: 'smoke' };
  assert.ok(!JSON.stringify(publicConfig(readConfig(env))).includes(key));
  assert.throws(() => readConfig({ ...env, AGENT_MAX_REQUESTS: '0' }), /AGENT_MAX_REQUESTS/);
  assert.throws(() => readConfig({ ...env, LLM_API_KEY: '' }), /LLM_API_KEY/);
  assert.throws(() => agentSpec('plain text'), /给智能体的需求/);
});

test('CLI runs an experiment against the SDK endpoint and writes final artifacts', async (t) => {
  const f = await fixture(t, (response, _body, n) => {
    if (n === 1) sse(response, { name: 'write', args: { path: 'output.txt', content: 'CLI works\n' } });
    else sse(response);
  });
  const child = spawn(process.execPath, [join(ROOT, 'bench/run.mjs'), '--mode', 'feature', '--from', f.cwd, '--prompt', 'Write output.txt.'], {
    cwd: ROOT, env: { ...process.env, PI_SDK_PATH: sdkPath, LLM_API: f.config.api, LLM_BASE_URL: f.config.baseUrl,
      LLM_MODEL: f.config.model, LLM_API_KEY: key, AGENT_TIMEOUT_SECONDS: '30', AGENT_MAX_REQUESTS: '4' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [exitCode] = await once(child, 'close');
  assert.equal(exitCode, 0, stdout + stderr);
  const outputDir = stdout.match(/^Run: (.+)$/m)?.[1].trim();
  assert.ok(outputDir, stdout);
  const summary = JSON.parse(await readFile(join(outputDir, 'summary.json'), 'utf8'));
  const changes = JSON.parse(await readFile(join(outputDir, 'changes.json'), 'utf8'));
  assert.equal(summary.status, 'completed');
  assert.equal(summary.requests, 2);
  assert.deepEqual(changes.files, ['output.txt']);
  assert.equal(await readFile(join(outputDir, 'workspace/output.txt'), 'utf8'), 'CLI works\n');
  assert.deepEqual(Object.keys(await manifest(f.cwd)), ['input.txt']);
});
