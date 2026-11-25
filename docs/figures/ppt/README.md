# 8 分钟汇报配图

全部配图为 16:9。可将 SVG 插入 PPT，PNG 也可直接使用。架构图和流程图提供可编辑的 `.drawio` 源文件。

| 用途 | 图 |
|---|---|
| 做了什么 · 架构改造 | [优化前后同页对照](architecture-comparison.drawio.svg)，另有[优化前](architecture-a.drawio.svg)和[优化后](architecture-b.drawio.svg)单图 |
| 做了什么 · 实验设计 | [三对完整链与 30 次需求实现](paired-experiment.drawio.svg) |
| 效果怎样 · 主结果 | [R0–R5 有效多后端重复规则数](structure-trend.svg) |
| 效果怎样 · 解释机制 | [第 1 对的 R5 预算检查接入位置](r5-budget-example.drawio.svg) |
| 效果怎样 · 成本 | [五轮实现费用与一次性优化费用](five-round-cost.svg) |
| 备份 · 变更影响面 | [触及包数、新增行数、改动文件数的配对比较](change-impact.svg) |

结构曲线来自 `tools/results.py --json` 的 `structure`，粗线逐轮取三次重复的中位数。影响面图按 `paired` 的 B−A 差值统计更少、相同和更多。费用图使用各链五轮的模型费用总和，并在每条 B 链上叠加一次选定的优化运行费用。运行索引和统计口径见[实验报告](../../results.md)。

R5 案例取第 1 对工作副本。A 的 `MemTransferService` 和 `JdbcTransferService` 分别调用 `BudgetLimits.check`。B 在 `AbstractTransferService` 的共享转账流程中调用 `validBudgets`。
