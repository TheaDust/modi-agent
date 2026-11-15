# -*- coding: utf-8 -*-
"""探测可用 LLM 端点：普通对话 + tool calling 能力。密钥从 opencode.json 读取，不落盘打印。"""
import json, os, urllib.request, urllib.error

CFG = os.path.expanduser(r"~\.config\opencode\opencode.json")
cfg = json.load(open(CFG, encoding="utf-8"))
prov = cfg["provider"]["hohai"]
base = prov["options"]["baseURL"].rstrip("/")
key = prov["options"]["apiKey"]
model = "claude-opus-5-5"


def post(path, payload, timeout=120):
    req = urllib.request.Request(
        base + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key,
                 "User-Agent": "modi-agent"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:600]
    except Exception as e:
        return -1, str(e)[:400]


print("== 1) models ==")
st, body = post("/models", {}, 30) if False else (None, None)
req = urllib.request.Request(base + "/models", headers={"Authorization": "Bearer " + key})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        ids = [m.get("id") for m in json.loads(r.read().decode()).get("data", [])]
        print("   available models:", ids)
except Exception as e:
    print("   /models failed:", str(e)[:200])

print("== 2) plain chat ==")
st, body = post("/chat/completions", {
    "model": model, "max_tokens": 64,
    "messages": [{"role": "user", "content": "只回答两个字：就绪"}],
})
print("   status:", st)
if st == 200:
    print("   content:", body["choices"][0]["message"].get("content"))
    print("   usage:", body.get("usage"))
else:
    print("   body:", body)

print("== 3) tool calling ==")
tools = [{
    "type": "function",
    "function": {
        "name": "read_file",
        "description": "读取项目中的一个文件",
        "parameters": {"type": "object",
                       "properties": {"path": {"type": "string", "description": "文件路径"}},
                       "required": ["path"]},
    },
}]
st, body = post("/chat/completions", {
    "model": model, "max_tokens": 512, "tools": tools, "tool_choice": "auto",
    "messages": [{"role": "user", "content": "请读取 pom.xml 这个文件。"}],
})
print("   status:", st)
if st == 200:
    msg = body["choices"][0]["message"]
    print("   tool_calls:", json.dumps(msg.get("tool_calls"), ensure_ascii=False)[:400])
    print("   content:", (msg.get("content") or "")[:200])
    print("   usage:", body.get("usage"))
else:
    print("   body:", body)
