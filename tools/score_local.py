# -*- coding: utf-8 -*-
"""就地给已克隆候选打分：规模 / 测试 / 外部依赖 / 分层气味。"""
import json, os, re

BASE = r"E:\my-works\coding\modi-agent\_candidates"
BAD = re.compile(r"mysql|postgresql|mariadb|mongodb|redis|redisson|mongo|cassandra|elasticsearch", re.I)


def java_files(root):
    out = []
    for dp, dn, fn in os.walk(root):
        dn[:] = [d for d in dn if d not in {".git", "target", "build", "node_modules", ".gradle"}]
        out += [os.path.join(dp, f) for f in fn if f.endswith(".java")]
    return out


rows = []
for name in sorted(os.listdir(BASE)):
    root = os.path.join(BASE, name)
    if not os.path.isdir(root):
        continue
    pom = os.path.join(root, "pom.xml")
    gradle = [g for g in ("build.gradle", "build.gradle.kts") if os.path.isfile(os.path.join(root, g))]
    jf = java_files(root)
    main = [f for f in jf if os.sep + "test" + os.sep not in f.lower()]
    tests = [f for f in jf if os.sep + "test" + os.sep in f.lower()]
    loc = 0
    for f in main:
        try:
            loc += sum(1 for _ in open(f, encoding="utf-8", errors="replace"))
        except Exception:
            pass
    ext = set()
    if os.path.isfile(pom):
        t = open(pom, encoding="utf-8", errors="replace").read()
        ext = {m.group(0).lower() for m in BAD.finditer(t)}
    # 包名（顶层业务包）分布
    pkgs = {}
    for f in main:
        rel = os.path.relpath(f, root).replace("\\", "/")
        parts = rel.split("/")
        key = "/".join(parts[:2]) if parts[0] in ("src",) and len(parts) > 2 else parts[0]
        pkgs[key] = pkgs.get(key, 0) + 1
    top = sorted(pkgs.items(), key=lambda kv: -kv[1])[:6]
    rows.append({
        "repo": name, "build": "maven" if os.path.isfile(pom) else ("gradle" if gradle else "?"),
        "main": len(main), "test": len(tests), "loc": loc,
        "ext": ",".join(sorted(ext)) or "-",
        "pkgs": " ".join("%s(%d)" % kv for kv in top),
    })

rows.sort(key=lambda r: -r["main"])
print("%-46s %-7s %5s %5s %7s  %-22s %s" % ("repo", "build", "main", "test", "loc", "external-deps", "top-pkgs"))
for r in rows:
    print("%-46s %-7s %5d %5d %7d  %-22s %s" %
          (r["repo"][:46], r["build"], r["main"], r["test"], r["loc"], r["ext"][:22], r["pkgs"]))
