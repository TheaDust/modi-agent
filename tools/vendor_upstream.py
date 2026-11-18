# -*- coding: utf-8 -*-
"""把记账候选固化到 benchmarks/bookkeeping/source/，并记录 provenance。"""
import json, os, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, ".cache", "candidates", "imetaxas__double-entry-bookkeeping-api")
BENCHMARK = os.path.join(ROOT, "benchmarks", "bookkeeping")
DST = os.path.join(BENCHMARK, "source")
SKIP_DIRS = {".git", "target", ".idea", ".vscode", "build", ".gradle", "__pycache__"}
SKIP_EXT = {".class", ".jar", ".war"}


def ignored(name):
    return name in SKIP_DIRS or os.path.splitext(name)[1] in SKIP_EXT


copied = 0
for dp, dn, fn in os.walk(SRC):
    rel = os.path.relpath(dp, SRC)
    out = DST if rel == "." else os.path.join(DST, rel)
    dn[:] = [d for d in dn if not ignored(d)]
    os.makedirs(out, exist_ok=True)
    for f in fn:
        if ignored(f):
            continue
        shutil.copy2(os.path.join(dp, f), os.path.join(out, f))
        copied += 1

sha = subprocess.run(["git", "-C", SRC, "rev-parse", "HEAD"], capture_output=True,
                     text=True, encoding="utf-8").stdout.strip()
meta = subprocess.run(["git", "-C", SRC, "log", "-1", "--format=%an|%ae|%ad|%s"],
                      capture_output=True, text=True, encoding="utf-8").stdout.strip()
lic = ""
for name in ("LICENSE", "LICENSE.txt", "COPYING"):
    p = os.path.join(SRC, name)
    if os.path.isfile(p):
        lic = open(p, encoding="utf-8", errors="replace").read().splitlines()[0]
        break

print("copied files:", copied)
print("upstream sha:", sha)
print("upstream meta:", meta)
print("license:", lic)

info = {
    "repo": "https://github.com/imetaxas/double-entry-bookkeeping-api",
    "sha": sha,
    "meta": meta,
    "license": lic,
    "vendored_at": subprocess.run(["git", "-C", ROOT, "rev-parse", "--abbrev-ref", "HEAD"],
                                  capture_output=True, text=True, encoding="utf-8").stdout.strip(),
}
os.makedirs(BENCHMARK, exist_ok=True)
with open(os.path.join(BENCHMARK, "provenance.json"), "w", encoding="utf-8") as fh:
    json.dump(info, fh, ensure_ascii=False, indent=2)
print("provenance written")
