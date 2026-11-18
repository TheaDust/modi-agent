# cron-utils 基准项目

cron 表达式处理库，用于观察解析、语义模型、时间求值和自然语言描述之间的变更传播。

| 路径 | 内容 |
|---|---|
| [source/](source/) | 9.2.1 源码及固定日期测试夹具 |
| [provenance.json](provenance.json) | 固定提交、已应用补丁、测试参数与基线结果 |
| [selection.md](selection.md) | 选型依据、适用范围和验证说明 |
| [patches/fixed-date.patch](patches/fixed-date.patch) | 固定时区转换测试日期的补丁 |

`source/` 已应用该补丁。生产源码与上游固定提交一致；测试基线为 667 个通过、51 个上游已有跳过。
需求集尚未定义；确定后放入本案例的 `requirements/`。

从仓库根目录运行基线测试：

```powershell
$repoRoot = (Get-Location).Path
& 'D:\Tools\apache-maven-3.9.14\bin\mvn.cmd' -B `
    -f benchmarks/cron-utils/source/pom.xml `
    "-Dmaven.repo.local=$repoRoot/.cache/maven" '-Djacoco.skip=true' test
```

依赖已缓存时可增加 `-o` 离线运行。
公共实验设计见 [docs/experiment-design.md](../../docs/experiment-design.md)。
