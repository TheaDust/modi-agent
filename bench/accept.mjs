import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from '../agent/config.mjs';
import { runMaven } from './verify.mjs';

const SOURCE = join(ROOT, 'benchmarks', 'bookkeeping', 'acceptance');
const TARGET = 'bookkeeping-core/src/test/java/com/yanimetaxas/bookkeeping/acceptance';
const REPORT = 'bookkeeping-core/target/surefire-reports';

// 冻结验收测试由实验方提供，实现方不参与编写。
// 它与实现方自写用例分开执行：编译或断言失败只影响 acceptance.json，不影响 verification.json。
export async function accept({ cwd, outputDir, benchmark, requirements, env = process.env }) {
  if (benchmark !== 'bookkeeping') {
    return writeResult(outputDir, { status: 'skipped', reason: '只有记账库案例有冻结验收测试' });
  }
  if (!requirements?.length) {
    return writeResult(outputDir, { status: 'skipped', reason: '本轮没有可冻结的需求' });
  }

  const target = join(cwd, TARGET);
  const copied = [];
  await mkdir(target, { recursive: true });
  try {
    await copyFile(join(SOURCE, 'AcceptanceSupport.java'), join(target, 'AcceptanceSupport.java'));
    copied.push('AcceptanceSupport.java');
    for (const requirement of requirements) {
      const name = `${requirement}AcceptanceTest.java`;
      await copyFile(join(SOURCE, name), join(target, name));
      copied.push(name);
    }

    const result = await runMaven({ cwd, benchmark, env });
    const { output, ...record } = result;
    await writeFile(join(outputDir, 'acceptance.log'), output + '\n');
    const perClass = await readReports(cwd, requirements);
    const compileError = /COMPILATION ERROR|BUILD FAILURE/.test(output) && perClass.length === 0;
    const tests = perClass.reduce((sum, item) => sum + item.tests, 0);
    const failures = perClass.reduce((sum, item) => sum + item.failures + item.errors, 0);
    const status = compileError ? 'compile_error' : result.status === 'passed' && tests > 0 ? 'passed' : result.status;
    return writeResult(outputDir, {
      status,
      requirements,
      files: copied,
      tests,
      failures,
      perClass,
      buildSuccess: result.buildSuccess,
      exitCode: result.exitCode,
      ...(compileError ? { reason: '冻结验收测试未能编译，见 acceptance.log' } : {}),
    });
  } finally {
    // 冻结用例不得留在工作副本里，否则会污染下一轮的 diff。
    await rm(target, { recursive: true, force: true });
  }
}

async function readReports(cwd, requirements) {
  const dir = join(cwd, REPORT);
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const requirement of requirements) {
    const file = names.find((name) => name.startsWith(`com.yanimetaxas.bookkeeping.acceptance.${requirement}AcceptanceTest`));
    if (!file) continue;
    const text = await readFile(join(dir, file), 'utf8');
    const match = text.match(/Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)/);
    if (match) {
      out.push({
        requirement,
        tests: Number(match[1]),
        failures: Number(match[2]),
        errors: Number(match[3]),
        skipped: Number(match[4]),
      });
    }
  }
  return out;
}

async function writeResult(outputDir, result) {
  await writeFile(join(outputDir, 'acceptance.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
