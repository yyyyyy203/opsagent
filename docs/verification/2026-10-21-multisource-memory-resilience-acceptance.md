# 多来源记忆异常与隔离验收记录

- 日期：2026-10-21（Asia/Shanghai）
- 分支：`codex/event-message-v2`
- Spec：[多来源记忆异常与隔离验收](../superpowers/specs/2026-10-21-multisource-memory-resilience-design.md)
- Plan：[阶段 A–D 实施计划](../superpowers/plans/2026-10-21-multisource-memory-resilience.md)
- 环境：Node.js v24.19.0；实际 pnpm v11.25.0（仓库声明目标为 pnpm 11.19.0，版本有差异）
- 数据：本地模拟 Metrics、Logs、Trace 缺失场景与 ScriptedModel；未连接在线模型、真实 Prometheus/ELK 或 `group-buy-market`。

## R01–R12 覆盖

| ID | 结果 | 本次证据与边界 |
| --- | --- | --- |
| R01 | 通过 | `pnpm e2e:memory:multisource` 的正常浏览器流程覆盖模拟 Metrics+Logs、Trace 限制、手动沉淀/批准、同 scope 再召回、撤销后不召回；`pnpm acceptance:memory` 的 13 项检查与 6 格策略矩阵通过。批准案例不可晋级由现有记忆验收断言覆盖。 |
| R02 | 通过 | 多来源 E2E 的 `metrics_failure` 保留 Logs，案例为 `insufficient`/`observation`/`eligibleForPromotion=false`，审核按钮禁用。 |
| R03 | 通过 | 同一 E2E 的 `logs_failure` 保留 Metrics，并验证不足案例不能批准。 |
| R04 | 通过（模拟边界） | `metrics_timeout` 验证超时后有界结束；`metrics_hang` 经 Run cancel 后到达 `cancelled`，来源收到 Abort。超时 E2E 的指标调用上限为 3。 |
| R05 | 通过 | `logs_partial` 在第二页失败，浏览器读取到 `log` partial 证据，候选不足且不可批准。 |
| R06 | 通过 | 多来源浏览器流程先检查 observation 不进入模型输入，批准后检查召回；既有记忆 API/召回测试覆盖拒绝资格过滤。单来源记忆 E2E 亦覆盖拒绝流程。 |
| R07 | 通过 | 多来源流程批准后召回、撤销后再次运行并检查模型输入不再含该案例；`test/memory-recall.test.ts` 覆盖冻结选择重校验。 |
| R08 | 通过 | `pnpm e2e:multi-target` 中的 Target 记忆浏览器流程先在有效期内正向召回，再由注入 Clock 精确推进到 `validUntil` 及其后 1ms；两次新 Run 的实际模型输入都不含案例标记。UI 显示“已过期，不能作为历史参考”，原案例仍是已批准状态。 |
| R09 | 通过 | 同一 Target Web 宿主及 SQLite：A 经真实 Target Run 工具管线采集证据、手动沉淀、批准并在实际后续模型输入中召回；B 切换后案例列表为空、模型输入没有 A 标记。B 跨 Target 读取 A 案例/证据及提交审核均返回 404。另有 `test/memory-recall.test.ts` 的同库 A/B 正向隔离集成断言。 |
| R10 | 通过（存储/召回层） | 新增 SQLite 作用域用例对 Target、dataset、service 做正向与反向隔离断言；`test/memory-recall.test.ts` 另有完整 scope 维度过滤测试。未另建 Target 端到端浏览器入口。 |
| R11 | 通过（既有策略验收） | `pnpm acceptance:memory` 的 6 格策略矩阵通过，Trace 可选/必需的质量策略由现有确定性策略验收覆盖；本轮未新增独立 Trace-required 浏览器场景。 |
| R12 | 部分通过 | 多来源夹具以实际 Node `globalThis.fetch` 后端传输入口记录允许来源、方法并拦截非本地来源；禁止目的地自测在发起网络请求前被拒绝。浏览器来源也受断言。观测不覆盖绕开 `fetch` 的原生 socket/其他进程传输；场景通过 Run 提示中的有限 marker 选择，测试串行运行，未提供通用活动 Run 重置控制面。 |

## 本次命令结果

以下命令均在本轮实际执行。浏览器测试使用本地 loopback 服务；因受限执行环境默认禁止监听本地端口，相关 E2E/验收命令在获准的本机 loopback 环境运行。为避开 macOS 临时目录符号链接差异，全量测试及记忆验收设置 `TMPDIR=/private/tmp`。

| 命令 | 结果 |
| --- | --- |
| `pnpm lint` | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过 |
| `pnpm web:typecheck` | 通过 |
| `pnpm web:build` | 通过 |
| `TMPDIR=/private/tmp pnpm test` | 通过：215 个文件通过、5 个 opt-in 文件跳过；2247 项通过、9 项跳过。 |
| `TMPDIR=/private/tmp pnpm acceptance:memory` | 通过：13 项检查、6 格策略矩阵；`modelRequestsSent=0`、`externalRequestsSent=0`、`externalRequestsBlocked=0`。 |
| `AGENTOPS_MEMORY_MULTI_E2E_AGENT_PORT=48700 AGENTOPS_MEMORY_MULTI_E2E_WEB_PORT=48773 AGENTOPS_MEMORY_MULTI_E2E_CONTROL_PORT=48701 pnpm e2e:memory:multisource` | 通过：3/3。覆盖正常闭环、4 个来源异常场景、活动来源请求取消；Web 与核心构建通过。 |
| `pnpm e2e:multi-target` | 通过：2/2，包含既有 Target 工作台回归和新的 Target 记忆隔离/到期流程。使用本机 Chrome 可执行文件配置。 |
| `pnpm exec playwright test --config=playwright.memory.config.ts` | 通过：10 项通过、1 项跳过。 |
| `AGENTOPS_MEMORY_E2E_DISABLED=1 pnpm exec playwright test --config=playwright.memory.config.ts -g 'disabled memory keeps existing inspection usable'` | 通过：1/1。 |
| `git diff --check` | 通过。 |

说明：浏览器夹具依赖本地 Node/Chrome。测试对 `globalThis.fetch` 的观测不能证明任意传输栈均无外部请求；离线验收的来源和模型配置均为本地模拟。

## 未完成与下一步

- R12 / 阶段 A：决定是否需针对原生 HTTP/socket 补观测；当前报告只声明 Node `globalThis.fetch` 和浏览器请求范围，并使用单 worker 串行用例，不外推为全进程网络保证或通用运行中重置能力。
- Target 记忆闭环与过期行为提交 `0ef4634` 及后续状态记录已在 2026-10-21 fetch 核对远端无独有提交后普通 push；远端分支确认更新至 `a004da1`。后续若扩充 R12 观测范围，先界定具体传输入口并更新 Spec/Plan 和验收证据。
