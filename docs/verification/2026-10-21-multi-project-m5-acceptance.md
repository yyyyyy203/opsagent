# 多项目 M5 联合验收记录

- 日期：2026-10-21
- 依据：[多项目 Spec §13](../superpowers/specs/2026-10-11-multi-project-adaptation-design.md)、[M5 逐文件计划](../superpowers/plans/2026-10-20-multi-project-m5.md)
- 状态：本地模拟验收通过；不代表真实业务目标或生产数据源验收。
- 环境：Node v24.19.0、Darwin arm64、Apple M5、10 CPU；Playwright 使用本地 Chromium。容量/负载数据为热态固定 fixture 测量。
- 外部调用：新增 browser/capacity/load fixture 使用本地 ScriptedModel 和模拟来源；外部模型、LangSmith、Prometheus/ELK 与业务目标调用数均为 0。

## Spec §13 验收映射

| # | 验收项 | 主要证据 | 本轮结果 |
|---|---|---|---|
| 1 | 两 Target 使用不同映射；4% 在 5%/2% 阈值产生不同结果 | `test/target-metrics-m3.integration.test.ts`、`test/e2e/multi-target-web.spec.ts` | 通过；A 判为低于阈值，B 判为达到阈值。 |
| 2 | 同名服务/窗口的消息、证据、用量、SSE 不串扰 | `test/target-metrics-m3.integration.test.ts`、`test/target-http-routes.test.ts`、`test/e2e/multi-target-web.spec.ts` | 通过；集成断言 A/B 并发隔离，路由验证跨 Target 访问一致返回 404。 |
| 3 | 环境、数据集、部署世代、规则版本记忆隔离 | `test/memory-policy.test.ts`、`test/memory-acceptance.integration.test.ts`、Target memory route tests | 通过；冻结 MemoryScope 逐维校验，Target 路由不依赖浏览器提交 profileId 授权。 |
| 4 | A 熔断时 B 可查询；同分区共享熔断 | `test/target-source-partition-registry.test.ts`、`test/target-metrics-m3.integration.test.ts` | 通过；同分区共享，独立 Target 保持可用。 |
| 5 | 半开取消与旧 epoch 迟到响应 | `test/target-source-partition-registry.test.ts` | 通过；取消不计逻辑失败，迟到旧 epoch 结果被 fencing。 |
| 6 | Run、子 Run、证据、消息、游标、确认归属一致 | `test/target-http-routes.test.ts`、`test/web-query-sqlite.test.ts`、`test/target-child-runtime.test.ts` | 通过；新增消息/证据/确认、跨 Target Run 和游标归属断言。 |
| 7 | 模型参数不能改写 Target 来源、服务或窗口 | `test/target-metrics-subagent.test.ts`、`test/target-metrics-m3.integration.test.ts` | 通过。 |
| 8 | 错误系列、非法计数、单位/窗口和 Counter 冒充拒绝 | `test/target-metrics-subagent.test.ts`、`test/target-metrics-m3.integration.test.ts` | 通过。 |
| 9 | 暂停恢复使用原快照；撤权或世代变化先拒绝 | `test/target-recovery-policy.test.ts`、`test/target-recovery-harness.integration.test.ts` | 通过；拒绝发生在模型/来源能力取得前。 |
| 10 | 初始事务/子 Run 绑定故障、重复创建、租约关闭 | `test/target-start-reconciliation.test.ts`、`test/target-binding-durable.test.ts`、`test/target-child-runtime.test.ts` | 通过；事务回滚、幂等预留及 owner fencing 均有回归。 |
| 11 | 未批准知识和历史案例不冒充观测证据 | `test/target-knowledge-publication.test.ts`、`test/knowledge-memory-api.test.ts`、`test/memory-acceptance.integration.test.ts` | 通过。 |
| 12 | 并发公平、有界预算与注册表 | `test/multi-target-load.test.ts`、`test/target-source-partition-registry.test.ts` | 通过；10 Run、FIFO 排队、最大并发 2，来源注册表容量/准入回归通过。 |
| 13 | simulation 与 V2、证据、用量、恢复、熔断回归 | `test/e2e/agent-web.spec.ts`、全仓 lint/typecheck/test/build、Web typecheck/build | 通过；全仓 Vitest 默认跳过项见下文。 |
| 14 | 200 Target 目录查询 p95 < 100 ms | `test/multi-target-capacity.test.ts` | 通过；200 次样本，p95 0.036209 ms。 |
| 15 | 50 来源分区查找 p95 < 10 ms、外部调用为 0 | `test/multi-target-capacity.test.ts` | 通过；1000 次样本，p95 0.043707 ms，外部调用 0。 |
| 16 | 10 个并发父 Run 与排队/调度分位数 | `test/multi-target-load.test.ts` | 通过；10 Run，配置及峰值并发 2，A/B 各 5 Run，外部调用 0。 |
| 17 | 身份账本拒绝重用/倒退并接受新世代 | `test/target-identity-registry.test.ts`、`test/target-resolver.test.ts` | 通过。 |
| 18 | 父/子恢复时当前策略与原场景 digest 双重校验 | `test/target-recovery-harness.integration.test.ts`、`test/target-recovery-policy.test.ts` | 通过。 |
| 19 | Start accepted/absent/unknown 三态和 owner fencing | `test/target-start-reconciliation.test.ts` | 通过。 |
| 20 | Target HITL 工具摘要与当前租约恢复 | `test/hitl-durable-revision.test.ts`、`test/target-recovery-harness.integration.test.ts` | 通过。 |

## 本轮命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm lint` | 通过。 |
| `pnpm typecheck`、`pnpm build` | 通过。 |
| `pnpm test` | 215 个测试文件通过、5 个 opt-in 文件跳过；2241 项通过、9 项跳过。默认跳过项包括真实 Elasticsearch/Prometheus 和单独运行的多 Target 容量/负载验收。 |
| `pnpm web:typecheck`、`pnpm web:build` | 通过。 |
| `pnpm e2e:multi-target` | 通过，1/1；验证 A/B 页面、冻结范围标签、跨 Target/legacy 404、迟到响应隔离、A 历史与 simulation 回归。 |
| `pnpm acceptance:multi-target-capacity` | 通过；目录 200 samples p95 0.036209 ms；50 partitions/1000 samples 查找 p95 0.043707 ms，externalCalls=0。 |
| `pnpm acceptance:multi-target-load` | 通过；10 Runs、配置并发 2、峰值 2、A=5/B=5、externalCalls=0。队列等待 p50 75.78 ms、p95/p99 149.85 ms；Agent 调度 p50 4.79 ms、p95/p99 9.99 ms；完成延迟 p50 206.88 ms、p95/p99 208.46 ms。 |

全仓测试在默认沙箱遇到 loopback `listen EPERM` 后，使用获准的 loopback 执行环境并将 `TMPDIR` 指向 `/private/tmp` 重跑通过。M5 结论只覆盖本机模拟 Target 和确定性测试；未连接真实 `group-buy-market`、生产 Prometheus/ELK、在线模型或 LangSmith。真实业务只读数据源与生产部署仍需单独验收。
