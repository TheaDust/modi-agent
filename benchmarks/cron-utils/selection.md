# 第二个基准项目 选型：cron-utils

## 推荐及范围

推荐采用 [jmrozanec/cron-utils](https://github.com/jmrozanec/cron-utils) 的 **9.2.1** 发布版，
固定提交为 `a3d31f7445376b19d1337c604d3d3b7e986302cc`。许可为 Apache-2.0。
选型核查日期：2026-11-16。

它用于检验可修改性优化的效果能否从记账领域迁移到表达式处理领域。
两个项目仍然都是 Java 库，因此支持的结论限于不同业务和内部结构的 Java 库，不能据此推广到 Web 应用、分布式系统或其他语言。

## 已核查的适配条件

以下数量来自发布版工作树，排除构建产物；文件数不等同于测试用例数。

| 项目 | 核查结果 |
|---|---|
| 构建 | 单模块 Maven；发布版配置见上游 `pom.xml` |
| 主源码 | 87 个 Java 文件，9,555 行（含注释和空行） |
| 测试源码 | 114 个 Java 文件，12,113 行（含辅助类） |
| 主要能力 | cron 解析、校验、方言转换、自然语言描述、执行时间计算 |
| 外部服务 | 源码与 POM 检查未发现必须启动数据库、Redis 或 Docker 的要求 |
| 本地检查环境 | Windows、OpenJDK 17.0.18、Maven 3.9.14 |

来源：[固定版本源码](https://github.com/jmrozanec/cron-utils/tree/a3d31f7445376b19d1337c604d3d3b7e986302cc)、
[POM](https://github.com/jmrozanec/cron-utils/blob/a3d31f7445376b19d1337c604d3d3b7e986302cc/pom.xml)、
[许可证](https://github.com/jmrozanec/cron-utils/blob/a3d31f7445376b19d1337c604d3d3b7e986302cc/LICENSE)。

## 对泛化性提供的增量

| 维度 | 记账项目 | cron-utils |
|---|---|---|
| 核心对象 | 账户、余额、交易 | 表达式、字段约束、时间 |
| 核心流程 | 校验与原子过账、存储查询 | 解析、语义模型、描述、求值与转换 |
| 变化传播 | 业务服务与存储适配之间 | 同一语义在多个处理阶段之间 |
| 回归判据 | 金额、交易记录与后端一致性 | 固定输入下的解析结果、描述与时间序列 |
| 结构范围 | 多模块、双存储后端 | 单模块、多包及表达式 Visitor |

保留 Java/Maven 降低工具链差异，同时改变业务与内部组织，使第二案例提供独立于存储分层的证据。

## 已观察到的变更传播位置

- `FieldParser` 根据不同符号分派解析逻辑。
- `FieldExpressionVisitor` 为既有表达式类型提供不同访问方法。
- `FieldValueGeneratorFactory` 根据表达式类型和日期字段选择求值器。
- `DescriptionStrategyFactory` 根据表达式及特殊符号选择描述策略。
- `SingleExecutionTime` 集中处理多个日期字段及时间搜索逻辑。

这些是可供变更追踪的具体位置，不等同于已经证实的架构缺陷。
已有 Visitor、Builder 和约束模型也是原版的能力；不能假设原版缺乏扩展设计，更不能预设优化版一定胜出。

## 后续需求设计方向（尚非实验规格）

可从新增表达式语义、执行日历约束、结构化解析诊断、描述输出能力等不同类型中选取需求。
先检查基线是否已支持，再定义精确输入输出、边界条件及公共 API。
应包含预计影响局部的变更，允许两组收益接近；不能把全部需求限制为一种表达式扩展。

正式需求与验收测试应在优化前独立冻结。优化 Agent 仅获得一般质量属性场景，不能读取具体留出需求或本节提示。
测试使用固定日期、时区与 Locale，并明确夏令时和无后续执行时间等场景的语义。
两项目共用成本、变更影响面、兼容性和正确性指标；记账项目的双后端同名方法指标不适用于本项目。

## 备选比较

同时查看了 `j-easy/easy-rules` 和 `jknack/handlebars.java` 的当前源码树。
Easy Rules 的多表达式引擎适配与首个项目的多后端结构相似，且上游声明处于维护模式；
Handlebars.java 的多模块集成及模板资源使筛选和基线管理更复杂。
它们没有进行本地构建验证，不记为不合格。当前优先选择 cron-utils，是因为结构差异、规模和验证成本的组合更适合本实验。

## 基线验证

正式基线位于 `benchmarks/cron-utils/source/`，已应用固定日期测试夹具。
候选工作树与原始验证日志保留在 `.cache/candidates/`。

### 原始版本与测试环境归一化

原始 `mvn test` 的记录为：718 个用例，2 个失败、0 个错误、51 个跳过，日志为
`.cache/candidates/_buildlogs/cron-utils-9.2.1.log`。

两个失败来自 `CronConverterTest` 的 `America/St_Johns` 时区转换样例。
生产代码通过 `Calendar.getInstance(TimeZone)` 取得运行日期，测试却固定期待夏令时偏移；
在 11 月运行时，两项小时字段相差 1。此问题属于上游测试对日期的依赖，不能作为优化 Agent 的失败。

为形成稳定基线，单独保存了测试夹具补丁
`benchmarks/cron-utils/patches/fixed-date.patch`：只在该参数化测试内用已有 Mockito
固定 `Calendar.getInstance(TimeZone)` 的日期为各时区的 `2020-07-01 12:00:00`。
生产源码与既有预期断言保持原样。该测试的 12 个用例经定向验证全部通过。

另需使用 `-Djacoco.skip=true`：发布版附带的 JaCoCo 0.8.6 在 Java 17 上记录
`Unsupported class file major version 61` 插桩异常。此配置关闭覆盖率采集，不关闭测试。
因此，本实验基线的准确名称应是“9.2.1 + 固定日期测试夹具”，不能写成“上游原版直接全绿”。
该补丁和运行参数应在优化前冻结，并同样应用于原版组和优化组。

### 复现命令

```powershell
# 从仓库根目录运行已固化的基线
$repoRoot = (Get-Location).Path
& 'D:\Tools\apache-maven-3.9.14\bin\mvn.cmd' -B `
    -f benchmarks/cron-utils/source/pom.xml `
    "-Dmaven.repo.local=$repoRoot/.cache/maven" `
    '-Dfile.encoding=UTF-8' '-Djacoco.skip=true' test
```

从干净上游重建时，先固定到上述 SHA，再在上游源码根目录应用
`benchmarks/cron-utils/patches/fixed-date.patch`，然后运行相同测试参数。

依赖缓存完成后增加 `-o` 可离线运行；首次下载依赖的耗时不纳入 Agent 实现成本。
最终基线验证使用 `-o`，日志为 `.cache/candidates/_buildlogs/cron-utils-9.2.1-fixed-date.log`。
结果为 **BUILD SUCCESS**：718 个用例，667 个通过、51 个上游已有跳过，0 个失败、0 个错误；
Maven 总用时 14.792 秒。此耗时仅为基线测试运行时间，并非 Agent 变更成本。

本轮验证仅覆盖该候选：先记录原始结果，再定向验证失败测试的日期夹具，最后重跑候选全套测试以建立统一基线。
未修改当前实验生产代码，也无需运行记账项目或其他候选的测试。
