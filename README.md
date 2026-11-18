# modi-agent

**基于 AI Agent 的软件体系结构可修改性优化**——软件体系结构课程实验。

研究问题：对可修改性做架构层面的预先投资，能否降低后续需求变更的实现成本？

## 从这里开始

- [实验设计](docs/experiment-design.md)：研究假设、控制变量、指标、版本组织与有效性威胁。
- [记账库基准项目](benchmarks/bookkeeping/README.md)：第一个案例，含源码、需求 R1–R5 和既有架构分析。
- [cron-utils 基准项目](benchmarks/cron-utils/README.md)：第二个案例，含源码、测试夹具补丁与基线验证记录。
- [Agent 运行说明](docs/agent-runtime.md)：本机 Pi SDK、`.env`、任务入口和运行日志。

## 目录

```text
modi-agent/
├── README.md
├── docs/
│   └── experiment-design.md
├── benchmarks/
│   ├── bookkeeping/
│   │   ├── README.md
│   │   ├── source/               # 固定上游源码
│   │   ├── requirements/         # R1–R5
│   │   ├── baseline/             # 结构指标快照
│   │   ├── provenance.json
│   │   ├── selection.md
│   │   └── architecture.md
│   └── cron-utils/
│       ├── README.md
│       ├── source/               # 固定源码及已应用测试夹具
│       ├── patches/
│       ├── provenance.json
│       └── selection.md
├── tools/                        # 选型、固化、分析与端点探测脚本
├── agent/                        # Pi SDK 加载、模型配置与运行内核
├── prompts/                      # 检查、优化和需求实现提示词
├── bench/                        # 独立工作副本与单轮执行入口
├── test/                         # 使用本地模拟端点的框架测试
├── results/                      # 每轮产物与工作副本，不入库
└── .cache/                       # 本地数据，不入库
    ├── candidates/               # 候选仓库、筛选结果与 _buildlogs/
    ├── maven/                    # Maven 依赖缓存
    └── legacy-tools/             # 保留的早期临时脚本
```

每个基准项目 的源码、需求和证据放在同一目录。A/B 表示同一案例的原版与优化版，不用于区分两个案例。

单轮 Agent 已实现；多次配对实验、独立验收与反作弊守卫后续在 `bench/` 中实现。

## 启动 Agent

本机 `.env` 已创建，填写 `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY`；默认使用兼容 OpenAI 的协议。
复用本机 Pi SDK 1.2.0，无需 `npm install`。

```powershell
npm run agent:check
npm run agent:smoke
npm run agent -- --benchmark bookkeeping --mode inspect
```

每次运行都复制独立工作区，日志和产物写入 `results/<run-id>/`。详细参数见 [运行说明](docs/agent-runtime.md)。

## 两个案例

| 案例 | 上游与固定版本 | 变更观察重点 | 基线验证记录 |
|---|---|---|---|
| Bookkeeping | [double-entry-bookkeeping-api](https://github.com/imetaxas/double-entry-bookkeeping-api)，`0235352` | 业务服务与存储适配 | 182 个测试通过 |
| cron-utils | [cron-utils](https://github.com/jmrozanec/cron-utils)，9.2.1，`a3d31f7` | 解析、求值与描述 | 固定日期夹具后 667 个通过、51 个上游已有跳过 |

## 实验流程

对每个案例独立执行：

1. 固定原版 A、需求集、验收测试和运行环境。
2. 优化 A 得到 B，记录改造成本，验证既有行为与 API 兼容性。
3. 同一 Agent 在 A、B 两组分别实现相同的累积需求。
4. 比较逐轮变更影响面、实现成本、正确性与结构指标，再分析跨案例结果。

## 常用命令

以下命令从仓库根目录执行。Maven 路径按本机安装位置调整。

```powershell
# 记账库结构分析（沿用现有指标口径）
python tools/structure.py benchmarks/bookkeeping/source

# 记账库基线测试
$repoRoot = (Get-Location).Path
& 'D:\Tools\apache-maven-3.9.14\bin\mvn.cmd' -B `
    -f benchmarks/bookkeeping/source/pom.xml `
    "-Dmaven.repo.local=$repoRoot/.cache/maven" test

# cron-utils 基线测试：source/ 已包含固定日期夹具
& 'D:\Tools\apache-maven-3.9.14\bin\mvn.cmd' -B `
    -f benchmarks/cron-utils/source/pom.xml `
    "-Dmaven.repo.local=$repoRoot/.cache/maven" '-Djacoco.skip=true' test
```

`tools/screen_candidates.py`、`score_local.py`、`test_candidates.py` 用于候选筛选；
`vendor_upstream.py` 用于重新固化记账库；`probe_llm.py` 会调用配置中的模型端点。
