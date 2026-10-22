# 项目状态

更新时间：2026-10-22（Asia/Shanghai）

当前仓库：`/Users/yumohan/Documents/ChatGPT/巡检项目/opsagent`

当前分支：`codex/event-message-v2`

GitHub 远端：`https://github.com/yyyyyy203/opsagent.git`

## 最新任务：本地多项目只读巡检系统 S1 / S2（2026-10-22）

### 后续推进记录（2026-10-22）

- 按 S2 计划继续补普通 Target 宿主生命周期组合验收：有效期内 A 召回三条已发布知识；撤销 Procedural 后不再注入；推进固定 Clock 并重启后过期 Semantic 不再注入、未过期 Semantic 仍可召回；记忆关闭后所有三条均不注入。新增的 Web 浏览器闭环通过草稿、提交审核、批准、发布、A 模型输入确认及 B 隔离。
- 本轮实际检查：`pnpm lint`、`pnpm typecheck`、`pnpm web:typecheck` 通过；`pnpm e2e:local-inspection` 重跑 2/2 通过（首次双 Target 案例有一次模拟 Metrics 瞬态未产出证据）；`TMPDIR=/private/tmp pnpm test` 全量 218 文件通过、5 个 opt-in 文件跳过，2259 项通过、9 项跳过。全量测试在默认沙箱第一次运行受 loopback `EPERM` 影响，提升本机回环权限后重跑通过。详细结果见[验收记录](./verification/2026-10-22-local-knowledge-integration.md)。
- 本轮工作树改动包括宿主生命周期测试、Web 测试夹具/用例、S2 Plan 与验收/状态文档。尚未提交或推送；需先独立暂存本任务文件、复核分支和远端，再普通推送并核对远端 SHA。
- 下一步仍是完成 S2 遗留组合验收：拒绝后不注入、来源状态变化、治理存储故障/超时、显式 Abort、required 知识缺失 Run 门禁和三类记忆预算断言。S2/L04–L05 继续保持进行中。

- 继续 S2.2 后，普通本地 Target 宿主可走通 Semantic/Procedural 创建、提交、单操作员审核、发布和召回。新增了明确的 loopback 单操作员决策和 4 KiB 知识输入上限；修复发布 policy overlay 校验、FTS 全词 AND 漏召回以及 limit 64 超出存储上限的问题。Episodic 保持既有 1 KiB renderer 上限和审核资格规则。详细范围/限制见[本地知识验收记录](./verification/2026-10-22-local-knowledge-integration.md)。
- 本轮最终检查：`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm web:typecheck`、`pnpm web:build` 通过；`TMPDIR=/private/tmp pnpm test` 为 218 文件通过、5 个 opt-in 文件跳过，2259 项通过、9 项跳过；`TMPDIR=/private/tmp pnpm acceptance:memory` 的 13 项检查和六格策略矩阵通过；本地巡检 E2E 1/1（首次瞬态失败、重跑通过）、多 Target E2E 2/2、多来源独立 E2E 7/7 通过。集成类命令使用 loopback 权限；默认沙箱 EPERM 不作为通过依据。
- S2.2 正向组合验收通过，但 S2/L04–L05 不标完成：Target 宿主的拒绝/撤销/到期、来源状态变化与失败路径、必需知识门禁和 Web 治理操作尚未全部组合验收。

- 用户已授权按计划实施。当前分支 `codex/event-message-v2`，S2.2 实施前 HEAD 为 `fddb10b`；其父提交 `7b2fc7c` 为 S1、`fddb10b` 为 S2.1。S2.2 实现、测试、示例与方案/验收文档已独立提交为 `65cedc9`，状态文档为 `be30bd2`。Node v24.19.0，pnpm v11.25.0（仓库声明 11.19.0）。本轮远端核验记录将在后续文档提交中纳入。
- 远端收尾：提升网络权限后核对 `origin/codex/event-message-v2` 为 `1aab521151a32a517cd8e11387a33a23d389e41e`，确认它是本地 HEAD 祖先；随后普通推送 S1、S2.1、S2.2 与状态提交。推送后 `git ls-remote` 返回 `be30bd277c2b3932a53097fd22f7a5354fe9247c`，与当时本地 HEAD 一致。当前这条远端核验记录会另作文档提交。
- S1 的 L01–L03 验收见[产品验收记录](./verification/2026-10-22-local-inspection-product-acceptance.md)。S2.1 的运行时 seam 回归为 47 项通过；本轮 lint、typecheck、build 与新增 S2.2 检查结果见[本地知识验收记录](./verification/2026-10-22-local-knowledge-integration.md)。
- 下一步：继续 S2 的剩余组合验收：拒绝/撤销后不召回、到期与来源撤销边界、存储失败/超时/Abort、必需知识门禁及浏览器草稿审核发布，并补明确的预算断言。S2 整体仍进行中，S1/S2.2 通过不代表产品成熟或可生产上线。

## 当前阶段

- **M4：完成。** Target 工作台、作用域读写边界、旧入口隔离、Target 记忆和双模式 Web 已实现并通过回归。
- **M5：完成（本地模拟验收）。** Spec §13 的适用项、双 Target 浏览器、容量、负载及全仓质量门通过。结果和限制见 [M5 验收记录](./verification/2026-10-21-multi-project-m5-acceptance.md)。
- **M2b：M2b.1 盘点完成，M2b.2 未触发。** 当前工作树未发现数据库文件，`AGENTOPS_DATA_DIR` 未配置，没有可核验候选；未创建历史绑定或迁移写路径。详见 [M2b 盘点报告](./verification/2026-10-21-m2b-inventory.md)。

## 前轮多来源记忆韧性实施结果（2026-10-21；同步状态见最新任务）

- 按[实施计划](./superpowers/plans/2026-10-21-multisource-memory-resilience.md)完成阶段 A/B，并回归阶段 C；没有修改产品运行时、公共契约、数据库 Schema 或审核资格语义。R01–R12 结果见[验收记录](./verification/2026-10-21-multisource-memory-resilience-acceptance.md)。
- 多来源夹具改用进程启动时固定的场景和 `2026-10-21T12:00:00.000Z` Clock；七个浏览器用例各用新的 Agent/Web 进程、SQLite 临时目录、调用统计和模型实例。每个用例从空案例/零调用开始，退出后由启动器清理目录并核对端口已释放。
- Metrics 的真实 7 秒超时由来源侧收到 `TimeoutError` Abort 证明；错误、截止和 Logs partial 场景都直接请求审核 API，收到 422/`MEMORY_APPROVAL_DENIED`，回读后案例仍为 observation、revision 未变。案例证据引用核对了 ownerRunId、evidenceId、采集时间和 SHA-256。
- 请求边界限于浏览器请求与 Node `globalThis.fetch`；本夹具 MCP SDK 的 `GET/POST /mcp` 均经 `fetch` 记录。禁止目的地自测在连接前被阻断；不声称覆盖原生 socket 或其他进程。
- 本次实际检查通过：`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm web:typecheck`、`pnpm web:build`；`TMPDIR=/private/tmp pnpm test`（215 个文件通过、5 个 opt-in 文件跳过；2247 项通过、9 项跳过）；`TMPDIR=/private/tmp pnpm acceptance:memory`（13 项、六格策略矩阵）；`pnpm e2e:memory:multisource`（7/7 个独立场景）；`pnpm e2e:multi-target`（2/2）；记忆 Web（10 通过、1 按配置跳过）及 disabled baseline（1/1）。本状态更新后 `git diff --check` 通过。
- Git 基线为分支 `codex/event-message-v2`、实施提交 `fb8355f85358c61a7a0fecab5e51927b9310cab2`；Node v24.19.0、pnpm v11.25.0（声明目标 v11.19.0）。任务变更包括 E2E 配置、夹具、用例启动器、lint 配置、`package.json`、Spec、Plan、验收记录和本文件。
- 交付阻塞：`git ls-remote origin refs/heads/codex/event-message-v2` 因 `Could not resolve host: github.com` 失败，远端 SHA 不能核对；后续重试仍未返回远端结果。实施提交已在本地，未尝试推送以免在无法确认远端分支时写入。网络恢复后先查询分支、确认无远端独有提交，再普通推送并核验远端 HEAD。目前不得称已同步。

## 历史重排快照（2026-10-21；已由最新任务及前轮实施结果更新）

1. **在途提交收尾：已完成。** GitHub 分支经 `ls-remote` 核对原为 `a004da1`，确认该提交是本地 HEAD 祖先后普通 push；推送后远端 HEAD 核对为 `18f2753`，包含此前重排、阻塞记录及本次方案修订。文档中的仓库路径 `/Users/yumohan/Documents/ChatGPT/巡检项目/opsagent` 与实际路径一致，无需改写。
2. **多来源计划：R08、R09 已完成，不再列作缺口。** R08 到期边界和过期 UI、R09 A 采集/批准/召回及切换 B 后隔离已有浏览器证据。新一轮审阅发现 B 尚缺真实计时器超时取消、异常案例直接请求后端批准的组合验收；A/R12 尚缺多来源业务 Clock 和独立用例状态隔离。请求观测当前覆盖 Node `fetch` 与浏览器请求，其他入口按实际调用链界定。修订的逐文件方案见[实施计划 §7](./superpowers/plans/2026-10-21-multisource-memory-resilience.md)。
3. **Semantic/Procedural 运行时接线：暂缓。** 普通 `apps/agent-server` 目前不组装 Target Runtime/知识治理 Host；这两类 Target 知识流程尚未接入常规运行时。本阶段继续以 simulation Profile 的 Episodic 记忆和本地模拟来源为验收范围，接线另立 Spec/Plan 后再做。
4. **认证授权：外部开放前的发布门槛。** 当前本地单操作员模拟验收不以此为阻塞；若将记忆审核 API 暴露给其他用户或网络边界，须先为 `/memory/cases/:id/review` 等审核入口定义并验证身份、角色和审计归属。

## 历史方案修订快照（2026-10-21）

- 目标：把前次审阅指出的真实超时、后端审核拒绝、Clock 与用例隔离缺口形成可执行的逐文件方案；本轮只修改方案文档，不把计划项记为已实施。
- 范围：修订[Spec](./superpowers/specs/2026-10-21-multisource-memory-resilience-design.md)、[Plan](./superpowers/plans/2026-10-21-multisource-memory-resilience.md)、`docs/PROJECT.md` 和本文件。修改分类为测试基础设施/适配器组合验收方案；不涉及公共契约、持久化 Schema、HITL、写动作或依赖方向，故本轮无新增设计决策和迁移。
- 本次检查：开始时 `git status --short` 干净；`git diff --check` 通过；四份修订文档的 29 个本地 Markdown 链接均可解析。未运行 lint、typecheck、test、build 或浏览器测试，因为本轮没有实现代码改动；前次测试结果仍只属于前次代码基线。
- Git 交付：本次方案提交 `18f2753` 与此前两项待推送提交已通过普通 push，同步后再次 `ls-remote` 核对远端 HEAD 为 `18f2753`。本次状态订正作为独立提交交付，其远端结果以最新 Git 状态为准。
- 下一步：按 Plan §7 分阶段实施、重新执行质量门并更新验收报告。本轮提交前的未提交文件仅为上述四份方案文档；本次状态订正只修改本文件。

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

## 当前下一步

1. 本地只读巡检 Spec/Plan 已完成文档校验并在 `34b91af` 推送核验；实施从 S0 重新核对当时基线。最新结果见顶部任务记录。
2. 产品实施按新 Plan 的 S0–S6 推进，当前尚未启动。先解决普通 `apps/agent-server` 的 Target 双来源与受治理知识接线，复用既有机制和测试。
3. 在线模型质量单独验收；对外认证授权、真实业务接入和外部告警/通知另立方案。M2b 没有可信旧数据时不触发迁移。

## 前次方案文档任务（2026-10-21）

- 已新增 Spec 和 Plan，关联 PROJECT 与本状态文件；新增行为均标为待实施，没有产品代码或测试代码变更。
- 本任务涉及四份文件：上述 Spec、Plan、`docs/PROJECT.md`、`docs/STATUS.md`。开始时工作区干净；阶段 A–D 未启动。
- 已检查当前分支 `codex/event-message-v2`、远端、既有测试和记忆接口；`git diff --check` 通过，四份文档的 25 个本地链接有效，R01–R12 矩阵及 A–D 未开始状态检查通过。核心/Web 构建和测试未运行：本次仅修改文档，不沿用前次结果作为通过依据。
- 未触发契约、Schema、审核/晋级语义变更，不新增设计决策；后续实施若触发门槛，先补决策。
- 四份方案文档已独立提交为 `74c9bdb`；GitHub 同步受阻，文档交付尚未满足推送完成条件。首次推送返回 `Error in the HTTP2 framing layer`；仅对重试命令改用 HTTP/1.1 后，仍在约 75 秒后无法连接 `github.com:443`。未修改全局 Git 配置，不能宣称远端已同步。
- 待办：网络恢复后核对远端分支，再推送当前 `codex/event-message-v2`（包含本条阻塞记录）并核对远端提交；如远端已变化，先处理差异，禁止强推。下一步实施不包含在本次文档交付内。

## 前次实施任务快照（2026-10-21；以下“完成”是当时的覆盖口径）

- 用户授权按 Spec/Plan 实施，并补充 AGENTS 规则。本轮范围仍是本地模拟验证。
- 更新 AGENTS.md §18，明确多模块/核心/分阶段任务需先检查并维护 `docs/superpowers/specs/`、`plans/`，STATUS 链接必须准确区分方案、实施和验收；既有授权决定是否实施。
- 阶段 A 部分完成：ScriptedModel 根据真实 ToolResult 有界分支；本地 `fetch` 请求统计与禁止目的地拦截自测、来源 Abort 已验证。Clock 注入、用例级状态重置以及全传输栈观测未完整覆盖。
- 阶段 B 完成：Metrics/Logs 单侧失败、Metrics 超时、Logs partial 的浏览器矩阵通过；不足案例保持 observation 且不可批准。
- 阶段 C 完成：Target Web+SQLite 闭环覆盖 A 采集、批准、召回，切换 B 后无 A 案例/模型输入，跨 Target 证据和审核请求返回 404；R08 用夹具 Clock 验证到期前、相等、之后三点，UI 标记过期但不改写已批准状态。新增 Target Profile `profile/v1` 校验回归，原配置校验器曾拒绝此快照版本格式。
- 阶段 D 质量门：`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm web:typecheck`、`pnpm web:build` 通过；`TMPDIR=/private/tmp pnpm test` 通过（215 文件通过、5 个 opt-in 文件跳过；2247 项通过、9 项跳过）；`TMPDIR=/private/tmp pnpm acceptance:memory` 通过（13 checks、6 策略行）；多来源 E2E 3/3、多 Target E2E 2/2、记忆 Web E2E 10 通过/1 跳过、禁用模式 1/1 通过。明细见验收报告。
- 测试环境 Node.js v24.19.0，pnpm v11.25.0（与仓库声明的 v11.19.0 不同）。全量测试/验收使用 `/private/tmp` 规避 macOS 临时目录符号链接问题；浏览器测试需本机 loopback 权限。
- 当时（此前网络阻塞阶段）`git fetch` 与普通 `git push` 曾因无法连接 `github.com:443` 失败；本次 fetch 已成功，核对远端无独有提交后普通 push 成功，远端现为 `a004da1`。
- 此前实现与状态记录已同步到 `a004da1`；本次重排记录 `32a7259` 及其后的状态收尾提交尚待网络恢复后 fetch 核对并普通 push。当前本地工作区干净。
- 未触发公共契约、Schema、Harness 顺序、Guard/Hook/HITL 或晋级语义变更，无需新增 DECISIONS 记录。`git diff --check` 当前通过。
- 当时记录的下一步是阶段 A/R12；本次审阅新增阶段 B 的真实超时与审核 API 组合缺口，以上方“下一步”及修订后的 Spec/Plan 为准。R08、R09 不再重复实施，计划整体仍未完成。

此前逐文件实施记录：[M4 计划](./superpowers/plans/2026-10-20-multi-project-m4.md)、[M5 计划](./superpowers/plans/2026-10-20-multi-project-m5.md)、[M2b 计划](./superpowers/plans/2026-10-20-multi-project-m2b.md)。
