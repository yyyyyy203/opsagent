# 多项目适配 M4 逐文件实施计划：Target 工作台与全入口归属

- 日期：2026-10-20
- 依据：[多项目适配设计 Spec](../specs/2026-10-11-multi-project-adaptation-design.md) §4.2、§7–§13
- 前置：M1/M2a/R0、M3 已实现的契约和安全门；执行前重新核对分支、`AGENTS.md`、Spec、当前测试与 Git 状态。
- 状态：已完成。实现、全仓质量门及双 Target 浏览器验收通过；真实业务目标接入不属于本阶段验收。

## 目标与现状

让单一可信操作者在 Web 中选择“项目 → 部署 → 场景”，在同一 Target 范围内启动、查看、恢复和管理 Run。报告显示冻结的目标身份与规则版本；来源状态按所属 Run 展示。沿用现有 Agent Harness、V2 事件、持久化所有者和受治理知识实现。

当前已有 `TargetRunService`、`/targets`、`/targets/:targetId/readiness`、Target Run 的创建/列表/详情/命令/SSE，以及 Target 知识路由。主工作台 `App.tsx`、`RunViewController` 仍用 `/profiles` 与旧 `/runs`；Target 消息、证据、用量和 Episodic 记忆入口尚未全部接线。现有 Target 绑定列表使用原始 `runId` 作游标；旧 `/runs` 列表在取出一页后才过滤已绑定 Run。实施时先补归属与分页边界，再接 UI。

## 契约与兼容决定

1. 新 Target 路由只接受 `targetId`、有界用户问题和明确允许的偏好；Target 身份、来源地址、PromQL、阈值、指纹、规则版本、密钥引用和工具清单只从宿主解析。当前 POST Target Run 仅接收 `message`，若要让浏览器提交 `MemoryPreferences`，先记录该可选字段的契约决定、严格 Schema、默认值、幂等摘要兼容行为，并让旧请求保持原义；不能把偏好塞进问题文本。
2. `TargetCatalogDto` 继续只提供安全展示字段。报告标签从持久化 Run→绑定→冻结快照生成，不能用当前 Catalog 回填历史规则。新增 DTO 字段采用可选字段或显式版本，更新严格 parser、公共投影和客户端；不修改已发布 V2 事件语义。
3. 对 Target Run 的所有公开读写路径，先查绑定归属，再访问 Run、Checkpoint、证据、消息、记忆或事件。未知资源与跨 Target 资源返回相同的安全 404。目标停用时可读历史、拒绝确认及取消在途工作；批准/恢复仍走当前策略门。
4. 旧 `/profiles`、`/runs`、`/memory` 保留模拟器兼容行为，但不能查询或操作 Target Run/Target 专属记忆。旧 Run 不按同名 `profileId` 自动绑定；旧分页须在存储查询时排除 Target Run，不能查询后过滤。
5. 客户端切换 Target 或 Run 时，关闭旧 SSE，取消或忽略旧请求，重置游标、消息、证据、用量、确认和来源状态；父子 Run 的证据查询必须逐个验证同一 Target/root lineage。

## 逐文件任务

### M4.1 服务端归属与分页

| 文件 | 具体修改 |
| --- | --- |
| `src/contracts/target.ts`、`src/contracts/read-model.ts`、`src/contracts/web-read-model.ts` | 增加最小的 Target 公共投影和分页输入/输出类型；冻结标签只含安全 ID、展示名、场景/服务和规则版本。保持原 DTO 兼容。 |
| `src/application/target-run-service.ts` | 保留已有启动/命令门；将 Target 列表、详情和父子归属检查作为统一服务端入口，校验分页游标固定 Target 和查询条件；报告引用冻结快照，不直接信任 Catalog。 |
| `src/application/target-web-query-service.ts`（新） | 封装 Target 消息、证据列表/详情、确认状态、用量和根/子 Run 展示查询。每次先验证绑定及 lineage，再调用现有只读端口；不复制数据或新建全局缓存。若现有 `TargetRunService` 扩展后仍足够小，可并入该文件并记录原因。 |
| `src/infrastructure/sqlite/durable-state-store.ts`、`src/storage/in-memory-durable-state.ts` | 调整 `listByTarget` 游标为受目标及过滤条件约束的有界游标；查询必须先按 `target_id` 过滤再分页。迁移现有仅含 `runId` 的游标时明确拒绝或版本化处理，不默默当作另一目标游标。 |
| `src/infrastructure/sqlite/inspection-query-service.ts`、`src/storage/in-memory-inspection-query.ts` | 给 legacy 列表增加 `NOT EXISTS run_target_bindings` 等价过滤，分页前完成；内存实现也在排序/分页前过滤。不要通过取多页补齐的方式伪装正确分页。 |
| `src/application/message-cursor-codec.ts`、`src/infrastructure/sqlite/web-message-query.ts`、`src/infrastructure/sqlite/sqlite-evidence-store.ts` | 保持既有 runId 绑定；由 Target 门先验归属，并为新增 Target 公共分页封装 Target/查询类型边界。跨 Target、跨 Run、篡改或过期游标拒绝，且不泄露原记录。 |
| `src/api/http-server.ts` | 补齐 `/targets/:targetId/runs/:runId/{messages,evidence,evidence/:evidenceId,confirmation}` 等只读路由；SSE 在订阅前及重连时校验归属。当前 memory handler 在 Target/legacy 归属检查前运行，需在分发前拦截 legacy Target 资源，不能仅在后续 `/runs` 分支补 guard。保持已有 Target 创建、命令和旧路由行为。 |
| `src/bootstrap/agent-web-runtime.ts` | 注入同一持久化 bundle、Target 查询门、消息/证据/记忆端口；不得另建 SQLite/事件投影所有者。启动能力仍取决于宿主显式提供的 Target Starter/Recovery Gate。 |
| `test/target-http-routes.test.ts`、`test/target-run-service.test.ts`、`test/web-query-sqlite.test.ts`、`test/web-sse-recovery.test.ts` | 覆盖 A/B 错配 Run/子 Run/证据/消息/游标/SSE 的一致 404，分页前过滤、跨目标游标、暂停/撤权后读写边界，以及 legacy simulation 回归。 |

### M4.2 记忆与知识接线

| 文件 | 具体修改 |
| --- | --- |
| `src/bootstrap/memory-policy.ts`、`src/bootstrap/diagnostic-memory.ts` | 核对 200 Target 注册/解析时独立 `MemoryScope` 和每 Target `requiredSources`；如现有注入不满足，按 Target 派生配置，保留当前关闭默认值及精确 profileRevision 匹配。 |
| `src/application/memory-query-service.ts`、`src/api/memory-routes.ts` | 新增或复用 Target-scoped Episodic 门面及路由：能力、案例列表/详情、当前 Run 记忆/捕获与审核都先验证 Target/Run/案例 scope；legacy `profileId` 入口拒绝 Target 资源。不能仅靠浏览器传来的 profileId 授权。 |
| `src/api/knowledge-memory-routes.ts`、`src/application/target-knowledge-publication-service.ts` | 复查既有 Target 知识入口的策略、发布版本和归属校验；只修复缺口，不重复实现 Semantic/Procedural CRUD。知识摘要不冒充本次证据。 |
| `test/memory-api.test.ts`、`test/memory-web-view.test.ts`、`test/knowledge-memory-api.test.ts`、`test/memory-policy.test.ts` | 覆盖 200 个 Target 的隔离、required/optional 知识、禁用/撤销/过期、错误目标案例与 Run 记忆、legacy 绕行、浏览器偏好只影响允许的 capture/recall。 |

### M4.3 Web 客户端与页面

| 文件 | 具体修改 |
| --- | --- |
| `apps/agent-web/src/api/types.ts`、`apps/agent-web/src/api/client.ts` | 增加 Target 作用域的启动（`Idempotency-Key` header）、列表、详情、消息、证据、确认、恢复、取消、SSE 和记忆调用；保持旧方法供 simulation。只传允许的偏好，禁止由 UI 构造 endpoint/查询表达式。 |
| `apps/agent-web/src/state/run-view.ts` | 引入显式视图模式与选中 `targetId`，切换时递增 generation、关闭旧订阅、清空分页/快照/来源状态；所有回包和 SSE 更新同时校验当前 Target 与 Run。 |
| `apps/agent-web/src/App.tsx`、`apps/agent-web/src/components/TaskComposer.tsx` | 增加项目→环境/部署→场景选择；从安全目录和 readiness 展示不可启动原因。明确保留 simulation 入口；Target 启动调用新客户端方法。 |
| `apps/agent-web/src/components/RunList.tsx`、`apps/agent-web/src/components/RunStatus.tsx`、`apps/agent-web/src/components/EvidencePanel.tsx`、`apps/agent-web/src/components/SubagentPanel.tsx` | 历史和报告显示冻结目标/规则版本；来源重试、熔断、半开、恢复按当前 Run 所属 Target 展示，来源不可用与业务低失败率分开；父子证据只显示安全摘要/引用。 |
| `apps/agent-web/src/components/MemoryPanel.tsx`、`apps/agent-web/src/components/knowledge-view.ts` | 已有知识 Target 选择与主工作台同步；Episodic 操作走 Target 作用域端点，不因页面切换把旧 Target 案例或通知留下。 |
| `apps/agent-web/src/styles.css` | 仅补选择器、冻结标签、来源状态的布局和窄屏样式；保留现有页面结构。 |
| `test/web-api-client.test.ts`、`test/web-run-view.test.ts`、`test/e2e/agent-web.spec.ts`、`test/e2e/memory-web.spec.ts` | 覆盖 URL/请求头/请求体、切换时迟到响应与 SSE、A/B 页面数据隔离、禁用目标、来源状态和旧 simulation 行为。 |

### M4.4 文档与阶段门

| 文件 | 具体修改 |
| --- | --- |
| `docs/guides/agent-web-local.md`、`docs/implementation-status.md` | 记录两个模拟 Target 的本地启动方式、环境条件、可见状态和剩余 M5/真实目标缺口；不要声称生产验收通过。 |

按 M4.1 → M4.2 → M4.3 顺序实施；每段先写关键失败用例，再修改对应文件，防止 UI 绕开未补齐的归属门。完成后执行仓库要求的 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、Web typecheck/build 和相关浏览器验收，记录运行环境、通过/跳过项。M4 的完成条件是所有公开 Target 入口可按归属使用，旧入口不能访问 Target 资源，两个模拟 Target 可在主工作台切换，且没有原始连接或证据内容进入公共投影。

M5 的联合浏览器/容量验收见 [M5 计划](2026-10-20-multi-project-m5.md)。可选旧 Run 迁移见 [M2b 计划](2026-10-20-multi-project-m2b.md)，不是 M4 前置条件。真实 `group-buy-market` 数据源、Counter 场景、多人 ACL 与真实动作不属于本阶段。

## 本轮逐文件执行结果（2026-10-21）

| 计划文件/文件组 | 执行结果 |
| --- | --- |
| `src/contracts/target.ts`、`src/contracts/read-model.ts` | 已调整 Target 安全投影与旧列表过滤输入；`web-read-model.ts` 现有 DTO 足够，未改。 |
| `src/application/target-run-service.ts`、`src/application/target-web-query-service.ts` | 已实现 Target 游标范围校验、冻结 Snapshot 标签，以及消息/证据/确认查询前的 Target 与父子 lineage 校验。 |
| `src/infrastructure/sqlite/inspection-query-service.ts`、`src/storage/in-memory-inspection-query.ts`、`src/application/create-runtime.ts`、`src/api/http-server.ts` | 已在 legacy 列表排序分页前排除 Target-bound Run，并接入 Target 查询门与旧入口拒绝。持久化 Target 列表本身已由现有按 Target 查询端口过滤，未需改 `durable-state-store.ts`。 |
| `src/api/memory-routes.ts`、`src/bootstrap/memory-policy.ts`、`src/bootstrap/agent-web-runtime.ts` | 已接入 Target-scoped Episodic API、冻结 MemoryScope 校验和可选 capture/recall 偏好；偏好合同及幂等兼容记录在[决策文档](../decisions/2026-10-21-target-memory-preferences.md)。 |
| `apps/agent-web/src/api/{client,types}.ts`、`apps/agent-web/src/state/run-view.ts`、`apps/agent-web/src/App.tsx`、`apps/agent-web/src/components/TargetWorkspace.tsx`、`TaskComposer.tsx`、`RunList.tsx`、`RunStatus.tsx`、`MemoryPanel.tsx`、`apps/agent-web/src/styles.css` | 已完成 Target/simulation 双模式与工作台接线；复用现有消息、证据、确认、子 Run 面板。Run View 现以服务端 accepted `runId` 打开新 Run，覆盖了此前浏览器临时 ID 与服务端 ID 不一致的问题。 |
| `test/target-http-routes.test.ts`、`test/memory-policy.test.ts`、`test/web-api-client.test.ts`、`test/web-run-view.test.ts`、`test/e2e/multi-target-web.spec.ts` 及既有 Target 回归 | 全仓回归和新增双 Target 浏览器用例通过；浏览器覆盖 A/B 阈值结果、冻结标签、跨 Target/legacy 404、切换迟到响应隔离、历史和旧 simulation。 |
| `docs/guides/agent-web-local.md`、`docs/implementation-status.md`、`docs/verification/2026-10-21-multi-project-m5-acceptance.md` | 已补充本地使用方式、验收证据和真实目标限制。 |

未改动的消息游标、证据存储与知识治理实现继续复用已有 run-bound 查询、Target 知识门和投影；本轮在 Target 查询服务及路由层先做归属校验，没有新增第二套存储或知识 CRUD。验证：根 lint/typecheck/build、全仓测试、Web typecheck/build 与 `pnpm e2e:multi-target` 均通过；运行环境、测试计数和外部请求边界详见 [M5 验收记录](../../verification/2026-10-21-multi-project-m5-acceptance.md)。
