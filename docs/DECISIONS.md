# 重要决策记录

本文件是重要决策的索引和当前约束摘要。具体设计细节以链接文档为准；新决策按日期追加，说明背景、选择、理由和影响。

## 已确认决策

### 2026-10-21：持续使用本地模拟 Metrics+Logs 验收

- **选择：** 后续常规开发和验收始终使用本地模拟指标与日志；不为验证 Agent 重新部署或更改 `group-buy-market`，也不把真实业务数据源接入作为验收前提。
- **理由：** 保持验证可重复，并让 Agent 侧开发不改变被监测项目的运行状态。
- **影响：** simulation Profile 的 Episodic 案例可按配置要求的来源沉淀；未配置的 Trace 缺口保留为限制，但不阻止满足 `requiredSources` 的案例通过质量门。配置与启动步骤见[模拟记忆本地启用指南](./guides/diagnostic-memory-local.md)。真实目标或生产数据接入需用户之后明确改变此约束。

### 2026-09-07：Event/Message V2 为事件与消息协议基线

- **选择：** V2 作为新增实现的完整协议；通过兼容投影维持 V1 使用方，不破坏性修改已发布契约。
- **理由：** 需要强类型事件、流式消息、重放、审计和可恢复运行的一致边界。
- **影响：** 契约细节见 [Event 与 Message V2](./architecture/15-event-message-v2.md)；相关验收状态见 [V2 验收状态](./event-message-v2-acceptance-status.md)。修改事件、消息、ToolResponse 或持久化 Schema 前，先更新设计和迁移方案。

### 2026-09-06 起：独立实现与只读诊断优先

- **选择：** 本仓库 clean-room 独立实现；V1 生产组装以只读诊断为界，真实写操作不进入默认路径。
- **理由：** 保持代码来源清晰，并限制诊断系统对被监测业务的影响。
- **影响：** 真实动作必须另行设计并满足白名单、HITL、审计、幂等和验证要求。详见 [AGENTS.md](../AGENTS.md) 与 [产品范围](./architecture/01-product-scope-and-roadmap.md)。

### 2026-10-11：多项目适配按可信身份和严格归属推进

- **选择：** 多项目能力基于可信 Target 绑定、冻结快照、单一持久化所有者及严格归属校验；不从当前 Profile 或模型文本推断历史 Run 身份。
- **理由：** 防止跨项目数据混用和旧 Run 被错误恢复。
- **影响：** M2b 旧 Run 迁移须先有历史自身可核验的身份元数据并逐条审核。当前盘点未找到候选，见 [M2b 盘点](./verification/2026-10-21-m2b-inventory.md)。设计细节见 [多项目适配 Spec](./superpowers/specs/2026-10-11-multi-project-adaptation-design.md)。

### 2026-10-21：Target Run 的可选记忆偏好

- **选择：** 创建 Target Run 可传可选的 capture/recall 偏好；Target 身份和记忆作用域仍由宿主冻结快照决定。
- **理由：** 让用户在既有策略范围内选择记忆行为，同时保持创建请求的幂等语义。
- **影响：** 旧请求摘要和行为保持兼容；新偏好纳入摘要，同一幂等键的不同偏好冲突。契约记录见 [Target 记忆偏好决定](./superpowers/decisions/2026-10-21-target-memory-preferences.md)。当前工作区有未提交实现，完成状态须另行验收。

### 2026-10-21：顶层 Run 准入上限

- **选择：** 单进程协调器默认最多并发执行 2 个顶层 Run，等待队列最多 32 个；宿主可在安全上限内覆盖。Target 启动在等待执行槽期间不持有启动租约。
- **理由：** 多 Target 共享 Agent 进程资源，需要对单项目突发请求提供有界、FIFO 的准入。
- **影响：** 启动和恢复共用协调器准入；父 Run 内的子调查不重复占用顶层槽。限制不跨进程。细节见 [Root Run 准入决定](./superpowers/decisions/2026-10-21-root-run-admission-limit.md)。

## 待实施设计（尚未发布为运行时契约）

### 2026-10-21：本地只读巡检产品化

- **方案：** [Spec](./superpowers/specs/2026-10-21-local-inspection-product-design.md)与[Plan](./superpowers/plans/2026-10-21-local-inspection-product.md)提出单进程、loopback、本地模拟来源的产品交付路径；优先接通现有 Target/记忆机制，再补周期调度、站内结果处理与运维。
- **兼容边界：** 保留旧 simulation、冻结快照、记忆晋级、HITL 和 V2 契约；不扩大真实动作或业务访问范围。在线模型验收独立 opt-in；外部通知不在本版范围。
- **实施前门槛：** S1/S2 若需要公共端口扩展，应先记录兼容决定；S4 的 Schedule/Occurrence Schema 与事务对账、S5 的独立处理状态/报告 DTO、S6 的恢复与引用保护须分别形成详细决策和迁移验证后再实施。当前文档不是上述新增接口已发布或功能已完成的证明。

## 决策门槛

公共契约、Harness 顺序、Guard/Hook/HITL 职责、自动写操作、Checkpoint/记忆资格语义、持久化后端或核心依赖方向发生变化时，必须先补充本记录及对应设计文档，再实施。日常实现选择不需要写入本文件。
