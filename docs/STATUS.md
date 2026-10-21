# 项目状态

更新时间：2026-10-21（Asia/Shanghai）

当前仓库：`/Users/yumohan/Documents/ChatGPT/巡检项目/opsagent`

当前分支：`codex/event-message-v2`

GitHub 远端：`https://github.com/yyyyyy203/opsagent.git`

## 当前阶段

- **M4：完成。** Target 工作台、作用域读写边界、旧入口隔离、Target 记忆和双模式 Web 已实现并通过回归。
- **M5：完成（本地模拟验收）。** Spec §13 的适用项、双 Target 浏览器、容量、负载及全仓质量门通过。结果和限制见 [M5 验收记录](./verification/2026-10-21-multi-project-m5-acceptance.md)。
- **M2b：M2b.1 盘点完成，M2b.2 未触发。** 当前工作树未发现数据库文件，`AGENTOPS_DATA_DIR` 未配置，没有可核验候选；未创建历史绑定或迁移写路径。详见 [M2b 盘点报告](./verification/2026-10-21-m2b-inventory.md)。

## 持续模拟验证与记忆接线（2026-10-21）

- 按用户确定的验证约束，后续常规开发持续使用本地模拟 Metrics+Logs，不重新部署或修改 `group-buy-market`。该约束已写入 [AGENTS.md](../AGENTS.md)、[PROJECT.md](./PROJECT.md) 和[决策记录](./DECISIONS.md)。
- `apps/agent-server` 原本已支持通过 `AGENTOPS_MEMORY_ENABLED` 和 `AGENTOPS_MEMORY_CONFIG` 启用 simulation Profile 的 Episodic 记忆，默认关闭。本轮新增双来源模拟配置 [diagnostic-memory-simulation.json](../examples/diagnostic-memory-simulation.json)，并补充本地启用指南。
- 修复记忆完整性判定：Profile 未把 Trace 列入 `requiredSources` 时，缺少 Trace 仍留在案例 `limitations`，但不会覆盖已完整的指标/日志证据质量；必需来源缺失、证据 partial 或窗口/归属无效仍不通过。模拟双来源集成验证已实际沉淀并审核一条包含 metric+log 引用的案例。
- 普通 `apps/agent-server` 仍没有 Target Runtime/知识治理 Host，所以 Semantic/Procedural Target 知识流程不随本配置启用；本配置验证的是 simulation Profile 上的 Episodic 记忆。

## 验证

- `pnpm lint`：本轮通过。
- `pnpm test`：215 个文件通过、5 个 opt-in 文件跳过；2244 项通过、9 项跳过。
- `pnpm acceptance:memory`：本轮通过 13 项 checks 和 6 格策略矩阵；`modelRequestsSent=0`、`externalRequestsSent=0`、`externalRequestsBlocked=0`。
- 新增的组合来源集成测试：Metrics+Logs 子 Run 均完成，记忆案例含 `metric` 与 `log` 两类证据引用且可审核通过；未配置的 Trace 缺口保留在案例限制中。
- `pnpm typecheck`、Web build/typecheck 与多 Target/capacity/load 验收为此前 M5 记录，本轮没有重跑这些命令。
- 本轮 `pnpm test` 和 `pnpm acceptance:memory` 都包含 `pnpm build`，构建通过。
- `pnpm web:typecheck`、`pnpm web:build`：此前通过，本轮没有重跑。
- `pnpm e2e:multi-target`：1/1 通过。
- `pnpm acceptance:multi-target-capacity`、`pnpm acceptance:multi-target-load`：通过。

新增验收均使用本地模拟 Target、ScriptedModel 和模拟来源，没有连接真实 `group-buy-market`、生产 Prometheus/ELK、在线模型或 LangSmith。因此，真实业务目标接入和生产验收仍是后续阶段；M2b 若要继续，需要宿主提供旧数据库及可信历史身份元数据来源。

## 下一步

下一步用本地 Logs Lab 的 `settlement_failure` 模拟场景启动 Metrics+Logs Web 工作台，按[本地记忆指南](./guides/diagnostic-memory-local.md)启用配置，并在页面完成一次 Run、手动沉淀、审核及后续同 scope 召回的人工闭环验收。此浏览器手动路径尚未在本轮执行；当前确认依据是确定性组合来源集成测试和离线记忆验收。继续 M2b 仍需宿主提供可证明身份的旧数据。

逐文件实施记录：[M4 计划](./superpowers/plans/2026-10-20-multi-project-m4.md)、[M5 计划](./superpowers/plans/2026-10-20-multi-project-m5.md)、[M2b 计划](./superpowers/plans/2026-10-20-multi-project-m2b.md)。所有本轮改动按仓库要求提交并推送至 `origin/codex/event-message-v2`；同步状态以 `git status` 和本地/远端提交比较为准。
