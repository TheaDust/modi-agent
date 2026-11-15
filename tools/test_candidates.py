# -*- coding: utf-8 -*-
"""对 Maven 候选逐个真跑 mvn test，记录是否零外部服务即可通过。"""
import os, re, subprocess, sys, time

BASE = r"E:\my-works\coding\modi-agent\_candidates"
TARGETS = [
    "imetaxas__double-entry-bookkeeping-api",
    "yanndemel__crud-rest-gen",
    "lmxdawn__vue-admin-java",
    "Morteza363831__spring-boot-chat-messenger",
    "guto-alves__loterias-api",
    "jcalvopinam__example-envers",
    "xsreality__spring-modulith-with-ddd",
    "liyupi__literature-assistant",
]

for name in TARGETS:
    root = os.path.join(BASE, name)
    if not os.path.isdir(root) or not os.path.isfile(os.path.join(root, "pom.xml")):
        print("SKIP %s (no pom)" % name, flush=True)
        continue
    t0 = time.time()
    env = dict(os.environ, MAVEN_OPTS="-Xmx1g", JAVA_TOOL_OPTIONS="-Dfile.encoding=UTF-8")
    mvn = r"D:\Tools\apache-maven-3.9.14\bin\mvn.cmd"
    try:
        r = subprocess.run([mvn, "-B", "-Dfile.encoding=UTF-8", "test"],
                           cwd=root, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=1500, env=env)
        out = r.stdout + "\n" + r.stderr
        code = r.returncode
    except subprocess.TimeoutExpired:
        out, code = "", -1
    dur = time.time() - t0

    # 只统计 per-class 明细行（含 "-- in "），避免与模块汇总行重复计数
    tests = re.findall(r"Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)[^\n]*-- in ", out)
    tot = sum(int(t[0]) for t in tests)
    fail = sum(int(t[1]) for t in tests)
    err = sum(int(t[2]) for t in tests)
    verdict = "PASS" if code == 0 else ("TIMEOUT" if code == -1 else "FAIL")
    print("%-45s %-8s exit=%-4s tests=%-4s fail=%-3s err=%-3s  %.0fs" %
          (name, verdict, code, tot, fail, err, dur), flush=True)
    if code != 0:
        errs = [l.strip() for l in out.splitlines()
                if re.search(r"ERROR|Caused by|Could not resolve|Connection refused|UnknownHost", l)]
        for l in errs[:8]:
            print("      | " + l[:170], flush=True)
    # 记录可复用日志
    logdir = os.path.join(BASE, "_buildlogs")
    os.makedirs(logdir, exist_ok=True)
    open(os.path.join(logdir, name + ".log"), "w", encoding="utf-8").write(out)
    time.sleep(2)
