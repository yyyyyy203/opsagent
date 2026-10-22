# 普通宿主知识治理主机面：来源吊销与必需知识策略

- 日期：2026-10-22
- 状态：已采纳，仅用于 loopback 本地模拟宿主。
- 关联：[S0–S6 实施计划](../plans/2026-10-21-local-inspection-product.md) §5 S2、[本地单操作员审核决策](./2026-10-22-local-operator-knowledge-governance.md)。

## 背景

S2 剩余组合验收需要普通 Target 宿主能观察并验证两类治理边界：

1. **来源状态变化**：知识来源被吊销后，已发布知识不再进入模型输入，并在 Run 资格中标记 `KNOWLEDGE_SOURCE_REVOKED`。
2. **必需知识门禁**：知识被标记为 `required` 后，缺失/吊销/到期不得静默降级，Run 资格 `diagnosisReady` 必须为 `false`。

持久化层已具备完整能力（`KnowledgeSourceGovernanceStore.transitionSource`、`TargetKnowledgePolicyStore.compareAndSet`，均带 epoch-CAS、审计和 outbox），但普通宿主 HTTP 面没有触发入口，导致这两类行为只能停留在协调器/存储层测试，无法与正式 bootstrap 组合验收。

## 决策

在普通本地宿主新增两个最小治理路由，均由宿主可信配置解析 scope、actor、来源 dataDomainId 与 digest，调用方只提供选择器和 epoch：

1. `POST /targets/:targetId/knowledge/sources/:sourceId/revoke`
   - Body：`{ requestId, sourceVersion, expectedSourceEpoch }`。
   - 行为：`KnowledgeManagementService.revokeSource` 解析 Target scope/actor 与来源 `{ dataDomainId, sourceDigest }`，调用 `transitionSource({ transition: 'revoked' })`。只允许 `revoked` 一种转移，不暴露 `revalidated`（重新生效属后续独立决策）。

2. `PUT /targets/:targetId/knowledge/policy`
   - Body：`{ requestId, policyVersion, expectedPolicyEpoch, requirements }`，`requirements` 为 `{ id, version, digest, requiredness, knowledgeClass? }[]`（≤20）。
   - 行为：`KnowledgeManagementService.updatePolicy` 校验每条 requirement 必须引用当前已发布引用（id/version/digest 一致），`required` 必须带 `knowledgeClass`；随后 `compareAndSet` 落库（epoch-CAS）。

## 安全边界

- 两个路由只服务于 loopback 本地宿主（Agent Web 宿主已限制 `127.0.0.1`/`localhost`），复用本地单操作员身份，不改变对外认证边界。
- scope、actor、来源 dataDomainId、来源 digest、policy targetId 全部由宿主可信配置解析；请求 DTO 不得提供 scope/actor/digest，与既有审核/发布路由一致。
- 只允许把知识标为 `required` 或 `optional`，不新增自动写动作；`required` 缺失时按既有协调器 `qualification` 产生 `diagnosisReady:false` 与 `partial` 步级结果，不静默放行。
- `updatePolicy` 的 `compareAndSet` 冲突（`TARGET_IDENTITY_CONFLICT`）统一映射为 `KNOWLEDGE_PUBLICATION_CONFLICT`(409)，无效形状映射为 `KNOWLEDGE_RECORD_INVALID`(400)。

## 兼容性

- 不改变既有知识发布、审核、召回语义；不修改持久化 Schema、事件契约、记忆晋级规则或 Harness 顺序。
- `TargetKnowledgeManagementHostOptions` 新增必填 `sourceGovernance` 端口；`KnowledgeManagementService` 的 `revisions` 类型扩展到 `KnowledgeSourceGovernanceStore`（其底层存储本就实现该接口），无运行时行为变化。
- 故障注入（存储失败、超时、Abort、预算）仍按 Spec §4.2 禁止在普通宿主开启，由协调器层确定性覆盖；本决策不为普通宿主增加测试时钟或故障控制接口。

## 验收

- 拒绝知识（review `reject`）不可发布（422）且不进入模型输入。
- 来源吊销后已发布知识不再注入，Run 资格含 `KNOWLEDGE_SOURCE_REVOKED`。
- `required` 知识可用时注入且 `diagnosisReady:true`；吊销后不再注入且 `diagnosisReady:false`、缺口为 `KNOWLEDGE_REVOKED`。
