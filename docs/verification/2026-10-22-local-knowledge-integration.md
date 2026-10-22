# 本地 Target 受治理知识接线验收

- 日期：2026-10-22（Asia/Shanghai）
- 计划：[S0–S6 实施计划](../superpowers/plans/2026-10-21-local-inspection-product.md) §5 S2
- 设计：[本地巡检产品 Spec](../superpowers/specs/2026-10-21-local-inspection-product-design.md)
- 决策：[本地单操作员审核决策](../superpowers/decisions/2026-10-22-local-operator-knowledge-governance.md)
- 本次范围：S2.2 普通本地宿主接线和正向模型输入验收；S2 整体及 L04–L05 保持进行中。

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

下列覆盖仍需完成后才可将 S2/L04–L05 标记通过：明确拒绝与撤销后模型输入移除、到期边界、来源撤销/存储故障/超时/Abort 的 Target 知识路径、必需知识缺失门禁、从 Web UI 操作草稿/审核/发布的浏览器闭环，以及正式的逐类型 token/byte 预算断言。现有基础治理测试覆盖部分拒绝/撤销/到期与故障语义，但本次尚未完成其与 Target 普通宿主的组合验收。

未调用在线模型、生产数据源或外部服务；未修改被监测项目，也未增加写动作。远端同步结果以本次 Git 状态记录为准。
