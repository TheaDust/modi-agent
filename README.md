# modi-agent

**基于 AI Agent 的软件体系结构可修改性优化** —— 课程大作业

> 研究命题：对可修改性做架构层面的**预先投资**，能否显著降低后续需求变更的实现成本？

---

## 实验全貌

```
                      上游开源项目 A（复式记账引擎）
                              │
                    ┌─────────┴─────────┐
                    │  Agent：可修改性优化 │   ← 唯一的架构改造
                    └─────────┬─────────┘
                              ▼
                      优化后代码 B（行为等价，架构更友好）
                              │
        ┌─────────────────────┼─────────────────────┐
        │  同一 Agent 实现同一组新需求 R1..R5        │
        ▼                     ▼                     │
   在 A 上改 → C        在 B 上改 → D               │
        │                     │                     │
        └──────────┬──────────┘                     │
                   ▼                                │
        diff(A,C)  vs  diff(B,D)  ← 核心证据链      │
                   │                                │
                   └──────── 累积 5 轮 → 架构劣化曲线┘
```

**唯一自变量**：起点代码是 A 还是 B。其余全部钉死（同一 agent、同一模型、同一提示词、同一工具集、同一对外 API 契约）。

---

## 目录

| 路径 | 内容 |
|---|---|
| `projectA/` | 上游项目 A（已固化，含 LICENSE 与 provenance） |
| `docs/00-candidate-selection.md` | **选型记录**：硬标准 + 30+ 候选逐一实测 |
| `docs/01-experiment-design.md` | **实验设计**：假设 / 控制变量 / 指标 / 反作弊 / 威胁有效性 |
| `docs/02-architecture-inventory.md` | **A 的架构体检报告**：异味清单 + 量化基线 |
| `docs/baseline-structure.json` | A 的架构指标基线快照 |
| `requirements/` | R1–R5 需求定义（规定对外 API，不规定实现位置） |
| `tools/structure.py` | 架构指标计算器（依赖图 / 环 / 层级违规 / 多后端重复规则） |
| `tools/` | 选型与验证脚本 |
| `prompts/` | 优化 / 实现需求 两类提示词（待建） |
| `agent/` | 被测 agent（待建） |
| `bench/` | 实验编排与 diff 指标（待建） |
| `results/` | 各轮产物与指标（待建） |

---

## 项目 A

| 项 | 值 |
|---|---|
| 上游 | [imetaxas/double-entry-bookkeeping-api](https://github.com/imetaxas/double-entry-bookkeeping-api) |
| SHA | `023535235e4151d43a18e6dc7ec8f473bcb59eac`（release 1.0.0） |
| 许可 | MIT |
| 规模 | 4 个 Maven 模块 · 62 个主源码文件 · 182 个测试**全绿且零外部服务** |

**为什么是它**（详见 `docs/00-candidate-selection.md`）：

1. **自带跨后端契约测试**（InMemory / H2 / Derby / HSQL / SQLite）→ 行为等价性有客观判据，不靠 agent 自述；
2. **存在真实且可量化的架构异味** → 优化有实质空间，差异可测；
3. **零外部服务依赖** → 评审者与复现者可离线一键跑通。

### A 的架构基线（优化靶子）

| 指标 | 值 |
|---|---|
| 包间循环依赖 | **2** |
| 层级违规（业务包 → 持久化包） | **1**（`validation → dao`） |
| **被 memory / jdbc 双后端各实现一遍的业务规则** | **21**（含 `transferFunds`、`storeTransaction`） |
| public API 面积 | 58 类型 / 242 方法 |

第三条是本实验的核心：**A 上加一条业务规则（如转账限额）要改两处**；B 若把规则收敛到单一处，只需改一处。

---

## 复现

```powershell
# 构建并跑全部测试（无 Docker、无外部服务）
cd projectA
& 'D:\Tools\apache-maven-3.9.14\bin\mvn.cmd' -B test

# 架构指标基线
python tools\structure.py projectA --json docs\baseline-structure.json
```
