# 多项目适配 M5 逐文件实施计划：联合验收与回归

- 日期：2026-10-20
- 依据：[多项目适配设计 Spec](../specs/2026-10-11-multi-project-adaptation-design.md) §13 验收矩阵
- 前置：M4 的 Target 主工作台、归属读写入口和模拟 Target 运行能力均已实现。
- 状态：待实施；本计划只定义验收，不代表测试已运行。

## 验收边界

使用两个身份、指标映射、标签、阈值和数据集都不同的模拟 Target，确定性模型桩、注入时钟和临时 SQLite。测试不得调用真实模型、LangSmith、生产 Prometheus/ELK 或 `group-buy-market`。M5 同时证明双目标浏览器流程与服务端边界；不能用现有单 simulation 熔断 E2E 代替。

## 逐文件任务

| 文件 | 验收工作 |
| --- | --- |
| `src/profiles/target-samples.ts`、`test/helpers/target-publication-fixture.ts` | 固定 A/B 版本化 Catalog、知识发布和来源身份；同名服务/同窗口但独立数据域，阈值 5%/2%，4% 样本在两侧得出不同确定性结果。夹具中无真实地址或凭据。 |
| `test/e2e/multi-target-fixture-server.mjs`（新） | 启动真实本地 Agent Web Runtime、两个模拟来源分区、临时数据库和可注入故障/时钟控制面；启动失败和 teardown 必须关闭所有租约、HTTP 服务与临时资源。只监听 loopback。 |
| `test/e2e/multi-target-web.spec.ts`（新） | 浏览器选择 A/B，启动并发 Run，切换页面和历史；验证目标/规则版本、父子证据、消息、用量、记忆、确认、SSE 不串扰；A 熔断/恢复时 B 仍可查询；Target 切换后旧 SSE/迟到响应不得更新新视图；旧 simulation 页面仍可用。 |
| `test/target-metrics-m3.integration.test.ts`、`test/target-metrics-subagent.test.ts` | 复用 M3 机制断言 A/B 不同映射、边界窗口/单位/异常计数、模型篡改参数、父子继承和来源越界拒绝；补 M5 所需的两项目并发组合，不重写场景实现。 |
| `test/target-source-partition-registry.test.ts`、`test/target-recovery-harness.integration.test.ts`、`test/target-recovery-policy.test.ts` | A 的 3 次逻辑失败、30 秒冷却、单半开探测、取消不计失败、旧 epoch 迟到完成、跨场景同分区共享与 B 独立；暂停后禁用/撤权/改世代/Scenario digest 变化均在模型或来源调用前拒绝。 |
| `test/target-http-routes.test.ts`、`test/web-query-sqlite.test.ts`、`test/memory-api.test.ts`、`test/knowledge-memory-api.test.ts` | A 的 runId/evidenceId/游标/确认/案例用于 B 全部安全拒绝；旧 `/runs` 在数据库分页前排除 Target Run；知识失效不注入，旧入口不能绕行；进程重开后相同归属仍成立。 |
| `test/target-start-reconciliation.test.ts`、`test/target-binding-durable.test.ts`、`test/target-child-runtime.test.ts` | 初始事务失败、丢失响应、unknown 重读、双协调器、子 Run 首次绑定失败与租约释放；绝不产生可执行但无绑定的 Run 或重复执行。 |
| `test/multi-target-capacity.test.ts`（新） | 在具名固定环境中登记并解析至少 200 Target，首屏目录查询 p95 < 100 ms；登记至少 50 来源分区，纯内存查找 p95 < 10 ms 且外部调用数为 0。记录硬件、Node/pnpm、冷热状态、样本量与方法。 |
| `test/multi-target-load.test.ts`（新）或独立 opt-in 脚本 | 用可覆盖默认并发 2 的显式压测配置运行 10 个并发父 Run；记录排队和 Agent 调度 p50/p95/p99、作用域隔离、预算与注册表上界。固定环境才作为性能门，外部网络延迟不作回归阈值。 |
| `playwright.multi-target.config.ts`（新）、`package.json` | 增加 opt-in `e2e:multi-target` 与必要的本地 fixture 启动命令；不改变默认测试对真实外部服务的禁用行为。 |
| `docs/verification/2026-10-20-multi-project-m5-acceptance.md`（新）、`docs/implementation-status.md` | 逐条映射 Spec §13 的 1–20 项至测试、命令、结果和未覆盖项；记录浏览器截图/日志的安全摘要、容量环境、跳过项与所有外部请求计数。明确模拟验收与真实目标验收的差别。 |

## 执行顺序与完成标准

1. 先复用 M1–M3/R0 已有机制测试，列出 Spec §13 每一项的现有证据；只补缺失的组合和浏览器路径。不要把历史通过记录当作本轮结果。
2. 搭建 A/B fixture，先验证单目标，再执行并发、故障、恢复、跨范围拒绝和浏览器切换；注入故障控制面不得暴露给 Agent 工具。
3. 运行容量和 opt-in 负载项，记录环境与分位数；资源上限与默认并发配置分别核对。
4. 执行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、Web typecheck/build、`e2e:multi-target` 和现有 simulation/Episodic/知识/熔断回归；记录通过、失败及跳过。
5. 只有 Spec §13 的适用项均有本次可复现证据，且没有跨 Target 数据或权限泄漏，才把 M5 标记完成。可选 M2b 仅在实施后追加其迁移路径验收。真实 `group-buy-market` 只读 Prometheus 接入另立验收任务。
