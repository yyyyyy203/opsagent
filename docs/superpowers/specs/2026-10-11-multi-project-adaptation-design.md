# 多项目巡检适配设计 Spec

- 日期：2026-10-11
- 决策状态：设计草案，待审核；本次不实施运行时代码。
- 适用范围：一套本地 Agent 宿主，由一个可信操作者切换多个项目、部署环境和巡检场景。
- 首轮数据：两个可区分的模拟项目；不依赖真实业务压测、付费模型或 LangSmith 请求。
- 基线：沿用本仓库 AGENTS.md、Event/Message V2、统一工具管线、Source Subagent、Durable State 和受控诊断记忆，不另建主循环。

## 1. 目标与非目标

目标是让不同项目复用同一个巡检框架，并且可明确回答：本次在查哪个系统、哪个部署、哪类问题、用了哪版规则、证据和记忆属于谁。

采用“共享 Agent Core + 受信任的目标绑定 + 场景包 + 数据源适配”的方式。Profile 是规则入口，Semantic Memory 是知识补充；两者都不能单独承担完整的多项目适配。

第一版必须支持：

1. 在 Web 中选择项目、环境和巡检场景，不输入连接地址或密钥。
2. 同一场景在两个项目中使用不同的服务映射、指标名、标签和阈值。
3. 父 Run 和 Source 子 Run 使用同一个不可变目标范围。
4. 证据、Checkpoint、记忆、游标、工具权限和数据源熔断不跨范围串扰。
5. 保留现有 simulation 入口及烟测行为；新目标机制是显式启用的增量。

本 Spec 不授权新增自动动作，不接入任意 Shell/Git，不建设跨组织 SaaS，不保证未提供观测数据的系统可以完成根因诊断。多人远程访问必须另行设计身份认证、项目 ACL 和部署隔离；Host/Origin 检查不是授权机制。

## 2. 当前代码事实与缺口

下表基于源码检查，而非仅根据旧架构文档推测。

| 已有实现 | 当前边界 | 多项目需要补充 |
| --- | --- | --- |
| `src/profiles/profile-types.ts`、`profile-resolver.ts` | Profile 保存服务等级、允许动作、冻结期和影响策略；通过 profileId 解析不可变快照 | 组合项目、部署、场景和来源配置，不把这些全部塞进安全 Profile |
| `src/bootstrap/agent-web-runtime.ts` | Metrics/Logs 配置只接受 simulation；启动准备固定 checkout 和五分钟窗口 | 受信任 Target Resolver 与多目标组装 |
| `src/profiles/settlement.ts`、`src/infrastructure/prometheus/settlement-source.ts` | 结算实验的服务、环境、指标名和窗口计数语义固定；Counter increase 不是此 Profile 的语义 | 指标映射、查询模板和场景级确定性分析，保留旧实验契约 |
| `src/bootstrap/metrics-web-source.ts`、`logs-web-source.ts` | 为当前来源构造客户端和熔断器；子 Agent 复用父级事件和证据端口 | 来源分区注册表、跨 Run 的受控共享、子 Run 继承范围 |
| `src/contracts/diagnostic-memory.ts`、`src/memory/memory-scope.ts` | 已按 profileId、revision、serviceId、faultType、environment、dataClass、targetFingerprint、datasetId 精确隔离 | 宿主生成一致的范围；不降低现有同范围校验 |
| `src/bootstrap/memory-policy.ts` | 每个 profileId 仅能对应一个 MemoryScope；requiredSources 属于整份配置 | 每个 Target 派生独立记忆策略，不共用一份场景不匹配的全局 requiredSources |
| `src/infrastructure/sqlite/persistence-bundle.ts` | 有完整 SQLite bundle 和事务边界 | 目标快照/Run 归属表，与初始 Checkpoint 原子提交 |
| `src/application/create-runtime.ts` | SQLite bundle 由组装函数创建；sharedEvents 主要用于子 Run，不能等同于完整 Durable State 注入 | 明确完整持久化端口和唯一生命周期所有者，不只共享 Checkpoint/EventStore |
| `src/contracts/read-model.ts`、`web-read-model.ts` | 查询以 runId/profileId 为主，没有项目级入口 | Target-scoped 查询门面、归属校验和新的安全目录 DTO |

现有 Episodic Memory 及向量影子实验不等于完整 Semantic/Procedural 知识库。多项目设计不能据此宣称知识来源或多项目隔离已经实现。

## 3. 方案选择

| 方案 | 优点 | 主要代价/风险 | 结论 |
| --- | --- | --- | --- |
| 单个可变 Toolkit，切换全局当前项目 | 入口改动看起来少 | 并发 Run、恢复、缓存和工具闭包可能读到另一个项目；工具表膨胀 | 不采用 |
| 共享框架，按不可变 Target 快照组装运行能力 | 复用主循环；目标范围清晰；可逐项目接入 | 要补目标归属、完整端口注入和有界生命周期 | 推荐 |
| 每个项目独立部署进程和数据库 | 隔离强、部署边界明确 | 配置、升级、Web 入口和运维成本更高 | 未来强隔离选择，不作为个人验证起点 |

推荐方案不要求为每个项目启动一个独立进程，也不为每个项目发明一套 Subagent。仍是主 Agent 调用 metrics_subagent、logs_subagent 等 Tool，子 Agent 内部调用受当前绑定约束的底层工具。

## 4. 适配模型：项目、部署、场景、来源分别建模

```text
共享 Agent Core / Tool Pipeline / V2 / Memory 接口
                     ↑ 宿主按快照注入
InspectionTarget（一次可选择的巡检目标）
  ├── ProjectDefinition：项目身份、展示名、逻辑服务目录
  ├── DeploymentDefinition：环境、部署身份、数据类别
  ├── ScenarioBinding：场景包版本、服务、指标映射、阈值
  ├── Risk Profile：安全规则、等级、允许动作、冻结期
  ├── SourceBindings：Metrics / Logs / Trace 的受控来源
  └── KnowledgeBindings：经审核知识引用及记忆策略
```

概念边界：

- Project 是业务项目，不是一个 Git 路径，也不要求源码在本机。
- Deployment 是项目的一个具体部署，例如模拟数据集、测试环境或生产集群。同一 environment 可有多个部署；不能只用 production 这个字符串判断同一系统。
- Scenario 是问题类型和确定性诊断方法，例如窗口失败率升高。场景包可被多个项目复用。
- Target 是一个可选择的“项目 + 部署 + 场景 + 服务”绑定；不是所有项目配置的大对象。
- SourceBinding 指向宿主控制的连接定义、访问范围和适配器。原始 URL、认证信息、索引名等敏感连接细节只留在宿主私有配置。

同一个项目可有多个环境和场景。第一版一个 Target 对应一个主逻辑服务；跨服务调查只能访问该 Target 显式声明的依赖服务白名单，不能根据模型文本临时扩张。

### 4.1 身份规则

| 标识 | 用途 | 稳定性 |
| --- | --- | --- |
| projectId | 无敏感含义的项目资源 ID | 展示名改变不改变 ID |
| deploymentId + deploymentGeneration | 定位数据所属部署及其世代 | 指向另一系统/数据域必须更换世代 |
| targetId | Web 选择和路由的稳定资源 ID | 禁止删除后重新绑定为另一目标 |
| profileId | 兼容现有 Profile、Run 和记忆接口 | 在整个宿主中唯一，绑定一个 Target |
| profileRevision | 诊断规则、映射和知识兼容边界 | 语义变化必须递增 |
| targetFingerprint | 现有 MemoryScope 的部署身份 | 来自宿主分配的非敏感身份；不哈希 URL 或密钥生成 |
| datasetId | 区分模拟实验数据集 | 仅 simulated 有，换数据集必须换 ID |
| bindingId + digest | 定位本次冻结的完整绑定快照 | 快照不可变，摘要采用现有 canonical JSON 机制 |

Project/Deployment 本身不能授权读写。ID 只能作为查找键，真正权限来自宿主解析出的绑定与当前策略。

targetFingerprint 必须唯一对应项目、部署世代和实际数据域；部署世代或数据域改变时分配新值，禁止继续复用旧值。解析器检查该映射的一致性，不能仅因仍叫 checkout/production 就认为是同一目标。普通密钥值轮换不改变数据域身份。

示例 profileId 可使用 `market-a.lab.settlement`、`market-b.lab.settlement`，但不要依靠分割字符串获取归属，归属必须查注册表。现有 `simulation` 保留为显式 legacy Target，不重命名历史 Run。

### 4.2 配置源与装载

第一版用宿主显式指定的本地 JSON 配置和严格 Schema，不提供模型改配置、Web 上传配置或可执行脚本插件。

配置分三份：

1. Target Catalog：非敏感资源 ID、场景版本、服务映射、阈值、来源绑定引用、知识引用。
2. Connection Registry：连接地址、传输参数、访问范围、secretRef；仅宿主访问。
3. Secret Provider：从受控运行环境解析密钥；永不把密钥写进 Catalog、快照、Checkpoint、事件、模型上下文或报告。

装载时检查 ID 唯一、引用完整、版本已安装、指标语义/单位正确、服务白名单、数据类别、记忆范围一致、预算上限。禁止从浏览器或 LLM 的参数直接使用 endpoint、PromQL、索引通配符、profileRevision、targetFingerprint、datasetId 或 secretRef。

无效配置只使对应 Target 不可启动，其他已验证 Target 可用。认证密钥值不在配置目录预览中显示；连接测试保持惰性，不因一个数据源暂时掉线而使所有项目无法启动。

重名 ID 的所有冲突项必须隔离，不采用“最后一项覆盖前一项”；目录整体无法解析时不发布半份未校验目录。第一版推荐注册 Target 上限 20，配置文件和引用数量有独立上限；数值可经宿主配置调整，但不能由模型请求增加。

## 5. 新项目接入到底改什么

### 5.1 同一场景：配置和映射适配

如果新项目也需要检查窗口失败率，只需声明：逻辑服务、窗口计数的指标名/标签、窗口时间指标、最低样本数、阈值、来源绑定和已审核背景知识。

两个模拟 Target 的例子：

| 项目 | 场景 | 指标映射 | 失败阈值 | 数据来源 |
| --- | --- | --- | --- | --- |
| market-a | window_failure_rate.v1 | `market_checkout_window_requests`，outcome=success/failed | 5% | metrics-a + dataset-a |
| market-b | window_failure_rate.v1 | `orders_submit_window_count`，result=ok/error | 2% | metrics-b + dataset-b |

这两个例子都要求“同一可信窗口的整数快照计数”，不能只因名称相似就把 Counter、Gauge 和 rate 的值混用。窗口边界也要映射并验证，不把抓取时间当业务统计窗口。

映射器把返回内容转成该场景的版本化事实，例如 `window_count_snapshot.v1`；确定性分析器计算 failed/total、样本量和阈值结果。LLM 解释结果、规划补证，不重新计算数值，也不能修改阈值。

### 5.2 不同计数语义或新故障类型：扩展场景包

如果新项目只提供 Prometheus Counter，需要单独定义 Counter 场景的区间、reset、increase 估算、小样本和浮点精度规则，不能复用整数快照分析器。

如果要诊断数据库连接池、队列积压或其他新故障，则新增经过测试的 Scenario Pack：

- 版本化输入/事实/报告 Schema。
- 允许的查询模板和参数边界。
- 数值、阈值、证据充分性和场景结果的确定性分析器。
- 必需与可选的数据源、取证计划和预算。
- 模型可读的背景说明、诊断限制与 Runbook 引用。
- 模拟样本、异常/缺失/边界样本以及独立验收断言。

场景包是仓库内经审核的 TypeScript 实现，通过小接口注册；不是从 JSON 动态执行代码。新增后要同步公共投影与前端安全摘要 Schema，不能把任意事实 JSON 直接透传出去。

现有 SettlementMetricsProfile/Fact 保留，不扩大其中 simulation/checkout 的字面量来假装通用化。新增场景包及适配器独立实现，旧实验可用兼容映射或继续走原入口。

## 6. 核心接口与模块职责

以下是目标接口边界，不是对当前代码已经具备这些接口的声明。具体字段和命名在逐文件计划中与 Schema 一起冻结。

```typescript
interface TargetResolver {
  resolve(selection: TargetSelection): Promise<ResolvedTargetSnapshot>;
}

interface TargetRuntimeProvider {
  // 使用已验证快照；不能传任意 endpoint 或工具数组。
  acquire(snapshot: ResolvedTargetSnapshot): Promise<TargetRuntimeLease>;
}

interface ScenarioPack {
  readonly id: string;
  readonly version: string;
  validateBinding(binding: ScenarioBinding): ValidatedScenarioBinding;
  analyze(input: ScenarioEvidenceInput): ScenarioAssessment;
}

interface SourceAdapterFactory {
  // 仅在 bootstrap 使用私有连接端口组装 Tool。
  create(binding: ValidatedSourceBinding, ports: SourceAssemblyPorts): SourceTools;
}
```

ScenarioAssessment 是注册场景的判别联合，不是未校验的 Record<string, unknown>。来源查询和证据采集异步执行；analyze 对已验证事实做确定性分析，不发网络请求。

模块建议：

- `contracts/`：最小目标、快照、场景结果与归属端口；不依赖基础设施。
- `profiles/`：Target/场景配置校验、风险 Profile；场景实现先放 `profiles/scenarios/`，不急于拆 npm 包。
- `application/`：Target-scoped Run 用例、查询门面、恢复协调。
- `bootstrap/`：目录装载、私有连接解析、运行时和来源生命周期管理。
- `infrastructure/`：SQLite 归属记录、Prometheus/ELK 映射适配器。

Memory、压缩器、ToolRunner、风险策略仍通过各自现有接口替换；不塞进 TargetResolver，不让 Harness 感知具体数据库、连接协议或项目名。

## 7. 单次 Run 的执行、继承和恢复

```text
Web 选择 targetId + 问题 + 允许的记忆偏好
  → 宿主解析并验证 Target/Scenario/Source 绑定
  → 冻结服务、统计窗口、规则、版本、知识引用和预算
  → 原子创建归属记录 + 初始 Checkpoint + 起始事件 Outbox
  → 获取与该快照匹配的 Toolkit/来源能力
  → 现有 Harness：Reasoning → Guard/Hook/HITL → Tool 执行
  → Source 子 Run 继承绑定；采集证据并做场景分析
  → 主 Agent 给出结论、引用、缺失项与限制
```

模型可以请求白名单内的调查工具、服务和受限时间子窗口；宿主已冻结的上限优先。任何重试、JSON 修复或 Subagent 重试都不得绕过绑定校验。

现有 trustedSystemContext 文本只能帮助模型理解范围，不是授权依据。真正约束来自结构化快照、作用域端口和执行前校验；不能靠提示词要求模型“不要查其他项目”。每个 Tool 的并发调用都携带自己的不可变执行范围，禁止在工具实例上临时设置 currentProject/currentWindow。

主 Agent 仅注册需要的来源 Subagent Tool，子 Agent 才获得该来源的底层 Tool。工具名继续使用 `metrics_subagent`、`logs_subagent`；不会为两个项目注册两套带项目名前缀的工具暴露给模型。

Toolkit 在快照对应的运行能力组装后冻结，Run 中途不增删工具。缺少可选来源的 Target 不注册该能力并明确 missingEvidence；已配置但暂时失败的来源保留固定 Schema，执行时返回 unavailable/partial。必需来源缺少配置属于 Target 配置错误；必需来源运行中失败属于证据不足，不能宣称目标健康。

### 7.1 快照与持久化

推荐第一版继续用一个宿主拥有的完整 SQLite persistence bundle，不为每个 Target 重复开同一数据库，也不只给它注入一个 CheckpointStore。

需要新增版本化的 `target_snapshots` 和 `run_target_bindings` 等价存储：

- Snapshot 保存 project/deployment/target/profile/scenario 的 ID 与版本、世代、已验证映射/规则、来源引用版本、知识引用版本和 digest；不含连接密钥和 URL。
- root Run 的初始 Checkpoint 与归属关系通过同一 DurableTransition 事务提交；提交前不执行模型或来源网络请求。
- 新建 Run 的客户端幂等键也绑定 Target 与请求摘要；重复提交返回同一 Run，参数冲突则拒绝，不能因 HTTP 重试重复创建付费巡检。
- child Run 在其首个持久化转换中绑定同一 Snapshot 和 rootRunId；归属不能由 tool arguments 或事件事后推测。
- 为 AgentContext 增加可选 `targetBindingId`，更新严格 Checkpoint codec 与版本迁移；没有该字段的旧 Run 仍按 legacy 规则读取。
- L0/L1/L2 不裁剪或改写目标绑定引用、版本、未解决风险及证据归属；模型渲染只输出获准背景，不序列化完整私有配置。
- Snapshot/ref 必须随活跃/可恢复 Run 保留，不允许普通配置清理删掉恢复所需版本。

当前 createAgentRuntime 的 sharedEvents 不能满足完整 Durable State/Memory 注入。实施时新增明确的“完整 runtime persistence ports”注入边界，包含 transitions/outbox/executions/queries/evidence/memory 及生命周期；不可用部分注入默默退回 InMemoryDurableState。

SQLite、Outbox dispatcher、V2 Publisher/Projectors 和回放管理由宿主唯一所有者初始化和关闭。各目标运行能力持有作用域端口和租约，不各自重复初始化投影、回放全库或 flush/close 共享所有者；子 Run 的事件与父 Run 继续使用同一条权威持久化链路。

### 7.2 恢复不自动换规则

恢复必须按 runId 查原 Snapshot，再重建原版本能力。不得按当前 projectId/profileId 重新选择最新连接、场景或阈值。

同时重新检查当前限制：目标是否禁用、来源权限是否撤销、部署/数据集世代是否改变、知识是否撤销、HITL 是否过期。旧快照只保证可复现，不授予永久权限。收紧立即生效，放宽不会自动扩大旧 Run 的权限。

原场景包或绑定版本不存在时拒绝执行并返回固定错误码，提供只读历史结果；不能隐式迁移到新版本。普通密钥轮换可重新解析同一权限/数据范围的 secretRef；如果访问的是另一数据域，必须改变来源/部署世代并阻止旧 Run 再取证。

## 8. 隔离不仅是记忆隔离

| 对象 | 强制隔离键/规则 |
| --- | --- |
| Run 与子 Run | bindingId + rootRunId + runId；子 Run 继承同一绑定 |
| 工具/模型请求 | 绑定快照的服务/窗口/来源白名单，逐调用 signal/deadline/预算 |
| 当前证据 | evidenceId 归属已绑定 Run；只允许同 root lineage 的受控引用，不凭同 profileId 放行 |
| 历史案例 | 现有 MemoryScope 全字段精确匹配；历史引用不得充当本次证据 |
| Query/cache | 部署世代、来源分区、查询模板/参数、统计窗口和返回 Schema 版本 |
| 原始 Blob | Manifest 归属查询后才开放内部读取；公共页面仍只展示摘要和引用 |
| 游标 | target/binding + runId + 查询类型/参数摘要；别的 Target 不能继续分页 |
| HITL/resume/cancel | 先验证 Run 归属，再执行具体 toolCallId 的现有授权流程 |
| SSE/messages | 连接绑定 runId 与目标归属；前端切换项目不能接收旧选择的流到新视图 |

来源状态不按全局字符串 prometheus 或 elk 存。宿主 SourcePartitionRegistry 的分区键至少包含 projectId、deploymentId/generation、sourceBindingId 和 sourceGeneration。

同部署、同权限/数据域的多个场景共享同一来源分区的客户端、熔断器和并发配额，避免通过切换场景绕过熔断；不同项目/部署/数据域不得共用分区，即使连接到了同一个 Prometheus/MCP 服务。

保留当前默认“3 次逻辑操作失败 → 熔断 30 秒 → 一个半开探测”的语义，不按每个 retry attempt 重复计失败。取消不计来源故障，旧 epoch 的成功不能关闭新熔断。换 Run、切页面或释放 Toolkit 租约不重置共享熔断器。

访问共享后端时，适配器必须把服务/部署约束编译进允许的查询模板并验证返回 Scope；仅在浏览器选择了项目但发出跨项目查询是不合格的。发现响应越界必须失败并禁止跨域内容进入证据/模型。

全局运行上限与 Target/来源分区上限同时生效，防止某一项目耗尽资源。第一版推荐默认最多 2 个活跃父 Run、每个 Target 1 个；子 Run 继承父级工具/网络/模型预算，不另领一份无限预算。模型/网络信号量按单次实际请求释放，不在父 Run 等待子 Run 时占住子 Run 所需的许可。

注册目录、活跃能力租约、窗口、查询结果、Schema 大小、来源读取和历史分页都要有上限。空闲能力可释放但不能清掉活跃 Run/半开探测；来源注册表随宿主有界管理，第一版不提供无上限动态添加目标。

## 9. 记忆和知识的使用策略先确定

### 9.1 四类记忆各做什么

| 类型 | 多项目中的用途 | 第一版策略 |
| --- | --- | --- |
| Working | 本次绑定、事实、待确认、缺失证据和预算 | 复用结构化 AgentContext/Checkpoint |
| Episodic | 同项目/部署/场景的已审核历史案例 | 继续现有受控保存/审核/撤销/同范围召回；开关不因多项目自动开启 |
| Semantic | 服务依赖、指标含义、已知系统背景、Runbook 说明 | 从审核后的 Profile/场景配置生成有界知识快照；完整知识库另行 Spec |
| Procedural | 可复用的诊断步骤模板 | 只能提供人工审核的只读诊断提示；不自动执行动作或晋级经验 |

Semantic 的使用时机明确为 Triage 和取证计划阶段，按 Target、服务和场景选择有界内容；不是先把知识库全建完再决定用途。

确定性权威保持唯一：阈值、指标类型/单位、查询范围和安全规则以版本化 Profile/Scenario 绑定为准。知识条目引用这些定义，不复制一份独立阈值让模型选择。冲突知识进入隔离/待审核，不用最近更新或向量得分决定谁是权威。

知识引用使用独立的 knowledgeRef/version/source/review 信息，不能伪装为 evidenceId、增加当前证据 coverage，或替代失败率观测和 Risk Gate。未审核、过期、撤销或与当前部署版本不兼容的内容不注入。

第一增量只渲染受信任配置中已有、明确审核的描述和 Runbook 引用，不开放自动 LLM 提取、跨项目检索或完整 Semantic CRUD。Runbook 内容只能提供背景，不能改变系统提示词中的权限和执行规则。

### 9.2 现有记忆范围怎样接上

Target Resolver 生成 trustedMemoryControl，浏览器只提交现有 capture/recall 偏好。每个 Target/profileId 的范围唯一；同名 checkout 服务也因 profileId、targetFingerprint、datasetId 等字段隔离。

保持现有 profileRevision 精确匹配：规则改变不会自动召回旧版本案例。未来需要跨版本共享时，另行设计兼容声明、复核和重新审核，不能为了“多项目通用”删掉范围过滤。

场景包决定 requiredSources，生成 Target 对应的 DiagnosticMemoryConfig/端口，不让 Logs 可选场景与 Logs 必需场景共用错误质量门。

向量 V3 继续是独立影子实验；BM25/向量/混合都必须先作用域过滤再排序，不在此增量更改生产召回默认。通用诊断经验的跨项目复用必须经过独立去敏和审核设计，不能直接检索其他项目案例。

## 10. Web 与公共接口

新增独立的安全 Target Catalog DTO，提供 project/environment/target/scenario 的受控展示信息、只读能力和可启动状态；不改变 PublicProfile 现有必填字段，不泄露 endpoint、索引路径、凭据或私有配置。

推荐新路径使用 `/targets` 与 `/targets/:targetId/runs` 等目标作用域入口；全部由一个 Target-scoped application facade 路由到现有命令/查询端口。

列表必须在存储查询和分页之前应用目标归属过滤，不允许先全库分页再在页面上过滤。每个下一页游标固定原目标和查询条件，目标切换必须重置分页及流订阅。

所有访问 Run 的入口都要经过归属判断，包括列表、详情、证据、消息、SSE、用量、取消、恢复、确认以及记忆查看/审核。不得只校验创建 Run。不存在与不属于该 Target 的资源返回统一安全结果，避免利用错误详情探测另一目标。

旧 `/profiles`、`/runs` 等入口保留 legacy simulation 兼容行为；不能成为访问任意新 Target 的无作用域后门。legacy 路由携带新的 Run ID 时也必须拒绝跨范围访问。

前端提供“项目 → 环境/部署 → 场景”选择，报告始终展示所查目标与绑定规则版本。证据页继续只显示摘要、引用、覆盖率和缺失项；不是重新开放原始 ELK 数据。

沿用 V2 事件及 runId/parentRunId 关联，用 Run→绑定关系在安全查询层补展示标签，不给每一种已发布事件强加 projectId。确需新增可见字段时使用明确可选字段或版本化 DTO，并同时更新严格 Schema、Projector 和客户端解析测试。

LangSmith/审计中的父子 Trace 关联与模型用量继续按 Run 收集；目标维度只能使用审核后的安全资源标签，不能为便于定位而上报私有连接信息或完整配置。配置错误和可用性检查同样需要脱敏。

来源重试/熔断/半开/恢复沿用现有事件流；页面通过 Run 归属显示来源标签。离线状态和证据不足必须可见，不能把“数据源暂不可用”显示成“业务失败率为零”。

本地单操作者模式允许切换多个 Target，不代表不同用户之间有隐私隔离；未来多人模式还要在同一门面检查 principal→Target 权限，并对调度、存储、审计进行独立安全验收。

## 11. 兼容、迁移与失败语义

需要记录的契约决策：新的目标/快照契约、完整运行时持久化注入端口、可选 targetBindingId、Checkpoint codec 版本及事务归属存储。旧字段、工具名、V2 语义、SourceSubagentResult 和 ToolResponse 不删除、不重定义。

历史迁移：

- 原有 simulation Run 可通过已确认的 legacy 映射获得目标标签，不重写历史证据。
- 其他旧 Run 仅标为 legacy/unbound，不能根据当下同名 profileId 猜部署、记忆范围或新目标归属。
- 新 Target Run 缺少绑定/快照时 fail closed，不自动回退 legacy。
- 最初提交事务失败不允许执行模型/来源请求；Outbox 投影暂时失败不改变已经持久化的归属事实。
- 原有只读、Dry Run、HITL、工具四道闸门、压缩完整性与动作幂等不因多项目而放宽。

建议固定原因码：TARGET_NOT_FOUND、TARGET_DISABLED、TARGET_BINDING_INVALID、TARGET_SCOPE_MISMATCH、TARGET_SNAPSHOT_UNAVAILABLE、TARGET_GENERATION_CHANGED、SCENARIO_VERSION_UNSUPPORTED、SOURCE_MAPPING_INVALID。按现有 AgentError 的分类承载并只投影经白名单审核的原因码；不能把连接报错或配置原文当公共错误详情。

一般来源失败复用现有超时/重试/熔断标准结果，产出 partial/unavailable 与 missingEvidence；语义/归属校验失败不可重试为另一个目标。不存在来源与运行中不可用是不同状态。

## 12. 逐步落地顺序与依赖

| 增量 | 交付 | 必须依赖 |
| --- | --- | --- |
| M1 身份与配置 | 严格目录、TargetResolver、场景/来源绑定校验、安全目录 DTO、两项目静态样本 | 本 Spec 审核；不调用模型 |
| M2 归属与恢复 | 完整持久化注入、快照和 Run 归属的原子写入、scope 门面、旧 Run 兼容、重启恢复 | M1；先确认 codec/事务迁移测试 |
| M3 场景适配 | window_failure_rate.v1、确定性分析、受控 Prometheus 映射、来源分区/租约、子 Run 继承 | M1+M2；保留旧 settlement 实验 |
| M4 Web 与知识接线 | 目标选择、所有读写入口范围校验、有限知识快照、独立记忆策略和熔断展示 | M2+M3；不新建完整知识库 |
| M5 联合验收 | 两项目并发/故障/恢复/隔离测试、浏览器验收及 legacy 回归 | M1–M4 |

M1/M2 通过后才能在新 Target 发起模型或来源操作；不能先做界面选择，再用单个共享可变配置凑多项目运行。完整 Semantic/Procedural 管理、Counter 场景、真实 group-buy-market 接入、多人 ACL 和真实动作分别另立增量。

## 13. 第一版验收矩阵

使用明确不同的两套模拟数据源或可验证分区、确定性模型桩和可注入时钟。验收不默认调用 DeepSeek/LangSmith。

1. 同一场景、不同指标名/标签能产出同一种版本化事实；一个失败率 4% 时，在阈值 5% 的项目不超限，在阈值 2% 的项目超限。
2. 同名服务和相同统计窗口并发巡检，工具参数、证据、报告、使用量、记忆及 SSE 不串项目。
3. `simulation` 与 `live`、不同 datasetId、不同部署世代和不同 profileRevision 的历史案例不能互相召回。
4. A 来源达到 3 次逻辑失败后打开熔断，冷却内不发来源请求，30 秒后仅一个半开探测；B 保持可查询。同分区不同场景不能绕过熔断。
5. 取消半开请求不会当故障计数；旧请求的迟到成功不关闭新 epoch 的熔断。
6. 主/子 Run、证据页、历史查询和记忆写入具有一致的绑定；禁止给 B 的请求传 A 的 runId/evidenceId/游标/确认 ID。
7. 修改模型 tool arguments 中的 profileId、service、窗口或试图添加 endpoint 不改变宿主绑定；JSON 修复和重试也不绕过校验。
8. 模拟源返回另一项目系列、负数、分母为零、failed>total、过期窗口、错误单位或 Counter 值冒充整数快照时，确定性校验失败/显式不足，不能产生高置信诊断。
9. Run 暂停后更新阈值/映射，重启仍使用原版本；禁用目标、撤销来源或改变部署世代后拒绝继续取证。缺失旧快照不得套用新版本。
10. 初始事务故障、子 Run 首次绑定故障、Outbox 延迟和进程关闭不会留下能执行但无归属的 Run；重复创建请求不产生新 Run；关闭一个租约不关闭其他 Run 依赖的共享持久化/来源。
11. 未审核/过期/撤销知识不注入；知识不能充当观测证据，历史案例也不能使当前缺失来源变成完整。
12. 预算耗尽或单项目大量请求不压垮其他目标；父子调用没有信号量死锁，内存和注册表有界。
13. 现有 simulation 烟测断言、V1 Generator/V2 Publisher 一致性、公共摘要脱敏、父子证据归属、模型用量、Pause/Resume、记忆和熔断测试保持通过。

提交实现前执行仓库既有 lint/typecheck/test/build 与相关浏览器验收，并区分既有失败与新增回归。本次 Markdown 设计只做文档一致性与 diff 检查，不声明上述能力已通过。

## 14. 审核结论需要覆盖的决策

第一版建议确认以下组合：同一宿主/可信操作者、多 Target；Target 绑定优先而不是记忆驱动选项目；同场景声明式映射、新场景经审核代码；单完整持久化所有者；默认只读；先两个模拟项目验收。

如果第一目标改为团队远程共用或每项目独立部署，身份/授权或生命周期边界需要调整，应在生成逐文件实施计划前修订本 Spec，而不是在实现中临时增加隐式全局权限。
