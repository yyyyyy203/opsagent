# 多项目适配 M2b 逐文件实施计划：可选旧 Run 核验与迁移

- 日期：2026-10-20
- 依据：[多项目适配设计 Spec](../specs/2026-10-11-multi-project-adaptation-design.md) §4.1、§10–§12
- 前置：M1/M2a/R0 的身份账本、Snapshot V2、原子绑定和当前策略门；**不阻塞 M3–M5**。
- 状态：条件性计划。先盘点旧记录；若没有可核验的不可变来源元数据，保持旧 Run 只读并以报告结束本增量。

## 必须先证明的条件

候选旧 Run 的历史记录本身须能证明当时的项目、部署/数据集世代、来源数据域、权限范围、场景实现版本与所用规则。当前同名 profile、今天的 Catalog、现有 URL 或模型文本都不是证明。无法证明、元数据冲突、证据归属不完整或源已撤权时，不创建 Target 绑定，不修改旧 Checkpoint/证据，也不允许恢复执行。可选迁移必须逐 Run 审核、可审计且可重试；批量静默补造绑定不在范围。

## 逐文件任务

### M2b.1 只读盘点与资格报告（总是执行）

| 文件 | 具体工作 |
| --- | --- |
| `src/contracts/target.ts`、`src/contracts/target-schema.ts` | 如现有类型不足，增加独立的旧 Run 资格判定结果/原因码，不改 Snapshot V1/V2 或已发布事件字段。明确 `eligible`、`ineligible`、`unknown`，默认不可迁移。 |
| `src/application/legacy-run-inventory-service.ts`（新） | 只读扫描有界 Run/Checkpoint/来源记录，列出证据字段、缺口、归属冲突与可核验候选 ID；输出仅安全摘要，不暴露 URL、密钥或原始证据。不得按 `profileId` 猜 Target。 |
| `src/infrastructure/sqlite/durable-state-store.ts`、`src/storage/durable-codec.ts`、`src/infrastructure/sqlite/web-message-query.ts` | 只添加必要的有界读取端口或查询；原始历史数据不重写。先确认现有 v1–v8+ migration 和 checkpoint codec 版本，再决定是否需要新迁移。 |
| `test/legacy-run-inventory.test.ts`（新）、`docs/verification/2026-10-20-m2b-inventory.md`（新） | 固定样本覆盖完整、缺失、冲突和伪造的历史元数据；报告每类数量及证明来源。若可核验候选为零，到此结束，不新增迁移写路径。 |

### M2b.2 显式迁移（仅资格、设计与审核均通过时）

| 文件 | 具体工作 |
| --- | --- |
| `src/application/legacy-run-migration-service.ts`（条件性新增） | 对具名候选做当前身份账本、来源权限、旧事实和冻结快照的双重核验；操作者逐 Run 提交含 expected revision 的审核决定。迁移前后均写审计，重复请求幂等；任一不确定状态停止，不创建可执行 Run。 |
| `src/infrastructure/sqlite/durable-state-store.ts`、对应新 migration（条件性） | 只追加新版本的迁移审计/资格记录和必要的不可变只读映射；事务中保证 Run/证据/消息归属一致。不得覆盖旧 Snapshot、Checkpoint、事件或 Blob。当前 migration 版本以实施时仓库为准。 |
| `src/api/http-server.ts`、`src/bootstrap/agent-web-runtime.ts`（条件性） | 如确需本地审核入口，增加宿主显式启用的单操作者管理命令；默认关闭，严格请求 Schema，不允许浏览器自行声明历史来源或生成 Snapshot。历史只读展示可先独立提供。 |
| `test/legacy-run-migration.test.ts`、`test/target-http-routes.test.ts`、`test/target-recovery-harness.integration.test.ts`（条件性） | 覆盖审核冲突、重复请求、提交丢失、重启、旧 owner、来源撤权、跨 Target 归属和拒绝恢复；没有可信证明时模型/来源调用数必须为零。 |
| `docs/verification/2026-10-20-m2b-inventory.md`、`docs/implementation-status.md` | 记录逐 Run 决定和执行结果；区分只读标签与可恢复执行资格，不把“显示为某 Target”写成“已安全迁移”。 |

## 阶段门

M2b.1 盘点是 M2b.2 的硬前置。只有旧数据自身可证明完整身份、Spec 允许的显式审核路径已记录、现有安全门能在恢复与后续模型/来源操作前校验原规则及当前策略，才实施 M2b.2。任何不确定性保留 legacy/unbound 只读状态。实施条件性代码后执行仓库 lint/typecheck/test/build 和相关 Target/legacy 回归；若只有盘点文档，检查文档链接、证据对应关系和 Git diff 即可。
