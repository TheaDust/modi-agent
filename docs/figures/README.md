# 报告配图

本目录存放课程报告用的四张图，均为原生 draw.io 文件，可直接在 draw.io 中继续编辑。

| 文件 | 用途 |
|---|---|
| `architecture-a.drawio` | 图 1a：架构 A（重构前） |
| `architecture-b.drawio` | 图 1b：架构 B（重构后） |
| `metrics-a-to-b.drawio` | 图 2：结构指标、兼容性与重构成本的量化对比 |
| `degradation-curve.drawio` | 图 3：R0–R5 的架构劣化曲线（N=3，主结论） |
| `*.drawio.png` / `*.drawio.svg` | 由上面的 `.drawio` 导出（PNG 为 2 倍分辨率，SVG 为矢量） |

三张图共用一套视觉语言：白底、深灰标题、浅色底 + 细描边的方块、统一的圆角与字号。

## 术语

图上出现的名词一律用代码里的真实单位，两张架构图用词完全一致：

| 图上写法 | 指代 | 代码位置 |
|---|---|---|
| `memory 包` / `jdbc 包` | 两个存储后端所在的包（架构 A 里规则和存储实现混在同一个包里） | `com.yanimetaxas.bookkeeping.memory` / `.jdbc` |
| `service 包` | 业务层所在包 | `com.yanimetaxas.bookkeeping.service` |
| 转账规则 / 账户规则 / 会话前导 | 三条业务规则 | 架构 B 中为 `AbstractTransferService` / `AccountServiceImpl` / `AbstractStorageProvider` |
| 端口（`AccountStore` / `TransferStore`） | 业务层自己定义的窄接口 | `service` 包 |
| 存储实现 | 后端里的读写原语 | `InMemory*Dao` / `Jdbc*Repository` |
| `dao 接口` | 保持不变的持久化接口 | `AccountDao` / `TransactionDao` / `ClientDao` |
| `Ledger` | 对外入口门面 | `com.yanimetaxas.bookkeeping.Ledger` |

方块颜色只用来区分**角色**，不表示好坏：

| 颜色 | 含义 |
|---|---|
| 琥珀 | 业务规则（架构 A 中同一规则有两份，用虚线相连） |
| 青绿 | 业务规则（架构 B 中唯一一份） |
| 蓝 | 端口（由业务层定义、后端反向实现） |
| 灰 | 存储实现 / 后端包 / dao 接口 |
| 白 + 深描边 | 对外入口 `Ledger` |

## 图 1a / 1b：架构对比

两张图按同一个骨架对照：入口 `Ledger` 在上，下方是分层。

- **图 1a**：规则写在后端包里。`memory 包` 与 `jdbc 包` 两列并排，各写了一份
  `转账规则 / 账户规则 / 会话前导`，同名规则之间用虚线连起来 —— 一眼看出「同一条规则写了两遍」；
  两列下方各有一份「存储实现」，说明规则与存储实现混在同一层。
- **图 1b**：规则提到 `service` 包，只有一份；业务层向下依赖自己定义的窄端口
  `AccountStore` / `TransferStore`；`memory 包` 与 `jdbc 包` 用**向上的蓝色箭头**实现端口 ——
  依赖倒置就画在这两支反向箭头上。

图中结构与包名均取自真实代码，不是示意性命名。

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
图 2 只描述 `A_0` → `B_0` 那一次架构改造本身，不含 R1–R5 数据，因此不受 N=3 扩充影响。

## 图 3：架构劣化曲线（N=3）

主结论的可视化：横轴是累计实现的需求数（R0 即基线），纵轴是「有效多后端重复规则数」。
每条链画 3 条细虚线（各次重复）+ 1 条粗实线（三次重复的中位数），A 链琥珀、B 链青绿，
沿用图 1a/1b 的配色语言。

| 图上数值 | 来源 |
|---|---|
| 每条线 6 个点（R0–R5） | `python tools/results.py --json out.json` 输出的 `structure[*].effective_multi_backend_rule_count` |
| R0 = `A_0` 12、`B_0` 8 | 同上，`structure.A_0` / `structure.B_0` |
| 中位数序列 A：12/13/16/16/16/20；B：8/8/8/8/8/9 | 对 3 次重复逐点取中位数 |
| 两组中位数之差 4→11 | 同轮 A、B 中位数相减 |
| 「15/15 个配对 B 更少」 | 同一 JSON 的 `overall.effective_multi_backend_rule_count.bBetter` |

图 3 的曲线对应上述 JSON。数据与判定口径见 `docs/results.md` §3.3。

## 重新导出

在装有 draw.io 桌面版的机器上执行（`-e` 会把图的可编辑 XML 嵌入导出文件）：

```bash
drawio -x -f png -e -b 16 -s 2 -o architecture-a.drawio.png architecture-a.drawio
drawio -x -f svg -e -b 16          -o architecture-a.drawio.svg architecture-a.drawio
# 其余两张同理；图 3 的文件名前缀为 degradation-curve
```

改图请直接编辑 `.drawio` 源文件，再重新导出 PNG / SVG。
