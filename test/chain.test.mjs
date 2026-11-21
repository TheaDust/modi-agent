import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from '../agent/config.mjs';
import { classify, runChain } from '../bench/chain.mjs';

async function tempDir(t, prefix) {
  await mkdir(join(ROOT, '.cache'), { recursive: true });
  return mkdtemp(join(ROOT, '.cache', prefix));
}

// 假的一轮：按计划写出 summary/guard/verification/acceptance 四份产物。
function fakeRunner(root, plan) {
  const calls = [];
  const runner = async ({ requirement, from }) => {
    const attempt = calls.filter((call) => call.requirement === requirement).length + 1;
    calls.push({ requirement, attempt, from });
    const status = plan(requirement, attempt);
    const outputDir = join(root, `${requirement}.${attempt}`);
    await mkdir(join(outputDir, 'workspace'), { recursive: true });
    const summary = { status: 'completed', requests: 10, toolCalls: 8, wallTimeSeconds: 60,
      usage: { input: 100, output: 50, cacheRead: 20, totalTokens: 170 }, cost: { total: 0.002 } };
    if (status === 'agent-failed') summary.status = 'failed';
    await writeFile(join(outputDir, 'summary.json'), JSON.stringify(summary));
    await writeFile(join(outputDir, 'guard.json'), JSON.stringify({ valid: status !== 'guard-invalid', api: { changedSignatures: [] } }));
    await writeFile(join(outputDir, 'verification.json'), JSON.stringify({
      status: status === 'verification-failed' ? 'failed' : 'passed',
      tests: 20, failures: status === 'verification-failed' ? 1 : 0,
    }));
    await writeFile(join(outputDir, 'acceptance.json'), JSON.stringify({
      status: status === 'acceptance-failed' ? 'failed' : 'passed', tests: 7, failures: 0,
    }));
    return { exitCode: status === 'ok' ? 0 : 1, outputDir };
  };
  return { runner, calls };
}

test('classify turns artifact state into a keep-or-discard verdict', async (t) => {
  const dir = await tempDir(t, 'chain-classify-');
  const { runner } = fakeRunner(dir, () => 'ok');
  const { outputDir } = await runner({ requirement: 'R1' });
  assert.equal((await classify(outputDir)).status, 'ok');

  for (const [status, expected] of [
    ['agent-failed', 'agent-failed'],
    ['guard-invalid', 'guard-invalid'],
    ['verification-failed', 'verification-failed'],
    ['acceptance-failed', 'acceptance-failed'],
  ]) {
    const one = fakeRunner(dir, () => status);
    const made = await one.runner({ requirement: 'R1' });
    assert.equal((await classify(made.outputDir)).status, expected);
  }
});

test('a verification that could not run is discarded, not accepted', async (t) => {
  const dir = await tempDir(t, 'chain-verify-error-');
  const { runner } = fakeRunner(dir, () => 'ok');
  const { outputDir } = await runner({ requirement: 'R1' });
  await writeFile(join(outputDir, 'verification.json'), JSON.stringify({ status: 'error', reason: 'maven failed to start' }));
  assert.equal((await classify(outputDir)).status, 'verification-error');
});

test('a chain feeds each round with the previous round\'s workspace', async (t) => {
  const dir = await tempDir(t, 'chain-order-');
  const base = join(dir, 'base');
  await mkdir(base);
  const { runner, calls } = fakeRunner(dir, () => 'ok');
  const state = await runChain({
    benchmark: 'bookkeeping', side: 'A', replicate: 1, base,
    rounds: ['R1', 'R2'], maxAttempts: 3, chainDir: join(dir, 'chain'), runRoundImpl: runner,
  });
  assert.equal(state.status, 'completed');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].from, base);
  // 第二轮的起点必须是第一轮成功产出的工作副本，链条因此逐轮累积。
  assert.equal(calls[1].from, join(dir, 'R1.1', 'workspace'));
});

test('a failed round is discarded and retried without moving the chain', async (t) => {
  const dir = await tempDir(t, 'chain-retry-');
  const base = join(dir, 'base');
  await mkdir(base);
  const { runner, calls } = fakeRunner(dir, (requirement, attempt) => {
    if (requirement === 'R2' && attempt === 1) return 'guard-invalid';
    return 'ok';
  });
  const state = await runChain({
    benchmark: 'bookkeeping', side: 'A', replicate: 1, base,
    rounds: ['R1', 'R2', 'R3'], maxAttempts: 3, chainDir: join(dir, 'chain'), runRoundImpl: runner,
  });
  assert.equal(state.status, 'completed');
  assert.equal(calls.length, 4);
  // 被丢弃的那一轮与重跑的那一轮，起点必须相同。
  assert.equal(calls[1].from, calls[2].from);
  assert.equal(calls[1].from, join(dir, 'R1.1', 'workspace'));
  // 链条位置不动：第三轮从 R2 的成功产物出发，而不是被丢弃的那一轮。
  assert.equal(calls[3].from, join(dir, 'R2.2', 'workspace'));
  assert.equal(state.rounds.R2.attempts.length, 2);
  assert.equal(state.rounds.R2.attempts[0].status, 'guard-invalid');
  assert.equal(state.rounds.R2.status, 'ok');
});

test('a chain stops when a round keeps failing and records why', async (t) => {
  const dir = await tempDir(t, 'chain-abort-');
  const base = join(dir, 'base');
  await mkdir(base);
  const { runner } = fakeRunner(dir, (requirement) => (requirement === 'R2' ? 'acceptance-failed' : 'ok'));
  await assert.rejects(
    () => runChain({
      benchmark: 'bookkeeping', side: 'A', replicate: 1, base,
      rounds: ['R1', 'R2'], maxAttempts: 2, chainDir: join(dir, 'chain'), runRoundImpl: runner,
    }),
    /R2/,
  );
  const state = JSON.parse(await readFile(join(dir, 'chain', 'state.json'), 'utf8'));
  assert.equal(state.status, 'failed');
  assert.equal(state.rounds.R2.attempts.length, 2);
  assert.equal(state.rounds.R1.status, 'ok');
});

test('a chain records every attempt with its cost and its verdict', async (t) => {
  const dir = await tempDir(t, 'chain-state-');
  const base = join(dir, 'base');
  await mkdir(base);
  const { runner } = fakeRunner(dir, () => 'ok');
  const chainDir = join(dir, 'chain');
  await runChain({
    benchmark: 'bookkeeping', side: 'B', replicate: 2, base,
    rounds: ['R1'], maxAttempts: 3, chainDir, runRoundImpl: runner,
  });
  const state = JSON.parse(await readFile(join(chainDir, 'state.json'), 'utf8'));
  assert.equal(state.side, 'B');
  assert.equal(state.replicate, 2);
  assert.equal(state.rounds.R1.status, 'ok');
  const attempt = state.rounds.R1.attempts[0];
  assert.equal(attempt.status, 'ok');
  assert.equal(attempt.totalTokens, 170);
  assert.equal(attempt.acceptanceTests, 7);
  assert.equal(attempt.changedSignatures, 0);
});
