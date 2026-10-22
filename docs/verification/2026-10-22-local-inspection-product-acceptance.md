# 本地多项目只读巡检系统验收记录

- 日期：2026-10-22（Asia/Shanghai）
- 计划：[S0–S6 实施计划](../superpowers/plans/2026-10-21-local-inspection-product.md)
- Spec：[本地巡检产品设计](../superpowers/specs/2026-10-21-local-inspection-product-design.md)
- 本轮阶段：S1；L01–L03 验收通过，L04–L14 未运行。

## 范围与基线

本轮在普通 `apps/agent-server` 入口启用本地模拟 Target 配置，组装双来源只读运行时，并通过真实本地 Prometheus HTTP 与 Logs MCP 模拟服务完成浏览器巡检。测试模型只由专用测试入口注入。没有访问 `group-buy-market`、生产 Prometheus/ELK、在线模型或外部服务，也没有引入真实写动作。

- 分支：`codex/event-message-v2`
- 实施前 HEAD：`1aab521151a32a517cd8e11387a33a23d389e41e`
- Node：`v24.19.0`
- pnpm：`v11.25.0`；仓库声明版本为 `11.19.0`
- 配置样例：`examples/local-inspection-targets.json`，Target A/B 使用同一合成输入，阈值分别为 5% 和 2%。

S0 本地基线、配置范围和验收目录已核对。`git ls-remote origin refs/heads/codex/event-message-v2` 初次因 `Could not resolve host: github.com` 失败；随后重试连接持续挂起并被中止，均未取得远端 SHA。S1 已独立提交到本地分支（提交 `6bb18e5`），尚未推送；不能宣称远端同步。

## L01–L03

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| L01 普通宿主 Target 双来源接线 | passed | `pnpm e2e:local-inspection` 通过；从普通 `apps/agent-server` 进程读取 `AGENTOPS_TARGET_CONFIG`，Targets 可启动且不会泄露来源端点。旧 simulation 浏览器路径由 `pnpm e2e:multi-target` 回归。 |
| L02 双 Target 证据与作用域隔离 | passed | 本地浏览器 E2E 对 A/B 都采集 Metrics+Logs；A 显示 5% 阈值且 `thresholdReached=false`，B 显示 2% 且为 true；切换 Target 后历史和证据隔离，跨 Target 读取/证据/取消返回 404。 |
| L03 取消、重启与历史配置快照 | passed | Target 活跃 Run 取消请求触发模型 Abort 并落为 `cancelled`；重启后旧证据保留原阈值/判定，新 Run 使用改动后的 Target 配置；现有 Target recovery integration 覆盖策略撤销门。 |

## 检查结果

已完成的检查及本轮结果：

- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm web:typecheck`：通过。
- `pnpm test`：通过；218 个文件通过、5 个 opt-in 文件跳过；2257 项通过、9 项跳过。命令包含 `pnpm build`。
- `pnpm e2e:local-inspection`：1/1 通过。
- `pnpm e2e:multi-target`：2/2 通过。
- `pnpm e2e:memory:multisource`：7/7 通过。
- `pnpm exec vitest run test/local-target-runtime.test.ts test/local-target-runtime-host.test.ts test/local-target-simulator.test.ts test/web-run-view.test.ts test/lazy-elk-evidence-source.test.ts`：此前 26 项通过；随后新增取消测试，`pnpm exec vitest run test/local-target-runtime-host.test.ts` 为 4/4 通过。
- `pnpm build` 与 `pnpm web:build`：由全量测试和 E2E 命令执行并通过。
- `git diff --check`：通过。

此前一次在默认沙箱内运行全量测试时，涉及 loopback 的测试被权限层拒绝并显示 `listen EPERM: operation not permitted 127.0.0.1`；该次未作为产品失败或通过依据。随后在 loopback 权限下重跑，全量套件通过。

## 未覆盖与限制

- S1 之外的 L04–L14 均为 `not_run`；特别是 Semantic/Procedural 记忆治理接线、11 个诊断质量样本、在线模型质量、持久化定时巡检、站内通知闭环、统一运维/备份恢复和 24 小时持续运行均未完成。
- 当前只验证本地合成数据与离线 ScriptedModel 路径，不代表生产数据、真实模型或上线认证授权验收。
- GitHub DNS/连接阻塞远端 SHA 核验与推送；本地提交 `6bb18e5` 尚待远端核验和普通推送。
