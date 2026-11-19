import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, cp, readdir, stat } from 'node:fs/promises';
import { resolve, join, relative, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readConfig, ROOT } from '../agent/config.mjs';
import { runAgent, TOOLS } from '../agent/runtime.mjs';
import { initBaseline, stageChanges, lineDiff } from './diff.mjs';
import { verify } from './verify.mjs';

export const DEFAULT_TASKS = {
  inspect: '检查 pom.xml 和源码目录，说明主要组件及其依赖关系，并引用相关文件路径。',
  optimize: '在不改变现有行为、公共 API 和现有测试的前提下，检查该项目的变更传播路径，实施能降低后续需求实现成本的架构优化，并报告改动依据与验证结果。',
};

export function agentSpec(markdown) {
  const match = markdown.match(/^## 给智能体的需求\s*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m);
  if (!match) throw new Error('需求文件缺少 ## 给智能体的需求');
  return match[1].trim();
}

export async function manifest(directory) {
  const files = {};
  async function walk(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.git', 'target', 'node_modules'].includes(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files[relative(directory, path).replaceAll('\\', '/')] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  await walk(directory);
  return files;
}

function runGuard({ cwd, mode, outputDir, env }) {
  return new Promise((done) => {
    const child = spawn(env.PYTHON || 'python', [
      join(ROOT, 'bench', 'guard.py'), cwd, '--mode', mode,
      '--json', join(outputDir, 'guard.json'),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => done({ status: 'skipped', reason: error.message, valid: true }));
    child.on('close', (code) => {
      if (code === 1) done({ status: 'error', reason: stderr.trim(), valid: true });
      else done({ status: code === 2 ? 'invalid' : 'ok', valid: code !== 2, stdout: stdout.trim() });
    });
  });
}

async function hasPom(cwd) {
  try { return (await stat(join(cwd, 'pom.xml'))).isFile(); } catch { return false; }
}

export async function prepareRun({ benchmark, from, mode, prompt, systemPrompt }) {
  if (!['bookkeeping', 'cron-utils'].includes(benchmark)) throw new Error('benchmark 必须为 bookkeeping 或 cron-utils');
  if (!TOOLS[mode]) throw new Error('mode 必须为 inspect、optimize 或 feature');
  const source = from ? resolve(ROOT, from) : join(ROOT, 'benchmarks', benchmark, 'source');
  if (!(await stat(source)).isDirectory()) throw new Error('起点必须为源码目录');
  const id = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${benchmark}-${mode}-${randomUUID().slice(0, 8)}`;
  const outputDir = join(ROOT, 'results', id);
  const cwd = join(outputDir, 'workspace');
  await mkdir(outputDir, { recursive: true });
  await cp(source, cwd, {
    recursive: true,
    filter: (path) => !['.git', 'target', 'node_modules'].includes(basename(path)),
  });
  if (mode === 'optimize') {
    await mkdir(join(cwd, '_tools'), { recursive: true });
    await cp(join(ROOT, 'tools', 'structure.py'), join(cwd, '_tools', 'structure.py'));
  }
  const baseline = await initBaseline(cwd);
  const before = await manifest(cwd);
  const provenance = JSON.parse(await readFile(join(ROOT, 'benchmarks', benchmark, 'provenance.json'), 'utf8'));
  const runRecord = { id, benchmark, mode, source, provenance, baseline, promptSha256: createHash('sha256').update(prompt).digest('hex') };
  if (systemPrompt !== undefined) runRecord.systemPromptSha256 = createHash('sha256').update(systemPrompt).digest('hex');
  await writeFile(join(outputDir, 'run.json'), JSON.stringify(runRecord, null, 2) + '\n');
  await writeFile(join(outputDir, 'before.json'), JSON.stringify(before, null, 2) + '\n');
  return { id, outputDir, cwd, before, baseline };
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    benchmark: { type: 'string', default: 'bookkeeping' },
    mode: { type: 'string', default: 'inspect' },
    prompt: { type: 'string' }, 'prompt-file': { type: 'string' },
    requirement: { type: 'string' }, from: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('npm run agent -- --benchmark bookkeeping|cron-utils --mode inspect|optimize|feature [--prompt TEXT | --prompt-file FILE | --requirement R1] [--from SOURCE_DIR]');
    console.log('inspect/optimize 省略任务时使用固定默认任务；feature 必须提供 --requirement 或任务文本。');
    return;
  }
  const config = readConfig();
  delete process.env.LLM_API_KEY;
  if (!TOOLS[values.mode]) throw new Error('mode 必须为 inspect、optimize 或 feature');
  if (!['bookkeeping', 'cron-utils'].includes(values.benchmark)) throw new Error('未知 benchmark');
  if ([values.prompt, values['prompt-file'], values.requirement].filter(Boolean).length > 1) throw new Error('任务来源只能选择一种');
  let prompt = values.prompt;
  if (values['prompt-file']) prompt = await readFile(resolve(ROOT, values['prompt-file']), 'utf8');
  if (values.requirement) {
    if (values.mode !== 'feature' || !/^R[1-5]$/.test(values.requirement)) throw new Error('--requirement 仅用于 feature 模式，取值 R1–R5');
    prompt = agentSpec(await readFile(join(ROOT, 'benchmarks', values.benchmark, 'requirements', `${values.requirement}.md`), 'utf8'));
  }
  prompt ??= DEFAULT_TASKS[values.mode];
  if (!prompt?.trim()) throw new Error('feature 模式需要明确的需求或任务文本');
  const systemPrompt = await readFile(join(ROOT, 'prompts', `${values.mode}.md`), 'utf8');
  const run = await prepareRun({ benchmark: values.benchmark, from: values.from, mode: values.mode, prompt, systemPrompt });
  console.log(`Run: ${run.outputDir}`);
  const summary = await runAgent({ config, ...run, mode: values.mode, prompt, systemPrompt, onText: (text) => process.stdout.write(text) });
  const after = await manifest(run.cwd);
  const changed = [...new Set([...Object.keys(run.before), ...Object.keys(after)])].filter((path) => run.before[path] !== after[path]);
  await writeFile(join(run.outputDir, 'changes.json'), JSON.stringify({ filesChanged: changed.length, files: changed, after }, null, 2) + '\n');

  // 行级 diff 是 H1 变更规模的来源；基线提交在 Agent 运行前已写入 run.json。
  if (run.baseline?.status === 'ready') {
    try {
      await stageChanges(run.cwd, changed);
      const diff = await lineDiff(run.cwd);
      await writeFile(join(run.outputDir, 'diff.json'), JSON.stringify(diff, null, 2) + '\n');
    } catch (error) {
      await writeFile(join(run.outputDir, 'diff.json'), JSON.stringify({ status: 'unavailable', reason: error.message }, null, 2) + '\n');
    }
  }

  let guardResult = null;
  let verification = null;
  if (summary.status === 'completed' && await hasPom(run.cwd)) {
    guardResult = await runGuard({ cwd: run.cwd, mode: values.mode, outputDir: run.outputDir, env: process.env });
    verification = await verify({ cwd: run.cwd, outputDir: run.outputDir, benchmark: values.benchmark });
  }

  const { input, output, cacheRead, cacheWrite, totalTokens } = summary.usage;
  console.log(`\nStatus: ${summary.status}; requests: ${summary.requests}; tools: ${summary.toolCalls}; changed files: ${changed.length}`);
  console.log(`Tokens: input ${input}, output ${output}, cache read ${cacheRead}, cache write ${cacheWrite}, total ${totalTokens}`);
  console.log(`Time: ${summary.wallTimeSeconds.toFixed(2)}s; cost: $${summary.cost.total.toFixed(6)}`);
  if (guardResult) console.log(`Guard: ${guardResult.status}${guardResult.stdout ? ` — ${guardResult.stdout}` : ''}`);
  if (verification) console.log(`Verification: ${verification.status}${verification.reason ? ` — ${verification.reason}` : ''}`);
  if (summary.error) console.error(summary.error);
  if (summary.status !== 'completed') process.exitCode = 1;
  if (guardResult && !guardResult.valid) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
