# 多来源记忆异常与隔离验收实施计划

- 日期：2026-10-21（Asia/Shanghai）
- 依据：[Spec 与 R01–R12 验收矩阵](../specs/2026-10-21-multisource-memory-resilience-design.md)
- 状态：阶段 A、B、C、D 的本地实现与验收均通过；实施提交 `fb8355f` 已在本地，GitHub 分支查询因 DNS 无法解析而失败，当前尚未推送。逐条证据见[验收记录](../../verification/2026-10-21-multisource-memory-resilience-acceptance.md)和 STATUS。
- 分类：测试基础设施、适配器组合验收；仅按实际失败修复对应产品模块。
- 兼容性：沿用公共契约、存储 Schema、审核/晋级与冻结选择规则，预计无需迁移。

## 1. 执行约定

开始实施时重新阅读 AGENTS、PROJECT、STATUS、相关 DECISIONS，检查分支和工作区，不沿用本文盘点结果作为运行基线。使用本地模拟来源与确定性模型，不访问真实业务系统。

原计划以 A → B → C → D 实施。当前按实际缺口收尾：先补 B 的真实超时和审核 API 断言，再完成 A 的 Clock 与独立用例夹具，最后重跑 D；C 只作回归。每个可独立验收阶段先核对退出条件，再更新 STATUS、独立提交并推送；失败只能记为进行中或受阻。阶段提交包含实现时，按 AGENTS 运行 lint、typecheck、test、build，涉及 Web 同时运行 Web 检查。

## 2. 阶段 A：可信且隔离的测试夹具

目标：让异常注入、计时、请求观测和模型行为可以被验证，而不是由夹具固定返回预期结果。

| 文件 | 计划改动 |
| --- | --- |
| `test/e2e/memory-multisource-fixture-server.mjs` | 从启动参数读取有限场景和固定业务时间；把同一 Clock 注入 Runtime 并据此生成 Metrics/Logs 窗口；移除模型输入切换全局场景的路径。保留只读观测端点并保证进程退出清理。 |
| `test/e2e/memory-multisource-web.spec.ts` | 拆开异常矩阵的独立用例；每个用例开头断言空数据库和初始统计；核对场景下真实模型输入、状态和资源指标。 |
| `test/e2e/run-memory-multisource-cases.mjs`（拟新增） | 每个具名用例顺序启动新的 Playwright/Agent/Vite 进程和临时目录；一次构建，多次隔离运行；失败时保留 Playwright trace 并终止整组。 |
| `playwright.memory-multisource.config.ts`、`package.json` | 单 worker、禁止复用旧服务；只选当前场景用例，给子进程固定端口与场景/时钟；`e2e:memory:multisource` 调用上述隔离入口。 |

- [x] 列出现有测试与 R01–R12 的映射，确定需新增的组合断言。
- [x] 脚本模型依据实际 ToolResult 处理成功与失败，不因缺少 evidenceId 无限重试。
- [x] 为多来源夹具注入固定业务 Clock 并同步指标/日志窗口与证据时间；测试检查真实采集时间和窗口。正常场景模型实际输入仍记录案例召回 Run。
- [x] 每个具名用例由独立 Playwright、Agent、Vite 进程和临时 SQLite 目录承载；场景通过启动环境固定，不从消息内容切换。
- [x] 在 Node `globalThis.fetch` 与浏览器请求观测边界统计/阻止非允许目的地；用不发送网络的拦截自测验证。其他传输入口需先具体界定，不笼统宣称全进程保证。
- [x] 七个具名用例逐一以新进程运行；每个用例先验证空案例和零来源/模型计数，结束后启动器移除临时目录并验证所有服务端口已释放。

退出条件：R01 原正常闭环保持通过，R12 有可信结果；故障可以重复触发，模型能有界结束，观测覆盖范围已记录。若源码语义与 Spec 冲突，先登记差异，不改规则来迁就测试。

## 3. 阶段 B：来源异常与质量门

| 文件 | 计划改动 |
| --- | --- |
| `test/e2e/memory-multisource-web.spec.ts` | 增加 Metrics/Logs 单侧失败、超时及 partial 的浏览器流程；保留另一侧证据，检查限制和审核不可用原因。 |
| `test/memory-api.test.ts`、`test/memory-review-service.test.ts`；必要时新增多来源集成文件 | 复用现有 API 与审核服务测试；只有端到端场景无法定位缺口时才新增独立集成文件。 |
| `test/memory-capture-source.test.ts`、`test/memory-case-builder.test.ts`、`test/memory-review-service.test.ts` | 仅补发现缺失的双来源组合和边界，复用现有失败/不足/审核测试。 |
| `src/infrastructure/sqlite/memory-capture-source.ts`、`src/memory/case-builder.ts`、`src/memory/review-service.ts`、`apps/agent-web/src/components/MemoryPanel.tsx` | 条件性修复范围；先以失败测试复现，再最小修改。不得因计划列出文件就无条件重构。 |

- [x] 来源错误与立即抛出的模拟 TimeoutError 从 source 产生，没有 mock 最终 memory API；真实计时器触发的超时仍待补。
- [x] Metrics/Logs 失败、partial 和超时场景的候选引用回查对应子 Run/evidenceId、采集时间和 SHA-256。
- [x] 对 Metrics 失败、立即 TimeoutError、Logs 失败、Logs partial 和真实截止场景直接请求审核 API；均为 422/`MEMORY_APPROVAL_DENIED`，回读状态仍为 observation 且 revision 不变，UI 按钮禁用。
- [x] 持续等待的 Metrics 来源由 MCP 的 7 秒真实截止信号取消；三次有界调用均记录 TimeoutError，无指标成功证据，Run 结束且用例退出后端口释放。显式 Run cancel 由独立用例对照验证。
- [x] Logs 已有页后失败的 partial 行为按现有契约验证，保留完整指标证据引用。
- [x] requiredSources 可选/必需 Trace 的质量对照复用 `test/memory-capture-source.test.ts`；全量单测通过。

退出条件：R02–R05、R11 通过，R01 无回退；API 与 UI 对不足案例的处理一致。确定性模型的文字回答不作为唯一通过条件。

## 4. 阶段 C：召回资格与跨作用域隔离

| 文件 | 计划改动 |
| --- | --- |
| `test/e2e/memory-multisource-web.spec.ts`、`test/e2e/multi-target-web.spec.ts`（已扩展） | 前者覆盖未审核/撤销后的多来源召回，后者覆盖 Target 场景的过期展示和实际模型输入。 |
| `test/e2e/multi-target-fixture-server.mjs`、`test/e2e/multi-target-web.spec.ts`（已扩展） | 复用既有 Target 组装端口，A/B 共库，已覆盖真实采集、审核、召回、隔离和过期边界。 |
| `playwright.multi-target.config.ts`、`package.json`（已复用） | 通过既有 `e2e:multi-target` 入口运行 Target 记忆场景；没有另建独立命令。 |
| `test/memory-recall.test.ts` | 已复用同库 SQLite 逐维 scope 正反对照及过期边界，不另建多来源集成文件。 |
| `test/memory-recall.test.ts`、`test/memory-api.test.ts`、`test/e2e/memory-web.spec.ts` | 复用并回归已有过滤、冻结选择重校验、拒绝/撤销及接口隔离，按缺口补断言。 |

- [x] 案例通过实际采集、沉淀与审核产生，不直接 SQL 修改生命周期状态。
- [x] 每个不召回场景都有同 scope 合格案例的正向对照，排除关键词/预算错误。
- [x] 到期前、等于到期、到期后由 Clock 验证；新 Run 使用一致的新证据窗口。
- [x] A/B 共库，A 正向可用、B 不含 A 案例；跨 Target 读取证据和审核安全拒绝。
- [x] scope 由宿主解析和冻结，不能让浏览器或模型自由填写身份字段。
- [x] 服务和 dataset 单维变化在集成层验证；浏览器承担 Target 选择和展示路径。
- [x] 已批准的模拟案例仍不可晋级，撤销及过期不会新增持久化状态。

退出条件：R06–R10 通过；正向召回可观测，负向案例 ID/内容未进入模型；多 Target 与原有单来源记忆 UI 无回退。该阶段不以产品入口尚未接线为理由扩大到普通 agent-server 知识治理部署。

## 5. 阶段 D：回归、验收报告与交接

先执行核心/Web 构建和检查，再执行依赖构建的浏览器套件；共享端口或写同一构建目录的命令顺序运行。

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm web:typecheck
pnpm web:build
pnpm acceptance:memory
pnpm e2e:memory:multisource
pnpm e2e:multi-target
pnpm exec playwright test --config=playwright.memory.config.ts
AGENTOPS_MEMORY_E2E_DISABLED=1 pnpm exec playwright test --config=playwright.memory.config.ts -g 'disabled memory keeps existing inspection usable'
```

Target 记忆流程由 `pnpm e2e:multi-target` 覆盖；原记忆禁用态场景通过专门配置运行。记录实际选择、跳过和通过的测试，不把跳过计为通过。浏览器缺失、端口权限等环境问题须记录，不用旧日志代替。

- [x] 建立验收记录，逐条记录 R01–R12 对应测试、命令、结果及限制。
- [x] 记录 Node/pnpm、实际分支和代码基线、模拟来源配置、时钟/预算、请求观测范围；报告不含凭据。
- [x] 标明模拟验收与真实数据/在线模型/生产授权验收的边界。
- [x] 检查本任务修改、`git diff --check`，更新计划和 `docs/STATUS.md`。
- [x] 核对工作分支和远端；此前因网络阻塞未完成的提交已在本次 fetch 后普通 push，远端确认到 `a004da1`。
- [x] B/A 实现后重新执行本节相关核心、记忆、Target 和浏览器命令，并更新验收记录；本地检查通过。GitHub 分支查询因 DNS 失败，提交推送作为交付待办记录在 STATUS，不宣称远端已同步。

退出条件：R01–R12 有本次可复现证据，必要质量门通过，相关缺陷已修复，报告/状态更新并提交推送。文档编写完成、某一条正常测试通过或仅本地 commit 都不等于本实施计划完成。

## 6. 当前执行状态

| 阶段 | 状态 | 本次结果 |
| --- | --- | --- |
| A | 本地验收通过 | 固定 Clock、七个独立进程用例、空数据库/零计数起始检查、临时目录清理和端口释放检查通过。请求观测覆盖浏览器请求与 Node `globalThis.fetch`；MCP SDK 的 HTTP 入口经该 `fetch` 记录为 `GET/POST /mcp`。未覆盖绕开 `fetch` 的原生 socket 或其他进程。 |
| B | 通过 | 五种异常候选均由后端拒绝批准且状态/revision 不变；真实 7 秒 Metrics 截止取消与显式 Run cancel 分开通过，来源调用最多三次，超时原因及无错误成功证据均有结构化断言。 |
| C | 完成 | R08/R09：同库 Target A/B 的浏览器采集、批准、正向召回、切换后隔离、跨 Target 证据/审核拒绝通过；Clock 验证到期前、等于到期和到期后不召回，UI 显示过期且不重写批准状态。 |
| D | 本地验收通过，推送待办 | lint、typecheck、test、build、Web 检查、记忆验收、多来源/Target/记忆浏览器回归及 `git diff --check` 均有本次结果。远端查询失败：`Could not resolve host: github.com`。 |

本计划的代码实现与本地验收已完成，实施提交为 `fb8355f`。按 AGENTS §18 仍须远端核对并推送后才能关闭任务；当前因 DNS 失败尚未确认远端 SHA。R12 当前证明的请求边界为浏览器请求及 Node `fetch`（包括本夹具 MCP SDK 的 HTTP 请求）；没有证明任意 socket 或其他进程的全网出站。R08/R09 已完成，只需作为回归，不应重复实施。

## 7. 剩余改动的逐步实施方案

### 7.1 基线与交付收尾（约 0.5 天，网络时间另计）

1. 重新核对本分支、`git status --short`、`AGENTS.md`、PROJECT、STATUS、DECISIONS 和本 Spec/Plan。本轮方案基线提交 `18f2753` 已推送且远端核对成功；后续每阶段仍须先向远端查询最新 SHA，确认无远端独有提交后普通 push。网络不可用时把失败和待办写入 STATUS，继续本地可独立完成的实施，不用陈旧 `origin/` 引用声称远端已同步。
2. 固定本轮验收基线：记录 Node/pnpm 版本、现有 E2E 入口、R01–R12 上一轮证据。先运行受影响的定向测试，确认改动前的真实缺口；此前通过的质量门仅作历史记录。

### 7.2 R02–R05：真实超时与后端审核门禁（约 1–1.5 天）

| 文件 | 具体改动 | 验收证据 |
| --- | --- | --- |
| `test/e2e/memory-multisource-fixture-server.mjs` | 保留立即报错场景作为错误映射对照；新增 `metrics_deadline`，来源查询一直等待传入的 `AbortSignal`，收到 abort 后记录 `signal.reason` 的类型与次数，再按现有取消路径结束。使用 MCP 服务现有 7 秒截止信号，不推进业务 Clock 伪造超时。 | 观测到实际 abort，原因是截止时间；单次 Run 指标查询有界，来源无成功快照。 |
| `test/e2e/memory-multisource-web.spec.ts` | 为 Metrics 失败、Logs 失败、Logs partial 和 `metrics_deadline` 的候选直接发送批准请求，读取 `revision` 并用唯一 `requestId`；检查 422/`MEMORY_APPROVAL_DENIED`，随后 GET 案例确认状态仍为 `observation`、revision 不变。真实超时与显式 Run cancel 分开测试，断言终态、可用侧证据和取消计数。 | API 与 UI 都不能放行不足案例；真实超时由来源取消而非 Playwright 超时结束。 |
| `test/memory-api.test.ts`、`test/memory-review-service.test.ts` | 仅在组合验收暴露缺口时补稳定错误码、无审核事件/无状态变更的针对性回归。 | 使用结构化字段和持久化状态断言，不依赖错误文案。 |
| `src/infrastructure/mcp/settlement-server.ts` 或相关适配器 | 仅当上述测试证明现有超时信号未正确传播时最小修复；若 CI 确需缩短 7 秒，新增只供组装注入的正整数超时选项，默认值与生产行为保持 7000ms。 | 不改变公开 ToolResponse、事件、SQLite Schema、默认超时语义。 |

失败条件：来源没有收到实际 abort、Run 只能靠外部测试超时结束、批准请求成功、或审核失败后 revision/状态变化，都不能把 R04 或审核门禁标为通过。

### 7.3 R12：Clock、独立用例和请求边界（约 1 天）

1. 在 `memory-multisource-fixture-server.mjs` 由测试进程启动参数选定一个有限场景及固定 ISO 时间，创建 `Clock` 传给 `startAgentWebRuntime`；Metrics 快照、Logs 查询窗口和证据时间均从该 Clock 派生。移除从用户问题或模型消息提取 `E2E_SCENARIO` 并修改模块全局 `activeScenario` 的方式。测试断言 Run 上下文和证据窗口与夹具 Clock 一致。
2. 在 `memory-multisource-web.spec.ts` 将四个异常场景拆为具名用例。新增 `test/e2e/run-memory-multisource-cases.mjs` 顺序为每个用例启动一次 Playwright 命令；每次 Playwright 命令由 `playwright.memory-multisource.config.ts` 启动全新的 Agent 与 Vite，使用新的临时 SQLite 目录和统计。`package.json` 的 `e2e:memory:multisource` 先构建一次，再运行这些用例。启动前检查本地端口空闲，失败/结束均等待子进程退出并清理目录。
3. 每个用例第一步断言案例列表为空、模型调用/来源调用计数为初值；相邻用例使用相同问题仍无前一案例 ID 或模型历史标记。运行中场景不变。若实际启动器无法证明清理或会污染其他用例，先修启动器，不通过新增通用重置接口掩盖问题。
4. 盘点该夹具真实调用的浏览器请求、Node `globalThis.fetch`、MCP SDK/HTTP 入口。保留现有禁止目的地的无网络自测；若发现新的原生传输出口，再为该入口加观测或阻断并更新 Spec/验收报告。只对实际覆盖的入口声明没有外部发送。

### 7.4 最终回归与完成条件（约 0.5–1 天）

按依赖顺序重新运行：`pnpm lint`、`pnpm typecheck`、`TMPDIR=/private/tmp pnpm test`、`pnpm build`、`pnpm web:typecheck`、`pnpm web:build`、`TMPDIR=/private/tmp pnpm acceptance:memory`、`pnpm e2e:memory:multisource`、`pnpm e2e:multi-target`、原记忆 Web E2E 与禁用态用例。记录真实通过、失败、跳过和运行环境；浏览器命令需要本地 loopback/Chrome 时按现有验收环境运行。

更新[验收记录](../../verification/2026-10-21-multisource-memory-resilience-acceptance.md)的 R02–R05、R12 证据和请求观测边界，核对 R08/R09 回归；完成 `git diff --check`。先更新 STATUS 再标记阶段完成。逐阶段只提交本任务文件；推送前重新核对分支、远端 SHA 和提交内容，普通 push 并核对远端 HEAD。网络阻塞时明确记为“本地已验证、GitHub 未同步”，计划整体仍为进行中。

本轮只改测试夹具、测试入口与验收文档；公共事件、ToolResponse、MemoryScope、SQLite Schema、审核资格和 Harness 顺序均保持现有契约。如果测试揭示必须改变其中任一语义，先按 AGENTS §17 记录设计决策并修订本 Spec/Plan，再实施对应产品改动。

### 7.5 随后的产品任务

本计划关闭后，针对普通 `apps/agent-server` 是否组装 Target Runtime 与 Semantic/Procedural 知识治理 Host，另写接线 Spec/Plan 并以本地模拟 Target 验收。记忆审核 API 在对外开放前另设身份、角色和审计归属门槛；这两项不计入 R01–R12 的完成率。
