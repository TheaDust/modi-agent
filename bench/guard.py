# -*- coding: utf-8 -*-
"""事后反作弊守卫：比较结果工作副本的基线提交与当前文件。

设计原则：只把高置信度违规判为 invalid；无法可靠判定的情况一律降为 warning，
避免把合法实现误杀。Java 项目之外（例如框架 smoke 测试）直接跳过。

用法：
    python bench/guard.py <workspace> --mode feature|optimize [--json guard.json]
退出码：0 = 有效/跳过，2 = 判为无效，1 = 工具内部错误。
"""
import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from difflib import unified_diff

PKG_RE = re.compile(r"^[ \t]*package\s+([\w.]+)\s*;", re.M)
TYPE_RE = re.compile(
    r"^[ \t]*(?P<mods>(?:(?:public|final|abstract|sealed|non-sealed)\s+)*)"
    r"(class|interface|enum|record|@interface)\s+(\w+)(?:<[^\n{]*>)?", re.M)
IMPORT_RE = re.compile(r"^[ \t]*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;", re.M)
PUBLIC_METHOD_RE = re.compile(
    r"\bpublic\s+(?:<[^>]+>\s*)?"
    r"(?:(?:final|static|synchronized|abstract|default|native|strictfp)\s+)*"
    r"([\w<>\[\].?,]+)\s+(\w+)\s*\(", re.M)
ASSERT_RE = re.compile(
    r"\b(?:assert\w*|expect\w*|should\w*|verify\w*|fail|assertThat|assertThatThrownBy|"
    r"isEqualTo|isTrue|isFalse|isNull|isNotNull|hasSize|containsExactly|matches)\s*\(")
FORBIDDEN_IMPORT_RE = re.compile(r"(?:^|\.)(dao|jdbc|memory|spring)(?:\.|$)")
BUSINESS_PACKAGES = {"model", "service", "validation", "report"}
SKIP_DIRS = {".git", "target", "node_modules", ".idea", ".vscode"}
PROTECTED_FILES = ("_tools/structure.py",)


def git(workspace, *args):
    result = subprocess.run(
        ["git", "-C", workspace, *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace", check=True)
    return result.stdout


def has_baseline(workspace):
    try:
        git(workspace, "rev-parse", "--verify", "HEAD")
        return True
    except (subprocess.CalledProcessError, OSError):
        return False


def head_files(workspace):
    return [p for p in git(workspace, "ls-tree", "-r", "--name-only", "HEAD").splitlines() if p]


def head_content(workspace, path):
    try:
        return git(workspace, "show", f"HEAD:{path}")
    except subprocess.CalledProcessError:
        return None


def disk_files(workspace):
    out = []
    for root, dirs, files in os.walk(workspace):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            full = os.path.join(root, name)
            out.append(os.path.relpath(full, workspace).replace("\\", "/"))
    return sorted(out)


def read_disk(workspace, path):
    full = os.path.join(workspace, path.replace("/", os.sep))
    try:
        with open(full, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return None


def strip_comments(src):
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def norm(text):
    text = re.sub(r"\s+", " ", text).strip()
    return re.sub(r"\s*([,\[\]<>?.])\s*", r"\1", text)


def balanced_params(src, open_index):
    depth, i = 0, open_index
    while i < len(src):
        if src[i] == "(":
            depth += 1
        elif src[i] == ")":
            depth -= 1
            if depth == 0:
                return src[open_index + 1:i]
        i += 1
    return src[open_index + 1:]


def brace_depth_at(src, index):
    """方法声明所在的大括号深度；1 = 顶层类型的方法，>=2 为内部类的方法。"""
    prefix = re.sub(r'"(?:\\.|[^"\\])*"', '""', src[:index])
    return prefix.count("{") - prefix.count("}")


def java_units(files, content_of):
    """path -> {pkg, types, public_types, imports, methods, supers}。

    只有 public 顶层类型及其直接声明的方法属于对外 API；
    package-private 类型与 private 内部类的方法不计入，否则会把合法重构误判为破坏性变更。
    """
    units = {}
    for path in files:
        if not path.endswith(".java"):
            continue
        src = content_of(path)
        if src is None:
            continue
        clean = strip_comments(src)
        pkg_match = PKG_RE.search(clean)
        pkg = pkg_match.group(1) if pkg_match else ""
        type_matches = list(TYPE_RE.finditer(clean))
        names = {m.group(3) for m in type_matches}
        types = {(pkg, name) for name in names}
        public_types = {
            (pkg, m.group(3)) for m in type_matches
            if "public" in m.group("mods").split()
        }
        imports = {m.group(1) for m in IMPORT_RE.finditer(clean)}
        parsed = re.sub(r"@\w+(?:\s*\([^)]*\))?", "", clean)
        methods = set()
        for m in PUBLIC_METHOD_RE.finditer(parsed):
            if brace_depth_at(parsed, m.start()) != 1:
                continue
            ret, name = m.group(1).strip(), m.group(2)
            if name in {"class", "interface", "enum", "record"} or ret in {"class", "interface", "enum", "record"}:
                continue
            params = norm(balanced_params(parsed, m.end() - 1))
            sig = "<init>(" + params + ")" if name in names else name + "(" + params + ")"
            methods.add((sig, norm(ret)))
        supers = []
        for match in re.finditer(
                r"\b(?:extends|implements)\s+([\w.]+(?:\s*,\s*[\w.]+)*)", clean):
            supers.extend(name.strip() for name in match.group(1).split(","))
        units[path] = {"pkg": pkg, "types": types, "public_types": public_types,
                       "imports": imports, "methods": methods, "supers": supers, "src": clean}
    return units


def resolve_supers(units):
    """把 extends/implements 的简单名解析到本代码库内的 public 类型。"""
    by_simple = defaultdict(list)
    for unit in units.values():
        for type_key in unit["types"]:
            by_simple[type_key[1]].append(type_key)
    resolved = {}
    for unit in units.values():
        for type_key in unit["types"]:
            parents = []
            for name in unit["supers"]:
                candidates = [key for key in by_simple.get(name.split(".")[-1], [])
                              if ".".join(key) == name or key == (unit["pkg"], name)
                              or any(imp == name or imp.endswith("." + name)
                                     for imp in unit["imports"])]
                if len(candidates) == 1:
                    parents.append(candidates[0])
            resolved[type_key] = parents
    return resolved


def effective_api(before_api, before_supers):
    """类型对外可见的方法 = 自身声明 + 从本代码库父类继承。"""
    cache = {}

    def visit(type_key, seen):
        if type_key in cache:
            return cache[type_key]
        if type_key in seen:
            return set()
        methods = set(before_api.get(type_key, ()))
        for parent in before_supers.get(type_key, ()):
            methods |= visit(parent, seen | {type_key})
        cache[type_key] = methods
        return methods

    return {key: visit(key, set()) for key in before_api}


def under(path, segment):
    return ("/" + path.replace("\\", "/")).find("/" + segment + "/") >= 0


def new_layer_dependencies(before, after):
    def pairs(units):
        out = set()
        for unit in units.values():
            if unit["pkg"].split(".")[-1] not in BUSINESS_PACKAGES:
                continue
            for imp in unit["imports"]:
                if FORBIDDEN_IMPORT_RE.search(imp):
                    out.add((unit["pkg"], imp))
        return out
    return sorted(pairs(after) - pairs(before))


def assertion_core(line):
    match = ASSERT_RE.search(line)
    return norm(line[match.start():]) if match else None


def assertion_changes(workspace, before_paths, after_paths):
    """返回 (violations, warnings)。只检查既有测试文件里被移除/改写的断言行。"""
    test_paths = sorted(p for p in (set(before_paths) | set(after_paths))
                        if under(p, "src/test") and p.endswith(".java"))
    violations, warnings = [], []
    per_file_added = {}
    all_added_assertions = set()
    for path in test_paths:
        after = read_disk(workspace, path)
        if after is None:
            continue
        added = [core for line in after.splitlines()
                 if (core := assertion_core(strip_comments(line)))]
        per_file_added[path] = added
        all_added_assertions.update(added)

    for path in test_paths:
        before = head_content(workspace, path)
        after = read_disk(workspace, path)
        if before is not None and after is None:
            violations.append({"rule": "test-file-deleted", "file": path,
                               "detail": "既有测试文件被删除"})
            continue
        if before is None or after is None:
            continue
        removed = []
        for line in unified_diff(before.splitlines(), after.splitlines(), lineterm="", n=0):
            if line.startswith("-") and not line.startswith("---"):
                stripped = line[1:].strip()
                if stripped and not stripped.startswith("//"):
                    core = assertion_core(strip_comments(stripped))
                    if core:
                        removed.append(core)
        if not removed:
            continue
        local = set(per_file_added.get(path, []))
        for line in removed:
            if line in local:
                continue
            # 行被折行/重排时按 token 多重集兜底，避免把纯格式化误判为改断言。
            if not Counter(re.findall(r"\w+", line)) - Counter(
                    token for added in all_added_assertions for token in re.findall(r"\w+", added)):
                continue
            violations.append({"rule": "test-assertion-changed", "file": path,
                               "detail": "既有断言行被移除或改写：" + line[:160]})
    return violations, warnings


def check(workspace, mode):
    result = {
        "workspace": workspace,
        "mode": mode,
        "status": "ok",
        "valid": True,
        "violations": [],
        "warnings": [],
        "api": {"addedTypes": [], "removedTypes": [], "addedMethods": 0, "removedMethods": 0},
    }
    if not os.path.isfile(os.path.join(workspace, "pom.xml")):
        result["status"] = "skipped"
        result["reason"] = "非 Java 项目，无需 Java 守卫"
        return result, 0
    if not has_baseline(workspace):
        result["status"] = "unavailable"
        result["warnings"].append("结果工作副本没有基线提交，守卫无法比对")
        return result, 0

    before_paths = head_files(workspace)
    after_paths = disk_files(workspace)
    before = java_units(before_paths, lambda p: head_content(workspace, p))
    after = java_units(after_paths, lambda p: read_disk(workspace, p))
    before_main = {p: unit for p, unit in before.items() if under(p, "src/main")}
    after_main = {p: unit for p, unit in after.items() if under(p, "src/main")}

    violations, warnings = assertion_changes(workspace, before_paths, after_paths)

    for protected in PROTECTED_FILES:
        if protected not in set(before_paths):
            continue
        if read_disk(workspace, protected) != head_content(workspace, protected):
            violations.append({"rule": "protected-file-changed", "file": protected,
                               "detail": "结构分析工具属于评测基线，不得改动"})

    if mode == "feature":
        before_types = {}
        after_types = {}
        for path, unit in before.items():
            if not under(path, "src/main"):
                continue
            for type_key in unit["types"]:
                before_types.setdefault(type_key, set()).add(path.split("/")[0])
        for path, unit in after.items():
            if not under(path, "src/main"):
                continue
            for type_key in unit["types"]:
                after_types.setdefault(type_key, set()).add(path.split("/")[0])
        for type_key, modules in sorted(before_types.items()):
            if type_key in after_types:
                if modules != after_types[type_key]:
                    violations.append({"rule": "class-moved", "file": type_key[1],
                                       "detail": "既有类跨模块移动：" + ".".join(type_key)})
                continue
            moved = any(key[1] == type_key[1] for key in after_types)
            rule = "class-renamed-or-moved" if moved else "class-deleted"
            violations.append({"rule": rule, "file": type_key[1],
                               "detail": "既有类消失：" + ".".join(type_key)})
        before_pkgs = {unit["pkg"] for unit in before.values() if unit["pkg"]}
        after_pkgs = {unit["pkg"] for unit in after.values() if unit["pkg"]}
        for pkg in sorted(before_pkgs - after_pkgs):
            warnings.append({"rule": "package-removed", "file": pkg,
                             "detail": "既有包已无 Java 文件，请人工确认是否仅为重组"})

    new_deps = new_layer_dependencies(before_main, after_main)
    for pkg, imp in new_deps:
        violations.append({"rule": "new-layer-dependency", "file": pkg,
                           "detail": f"业务包新增对持久化包的依赖：{pkg} -> {imp}"})

    before_api = defaultdict(set)
    after_api = defaultdict(set)
    for unit in before_main.values():
        for type_key in unit["public_types"]:
            before_api[type_key] |= unit["methods"]
    for unit in after_main.values():
        for type_key in unit["public_types"]:
            after_api[type_key] |= unit["methods"]
    before_api = effective_api(before_api, resolve_supers(before))
    after_api = effective_api(after_api, resolve_supers(after))
    for type_key in sorted(set(before_api) - set(after_api)):
        if not any(v["rule"] in {"class-moved", "class-renamed-or-moved", "class-deleted"}
                   and v["file"] == type_key[1] for v in violations):
            result["api"]["removedTypes"].append(".".join(type_key))
    for type_key in sorted(set(before_api) & set(after_api)):
        removed = before_api[type_key] - after_api[type_key]
        if removed:
            result["api"]["removedMethods"] += len(removed)
        added = after_api[type_key] - before_api[type_key]
        if added:
            result["api"]["addedMethods"] += len(added)
    for type_key in sorted(set(after_api) - set(before_api)):
        result["api"]["addedTypes"].append(".".join(type_key))
    for type_key, methods in sorted(before_api.items()):
        if type_key in after_api:
            continue
        if not methods:
            continue
        if any(v["rule"] in {"class-moved", "class-renamed-or-moved", "class-deleted"}
               and v["file"] == type_key[1] for v in violations):
            continue
        violations.append({"rule": "public-type-removed", "file": type_key[1],
                           "detail": "public 类型被删除：" + ".".join(type_key)})
    for type_key, methods in sorted(before_api.items()):
        if type_key not in after_api:
            continue
        for sig, ret in sorted(methods - after_api[type_key]):
            violations.append({"rule": "public-api-removed", "file": type_key[1],
                               "detail": f"public 方法签名消失：{'.'.join(type_key)}.{sig} : {ret}"})

    if mode == "feature":
        for path, unit in before.items():
            if not under(path, "src/main") or path not in after:
                continue
            old_count = len(unit["methods"])
            if old_count >= 6 and len(after[path]["methods"]) <= old_count * 0.5:
                warnings.append({"rule": "possible-class-split", "file": path,
                                 "detail": "public 方法数大幅减少，请人工确认是否拆分了既有类"})

    result["violations"] = violations
    result["warnings"] = warnings
    result["valid"] = not violations
    return result, (0 if result["valid"] else 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workspace")
    ap.add_argument("--mode", choices=("feature", "optimize"), default="feature")
    ap.add_argument("--json")
    args = ap.parse_args()
    result, code = check(args.workspace, args.mode)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
    status = "INVALID" if not result["valid"] else result["status"].upper()
    print(f"Guard: {status}; violations={len(result['violations'])}; warnings={len(result['warnings'])}")
    for violation in result["violations"][:10]:
        print(f"  [{violation['rule']}] {violation['detail']}")
    return code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001 - 工具自身失败不应被误读为通过
        print(f"Guard error: {error}", file=sys.stderr)
        sys.exit(1)
