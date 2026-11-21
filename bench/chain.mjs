import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../agent/config.mjs';

export const CHAIN_ROOT = join(ROOT, 'results', '_chains');

// 一轮失败的原因决定是否丢弃该轮产物并重跑同一轮。
export const RETRYABLE = new Set(['agent-failed', 'guard-invalid', 'acceptance-failed', 'verification-failed', 'verification-error', 'no-run-dir']);

// 判定一轮产物的可用性。产物缺哪一项就退化为哪一项的结论。
export async function classify(outputDir) {
  const read = async (name) => {
    try {
      return JSON.parse(await readFile(join(outputDir, name), 'utf8'));
    } catch {
      return null;
    }
  };
  const summary = await read('summary.json');
  if (!summary || summary.status !== 'completed') return { status: 'agent-failed', summary };
  const guard = await read('guard.json');
  if (guard && !guard.valid) return { status: 'guard-invalid', summary, guard };
  const verification = await read('verification.json');
  // verification 的 error 表示 Maven 调用本身失败（基础设施问题），不是实现有错；
  // 但它同样让这一轮无法被验证，因此同样丢弃重跑。
  if (verification && ['failed', 'error'].includes(verification.status)) {
    return { status: verification.status === 'error' ? 'verification-error' : 'verification-failed', summary, guard, verification };
  }
  const acceptance = await read('acceptance.json');
  if (acceptance && !['passed', 'skipped'].includes(acceptance.status)) return { status: 'acceptance-failed', summary, guard, verification, acceptance };
  return { status: 'ok', summary, guard, verification, acceptance };
}

export function metrics(detail) {
  const usage = detail.summary?.usage ?? {};
  return {
    requests: detail.summary?.requests ?? 0,
    toolCalls: detail.summary?.toolCalls ?? 0,
    wallTimeSeconds: detail.summary?.wallTimeSeconds ?? 0,
    inputTokens: usage.input ?? 0,
    outputTokens: usage.output ?? 0,
    cacheReadTokens: usage.cacheRead ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    costUsd: detail.summary?.cost?.total ?? 0,
    tests: detail.verification?.tests ?? 0,
    testFailures: detail.verification?.failures ?? 0,
    acceptanceTests: detail.acceptance?.tests ?? 0,
    acceptanceFailures: detail.acceptance?.failures ?? 0,
    changedSignatures: detail.guard?.api?.changedSignatures?.length ?? 0,
  };
}

async function listResultDirs() {
  try {
    const entries = await readdir(join(ROOT, 'results'), { withFileTypes: true });
    return new Set(entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('_')).map((entry) => entry.name));
  } catch {
    return new Set();
  }
}

export async function runRound({ benchmark, requirement, from, logPath }) {
  const args = [
    '--env-file=.env', join(ROOT, 'bench', 'run.mjs'),
    '--benchmark', benchmark, '--mode', 'feature', '--requirement', requirement, '--from', from,
  ];
  const before = await listResultDirs();
  const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, env: process.env });
  const log = createWriteStream(logPath);
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; log.write(chunk); });
  child.stderr.on('data', (chunk) => log.write(chunk));
  const exitCode = await new Promise((done) => {
    child.on('error', () => done(-1));
    child.on('close', (code) => done(code ?? -1));
  });
  await new Promise((done) => log.end(done));
  // 主路径：run.mjs 在 Agent 启动前打印第一行 `Run: <产物目录>`。
  const matched = stdout.match(/^Run: (.+)$/m);
  if (matched) return { exitCode, outputDir: matched[1].trim() };
  // 兜底：取运行期间新建的产物目录。
  const after = await listResultDirs();
  const created = [...after].filter((name) => !before.has(name));
  if (created.length === 1) return { exitCode, outputDir: join(ROOT, 'results', created[0]) };
  return { exitCode, outputDir: null };
}

// 一条链 = 一串按顺序执行的需求轮次。每轮的起点是上一轮成功产出的工作副本。
export async function runChain({ benchmark, side, replicate, base, rounds, maxAttempts, chainDir, runRoundImpl = runRound, onEvent = () => {} }) {
  await mkdir(chainDir, { recursive: true });
  const state = {
    side, replicate, benchmark,
    base: relative(ROOT, base).replaceAll('\\', '/'),
    rounds: {},
    status: 'running',
  };
  const persist = async () => writeFile(join(chainDir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  await persist();

  let from = base;
  for (const requirement of rounds) {
    let attempt = 1;
    let accepted = null;
    while (attempt <= maxAttempts) {
      const logPath = join(chainDir, `${requirement}.attempt${attempt}.log`);
      onEvent({ type: 'start', requirement, attempt });
      const { exitCode, outputDir } = await runRoundImpl({ benchmark, requirement, from, logPath });
      if (!outputDir) {
        state.rounds[requirement] ??= { attempts: [] };
        state.rounds[requirement].attempts.push({ attempt, exitCode, status: 'no-run-dir' });
        await persist();
        onEvent({ type: 'attempt', requirement, attempt, status: 'no-run-dir' });
        attempt += 1;
        continue;
      }
      const detail = await classify(outputDir);
      const record = {
        attempt,
        exitCode,
        status: detail.status,
        runId: outputDir.split(/[\\/]/).pop(),
        outputDir: relative(ROOT, outputDir).replaceAll('\\', '/'),
        workspace: relative(ROOT, join(outputDir, 'workspace')).replaceAll('\\', '/'),
        ...metrics(detail),
      };
      state.rounds[requirement] ??= { attempts: [] };
      state.rounds[requirement].attempts.push(record);
      await persist();
      onEvent({ type: 'attempt', requirement, attempt, status: detail.status, record });
      if (detail.status === 'ok') {
        accepted = record;
        break;
      }
      if (!RETRYABLE.has(detail.status)) break;
      attempt += 1;
    }
    if (!accepted) {
      state.status = 'failed';
      state.rounds[requirement].status = 'failed';
      await persist();
      throw new Error(`[${side}${replicate}] ${requirement} 连续 ${maxAttempts} 次尝试仍失败，链中止`);
    }
    state.rounds[requirement].status = 'ok';
    state.rounds[requirement].runId = accepted.runId;
    state.rounds[requirement].outputDir = accepted.outputDir;
    state.rounds[requirement].workspace = accepted.workspace;
    state.rounds[requirement].attempt = accepted.attempt;
    await persist();
    // 下一轮从本轮成功产出的工作副本出发，链条因此逐轮累积。
    from = resolve(ROOT, accepted.workspace);
  }

  state.status = 'completed';
  await persist();
  return state;
}

async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    benchmark: { type: 'string', default: 'bookkeeping' },
    side: { type: 'string' },
    replicate: { type: 'string' },
    base: { type: 'string' },
    rounds: { type: 'string', default: 'R1,R2,R3,R4,R5' },
    'max-attempts': { type: 'string', default: '3' },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('用法: node --env-file=.env bench/chain.mjs --side A|B --replicate N --base SOURCE_DIR [--rounds R1,R2,...] [--max-attempts 3]');
    console.log('在一条链内按顺序执行 R1→RN，每轮的起点是上一轮成功产出的工作副本。');
    console.log('某轮失败（Agent 中断 / 守卫判废 / 验收不过 / 既有测试失败）即丢弃该轮并重跑，链条位置不变。');
    return;
  }
  if (!values.side || !values.replicate || !values.base) throw new Error('必须提供 --side、--replicate 与 --base');

  const rounds = values.rounds.split(',').map((item) => item.trim()).filter(Boolean);
  const maxAttempts = Number(values['max-attempts']);
  const base = resolve(ROOT, values.base);
  const chainKey = `${values.side}${values.replicate}`;
  await runChain({
    benchmark: values.benchmark,
    side: values.side,
    replicate: Number(values.replicate),
    base,
    rounds,
    maxAttempts,
    chainDir: join(CHAIN_ROOT, chainKey),
    onEvent: (event) => {
      if (event.type === 'start') process.stderr.write(`[${chainKey}] ${event.requirement} 第 ${event.attempt} 次尝试\n`);
      else process.stderr.write(`[${chainKey}] ${event.requirement} 第 ${event.attempt} 次尝试 -> ${event.status}`
        + (event.record ? `  tokens=${event.record.totalTokens} requests=${event.record.requests}` : '') + '\n');
    },
  });
  process.stderr.write(`[${chainKey}] 链完成\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
