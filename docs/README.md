# 巡检诊断 Agent 架构知识库

本目录是 `agentops` 的架构事实来源（Architecture Knowledge Base）。文档描述已确认的目标设计；代码是否已经实现，以各文档的“实现状态”说明和仓库源码为准。

## 新对话入口

先读 [项目概览](./PROJECT.md)、[当前状态](./STATUS.md)、[重要决策](./DECISIONS.md) 和 [开发规则](../AGENTS.md)，然后核对 Git 状态及本次任务相关代码。下文包含历史阶段记录；当前进度以代码、本次检查和 `STATUS.md` 的时间戳共同判断。

## 阅读顺序

1. [产品边界与迭代路线](./architecture/01-product-scope-and-roadmap.md)
2. [总体架构与模块边界](./architecture/02-system-architecture.md)
3. [Agent Harness 与运行状态机](./architecture/03-agent-harness.md)
4. [统一 Tool、四道闸门与重试](./architecture/04-tool-system.md)
5. [数据源 Subagent 与 MCP](./architecture/05-subagents-and-mcp.md)
6. [Guard、Hooks、HITL 与动作安全](./architecture/06-guard-hooks-hitl.md)
7. [上下文、压缩、记忆与持久化](./architecture/07-context-memory-storage.md)
8. [可观测、LangSmith 与审计](./architecture/08-observability.md)
9. [遥测模拟器、前端与触发入口](./architecture/09-simulator-and-apps.md)
10. [可靠性、测试、评测与验收](./architecture/10-reliability-and-evaluation.md)
11. [公共契约与工程约束](./architecture/11-contracts-and-engineering.md)
12. [MCP 只读接入实现](./architecture/12-mcp-implementation.md)
13. [指标实验链路实现与复验](./architecture/13-metrics-lab-implementation.md)
14. [结算指标 MCP 与证据闭环](./architecture/14-settlement-mcp-evidence.md)
15. [Event 与 Message V2 协议](./architecture/15-event-message-v2.md)

完整 V1 设计基线见 [巡检诊断 Agent V1 设计规格](./superpowers/specs/2026-09-06-inspection-agent-v1-design.md)。

多项目适配的设计与阶段边界见 [多项目巡检适配设计 Spec](./superpowers/specs/2026-10-11-multi-project-adaptation-design.md)。已有阶段和未完成阶段须分别依据代码、验收记录及 [当前状态](./STATUS.md) 核对；该 Spec 不代表所有阶段均已完成，也不改变既有 simulation 验收入口。

受控诊断记忆一期见 [Spec R2](./superpowers/specs/2026-10-10-governed-diagnostic-memory-design.md)、[逐文件实施计划](./superpowers/plans/2026-10-10-governed-diagnostic-memory.md) 和[本地验收指南](./guides/diagnostic-memory-local.md)。阶段 A 已实现 Episodic 保存、人工审核/撤销、同范围有界召回、SQLite 持久化与暂停恢复重新校验；Working 状态复用 Checkpoint。2026-10-13 的 [完整治理记忆验收记录](./implementation-status.md#2026-10-13完整治理记忆系统-t5t7-收口) 记录了 Semantic/Procedural 治理、检索及只读 UI 的离线验收；自动晋级和自动动作仍未实现。向量记忆 V3 影子检索与对照入口已实现，真实语义效果待真实包验收。

向量存储可用性独立按 [向量实验 Spec](./superpowers/specs/2026-10-10-memory-vector-feasibility-design.md) 与 [向量实验计划](./superpowers/plans/2026-10-10-memory-vector-feasibility.md) 推进。V1 本地 Embedding 包解析、V2 SQLite Float32 索引/隔离/重启机制已实现；V3 影子检索、BM25 故障降级和 BM25/向量/混合离线对照入口已实现。实验默认关闭且不影响案例保存；无真实 Embedding 包不能宣称真实语义检索通过，也不修改生产召回默认。

Durable Run State & Evidence 的早期设计见 [设计文档](./superpowers/specs/2026-09-10-durable-run-state-evidence-design.md)。仓库现已有 SQLite durable state、Checkpoint 和证据实现；具体覆盖范围以相关代码与 [实现进度](./implementation-status.md) 核对，该历史设计不能直接当作当前缺口清单。

ELK 大体量证据的设计基线见 [流式摄取与 BlobStore 设计](./superpowers/specs/2026-09-10-elk-large-evidence-blob-storage-design.md)。仓库已有分页取证、本地 BlobStore 和 Manifest 相关实现；对象存储与生产规模验收应按当前代码和验收记录另行确认。

最新已实现能力与检查结果见 [实现进度](./implementation-status.md)。

2026-10-05 本机 Prometheus、Elasticsearch 测试后端和浏览器验收的范围、结果与生产边界见[本轮验收记录](./verification/2026-10-05-local-acceptance-closeout.md)。

个人开发环境的一次性真实模型/LangSmith 验收入口及人工复核操作见 [真实模型与 LangSmith 联合验收指南](./guides/real-model-langsmith-acceptance.md)。指南只描述受限烟测机制，不代表已经执行线上验收。

V2 分支文档与代码的一致性审计见 [V2 文档审计记录](./documentation-audit-v2.md)。

## 文档状态

- 决策状态：已由项目负责人确认，可用于拆分实施计划。
- 当前代码状态以 [当前状态](./STATUS.md) 和本次 Git/源码核查为准。Event/Message V2、内存/SQLite 存储、公共投影、暂停恢复、Agent Web 及治理记忆已有实现；本机 Prometheus/MCP 和日志浏览器验收使用模拟数据，不等于目标业务或生产观测栈验收。在线模型、真实业务数据效果、真实向量语义效果、托管 CI 和真实动作仍需分别核验，详见[实现进度](./implementation-status.md)。
- 代码来源：本项目独立实现。Newton 仅用于机制参考；不得把未获授权的公司源码复制到本仓库。
- 第一阶段：只读诊断和模拟验证，不接入真实写动作，也不读取业务仓库代码。
- 向量记忆实验 V3 已提供独立影子检索、BM25 故障降级与离线对照入口 `pnpm acceptance:memory-vector`；默认关闭，不更改基础记忆召回。缺少经来源复核的真实 Embedding 包时只验证机制，不宣称语义效果通过。

## 变更规则

公共事件、消息块、`ToolResponse`、Harness 顺序、HITL 语义、Checkpoint Schema 或自动写动作发生变化前，必须先更新设计决策，再修改实现。根目录 [AGENTS.md](../AGENTS.md) 的安全和依赖约束优先级最高。
