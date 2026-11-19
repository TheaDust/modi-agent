import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function git(cwd, args) {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

// 结果工作副本必须是 git 仓库，否则 git diff 无法作为变更规模的来源。
// 基线提交在 Agent 运行之前完成；失败的副本降级为 unavailable，不影响单轮记录。
export async function initBaseline(cwd) {
  try {
    await git(cwd, ['init', '-q']);
    await git(cwd, ['add', '-A']);
    await git(cwd, ['-c', 'user.name=modi-agent', '-c', 'user.email=modi-agent@local',
      'commit', '-q', '-m', 'baseline']);
    return { status: 'ready', baseCommit: (await git(cwd, ['rev-parse', 'HEAD'])).trim() };
  } catch (error) {
    return { status: 'unavailable', reason: error.message };
  }
}

// 把 Agent 的新增文件（含被 .gitignore 忽略的文件）纳入 diff。
export async function stageChanges(cwd, changedFiles = []) {
  await git(cwd, ['add', '-A']);
  for (const file of changedFiles) {
    if (file.startsWith('.git/') || file === '.git') continue;
    try {
      await git(cwd, ['add', '-f', '--', file]);
    } catch {
      // 删除的文件已由 git add -A 处理。
    }
  }
}

function parseNumstat(text) {
  const byPath = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const [added, deleted, path] = line.split('\t');
    if (path === undefined) continue;
    byPath.set(path, {
      added: added === '-' ? null : Number(added),
      deleted: deleted === '-' ? null : Number(deleted),
    });
  }
  return byPath;
}

function parseNameStatus(text) {
  const byPath = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const [status, first, second] = line.split('\t');
    if (!status || first === undefined) continue;
    if (second !== undefined) {
      byPath.set(second, { status, renameFrom: first });
    } else {
      byPath.set(first, { status });
    }
  }
  return byPath;
}

export async function lineDiff(cwd) {
  const numstat = parseNumstat(await git(cwd, ['diff', '--cached', '--numstat', 'HEAD']));
  const nameStatus = parseNameStatus(await git(cwd, ['diff', '--cached', '--name-status', 'HEAD']));
  const paths = [...new Set([...numstat.keys(), ...nameStatus.keys()])].sort();
  const files = paths.map((path) => ({
    path,
    status: nameStatus.get(path)?.status ?? 'M',
    ...(nameStatus.get(path)?.renameFrom ? { renameFrom: nameStatus.get(path).renameFrom } : {}),
    added: numstat.get(path)?.added ?? 0,
    deleted: numstat.get(path)?.deleted ?? 0,
  }));
  return {
    baseCommit: (await git(cwd, ['rev-parse', 'HEAD'])).trim(),
    filesChanged: files.length,
    linesAdded: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
    linesDeleted: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
    files,
  };
}
