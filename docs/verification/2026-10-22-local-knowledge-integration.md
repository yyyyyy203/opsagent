# 本地 Target 受治理知识接线验收

- 日期：2026-10-22（Asia/Shanghai）
- 计划：[S0–S6 实施计划](../superpowers/plans/2026-10-21-local-inspection-product.md) §5 S2
- 设计：[本地巡检产品 Spec](../superpowers/specs/2026-10-21-local-inspection-product-design.md)
- 决策：[本地单操作员审核决策](../superpowers/decisions/2026-10-22-local-operator-knowledge-governance.md)
- 原始验收范围：S2.2 普通本地宿主接线和正向模型输入。本文末尾追加后续 S2 组合验收；S2 整体及 L04–L05 仍进行中。

## 结果

普通 `apps/agent-server` Target Runtime 现在可在显式模拟配置中组装 Semantic、Procedural 与 Episodic 记忆。端到端用例经实际 loopback Metrics/Logs 来源完成 Semantic/Procedural 草稿、提交、审核、发布；A 的模型输入含两类内容及精确 ID/version/digest，切换 B 后无 A 条目；关闭记忆后不注入；重启宿主后 A 的已发布条目仍可召回。

验收过程还定位并修复三个既有接线缺陷：发布 overlay 把配置策略和动态发布引用视作完全相等，导致协调器拒绝所有已发布知识；SQLite FTS 召回把查询所有词设为 AND，正常查询会遗漏精确白名单知识；协调器传入 limit 64，超过存储端上限 50 并触发失败关闭。现已分别按宿主策略版本与发布引用核验、在精确 scope/reference 过滤后按任一查询词召回并排序、将候选上限限制为 50。知识输入预算受限在 4 KiB；Episodic 渲染仍为 1 KiB。

本地单操作员审核只在明确启用的 loopback 宿主中工作。actor、scope、来源 epoch/digest 均由持久化端解析；默认宿主仍使用拒绝型 authority。此模式不支持多用户或远程部署，见决策记录。

## 本轮检查

- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过，并由全量测试/E2E 再次运行。
- `pnpm web:typecheck`：通过。
- `pnpm web:build`：通过，由浏览器验收命令运行。
- `TMPDIR=/private/tmp pnpm test`：通过；218 个测试文件通过、5 个 opt-in 文件跳过；2259 项通过、9 项跳过。
- `TMPDIR=/private/tmp pnpm acceptance:memory`：通过；13 项策略与安全检查、六格 capture/recall 矩阵通过，0 模型请求、0 外部请求。
- `pnpm exec vitest run test/local-target-runtime-host.test.ts test/local-target-runtime.test.ts test/target-knowledge-publication.test.ts test/memory-coordinator.test.ts`：71 项通过。
- `pnpm e2e:local-inspection`：重跑后 1/1 通过。首次运行有一次模拟 Metrics 子 Run 未产出证据，立即重跑通过；已作为瞬态失败保留记录。
- `pnpm e2e:multi-target`：2/2 通过。
- `pnpm e2e:memory:multisource`：7 个独立场景全部通过。
- HTTP/API、宿主和浏览器集成需 loopback 绑定权限；默认沙箱出现 `listen EPERM` 的运行未算作通过依据，均在允许 loopback 后重跑。

## 尚未验收

截至原始验收，下列覆盖仍需完成。

未调用在线模型、生产数据源或外部服务；未修改被监测项目，也未增加写动作。远端同步结果以本次 Git 状态记录为准。

## 2026-10-22 后续组合验收

本次继续补上普通 Target 宿主中的知识撤销与有效期边界：固定 Clock 为 `2026-10-22T12:00:00Z`，新增一条一分钟后到期的 Semantic 知识。有效期内三条知识均进入 A 的模型输入；Procedural 被撤销后下一次 Run 不再包含该条，仍保留 Semantic 和未到期条目；时钟推进两分钟并重启宿主后，过期条目不再注入，未到期 Semantic 仍可召回。随后以记忆关闭的宿主再次验证三条均不注入。测试使用真实本地 SQLite 持久化和模拟 Metrics/Logs 来源。

浏览器新增治理闭环：在 A 的“系统知识”页创建 Semantic 草稿、提交、批准并发布；A 随后的 Run 将 canary 内容送入 ScriptedModel 实际输入；切换 B 后没有 A 的知识记录或发布绑定。

本次验证：`pnpm exec vitest run test/local-target-runtime-host.test.ts -t 'publishes Semantic and Procedural knowledge'` 1 项通过；`pnpm e2e:local-inspection` 首次运行时双 Target 案例遇到一次模拟 Metrics 未产出证据，随即重跑 2/2 通过（知识浏览器用例两次均通过）；`pnpm lint`、`pnpm typecheck`、`pnpm web:typecheck` 通过；`TMPDIR=/private/tmp pnpm test` 全量 218 文件通过、5 个 opt-in 文件跳过，2259 项通过、9 项跳过。第一次在默认沙箱中运行全量测试因 loopback `EPERM` 造成 101 项失败，不计为代码回归；在允许本机 loopback 后完整重跑通过。E2E 同样仅访问本地模拟服务。

仍待完成：Target 普通宿主中的拒绝后不注入、来源状态撤销/变化、知识存储故障和超时组合、显式取消/Abort 路径、required 知识缺失时的 Run 门禁，以及 Semantic/Procedural/Episodic 的独立输入预算边界断言。协调器层已有 required、存储失败、deadline 和 Abort 单测，但不替代宿主组合验收。S2/L04–L05 不因此标为完成。

## 2026-10-22 治理边界组合验收（拒绝 / 来源吊销 / 必需知识门禁）

本次补齐普通 Target 宿主剩余的治理边界组合验收，并为此新增两个最小治理路由（见[设计决策](../../superpowers/decisions/2026-10-22-knowledge-governance-host-surface.md)）：

1. **拒绝后不注入**：Semantic 草稿提交后以 `decision:'reject'` 审核，状态为 `rejected`；用该引用发布返回 422（`KNOWLEDGE_APPROVAL_DENIED`）；随后 A 的 Run 模型输入不含该 canary。
2. **来源状态变化**：发布一条绑定 `local-settlement-runbook` 的 Semantic 知识并验证注入；通过 `POST /targets/market-a-sim/knowledge/sources/local-settlement-runbook/revoke`（`expectedSourceEpoch:0`）吊销来源后，下一次 Run 不再注入，Run 资格 `missingKnowledge` 含 `KNOWLEDGE_SOURCE_REVOKED` 且 `diagnosisReady` 仍为 `true`（可选知识降级）。
3. **必需知识门禁**：发布 Semantic 后通过 `PUT /targets/market-a-sim/knowledge/policy`（`policyVersion:'required/v1'`，`requiredness:'required'`，`knowledgeClass:'semantic'`）把知识标记为必需；验证 `policyEpoch:1` 且知识仍注入、`diagnosisReady:true`；再用既有 revoke 路由吊销该知识后，下一次 Run 不再注入、`diagnosisReady:false`、`missingKnowledge` 含 `KNOWLEDGE_REVOKED` 且 `requiredness:'required'`。

以上三条均通过普通 `apps/agent-server` 正式 bootstrap（真实 SQLite、真实 Resolver/OperationPolicy/RuntimeProvider、loopback 模拟 Metrics/Logs 来源），模型输入通过 ScriptedModel 实际录制，Run 资格通过 `/targets/:id/runs/:id` 的 `knowledgeQualification` 断言。

存储失败 / 超时 / Abort / 逐类型预算仍保持协调器层确定性覆盖（`memory-coordinator.test.ts` 已断言 required 门禁、存储失败、deadline、Abort、预算）；Spec §4.2 明确禁止普通宿主开启故障控制/测试时钟，因此这些故障注入不与正式宿主组合。Episodic 正向召回沿用多来源记忆既有验收（simulation Profile），本轮未在 Target 宿主重测。

本轮检查：`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm web:typecheck`、`pnpm web:build` 通过；`pnpm exec vitest run test/local-target-runtime-host.test.ts` 8/8 通过（含 3 条新组合用例）；`pnpm exec vitest run test/knowledge-memory-api.test.ts test/procedural-template-service.test.ts test/memory-coordinator.test.ts test/target-knowledge-publication.test.ts test/knowledge-memory-contract.test.ts` 125/125 通过；全量 `TMPDIR=/private/tmp pnpm test` 218 文件通过、5 个 opt-in 文件跳过，2262 项通过、9 项跳过。未运行浏览器 E2E（本轮改动仅核心治理路由与主机级测试，未触碰 Web 前端）。
