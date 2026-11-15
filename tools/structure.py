# -*- coding: utf-8 -*-
"""架构结构分析器：包依赖图、循环依赖、层级违规、跨模块重复实现、public API 面积。

用法：
    python tools/structure.py projectA                 # 分析并打印
    python tools/structure.py projectA --json out.json # 同时导出 JSON（用于前后对比）
"""
import argparse, json, os, re, sys
from collections import defaultdict

# ---------------------------------------------------------------- 解析

PKG_RE = re.compile(r"^\s*package\s+([\w.]+)\s*;", re.M)
IMPORT_RE = re.compile(r"^\s*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;", re.M)
PUBLIC_TYPE_RE = re.compile(r"^\s*public\s+(?:final\s+|abstract\s+|sealed\s+)?"
                            r"(?:class|interface|enum|record)\s+(\w+)", re.M)
PUBLIC_METHOD_RE = re.compile(
    r"^\s{2,}public\s+(?!class|interface|enum|record|static\s*\{)"
    r"(?:(?:final|static|synchronized|abstract|default)\s+)*"
    r"([\w<>\[\],.\s?]+?)\s+(\w+)\s*\(", re.M)
MODIFIERS_RE = re.compile(r"^\s*(?:public|protected|private)\s+", re.M)


def read_java(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read()


def strip_comments(src):
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def collect(root):
    """返回 (files, modules) —— files: {relpath: (package, imports, src)}"""
    files, modules = {}, set()
    for dp, dn, fn in os.walk(root):
        dn[:] = [d for d in dn if d not in {".git", "target", ".idea", ".vscode"}]
        for f in fn:
            if not f.endswith(".java"):
                continue
            full = os.path.join(dp, f)
            rel = os.path.relpath(full, root).replace("\\", "/")
            src = read_java(full)
            pkg = (PKG_RE.search(src).group(1) if PKG_RE.search(src)
                   else rel.split("/src/main/java/")[0].split("/")[-1])
            imports = set(IMPORT_RE.findall(src))
            files[rel] = {"pkg": pkg, "imports": imports, "src": src,
                          "module": rel.split("/")[0]}
            modules.add(rel.split("/")[0])
    return files, modules


# ---------------------------------------------------------------- 依赖图

def package_of(imp, files):
    """把 import 解析到最接近的已知包（处理 import a.b.c.Class 与 import a.b.*）。"""
    if imp.endswith(".*"):
        imp = imp[:-2]
    best = None
    for p in {f["pkg"] for f in files.values()}:
        if imp == p or imp.startswith(p + "."):
            if best is None or len(p) > len(best):
                best = p
    if best:
        return best
    # 静态 import a.b.c.Class.member -> 回退到 a.b.c
    parts = imp.split(".")
    for i in range(len(parts) - 1, 0, -1):
        cand = ".".join(parts[:i])
        if cand in {f["pkg"] for f in files.values()}:
            return cand
    return None


def build_graph(files):
    """返回 package -> set(package)。同时记录模块级依赖。"""
    known = {f["pkg"] for f in files.values()}
    g = defaultdict(set)
    mods = defaultdict(set)
    for f in files.values():
        for imp in f["imports"]:
            tgt = package_of(imp, files)
            if tgt and tgt != f["pkg"]:
                g[f["pkg"]].add(tgt)
    for f in files.values():
        for tgt in g.get(f["pkg"], ()):  # 模块级
            if f["module"] != tgt.split(".")[0] and not tgt.startswith(f["module"]):
                mods[f["module"]].add(tgt.split(".")[0])
    return g, mods


def find_cycles(graph):
    """Tarjan 强连通分量（大小>1 或自环）= 循环依赖。"""
    index, low, stack, on, idx = {}, {}, [], set(), [0]
    cycles = []

    def strong(v):
        index[v] = low[v] = idx[0]
        idx[0] += 1
        stack.append(v)
        on.add(v)
        for w in graph.get(v, ()):
            if w not in index:
                strong(w)
                low[v] = min(low[v], low[w])
            elif w in on:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            comp = []
            while True:
                w = stack.pop()
                on.discard(w)
                comp.append(w)
                if w == v:
                    break
            if len(comp) > 1 or v in graph.get(v, ()):
                cycles.append(sorted(comp))

    for v in list(graph):
        if v not in index:
            strong(v)
    return cycles


# ---------------------------------------------------------------- 层级

# 领域核心不应依赖持久化/DAO；Web 层不应含业务规则
DOMAIN_FORBIDDEN = {"dao", "jdbc", "memory", "spring"}


def layer_violations(files):
    """包名末段落在 forbidden 集合且被 'model'/'service'/'validation' 依赖 -> 层级违规。"""
    out = []
    for f in files.values():
        leaf = f["pkg"].split(".")[-1]
        owner = f["pkg"].rsplit(".", 1)[0] if "." in f["pkg"] else ""
        # 业务包 = 包名最后一段
        top = f["pkg"].split(".")[-1]
        if top in ("model", "service", "validation", "report"):
            for imp in f["imports"]:
                tgt = package_of(imp, files)
                if tgt and tgt.split(".")[-1] in DOMAIN_FORBIDDEN:
                    out.append({"file": f["pkg"], "imports": tgt})
                    break
    return out


# ---------------------------------------------------------------- 重复实现

METHOD_RE = re.compile(
    r"(?:^|\n)\s{2,}(?:public|protected|private)\s+(?:(?:final|static|synchronized|abstract|default)\s+)*"
    r"([\w<>\[\],.\s?]+?)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws [\w.,\s]+)?\{", re.M)


def methods_of(src):
    out = []
    clean = strip_comments(src)
    for m in METHOD_RE.finditer(clean):
        ret, name, params = m.group(1).strip(), m.group(2), m.group(3).strip()
        # 取方法体
        start = clean.find("{", m.start())
        depth, i = 0, start
        while i < len(clean):
            if clean[i] == "{":
                depth += 1
            elif clean[i] == "}":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        body = clean[start:i + 1]
        toks = re.findall(r"[A-Za-z_][A-Za-z0-9_]*", body)
        out.append({"name": name, "params": params, "tokens": toks,
                    "loc": body.count("\n") + 1})
    return out


def duplication(files, min_tokens=12, include_tests=False):
    """跨模块同名方法体 token 的 Jaccard 相似度。

    min_tokens 过滤掉 trivial getter（3~5 个 token 的方法体相似度恒为 1.0，是噪声）。
    """
    by_mod = defaultdict(dict)
    for rel, f in files.items():
        if not include_tests and "/src/test/" in rel:
            continue
        for m in methods_of(f["src"]):
            if len(m["tokens"]) < min_tokens:
                continue
            key = (m["name"], m["params"].count(",") + 1 if m["params"] else 0)
            by_mod[f["module"]].setdefault(key, []).append((rel, m))
    mods = sorted(by_mod)
    pairs = []
    for i in range(len(mods)):
        for j in range(i + 1, len(mods)):
            a, b = mods[i], mods[j]
            for key in set(by_mod[a]) & set(by_mod[b]):
                best = (0.0, None, None)
                for ra, ma in by_mod[a][key]:
                    ta = set(ma["tokens"])
                    if not ta:
                        continue
                    for rb, mb in by_mod[b][key]:
                        tb = set(mb["tokens"])
                        if not tb:
                            continue
                        sim = len(ta & tb) / len(ta | tb)
                        if sim > best[0]:
                            best = (sim, (ra, ma), (rb, mb))
                if best[0] >= 0.45 and best[1] and best[2]:
                    pairs.append({
                        "method": key[0], "arity": key[1],
                        "module_a": a, "file_a": best[1][0],
                        "module_b": b, "file_b": best[2][0],
                        "similarity": round(best[0], 3),
                        "loc_a": best[1][1]["loc"], "loc_b": best[2][1]["loc"],
                    })
    pairs.sort(key=lambda d: -d["similarity"])
    return pairs


# ------------------------------------------------- 多后端业务规则（可修改性成本驱动）

BACKEND_MARKERS = ("memory", "jdbc")


def multi_backend_rules(files):
    """同一业务规则被多个存储后端各自实现一次。

    与 token 相似度无关：内存版用 Map、JDBC 版用 SQL，代码写法必然不同，
    但「一条规则要改两处」的成本是真实的，且两处写法不同更容易静默分叉。
    """
    impl = defaultdict(lambda: defaultdict(set))   # method -> backend -> {file}
    for rel, f in files.items():
        if "/src/test/" in rel:
            continue
        parts = f["pkg"].split(".")
        backend = next((p for p in parts if p in BACKEND_MARKERS), None)
        if not backend:
            continue
        for m in methods_of(f["src"]):
            impl[m["name"]][backend].add(rel)
    out = []
    for name, backends in impl.items():
        if len(backends) >= 2:
            out.append({
                "method": name,
                "backends": {b: sorted(v) for b, v in backends.items()},
                "backend_count": len(backends),
            })
    out.sort(key=lambda d: (-d["backend_count"], d["method"]))
    return out


# ---------------------------------------------------------------- API 面积

def api_surface(files):
    classes = set()
    methods = 0
    for f in files.values():
        clean = strip_comments(f["src"])
        for m in PUBLIC_TYPE_RE.finditer(clean):
            classes.add((f["pkg"], m.group(1)))
        methods += len(PUBLIC_METHOD_RE.findall(clean))
    return len(classes), methods


# ---------------------------------------------------------------- 主流程

def analyze(root):
    files, modules = collect(root)
    graph, mod_graph = build_graph(files)
    cycles = find_cycles(graph)
    viol = layer_violations(files)
    dup = duplication(files)
    mbr = multi_backend_rules(files)
    n_cls, n_meth = api_surface(files)
    main = {r: f for r, f in files.items() if "/src/test/" not in r}
    return {
        "root": root,
        "files_total": len(files),
        "files_main": len(main),
        "modules": sorted(modules),
        "packages": len(graph),
        "package_edges": sum(len(v) for v in graph.values()),
        "cycles": cycles,
        "cycle_count": len(cycles),
        "layer_violations": viol,
        "layer_violation_count": len(viol),
        "duplication": dup,
        "duplication_count": len(dup),
        "multi_backend_rules": mbr,
        "multi_backend_rule_count": len(mbr),
        "public_types": n_cls,
        "public_methods": n_meth,
        "graph": {k: sorted(v) for k, v in sorted(graph.items())},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--json")
    args = ap.parse_args()
    r = analyze(args.root)

    print("=" * 68)
    print("架构结构分析:", r["root"])
    print("=" * 68)
    print("模块        :", ", ".join(r["modules"]))
    print("文件(主/总) : %d / %d" % (r["files_main"], r["files_total"]))
    print("包 / 包间依赖边 : %d / %d" % (r["packages"], r["package_edges"]))
    print("循环依赖    : %d  %s" % (r["cycle_count"],
                                    [c for c in r["cycles"][:5]]))
    print("层级违规    : %d" % r["layer_violation_count"])
    for v in r["layer_violations"][:8]:
        print("    %s -> %s" % (v["file"], v["imports"]))
    print("跨模块重复实现 : %d" % r["duplication_count"])
    for d in r["duplication"][:12]:
        print("    %-22s %s(%.0f LOC) <-> %s(%.0f LOC)  sim=%.2f" %
              (d["method"], d["file_a"], d["loc_a"], d["file_b"], d["loc_b"],
               d["similarity"]))
    print("public 类型 / 方法 : %d / %d" % (r["public_types"], r["public_methods"]))
    print("多后端重复实现的业务规则 : %d" % r["multi_backend_rule_count"])
    for d in r["multi_backend_rules"]:
        locs = ", ".join("%s:%d处" % (b, len(fs)) for b, fs in sorted(d["backends"].items()))
        print("    %-28s %s" % (d["method"], locs))

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(r, fh, ensure_ascii=False, indent=2)
        print("\nJSON ->", args.json)


if __name__ == "__main__":
    main()
