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

其余参数也在 `.env` 中：上下文窗口、单次输出上限、采样温度和思考等级。
这些值应与所用模型能力一致；服务端是否接受或忽略参数仍由具体模型决定。

思考等级以 `reasoning_effort` 参数发给服务商：`off` 映射为 `none`（关闭思考），其余档位原样透传。
模型声明为可推理后 SDK 才会发送该参数；不声明则一个参数都不发，网关按自身默认值思考，档位实际不受控。
单次输出上限是思考 token 与正文共享的池子，两类 token 相加不能超过该上限；
上限过小会让模型在思考阶段被截断，运行以 `Model stopped: length` 失败。

上下文窗口同时决定单次输出上限：SDK 按 `min(配置上限, 上下文窗口 − 已用上下文 − 4096)` 计算，
上下文接近窗口时输出上限会被压到接近 0，症状同样是 `Model stopped: length`。
因此上下文窗口要按模型真实能力配置，保守低估会让长任务在收尾阶段失败。

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

# 架构优化：省略任务时使用固定默认优化任务
npm run agent -- --benchmark bookkeeping --mode optimize

# 指定优化任务
npm run agent -- --benchmark bookkeeping --mode optimize --prompt-file tasks/optimize-bookkeeping.md

# 实现 R1，仅传入「给智能体的需求」区块
npm run agent -- --benchmark bookkeeping --mode feature --requirement R1

# 从前一轮成果开始：仍复制到一个新工作区，每次新建会话
npm run agent -- --benchmark bookkeeping --mode feature --requirement R2 --from results/PREVIOUS_RUN/workspace
```

`--prompt`、`--prompt-file` 和 `--requirement` 三者互斥。
`--prompt-file` 为你准备的任务文件，上面的 `tasks/optimize-bookkeeping.md` 是路径示例。
不指定任务时，inspect 和 optimize 分别使用固定默认任务；feature 模式必须给出需求或任务文本。
默认优化任务为：在不改变现有行为、公共 API 和现有测试的前提下，检查该项目的变更传播路径，
实施能降低后续需求实现成本的架构优化，并报告改动依据与验证结果。

## 行为与产物

每次运行将起点源码复制到 `results/<run-id>/workspace/`，跳过 `.git`、`target` 和 `node_modules`。
默认起点是案例的固化 `source/`；`--from` 可指定优化版或前一需求轮次的源码。
不复制选型报告、需求分析说明或其他组的运行历史。

| 模式               | 工具                               |
| ------------------ | ---------------------------------- |
| inspect            | read、grep、find、ls               |
| optimize / feature | 上述工具及 edit、write、powershell |

文件工具检查目标是否位于当前工作副本内，包含真实路径检查。
PowerShell 以当前副本为工作目录，具有本机进程权限；当前实现不提供操作系统级隔离。
正式隔离实验需另外配置进程环境和访问边界。

各运行显式使用独立内存会话、固定提示词和工具集合，不加载用户级技能、扩展、项目指令文件或历史会话。
自动上下文压缩、自动重试和缓存保温关闭；超出上下文后按失败记录。
工具顺序执行。每次模型请求都会记录请求数与事件；运行不设请求次数或时长上限，由模型自主进行到完成，Ctrl+C 可中止当前调用。

运行目录包含：

| 文件                                 | 内容                                                          |
| ------------------------------------ | ------------------------------------------------------------- |
| `run.json`                         | 案例、起点路径、上游来源记录和任务摘要哈希                    |
| `config.json`                      | 模型参数、SDK 版本、启用工具和控制策略                        |
| `prompt.md` / `system-prompt.md` | 实际任务和系统提示词                                          |
| `before.json`                      | 起点文件内容 SHA-256 清单                                     |
| `events.jsonl`                     | 完成消息、工具调用结果和生命周期事件；不保存逐 token 增量事件 |
| `answer.md`                        | 最后一条助手消息的文本                                        |
| `summary.json`                     | 请求数、工具数及错误数、token、货币成本、墙钟时间和终止状态   |
| `changes.json`                     | 变更文件及运行结束后的文件哈希                                |
| `diff.json`                        | 相对基线提交的行级增删与文件状态（`git diff --numstat`）       |
| `guard.json`                       | 事后反作弊结果；`valid=false` 表示该轮判为无效                |
| `verification.json` / `verification.log` | 独立 `mvn test` 验收结论、用例统计与原始日志            |
| `workspace/`                       | 本轮工作副本（运行前已 `git init` 并提交基线）                |

运行状态包括 `completed`、`failed`、`interrupted`。
`completed` 仅表示 Agent 正常结束；`summary.json` 的 `correctness` 字段仍固定为 `not_evaluated`，
真正的正确性以 `verification.json`（`mvn test` 的通过/失败与用例数）为准，不以 Agent 自述为准。

结果工作副本在 Agent 运行前初始化 git 并提交基线，`diff.json` 由此产出行级增删，
是 H1「变更规模」的指标来源。`guard.json` 在行为等价性、public API、测试断言、既有类位置与
跨层依赖上做事后检查：只把高置信度违规判为 `valid=false`，无法可靠判定的情况记为 `warnings`。
非 Java 项目或缺少 git 基线时守卫降级为 `skipped` / `unavailable`，不会误判为无效。
`verification.json` 需要本机 Maven：在 `.env` 中设置 `MAVEN_PATH`，未设置时使用 PATH 中的 `mvn`。
Token 使用 SDK 返回的统计；`cost` 按 `.env` 中的 `MODEL_COST_*` 单价（美元 / 百万 token）估算，
在 `summary.json` 中给出输入、输出、缓存读取、缓存写入分项及 `total`；未填写时输入、输出、缓存读取默认使用
0.15 / 0.6 / 0.003，缓存写入按输入单价计。
实际单价随 `config.json` 一并保存，便于复算。
`wallTimeSeconds` 包含 SDK 会话准备、模型调用和工具执行；不包含入口复制工作区的时间。
工作副本和运行产物默认不入库。

## 当前验证范围

模拟 API 测试覆盖 SDK 工具循环、生成文件与命令执行、用量汇总、密钥脱敏、
模型服务错误、只读工具集合与路径边界、需求摘取，以及基准源码保持不变。
模型连接配置由用户稍后填写，因此本轮不宣称真实模型已连通。

当前交付为带事后检查的单轮执行框架：行级 diff、反作弊守卫、独立测试验收与 API 签名差分已落地；
多次配对实验、跨轮统计与净投资回报分析仍需在实验编排阶段实现。
