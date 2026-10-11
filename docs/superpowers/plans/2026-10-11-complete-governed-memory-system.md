# 完整受治理记忆系统逐文件实施计划

> **执行方式：** 按依赖顺序执行，采用测试先行；所有持久化、API 与 UI 更改小步提交到工作区，不覆盖用户已有向量实验或其他未提交改动。此计划依赖 [完整记忆 Spec](../specs/2026-10-11-complete-governed-memory-system.md)。Spec 获用户明确审核通过前，不开始 T1–T8 的代码修改。

## 目标

在现有 Working/Checkpoint 与 Episodic 闭环上，补齐 Semantic 知识库和 Procedural 只读调查模板的版本、来源、审核、范围、检索、持久化、API/UI，并统一四类记忆的读取边界。不得改写 Episodic R2 语义，也不得把向量实验接入基础运行路径。

## 依赖与不可越过的门

```text
Spec 用户审核
  -> T1 稳定契约/schema
  -> T2 SQLite v7 + InMemory Store
  -> T3 Semantic 来源/草稿/审核
  -> T4 Procedural 模板/审核/适用性
  -> T5 MemoryCoordinator + Harness 受控呈现
  -> T6 API/前端
  -> T7 迁移、全量隔离与全仓回归
```

T3 与 T4 可在 T2 contracts/store 稳定后并行开发，但合并到主运行时前必须按 T3→T4→T5 顺序集成。若现有 Memory 或 Target 契约与 Spec 不符，先暂停并提报契约决策，不在实现中悄悄改变字段语义。

## T1 — 四类记忆契约与严格解析（RED → GREEN）

**文件**

- 新增 `src/contracts/knowledge-memory.ts`：Semantic/Procedural 记录、来源、生命周期、审核命令、查询端口、KnowledgeRef 和固定错误码。
- 新增 `src/contracts/knowledge-memory-schema.ts`：严格 Zod schema、判别联合、长度/数量/深度界限、时间/摘要验证。
- 更新 `src/contracts/index.ts`：导出新契约；保留现有 `diagnostic-memory.ts` 和 `memory.ts` 的语义。
- 新增 `test/knowledge-memory-contract.test.ts` 与 `test/knowledge-memory-schema.test.ts`。

**先写测试**：拒绝未知字段、过长内容、重复步骤/引用、无来源、伪造批准者、非法状态转换载荷、scope 不完整、错误 digest、live/simulation 混淆；校验已有 Target `knowledgeRefs` 可无损关联记录 revision/digest。然后实现 parser 和合同测试。

## T2 — 持久化、版本和事务（RED → GREEN）

**文件**

- 更新 `src/infrastructure/sqlite/migrations.ts`：在当前 v6 后只追加 v7，创建知识当前视图、不可变 revisions、审核幂等记录和严格范围 FTS 表；优先复用 V2 outbox。
- 新增 `src/infrastructure/sqlite/knowledge-memory-store.ts`：使用已注入的 `SqliteDatabase`/主 persistence bundle，不打开第二库；支持保存 draft、版本修订、审批 CAS、拒绝、撤销、替代、按 scope/ref 查询和原子 FTS/outbox。
- 新增 `src/memory/in-memory-knowledge-store.ts`：对齐持久化实现的可观察语义，仅用于测试。
- 更新现有 persistence/bootstrap 组装点：仅传入已拥有的 database、event factory/outbox 端口。
- 新增 `test/knowledge-memory-store.test.ts`、`test/knowledge-memory-sqlite.test.ts`、`test/knowledge-memory-migration.test.ts`。

**验收**：从 v6 升级、v1-v6 迁移回归、失败回滚、重开、相同/冲突 requestId、expectedRevision CAS、旧 worker/旧 revision 不可覆盖、新审批与索引/outbox 同事务；范围与 kind 均由 SQL 前置过滤。

## T3 — Semantic 来源与治理服务（RED → GREEN）

**文件**

- 新增 `src/memory/semantic-knowledge-service.ts`：受控导入/草稿、来源校验、结构化变更和审核请求编排；不得调用 LLM 自动批准。
- 新增 `src/memory/semantic-source-registry.ts`：解析 host-owned Target/Profile knowledgeRefs 到版本化来源；只接受清单内 source ID + digest，不接受任意 URL/文件路径。
- 更新 `src/profiles/target-resolver.ts` 与必要的 Target schema：启动时确认知识引用版本可解析、digest 匹配；快照仅存非敏感 id/revision/digest，不存文档原文或路径。
- 新增 `test/semantic-knowledge-service.test.ts` 与 `test/semantic-source-registry.test.ts`。

**验收**：Profile/Target authority 优先；来源 digest 改变、引用版本缺失、撤回、过期和同 naturalKey 冲突均 fail-closed；Metric 定义不得覆盖确定性阈值/映射；跨 Target 导入形成独立未批准 revision。

## T4 — Procedural 模板及确定性适用性（RED → GREEN）

**文件**

- 新增 `src/memory/procedural-template-service.ts`：模板 draft、修订、审核和撤销；不得生成可执行命令。
- 新增 `src/memory/procedural-applicability.ts`：按 Target snapshot、Scenario/version、service、faultType、environment、dataClass、required evidence/capabilities 确定性过滤。
- 新增 `test/procedural-template-service.test.ts` 与 `test/procedural-applicability.test.ts`。

**验收**：不适用模板不返回；相似度不能越过前置筛选；模板只返回固定结构建议，不能实例化 ToolCall、触发写动作、减少必需取证或绕过 HITL/Guard。

## T5 — 四类记忆协调器、预算与模型视图（RED → GREEN）

**文件**

- 新增 `src/memory/memory-coordinator.ts`：协调 Working Context、既有 Episodic Recall、Semantic Query 与 Procedural Query 的独立端口；不承担存储。
- 更新 `src/contracts/diagnostic-memory.ts`：仅追加可选能力发现字段/协调端口；保留已发布字段和旧 `MemoryFacade` 语义。
- 更新 `src/contracts/context.ts`、`src/storage/durable-codec.ts` 和对应 Checkpoint schema：按需持久化 `knowledgeSelection`，旧 checkpoints 仍可读且不自动绑定。
- 更新 `src/agent/agent-harness.ts`、`src/agent/types.ts` 与 `src/memory/hint-renderer.ts`：仅在现有 Pre-reasoning 边界准备和呈现；不改变主循环顺序、V1 generator yield 或 V2 事件顺序。
- 更新 `src/contracts/event-v2/subsystem.ts` 仅当现有 Memory event payload 无法描述既定状态；否则复用现有类型，不改公共事件契约。
- 新增 `test/memory-coordinator.test.ts`、`test/memory-knowledge-recovery.test.ts`，扩展 `test/memory-harness.test.ts`、`test/memory-harness-recovery.test.ts`、`test/context-compression-recovery.test.ts`。

**验收**：scope/ref/status/provenance 的过滤发生在搜索/排序前；结果有稳定排序和每类/总预算；revocation 立即从恢复/下一轮呈现中移除；知识 ID 不混入证据；召回故障只降级可选知识而 Abort 传播。

## T6 — Web 查询/治理 API 与同页 UI（RED → GREEN）

**文件**

- 新增 `src/api/knowledge-memory-routes.ts`；在 `src/api/http-server.ts` 挂载 strict routes。
- 更新 `src/bootstrap/agent-web-runtime.ts` 与 `src/bootstrap/diagnostic-memory.ts`：构造器注入 Knowledge ports、host-owned actor/scope resolver；服务关闭时不影响旧路径。
- 更新 `apps/agent-web/src/api/client.ts`、`apps/agent-web/src/components/MemoryPanel.tsx`、`apps/agent-web/src/App.tsx` 与必要 styles：增加“系统知识/调查模板”只读查询、草稿、审核和撤销面板，区分与 Episodic 案例。
- 新增 `test/knowledge-memory-api.test.ts`、更新 `test/memory-web-view.test.ts` 和 `test/e2e/memory-web.spec.ts`。

**验收**：body 不接受 scope/actor/状态/批准者/绝对路径/任意 URL；不存在和越界统一 404；审核 CAS/重放行为稳定；UI 标注来源、适用条件和 revision；模板没有执行按钮；无认证的本地操作员模式不得监听公网。

## T7 — 联合验收与安全回归

**测试**

- 四类契约/生命周期矩阵；SQLite/InMemory 一致性；v6→v7 和重启。
- 两个 Target、两个 Profile revision、simulated/live、不同 dataset、不同服务/Scenario 的正反向隔离。
- Semantic 来源撤回/摘要变化/矛盾知识，Procedural 版本不兼容/缺证据要求/工具能力不在 allowlist。
- Episodic R2 原有 capture-review-recall UI/HTTP/acceptance 测试；向量实验仅验证 Episodic shadow，不接入主协调器。
- Context 压缩、checkpoint 恢复、HITL、事件安全投影、LangSmith 隐私、Abort/deadline、失效降级。

**质量门**：运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`，并进行一次独立代码审查。清晰报告全量已有阻塞；不能以定向测试代替全仓通过。

## 风险和明确不在计划内

- 不训练/调用记忆专用模型；不启用远程 Embedding API。
- 不把 `approved` 当成确定性事实真值；不自动把 Episodic 升级为 Semantic/Procedural。
- 不启用跨项目通配召回或自动复制；不添加任何写业务系统的工具。
- 不在同一个 Spec 中做向量正式化、生产认证/RBAC、跨用户审核或真实业务数据接入。

## 执行状态

- [ ] 用户审核 Spec。
- [ ] T1–T7 尚未开始；审核通过后按序执行。
