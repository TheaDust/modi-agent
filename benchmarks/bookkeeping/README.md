# Bookkeeping benchmark

复式记账库，用于观察业务规则、账本状态和多后端存储之间的变更传播。

| 路径 | 内容 |
|---|---|
| [source/](source/) | 固定上游源码，含原始 README、LICENSE 和测试 |
| [provenance.json](provenance.json) | 上游仓库、固定提交与许可 |
| [selection.md](selection.md) | 候选筛选过程及选型记录 |
| [architecture.md](architecture.md) | 既有架构分析报告 |
| [baseline/structure.json](baseline/structure.json) | 既有结构指标快照 |
| [requirements/](requirements/README.md) | 本案例的累积需求 R1–R5 |

架构报告和快照沿用既有统计口径；方法论审阅发现的指标局限仍需在正式实验前处理。
本次目录整理仅更新快照中的源码路径。

从仓库根目录执行结构分析：

```powershell
python tools/structure.py benchmarks/bookkeeping/source
```

公共实验设计见 [docs/experiment-design.md](../../docs/experiment-design.md)。
