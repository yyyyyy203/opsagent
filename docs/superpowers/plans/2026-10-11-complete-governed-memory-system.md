# 完整受治理记忆系统逐文件实施计划

> **执行方式：** 按依赖顺序执行，采用测试先行；所有持久化、API 与 UI 更改小步落入工作区，不覆盖用户已有向量实验或其他未提交改动。此计划依赖 [完整记忆 Spec](../specs/2026-10-11-complete-governed-memory-system.md) 和 [多项目计划](2026-10-11-multi-project-m1-m2a.md) R0。先完成 R0 安全门；Spec 未获用户审核通过前不开始 T1–T7（含 T4b）代码修改。提交/推送另需用户请求。

## 目标

在现有 Working/Checkpoint 与 Episodic 闭环上，补齐 Semantic 知识库和 Procedural 只读调查模板的版本、来源、审核、范围、检索、持久化、API/UI，并统一四类记忆的读取边界。不得改写 Episodic R2 语义，也不得把向量实验接入基础运行路径。

## 依赖与不可越过的门

```text
Spec 用户审核
  -> R0.1–R0.4 身份/恢复/首提交安全门（SQLite v7）
  -> T1 稳定契约/schema + 治理审计契约
  -> T2 SQLite v8 + InMemory Store
  -> T3 Semantic 来源/草稿/审核
  -> T4 Procedural 模板/审核/适用性
  -> T4b Target 知识启用发布
  -> T5 MemoryCoordinator + Harness 受控呈现
  -> T6 API/前端
  -> T7 迁移、全量隔离与全仓回归
```

T3 与 T4 可在 T2 contracts/store 稳定后并行开发，但按 T3→T4→T4b→T5 顺序集成。T1 先冻结审批/发布命令、独立审计和 outbox payload，T2 不等待 T5 再决定这些契约。R0 不以 M3 来源或 M4 完整 UI 为前置。若迁移版本被其他工作占用，或契约与 Spec 不符，先同步设计和两个计划，不覆盖已有迁移、不悄悄改变字段语义。

## T1 — 四类记忆契约与严格解析（RED → GREEN）

**文件**

- 新增 `src/contracts/knowledge-memory.ts`：Semantic/Procedural 内容修订、逐修订 governanceVersion/status、来源 sourceEpoch、生命周期、双版本 CAS 审核命令、查询端口、发布端口及固定错误码。引用使用已有 TargetKnowledgeReference，不再发明同名不同语义的 KnowledgeRef。
- 新增 `src/contracts/knowledge-memory-schema.ts`：严格 Zod schema、判别联合、长度/数量/深度界限、时间/摘要验证。
- 新增 `src/contracts/knowledge-governance-audit.ts`：独立 KnowledgeGovernanceAuditV1，以 knowledge_transition/source_transition/binding_publication 判别联合定义严格 parser 与事务 outbox/查询端口；不伪造 sourceRunId/knowledgeId/状态转换。旧 MEMORY_UPDATE 状态/事件保持原样。
- 复用 R0 的 `TargetKnowledgePolicy`、Snapshot V2 和历史身份端口：kind、精确 id/version、optional/required、publicationVersion 由宿主提供；不往已发布 reference 添加 required 字段。
- 在 `knowledge-memory.ts` 定义独立 `KnowledgeDiagnosisQualificationV1`：diagnosisReady、missingKnowledge 和固定限制原因；与证据缺失分离，不改 ToolResponse/V2 必填字段。
- 更新 `src/contracts/index.ts`：导出新契约；保留现有 `diagnostic-memory.ts` 和 `memory.ts` 的语义。
- 新增 `test/knowledge-memory-contract.test.ts` 与 `test/knowledge-memory-schema.test.ts`。

**先写测试**：拒绝未知字段、过长内容、重复步骤/引用、无来源、伪造批准者、非法转换、scope 不完整、错误 digest、live/simulation 混淆；Target reference.version 无损关联 contentRevision 而不是治理版本。审批同时需 contentRevision/governanceVersion；发布需 expectedPublicationVersion；无 Run 的审计正常，revoked/superseded/published 不压成 rejected。新增 `test/knowledge-governance-audit-contract.test.ts` 并验证旧 V2 fixtures 不变，然后实现 parser。

- [x] T1 验收：状态转换表与错误码覆盖 Spec §5/§7；审计契约已冻结，才允许 T2 建表/写 outbox。

## T2 — 持久化、版本和事务（RED → GREEN）

**文件**

- 更新 `src/infrastructure/sqlite/migrations.ts`：R0 v7 之后只追加 v8，创建内容 revisions、逐修订治理状态、来源 epoch、审核幂等记录、Target 启用指针/发布历史、严格范围 FTS、治理审计及独立 outbox；不修改现有 Run V2 outbox 的 payload。
- 新增 `src/contracts/knowledge-memory-storage.ts`：只添加 SQLite/InMemory 共用的稳定存储端口（草稿/修订、来源 epoch、受限 FTS 查询、事务边界）；保持 T1 已发布类型和行为不变，并从 `contracts/index.ts` 增量导出。
- 新增 `src/infrastructure/sqlite/knowledge-memory-store.ts`：使用已注入的主 persistence bundle，不打开第二库；内容不可变，双版本 CAS、有效期/sourceEpoch 检查、治理状态/FTS/audit/outbox 同事务；支持读取旧修订当前状态。
- 新增 `src/infrastructure/sqlite/target-knowledge-binding-store.ts`：启用指针与发布历史 CAS，和上述知识状态共享同库事务，不尝试与 JSON 文件做跨介质“原子提交”。
- 新增 `src/memory/knowledge-audit-dispatcher.ts`：注入有界 outbox/sink，auditId 幂等投递、失败保留、重启回放；由唯一宿主初始化/关闭，不应用审核命令。
- 新增 `src/memory/in-memory-knowledge-store.ts`：对齐持久化实现的可观察语义，仅用于测试。
- 更新现有 persistence/bootstrap 组装点：仅注入现有 database 与独立知识审计端口；Run 的 V2 Publisher/Dispatcher 所有权不变。
- 新增 `test/knowledge-memory-store.test.ts`、`test/knowledge-memory-sqlite.test.ts`、`test/knowledge-memory-migration.test.ts`。

**验收**：v6→v7→v8、v7→v8、旧迁移不变、失败回滚/重开；相同/冲突 requestId、双版本 CAS、来源撤回/审批竞态、旧修订治理查询；批准/撤销/发布与状态、FTS、审计/outbox 同事务。查询以 scope/kind/精确 refs 前置过滤，再 join 当前治理/来源/有效期；FTS 有旧条目也不得放行。补 `test/knowledge-audit-outbox.test.ts` 和 `test/target-knowledge-binding-store.test.ts`。

- [x] T2 验收：SQLite/InMemory 可观察语义一致；无 Run 的导入、重复投递和宕机回放均有审计，不修改旧 V2 contract。已通过定向测试、全仓质量门和独立任务复核。

## T3 — Semantic 来源与治理服务（RED → GREEN）

**文件**

- 新增 `src/memory/semantic-knowledge-service.ts`：受控导入/草稿、来源校验、结构化变更和审核请求编排；不得调用 LLM 自动批准。
- 新增 `src/memory/semantic-source-registry.ts`：解析 host-owned Target/Profile knowledgeRefs 到版本化来源；只接受清单内 source ID + digest，不接受任意 URL/文件路径。
- 更新 `src/profiles/target-resolver.ts` 的知识解析接线：读取已发布指针与 host-only policy，按 Spec §7.1 判断能力/必需性；可选内容缺失不阻断整个 Target。快照只存安全引用/策略/publicationVersion，不存全文、文件路径或永久批准状态。
- 新增 `test/semantic-knowledge-service.test.ts` 与 `test/semantic-source-registry.test.ts`。

**验收**：fail-closed 指拒绝使用无效知识，不一律禁止 Target 启动。覆盖开关 × optional/required × 缺失/撤回/到期/digest 失配/冲突/超时；required 类型关闭为新 Run 配置错误，optional 关闭不查询，required 运行时缺失产生 missingKnowledge/limitations 而非伪证据。Metric 定义不覆盖确定性规则；跨 Target 导入新 draft。批准 r2 不自动撤销仍有效的 r1；内容相同而治理/sourceEpoch 已变时迟到批准失败。

- [x] T3 验收：可注入时钟模拟到期和 sourceEpoch 变更；无后台清理也不召回失效记录，无网络/LLM 自动批准。独立评审通过（5 项修复均关闭，0 个阻断）；Node 24 全仓 lint/typecheck/test/build 复验通过；Minor catalog readiness 项转 T6 复核。

## T4 — Procedural 模板及确定性适用性（RED → GREEN）

**文件**

- 新增 `src/memory/procedural-template-service.ts`：模板 draft、修订、审核和撤销；不得生成可执行命令。
- 新增 `src/memory/procedural-applicability.ts`：按 Target snapshot、Scenario/version、service、faultType、environment、dataClass、required evidence/capabilities 确定性过滤。
- 新增 `test/procedural-template-service.test.ts` 与 `test/procedural-applicability.test.ts`。

**验收**：不适用模板不返回；相似度不能越过前置筛选；模板只返回固定结构建议，不能实例化 ToolCall、触发写动作、减少必需取证或绕过 HITL/Guard。

- [x] T4 验收：复用 Semantic 的双版本 CAS/审计，不建立另一套放宽的审批；新 draft 不自动停用旧模板，已撤权/不兼容则立即停止使用。T4 实现与回执优先重放通过独立复审；定向 167 项测试、lint、typecheck、build 通过。1 项 lexical guard 误报/漏报边界作为 Minor 留待最终整分支复核。

## T4b — 审批到 Target 启用的发布闭环（依赖 T2–T4）

**文件**

- 新增 `src/application/target-knowledge-publication-service.ts`：宿主解析 Target/scope，校验精确 refs、governanceVersion、sourceEpoch、有效期、Target policy/profile 版本及 expectedPublicationVersion，只处理知识绑定发布。
- 更新 `src/profiles/target-resolver.ts`、`src/bootstrap/diagnostic-memory.ts` 与 Target bootstrap 注入：一致读取同库启用指针覆盖层；Catalog 的初始 knowledgeRefs 只能显式导入，不在重启时覆盖现有发布。
- 新增 `test/target-knowledge-publication.test.ts`，扩展 `test/target-run-service.test.ts`、`test/knowledge-memory-sqlite.test.ts`。

- [ ] RED：approve r2 后未发布，r1 保持可用且新 Run 不自动选 r2；显式启用成功后新 Run 固定 r2，旧 Run 不升级。
- [ ] RED：发布与撤销/sourceEpoch/Target scope 更新并发、CAS 冲突、写 outbox 失败，均完整回滚；安全撤销不因没有替代版本而延期。
- [ ] GREEN：同事务提交启用集合/publicationVersion、必要 supersede、索引资格和审计；不修改阈值/连接/工具权限。知识发布不自行递增 profileRevision；真正规则变化需新 scope 和审核。
- [ ] 验收：旧 Run 的 r1 若被 supersede，按 optional/required 矩阵显示限制而非替换引用；重启不丢发布，首绑定事务保持原 publicationVersion。历史收据/旧修订不得用作撤销回滚授权。

## T5 — 四类记忆协调器、预算与模型视图（RED → GREEN）

**文件**

- 新增 `src/memory/memory-coordinator.ts`：协调 Working Context、既有 Episodic Recall、Semantic Query 与 Procedural Query 的独立端口；不承担存储。
- 更新 `src/contracts/diagnostic-memory.ts`：仅追加可选能力发现字段/协调端口；保留已发布字段和旧 `MemoryFacade` 语义。
- 更新 `src/contracts/context.ts`、`src/storage/durable-codec.ts` 和对应 Checkpoint schema：按需持久化 `knowledgeSelection`，旧 checkpoints 仍可读且不自动绑定。
- 更新 `src/agent/agent-harness.ts`、`src/agent/types.ts` 与 `src/memory/hint-renderer.ts`：仅在现有 Pre-reasoning 边界准备和呈现；不改变主循环顺序、V1 generator yield 或 V2 事件顺序。
- 仅将实际 Run 检索接入既有 MEMORY_RETRIEVAL 事件；治理操作使用 T1 已冻结的独立审计。不得在 T5 才决定新增 payload，或修改旧 UPDATE 事件来承载无 Run 的撤销/发布。
- 更新 `src/contracts/read-model.ts` 与对应查询/安全 DTO parser，以可选、版本化字段呈现 KnowledgeDiagnosisQualificationV1；最终报告资格由确定性门约束，不能只靠模型文本声明限制。
- 新增 `test/memory-coordinator.test.ts`、`test/memory-knowledge-recovery.test.ts`，扩展 `test/memory-harness.test.ts`、`test/memory-harness-recovery.test.ts`、`test/context-compression-recovery.test.ts`。

**验收**：scope/ref/逐修订 status/sourceEpoch/有效期过滤在搜索前；每轮重建临时模型视图，不把知识全文/批准状态作为长期 Checkpoint 授权。模型请求前/最终资格提交前再次复核，revocation 从下一轮/恢复/缓存移除；预算不足的 required 显式限制，optional 失败不丢其他合法类型，全部长期检索失败才 working_only，Abort 传播。确定性 diagnosisReady/missingKnowledge 门不靠模型自行承认不足，知识不混入 evidenceIds/coverage；压缩不改写引用身份。

- [ ] T5 验收：类型开关、用户偏好、required、预算、scope 撤销和压缩/重启矩阵；已有 Episodic 临时提示与 revalidate 保持，不假设已存在“撤销文本永久入历史”缺陷。

## T6 — Web 查询/治理 API 与同页 UI（RED → GREEN）

**文件**

- 新增 `src/api/knowledge-memory-routes.ts`；在 `src/api/http-server.ts` 挂载 Target-scoped strict routes，分开 review、revoke 和 publish 命令；复用 R0 application 归属/当前策略端口，不把 legacy route 当 Target 后门。
- 更新 `src/bootstrap/agent-web-runtime.ts` 与 `src/bootstrap/diagnostic-memory.ts`：构造器注入 Knowledge ports、host-owned actor/scope resolver；服务关闭时不影响旧路径。
- 更新 `apps/agent-web/src/api/client.ts`、`apps/agent-web/src/components/MemoryPanel.tsx`、`apps/agent-web/src/App.tsx` 与必要 styles：增加“系统知识/调查模板”查询、草稿、审核、撤销和独立“启用到此 Target”操作；显示内容/治理/发布版本、未启用与旧 Run 限制。只消费安全 Target Catalog 选择知识范围，不宣称交付完整 M4 Run/UI。
- 新增 `test/knowledge-memory-api.test.ts`、更新 `test/memory-web-view.test.ts` 和 `test/e2e/memory-web.spec.ts`。

- Target host bootstrap 必须向 `ProceduralTemplateService` 注入 `KnowledgeProceduralReplayCapability`。为兼容既有宿主而保留的旧 T2 适配器路径不得用于本项目正式组装；T6 回归需验证正式组装走回执优先重放，并覆盖 source/attestation 易变后的相同命令重试。

**验收**：body 不接受 scope/actor/状态/批准者/绝对路径/任意 URL；不存在和越界统一 404；审核 CAS/重放行为稳定；UI 标注来源、适用条件和 revision；模板没有执行按钮；无认证的本地操作员模式不得监听公网。

- [ ] T6 验收：批准≠启用可从页面观察；publishing 不能修改业务规则或激活失效 revision，失效知识只能只读审计；能力关闭/必需限制明确可见。

## T7 — 联合验收与安全回归

**测试**

- 四类契约/生命周期矩阵；SQLite/InMemory 一致性；v6→v7→v8、v7→v8 和重启。
- 两个 Target、两个 Profile revision、simulated/live、不同 dataset、不同服务/Scenario 的正反向隔离。
- Semantic 来源撤回/摘要变化/矛盾知识，Procedural 版本不兼容/缺证据要求/工具能力不在 allowlist。
- Episodic R2 原有 capture-review-recall UI/HTTP/acceptance 测试；向量实验仅验证 Episodic shadow，不接入主协调器。
- Context 压缩、checkpoint 恢复、HITL、事件安全投影、LangSmith 隐私、Abort/deadline、失效降级。
- 执行 Spec 验收 10–13：optional/required/flag 全矩阵、approve→publish→supersede、sourceEpoch 与双版本 CAS、重复审核/发布收据不能复活撤销、没有 Run 的治理审计和 outbox 回放。

**质量门**：运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`，并进行一次独立代码审查。清晰报告全量已有阻塞；不能以定向测试代替全仓通过。

- [ ] T7 验收：R0 + T1–T6 的定向测试及全部质量门有新鲜输出；测试只用确定性桩，不调用付费模型/Embedding/LangSmith。

## 风险覆盖与执行清单

| 风险 | 必须完成的任务 | 关键负向断言 |
|---|---|---|
| R1 历史身份漂移 | 前置 R0.1 | 跨重启同 fingerprint 换世代/数据域拒绝 |
| R2 恢复未检查当前权限 | 前置 R0.3 + T5 | 被撤销后 resume/retry/child 不执行，知识提示不复用 |
| R3 首事务 unknown 放行 | 前置 R0.2 | 重读抛错不释放 reservation，不重复 start |
| R4 开关/必需性与降级冲突 | T1、T3、T5、T7 | optional 失效不瘫痪 Target；required 缺失不输出完整诊断 |
| R5 审批到引用无启用闭环 | T2、T4b、T6、T7 | approve 不换引用；publish 失败保留旧绑定 |
| R6 内容 CAS 无法防治理竞态 | T1–T4、T7 | 同内容撤回后，旧 approve/幂等收据不复活 |
| R7 审计契约晚于存储 | T1→T2、T7 | 无 Run 导入有真实审计；旧 V2 不改义 |

## 风险和明确不在计划内

- 不训练/调用记忆专用模型；不启用远程 Embedding API。
- 不把 `approved` 当成确定性事实真值；不自动把 Episodic 升级为 Semantic/Procedural。
- 不启用跨项目通配召回或自动复制；不添加任何写业务系统的工具。
- 不在同一个 Spec 中做向量正式化、生产认证/RBAC、跨用户审核或真实业务数据接入。

## 执行状态

- [x] 用户已审核并明确批准按本 Spec 与计划执行（2026-10-12）。
- [x] R0.1–R0.4 运行时补强及验收完成；依据多项目计划 R0.4 的实现/独立审查记录，并在 2026-10-12 重新通过 Node 24 全仓 lint、typecheck、test、build。
- [x] T1、T2 已完成并通过独立复核。
- [x] T1–T4 已完成并通过对应任务复核；T3 与 T4 的 Minor 均须在 T6/最终复核中回看。
- [ ] T4b、T5、T6、T7 尚未完成；按依赖顺序继续执行，文档修订不算实现完成。
