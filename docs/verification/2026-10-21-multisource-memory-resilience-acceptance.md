# 多来源记忆异常与隔离验收记录

- 日期：2026-10-21（Asia/Shanghai）
- 分支：`codex/event-message-v2`
- Spec：[多来源记忆异常与隔离验收](../superpowers/specs/2026-10-21-multisource-memory-resilience-design.md)
- Plan：[阶段 A–D 实施计划](../superpowers/plans/2026-10-21-multisource-memory-resilience.md)
- 环境：Node.js v24.19.0；实际 pnpm v11.25.0（仓库声明目标为 pnpm 11.19.0，版本有差异）。固定多来源 Clock 为 `2026-10-21T12:00:00.000Z`，共享指标/日志窗口为 `11:55–12:00Z`。
- 数据：本地模拟 Metrics、Logs、Trace 缺失场景与 ScriptedModel；未连接在线模型、真实 Prometheus/ELK 或 `group-buy-market`。

## R01–R12 覆盖

| ID | 结果 | 本次证据与边界 |
| --- | --- | --- |
| R01 | 通过 | `pnpm e2e:memory:multisource` 的正常浏览器流程覆盖模拟 Metrics+Logs、Trace 限制、手动沉淀/批准、同 scope 再召回、撤销后不召回；`pnpm acceptance:memory` 的 13 项检查与 6 格策略矩阵通过。批准案例不可晋级由现有记忆验收断言覆盖。 |
| R02 | 通过 | 独立 `metrics_failure` 用例保留 Logs；不足候选直接请求 `POST /memory/cases/:id/review`，返回 422/`MEMORY_APPROVAL_DENIED`，再次 GET 后仍为 observation 且 revision 未变；UI 按钮禁用。案例引用匹配子 Run 的 ownerRunId/evidenceId、capturedAt 和 SHA-256。 |
| R03 | 通过 | 独立 `logs_failure` 用例保留 Metrics，并执行相同后端审核拒绝、状态/revision 不变及证据引用回查断言。 |
| R04 | 通过（真实本地超时信号） | `metrics_deadline` 来源持续等待，MCP 现有 7 秒 `AbortSignal.timeout` 触发；三个有界尝试均由来源记录 `TimeoutError`，Run 终止且没有错误成功的指标证据。另有 `metrics_timeout` 即时 TimeoutError 映射对照和独立 `metrics_hang` 显式 Run cancel，后者 Run 为 cancelled 且来源收到 Abort。 |
| R05 | 通过 | `logs_partial` 在第二页失败，仍保留指标及已采集日志的 partial 状态；不足候选通过真实审核 API 被拒绝，案例状态/revision 不变且 UI 按钮禁用。 |
| R06 | 通过 | 多来源浏览器流程先检查 observation 不进入模型输入，批准后检查召回；既有记忆 API/召回测试覆盖拒绝资格过滤。单来源记忆 E2E 亦覆盖拒绝流程。 |
| R07 | 通过 | 多来源流程批准后召回、撤销后再次运行并检查模型输入不再含该案例；`test/memory-recall.test.ts` 覆盖冻结选择重校验。 |
| R08 | 通过 | `pnpm e2e:multi-target` 中的 Target 记忆浏览器流程先在有效期内正向召回，再由注入 Clock 精确推进到 `validUntil` 及其后 1ms；两次新 Run 的实际模型输入都不含案例标记。UI 显示“已过期，不能作为历史参考”，原案例仍是已批准状态。 |
| R09 | 通过 | 同一 Target Web 宿主及 SQLite：A 经真实 Target Run 工具管线采集证据、手动沉淀、批准并在实际后续模型输入中召回；B 切换后案例列表为空、模型输入没有 A 标记。B 跨 Target 读取 A 案例/证据及提交审核均返回 404。另有 `test/memory-recall.test.ts` 的同库 A/B 正向隔离集成断言。 |
| R10 | 通过（存储/召回层） | 新增 SQLite 作用域用例对 Target、dataset、service 做正向与反向隔离断言；`test/memory-recall.test.ts` 另有完整 scope 维度过滤测试。未另建 Target 端到端浏览器入口。 |
| R11 | 通过（确定性策略验收） | 全量单测中的 `test/memory-capture-source.test.ts` 对比 Trace 非必需/必需时的完整性判定；`pnpm acceptance:memory` 的六格采集/召回策略矩阵通过。 |
| R12 | 通过（边界明确） | 七个具名浏览器用例各自在新的 Playwright、Agent、Vite 进程及临时 SQLite 目录运行；每次检查空案例、零模型/来源计数，退出时删除目录并核对 Agent/Web/控制端口已释放。启动参数固定场景与 Clock，不从用户消息切换。浏览器请求仅访问本地 Web/Agent；Node `globalThis.fetch` 记录允许 MCP 端点的 `GET/POST /mcp`，仅允许本进程创建的 Metrics/Logs MCP 来源，并在发出网络请求前拦截禁止目的地自测。未覆盖绕开 `fetch` 的原生 socket 或其他进程，不作全传输栈保证。 |

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
| `pnpm e2e:memory:multisource` | 通过：7 个具名用例各在独立进程运行。覆盖正常记忆闭环、Metrics 失败/即时超时/真实截止、Logs 失败/partial 和显式 Run cancel；每个场景均验证新目录/零初始计数，退出核对临时目录及服务端口释放。命令中的核心与 Web 构建通过。 |
| `pnpm e2e:multi-target` | 通过：2/2，包含既有 Target 工作台回归和新的 Target 记忆隔离/到期流程。使用本机 Chrome 可执行文件配置。 |
| `pnpm exec playwright test --config=playwright.memory.config.ts` | 通过：10 项通过、1 项跳过。 |
| `AGENTOPS_MEMORY_E2E_DISABLED=1 pnpm exec playwright test --config=playwright.memory.config.ts -g 'disabled memory keeps existing inspection usable'` | 通过：1/1。 |
| `git diff --check` | 通过。 |

说明：浏览器夹具依赖本地 Node/Chrome 与 loopback 监听。沙箱默认拒绝监听，因此最终 E2E 和模拟验收在获准的本机 loopback 执行。`TMPDIR=/private/tmp` 用于 macOS SQLite/验收目录校验。测试对 Node `globalThis.fetch` 的观测不能证明任意传输栈或其他进程均无外部请求；所有受测来源和模型均为本地模拟。

## 完成状态与交付限制

- 本计划 A–D 的实现与本地验收通过；未修改产品运行时、公共契约、持久化 Schema 或记忆审核语义。`git diff --check` 通过。
- 当前实现仍须独立提交并推送到 `codex/event-message-v2`。本轮 `git ls-remote origin refs/heads/codex/event-message-v2` 返回 `Could not resolve host: github.com`，因此远端 SHA 尚不可核验，不能称为已同步。网络恢复后先查询远端，再普通推送并核验 HEAD；禁止使用陈旧 `origin/` 跟踪引用代替远端查询。
