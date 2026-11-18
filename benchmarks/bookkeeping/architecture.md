# 02 · 项目 A 的架构体检报告（基线）

> 对象：`benchmarks/bookkeeping/source/` = `imetaxas/double-entry-bookkeeping-api` @ `0235352`
> 工具：`python tools/structure.py benchmarks/bookkeeping/source --json benchmarks/bookkeeping/baseline/structure.json`
> 本报告是 B 优化的**靶子**，也是前后架构指标对比的**尺子**。

---

## 1. 规模基线

| 指标 | 值 |
|---|---|
| Maven 模块 | 4（core / jdbc / spring-boot-starter / examples） |
| 主源码文件 | 62 |
| 测试文件 | 21 |
| 包数量 | 11 |
| 包间依赖边 | 40 |
| public 类型 | 58 |
| public 方法 | 242 |
| 测试用例 | **182 全部通过，零外部服务** |

> public API 面积（58/242）是「对外接口向后兼容」核查的基准线：B 相对 A 不得有破坏性变更。

---

## 2. 包依赖图

```
core 根包 .        -> .exception  .memory  .model  .report  .service  .validation
  .exception       -> (无)
  .model           -> .exception  .report  .validation
  .report          -> .model
  .service         -> .exception  .model
  .validation      -> .dao  .exception  .model
  .dao             -> .model
  .memory          -> .  .dao  .exception  .model  .service  .validation
  .jdbc            -> .  .dao  .exception  .model  .service  .validation
  .spring          -> .  .memory  .model
  .examples        -> .  .exception  .jdbc  .memory  .model  .spring  .validation
```

---

## 3. 异味清单（全部由工具实测，非人工印象）

### 3.1 循环依赖：2 个强连通分量，内含 4 条独立环路

| 环路 | 性质 | 后果 |
|---|---|---|
| `core 根包 ↔ .memory` | **抽象包依赖具体实现包** | 核心 API 无法脱离内存实现独立演进；换存储要动核心包 |
| `.model ↔ .report` | 领域模型 ↔ 报表视图互依赖 | 模型里要塞报表所需的信息，反向污染领域概念 |
| `.model ↔ .validation` | **领域模型依赖校验包** | 校验规则渗入领域模型，模型不再是纯数据 |
| `.validation → .dao → .model → .validation` | 校验包依赖持久化接口 | 见 3.2 |

### 3.2 层级违规：1 处

```
com.yanimetaxas.bookkeeping.validation → com.yanimetaxas.bookkeeping.dao
```

`TransferValidatorImpl` 直接依赖 `AccountDao` / `TransactionDao`：
**业务规则绑死在持久化接口上**，换一套存储抽象就要改业务校验代码。

### 3.3 多后端重复实现的业务规则：21 条 ⭐

`memory`（内存实现）与 `jdbc`（JDBC 实现）**各自实现了一遍同一批业务规则**：

```
accountExists               createAccount            dropAll
findAllTransactions         findTransactionsByAccountRef
getAccount                  getAccountBalance        getAccounts
getAllTransactions          getClientRef             getTransactionByRef
getTransactionRefsForAccount getTransactions         listAccounts
open                        requireCurrent           setClock
storeTransaction            transferFunds            transferService
accountService
```

其中 `transferFunds`（转账）、`storeTransaction`（记账）、`createAccount`（建科目）是**核心业务动作**。

**近重复（token 相似度 ≥ 0.45）：5 处**

| 方法 | 相似度 | 内存版 | JDBC 版 |
|---|---|---|---|
| `requireCurrent` | 0.83 | 7 LOC | 7 LOC |
| `findTransactionsByAccountRef` | 0.76 | 15 LOC | 10 LOC |
| `createAccount` | 0.74 | 11 LOC | 6 LOC |
| `getAccountBalance` | 0.71 | 12 LOC | 7 LOC |
| `open` | 0.54 | 24 LOC | 21 LOC |

> ⚠ **注意 `transferFunds` 不在近重复列表里** —— 因为内存版走 `Map`、JDBC 版走 `SQL`，
> 代码写法必然不同，但**同一条业务规则要改两处**的成本是真实的，且两处写法不同更容易**静默分叉**。
> 这比"代码长得像"更危险，因此本项目额外单列「多后端重复实现规则数」作为指标。

### 3.4 其他结构性异味

| 异味 | 位置 | 说明 |
|---|---|---|
| **过大的门面** | `Ledger.java`（301 行） | 门面同时承担 API 委派、事务编排、报表入口、内嵌 Builder |
| **setter 注入 + 可变状态** | `TransferValidatorImpl.setAccountDao/setTransactionDao` | 校验器可被换掉依赖，不满足构造后不变 |
| **隐式会话状态** | `StorageProvider.accountService()/transferService()` 返回「最近打开的 session」 | 调用结果依赖调用时序，隐式全局状态 |
| **抽象语义重叠** | `StorageProvider` / `StorageSession` / `StorageFactory` | 三层职责边界模糊，新增后端不知该实现哪个 |
| **示例代码在生产制品内** | `bookkeeping-examples` 在 `src/main` | 重构需同步更新示例，放大了改动波及面 |

---

## 4. 为什么这些异味恰好是「可修改性」的靶心

上面的异味不是抽象的架构术语，它们**直接换算成变更成本**：

| 异味 | 对「新增一条转账限额规则」的成本影响 |
|---|---|
| `transferFunds` 双后端实现 | 要改 **2 处**（`MemTransferService` + `JdbcTransferService`），漏一处 → 内存后端与 JDBC 后端行为不一致 |
| 校验耦合 DAO | 限额规则要判断账户余额/限额，必须先知道 DAO 怎么存 → 规则无法独立编写与测试 |
| `Ledger` 过大的门面 | 新能力往往要挂到门面上，门面再涨，改动波及所有调用方 |
| `model ↔ validation` 循环 | 限额是账户的属性，模型却依赖校验包 → 属性放不进去，或放进去就加深循环 |
| 隐式会话状态 | 新能力若需要账本上下文（当前账户、时钟），只能顺着 `StorageProvider` 的隐式 session 取 |

**这就是实验要验证的**：把这 21 条多后端规则收敛到单一处、把校验从 DAO 上解耦、把门面拆开之后，
**同样一条新需求的实现成本应当显著下降**。

---

## 5. 行为等价性判据（已就位）

| 判据 | 内容 |
|---|---|
| **跨后端契约测试** | `LedgerContractTest` × 5 实现（InMemory / H2 / Derby / HSQL / SQLite），随 A 原样固化，B/C/D 逐字复制后运行 |
| **集成测试不干扰** | `MySQLIntegrationIT` / `PostgresIntegrationIT` 按 Failsafe 命名，Surefire 默认不执行 → 不需 Docker |
| **回归基线** | A 上 182 用例全绿，作为 B/C/D 的准入门槛 |
| **public API 差分** | 以本报告的 58 类型 / 242 方法为基准，核查 B 相对 A 无破坏性变更 |

---

## 6. B 的验收标准（由 `prompts/optimize.md` 写入并由 `tools/structure.py` 自动判定）

| # | 指标 | A 基线 | B 目标 |
|---|---|---|---|
| 1 | 包间循环依赖数 | **2** | 0 |
| 2 | 层级违规（validation→dao） | **1** | 0 |
| 3 | 多后端重复实现的业务规则数 | **21** | ≤ 3（不可消除的部分需说明理由） |
| 4 | 破坏性 public API 变更 | — | **0** |
| 5 | `mvn test` | 182 全绿 | **182 全绿**（不允许删测试换绿） |
