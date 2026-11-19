# 仓库贡献指南

## 项目结构与模块划分

- `agent/`：Pi SDK 加载、模型配置、运行控制和事件记录。
- `bench/`：单轮命令行入口、工作副本准备和变更清单。
- `prompts/`：只读检查、架构优化、需求实现三种模式的提示词。
- `test/`：使用本地模拟模型端点的 Node.js 集成测试。
- `benchmarks/{bookkeeping,cron-utils}/`：固化的 Java 源码、来源记录、选型说明，以及案例需求或补丁。
- `tools/`：Python 选型、源码固化和结构分析脚本。
- `docs/`：实验设计与运行说明；`results/` 和 `.cache/` 存放不入库的本地产物。

修改执行行为前阅读 `docs/agent-runtime.md`；修改实验控制条件或指标前阅读 `docs/experiment-design.md`。

## 构建、测试与开发命令

在仓库根目录使用 Node.js 24+。框架通过 `PI_SDK_PATH` 加载本机已有的 Pi SDK **1.2.0**，无需安装 npm 依赖或编译。

- `npm run agent:check`：检查 SDK 加载和配置，不调用模型。
- `npm run agent:smoke`：使用本地模拟端点执行集成测试。
- `npm run agent -- --benchmark bookkeeping --mode inspect`：使用配置的模型检查独立工作副本。
- `python tools/structure.py benchmarks/bookkeeping/source`：计算记账库现有口径的结构指标。

Java 验证命令见各案例的 README；在文档所述环境中，cron-utils 需添加 `-Djacoco.skip=true`。

## 编码风格与命名

JavaScript 使用 ES 模块（`.mjs`）、两空格缩进、单引号和分号；标识符采用 camelCase，文件名应能表达用途。Python 使用四空格缩进和 snake_case 命名。Java 保持上游风格。目前未配置格式化或静态检查工具。

优先选择完整满足当前需求的最小、清晰实现。仅为已证实的需求增加抽象，避免预留扩展能力、无实际场景的兜底逻辑和无关重构。

## 测试要求

框架测试使用 `node:test` 和 `node:assert/strict`，文件命名为 `test/*.test.mjs`。

优先运行受影响模块的测试。仅在修改公共基础设施、局部测试失败或存在明确回归风险时扩大范围。仅修改文档时检查格式和链接，不运行测试。验证时说明修改内容、选择这些检查的原因，以及无需扩大范围的依据。

Agent 正常结束不代表功能正确；基准行为必须独立验收。

## 提交与合并请求

历史提交使用 `docs:`、`chore:`、`feat(A):` 等前缀。沿用 `类型(范围): 简要说明` 的格式，范围可省略。

合并请求应说明问题、修改后的行为、验证结果和实验影响，并关联相关议题或需求。仅在涉及视觉变化时附截图。

## 配置与实验完整性

参照 `.env.example` 在 `.env` 配置模型，密钥与生成产物不得入库。保留基准来源记录和原有测试断言。在工作副本上开展实验，配对运行使用一致的模型、提示词和工具。项目自有文档和提示词使用中文，保留代码标识符、命令和上游原始材料。
