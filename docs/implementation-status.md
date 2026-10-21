# 实现进度与验证记录

## 2026-10-21：多项目 M4/M5 与 M2b 盘点执行

按 [M4 逐文件实施计划](./superpowers/plans/2026-10-20-multi-project-m4.md)、[M5 联合验收计划](./superpowers/plans/2026-10-20-multi-project-m5.md) 和 [M2b 条件迁移计划](./superpowers/plans/2026-10-20-multi-project-m2b.md) 执行。M4 已接入 Target 范围游标、冻结 Snapshot 安全标签、legacy `/runs` 分页前过滤、Target 消息/证据/确认与父子归属查询门、legacy 入口拒绝、Target Episodic 路由和冻结 MemoryScope 校验。Target 创建偏好只接收 capture/recall，进入幂等摘要，未提供偏好的旧请求保持摘要兼容；合同记录在 [Target Memory Preferences 决定](./superpowers/decisions/2026-10-21-target-memory-preferences.md)。

Web 增加 Target 与 simulation 双模式，Target 模式按宿主目录选择目标并使用 Target-scoped Run、SSE、消息、证据、确认和记忆 API；报告显示冻结 Snapshot 身份。浏览器回归验证 A/B 阈值、跨 Target/legacy 访问拒绝、迟到响应隔离、历史和 simulation。新增双 Target Playwright fixture、200 Target/50 来源分区容量验收和十个并发父 Run 负载验收；M5 另增加单进程 FIFO 根 Run 上限，决策见 [Root Run 准入上限](./superpowers/decisions/2026-10-21-root-run-admission-limit.md)。固定 fixture 使用 ScriptedModel/本地模拟数据，不代表真实 `group-buy-market` 数据源或生产验收。

M2b 只读盘点未找到工作树内 SQLite/DB 文件，`AGENTOPS_DATA_DIR` 未配置，且宿主启动要求显式提供数据目录；候选旧 Run 数为零。M2b.1 按阶段门完成，M2b.2 未触发；没有新增历史绑定或迁移写路径。证据记录在[盘点报告](./verification/2026-10-21-m2b-inventory.md)。

**验收结果：**根 lint/typecheck/build、全仓测试、Web typecheck/build、`e2e:multi-target`、容量和负载验收均通过。Vitest 215 个文件通过、5 个 opt-in 文件跳过；2241 项通过、9 项跳过。双 Target 浏览器 1/1 通过；容量和负载分位数与剩余限制见 [M5 验收记录](./verification/2026-10-21-multi-project-m5-acceptance.md)。M4/M5 的模拟验收完成；真实业务目标未接入。逐文件实施和未改计划文件的原因见 [M4 计划执行记录](./superpowers/plans/2026-10-20-multi-project-m4.md)。

## 2026-10-10：Prometheus + 熔断前端联合验收

新增独立 `pnpm e2e:circuit:prometheus` 验收入口，复用真实 Agent Web Runtime、MCP、熔断器、V2 SSE 和前端流程，但将 Metrics Lab 的恢复查询连接到本地 Docker Prometheus。模拟器在 MCP 来源边界注入 9 次失败；熔断期间 Prometheus 查询数保持 0。经过第一次失败的半开探测、重新熔断及第二轮冷却后，唯一成功探测实际调用 `PrometheusSettlementSource`，读回模拟窗口 100 笔/15 次失败。Public Evidence/UI 只保留摘要和引用，不暴露 Prometheus 原始指标名。

验证：Prometheus 联合浏览器 E2E 1/1 通过；原确定性熔断浏览器 E2E 1/1 通过；聚焦 MCP/指标回归 4 个文件、51 项通过；opt-in Prometheus → MCP → Web 集成 2/2 通过；默认全仓 Vitest 158 个文件通过、3 个 opt-in 文件跳过，共 1,334 项通过、7 项跳过。Node 24 下根构建、Web 构建、根/Web 类型检查、全仓 lint 及 `git diff --check` 通过。首次 E2E 红灯确认原夹具返回 `sourceMode=deterministic`，修正接线后绿灯通过。

该验收使用本地模拟遥测与 `ScriptedModel`，没有调用在线模型、LangSmith、ELK 或 `group-buy-market`；结论仅证明本地 Prometheus → MCP → Agent/Web 熔断与恢复闭环，不代表业务目标系统或生产数据验收。没有改动生产熔断策略、公共 Event/Message 契约或持久化 Schema；未 commit/push。

## 2026-10-10：半开探测失败后重新熔断的浏览器验收

扩展既有确定性熔断 E2E 为 7 个父 Run：保留初始 9 次物理失败、6 次重试、首次冷却边界及最终证据关联断言；在第一次冷却结束时额外注入一次来源故障，验证半开探测不追加重试、重新产生熔断打开事件。该故障消费后若错误地重试，确定性来源会立即成功，测试会通过成功查询计数及页面状态识别此问题。失败父/子 Run 的证据引用和证据列表均为空，页面不显示恢复。

重新熔断后立即发起查询及第二轮冷却的第 29,999 毫秒发起查询，均收到 `CIRCUIT_OPEN` 且来源成功查询数仍为 0；最后 1 毫秒过后仅显示探测待触发，后续一次探测成功才显示恢复并生成父子关联证据。测试控制面只允许按顺序进行第二次故障注入和时钟推进，并拒绝重复注入。机制测试另让失败探测耗时 500 ms，精确验证新冷却截止为失败完成后 30 秒，而非首次打开或探测开始后 30 秒。

验证：新 E2E 先在旧夹具处得到预期的第二次注入拒绝（409），补齐夹具后通过；最终浏览器复验 1/1 通过（场景 9.2 秒），机制测试 13/13 通过。全仓默认 Vitest 在 2 个 worker 下为 158 个文件通过、3 个 opt-in 文件跳过，1,334 项通过、7 项跳过；全仓 lint、根/Web 类型检查、根/Web 构建通过。Windows 沙箱内的 pnpm 依赖链接读取导致 Vitest `EPERM` 和 lint 类型解析异常，沙箱外使用已安装的 Node 24 工具完成上述质量门；未修改依赖或放宽 lint 规则。

本轮增量限于测试夹具、验收断言和文档，生产熔断策略、事件契约及持久化 Schema 未修改。使用 `ScriptedModel` 和模拟快照，不消耗模型额度，不访问真实 LangSmith/Prometheus/ELK 或目标业务系统。复现入口仍为 `pnpm e2e:circuit`，详见[本地验收指南](./guides/agent-web-local.md)；未 commit/push。

## 2026-10-09：来源重试/熔断恢复闭环与前端状态时间线

完成 Prometheus 与 ELK 只读来源的韧性事件贯通：保留默认 3 次逻辑操作失败后打开熔断、冷却 30 秒、半开只放行一个探测的行为；重试、打开、探测等待和恢复状态通过结构化 V2 事件及脱敏 Public SSE 投影送达前端，半开内部状态仅留在审计流。修复抖动退避产生小数毫秒、被 V2 整数 Schema 拒绝并使工具执行结果失败的问题，重试延迟现在向上取整，不会早于 Retry-After 下限。

模拟器新增仅限 loopback 管理面的来源故障注入，可确定性验证“物理查询失败 → 逻辑操作重试 → 熔断阻止查询 → 冷却后单探测恢复 → 证据重新可采集”；故障注入不是 Agent Tool。前端将最近 12 个韧性状态作为有界时间线展示，避免恢复事件覆盖此前的重试和熔断状态。`logs.capture` 改为流式结果以承载来源韧性事件，调用方和测试同步 drain AsyncGenerator。

验证：ESLint、根 TypeScript typecheck/build、Web typecheck/Vite production build 通过；本轮定向测试 8 个文件、64 项通过；完整 Vitest 串行回归 158 个文件通过、3 个 opt-in 文件跳过，1333 项通过、7 项跳过；Agent Web Playwright E2E 5/5 通过，覆盖重试、熔断、探测等待及恢复的可见时间线。没有调用真实模型、LangSmith 或生产 Prometheus/ELK；浏览器验收使用本地确定性 fixture，不代表真实数据源验收。未 commit/push；保留了本轮开始前工作区已有改动。

### 确定性熔断浏览器端到端验收（2026-10-10）

新增隔离的 `pnpm e2e:circuit` 命令及专用 Playwright fixture，串接真实 Agent Web Runtime、Metrics Lab/MCP、熔断器、V2 SSE、前端 Run/证据视图；模型使用 `ScriptedModel`，来源使用确定性模拟快照，SQLite 使用临时目录，测试控制面仅监听 loopback。浏览器验收 1/1 通过：注入 9 次物理来源失败并确认 6 次重试事件、熔断打开；熔断期间及冷却还剩 1 毫秒时的新 Run 均观察到 `CIRCUIT_OPEN`，来源查询数仍为 0；推进最后 1 毫秒后 UI 才显示“恢复探测待触发”，后续单次查询成功，UI 恢复，子 Run 与父 Run 均关联同一证据引用，原始数据标记不出现在公开证据或页面中。测试控制面拒绝未注入故障前的时钟推进，并在 teardown 时独立关闭 Runtime/Metrics Lab。

最终 `corepack pnpm@10 run e2e:circuit` 完整命令通过：根构建、Web 构建及浏览器 E2E 均成功；测试进程的 `node` 解析到 Node 24。Corepack/pnpm 启动器本身仍打印系统 Node 20 的 engine warning，因此 Windows 执行时必须确保 Node 24 在 PATH 前部，否则会因 better-sqlite3 ABI 不匹配而无法启动 Runtime。没有调用真实模型、LangSmith、Docker、Prometheus 服务或 `group-buy-market`。本验收证明模拟数据下的软件与 UI 集成路径，不代表生产数据源验收，也未覆盖多个并发请求竞争半开探测；后者仍由独立熔断器测试负责。未 commit/push。

## 2026-10-08：真实烟测跨层契约修复离线收口

完成已批准的真实烟测跨层修复：指标摘要中的有效 Unix 秒被确定性投影为公开 metric evidence `timeRange`（不改 SQLite Schema、不猜测旧记录）；Logs 在同一 capture evidence ID 上完成成功 search/read-slice 后可进入 report token cap，证据充分性仍由 Collector/硬门禁决定；Trace verifier 按实际 child-owned Source lifecycle 校验父/子 Run、toolCallId 和来源类型，并核验失败模型尝试的已知 usage/finishReason，缺失用量继续标 unavailable。

修复了独立复审发现的 LangSmith `/info` 隐私/准入问题：HTTP 200 响应在 SDK 接触前必须通过严格 UTF-8 JSON 对象解析及 SDK 消费字段白名单；malformed/错误类型响应转为固定终止错误，不触发 SDK fallback 重试，不把响应片段写入 warning、诊断或报告。回归断言覆盖 200 非法 JSON/错误字段类型：只请求一次、无上传/查询、canary 不进入日志或结果。Task 3/4 的独立只读复审结论为无阻塞问题。

新增真实 runtime → SQLite → public projection → acceptance → fake LangSmith 的离线联合契约测试；覆盖正确/错误窗口、证据归属、子 Run 截断失败、父子事件身份、远端 span 缺失和 usage 不匹配。最终质量门：全仓 lint、typecheck、build 和 Web typecheck/build 均通过；Vitest 在 2 个 worker 下 156 个文件通过、3 个 opt-in 文件跳过，1,286 项通过、7 项跳过。两项先前并发负载超时单独复跑通过，低并发全量复跑中未重现。

本次由 bundled pnpm shim 启动时尝试从 registry 安装/解析包管理器并遇到网络/EPERM，因此等价调用仓库已安装的 Node 24 ESLint、TypeScript、Vitest 和 Vite 二进制完成质量门；Web typecheck/build 均通过。没有调用真实 LangSmith、真实模型或生产 Prometheus/Elasticsearch，也未做人工报告复核；故历史远端 multipart HTTP 422 仍需真实 Trace probe 独立验证，不能据离线结果宣称已修复。无 commit/push。

## 2026-10-08：真实烟测修复的第二轮补强

针对先前真实运行返回的 LangSmith multipart HTTP 422，进一步加固受审计后的 multipart wire 编码：JSON part 以独立 `Content-Length` 头声明 UTF-8 字节长度，`Content-Type` 为 `application/json`，且不带 `filename`。离线 fake 服务逐段校验实际 wire body；真实远端是否接受仍未确认。固定同一模拟快照的来源时间窗贯穿父提示、Metrics、Logs 与 capture；报告阶段 token cap 只由有匹配 evidence ID 的成功结果触发。验收报告升级为 schema v2，增加父子 Run/截断结果门禁及源码/构建输入 SHA-256 指纹；旧 v1 可读，复核时新门禁标为 `not_run`。

本轮聚焦回归 289 项通过；全量测试 1153 项通过、7 项真实数据源 opt-in 测试跳过；lint、类型检查、构建以及 Web 类型检查/构建均通过。没有调用真实模型、LangSmith 或生产数据源，因此不能宣称既有远端 422 已通过真实端到端复验。详情见[2026-10-07 烟测修复验证记录](./verification/2026-10-07-real-model-smoke-repair.md)中的 2026-10-08 补强轮记录。

## 最新增量：真实模型烟测失败诊断、上传审计与输出预算修复

2026-10-07：按批准方案完成模型截断 usage/finishReason 保留、父子失败安全报告、LangSmith JSON/multipart/gzip 审计及响应正文超时治理；烟测接入查询 512、报告/汇总 1024 的阶段限额和父子/重试共享 5120 输出预留，仍保持 10 次 HTTP 上限。缺失可信 usage 不退还预留，截断工具 JSON 不执行、不重试/fallback；父 Run 完成也不会掩盖子 Run 的失败原因。公共 V2 失败事件只增加可选字段，旧事件/报告兼容，不改变 Harness/HITL/Checkpoint、生产工具 Schema 或证据仅摘要/引用的页面约定。

本轮 ESLint、类型检查、构建和 114 项聚焦回归已通过；最终全量测试为 150 个文件、1144 项通过，3 个真实后端 opt-in 文件的 7 项按设计跳过。命令、回归证据及边界见[本轮修复验证](./verification/2026-10-07-real-model-smoke-repair.md)。当前执行进程未继承模型/LangSmith 凭据，没有发起真实模型或 LangSmith 远端请求，未消耗模型余额；真实烟测、人工复核及生产目标数据验收仍待独立执行。已有未提交改动保留，本轮未自动提交/push。

## 最新增量：本机真实后端验收与审查缺口收口

2026-10-05：完成本轮实现审查和验收修复。Run/Evidence keyset 分页在 SQLite 与内存实现中统一使用 UTF-8/BINARY 顺序并严格校验游标；公共消息分页按实际 `{ message, version, truncated }` 包络及目标 `runId` 校验；Evidence 列表/详情和分页包络按 `PublicEvidenceView` 白名单校验，metric/log 摘要分别使用来源专属 Schema，未知字段（包括嵌套 `content`、`samples`）均 fail-closed。Evidence 列表项与本地接受快照、详情响应与列表项/本地快照均做完整字段结构化比较，保证 `state`、时间窗、哈希和计数等完整性元数据一致；尚未实现的 trace/change 摘要形状拒绝通过。SSE 中所有事件 payload 均执行对应严格 Schema 校验。LangSmith 远端 Run payload、公共事件/消息边界统一检查敏感值、字段名、凭据、私有路径、内部地址和 `file://` URI；`run_type` 必须是明确字符串类型，符合边界规则的 Unicode session name 可被接受。Durable Harness 结果切换保留共享 Tool/网络尝试预算账本，避免并行子执行中的消耗被旧快照回滚。

最终质量门在与正式工作树逐文件一致的隔离快照中通过：`pnpm lint`、`pnpm typecheck`、`pnpm test`（145 个测试文件通过、3 个 opt-in 文件跳过；942 项通过、7 项跳过）、`pnpm build`、`pnpm web:typecheck`、`pnpm web:build`。默认浏览器 E2E 为 4/4 通过。独立本机后端验收：真实 Prometheus 抓取 → MCP HTTP → Metrics Subagent 为 1/1 通过，并对三个场景分别断言失败率及正常/异常/样本不足结论；本机 Elasticsearch + Prometheus 测试栈上的 Logs Web Playwright 验收为 3/3 通过，覆盖有界取证、重连/重启不重放、日志源离线时保留 Metrics 降级结果以及取消/Checkpoint。最终全量测试计数见[本轮验收记录](./verification/2026-10-05-local-acceptance-closeout.md)。

上述后端使用本机模拟/验收数据，不是 `D:\xfg\group-buy-market` 业务数据或生产 ELK/Prometheus。Evidence 页面继续只展示摘要和引用，不开放原始数据正文。由于模型和 LangSmith 凭据当前未配置，本轮没有发起付费模型请求或 LangSmith 远端查询；托管 CI 和生产数据接入也未验收。因此这次闭环证明的是本机测试后端及端到端软件链路，不代表真实生产数据或在线模型质量验收。可复现范围见[本轮验收记录](./verification/2026-10-05-local-acceptance-closeout.md)。

## 最新增量：Task 7 本地验收 CLI 与人工复核入口

2026-10-05：新增 opt-in `acceptance:real-model` 命令。必须显式设置 `AGENTOPS_REAL_MODEL_SMOKE=1`；未授权时在加载运行器前返回固定 `PRECHECK_SMOKE_NOT_ENABLED`，并声明模型请求数为 0、未创建父 Run。命令只从本地服务端环境读取凭证，使用有界模型预算和本地模拟 Logs Lab，安全报告只保留确定性检查、预算/usage、LangSmith 状态与关联 ID。

新增 `acceptance:review` 本地命令，校验 v1 报告后调用 `applyManualReview`，只记录人工决定和 unsupported-claim 数，白名单重建输出到同目录新文件；不会覆盖原报告、保存消息正文或访问网络。审批无法越过失败检查或 LangSmith `failed/unavailable`。`test-results/` 已被忽略，不会把测试产物或凭证提交进仓库。

新增 [真实模型与 LangSmith 联合验收指南](./guides/real-model-langsmith-acceptance.md)，说明 Node/pnpm 基线、后端准备、隐藏输入凭证、独立 secret、绝对测试目录、单次预算、复核流程和结果边界。此增量没有运行真实模型、真实 Elasticsearch/Prometheus 后端或真实 LangSmith 查询，因此不代表任何在线闭环通过。

本轮复验：Node 24 下 `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm web:typecheck`、`pnpm web:build` 均通过；默认 `pnpm test` 在 Node 20 下为 145 个文件、901 项通过，3 个真实后端 opt-in 文件的 7 项按设计跳过。默认浏览器 E2E 在 Node 20 下 4/4 通过。Node 24 的本地 E2E/SQLite 测试被当前 `better-sqlite3` 原生模块 ABI 阻断：依赖按 Node ABI 115 编译，而 Node 24 要求 ABI 137；尝试在原 worktree 重建时 Windows 返回文件占用/`EPERM`，因此没有覆盖或强制结束占用进程。Node 24 的数据库/E2E门仍需在干净依赖目录或 CI 验证。

独立复审发现 LangSmith 的 start/completion 队列原为分开计数，可能使全局 pending 超出 Spec 的 256 上限；现已改为共享 admission 预算，并覆盖慢 start、挂起 completion、flush 等待和队列饱和。复审确认该问题已关闭；`metrics-web-durable` 单文件顺序复跑 3 次通过，全量套件最终复跑通过。

没有运行真实模型、真实 Elasticsearch/Prometheus 后端、LangSmith 远端查询或人工消息审核；本轮只验证了默认离线测试、CLI opt-in 防线和本地 E2E，不能描述为真实生产数据闭环或真实模型通过。真实联合验收仍需按指南显式授权并单独审核。

## 最新增量：Run / Evidence 只读查询 API 与公共消息投影

2026-10-01：按 [Run / Evidence 只读查询 API](./superpowers/specs/2026-10-01-run-evidence-read-api.md) 完成第一轮查询面。新增稳定的 `InspectionQueryService` 公开读模型、内存和 SQLite 实现，支持 Run/Evidence keyset 分页、SQLite 重启恢复、跨 Run evidence 隔离，以及 inline evidence 与已提交/partial Manifest 的统一目录。SQLite 公开查询只读取证据摘要列，不读取 `raw_json`；pending/failed/deleting Manifest 不可见。

SSE message snapshot 改为独立的 `PublicMessageProjectorV2`：删除内部 metadata、原始工具参数、ToolResult.response、artifact/image URI，并对文本、错误、诊断和动作摘要做有界脱敏。HTTP 新增 Run/Evidence 四个只读接口；无效 SSE 游标在响应头发送前返回 400，查询服务未组装时返回 503。没有新增 Event/Message 类型，也没有开放真实动作。

本轮补充查询面收口：公开最大 `limit=100` 与 Manifest 目录可组合使用；SQLite 仅检索 `SUBAGENT_STARTED` 的关联字段，不再扫描每个 Run 的前 250 条事件；默认内存查询也按页读取，不再为了一个页面加载全量 evidence；SSE durable catch-up 改为按批 yield，重连时先投递安全消息快照，再继续事件流。

本轮聚焦验证覆盖 3 个测试文件、15 项测试；`pnpm lint`、`pnpm typecheck`、`pnpm test` 和 `pnpm build` 已在本轮收尾通过。Agent Web、真实 group-buy-market Prometheus Profile、生产 ELK/Trace 和动作执行仍属于后续增量。

本页按时间倒序记录实现增量；带日期的旧条目是历史快照，不覆盖顶部最新状态。

## 最新增量：Metrics Subagent 组合与真实 Prometheus 验收边界

2026-09-30：完成 `metrics_subagent` 的父子 Harness 组合。父 Agent 只暴露 canonical
`metrics_subagent`；child Toolkit 严格只有 `metrics.settlement` 和 `source_report`。实现复用既有
`SourceSubagentRunner`、AgentHarness、统一 Tool Pipeline、Checkpoint、重试/恢复和共享预算，使用
simulation checkout Profile 对正常、失败率超阈值和低样本三个场景生成确定性报告。失败率、阈值、样本状态、窗口和 coverage 由代码校验/计算，模型摘要不能覆盖事实；来源 evidenceId 可回查，原始 Prometheus 内容不进入父 Context、Public/Audit/LangSmith 投影。

本轮还验证了合法/非法时间窗口、scope fail-closed、partial/unavailable、Abort、预算、恢复、父子
Tool 隔离和本地 OpenAI-compatible SDK/SSE 嵌套调用。Task 5 修复轮主控聚焦验证为 13 个文件、93
项测试通过，并通过 ESLint、TypeScript 类型检查和 diff 检查。

Task 6 已加入真实 Prometheus → MCP HTTP → Metrics Subagent → EvidenceStore 的 opt-in 验收测试，
默认运行保持跳过；本机 Docker daemon 不可用，因此本轮没有执行真实 Prometheus 命令，不能宣称真实
Prometheus 后端验收完成。`D:\\xfg\\group-buy-market`、线上模型质量、Run/Evidence API、前端、ELK/Trace
和真实动作仍不在本增量；没有新增 Event/Message 类型。

Task 6 收尾质量门已通过：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 和 `git diff --check`；
全量测试为 95 个文件通过、1 个真实 Prometheus 文件跳过，537 项测试通过、1 项跳过。

## 最新增量：可恢复的 logs_subagent 来源 Subagent

2026-09-15：按 [来源 Subagent 设计规格](./superpowers/specs/2026-09-14-source-subagent-design.md)
完成首个真实闭环 `logs_subagent`。主 Agent 只看到 canonical Tool；`logs.capture`、
`logs.search_evidence`、`logs.aggregate_evidence`、`logs.read_evidence_slice` 和内部
`source_report` 只在 child Toolkit 中注册。child 通过注入的 `SourceChildAgentFactory`
复用现有 AgentHarness、ToolAdmission、ToolBatchExecutor 和 ToolExecutionPipeline，不另起
第二套 ReAct 循环。

本轮新增 `source-subagent` 契约、`DefaultSourceSubagentRunner`、canonical Tool Adapter、
有界 `SourceReportCollector` 和 `createLogsSubagentTool`。输入严格限制 profile、服务、时间窗、
问题和父级 evidence hint；宿主 profile/Manifest 归属校验优先于模型字段。childRunId 由父
Run + parent ToolCall 稳定生成；父 deadline、共享 Tool/网络尝试账本、取消信号和 profile revision
沿执行/恢复路径传递。Checkpoint 恢复使用相同 childRunId 和 `resumeStream`，已提交或 partial
证据不会被无条件重采集。

重试最多三次，默认两次；已有父模型可见输出后不重试。实现了 Retry、Verify/Resume、Reduced
Scope（保留已有证据并返回 partial）和 Unavailable（无证据时返回结构化失败）四轮降级。来源状态、
coverage、调用计数和 evidence 引用由代码计算；结果、V2 `SUBAGENT_*` 生命周期、Public/Audit/
LangSmith 投影均保持有界并脱敏。LangSmith child span 优先挂到同一父 `tool.logs_subagent` span。

验收覆盖契约、输入闸门、child Harness 多轮取证、恢复、重试、父子预算和投影边界；测试使用注入式
日志页源、SQLite/local Blob 或 ScriptedModel。当前没有接入真实 Elasticsearch/ELK 地址、公司凭据、
线上模型或生产部署，因此不能宣称真实 ELK 生产验收。Metrics/Trace 的具体 Subagent Runner 仍待后续
实现；本轮只完成通用端口和 logs 首个切片。

## 最新增量：L1/L2 上下文压缩、完整性校验与重启恢复

2026-09-14：按 [Agent Runtime Governance 与上下文压缩设计](./superpowers/specs/2026-09-11-agent-runtime-governance-and-context-compression-design.md) 完成压缩治理链路。新增严格的 `StructuredHistorySummary`/`CompressionTrace`/`CompressionValidationResult` 契约、确定性 L1 结构裁剪、证据可见性与 ToolCall/ToolResult 配对校验、精确 ToolResult 修复、可选 compact model 的 L2 摘要和一次重试、L2 → 已验证 L1 降级，以及失败时保留旧 Context。

Harness 现在通过现有 Durable Transition/Outbox 依次提交并发布 `CONTEXT_COMPRESSION_STARTED`、`CONTEXT_COMPRESSED`、`CONTEXT_COMPRESSION_FAILED` 和 `CONTEXT_INTEGRITY_REPAIRED` V2 事实；只有已接受的候选才更新 Checkpoint，既有 V1 `CONTEXT_COMPRESSED` 兼容事件仍由 V2 投影产生。新增的 `ContextSummary` 字段已纳入 Durable Codec，SQLite 重启验收验证 `CompressionState`、summary version、来源消息范围和生命周期事件不会重复；Audit/LangSmith 边界测试确认不携带原始历史、ToolResult、storage key 或路径。

本轮验证：压缩契约、L1、Validator、摘要器、分层回退、Harness 生命周期、SQLite 重启和投影安全测试均通过；摘要器使用注入模型和本地协议测试，未宣称真实在线模型或生产 ELK 后端验收。默认 Runtime 在未配置 `compactModel` 时保持确定性 L1；通过 `compactModel`、`compressionValidator` 和 `compression` 选项可替换实现。完整质量门禁仍需在本轮全部变更合并后再次执行。

## 最新增量：持久化证据重启恢复验收

2026-09-14：完成 Task 10 基础验收。使用 SQLite Event/Message/Checkpoint/Manifest、注入式日志分页源和本地 gzip NDJSON BlobStore，验证指标 Run 关闭后重新打开仍可读取 Checkpoint 和原始证据；日志证据的 Manifest、Blob 分块和有界读取也可在重启后恢复，使用稳定密钥的 opaque cursor 可以继续读取下一页。公共事件流只返回投影后的安全字段，不包含原始证据标记、Blob storage key 或路径。

本轮修复了本地 BlobStore 将 `captureKey` 误当作路径段校验的问题。幂等键可以包含 `:` 等合法身份字符，但真正参与文件路径的 `manifestId` 和 `evidenceId` 仍必须经过安全路径段校验。新增 `test/durable-evidence-acceptance.test.ts`，覆盖两类证据的落盘、重启、回查和公共投影边界。当前完成的是本地/注入式持久化基础，不等同于已连接真实 ELK、生产对象存储、KMS 或部署环境。

## 最新增量：有界 ELK 分页、日志证据 Reader 与受控 Tools

2026-09-13：按 [ELK 大证据设计](./superpowers/specs/2026-09-10-elk-large-evidence-blob-storage-design.md) 完成第一版可替换日志取证边界。新增 `ElkPageClient`/`PagedEvidenceSource`，使用结构化服务与时间窗口查询，按页计算 UTF-8 大小并限制 512 KiB；支持 opaque cursor、PIT/source snapshot 透传、重复游标/快照漂移/页数上限检测。`McpElkPageClient` 只在基础设施层接触 MCP ToolResponse，`ResilientElkPageClient` 复用既有按页重试、尝试预算和 CircuitBreaker。

新增 `LocalEvidenceReader`，从已提交或 partial 的 gzip NDJSON Manifest 分块读取，使用绑定 evidenceId/manifestId 的 opaque cursor；扫描、解压和聚合均有上限，跨 Run、pending/failed 或损坏证据会拒绝。新增 `logs.capture`、`logs.search_evidence`、`logs.aggregate_evidence`、`logs.read_evidence_slice` 四个 evidence Tool：capture 通过 `StreamingEvidenceRecorder` 落盘并返回有界摘要与 `evidence_ref`，二次读取只能按当前 Run 的 evidenceId，模型边界只允许安全字段和有限样本，绝不返回 storage key、路径、DSL 或凭据。

Runtime 新增不依赖基础设施的 `toolFactories` 注入点，工厂在 L0 ports 就绪且 Toolkit 冻结前创建工具；只读 Inspection Runtime 对工厂产物执行同一 allowlist、action、Bash 和本地 call 校验。新增分页、PIT、重试熔断、Reader、工具归属和输出边界测试；Task 9 聚焦测试 17 项通过。Task 10 已补充本地 SQLite Manifest/Blob 的端到端重启验收；真实 ELK endpoint、认证配置、生产 Blob 后端和 Logs Subagent 仍待后续接入。

## 最新增量：L0 大证据边界与可替换 Runtime 组装

2026-09-13：按 [L0 大证据实施计划](./superpowers/plans/2026-09-13-l0-large-evidence.md) 完成第一版大日志/Trace 边界。新增独立的 `EvidenceBlobStore`、`EvidenceManifestStore`、`StreamingEvidenceRecorder` 和 `ToolResultCompactor` 端口；本地实现使用注入的绝对 Blob 根目录、gzip NDJSON 分块、SQLite Manifest 控制面、pending/committed/partial/failed 可见性和分块 SHA-256。单页、chunk、capture、摘要和样本均有界；达到字节/记录/时长预算时提交 partial，Abort 或存储/协议失败不返回 evidence reference。

模型视图通过可替换的 `CompactingChatModel` 和 OpenAI-compatible Formatter 双重收口：有 evidence reference 的超大 ToolResult 只保留有界摘要与引用，没有已提交证据引用则返回结构化 `BUDGET_EXCEEDED(tool_result_too_large)`。完整结果仍保留在 AgentContext，模型视图不修改持久化状态；`EVIDENCE_COLLECTED` 仅在 Manifest 可见后发布且按 evidenceId 幂等。Public SSE、Audit 和 LangSmith 投影均不携带原始 ToolResponse、storage key 或完整证据内容；LangSmith 只接收工具状态、耗时、错误码和 evidenceId。Runtime 支持注入 L0 ports，也支持 SQLite 配置显式的 `evidenceBlobRootPath`，未显式配置时不创建文件 Blob。

本轮新增 64MiB 分块捕获、partial/Abort、红线脱敏、事件发布顺序、Compactor、模型边界和 Runtime 组装测试；当前已通过相关 lint、typecheck 和聚焦测试。对象存储、删除/保留任务、L1/L2 全量压缩和生产后端验收仍不在本增量范围；ELK 本地/注入式分页与 Reader 以及本地重启验收已在后续增量实现。

## 最新增量：OpenAI-compatible 模型适配器

2026-09-10：按 [OpenAI-compatible 模型适配设计](./superpowers/specs/2026-09-06-openai-compatible-model-design.md) 完成生产边界的首版实现。适配链路为 `OpenAICompatibleChatModel -> EventedChatModel -> AgentHarness`：官方 `openai@6.49.0` 负责 HTTP/SSE framing，项目内 Formatter 负责稳定消息和工具 Schema，Assembler 负责文本、交错 tool-call、usage、finish reason 和协议完整性，原始 arguments 原样交给四道工具闸门。

本轮同时落地：Node.js 20 兼容依赖；SDK `maxRetries: 0`；绝对 Run deadline 与 `AbortSignal`；消费方提前关闭时的上游 iterator 回收；响应 content-type、`[DONE]`、字节上限和安全 URL/API Key 边界；`terminal / fallback_only / retryable / aborted` 四级错误处置；Retry-After 单次等待上限 2 秒；cached input tokens 与 finish reason 的 V2/LangSmith 投影；bootstrap 工厂和公开入口。

验证使用本地真实 HTTP/SSE 服务，覆盖中文 UTF-8 跨网络分片、多个并行 tool-call 交错分片、两轮 Harness 工具闭环、usage/cached tokens、缺失 `[DONE]`、错误 content-type、响应超限、取消、错误分类和 SDK 零重试。未使用真实 DeepSeek 凭据或在线 API，因此只能表述为“OpenAI-compatible 本地协议已验证”，不能表述为“DeepSeek 在线验收完成”。图像、reasoning content、model discovery、JSON response format 和供应商专属扩展仍不在本轮范围。

## 最新增量：Event / Message V2 核心验收与 AsyncGenerator 收口

2026-09-09：完成 Event/Message V2 核心验收收口。V2 MessageBlock 契约、Event PayloadMap/Schema、EventStore/MessageStore、内存与 SQLite 持久化、ReplayBuffer、MessageAssembler、EventPublisher、ProjectionRunner、Public/V1/Audit/LangSmith 投影、模型/工具/HITL/Subagent 运行时事件和 Node HTTP/SSE 入口均已落地。

本轮补充 V1 fixture、V2→V1 单向投影、并行工具 ToolCall/ToolResult 配对、公共事件/消息快照脱敏、模型身份链路、SQLite 重启和 transient 序列空洞恢复验收，并修复模型层提前发布 `TOOL_CALL_CREATED` 导致的重复事件。`replyStream()` 现在直接 yield V1 事件；`ToolRunner`、`ToolExecutionPipeline` 和 `ToolBatchExecutor` 形成流式工具链，安全 payload 与 V2→V1 投影共用映射。消费者调用 `return()`/`throw()` 时会清理子生成器、标记取消、保存 Checkpoint 并 flush observability。`RetryingChatModel` 保持 AsyncGenerator 语义：首个流事件前才重试，部分输出后不重放，支持 Abort、fallback 和模型尝试事件。消息 assembly 中间状态可恢复；V2 runtime 暴露 `ready` 执行本地投影启动回放，LangSmith 历史补报保持显式选择。

最终验证记录：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部通过；全量测试为 44 个测试文件通过、1 个真实 Prometheus 测试文件按默认配置跳过，222 项测试通过、1 项跳过。核心协议已验收，但完整生产一期仍保留若干明确缺口，详见 [Event / Message V2 一期验收状态](./event-message-v2-acceptance-status.md)。

## 设计决策：Event / Message V2 作为一期协议地基

2026-09-07：确认一期完整实现 Event/Message V2，而非只补少量事件名。范围包括强类型 PayloadMap、完整 MessageBlock、ID 与暂停恢复语义、模型/工具/四闸门/HITL/Subagent/MCP/熔断/压缩/记忆事件、EventStore 与重放、Public SSE/Audit/LangSmith 三类投影及 V1 兼容投影。完整设计见 [Event 与 Message V2 协议](./architecture/15-event-message-v2.md)。

本条为 2026-09-07 的目标确认记录。当前源码已经有 V2 契约、基础存储、发布与回放实现，但运行时生产点和三类投影尚未全部完成，仍以最新增量和验收状态文档为准。

## 最新增量：可运行 Metrics Lab 组装

2026-09-06：新增独立模拟器管理 API 和统一 Metrics Lab 生命周期。管理端仅监听 127.0.0.1，严格允许 GET /scenarios 与 PUT /scenario；抓取端仍不包含场景控制，Agent MCP 也无法访问管理能力。startMetricsLab 同时组装模拟器指标端、管理端、Prometheus 查询源和只读 MCP 服务，并在启动失败或关闭时回收已启动资源。提供 lab:backend:up、lab:backend:stop、lab:start 命令。

真实后端验收扩展后为 16 个文件、87 项测试通过，覆盖真实 Prometheus → MCP HTTP → Harness → EvidenceStore 三场景链路。Simulator Web 和 Agent Web 页面仍未实现；当前交付的是其服务端运行入口和管理 API，不应称为前端已完成。

## 上一增量：MCP → Harness → EvidenceStore

2026-09-06：新增本机只读 MCP 服务、严格结算查询协议和本地证据 Tool 组装。通过已有统一执行管线完成指标取证、确定性摘要计算、原文保存和引用回查；无数据不虚构证据，保存失败显式失败，来源重试只由已有执行器控制。修复 Error 自定义错误码在 Checkpoint 克隆中丢失的问题，公共字段不变。

四项质量检查通过：lint、typecheck、test、build。启用真实 Prometheus 时 14 个文件共 84 项测试通过，包含三个场景经真实 MCP HTTP、Harness 与证据回查的验收。模型仍是 ScriptedModel，存储仍在内存中；不能宣称已完成真实模型诊断或磁盘恢复。详见 [MCP 与证据闭环](./architecture/14-settlement-mcp-evidence.md)。

## 上一增量：真实 Prometheus 抓取与查询

2026-09-06：新增只读模拟器 HTTP 服务、Prometheus Compose 配置、固定实验 Profile 查询适配器及数据有效性校验。真实 Prometheus 已验证 100/15 异常、100/0 正常和 10/8 低样本三个场景。完整 Agent/MCP/EvidenceStore 链路仍未串接。

四项检查通过：lint、typecheck、test、build；启用真实后端验收时 12 个文件、76 项测试全部通过。新增 21 项测试，其中一项为显式启用的真实 Prometheus 验收；默认测试跳过该项。复验命令、安全边界与当前缺项见 [指标实验说明](./architecture/13-metrics-lab-implementation.md)。

## 上一增量：指标模拟快照与确定性判定

2026-09-06 中断重试后，补齐 SettlementSimulator 和独立 settlement Profile 计算。支持正常（100/0）、失败率升高（100/15）、低样本（10/8）三个固定窗口快照，输出 Prometheus 文本格式的 gauge；不使用 increase 推算固定样本数。重复抓取不刷新窗口时间，重新选择场景才创建新窗口。

失败率、阈值与最小样本判定由代码执行。零样本返回 null 失败率和 insufficient_data，低样本不判健康，非法计数和 Profile 参数显式拒绝。阈值采用严格大于语义。仅提供指标异常判定，不推断 MySQL 根因。

验证：pnpm lint、pnpm typecheck、pnpm test、pnpm build 均通过，9 个文件共 55 项测试（本增量新增 15 项）。Docker 后端已确认可用（29.1.2），但尚未启动 Prometheus 实验服务，不能把此结果视为真实后端联调通过。

本增量只交付快照生成及数值判定基础模块；HTTP 暴露/管理端隔离、Prometheus 查询校验、实验 MCP 服务、EvidenceStore 串接与完整链路验收仍按 metrics-lab 计划待实现。未改动公共契约、Harness 和 group-buy-market。

## 上一批次：MCP 只读接入与可靠性

2026-09-06 继续实施后，新增专用 createInspectionRuntime、官方 SDK HTTP 连接、本地 Manifest/Schema 对照注册、来源熔断器及有界执行器。支持网络超时、最多两次追加重试、jitter、Retry-After、取消、父 Run 截止和共享网络尝试账本；重试以 Tool 流式事件返回。详见 [MCP 实现说明](./architecture/12-mcp-implementation.md)。

最新验证：pnpm lint、pnpm typecheck、pnpm test、pnpm build 均通过，8 个文件共 40 个测试。相较上一批新增 17 个测试，包含 4 个官方 MCP 服务端真实 HTTP 集成测试。没有连接真实遥测后端或实际 LLM，完整 V1 尚未验证。

项目此时已存在 Git（读取到既有提交 745ce46），保留原有未提交改动；本轮未创建提交。下文“无 Git”的说明是上一批次的历史记录。

下一步：接入真实遥测实验环境与来源工具，再完成来源 Subagent、持久化和交互界面。自动重连/健康面板、完整 LangSmith 嵌套链路和真实业务验收仍需实施。

## 2026-09-06：工具准入与纠错基础链路

本轮实施 [工具准入计划](./superpowers/plans/2026-09-06-tool-admission.md)，在现有框架中落地以下能力：

- RawToolCall 与 ModelResponse.rawToolCalls：保留未解析参数，不把失败转换为空对象。
- ToolAdmission：工具存在性、JSON 解析/一次安全修复、严格 Zod Schema、注入式语义校验。
- JSON 限制：64 KiB、32 层，拒绝重复键（含 Unicode 转义同名键）、危险键、非对象和溢出数值；围栏/BOM/尾逗号修复不改字符串内容。
- Harness 回填 raw_tool_call 和配对失败结果；下一次模型推理获得结构化错误、目标 Schema 和剩余纠错额度。
- 每 Run 按工具保守限制一次纠错机会；累计两次参数失败后阻止该工具的新调用，状态随 Checkpoint 保存。该策略比未来按调查任务划分纠错链更严格，不能宣称已经实现完整语义级纠错链识别。
- 所有模型提出的调用计入总预算；拒绝也消耗额度。恢复已准入调用不重复扣费。
- 重复或缺失调用 ID 在整批执行前拒绝，单批最多 32 个候选。
- BatchExecutor 对只读安全调用采用 allSettled，保持结果顺序，隔离单工具/Guard 异常；动作强制进入串行桶。
- Pipeline 对成功、失败、中断和取消统一发布 TOOL_RESULT；Guard 和 Hook 使用规范化参数。成功 JSON 修复通过 TOOL_PROGRESS 记录规则。

## 兼容性

ToolCall.input、ToolResponse 外壳未替换。新增 RawToolCall、raw_tool_call 消息块、可选 rawToolCalls、可选 Tool.validateSemantics、新错误码及可选 Checkpoint 账本字段。

直接构造 AgentHarness 的宿主需要注入 ToolAdmission；createAgentRuntime 已完成组装。未来真实模型 Formatter 必须支持 raw_tool_call 的协议编码，不能把非法参数编码成正常空对象。

## 验证

Node v20.20.0，pnpm 11.19.0。执行结果：pnpm lint、pnpm typecheck、pnpm test、pnpm build 均通过。5 个测试文件，23 个测试通过，其中新增 19 个测试。测试使用 ScriptedModel 与实际 Harness/Pipeline；没有调用实际 LLM 或外部遥测服务。

本轮包括测试先失败再实现的验证过程：原始参数被忽略、纠错缺失、重复 ID、并行异常丢失结果、失败审计缺失以及 Infinity 输入问题均得到回归覆盖。

## 尚未交付

完整 V1 仍在实现中。真实模型/Formatter、Registry Manifest/快照、MCP 网络客户端、来源 Subagent 自治组装、网络重试与熔断、父子共享预算、SQLite、L0/L1/L2 完整性改造、记忆检索、LangSmith 完整追踪、模拟器和双 Web 均需继续实施。

当前存储仍为内存实现；恢复测试验证序列化状态经过新 Harness 后仍生效，不代表已经支持真实进程重启后的磁盘恢复。语义校验提供接口和拒绝能力，具体 Profile 规则及可审计安全收缩尚未接入。修复审计当前记录规则，原始/结果哈希和持久化事件后端需在审计里程碑补齐。

当前通用 createAgentRuntime 仍保留早期外部 Bash 选项和默认行为。最新批次已新增专用 createInspectionRuntime 排除 Bash、动作和外部执行；实际巡检宿主应使用该只读入口。

项目无 Git 元数据，未创建 commit。没有修改 group-buy-market。

## 2026-10-11：受控诊断记忆阶段 A 离线联合验收

Stage A 的 Episodic 保存/去重、审核/撤销、同 scope 有界召回、暂停恢复时对冻结选择重新验证、前端操作、关闭基线、事务回滚和 stale Worker fencing 已完成离线联合验收；新增 `pnpm acceptance:memory` 入口及安全固定错误码。Node 24.19.0 环境下 13/13 acceptance checks 通过，模型/外部请求计数均为 0。全仓 Vitest 179 文件通过、3 个 opt-in 文件跳过；1,613 项通过、7 项跳过。根 typecheck/build、Web typecheck/build、memory E2E（10/10 运行项通过，另 1 个关闭基线单测独立 1/1 通过）及确定性 circuit E2E 1/1 通过。

全仓 ESLint 仍有 51 条测试/fixture 诊断（主要 `require-await` 与 `unbound-method`，另有两个 Playwright 文件未纳入 ESLint project）；Task 9 相关文件 scoped lint 通过。验收记录与 Node ABI 错误定位见[阶段 A 验收记录](./verification/2026-10-10-diagnostic-memory-plan-review.md)。该阶段使用 ScriptedModel、临时 SQLite 与模拟数据，没有请求在线模型、LangSmith、Prometheus/ELK 或目标业务系统；不能据此宣称完整记忆系统或生产巡检已完成。Semantic/Procedural 完整知识库、向量实验及真实数据源效果仍未实现/验收。

## 2026-10-11：记忆向量 V3 影子检索与离线对照

按 [向量记忆可用性实验 Spec](./superpowers/specs/2026-10-10-memory-vector-feasibility-design.md) 完成 V3 机制：独立临时 SQLite 索引、16 条上限的嵌入与 upsert 分批、BM25/向量/混合影子检索、RRF、每次召回前重新校验 scope/状态/证据、向量故障时有界 BM25 降级，以及固定 holdout 的离线对照 CLI。验收报告包含安全投影后的向量包身份、外部请求计数和 DB/WAL/SHM 总容量；临时资源清理失败或任何 fetch 出站尝试都会使验收失败。

Node 24.19.0 验证：全仓 Vitest 181 个文件通过、3 个 opt-in 文件跳过，1,636 项通过、7 项跳过；`tsc --noEmit`、生产 build、V3 文件定向 ESLint 均通过。全仓 ESLint 仍有 51 条 V3 范围外既有测试/Playwright fixture 诊断。所有测试与检查均为本地离线执行，没有加载真实 Embedding 包，也没有发出模型、LangSmith 或数据源请求。

本增量仍不改变默认 BM25/Harness 路径。真实语义质量需要后续审查真实 Embedding 生成器及本地向量包后再验收；Semantic/Procedural 完整知识库、向量接入生产召回和真实业务效果仍未完成。

## 2026-10-13：完整治理记忆系统 T5–T7 收口

Semantic 与 Procedural 记忆已按批准、独立发布、Target/Profile 精确作用域、资格校验、审计和只读 UI 闭环；Agent 可在受限上下文中检索获批知识，Episodic 原有路径保持兼容。T6 Target-scoped API/UI 与 T7 四类记忆/迁移/重启/HITL/隐私/降级回归通过。新增 Target identity-registry version fence，阻止旧解析快照创建新 root Run；失效知识不会因恢复或旧收据重新获得资格。向量检索仍只是 Episodic shadow experiment，不是 Semantic/Procedural 主召回后端。

Node 24.19.0 / Vitest 3.2.7 最终验证：全仓 ESLint、typecheck、build 通过；Vitest 209 个文件通过、3 个 opt-in 文件跳过，2,102 项通过、7 项跳过；离线 `acceptance:memory` 13/13 通过，模型/外部请求均为 0；知识治理 UI E2E 1/1 通过。独立终审在约定的 Procedural 词法边界内未发现 blocker/P3。该规则不是完整 SQL parser；当前验收也不代表真实生产数据源或生产授权体系已接入。未调用付费模型、Embedding、LangSmith 或生产系统；本轮未提交或推送。详细记录见[治理记忆系统计划](./superpowers/plans/2026-10-11-complete-governed-memory-system.md)及工作树 SDD 报告。
