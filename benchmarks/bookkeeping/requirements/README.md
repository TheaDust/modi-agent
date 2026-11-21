# 需求集 R1–R5

> 本目录定义实验用的 5 个累积新需求。**每个需求的文本在 A 组与 B 组完全一致**（同一份文件，不做任何针对性调整）。

## 提供给智能体与仅供分析的内容

每个需求文件分两部分：

| 区块 | 是否给 Agent |
|---|---|
| `## 给智能体的需求` | ✅ **中文原文逐字提供给智能体**，代码标识符保持原样 |
| `## 中文说明` / `## 预期架构敏感点` | ❌ **不给 Agent**，仅用于报告分析 |

Agent 收到的完整内容 = 固定的系统提示词（`prompts/feature.md`）+ 当前需求的「给智能体的需求」区块。

## 正式实验前的 API 可达性修订

需求冻结前发现并补齐了三处「规定了 API、但调用方够不着」的缺口，以保证 A/B 两组做的是同一个契约：

| 需求 | 缺口 | 修订 |
|---|---|---|
| R1 | `Ledger.accounts()` 是私有方法，`AccountService` 上的新成员无法从库入口调用；且 `Ledger.commit()` 按 ChartOfAccounts 校验账户引用，账户必须在建表时创建 | 规定 `Ledger.accountService()` 访问器与 `ChartOfAccountsBuilder.create(..., Money transferLimit)` 重载；冻结验收测试据此编写 |
| R3 / R4 / R5 | 原文允许「获取方式可自行选择」，A/B 可能暴露不同名称的服务访问器，破坏 API 可比性 | 分别固定 `Ledger.reconciliationService()` / `postingHistoryService()` / `budgetService()` |
| R4 | 未规定给操作者赋值的构建器方法名 | 规定 `TransferRequest.BuildStep.actor(String)` |

另有一处**冻结验收用例自身的矛盾**，在 R4 轮实测中暴露：A 组与 B 组同时、同一条断言失败
（`expected: <sale> but was: <payout>`）。原因是 `AcceptanceSupport.payment(...)` 提交的交易类型
固定为 `"payout"`，而 `R4AcceptanceTest.postingsAreListedPerAccountInSubmissionOrder` 却断言
`getTransactionType()` 等于 `"sale"`——用例与自己的辅助方法互相矛盾。两组实现返回的都是实际提交的类型
`"payout"`，属正确行为。该断言已订正为 `"payout"`。

> 此订正只改判据，不改需求，也不偏向任何一组：两组在同一判据下都通过。
> 订正后需对已完成的 R4/R5 轮次重新执行冻结验收，原始验收记录一并留档。

R5 的冻结用例另有一处**自身构造的转账不合法**：`budgetsAreCheckedPerAccount` 提交了一笔借记
`REVENUE` 500.00 的转账，而该用例的账本里 `REVENUE` 余额为 0.00，于是被项目**原有**的余额校验
（`TransferValidatorImpl.validBalance` → `InsufficientFundsException`）先行拒绝，根本走不到预算逻辑，
A 组与 B 组同时以同一原因失败。已给该用例的收入账户补足资金（`AcceptanceSupport` 增加带收入余额的重载），
断言与需求意图均未改动。

这些修订只固定**对外 API 表面**，不涉及实现位置、模块归属或设计模式，不违反铁律 1。

## 三条设计铁律

### 铁律 1 · 规定对外 API，但不规定实现位置

需求**规定**要新增哪些 public 类型与方法（因为这是库的对外契约，两组必须一致才能验证行为等价），
但**不规定**这些代码放在哪个模块、哪个包、用什么设计模式。

> 这正是本实验要测量的东西：**同一个 API 契约，在不同架构上的实现成本差多少**。
> 如果放任 agent 自由设计 API，A、B 两组的 API 本身就不同，diff 无法对比，行为等价也无法自动验证。

### 铁律 2 · 需求只讲业务行为，不讲代码结构

不得出现"抽出一个策略接口""把逻辑移到 core"之类的措辞 —— 那等于给某一组提示，会污染自变量。

### 铁律 3 · 需求必须对架构敏感

若一条需求在 A 和 B 上的实现难度天然相同，它对实验没有信息量。
每条需求都刻意落在 A 的已知架构弱点上（见各文件的「预期架构敏感点」）。

## 累积关系

R1 → R2 → R3 → R4 → R5 **逐轮累积**（第 N 轮的代码包含前 N-1 轮的成果）。
这样才能画出「架构劣化曲线」：A 组随轮次推进改动面越来越大，B 组保持平稳。

```
轮次   A 组起点            B 组起点            产出（k = 1,2,3 各重复一次）
R1     A_0                B_0                A_1^k / B_1^k
R2     A_1^k              B_1^k              A_2^k / B_2^k
R3     A_2^k              B_2^k              A_3^k / B_3^k
R4     A_3^k              B_3^k              A_4^k / B_4^k
R5     A_4^k              B_4^k              A_5^k / B_5^k
```

> 记法：`A_i^k` = 原版轨迹的第 k 次重复、累积实现前 i 个需求后的代码；
> `B_i^k` = 优化版轨迹上的对应版本；`i=0` 即两条链共用的基线，
> `k` 是重复序号（本实验 N=3，k ∈ {1,2,3}）。
> 同一个 k 的 A/B 两条链并行执行，构成一个配对。
> 详见 `docs/experiment-design.md` §5。
