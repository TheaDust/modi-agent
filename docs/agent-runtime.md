# Agent 运行框架

## 本机依赖和模型配置

运行环境为 Node.js 24+，直接加载本机已有的 `@earendil-works/pi-coding-agent` **1.2.0**。
本项目没有需要安装的 npm 依赖。`.env` 的 `PI_SDK_PATH` 指向 SDK 包目录；
该包自带的传递依赖由其原安装位置解析。SDK 版本不匹配时，入口会明确报错。

当前本机 `.env` 已创建。更换机器时先复制 `.env.example` 为 `.env`。
填写以下模型连接项：

```dotenv
LLM_API=openai-completions
LLM_BASE_URL=https://your-endpoint.example/v1
LLM_MODEL=your-model-id
LLM_API_KEY=your-key
```

`LLM_API` 对应 Pi 的 API 协议：`openai-completions`、`anthropic-messages` 或 `openai-responses`。
基础地址应填写对应协议的入口；不要加 `/chat/completions` 等具体方法路径。
本轮已用模拟端点验证 `openai-completions`；其他协议使用 SDK 原生适配器，真实连通性需在填入配置后验证。

其余参数也在 `.env` 中：上下文窗口、单次输出上限、采样温度、思考等级、每轮请求数上限和运行超时。
这些值应与所用模型能力一致；服务端是否接受或忽略参数仍由具体模型决定。

`.env` 已加入 Git 忽略。运行配置快照只保存“是否设置密钥”，不会保存密钥值；
运行前也会从子进程环境中移除 `LLM_API_KEY`。密钥不会写入 Pi 的持久凭证配置。

## 运行入口

以下命令从仓库根目录执行：

```powershell
# 本地 SDK 与配置检查，不调用模型；连接项缺失时退出码为 1
npm run agent:check

# 本地模拟 API：真实调用 Pi 的读、写、编辑和 PowerShell 工具，不消耗模型额度
npm run agent:smoke

# 首次真实模型运行：只读检查基准项目
npm run agent -- --benchmark bookkeeping --mode inspect --prompt "阅读 pom.xml 并说明主要模块。"

# 第二个基准项目
npm run agent -- --benchmark cron-utils --mode inspect

# 架构优化任务由你指定
npm run agent -- --benchmark bookkeeping --mode optimize --prompt-file tasks/optimize-bookkeeping.md

# 实现 R1，仅传入「给智能体的需求」区块
npm run agent -- --benchmark bookkeeping --mode feature --requirement R1

# 从前一轮成果开始：仍复制到一个新工作区，每次新建会话
npm run agent -- --benchmark bookkeeping --mode feature --requirement R2 --from results/PREVIOUS_RUN/workspace
```

`--prompt`、`--prompt-file` 和 `--requirement` 三者互斥。
`--prompt-file` 为你准备的任务文件，上面的 `tasks/optimize-bookkeeping.md` 是路径示例。
不指定任务时，只有 inspect 模式提供默认检查任务；optimize 和 feature 模式必须给出明确任务。

## 行为与产物

每次运行将起点源码复制到 `results/<run-id>/workspace/`，跳过 `.git`、`target` 和 `node_modules`。
默认起点是案例的固化 `source/`；`--from` 可指定优化版或前一需求轮次的源码。
不复制选型报告、需求分析说明或其他组的运行历史。

| 模式 | 工具 |
|---|---|
| inspect | read、grep、find、ls |
| optimize / feature | 上述工具及 edit、write、powershell |

文件工具检查目标是否位于当前工作副本内，包含真实路径检查。
PowerShell 以当前副本为工作目录，具有本机进程权限；当前实现不提供操作系统级隔离。
正式隔离实验需另外配置进程环境和访问边界。

各运行显式使用独立内存会话、固定提示词和工具集合，不加载用户级技能、扩展、项目指令文件或历史会话。
自动上下文压缩、自动重试和缓存保温关闭；超出上下文后按失败记录。
工具顺序执行。每次模型请求计入请求预算；运行超时或 Ctrl+C 会中止当前调用。

运行目录包含：

| 文件 | 内容 |
|---|---|
| `run.json` | 案例、起点路径、上游来源记录和任务摘要哈希 |
| `config.json` | 模型与预算、SDK 版本、启用工具和控制策略 |
| `prompt.md` / `system-prompt.md` | 实际任务和系统提示词 |
| `before.json` | 起点文件内容 SHA-256 清单 |
| `events.jsonl` | 完成消息、工具调用结果和生命周期事件；不保存逐 token 增量事件 |
| `answer.md` | 最后一条助手消息的文本 |
| `summary.json` | 请求数、工具数及错误数、token、墙钟时间和终止状态 |
| `changes.json` | 变更文件及运行结束后的文件哈希 |
| `workspace/` | 本轮工作副本 |

运行状态包括 `completed`、`failed`、`request_limit`、`timeout`、`interrupted`。
`completed` 仅表示 Agent 正常结束；正确性字段固定为 `not_evaluated`，仍需独立验收。
Token 使用 SDK 返回的统计；未配置价格，因此货币成本为 `null`，不把 SDK 中的零价格当作实际免费。
`wallTimeSeconds` 包含 SDK 会话准备、模型调用和工具执行；不包含入口复制工作区的时间。
工作副本和运行产物默认不入库。

## 当前验证范围

模拟 API 测试覆盖 SDK 工具循环、生成文件与命令执行、用量汇总、密钥脱敏、请求预算、
模型服务错误、超时、只读工具集合与路径边界、需求摘取，以及基准源码保持不变。
模型连接配置由用户稍后填写，因此本轮不宣称真实模型已连通。

当前交付为单轮执行框架。正式的多次配对实验、独立需求验收、反作弊守卫、API 兼容检查、
差异行数与跨轮统计仍需在实验编排阶段实现。
