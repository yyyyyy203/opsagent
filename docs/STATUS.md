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
- 新增 `pnpm e2e:memory:multisource` 浏览器闭环验收：本地 Metrics+Logs 模拟 Run、手动沉淀、UI 审核、多来源案例同 scope 再次召回，以及 Trace 缺口展示。验收发现并修复终态 Run 后记忆面板未刷新、子 Run 证据导致前端审核按钮禁用，以及召回预算把不会进入提示词的证据引用计入字节数三个问题；召回仍保留完整证据引用供审计。
- 普通 `apps/agent-server` 仍没有 Target Runtime/知识治理 Host，所以 Semantic/Procedural Target 知识流程不随本配置启用；本配置验证的是 simulation Profile 上的 Episodic 记忆。

## 前次实现验证记录（本次文档任务未重跑）

- `pnpm lint`：本轮通过。
- `pnpm test`：215 个文件通过、5 个 opt-in 文件跳过；2244 项通过、9 项跳过。
- `pnpm acceptance:memory`：本轮通过 13 项 checks 和 6 格策略矩阵；`modelRequestsSent=0`、`externalRequestsSent=0`、`externalRequestsBlocked=0`。
- 新增的组合来源集成测试：Metrics+Logs 子 Run 均完成，记忆案例含 `metric` 与 `log` 两类证据引用且可审核通过；未配置的 Trace 缺口保留在案例限制中。
- `pnpm e2e:memory:multisource`：浏览器闭环 1/1 通过（该脚本同时完成 core build 与 Web build）；`pnpm exec vitest run test/memory-recall.test.ts`：35 项通过；本轮 `pnpm lint`、`pnpm typecheck` 和 `pnpm web:typecheck` 通过。
- 多 Target、capacity/load 验收为此前 M5 记录，本轮没有重跑这些场景。
- 本轮 `pnpm test` 和 `pnpm acceptance:memory` 都包含 `pnpm build`，构建通过。
- 此前完整回归记录见 [M5 验收记录](./verification/2026-10-21-multi-project-m5-acceptance.md)。
- `pnpm e2e:multi-target`：1/1 通过。
- `pnpm acceptance:multi-target-capacity`、`pnpm acceptance:multi-target-load`：通过。

新增验收均使用本地模拟 Target、ScriptedModel 和模拟来源，没有连接真实 `group-buy-market`、生产 Prometheus/ELK、在线模型或 LangSmith。因此，真实业务目标接入和生产验收仍是后续阶段；M2b 若要继续，需要宿主提供旧数据库及可信历史身份元数据来源。

## 下一步

正在实施[多来源记忆异常与隔离验收 Spec](./superpowers/specs/2026-10-21-multisource-memory-resilience-design.md)及[阶段 A–D 计划](./superpowers/plans/2026-10-21-multisource-memory-resilience.md)。阶段 B、C 的来源异常、Target 隔离和召回过期验收已通过；阶段 A/R12 对非 `fetch` 网络栈和通用用例重置仍有边界。逐项结果、命令和限制见[验收记录](./verification/2026-10-21-multisource-memory-resilience-acceptance.md)。所有验收使用本地模拟服务，不需要重新部署 `group-buy-market`。M2b 仍需可证明身份的旧数据。

## 前次方案文档任务（2026-10-21）

- 已新增 Spec 和 Plan，关联 PROJECT 与本状态文件；新增行为均标为待实施，没有产品代码或测试代码变更。
- 本任务涉及四份文件：上述 Spec、Plan、`docs/PROJECT.md`、`docs/STATUS.md`。开始时工作区干净；阶段 A–D 未启动。
- 已检查当前分支 `codex/event-message-v2`、远端、既有测试和记忆接口；`git diff --check` 通过，四份文档的 25 个本地链接有效，R01–R12 矩阵及 A–D 未开始状态检查通过。核心/Web 构建和测试未运行：本次仅修改文档，不沿用前次结果作为通过依据。
- 未触发契约、Schema、审核/晋级语义变更，不新增设计决策；后续实施若触发门槛，先补决策。
- 四份方案文档已独立提交为 `74c9bdb`；GitHub 同步受阻，文档交付尚未满足推送完成条件。首次推送返回 `Error in the HTTP2 framing layer`；仅对重试命令改用 HTTP/1.1 后，仍在约 75 秒后无法连接 `github.com:443`。未修改全局 Git 配置，不能宣称远端已同步。
- 待办：网络恢复后核对远端分支，再推送当前 `codex/event-message-v2`（包含本条阻塞记录）并核对远端提交；如远端已变化，先处理差异，禁止强推。下一步实施不包含在本次文档交付内。

## 当前实施任务（2026-10-21）

- 用户授权按 Spec/Plan 实施，并补充 AGENTS 规则。本轮范围仍是本地模拟验证。
- 更新 AGENTS.md §18，明确多模块/核心/分阶段任务需先检查并维护 `docs/superpowers/specs/`、`plans/`，STATUS 链接必须准确区分方案、实施和验收；既有授权决定是否实施。
- 阶段 A 部分完成：ScriptedModel 根据真实 ToolResult 有界分支；本地 `fetch` 请求统计与禁止目的地拦截自测、来源 Abort 已验证。Clock 注入、用例级状态重置以及全传输栈观测未完整覆盖。
- 阶段 B 完成：Metrics/Logs 单侧失败、Metrics 超时、Logs partial 的浏览器矩阵通过；不足案例保持 observation 且不可批准。
- 阶段 C 完成：Target Web+SQLite 闭环覆盖 A 采集、批准、召回，切换 B 后无 A 案例/模型输入，跨 Target 证据和审核请求返回 404；R08 用夹具 Clock 验证到期前、相等、之后三点，UI 标记过期但不改写已批准状态。新增 Target Profile `profile/v1` 校验回归，原配置校验器曾拒绝此快照版本格式。
- 阶段 D 质量门：`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm web:typecheck`、`pnpm web:build` 通过；`TMPDIR=/private/tmp pnpm test` 通过（215 文件通过、5 个 opt-in 文件跳过；2247 项通过、9 项跳过）；`TMPDIR=/private/tmp pnpm acceptance:memory` 通过（13 checks、6 策略行）；多来源 E2E 3/3、多 Target E2E 2/2、记忆 Web E2E 10 通过/1 跳过、禁用模式 1/1 通过。明细见验收报告。
- 测试环境 Node.js v24.19.0，pnpm v11.25.0（与仓库声明的 v11.19.0 不同）。全量测试/验收使用 `/private/tmp` 规避 macOS 临时目录符号链接问题；浏览器测试需本机 loopback 权限。
- 第一阶段改动已提交并推送：`0f33332 test: cover memory source failures and target isolation`。Target 记忆闭环及到期行为已独立提交为 `0ef4634 test: verify target episodic memory isolation`。最近一次 `git fetch origin codex/event-message-v2` 和该提交的普通 `git push origin codex/event-message-v2` 均在约 75 秒后因无法连接 `github.com:443` 失败；本地 `origin/codex/event-message-v2` 跟踪 ref 仍指向旧提交 `7af008d`，比较结果受陈旧 ref 影响，不能据此声明远端同步。待网络恢复后先 fetch 核对远端；无远端独有提交时普通 push，有新提交则先整合，禁止强推。
- 后续状态收尾记录将在推送恢复后再次同步；当前实现与验收已本地提交，GitHub 同步仍受阻。
- 未触发公共契约、Schema、Harness 顺序、Guard/Hook/HITL 或晋级语义变更，无需新增 DECISIONS 记录。`git diff --check` 当前通过。
- 下一步：GitHub 网络恢复后 fetch 并重试普通 push，确认 `0ef4634` 已同步。计划仍有阶段 A/R12 的覆盖限制，不能标记整体完成。

此前逐文件实施记录：[M4 计划](./superpowers/plans/2026-10-20-multi-project-m4.md)、[M5 计划](./superpowers/plans/2026-10-20-multi-project-m5.md)、[M2b 计划](./superpowers/plans/2026-10-20-multi-project-m2b.md)。
