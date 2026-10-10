# 受控诊断记忆阶段 A 验收记录

> 计划文件名日期为 2026-10-10；本次实际验收日期为 2026-10-11（Asia/Shanghai）。

## 范围

验证受控诊断记忆阶段 A 的离线闭环：Episodic 案例保存、幂等、人工审核/撤销、同 scope 有界召回、冻结选择的暂停恢复复核、部署关闭基线、SQLite 事务和 Worker fencing，以及前端操作。该验收不覆盖完整 Semantic/Procedural 知识库、向量可用性、生产数据效果、远程多租户权限或真实动作。

环境：Node.js `v24.19.0`；项目当前声明 `pnpm@11.19.0`，本机执行入口解析到 `pnpm 11.25.0`。验证期间明确把 Node 24 放在 `PATH` 前部，确保 pnpm 启动的子进程也使用 Node 24。

## 结果

| 验证 | 结果 |
|---|---|
| `pnpm acceptance:memory`（Node 24 在 PATH 前部） | 通过，13/13 checks 全 true；`modelRequestsSent=0`、`externalRequestsSent=0` |
| Memory acceptance failure-code 回归 | 2/2 通过；合法固定码保留，异常正文/非法 code 不进入输出 |
| 全仓 Vitest，2 workers | 179 个文件通过、3 个 opt-in 文件跳过；1,613 项通过、7 项跳过；exit 0 |
| 根 `typecheck` | exit 0 |
| 根 `build` | exit 0 |
| Web `typecheck` | exit 0 |
| Web 生产 build | exit 0 |
| Memory 浏览器 E2E | 10 通过、1 个按测试设计跳过；禁用记忆基线单独运行 1/1 通过 |
| 确定性 circuit 浏览器 E2E | 1/1 通过 |
| Task 9 记忆 acceptance JS/类型声明/集成测试和 memory-web-view 测试的 scoped ESLint | exit 0 |
| `git diff --check` | exit 0 |
| 全仓 ESLint | exit 1：51 条已有测试/fixture lint 诊断，集中于 `playwright.memory.config.ts`、`test/e2e/memory-fixture-server.mjs` 和既有 `test/memory-*.test.ts`；主要规则为 `require-await`、`unbound-method`。另有两个 Playwright 文件未纳入 ESLint project。Task 9 记忆 acceptance 与 memory-web-view 涉及文件 scoped lint 通过。未为通过 lint 放宽规则，也未批量改写既有测试。 |

离线验收主要输出：

```json
{"status":"passed","checks":{"captureOnce":true,"manualCaptureWithoutRecall":true,"captureRecallMatrix":true,"sourceRunUnchanged":true,"failedArchiveNeverRecalled":true,"approvedOnly":true,"scopeIsolation":true,"resumeRevalidation":true,"noRawPublicData":true,"transactionRollback":true,"staleWorkerRejected":true,"noOracleLeak":true,"disabledBaseline":true},"modelRequestsSent":0,"externalRequestsSent":0,"externalRequestsBlocked":0}
```

## 定位到的运行环境问题

第一次通过 PATH 中的 Node 20.20.0 执行 acceptance CLI 时，`pnpm build` 能成功，但运行期打开 `better-sqlite3` 抛出 `ERR_DLOPEN_FAILED`：扩展按 Node ABI 137 编译，Node 20 要 ABI 115。原 CLI 将此异常压成全 false，无法定位。增加脱敏固定 `code` 后，错误路径只输出 `ERR_DLOPEN_FAILED`，不输出异常正文、路径或堆栈；把 Node 24.19.0 放到 PATH 前后，同一 `pnpm acceptance:memory` 通过。该错误属于 Node 运行时与原生依赖 ABI 不匹配，不是记忆逻辑验收失败。

本地 PowerShell 可以先确认：

```powershell
Get-Command node
node --version # 应为 v24.x
pnpm acceptance:memory
```

## 数据边界与限制

- 使用 `ScriptedModel`、临时 SQLite 和本地 loopback Runtime；浏览器 fixture 使用模拟数据。
- 没有调用 DeepSeek、LangSmith、Prometheus、ELK 或 `group-buy-market`；没有发起付费请求。
- 通过验收仅说明本地阶段 A 控制流与数据边界满足这些固定测试，不表示真实业务诊断准确率或生产可用性。
- 全仓 lint 遗留 51 条测试/fixture 诊断；Task 9 相关文件 scoped lint 通过。定向门禁本轮再次确认 `pnpm typecheck`、Task 9/runtime 测试文件 scoped ESLint、3 个聚焦测试文件 16/16 与 `pnpm acceptance:memory` 13/13 均通过。
- Semantic/Procedural 知识库、向量实验、生产备份恢复演练、保留清理运维、真实数据源效果、多租户远程权限仍未闭环。

## 独立复审后的验收补强

Task 9 首次独立复审发现验收器存在“配置被检查但真实行为未覆盖”的风险。本轮已增加以下防回归：

- 异常码改为有限安全 allowlist；任意形似标识符的值（包括 `AUTH_TOKEN_SECRET`）统一映射通用错误码。
- 离线 fetch 边界现在覆盖验收函数与 Runtime 全局 `fetch`，仅转发 loopback HTTP、强制 `redirect: 'error'`，并报告实际外发和被阻断计数。
- 原始证据 marker 被断言不进入模型输入；跨 scope Oracle marker 预置于另一 scope 的可召回案例，先证明它在异 scope 可检索，再断言目标 scope 与模型输入均不可见。
- 用只出现在被保存案例中的唯一 marker 验证 recall 开启时确实进入后续模型请求，关闭时不进入；撤销后暂停 Run 恢复也不得重新注入。
- 六种 capture × recall 组合各自执行实际模拟 Run，并检查手动/自动/跳过沉淀结果与模型召回结果，不再只验证策略解析。
- 事务回滚负例额外检查没有遗留 case、FTS 索引或 outbox 事件；scope 查询对可独立变化的每个标识字段做单字段负例。`dataClass` 与 `environment` 受合同的 discriminated union 约束，不制造非法组合。

补强后 focused `test/memory-acceptance.integration.test.ts` 为 3/3 通过，`test/memory-web-view.test.ts` 与 acceptance 集成测试合计 7/7 通过；`pnpm acceptance:memory` 为 13/13 checks 通过；六种行为输出如下：

| 保存策略 | recall=false | recall=true |
|---|---|---|
| manual | 手动保存成功 / 未召回 | 手动保存成功 / 已召回 |
| automatic | 自动保存成功 / 未召回 | 自动保存成功 / 已召回 |
| skip | 未保存 / 未召回 | 未保存 / 已召回 |

验收网络计数：`modelRequestsSent=0`、`externalRequestsSent=0`、`externalRequestsBlocked=0`。独立复审确认撤销后恢复请求不会再次注入唯一案例 marker，没有遗留 Task 9 blocker。最终全仓 Vitest 为 179 个文件通过、3 个 opt-in 文件跳过，1,613 项通过、7 项跳过。

全量回归曾出现一次 Node `fetch` 的 `bad port`，而单独复跑通过。诊断确认 runtime 测试通过 `port: 0` 使用系统临时端口；本机端口分配序列会经过 Fetch 禁止访问的 HTTP 端口，Node 在发出请求前即报 `bad port`。测试夹具现在先对本地 `/health` 做探测，仅遇到该固定原因时关闭临时 Runtime 并重新分配；其他异常仍直接失败。相关 runtime 用例 9/9、含 memory/runtime 的聚焦用例 16/16、最终全量回归均通过，未修改生产 HTTP Runtime。
