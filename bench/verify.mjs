import { spawn } from 'node:child_process';
import { writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ROOT } from '../agent/config.mjs';

// 只取模块汇总行，排除逐测试类的 "Time elapsed" 行，避免重复计数。
const TEST_SUMMARY = /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)(?!.*Time elapsed)/g;

function run(command, args, cwd) {
  return new Promise((resolve) => {
    // Windows 的 .cmd/.bat 必须经 shell 启动，否则 Node 直接 spawn 会抛 EINVAL。
    const shell = /\.(cmd|bat)$/i.test(command);
    const quote = (value) => (/\s/.test(value) ? `"${value}"` : value);
    const commandLine = [command, ...args].map(quote).join(' ');
    const child = shell
      ? spawn(commandLine, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => resolve({ exitCode: -1, output, error: error.message }));
    child.on('close', (exitCode) => resolve({ exitCode, output }));
  });
}

function parseTotals(output) {
  const totals = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  for (const match of output.matchAll(TEST_SUMMARY)) {
    totals.tests += Number(match[1]);
    totals.failures += Number(match[2]);
    totals.errors += Number(match[3]);
    totals.skipped += Number(match[4]);
  }
  return totals;
}

export async function verify({ cwd, outputDir, benchmark, env = process.env }) {
  const pom = resolve(cwd, 'pom.xml');
  try {
    if (!(await stat(pom)).isFile()) {
      return writeResult(outputDir, { status: 'skipped', reason: '工作副本没有 pom.xml' });
    }
  } catch {
    return writeResult(outputDir, { status: 'skipped', reason: '工作副本没有 pom.xml' });
  }

  const maven = env.MAVEN_PATH?.trim() || (process.platform === 'win32' ? 'mvn.cmd' : 'mvn');
  const args = [
    '-B', '-f', pom,
    `-Dmaven.repo.local=${join(ROOT, '.cache', 'maven')}`,
    '-Dfile.encoding=UTF-8',
  ];
  if (benchmark === 'cron-utils') args.push('-Djacoco.skip=true');
  args.push('test');

  const { exitCode, output, error } = await run(maven, args, cwd);
  await writeFile(join(outputDir, 'verification.log'), output + '\n');
  const totals = parseTotals(output);
  const buildSuccess = /BUILD SUCCESS/.test(output);
  const buildFailure = /BUILD FAILURE/.test(output);
  let status = 'error';
  if (error) status = 'skipped';
  else if (buildSuccess || (exitCode === 0 && totals.tests > 0)) status = 'passed';
  else if (buildFailure || exitCode !== 0) status = 'failed';

  return writeResult(outputDir, {
    status,
    reason: error || undefined,
    command: [maven, ...args],
    exitCode,
    buildSuccess,
    ...totals,
  });
}

async function writeResult(outputDir, result) {
  await writeFile(join(outputDir, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
