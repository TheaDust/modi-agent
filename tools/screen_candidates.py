# -*- coding: utf-8 -*-
"""批量筛选可作为「项目 A」的候选：Maven 构建 + 测试零外部依赖 + 规模适中。"""
import json, os, re, subprocess, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.join(ROOT, ".cache", "candidates")
HDRS = {"User-Agent": "modi-agent", "Accept": "application/vnd.github+json"}
QUERIES = [
    '"jdbc:h2" in:readme spring-boot language:Java stars:20..600 pushed:>2025-01-01',
    'topic:spring-boot language:Java stars:30..500 pushed:>2025-06-01 size:<500',
    'spring-boot hsqldb OR derby in:readme language:Java stars:20..400 pushed:>2025-01-01',
]
BAD_DEP = re.compile(r"mysql|postgresql|mariadb|mongodb|redis|redisson|mongo|cassandra|elasticsearch|clickhouse", re.I)
GOOD_LIC = {"mit", "apache-2.0", "bsd-2-clause", "bsd-3-clause", "isc", "mpl-2.0", "epl-2.0"}


def search(q):
    url = "https://api.github.com/search/repositories?q=%s&sort=stars&order=desc&per_page=40" % urllib.parse.quote(q)
    req = urllib.request.Request(url, headers=HDRS)
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.load(r).get("items", [])


def java_files(root):
    out = []
    for dp, dn, fn in os.walk(root):
        dn[:] = [d for d in dn if d not in {".git", "target", "build", "node_modules", ".gradle"}]
        for f in fn:
            if f.endswith(".java"):
                out.append(os.path.join(dp, f))
    return out


def score(root):
    """返回 (ok, info)。"""
    pom = os.path.join(root, "pom.xml")
    if not os.path.isfile(pom):
        return False, {"why": "no pom.xml (gradle/project)"}
    pomtxt = open(pom, encoding="utf-8", errors="replace").read()
    # 依赖里出现外部数据库/中间件 -> 判出局
    if BAD_DEP.search(pomtxt):
        bad = sorted(set(m.group(0).lower() for m in BAD_DEP.finditer(pomtxt)))
        return False, {"why": "external deps: %s" % ",".join(bad)}
    jf = java_files(root)
    main = [f for f in jf if os.sep + "test" + os.sep not in f.lower()]
    tests = [f for f in jf if os.sep + "test" + os.sep in f.lower()]
    nmain, ntest = len(main), len(tests)
    loc = 0
    for f in main:
        try:
            loc += sum(1 for _ in open(f, encoding="utf-8", errors="replace"))
        except Exception:
            pass
    return True, {
        "main": nmain, "test": ntest, "loc": loc,
        "hasH2": bool(re.search(r"<artifactId>h2</artifactId>", pomtxt, re.I)),
        "hasJunit": bool(re.search(r"spring-boot-starter-test|junit", pomtxt, re.I)),
        "modules": len(re.findall(r"<module>", pomtxt)),
    }


def main():
    seen, cands = set(), []
    for q in QUERIES:
        try:
            for it in search(q):
                fn = it["full_name"]
                if fn in seen:
                    continue
                seen.add(fn)
                cands.append(it)
        except Exception as e:
            print("SEARCH FAIL", q, e, flush=True)
        time.sleep(7)

    # 预筛：java + 体积适中（license 只记录不拦截，中文项目常无 license）
    pre = []
    for it in cands:
        if it.get("language") != "Java":
            continue
        if (it.get("size") or 0) > 1500:      # repo KB
            continue
        pre.append(it)
    print("pre-filtered: %d / %d" % (len(pre), len(cands)), flush=True)

    # 已克隆的先就地评分，不重复 clone
    results = []
    for it in pre[:60]:
        name = it["full_name"]
        dst = os.path.join(BASE, name.replace("/", "__"))
        if not os.path.isdir(dst):
            r = subprocess.run(["git", "clone", "--depth", "1", "--quiet",
                                "https://github.com/%s.git" % name, dst],
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
            if r.returncode != 0:
                continue
        ok, info = score(dst)
        info.update({"repo": name, "stars": it["stargazers_count"],
                     "license": (it.get("license") or {}).get("spdx_id"),
                     "desc": (it.get("description") or "")[:90]})
        results.append({"ok": ok, **info})
        print(("PASS " if ok else "DROP ") + name + " " + json.dumps(info, ensure_ascii=False), flush=True)

    print("\n===== 合格候选（按 main 文件数排序） =====", flush=True)
    good = [r for r in results if r.get("ok")]
    for r in sorted(good, key=lambda x: -x["main"]):
        print("%-45s main=%-4d test=%-3d loc=%-6d H2=%-5s stars=%-5d %s" %
              (r["repo"], r["main"], r["test"], r["loc"], r["hasH2"], r["stars"], r["license"]), flush=True)
    json.dump(results, open(os.path.join(BASE, "screen_result.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
