# 报告配图

本目录存放课程报告用的两张图，均为原生 draw.io 文件，可直接在 draw.io 中继续编辑。

| 文件 | 用途 |
|---|---|
| `architecture-a-to-b.drawio` | 图 1：架构 A（重构前）与架构 B（重构后）的分层对比 |
| `metrics-a-to-b.drawio` | 图 2：结构指标、兼容性与重构成本的量化对比 |
| `*.drawio.png` / `*.drawio.svg` | 由上面的 `.drawio` 导出（PNG 为 2 倍分辨率，SVG 为矢量） |

## 图 1：架构对比

左栏是重构前的记账库，右栏是重构后的记账库，横向三处差别对应三件具体的事：

1. **规则收敛** —— 业务规则从「内存后端 + JDBC 后端各写一遍」变成唯一一份
   （`AbstractTransferService` / `AccountServiceImpl` / `AbstractStorageProvider`）。
2. **依赖倒置** —— 业务层自己定义窄端口（`AccountStore` / `TransferStore`），
   两个后端反向实现端口；`service` 包不再依赖 `dao` 包。
3. **原语下沉** —— 后端只保留读一行、写一行、加锁、事务提交回滚等存储原语。

图中类名、包名与依赖方向均取自真实代码，不是示意性命名。

## 图 2：指标对比

数据全部来自同一口径下的工具输出，未手工换算：

| 图中数值 | 来源 |
|---|---|
| 近重复方法对、多后端重复规则、包间依赖边、循环依赖、层级违规、public 类型/方法数 | `python tools/structure.py <路径> --json <输出>`：A 取 `benchmarks/bookkeeping/source`，B 取优化 run 的 `workspace` |
| 被删除的 public 签名 = 0 | 优化 run 的 `guard.json`（`api.removedMethods` / `api.removedTypes`） |
| 既有测试 182 个全部通过 | 优化 run 的 `verification.json` |
| 改动文件 15 个、代码行 +791 / −469 | 优化 run 的 `diff.json` |
| 模型请求 99 次、36.8 分钟、$0.146 | 优化 run 的 `summary.json` |
| 反作弊守卫 0 违规 0 警告 | 优化 run 的 `guard.json` |

优化 run 指 `results/2026-11-20T08-41-49-404Z-bookkeeping-optimize-3d81d743`。

## 重新导出

在装有 draw.io 桌面版的机器上执行（`-e` 会把图的可编辑 XML 嵌入导出文件）：

```bash
drawio -x -f png -e -b 12 -s 2 -o architecture-a-to-b.drawio.png architecture-a-to-b.drawio
drawio -x -f svg -e -b 12          -o architecture-a-to-b.drawio.svg architecture-a-to-b.drawio
```

改图请直接编辑 `.drawio` 源文件，再重新导出 PNG / SVG。
