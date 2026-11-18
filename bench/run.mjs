import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, cp, readdir, stat } from 'node:fs/promises';
import { resolve, join, relative, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readConfig, ROOT } from '../agent/config.mjs';
import { runAgent, TOOLS } from '../agent/runtime.mjs';

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

export async function prepareRun({ benchmark, from, mode, prompt }) {
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
  const before = await manifest(cwd);
  const provenance = JSON.parse(await readFile(join(ROOT, 'benchmarks', benchmark, 'provenance.json'), 'utf8'));
  await writeFile(join(outputDir, 'run.json'), JSON.stringify({ id, benchmark, mode, source, provenance, promptSha256: createHash('sha256').update(prompt).digest('hex') }, null, 2) + '\n');
  await writeFile(join(outputDir, 'before.json'), JSON.stringify(before, null, 2) + '\n');
  return { id, outputDir, cwd, before };
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
  prompt ??= values.mode === 'inspect' ? '检查 pom.xml 和源码目录，说明主要组件及其依赖关系，并引用相关文件路径。' : undefined;
  if (!prompt?.trim()) throw new Error('optimize/feature 模式需要明确的任务文本');
  const run = await prepareRun({ benchmark: values.benchmark, from: values.from, mode: values.mode, prompt });
  console.log(`Run: ${run.outputDir}`);
  const systemPrompt = await readFile(join(ROOT, 'prompts', `${values.mode}.md`), 'utf8');
  const summary = await runAgent({ config, ...run, mode: values.mode, prompt, systemPrompt, onText: (text) => process.stdout.write(text) });
  const after = await manifest(run.cwd);
  const changed = [...new Set([...Object.keys(run.before), ...Object.keys(after)])].filter((path) => run.before[path] !== after[path]);
  await writeFile(join(run.outputDir, 'changes.json'), JSON.stringify({ filesChanged: changed.length, files: changed, after }, null, 2) + '\n');
  console.log(`\nStatus: ${summary.status}; requests: ${summary.requests}; tools: ${summary.toolCalls}; changed files: ${changed.length}`);
  if (summary.error) console.error(summary.error);
  if (summary.status !== 'completed') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
