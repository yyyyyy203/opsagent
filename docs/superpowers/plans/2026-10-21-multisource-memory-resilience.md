# 多来源记忆异常与隔离验收实施计划

- 日期：2026-10-21（Asia/Shanghai）
- 依据：[Spec 与 R01–R12 验收矩阵](../specs/2026-10-21-multisource-memory-resilience-design.md)
- 状态：部分实施；阶段 B 已完成本次验收，A/C 有未完成项，D 正在收尾。逐条证据见[验收记录](../../verification/2026-10-21-multisource-memory-resilience-acceptance.md)和 STATUS。
- 分类：测试基础设施、适配器组合验收；仅按实际失败修复对应产品模块。
- 兼容性：沿用公共契约、存储 Schema、审核/晋级与冻结选择规则，预计无需迁移。

## 1. 执行约定

开始实施时重新阅读 AGENTS、PROJECT、STATUS、相关 DECISIONS，检查分支和工作区，不沿用本文盘点结果作为运行基线。使用本地模拟来源与确定性模型，不访问真实业务系统。

实施顺序为 A → B → C → D。每个阶段先核对退出条件并运行相关检查，再更新 STATUS、独立提交并推送；失败只能记为进行中或受阻。不得混入其他任务文件。阶段提交包含实现时，按 AGENTS 运行 lint、typecheck、test、build，涉及 Web 同时运行 Web 检查。

## 2. 阶段 A：可信且隔离的测试夹具

目标：让异常注入、计时、请求观测和模型行为可以被验证，而不是由夹具固定返回预期结果。

| 文件 | 计划改动 |
| --- | --- |
| `test/e2e/memory-multisource-fixture-server.mjs` | 增加有限场景配置、Run 前冻结、用例重置、可控 Clock、实际请求观测和取消统计；确保启动失败及关闭都释放资源。 |
| `test/e2e/memory-multisource-web.spec.ts` | 提取启动、终态、沉淀、审核及模型输入检查帮助函数；终态等待支持现有 completed/failed/cancelled，不统一写死 completed。 |
| `test/e2e/helpers/memory-multisource-scenarios.mjs`（拟新增） | 仅当夹具职责过多时拆出场景/模型辅助；只存实例级状态，不创建共享 Run 状态。 |
| `playwright.memory-multisource.config.ts` | 按隔离策略维护服务启动和端口检查，单 worker 起步；失败保留 trace/screenshot，禁止复用未知既有服务。 |

- [ ] 列出现有测试与 R01–R12 的映射，确定需新增的组合断言。
- [ ] 脚本模型依据实际 ToolResult 处理成功与失败，不因缺少 evidenceId 无限重试。
- [ ] 注入业务时钟并同步模拟证据窗口；记录实际模型输入中的历史案例标识。
- [ ] 场景控制面仅在测试服务可用，限制 loopback、校验凭证与载荷；活动 Run 存在时拒绝重置。
- [ ] 在实际传输入口统计/阻止非允许目的地；用不发送网络的拦截自测验证观测器。
- [ ] 证明重置后没有前一用例案例、调用计数或模型状态残留。

退出条件：R01 原正常闭环保持通过，R12 有可信结果；故障可以重复触发，模型能有界结束，观测覆盖范围已记录。若源码语义与 Spec 冲突，先登记差异，不改规则来迁就测试。

## 3. 阶段 B：来源异常与质量门

| 文件 | 计划改动 |
| --- | --- |
| `test/e2e/memory-multisource-web.spec.ts` | 增加 Metrics/Logs 单侧失败、超时及 partial 的浏览器流程；保留另一侧证据，检查限制和审核不可用原因。 |
| `test/memory-acceptance.integration.test.ts` 或 `test/memory-multisource-resilience.integration.test.ts`（拟新增） | 使用实际 Runtime、临时 SQLite、模拟来源贯通错误传播、沉淀和审核，验证 R02–R05、R11。按文件复杂度选择扩展或拆分。 |
| `test/memory-capture-source.test.ts`、`test/memory-case-builder.test.ts`、`test/memory-review-service.test.ts` | 仅补发现缺失的双来源组合和边界，复用现有失败/不足/审核测试。 |
| `src/infrastructure/sqlite/memory-capture-source.ts`、`src/memory/case-builder.ts`、`src/memory/review-service.ts`、`apps/agent-web/src/components/MemoryPanel.tsx` | 条件性修复范围；先以失败测试复现，再最小修改。不得因计划列出文件就无条件重构。 |

- [ ] 来源错误/超时从模拟 source 或本地传输层产生，不 mock 最终 memory API。
- [ ] 失败用例保留可用证据并检查 ownerRunId、evidenceId、原文/哈希回查。
- [ ] 直接请求批准不足案例，断言稳定错误码及未发生审核状态变更；同时检查 UI。
- [ ] Abort 与超时分别验证信号、调用次数上界、终态和资源释放。
- [ ] Logs 已有页后失败/截断的 partial 行为按现有契约验证。
- [ ] requiredSources 包含与不包含 trace 的质量判断形成对照。

退出条件：R02–R05、R11 通过，R01 无回退；API 与 UI 对不足案例的处理一致。确定性模型的文字回答不作为唯一通过条件。

## 4. 阶段 C：召回资格与跨作用域隔离

| 文件 | 计划改动 |
| --- | --- |
| `test/e2e/memory-multisource-web.spec.ts` | 覆盖未审核、拒绝、撤销、过期后的多来源案例召回；检查真实模型输入。 |
| `test/e2e/memory-target-fixture-server.mjs`、`test/e2e/memory-target-web.spec.ts`（拟新增） | 复用既有 Target 组装端口，创建共享数据库的 A/B；来源、证据、记忆均通过真实应用接口运行，增加 Target 切换与归属检查。 |
| `playwright.memory-target.config.ts`、`package.json`（拟新增配置/脚本） | 新增明确的 opt-in `e2e:memory:target` 入口，隔离端口及结果目录；核对默认 Playwright 项目不会误收集专用夹具测试。 |
| `test/memory-multisource-resilience.integration.test.ts`（或阶段 B 选定文件） | 服务/dataset 逐维隔离、共享存储、相同查询、正向匹配对照；过期时间边界。 |
| `test/memory-recall.test.ts`、`test/memory-api.test.ts`、`test/e2e/memory-web.spec.ts` | 复用并回归已有过滤、冻结选择重校验、拒绝/撤销及接口隔离，按缺口补断言。 |

- [ ] 案例通过实际采集、沉淀与审核产生，不直接 SQL 修改生命周期状态。
- [ ] 每个不召回场景都有同 scope 合格案例的正向对照，排除关键词/预算错误。
- [ ] 到期前、等于到期、到期后由 Clock 验证；新 Run 使用一致的新证据窗口。
- [ ] A/B 共库，A 正向可用、B 不含 A 案例；跨 Target 读取证据和审核安全拒绝。
- [ ] scope 由宿主解析和冻结，不能让浏览器或模型自由填写身份字段。
- [ ] 服务和 dataset 单维变化在集成层验证；浏览器承担 Target 选择和展示路径。
- [ ] 已批准的模拟案例仍不可晋级，撤销及过期不会新增持久化状态。

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
pnpm e2e:memory:target
pnpm e2e:multi-target
pnpm exec playwright test --config=playwright.memory.config.ts
AGENTOPS_MEMORY_E2E_DISABLED=1 pnpm exec playwright test --config=playwright.memory.config.ts -g 'disabled memory keeps existing inspection usable'
```

`e2e:memory:target` 是阶段 C 待建立的命令，目前尚不存在。原记忆禁用态场景通过专门配置运行；记录实际选择、跳过和通过的测试，不把跳过计为通过。浏览器缺失、端口权限等环境问题须记录，不用旧日志代替。

- [ ] 建立 `docs/verification/<实际验收日期>-multisource-memory-resilience-acceptance.md`，逐条记录 R01–R12 对应测试、命令、结果、失败材料及限制。
- [ ] 记录 Node/pnpm、实际分支和代码基线、临时来源配置、时钟/预算、请求观测范围，报告不含凭据。
- [ ] 标明模拟验收与真实数据/在线模型/生产授权验收的边界。
- [ ] 检查所有本轮相关修改、`git diff --check`，更新本计划阶段状态和 `docs/STATUS.md`；若范围发生改变同步 PROJECT，决策门槛触发时同步 DECISIONS。
- [ ] 核对当前工作分支、远端与暂存文件，只提交本任务文件并推送；远端提交核对成功后报告同步完成。受阻时记录原因和下一步。

退出条件：R01–R12 有本次可复现证据，必要质量门通过，相关缺陷已修复，报告/状态更新并提交推送。文档编写完成、某一条正常测试通过或仅本地 commit 都不等于本实施计划完成。

## 6. 当前执行状态

| 阶段 | 状态 | 本次结果 |
| --- | --- | --- |
| A | 部分完成 | 补充 AGENTS 方案落盘规则；ScriptedModel 有界处理失败结果、本地请求拦截与来源取消已验证。业务 Clock 注入、用例级全状态重置/隔离证明尚未完整覆盖。 |
| B | 完成 | Metrics/Logs 失败、Metrics 超时、Logs partial 浏览器矩阵通过；本次全量记忆测试和 acceptance:memory 通过。 |
| C | 部分完成 | 同一 SQLite 的 Target A/B 正向召回和互相隔离测试通过；单来源记忆 UI 回归通过。缺 Target 切换与记忆采集/召回一体化浏览器夹具，R09 不满足完整退出条件。 |
| D | 进行中 | lint、typecheck、web:typecheck、test、memory acceptance、multi-source/multi-target/memory Web E2E 已通过；验收报告、最终差异检查与 Git 同步待完成。 |

本轮不能标记整个计划完成：R09 组合浏览器场景和阶段 A 中未完整证明的隔离条件仍待完成；其它已执行结果及环境边界见验收记录与 STATUS。
