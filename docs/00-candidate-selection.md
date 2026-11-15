# 00 · 候选项目 A 的选型记录

> 目的：确定「项目 A」时，**不靠感觉**，靠可复现的硬标准筛选。本文的每一条结论都由 `tools/` 下的脚本产出。

---

## 1. 硬性筛选标准

一个合格的「项目 A」必须同时满足：

| # | 标准 | 理由 |
|---|---|---|
| S1 | **测试能在零外部服务下跑通** | 行为等价性判据的地基。若需要 MySQL/Redis/Docker，评审者与复现者无法离线运行，整个实验的可信度归零 |
| S2 | **Maven 构建**（工具链可得） | 本机只有 Maven 3.9.14；Gradle 需额外下载 wrapper 分发 |
| S3 | **主源码 40–160 个 Java 文件** | 少于 40：架构空间太小，优化前后差异无法体现；多于 160：agent 上下文压力大、实验单轮成本过高 |
| S4 | **有规模足够的既有测试**（≥15 个用例类） | 「A≡B」需要客观判据，否则只能靠 agent 自述 |
| S5 | **业务域清晰，能自然派生 3~5 个新需求** | 新需求必须真实、且对架构敏感，否则实验测不出差异 |
| S6 | **许可证允许** | MIT / Apache-2.0 优先 |

---

## 2. 筛选过程（可复现）

```powershell
python tools/screen_candidates.py   # 拉取候选 + 打分（规模/测试/外部依赖）
python tools/score_local.py         # 对已克隆候选本地打分
python tools/test_candidates.py     # 逐个真跑 mvn test，记录是否零外部服务通过
```

### 2.1 初筛池（GitHub 搜索 → 30+ 仓库）

按 `topic:spring-boot` + `pushed` 窗口 + 体积上限检索，剔除：

- 依赖 MySQL / PostgreSQL / MongoDB / Redis / Redisson 的项目
- 无 Maven 构建的项目
- 主源码规模越界的项目

### 2.2 逐一实测（决定性一步）

**不看 pom 猜，只看 `mvn test` 的实际结果。**

| 候选 | 构建 | 主类 | 测试类 | 实测结果 | 结论 |
|---|---|---|---|---|---|
| **`imetaxas/double-entry-bookkeeping-api`** | Maven | 62 | 23 | **BUILD SUCCESS，182 用例全绿，零外部服务** | ✅ **选定** |
| `loterias-api` | Maven | 25 | 4 | BUILD SUCCESS，但主类仅 25 < S3 | 规模不足 |
| `vue-admin-java` | Maven | 92 | 9 | 需 MySQL + Redis | S1 不满足 |
| `qi-api` | Maven | 141 | 5 | 需 MySQL + Redis(Redisson) | S1 不满足 |
| `crud-rest-gen` | Maven | 89 | 21 | `mvn test` 失败（需先 `package`/`install`） | 复现门槛过高 |
| `spring-boot-chat-messenger` | Maven | 159 | 4 | 测试过少 | S4 不满足 |
| `ArchForge` | Gradle | 785 | 163 | 需 PostgreSQL + Redis；规模过大 | S1/S2/S3 均不满足 |
| `rqueue` | Gradle | 312 | 250 | 需 Redis | S1/S2 不满足 |
| `educational-platform` | Gradle | 159 | 56 | H2 可用，但架构本已分层良好，无优化空间 | 优化空间不足 |
| `spring-modulith-with-ddd` | Maven | 28 | 8 | 架构本已优秀 | 同上 |
| `example-envers` | Gradle | 37 | 14 | 规模偏小 | S3 不满足 |
| `casbin-spring-boot-starter` | Maven | 15 | 4 | 需 MySQL + Redis | S1 不满足 |

---

## 3. 选定：imetaxas/double-entry-bookkeeping-api

| 项 | 值 |
|---|---|
| 上游 | https://github.com/imetaxas/double-entry-bookkeeping-api |
| SHA | `023535235e4151d43a18e6dc7ec8f473bcb59eac` |
| 版本 | release 1.0.0（2026-10-30） |
| 许可 | MIT |
| 固化位置 | `projectA/` |

### 3.1 模块构成（6 个 Maven 模块）

| 模块 | 主类 | 职责 |
|---|---|---|
| `bookkeeping-core` | 37 | 领域模型 + 领域服务 + 内存存储实现 + 报表 + 校验 |
| `bookkeeping-jdbc` | 12 | JDBC 持久化实现（SQLite / H2 / Derby / HSQL / MySQL / Postgres） |
| `bookkeeping-spring-boot-starter` | 2 | Spring Boot 自动装配 |
| `bookkeeping-examples` | 11 | 11 个能力演示（电商记账、费用追踪、多币种 FX、结账…） |
| `bookkeeping-coverage` | — | 覆盖率汇总 |

### 3.2 为什么它特别适合这个实验

**(a) 自带跨后端契约测试 —— 现成的行为等价性判据**

`LedgerContractTest` 是抽象契约测试，有 5 个实现：

```
InMemoryLedgerContractTest   H2LedgerContractTest
DerbyLedgerContractTest      HsqlLedgerContractTest
SqliteLedgerContractTest
```

> 任何「架构优化」若悄悄改变了行为，5 个后端中至少一个会挂 —— **等价性由项目自己保证，不靠 agent 自述**。

另：`MySQLIntegrationIT` / `PostgresIntegrationIT` 命名符合 Failsafe 约定，Surefire 默认不执行，因此**不需要 Docker 也不会挂**。

**(b) 存在真实且可观测的架构异味 —— 优化有实质空间**

| 异味 | 位置 | 可修改性后果 |
|---|---|---|
| **转账业务逻辑双份实现** | `core/memory` 的 `MemTransferService` 与 `jdbc` 的 `JdbcTransferService` 各自实现 `transferFunds` | 加一条转账校验规则要**改两处**，易漏改 → 行为漂移 |
| **校验逻辑耦合持久化接口** | `validation/TransferValidatorImpl` 直接依赖 `dao.AccountDao` / `dao.TransactionDao` | 业务规则绑死在存储细节上，换存储要动校验 |
| **setter 注入 + 可变状态** | `TransferValidatorImpl.setAccountDao/setTransactionDao` | 不可变、难测试、易错配 |
| **隐式会话状态** | `StorageProvider.accountService()/transferService()` 返回「最近打开的 session」 | 隐式全局状态，调用者依赖时序 |
| **God Facade** | `Ledger.java` 301 行，内嵌 Builder + 委派 + 编排 | 门面承担过多职责，改动波及面大 |
| **抽象语义重叠** | `StorageProvider` / `StorageSession` / `StorageFactory` 三层职责边界模糊 | 新增后端时不知该实现哪个 |

**(c) 业务域天然适配"新需求"实验**

复式记账有不变量（借贷平衡、账户方向、币种匹配、余额充足），业务规则真实且可验证；每加一条规则都是典型的「架构敏感型变更」——**恰好是能放大 A/B 差异的那类需求**。

**(d) 对外契约可自动核查**

对外接口是 Java public API，可用**签名差分**自动判定「向后兼容」，无需人工审阅。

---

## 4. 已知风险与应对

| 风险 | 应对 |
|---|---|
| 项目是**库**而非 Web 应用，「新需求」形态与预期不同 | 反而更纯粹：新增能力 = 新增 API，差异直接体现在 public API 与实现位置 |
| 上游较新（2026-10），社区关注度可能有限 | 课程作业不依赖社区影响力；且 MIT + 有版本号，provenance 完整 |
| `bookkeeping-examples` 在 `src/main` 中，重构需同步更新 | 这正是 A 组「改动波及面大」的真实体现，应保留而非绕过 |
