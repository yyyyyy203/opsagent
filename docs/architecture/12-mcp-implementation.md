# MCP 只读接入：当前实现

本页描述 2026-09-06 已完成的 MCP 基础接入代码，与目标架构的区别以末尾边界说明为准。

## 公开入口

| API | 实现位置 | 职责 |
|---|---|---|
| HttpMcpConnection | src/infrastructure/mcp/http-connection.ts | 官方 SDK 的 HTTP 初始化、工具分页发现、工具调用和连接关闭 |
| McpConnection | src/mcp/types.ts | 与 SDK 无关的连接接口 |
| SourceCircuitBreaker | src/mcp/resilience.ts | 来源级 closed/open/half_open 状态及单探测并发 |
| ResilientExecutor | src/mcp/resilience.ts | 有界尝试、退避、截止、取消、共享请求次数账本 |
| bindReadonlyMcpTools | src/mcp/readonly-tools.ts | 本地 Manifest 对照远程 Schema，将只读工具适配为 Tool |
| createInspectionRuntime | src/bootstrap/inspection-runtime.ts | 本地允许清单、排除动作/Bash/外部执行、冻结 Registry |

这些接口通过 src/index.ts 公开。MCP SDK 只被基础设施实现依赖，Harness 不导入 SDK。

## 接入流程

1. 运维配置提供固定 MCP URL、请求头和资源上限，模型不能指定这些连接配置。
2. HttpMcpConnection.connect 完成初始化；未声明 sampling、elicitation 或其他用户交互能力。
3. bindReadonlyMcpTools 从服务器读取工具清单，检查本地 Manifest 中的 remoteName、expectedRemoteSchema、readOnly、idempotent 和唯一 localName。
4. Schema 比较忽略对象键顺序，其余内容精确一致；未列出的远程工具不会注册。本地 inputSchema 执行实际参数验证。
5. 将返回工具和 allowedToolNames 传入 createInspectionRuntime。Registry 冻结后不能追加工具。
6. 执行仍经过 Harness 闸门与 Tool Pipeline；MCP 工具内部使用 ResilientExecutor 调用连接，来源重试/熔断状态先作为内部流式 Tool chunk 发出，再由 Tool Pipeline 转成带 run/step/tool-call 关联的 V2 事件。原始内部 chunk 不进入模型消息或 Public SSE。
7. 宿主结束时调用 connection.close 释放本地连接。当前不主动发送 DELETE 终止远程会话，远程会话清理由服务端策略管理。

本地 Manifest 是人工审核的权限声明。远程 readOnlyHint 不能授予权限；同样，框架无法证明一段被操作者误标为只读的任意本地函数确实没有副作用。

## 可靠性默认值

每个来源复用同一个熔断器实例，累计 3 次失败的逻辑操作后打开 30 秒。内部网络重试不各算一个来源故障；一次逻辑操作最多追加两次尝试。半开只允许一个探测，探测不追加重试。旧并发请求的成功不能关闭较新故障打开的熔断器。

半开探测遇到可重试的来源故障时，也不会追加物理尝试，而是重新打开熔断器；新的完整 30 秒冷却从探测失败完成时开始计算。冷却到期仅允许下一个请求探测，不能视为来源已恢复。`test/mcp-resilience.test.ts` 覆盖失败完成时间边界，`pnpm e2e:circuit` 覆盖失败探测、再次阻止查询及最终成功恢复的浏览器链路。

单次默认超时 10 秒，指数退避基数 200 ms，带注入随机数的 jitter，上限 2 秒。Retry-After 超过本地等待上限时直接返回限流失败，不能截短后提前重试。认证错误、协议错误和 isError 工具业务结果不做网络重试。

退避等待毫秒在事件契约边界向上取整为整数，避免小数毫秒违反 V2 `delayMs` Schema；向上取整不会早于随机退避结果。`DATASOURCE_RETRY_SCHEDULED`、`DATASOURCE_CIRCUIT_OPENED` 和 `DATASOURCE_CIRCUIT_CLOSED` 投影到 Public SSE。`DATASOURCE_CIRCUIT_HALF_OPENED` 仅用于审计；前端在 `openUntil` 到期时本地展示“恢复探测待触发”，这表示允许下一次请求竞争唯一探测，不代表探测已开始。只有探测请求成功并收到 `DATASOURCE_CIRCUIT_CLOSED` 后才展示“数据源已恢复”。熔断器由 Web Runtime 组装并在该进程内跨 Run 复用，重启会重置内存熔断状态。

调用截止采用 min(父 Run 截止, 当前工具 30 秒窗口)。Pipeline 传递可选 deadline 和 networkAttemptBudget，初始网络额度为 Run 最大工具数乘以 3；重试扣除该共享对象中的剩余次数，随 Checkpoint 保存。父子 Agent 跨上下文共享此对象的组装尚未实现。

HTTP 传输不跟随重定向，响应流默认限制为 1 MiB；分页最多 20 页、最多 1000 个工具，重复游标/工具名会失败。凭证、内部 URL 和远程 HTTP 错误正文不写进 SourceFailure，错误只携带稳定代码。

取消使本地逻辑调用结束并传播 SDK 取消信号；远端是否及时停止由 MCP 服务端协作决定。底层 HTTP 另有超时上限。时钟、随机数和 sleep 可以注入；使用假时钟测试时，各组件必须使用同一时间基准。

## 协议与依赖

依赖固定为 @modelcontextprotocol/sdk 1.30.0。使用官方 SDK 提供的 Streamable HTTP 和协商机制，不另写 JSON-RPC 协议。SDK 1.x 的 Transport 可选属性类型与本项目 exactOptionalPropertyTypes 有差异，类型断言仅保留在 SDK 连接边界；工具响应继续显式 Schema.parse。

参考：[官方 TypeScript SDK v1.x](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)、[MCP Streamable HTTP 2025-11-25 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。这是已锁定 SDK 的兼容实现，不宣称实现了后续所有协议版本。

## 已验证与未实现

本地官方 SDK 服务端经真实 TCP/HTTP 验证 initialize、notifications/initialized、tools/list、tools/call、503 重试、鉴权不重试、业务错误不重试以及 Schema 漂移阻断。模型仍使用 ScriptedModel；服务返回的是 fixture 数据。

当前仅接收文本和 structuredContent；多媒体、远程资源引用、stdio、OAuth 授权交互、会话恢复和自动后台重连尚未实现。Event/Message V2 已在运行时提供内存/SQLite 事件消息存储与投影回放；结算指标证据可由 SQLite EvidenceStore 持久化，日志/Trace 大证据可通过 SQLite Manifest + 注入式本地 BlobStore 持久化，并由 `logs.search_evidence`、`logs.aggregate_evidence`、`logs.read_evidence_slice` 有界读取。Agent Web 已有按当前 Run 展示重试、熔断、冷却等待和恢复事件的状态区；模拟来源故障入口仍是独立 loopback 管理 API，不注册为 Agent Tool。连接初始化由宿主显式调用；不可将该接入模块误认为已经具备完整的降级启动/重连管理器。

当前已接通的业务实验链路为本地模拟器 → 可选真实 Prometheus → 结算 MCP → Evidence Tool → Harness；日志侧已接通注入式分页源 → 有界 `logs.capture` → 本地 Blob/Manifest → 二次读取 Tools，并已完成本地 runtime 重启验收。真实 Elastic/Tempo 后端、认证配置、三类来源 Subagent、生产 Registry、生产对象存储/KMS、Web 前端和自动健康控制仍在后续里程碑。此页不是完整 V1 验收。
