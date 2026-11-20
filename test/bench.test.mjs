import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from '../agent/config.mjs';
import { initBaseline, stageChanges, lineDiff } from '../bench/diff.mjs';
import { verify } from '../bench/verify.mjs';

const python = process.env.PYTHON || 'python';

async function tempDir(t, prefix) {
  await mkdir(join(ROOT, '.cache'), { recursive: true });
  const dir = await mkdtemp(join(ROOT, '.cache', prefix));
  t.after(() => {});
  return dir;
}

function git(cwd, args) {
  execFileSync('git', ['-C', cwd, ...args], { windowsHide: true, stdio: 'pipe' });
}

function guard(cwd, mode = 'feature') {
  const json = join(cwd, '..', 'guard.json');
  const result = spawnSync(python, [join(ROOT, 'bench', 'guard.py'), cwd, '--mode', mode, '--json', json], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.ok(result.status === 0 || result.status === 2, result.stderr);
  return JSON.parse(readFileSync(json, 'utf8'));
}

async function javaRepo(t) {
  const dir = await tempDir(t, 'guard-test-');
  const cwd = join(dir, 'workspace');
  await mkdir(join(cwd, 'src/main/java/com/example/service'), { recursive: true });
  await mkdir(join(cwd, 'src/test/java/com/example/service'), { recursive: true });
  await mkdir(join(cwd, '_tools'), { recursive: true });
  await writeFile(join(cwd, 'pom.xml'), '<project><artifactId>fixture</artifactId></project>\n');
  await writeFile(join(cwd, '_tools', 'structure.py'), 'baseline\n');
  const service = 'package com.example.service;\npublic class AccountService {\n'
    + '  public void create(String ref) { this.ref = ref; }\n'
    + '  public String find(String ref) { return ref; }\n}\n';
  await writeFile(join(cwd, 'src/main/java/com/example/service/AccountService.java'), service);
  const test = 'package com.example.service;\nclass AccountServiceTest {\n'
    + '  void works() { assertEquals(1, service.find("a")); }\n}\n';
  await writeFile(join(cwd, 'src/test/java/com/example/service/AccountServiceTest.java'), test);
  git(cwd, ['init', '-q']);
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-q', '-m', 'baseline']);
  return { cwd, service, test };
}

test('git baseline records line-level additions and deletions', async (t) => {
  const dir = await tempDir(t, 'diff-test-');
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\n');
  const baseline = await initBaseline(dir);
  assert.equal(baseline.status, 'ready');
  await writeFile(join(dir, 'a.txt'), 'one\nchanged\n');
  await writeFile(join(dir, 'b.txt'), 'new\n');
  await stageChanges(dir, ['a.txt', 'b.txt']);
  const diff = await lineDiff(dir);
  assert.equal(diff.filesChanged, 2);
  assert.equal(diff.linesAdded, 2);
  assert.equal(diff.linesDeleted, 1);
  assert.ok(diff.files.some((file) => file.path === 'b.txt' && file.status === 'A'));
});

test('guard accepts additive feature changes without false positives', async (t) => {
  const { cwd, service } = await javaRepo(t);
  await writeFile(join(cwd, 'src/main/java/com/example/service/NewFeature.java'),
    'package com.example.service;\npublic class NewFeature {\n  public void run() { run(); }\n}\n');
  await writeFile(join(cwd, 'src/main/java/com/example/service/AccountService.java'),
    service.replace('}\n', '  public int count() { return 1; }\n}\n'));
  await writeFile(join(cwd, 'src/test/java/com/example/service/ExtraTest.java'),
    'package com.example.service;\nclass ExtraTest { void x() { assertTrue(true); } }\n');
  const result = guard(cwd, 'feature');
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.api.addedMethods, 1);
});

test('guard rejects changed assertions, deleted classes and edited tools', async (t) => {
  const { cwd, test } = await javaRepo(t);
  await writeFile(join(cwd, 'src/test/java/com/example/service/AccountServiceTest.java'),
    test.replace('assertEquals(1,', 'assertEquals(2,'));
  await unlink(join(cwd, 'src/main/java/com/example/service/AccountService.java'));
  await writeFile(join(cwd, '_tools', 'structure.py'), 'tampered\n');
  const result = guard(cwd, 'feature');
  assert.equal(result.valid, false);
  const rules = result.violations.map((item) => item.rule);
  for (const rule of ['test-assertion-changed', 'class-deleted', 'protected-file-changed']) {
    assert.ok(rules.includes(rule), JSON.stringify(result));
  }
});

test('guard tolerates a moved assertion and rejects a new cross-layer dependency', async (t) => {
  const { cwd, test } = await javaRepo(t);
  await writeFile(join(cwd, 'src/test/java/com/example/service/AccountServiceTest.java'),
    test.replace('  void works() { assertEquals(1, service.find("a")); }\n', '')
      + '  void moved() { assertEquals(1, service.find("a")); }\n');
  assert.equal(guard(cwd, 'feature').valid, true);

  const service = await readFile(join(cwd, 'src/main/java/com/example/service/AccountService.java'), 'utf8');
  await writeFile(join(cwd, 'src/main/java/com/example/service/AccountService.java'),
    service.replace('package com.example.service;\n', 'package com.example.service;\nimport com.example.dao.AccountDao;\n'));
  const result = guard(cwd, 'feature');
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((item) => item.rule === 'new-layer-dependency'));
});

test('guard rejects removal of a public method', async (t) => {
  const { cwd, service } = await javaRepo(t);
  await writeFile(join(cwd, 'src/main/java/com/example/service/AccountService.java'),
    service.replace('  public String find(String ref) { return ref; }\n', ''));
  const result = guard(cwd, 'optimize');
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((item) => item.rule === 'public-api-removed'));
});

test('build artifacts and test logs are excluded from the diff metric', async (t) => {
  const dir = await tempDir(t, 'diff-artifact-test-');
  await writeFile(join(dir, 'a.txt'), 'one\n');
  await mkdir(join(dir, 'target'), { recursive: true });
  await writeFile(join(dir, 'target', 'out.txt'), 'build\n');
  await writeFile(join(dir, 'derby.log'), 'log\n');
  const baseline = await initBaseline(dir);
  assert.equal(baseline.status, 'ready');
  await writeFile(join(dir, 'derby.log'), 'log\nchanged\n');
  await writeFile(join(dir, 'target', 'out.txt'), 'build\nchanged\n');
  await mkdir(join(dir, '_tools', '__pycache__'), { recursive: true });
  await writeFile(join(dir, '_tools', '__pycache__', 'x.pyc'), 'cache\n');
  await stageChanges(dir, ['derby.log', 'target/out.txt', '_tools/__pycache__/x.pyc']);
  const diff = await lineDiff(dir);
  assert.equal(diff.filesChanged, 0);
  assert.equal(diff.linesAdded, 0);
  assert.equal(diff.linesDeleted, 0);
});

test('guard skips non-Java working copies', async (t) => {
  const dir = await tempDir(t, 'guard-skip-');
  await writeFile(join(dir, 'input.txt'), 'x');
  const result = guard(dir);
  assert.equal(result.status, 'skipped');
  assert.equal(result.valid, true);
});

test('structure metric excludes pure delegation from the effective count', async (t) => {
  const dir = await tempDir(t, 'structure-test-');
  for (const backend of ['memory', 'jdbc']) {
    await mkdir(join(dir, backend), { recursive: true });
    await writeFile(join(dir, backend, 'Impl.java'), `package p.${backend};\nclass Impl {\n`
      + '  public void rule() { alpha(); bravo(); charlie(); delta(); echo(); foxtrot(); golf(); hotel(); india(); juliet(); kilo(); lima(); mike(); november(); }\n'
      + '  public void shared() { super.shared(); }\n}\n');
  }
  const out = join(dir, 'structure.json');
  const result = spawnSync(python, [join(ROOT, 'tools', 'structure.py'), dir, '--json', out], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(data.multi_backend_rule_count, 2);
  assert.equal(data.effective_multi_backend_rule_count, 1);
});

test('verification skips projects without a pom', async (t) => {
  const dir = await tempDir(t, 'verify-test-');
  const result = await verify({ cwd: dir, outputDir: dir, benchmark: 'bookkeeping' });
  assert.equal(result.status, 'skipped');
});
