# S3 离线诊断质量集验收记录

- 日期：2026-10-23（Asia/Shanghai）
- 计划：[S0–S6 实施计划](../superpowers/plans/2026-10-21-local-inspection-product.md) §6
- Spec：[本地巡检产品设计](../superpowers/specs/2026-10-21-local-inspection-product-design.md) §6、§11（L06/L07）
- 本轮阶段：S3。L06（离线）通过；L07（在线模型质量）保持 `not_run`，并且四个样本之一为 `blocked`。

## 范围与基线

本轮只新增确定性场景族、模拟数据集、离线质量集与其验收入口，不改变 Agent Harness 顺序、工具执行管线、HITL、真实动作边界或已发布事件字段。没有访问 `group-buy-market`、生产 Prometheus/ELK、在线模型或 LangSmith；离线入口显式拒绝非回环请求。

- 分支：`codex/event-message-v2`
- 实施前 HEAD：`10d9082`
- Node：`v24.21.0`（仓库声明 `>=24.0.0 <25.0.0`）
- pnpm：`11.28.5`（仓库声明 `11.19.0`；pnpm 每次调用会先尝试联网校验 pinned 版本，本机以 `PATH=/tmp/dsh-node-unsigned` 的运行时副本执行，未修改仓库配置）
- 数据集：`local-scenario-windows-v1`，摘要 `sha256:v1:cf428c061e36d5be29fad8ddfaea56bff5d2bfb5eb222c052fb7c314ea7aa534`，冻结窗口 300 秒，评估时间 `1760000000`

## 本轮交付

| 文件 | 说明 |
| --- | --- |
| `src/profiles/scenarios/scenario-conclusions.ts`、`scenario-window.ts` | 五族共用的结论词表与窗口/输入校验助手；`root_cause_established`、`healthy_system_wide` 永远在禁止集合内 |
| `src/profiles/scenarios/window-latency-v1.ts` | 延迟族 `window_latency.v1` 1.0.0：分位数单调性、单位、样本量与 `p95 >= 阈值` 的确定性判定 |
| `src/profiles/scenarios/window-traffic-baseline-v1.ts` | 流量族 `window_traffic_baseline.v1` 1.0.0：基线窗口对齐/不重叠校验、`dropRatio >= 阈值`；基线缺失只报缺失，不推断 |
| `src/profiles/scenarios/dependency-correlation-v1.ts` | 依赖族 `dependency_correlation.v1` 1.0.0：区分已印证关联与仅时间重合；窗口内日志越界按稳定错误码拒绝 |
| `src/profiles/scenarios/resource-saturation-v1.ts` | 资源族 `resource_saturation.v1` 1.0.0：按信号阈值判定；信号数不足确认下限时只输出候选 |
| `src/profiles/scenarios/index.ts`、`src/profiles/index.ts` | 五族注册表与适用性查询（id/version/implementationDigest），公开入口同步导出 |
| `src/profiles/scenarios/window-failure-rate-v1.ts` | 仅新增 `windowFailureRateConclusionsV1` 纯映射；1.1.0 评估形状与摘要保持不变，避免破坏既有 Target 快照 |
| `src/infrastructure/simulator/scenario-window-fixtures.ts`、`scenario-window-server.ts` | 一致时间窗的模拟指标/日志数据集（19 个夹具，含正常、异常、歧义、低样本、缺失与矛盾信息）及回环 HTTP 只读服务 |
| `src/bootstrap/scenario-quality-lab.ts` | 进程内加载器与回环 lab（启动时一次性拉取夹具，实例级缓存，无模块级可变状态） |
| `src/acceptance/local-quality.ts` | 离线质量集运行器、确定性投影、预算/Abort、`schemaVersion: 1` 报告与 `parseLocalQualityReportV1` 复算防篡改 |
| `src/acceptance/local-quality-cases.ts` | 19 个具名样本与结构化预期（精确数值、缺失证据、允许/禁止结论、证据来源归属） |
| `src/acceptance/online-quality-plan.ts` | 在线四例批次清单（授权、凭据名与存在性、预算、probe 门禁、人工复核门槛），只生成清单不发起调用 |
| `src/acceptance/evaluator.ts`、`types.ts` | 可选 `scenarioApplicability` 输入与 `SCENARIO_APPLICABILITY` 检查；未声明时报告仍为原 13 项检查，人工批准不能补成通过 |
| `apps/acceptance/local-inspection-quality.mjs`、`package.json` | 新增 `acceptance:local-quality`、`acceptance:local-quality:loopback`；回环外请求被拒绝，报告写回后复算 |
| `test/fixtures/local-inspection-quality-cases.ts`、`test/local-inspection-quality.test.ts`、`test/acceptance-evaluator.test.ts` | 覆盖族/样本数量、冻结窗口、阈值边界、稳定错误码、缺失证据、结论边界、预算、Abort、报告防篡改、回环传输与适用性门禁 |
| `docs/guides/real-model-langsmith-acceptance.md` | 补离线质量集用法、在线四例选择、整批预算、凭据配置方式与人工复核步骤 |

## L06 离线质量集

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 五族至少 11 个具名样本确定性通过 | passed | 19 个样本：失败率 5、延迟 3、流量 3、依赖 4、资源 4；`pnpm acceptance:local-quality` 与 `--transport=loopback-http` 均 `verdict: passed`、`failedCases: []` |
| 报告记录模拟来源与模型模式 | passed | 报告固定 `modelMode: offline_deterministic`、`sourceMode: simulated`、`transport`、数据集 ID/摘要与 `windowSeconds: 300`；每个用例记录 scenario id/version/implementationDigest 与证据来源 |
| 异常证据不伪装完整 | passed | `fr-missing-window`→`unavailable`+`['end_boundary']`；`traffic-baseline-missing`→`baseline_missing`+`['baseline_count','baseline_window']`；`dep-log-source-missing`→`insufficient_evidence`+`['log_records','log_source']`；`res-series-missing`→`unavailable`+`['resource_series']`；限制型状态不得暴露 ratio/阈值触发判定，且必须允许一条限制性结论 |
| 矛盾与非法输入按稳定码拒绝 | passed | `fr-contradictory-total`→`INCONSISTENT_TOTAL`、`dep-record-outside-window`→`RECORD_OUTSIDE_WINDOW`；另有 `NON_MONOTONIC_QUANTILES`、`WINDOW_MISMATCH`、`BASELINE_OVERLAPS_CURRENT`、`BASELINE_WINDOW_MISALIGNED`、`ERROR_COUNT_EXCEEDS_CALLS`、`DUPLICATE_SIGNAL_KIND`、`SIGNALS_EMPTY`、`INVALID_UTILIZATION` 断言，且 `error.message === error.code` |
| 预算、Abort 与防篡改 | passed | `maxCases` 不足抛 `BUDGET_EXCEEDED`；假 Clock 超期后剩余用例 `not_run` 且整体 `failed`；Abort 后全部 `not_run`；改写 verdict/check/summary 或新增 `manualReview`、改 `sourceMode` 均触发 `REPORT_TAMPERED` |

报告产物：`test-results/local-inspection-quality/local-inspection-quality-report.json`（`test-results/` 已被忽略，不入库）；在线清单产物：`test-results/local-inspection-quality/online-quality-plan.json`。

## L07 在线模型质量

保持 `not_run`。本轮没有在线授权、模型凭据或 LangSmith 配置，也没有执行任何模型调用；`--online-plan` 生成的清单 `verdict: blocked`。

- 已就绪样本：正常（`normal`）、失败率异常（`settlement_failure`）、来源缺失（`logs_offline`）。
- 受阻样本：依赖歧义，原因码 `SCENARIO_NOT_BOUND_TO_TARGET_RUNTIME`。S3 新场景族尚未绑定 Target Catalog/运行时（当前绑定仍固定 `window_failure_rate.v1`），因此无法用真实 Run 产生依赖歧义样本。
- 门槛未变：显式 opt-in、整批 4 个父 Run、每样本 1 次、无自动重跑、当次 LangSmith probe 门禁、逐 Run 人工复核且 unsupported claims 为 0。

## 检查结果

本轮实际执行：

- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `TMPDIR=/private/tmp pnpm test`：219 个文件通过、5 个 opt-in 文件跳过；2280 项通过、9 项跳过。
- `pnpm build`、`pnpm web:typecheck`、`pnpm web:build`：通过。
- `git diff --check`：通过。
- `pnpm acceptance:local-quality`：`verdict: passed`，19/19。
- `node apps/acceptance/local-inspection-quality.mjs --transport=loopback-http`：`verdict: passed`，19/19。
- `node apps/acceptance/local-inspection-quality.mjs --online-plan`：清单写出，`verdict: blocked`。
- `TMPDIR=/private/tmp pnpm acceptance:memory`：13 项检查与六行策略矩阵通过（回归）。
- `TMPDIR=/private/tmp pnpm e2e:local-inspection`：2/2 通过（回归）。
- `TMPDIR=/private/tmp pnpm e2e:multi-target`：2/2 通过（回归）。
- `pnpm exec vitest run test/local-inspection-quality.test.ts`：15/15 通过（含回环传输用例）。

未执行：`pnpm e2e:memory:multisource`、`pnpm acceptance:real-model`、`pnpm acceptance:trace-probe`、24 小时持续运行。前三者分别属于 S2 记忆路径回归与在线验收，本轮未触碰其接线；在线验收缺授权与凭据。

## 与计划的差异

- 计划把具名样本表放在 `test/fixtures/local-inspection-quality-cases.ts`。为让离线 CLI 与测试共用同一张表且不重复抽象，权威样本表落在 `src/acceptance/local-quality-cases.ts`，测试夹具文件复用该表并补充篡改/非法变体。
- 计划提到修改 `src/bootstrap/metrics-lab.ts`、`logs-lab.ts`。两个 lab 都是结算场景专用，本轮改为新增独立的 `scenario-window-fixtures.ts` + `scenario-window-server.ts` + `scenario-quality-lab.ts`，不改动既有 lab 行为。
- 新场景族尚未接入 Target Catalog/运行时绑定与 Metrics Subagent，属于后续独立任务；本轮只交付离线确定性质量集，不宣称真实 Target 运行可使用新族。
- `SCENARIO_APPLICABILITY` 为可选检查：只有 Run 显式声明场景绑定时才出现，历史报告检查列表保持 13 项不变。

## 限制

- 全部数据为本地模拟，不代表真实业务指标、日志或链路。
- 离线通过只证明工程路径与确定性计算，不证明模型诊断质量；L07 未运行时不得称“本地诊断可用通过”。
- 结论词表覆盖窗口级判定，不包含跨窗口趋势、发布变更或容量预测。
