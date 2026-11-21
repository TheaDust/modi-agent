# -*- coding: utf-8 -*-
"""汇总 A/B 配对实验的全部指标，供 docs/results.md 引用。

记法：``A_i^k`` / ``B_i^k`` —— 字母是轨迹（A 原版 / B 优化版），下标 i 是累积轮次，
上标 k 是重复序号。同一个 (i, k) 构成一个配对。

数据来源有两处，合并后使用：
  1. ``benchmarks/<案例>/runs.json`` —— 入库的链清单（每轮对应的产物目录）；
  2. ``results/_chains/<链名>/state.json`` —— 编排器落盘的在跑链状态，覆盖前者。
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STRUCT = os.path.join(ROOT, 'tools', 'structure.py')
CACHE = os.path.join(ROOT, '.cache', 'structure')
SKIP = shutil.ignore_patterns('.git', 'target', 'node_modules', '__pycache__',
                              '*.log', '*.class', '_tools', '.idea')
ROUNDS = ['R1', 'R2', 'R3', 'R4', 'R5']


def load_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def median(values):
    values = [v for v in values if v is not None]
    return round(statistics.median(values), 4) if values else None


def spread(values):
    values = [v for v in values if v is not None]
    if not values:
        return None
    return {'min': min(values), 'max': max(values)}


def structure(root, tag):
    """计算某个版本的架构指标；同一目录只算一次，结果缓存在 .cache/。"""
    os.makedirs(CACHE, exist_ok=True)
    key = hashlib.sha256((os.path.abspath(root) + tag).encode('utf-8')).hexdigest()[:16]
    out = os.path.join(CACHE, '%s_%s.json' % (tag, key))
    if not os.path.isfile(out):
        subprocess.run([sys.executable, STRUCT, root, '--json', out], capture_output=True, text=True)
    return load_json(out)


def packages_touched(workspace, files):
    """按改动文件所属的 Java 包统计触及面。"""
    found = set()
    for rel in files:
        full = os.path.join(workspace, rel.replace('/', os.sep))
        if not os.path.isfile(full):
            continue
        with open(full, encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if line.startswith('package ') and line.endswith(';'):
                    found.add(line[8:-1].strip())
                    break
    return sorted(found)


def numstat_between(dir_a, dir_b):
    tmp = tempfile.mkdtemp(prefix='cmp_')
    a, b = os.path.join(tmp, 'a'), os.path.join(tmp, 'b')
    shutil.copytree(dir_a, a, ignore=SKIP)
    shutil.copytree(dir_b, b, ignore=SKIP)
    proc = subprocess.run(['git', 'diff', '--no-index', '--numstat', a, b],
                          capture_output=True, text=True)
    added = deleted = files = 0
    for line in proc.stdout.splitlines():
        parts = line.split('\t')
        if len(parts) < 3:
            continue
        if parts[0].isdigit():
            added += int(parts[0])
        if parts[1].isdigit():
            deleted += int(parts[1])
        files += 1
    shutil.rmtree(tmp, ignore_errors=True)
    return {'files': files, 'added': added, 'deleted': deleted}


def collect_chains(benchmark, include_partial=False):
    """合并入库清单与在跑链状态，得到 (side, replicate) -> {'rounds':…, 'base':…}。

    ``base`` 是该链的起点目录（B 链是 B_0 的工作副本，A 链是案例源码），
    累计净变更必须以它为基准，不能拿第一轮的产物当基准。

    默认只纳入完整跑完的链；``include_partial`` 用于跑批期间的进度查看。
    """
    chains = {}
    manifest = load_json(os.path.join(ROOT, 'benchmarks', benchmark, 'runs.json'))
    for entry in manifest.get('chains', []):
        chains[(entry['side'], int(entry['replicate']))] = {
            'rounds': dict(entry['rounds']),
            'base': entry.get('base'),
        }

    chain_root = os.path.join(ROOT, 'results', '_chains')
    if os.path.isdir(chain_root):
        for name in sorted(os.listdir(chain_root)):
            state = load_json(os.path.join(chain_root, name, 'state.json'))
            if not state:
                continue
            if state.get('status') != 'completed' and not include_partial:
                continue
            key = (state['side'], int(state['replicate']))
            rounds = {}
            for req, info in state.get('rounds', {}).items():
                if info.get('status') == 'ok' and info.get('outputDir'):
                    rounds[req] = info['outputDir']
            if rounds:
                chains[key] = {'rounds': rounds, 'base': state.get('base')}
    return chains


def resolve_run(run_dir):
    """把产物目录的多种写法统一成绝对路径。

    入库清单里存的是目录名（相对 results/），编排器状态里存的是相对仓库根的路径，
    链的 base 可能是 results/ 下的产物目录，也可能是 benchmarks/ 下的案例源码。
    """
    if os.path.isabs(run_dir):
        return run_dir
    norm = run_dir.replace('\\', '/')
    if norm.startswith('results/'):
        return os.path.join(ROOT, norm.replace('/', os.sep))
    candidate = os.path.join(ROOT, norm.replace('/', os.sep))
    if os.path.isdir(candidate):
        return candidate
    return os.path.join(ROOT, 'results', run_dir)


def collect_run(benchmark, side, replicate, req, run_dir):
    """读一轮产物的全部指标。run_dir 可以是目录名，也可以是相对 results/ 的路径。"""
    d = resolve_run(run_dir)
    ws = os.path.join(d, 'workspace')
    diff = load_json(os.path.join(d, 'diff.json'))
    summary = load_json(os.path.join(d, 'summary.json'))
    guard = load_json(os.path.join(d, 'guard.json'))
    verification = load_json(os.path.join(d, 'verification.json'))
    acceptance = load_json(os.path.join(d, 'acceptance.json'))
    files = [f['path'] for f in diff.get('files', [])]
    usage = summary.get('usage', {})
    api = guard.get('api', {})
    return {
        'side': side,
        'replicate': replicate,
        'round': req,
        'label': '%s_%s^%d' % (side, req[1:], replicate),
        'run': run_dir,
        'workspace': ws,
        'filesChanged': diff.get('filesChanged', 0),
        'linesAdded': diff.get('linesAdded', 0),
        'linesDeleted': diff.get('linesDeleted', 0),
        'packages': len(packages_touched(ws, files)),
        'packageList': packages_touched(ws, files),
        'requests': summary.get('requests', 0),
        'toolCalls': summary.get('toolCalls', 0),
        'wallTimeSeconds': summary.get('wallTimeSeconds', 0),
        'inputTokens': usage.get('input', 0),
        'outputTokens': usage.get('output', 0),
        'cacheReadTokens': usage.get('cacheRead', 0),
        'totalTokens': usage.get('totalTokens', 0),
        'costUsd': summary.get('cost', {}).get('total', 0),
        'guardValid': guard.get('valid'),
        'changedSignatures': len(api.get('changedSignatures', [])),
        'removedMethods': api.get('removedMethods', 0),
        'addedMethods': api.get('addedMethods', 0),
        'verifyStatus': verification.get('status'),
        'verifyTests': verification.get('tests', 0),
        'verifyFailures': verification.get('failures', 0),
        'acceptStatus': acceptance.get('status'),
        'acceptTests': acceptance.get('tests', 0),
        'acceptFailures': acceptance.get('failures', 0),
    }


def paired_stats(values, lower_is_better=True):
    """对一个指标做配对统计。values 是 (重复序号, A 值, B 值) 的列表。"""
    diffs = [b - a for _, a, b in values]
    if not diffs:
        return None
    wins = sum(1 for d in diffs if (d < 0 if lower_is_better else d > 0))
    return {
        'pairs': len(diffs),
        'medianDiff': median(diffs),
        'minDiff': min(diffs),
        'maxDiff': max(diffs),
        'bBetter': wins,
        'bBetterRatio': round(wins / len(diffs), 4),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--benchmark', default='bookkeeping')
    parser.add_argument('--json', help='把完整结果写成 JSON')
    parser.add_argument('--include-partial', action='store_true',
                        help='把尚未跑完的链也算进来（仅用于跑批期间查看进度）')
    parser.add_argument('--quiet', action='store_true')
    args = parser.parse_args()

    chains = collect_chains(args.benchmark, args.include_partial)
    if not chains:
        print('没有可用的链数据')
        return

    # 逐轮收集指标
    runs = []
    for (side, replicate), chain in sorted(chains.items()):
        for req in ROUNDS:
            if req not in chain['rounds']:
                continue
            runs.append(collect_run(args.benchmark, side, replicate, req, chain['rounds'][req]))

    # 起点：每条链自己声明的 base（B 链是 B_0 的工作副本，不是它的第一轮产物）
    baselines = {}
    for (side, replicate), chain in sorted(chains.items()):
        base = chain.get('base')
        if base:
            baselines[(side, replicate)] = resolve_run(base)
    if not any(side == 'A' for side, _ in baselines):
        baselines[('A', 1)] = os.path.join(ROOT, 'benchmarks', args.benchmark, 'source')

    struct = {}
    a0 = baselines.get(('A', 1)) or os.path.join(ROOT, 'benchmarks', args.benchmark, 'source')
    struct['A_0'] = structure(a0, 'A_0')
    b0 = baselines.get(('B', 1))
    if b0:
        struct['B_0'] = structure(b0, 'B_0')
    for run in runs:
        key = '%s_%s^%d' % (run['side'], run['round'][1:], run['replicate'])
        struct[key] = structure(run['workspace'], key)

    # 按 (轮次, 侧) 聚合
    metrics = ['filesChanged', 'linesAdded', 'linesDeleted', 'packages',
               'requests', 'toolCalls', 'totalTokens', 'inputTokens', 'outputTokens',
               'cacheReadTokens', 'costUsd', 'wallTimeSeconds']
    struct_metrics = ['effective_multi_backend_rule_count', 'multi_backend_rule_count',
                      'duplication_count', 'layer_violation_count', 'package_edges',
                      'public_types', 'public_methods', 'files_main', 'cycle_count']
    STRUCT_METRICS = set(struct_metrics)

    def rows_for(req, side):
        return [r for r in runs if r['round'] == req and r['side'] == side]

    aggregate = {}
    for req in ROUNDS:
        for side in ('A', 'B'):
            rows = rows_for(req, side)
            if not rows:
                continue
            entry = {'samples': len(rows), 'replicates': sorted(r['replicate'] for r in rows)}
            for key in metrics:
                values = [r[key] for r in rows]
                entry[key] = median(values)
                entry[key + '_range'] = spread(values)
            for key in struct_metrics:
                values = [struct['%s_%s^%d' % (side, req[1:], r['replicate'])].get(key) for r in rows]
                entry[key] = median(values)
                entry[key + '_range'] = spread(values)
            aggregate['%s_%s' % (side, req)] = entry

    # 配对比较：同一个 (轮次, 重复序号) 内 A 与 B 相减
    by_key = {(r['side'], r['round'], r['replicate']): r for r in runs}

    def value_of(run, key):
        """运行级指标取自 run 记录；结构级指标取自该版本的结构快照。"""
        if key in STRUCT_METRICS:
            label = '%s_%s^%d' % (run['side'], run['round'][1:], run['replicate'])
            return struct.get(label, {}).get(key)
        return run.get(key)

    def pair_values(req, key):
        out = []
        for replicate in sorted({r['replicate'] for r in runs}):
            a = by_key.get(('A', req, replicate))
            b = by_key.get(('B', req, replicate))
            if not a or not b:
                continue
            av, bv = value_of(a, key), value_of(b, key)
            if av is None or bv is None:
                continue
            out.append((replicate, av, bv))
        return out

    paired = {}
    overall = {}
    for key in ['packages', 'filesChanged', 'linesAdded', 'totalTokens', 'requests',
                'effective_multi_backend_rule_count', 'multi_backend_rule_count',
                'duplication_count', 'layer_violation_count', 'package_edges']:
        all_pairs = []
        for req in ROUNDS:
            values = pair_values(req, key)
            if not values:
                continue
            all_pairs.extend(values)
            stats = paired_stats(values)
            if not stats:
                continue
            stats['details'] = [{'replicate': r, 'A': a, 'B': b, 'diff': b - a} for r, a, b in values]
            paired.setdefault(req, {})[key] = stats
        summary = paired_stats(all_pairs)
        if summary:
            overall[key] = summary

    # 累计成本：每条链逐轮累加
    cumulative = {}
    for side in ('A', 'B'):
        for replicate in sorted({r['replicate'] for r in runs}):
            chain = [r for r in runs if r['side'] == side and r['replicate'] == replicate]
            chain.sort(key=lambda r: ROUNDS.index(r['round']))
            acc = 0
            steps = []
            for r in chain:
                acc += r['totalTokens']
                steps.append({'round': r['round'], 'cumulativeTokens': acc})
            cumulative['%s^%d' % (side, replicate)] = {'steps': steps, 'totalTokens': acc}

    # 累计净变更：链的 base -> 最后一轮末
    net = {}
    for (side, replicate), chain in sorted(chains.items()):
        chain_runs = [r for r in runs if r['side'] == side and r['replicate'] == replicate]
        chain_runs.sort(key=lambda r: ROUNDS.index(r['round']))
        if not chain_runs:
            continue
        base = baselines.get((side, replicate))
        if not base:
            continue
        net['%s^%d' % (side, replicate)] = numstat_between(base, chain_runs[-1]['workspace'])

    payload = {
        'runs': runs,
        'aggregate': aggregate,
        'paired': paired,
        'overall': overall,
        'cumulative': cumulative,
        'netChanges': net,
        'structure': struct,
    }

    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=1)
        if not args.quiet:
            print('wrote %s' % args.json)
        return

    # 文本报告
    print('=' * 100)
    print('版本索引')
    print('=' * 100)
    for r in runs:
        print('  %-12s %-38s 守卫=%s 既有测试=%s/%s 验收=%s/%s'
              % (r['label'], r['run'], r['guardValid'], r['verifyTests'], r['verifyFailures'],
                 r['acceptTests'], r['acceptFailures']))

    print()
    print('=' * 100)
    print('槽位①  变更规模与影响面')
    print('=' * 100)
    print('%-6s%-6s%6s%12s%12s%12s%12s' % ('轮次', '侧', '样本', '文件数', '新增行', '删除行', '触及包数'))
    for req in ROUNDS:
        for side in ('A', 'B'):
            key = '%s_%s' % (side, req)
            if key not in aggregate:
                continue
            a = aggregate[key]
            print('%-6s%-6s%6d%12s%12s%12s%12s' % (
                req, side, a['samples'], a['filesChanged'], a['linesAdded'],
                a['linesDeleted'], a['packages']))

    print()
    print('=' * 100)
    print('槽位②  实现成本')
    print('=' * 100)
    print('%-6s%-6s%6s%10s%14s%14s%10s' % ('轮次', '侧', '样本', '请求', '总tok', '缓存tok', 'USD'))
    for req in ROUNDS:
        for side in ('A', 'B'):
            key = '%s_%s' % (side, req)
            if key not in aggregate:
                continue
            a = aggregate[key]
            print('%-6s%-6s%6d%10s%14s%14s%10s' % (
                req, side, a['samples'], a['requests'], a['totalTokens'],
                a['cacheReadTokens'], round(a['costUsd'], 4)))

    print()
    print('累计成本（每条链逐轮累加 token）：')
    for key, value in sorted(cumulative.items()):
        steps = '  '.join('%s=%s' % (s['round'], format(s['cumulativeTokens'], ',')) for s in value['steps'])
        print('  %-6s %s' % (key, steps))

    print()
    print('=' * 100)
    print('槽位③  架构劣化')
    print('=' * 100)
    print('%-12s%12s%12s%12s%12s%12s' % ('版本', '有效重复规则', '原始计数', '近重复对', '层级违规', '依赖边'))
    for key in [k for k in ('A_0', 'B_0') if k in struct] + sorted(k for k in struct if k not in ('A_0', 'B_0')):
        if key not in struct:
            continue
        s = struct[key]
        print('%-12s%12s%12s%12s%12s%12s' % (
            key, s.get('effective_multi_backend_rule_count'), s.get('multi_backend_rule_count'),
            s.get('duplication_count'), s.get('layer_violation_count'), s.get('package_edges')))

    print()
    print('累计净变更（链的 base -> 最后一轮末）：')
    for key, value in sorted(net.items()):
        print('  %-6s %d 文件, +%d, -%d' % (key, value['files'], value['added'], value['deleted']))

    print()
    print('=' * 100)
    print('配对比较（B 相对 A 的差值；负值 = B 更小）')
    print('=' * 100)
    for req in ROUNDS:
        if req not in paired:
            continue
        print('  %s' % req)
        for key, stats in paired[req].items():
            print('    %-34s 配对数=%d 中位差=%s 全距=[%s, %s] B 更优 %d/%d'
                  % (key, stats['pairs'], stats['medianDiff'], stats['minDiff'],
                     stats['maxDiff'], stats['bBetter'], stats['pairs']))

    print()
    print('=' * 100)
    print('总体配对汇总（全部 (轮次, 重复) 配对合并）')
    print('=' * 100)
    for key, stats in overall.items():
        print('  %-34s 配对数=%2d  中位差=%-12s 全距=[%s, %s]  B 更优 %d/%d (%.0f%%)'
              % (key, stats['pairs'], stats['medianDiff'], stats['minDiff'], stats['maxDiff'],
                 stats['bBetter'], stats['pairs'], stats['bBetterRatio'] * 100))


if __name__ == '__main__':
    main()
