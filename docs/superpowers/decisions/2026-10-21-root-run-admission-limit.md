# Root Run 准入上限

- 日期：2026-10-21
- 状态：已采纳
- 触发：多项目 M5 压测发现多个并发父 Run 会直接同时进入 Agent，缺少宿主级资源上限。

## 决定

- `RunExecutionCoordinator` 默认最多同时执行 2 个顶层 Run 或恢复任务。
- 默认等待队列最多 32 个请求；容量可由宿主通过 `runExecutionLimits` 覆盖，并受硬上限校验。
- 排队采用 FIFO。取消的排队项从队列移除；队列满时拒绝新的执行请求。
- Target Run 必须先取得执行槽，再领取持久化启动租约，避免等待期间租约过期后被另一个协调器抢占。
- 父 Run 内的子调查继续由其父执行流程调度，不重复占用顶层 Run 槽。

## 理由

多 Target 共享一个 Agent 进程与底层资源。默认并发上限让单项目请求突增时仍保持有界调度；有限等待队列避免把请求无限积压到内存。FIFO 为已接纳的顶层请求提供简单可测的顺序保证。

## 影响与验证

- 宿主可配置 `runExecutionLimits.maxConcurrentRuns` 和 `maxQueuedRuns`；默认分别为 2 和 32。
- Target 启动、legacy 启动和恢复共用同一准入器。
- M5 `test/multi-target-load.test.ts` 以 10 个父 Run 检查峰值并发、队列等待、Agent 启动开销和 Target 隔离；不调用外部模型或数据源。
- 该上限只约束单个进程内的协调器，不构成跨多进程或多主机的全局分布式配额。
