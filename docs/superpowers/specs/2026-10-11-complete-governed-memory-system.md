# 完整受治理记忆系统设计 Spec

日期：2026-10-11。状态：**风险修订版，运行时代码未实施**。依赖多项目基础 R0 安全补强，不把已有 M1/M2a 持久化视为安全恢复已完成。

## 1. 目标与当前实现边界

在已具备的 Target 身份与 Run 绑定基础上，把记忆能力收敛为 Working、Episodic、Semantic、Procedural 四个边界明确的子系统。目标不是把四种记录塞进一个任意文本表，而是让每类记忆有独立事实来源、生命周期、适用范围和可验证的检索契约。

当前代码核对：

| 类型 | 当前能力 | 本 Spec 的变化 |
|---|---|---|
| Working | Run 状态保存在 `AgentContext` / Checkpoint；包括阶段、证据、风险、待办及记忆状态 | 继续以当前 Run 的结构化状态为唯一事实源，不建立第二份可漂移的工作状态库 |
| Episodic | 受治理的历史巡检案例：捕获、审核、撤销、有效期、严格范围 BM25、模型提示和 UI/API | 沿用 `2026-10-10-governed-diagnostic-memory-design.md` 的 R2 规则；不重写其生命周期和已发布契约 |
| Semantic | Target 中已有 `knowledgeRefs` 字段，但当前只保存引用形状，尚未解析到知识记录；没有独立知识记录、审核、查询和管理闭环 | 增加有来源、有版本、可撤销的事实知识库 |
| Procedural | 事件类型允许 `procedural`，但没有模板契约、存储、适用性检查或审核闭环 | 增加只读调查流程模板，不增加执行权限 |
| Vector | 独立实验目前只处理 Episodic 影子索引 | 继续保持实验隔离；不升级为 Semantic/Procedural 默认依赖 |

本文是 Episodic R2 的补充 Spec，重点补 Semantic 与 Procedural，不废止 Episodic R2 的详尽规则，也不修改向量实验 Spec。只有本文获用户评审通过后，才进入后续文件级实施计划；当前不得据此直接改代码。

前置门为 [多项目实施计划](../plans/2026-10-11-multi-project-m1-m2a.md) R0.1–R0.4：历史 Target/来源身份一致性、原快照与当前策略恢复、unknown 首事务 reconciliation 均须通过，再执行本文的知识实现。R0 不要求先完成 M3 真实来源或 M4 完整 Target UI；记忆实现也不得替代这些后续验收。

## 2. 四类记忆的事实权威与依赖

```text
当前 Run 事实和预算       -> Working / AgentContext + Checkpoint
历史已审核案例            -> Episodic / 诊断记忆库
受控的系统事实和定义      -> Semantic / 版本化知识库 + Target 引用
经审核的只读调查方法      -> Procedural / 版本化流程模板
```

冲突时按来源权威处理，不按文本相似度投票：

1. 本次 Run 的有效证据和当前结构化状态决定“现在观测到什么”。
2. Run 绑定的 Profile、Scenario 和确定性规则快照决定指标映射、阈值、窗口、风险级别与动作权限；Semantic 不得覆盖这些字段。
3. 只有 Target 快照明确引用且当前仍有效的 Semantic/Procedural 修订可进入本 Run 的模型视图。
4. Episodic 永远只是历史案例；不得被渲染成当前事实、已验证根因或恢复证明。
5. Procedural 的相似度、批准状态和工具能力引用均不构成执行授权。Guard、Hook、HITL 和 Tool Admission 始终独立生效。

依赖方向：

```text
Harness -> MemoryCoordinator 接口 -> Working / Episodic / Semantic / Procedural ports
bootstrap -> 组装接口实现与 Target 快照引用
SQLite / Profile catalog -> 实现 contracts 定义的存储和解析端口
```

核心不得实例化 SQLite、向量索引、文件系统或具体知识源；长期记忆查询必须先做可信 scope 和引用白名单过滤，再做词法排序与预算裁剪。

## 3. 共同身份、范围和版本规则

Semantic/Procedural 记录包含受严格 Schema 校验的 `id`、`kind`、`scope`、单调递增 `revision`（内容修订号，下称 contentRevision）、`governanceVersion`、`status`、`createdAt`、`validUntil`（可选）、`provenance`、`contentDigest` 和 `schemaVersion`。内容版本与治理状态版本分离；Episodic 保留其已有契约，不因本文强加新必填字段。未经解析的 JSON 不进入核心或模型上下文。

- `Working` 的范围是 `runId`，由 Checkpoint 保存；不进入长期索引。
- `Episodic` 使用现有完整 `MemoryScope`，包括 Profile/revision、服务、故障、Target fingerprint、环境、数据分类及模拟 dataset。
- `Semantic` 与 `Procedural` 记录必须使用宿主生成的完整 scope，并由 Target 快照中的精确引用关联。现有不可变字段 `TargetKnowledgeReference { id, version, digest, approval }` 保持原样，其中 `id` 对应知识 ID、`version` 对应 revision；实现必须按三元组精确解析，不得将其改名或重新解释。自由文本、LLM 参数和浏览器请求不能指定 scope、状态、批准者或可见 Target。
- 匹配使用完整 scope 和精确版本/摘要，不支持隐式通配符、按 Profile 名相似匹配或“同项目自动共享”。跨 Target 复用必须由操作员将知识显式复制/导入到目标 scope，校验来源后形成新 revision 并重新审核。
- Target 快照保持历史可审计性；但审核撤销、过期、来源撤回或 scope 策略撤销要在每次查询和恢复时重新检查。已撤销知识立即停止注入，不因旧 Checkpoint 冻结而继续有效。
- 模拟知识只能在相同模拟 dataset 中使用，永不晋级为 live；真实环境不能读取模拟记忆或知识。
- 缺少可靠 Profile revision、Target fingerprint、来源摘要或时间有效性的知识不发布、不召回。不能从 `process.cwd()`、当前目录或用户问题推断路径/身份。

`TargetKnowledgeReference.version` 始终对应 contentRevision，不对应 governanceVersion。Target 固定的是内容身份，不是永久有效的批准状态；每个修订（包括旧修订）都要有可查询的权威治理状态，不能只检查最新 head。来源另有宿主维护的 sourceEpoch；内容相同但来源撤回、批准撤销或冲突时也要递增治理版本/来源 epoch，使旧审批请求失效。

requiredness 使用独立的宿主 `TargetKnowledgePolicy`，不修改既有 reference 形状或假定 Profile 已经有必需知识字段。该策略按精确 id/version 声明 kind 与 optional/required，并与引用及 publicationVersion 一起冻结到 Snapshot V2；遗漏的旧引用默认为 optional。策略不能由浏览器偏好或 LLM 提供，当前策略只能收紧原 Run 的使用条件，不能扩大旧引用白名单。行为以 §7.1 的开关/失败矩阵为准。

无认证的本地操作员模式继续沿用既有部署边界；本 Spec 不宣称实现多用户 RBAC、租户隔离或公网安全。

## 4. Working 与 Episodic 行为

### 4.1 Working

Working 的真值是 `AgentContext` 和其版本化 Checkpoint。它至少表达：当前阶段、已核实事实及证据 ID、待验证假设、缺失证据、预算、风险结论、待确认/已执行动作、压缩摘要和当前 Run 的 memory selection。跨轮更新必须通过既有 Harness 转移和 Checkpoint 原子边界持久化。

压缩可改变呈现方式，不得丢失证据归属、ToolCall/ToolResult 配对、审批、动作状态、待办和失败限制。Working 不调用向量检索、不从其他 Run 继承未验证事实。恢复后先校验 Checkpoint 与 Target binding，再重建运行态。

### 4.2 Episodic

保持 `2026-10-10-governed-diagnostic-memory-design.md`：自动/手动捕获策略、observation/approved/rejected、人工审核、证据复核、有效期、模拟隔离、失败调查限制、FTS/BM25、模型视图和现有 API/UI 均按该 Spec 执行。Episodic 批准只表示“可在同范围作为历史参考”，不等于 Semantic 事实，不会自动生成 Procedural。

本次后续实现只允许在兼容边界上由统一协调器调用现有 Episodic ports，不改旧 `MemoryFacade` 语义，不把当前向量实验从影子路径接入主 Harness。

## 5. Semantic：受控知识记忆

### 5.1 内容类型和来源

Semantic 表示可追溯的“系统是什么/指标意味着什么”，首批仅支持严格判别联合：

- `service_topology`：服务、依赖关系和有效时间；只保存非敏感稳定资源 ID 与关系，不保存内部凭据或任意网络地址。
- `metric_definition`：名称、业务含义、单位、标签定义、允许的聚合/窗口语义、来源引用。不能改变已绑定 Profile 中的 metric mapping、阈值或确定性计算。
- `domain_glossary`：受控术语与业务实体定义，必须带版本化来源引用。

来源白名单为：Target/Profile 版本化配置、仓库内受控 Runbook/文档清单、或本地操作员提供并审核的结构化知识。任意 URL、搜索结果、日志片段和模型编造内容不得直接成为已批准 Semantic。外部文档必须由宿主受控读取、记录来源 digest 与许可/更新时间；内容大小、字段数、字符串长度均有上限。

模型可以提出 `draft` 候选，不能直接写入 approved 区或主动覆盖 Target 引用。人工创建/编辑也先形成 immutable draft revision，审核通过后才可被 Target 引用。

### 5.2 生命周期

```text
draft -> review_pending -> approved（仅审核通过，未必启用）
            |                 |-> revoked / expired / conflict
            |                 |-> superseded（显式替代发布）
            -> rejected / conflict
approved + 显式启用事务 -> Target active binding（仅供未来 Run）
```

- 一旦建立，revision 的 payload、scope、来源和 digest 不可原地修改；修订生成新 revision。
- `approved` 必须含审核者、审核时间、声明检查结果和当前来源验证结果；内容版本相同不表示审核仍有效。审批同时使用内容/治理版本 CAS、来源 epoch 和幂等 requestId，详见 §5.3。
- 同一 scope/naturalKey 若出现互相矛盾且无法根据权威版本确定的记录，进入 `conflict` 隔离状态，不让模型自行选择；由操作员确认替代/废弃关系。有明确替代关系的新 draft 不因此自动使旧有效版本进入 conflict。
- revoke/supersede/来源撤回与治理状态、FTS 资格失效及独立 knowledge audit outbox 必须一个持久化事务。撤销后立即不可检索；历史内容和状态转移保留审计，不物理覆盖。来源 epoch 可批量阻断相关修订，不依赖异步索引清理完成才停用。
- `validUntil` 到期只停止召回，不删除审计内容；source digest/上游版本变化时停用旧资格，新建修订重新审核，不能原地复活已失效修订。

### 5.3 内容版本、治理 CAS 与来源撤回

| 对象 | 不变量 | 写入/读取规则 |
|---|---|---|
| contentRevision | payload、scope、provenance、digest 不可变 | 修改内容/来源只能建新 draft；Target reference.version 保持此含义 |
| governanceVersion | 每个修订的治理状态单调变化 | review/approve/reject/revoke/conflict/supersede 均检查并递增；旧 revision 也有当前状态 |
| sourceEpoch | 宿主已知的来源有效性版本 | 撤回、digest 失配、许可失效递增；旧 sourceEpoch 的审核或召回不能继续 |
| publicationVersion | Target 启用引用集合版本 | 仅显式发布 CAS 更新；不是内容修订号，也不修改原 Run 的快照 |

审核命令携带 requestId、expectedContentRevision、expectedGovernanceVersion 和待核验 contentDigest；actor/scope/sourceEpoch 从宿主可信端口取得。批准事务必须确认状态仍为 review_pending、内容/来源摘要一致、来源未撤回且未到期，CAS 同时更新治理版本、审核记录、索引资格与 audit outbox。事务外的预检查不够，来源验证结果的 epoch/digest 必须在提交时再比对。

来源撤回与旧 worker 的批准并发时以事务线性化：先撤回则旧批准 CAS 失败；先批准则随后的撤回立即使该修订不可用。相同 requestId/命令摘要重放只返回原收据及当前有效状态，不重新应用转换；摘要不同返回固定冲突码，不能把过去 approved 的收据当成现在仍 approved 的证明。对 revoked/superseded/rejected/expired/conflict 不允许原地重新 approve；处理原因后建立新修订并重新审核。

有效期按注入的时钟在查询、批准、发布和模型呈现前判断；不依赖后台清理及时运行。到期状态可惰性物化，但检查到期后不得继续使用。对来源撤回的“立即”指宿主已经获知并提交撤回的线性化点，不能宣称尚未接入的远端变化已实时检测。

### 5.4 审批与 Target 启用发布是两件事

审核 K/r2 不改变 Target 当前 K/r1 的引用或批准状态；r2 是已批准但尚未启用的修订。禁止“approve 自动 supersede r1”，否则会出现 r1 已失效、r2 又不在引用白名单中的真空。

新增小接口 `TargetKnowledgeBindingPublisher.publish`，只发布知识引用/使用策略，不接收 endpoint、服务映射、阈值、工具白名单或任意 Catalog 配置。操作员显式选择 Target 和精确修订；宿主检查当前 Target/Profile scope、内容/治理版本、来源 epoch、有效期和 expectedPublicationVersion。成功事务原子写入新的启用引用集合、publicationVersion、必要的旧修订 superseded 状态、FTS 资格与治理审计；失败全部回滚，原可用绑定不变。

为避免声称 JSON 文件与 SQLite 能跨介质原子提交，当前启用指针由同库 `target_knowledge_bindings` 及发布历史拥有，作为宿主 Catalog 的受控知识覆盖层。本地 Catalog 只提供初始候选，不能在重启时覆盖已发布指针；导入也走同一显式命令。Target Resolver 读取一个一致的已发布版本并冻结其引用/策略，不在首次绑定提交时切换到另一个 publicationVersion。与 Profile/scope 变化竞态时 CAS 失败并重新解析，不静默跨版本使用。

启用新知识本身不改 profileRevision，除非诊断权威规则/兼容边界也变了；后者必须走独立 Target/规则发布，并在新 scope 下重新导入审核知识。发布只改变未来 Run 的引用；旧 Run 保留原引用，不自动升级。若发布明确替代并 supersede r1，旧 Run 的 r1 按 §7.1 不再注入并展示限制。安全撤销可随时独立执行，不能为了保持可用性继续使用已撤销内容。

Semantic/Procedural 共用此流程。第一版不提供撤销回退为旧 revision 的“一键回滚”：要启用替代版本，仍须校验它当前有效，并执行新的发布 CAS/审计；历史快照可只读，但不能复活撤销状态。

## 6. Procedural：审核后的只读调查模板

Procedural 表示“如何调查”，不是事实库或自动化脚本。每个模板至少包括：

- `templateId` / revision / digest、精确 scope、适用场景 ID+版本、适用服务/故障类型/环境。
- 明确前置条件、所需证据类别与覆盖要求、按序编号的调查步骤、每步完成标准、停止条件、预期报告结构、已知限制与来源。
- 步骤可以引用宿主登记的只读 capability ID（例如某类指标/日志查询），但不得包含 MCP URL、任意 Tool JSON、Shell/SQL/HTTP 语句、凭据或可执行代码。

模板由版本化 Profile/Runbook 导入或人工撰写形成 draft；模型从历史成功案例提出的只能是 draft suggestion。由操作员检查来源、适用条件、漏项和风险后审核。单纯建立新 draft 不撤销仍有效的旧修订；已知内容不安全、scope/Scenario 不兼容或来源失效则立即停用原批准，新 revision 重新审核并显式发布。审批/发布沿用 §5.3–§5.4 的 CAS 和事务，不建立第二套较宽松流程。

召回时先用确定性场景、Target、服务、故障和环境条件过滤；词法相似度只用于同一适用集合内排序。模板只提供调查建议：不得跳过 Profile 必需证据、数据源状态检查、四轮 Tool Admission、Loop Guard、人工确认或执行后验证；不得调用工具、改变风险等级、生成授权或降低证据门槛。最终工具仍由 Agent 正常生成并经过统一执行管线。

## 7. 统一检索、预算和降级

新增独立 `MemoryCoordinator` / `MemoryRetrievalRequest` 小接口；不将四类记忆绑成一个巨大门面。每次请求由宿主提供可信 Target snapshot、当前 Run scope/stage、允许类型、模型剩余 token、deadline 和 excludeRunIds。

1. Working 从当前 Context 读取，不查询长期库。
2. Episodic 沿用现有明确开关、过滤和 revalidate。
3. Semantic/Procedural 仅读取 Target snapshot 引用中的精确 revision/digest 且当前仍 approved、未过期、scope 相同、来源未撤回的记录。
4. 所有类型先执行确定性资格与范围过滤，再对候选执行 FTS/BM25 或固定词法排序，随后稳定 tie-break、证据/来源复核和按类型预算裁剪。
5. 每类 `limit`、总条数、文本字节和 token 预算均有硬上限；任一类型不可用不得导致全库扫描或扩大到其他 scope。

注入模型视图时以显式区块标记类型和来源：Semantic 是“受控参考定义”，Procedural 是“建议调查清单”，Episodic 是“历史案例”；均不是当前 Run 证据。历史/知识引用不能加入本轮 `evidenceIds` 或生成 `EVIDENCE_COLLECTED`。对阈值/指标映射冲突优先采用绑定快照，并返回知识冲突状态而不是覆盖它。

单个可选类型失败采用 omit-knowledge，保留 Working、合法 Episodic 和其他可用类型；全部长期读取失败才使用既有 `working_only` 事件语义。必需知识不足由确定性诊断资格门记录 `missingKnowledge`/limitations 并限制结论，不把知识 ID 塞进观测 evidenceIds、证据 coverage 或伪造 EVIDENCE_COLLECTED。Abort 传播；不会静默伪造空成功。全阶段保持既有 AsyncGenerator/V2 事件主契约。

### 7.1 Feature flags、必需性与失败矩阵（R4）

两类 feature flag 是宿主提供该能力的开关，不是逐 Run 授权开关；用户偏好只能拒绝可选召回，不能打开关闭的能力或取消必需项。TargetKnowledgePolicy 是 requiredness 的唯一来源。

| 能力开关/引用状态 | optional | required |
|---|---|---|
| 该类型关闭 | 不查询、不注入；目录声明能力关闭，Target 仍可启动 | 新 Run 配置错误 `KNOWLEDGE_REQUIRED_DISABLED`，对应 Target 不可启动；不影响其他 Target |
| 开启，精确版本/scope/digest/sourceEpoch 有效且 approved | 在预算内注入，记录安全引用 | 在预算内保留必需引用；仍不构成当前证据或授权 |
| 开启，缺失/未批准/撤回/到期/superseded/conflict | 拒绝使用该知识，Target 可启动/继续；记录 unavailable 原因 | 可只读取证，但 diagnosisReady=false、显示 missingKnowledge；禁止健康/已验证根因等依赖该知识的完整结论 |
| 开启，知识存储暂时失败/检索 deadline/预算不足 | omit 该类型，显式降级，不全库搜索或重跑付费模型 | 与必需知识缺失相同，不以空数组包装成功或隐藏限制 |
| 知识记录 scope、内容 digest 或 provenance 来源身份校验失败 | 拒绝并隔离该引用、产生安全审计；其他合法知识/Target 不扩大权限 | 同样拒绝/隔离，并触发必需知识限制；不能拿其他 Target/最新修订替代 |
| 上游 signal Abort | 立即传播，不继续召回或生成结论 | 同左 |

运行中关闭必需类型/撤销知识不能靠重启恢复绕过：旧 Run 可保留历史/观测摘要，但降为上述 partial/limited 行为；不要把开关变更伪装成配置好的完整诊断。配置 envelope、重复冲突引用或策略版本无法解析仍属于 Target 配置错误，与“可选知识运行时不可用”不同。

该降级矩阵只处理知识资格；Target Snapshot/Run 归属被篡改或执行来源身份越界仍由 R0 阻断整个执行，不能被 optional 知识规则放行。`KnowledgeDiagnosisQualificationV1` 独立表达 diagnosisReady、缺失的安全知识引用及固定限制原因；通过版本化/可选诊断读模型呈现，不改旧 ToolResponse 或 V2 必填字段。资格不足时由确定性报告门限制完整 verdict/根因声明，不能仅让模型自由文本自觉降置信度。

必需性的满足与注入预算分开：预算不足以安全呈现必需知识时显式限制，不悄悄裁掉后继续宣称完整。知识视图每轮在 Pre-reasoning 重建，发起模型请求及提交最终诊断资格前复核治理版本/sourceEpoch；Checkpoint/L2 不永久保存知识全文或 approved 布尔值作为授权。撤销后的下一轮/恢复不得沿用缓存视图；请求已发送时不能收回模型已读内容，但未提交结论不得继续依赖失效必需知识。已经完成的历史诊断保留原审计，不倒改为当前证据。

向量只允许继续作为受限、可丢弃的 shadow index。未经单独真实语料评估、资源验收和新设计决策，不得成为 Semantic/Procedural 生产检索的必需后端。

## 8. 持久化、事件和 API/UI

### 8.1 持久化

先完成 R0 的 v6→v7，再追加知识 v8，不改写 v1–v7；迁移前保留备份和能力预检。建议同库建立：

| 表 | 职责 |
|---|---|
| `diagnostic_knowledge_items` | 按 `(kind, scope_key, natural_key)` 做唯一性/冲突管理，不作为旧 revision 治理状态的替代 |
| `diagnostic_knowledge_revisions` | append-only 内容、scope、来源和 digest；禁止审核时覆盖 JSON |
| `diagnostic_knowledge_revision_states` / `diagnostic_knowledge_sources` | 每个修订的权威治理版本/状态、来源 epoch 和有效性；旧引用也查询这些表 |
| `diagnostic_knowledge_reviews` | requestId + 命令摘要的幂等收据、双版本 CAS、宿主操作者和审核声明 |
| `target_knowledge_bindings` / `diagnostic_knowledge_publications` | Target 当前启用指针与 append-only 发布历史；expectedPublicationVersion CAS |
| `diagnostic_knowledge_fts` | 只索引有资格的有限文本；查询仍 join 当前状态、来源和有效期，过期索引不能放行 |
| `diagnostic_knowledge_audits` / `diagnostic_knowledge_outbox` | append-only 治理审计和事务投递；采用独立版本契约，不冒充 Run V2 event |

FTS 建索引和检索都要先约束 kind、scopeKey、Target 引用与状态；Schema/数据库能力不符合时迁移 fail-closed，旧版运行路径不得被部分迁移改变。

### 8.2 事件

实际 Run 的检索可复用既有 `MEMORY_RETRIEVAL_STARTED/COMPLETED/FAILED`。既有 UPDATE_SCHEDULED 必须有真实 sourceRunId，UPDATE_COMPLETED 只能表达 observation/approved/rejected；没有 Run 的知识导入以及 revoked/superseded/published 不能伪造 Run ID、借用这些状态或静默丢弃审计。

在 T1、任何 T2 持久化之前冻结独立 `KnowledgeGovernanceAuditV1` 契约和严格 parser。公共 envelope 为 schemaVersion、auditId、requestId/commandDigest、宿主 actorId 和注入时间；payload 是判别联合：

- `knowledge_transition`：knowledgeId/kind/contentRevision、governanceVersion、before/afterStatus、targetId/scopeKey 和来源有效性版本。
- `source_transition`：受控 sourceId/数据域身份、before/afterSourceEpoch、有效性及固定原因码；不伪造不存在的 knowledgeId。
- `binding_publication`：targetId/scopeKey、before/afterPublicationVersion、Target policy 版本及有界安全引用摘要；不伪造内容状态转换。

命令类型与关联版本按各分支严格校验，真实关联 Run ID 为可选且必须核实。只记录安全 ID、摘要与状态，不保存全文、提示词、检索词、地址、secretRef 或原始证据。源审计的 API 可见范围由宿主来源归属解析，不暴露另一 Target 的关联记录。

治理命令、状态/索引/绑定变更与 audit/outbox 原子落库；一个宿主所有者运行有界 dispatcher，以 auditId 幂等投递，重启可回放，失败不丢记录也不重复应用命令。独立 outbox 不修改现有只接受 Run V2 事件的 durable_event_outbox；不把审核事件当命令总线。前端读取经 Target 范围过滤的安全审计 DTO；未经独立契约决策不将其广播成公共 Run SSE 或上报 LangSmith。

### 8.3 API 与页面

沿用一个 Agent Web Memory 区域，按“案例 / 系统知识 / 调查模板”分区，不建新前端应用。新增受控查询和命令端点：

- 查询能力和按当前 Target/类型分页列出 Semantic/Procedural，详情显示 revision、来源、适用范围、审核者、有效期、引用。
- 本地操作员可提交新建/修订草稿、审核批准/拒绝、撤销，以及独立的“启用到此 Target”发布命令；请求只传允许内容、精确引用和幂等/CAS 字段，scope、actorId、当前 Target 身份由服务端推导。不得通过该端点改阈值、连接或工具权限。
- 返回 DTO 不含源文件绝对路径、内网地址、密钥、原始数据、完整证据或未授权 scope。
- 页面明确区分“事实定义”“历史案例”“建议流程”及“已审核/已启用”；显示内容修订、治理版本和发布版本。Procedural 页面不能执行模板；来源变更、冲突、到期、撤销和越界都可见且使用固定状态码。旧 Run 的失效引用显示限制，不替换成最新条目。

本地单操作员 API 不能直接暴露公网；多人协作/生产权限管理需另外设计认证、RBAC、审计归属及 CSRF 防护。

## 9. 契约兼容与迁移

- 已发布 `MemoryFacade`、Episodic `DiagnosticMemoryCase`、事件、消息块、ToolResponse 和旧 API 字段不删改、不重解释。
- 新增可选能力字段/API 或独立新类型；不把 `MemoryCapabilities.kind: 'episodic'` 原地改为多值。若要统一能力发现，新增 `availableKinds` 可选字段或版本化 DTO。
- `AgentContext` 已有字段保持原语义。新知识引用快照以可选、版本化结构添加；旧 Checkpoint 无新字段时仍按原路径读取，不推断 Target/Knowledge binding。
- R0 使用 schema v7；本计划 v8 只追加知识表/索引，不重写 v5 Memory、v6 Target 或 v7 R0 migration。测试 v6→v7→v8、v7→v8、失败回滚/重开和旧 Checkpoint 读取；不得跳过未完成 R0。若版本被其他工作占用，先同步两份计划，不就地覆盖。
- Feature flags 按类型独立，Semantic/Procedural 缺省关闭；部署可以一次开启受控来源，但每次 Run 不要求开发人员手工改环境变量。权限与召回偏好分离：用户偏好不能授予管理员权限。

## 10. 验收门槛

1. Working 与 Checkpoint 的重启、压缩、HITL/动作完整性测试通过；无第二事实源。
2. Episodic 原有 R2 捕获/审核/召回/模拟隔离回归不退化，向量仍为 shadow-only。
3. Semantic Schema、来源允许名单、版本不可变、审批 CAS/幂等、冲突隔离、来源撤回/过期即时停用、revocation 后重启不召回测试通过。
4. Procedural 适用条件负向矩阵、required evidence 保持、只读声明、无法直接执行、无工具授权提升、HITL 不绕过测试通过。
5. 多 Target/项目、Profile revision、environment、dataClass、dataset、服务、faultType 与 knowledgeRef 交叉隔离测试通过；跨 Target 复制必须新审。
6. 检索先过滤后排序；范围外内容不出现在结果、分数统计、模型上下文、审计或 API 中；Abort 与 deadline 行为正确。
7. 存储迁移、事务回滚、并发 CAS、重启、outbox、相同/冲突 requestId 全部有 SQLite 和 InMemory 契约测试。
8. 前端创建草稿、审核、修订、撤销、冲突、过期和 Run 引用展示通过；服务关闭不影响旧巡检路径。
9. 全仓 `lint`、`typecheck`、`test`、`build` 通过，或明确标出独立于本 Spec 的既存阻塞。
10. 完整验证 §7.1 的类型开关 × optional/required × 有效/缺失/撤回/到期/篡改/超时/预算矩阵。关闭可选知识不阻断 Target；关闭必需能力不能接受新 Run；必需缺失不能输出完整健康/根因结论。
11. approve r2 但未启用时 r1 仍可用；启用 CAS 成功后未来 Run 固定 r2，旧 Run 不升级。启用失败回滚、发布/撤销/Target 规则更新竞态、重启不会被 Catalog 初始值覆盖。
12. 内容未变时撤销/来源撤回也递增治理版本/epoch；迟到批准、旧请求重放和旧 head 不得复活失效修订。注入时钟到期，无后台任务仍立即停止使用。
13. 无 sourceRunId 的本地知识导入也有事务审计；revoked/superseded/published 保留真实状态。outbox 失败、重复投递、重启回放及旧 V2 fixtures 均验证，不伪造关联 Run 或重解释旧事件。

## 11. 风险修订与计划对应

| 风险 | 收口决策 | 实施归属 |
|---|---|---|
| R1 历史身份漂移 | 前置历史身份账本/来源身份/Snapshot V2 | 多项目 R0.1 |
| R2 恢复未校验当前权限 | 前置 recovery/operation gate；知识每轮重建 | R0.3 + T5 |
| R3 首提交 unknown 被当 absent | 前置三态 reconciliation/claim fencing | R0.2 |
| R4 optional/required 与开关冲突 | §3 host-only policy + §7.1 完整矩阵 | T1、T3、T5、T7 |
| R5 审批到引用启用没有闭环 | §5.4 独立发布及同库启用指针 | T2、T4b、T6、T7 |
| R6 内容 revision 无法防治理竞态 | §5.3 双版本 CAS、sourceEpoch、逐修订状态 | T1–T4、T7 |
| R7 先写存储后决定审计事件 | §8.2 T1 独立治理审计契约先冻结 | T1→T2、T7 |

风险已在文档中指定处理方式；这不是运行时代码修复或测试通过记录。

### 明确不作为通过条件的声明

本 Spec 实施本身不证明根因诊断准确率提升、不证明知识来源完整、不授权自动动作、不等于生产多租户安全、不代表真实业务系统已接入，也不表示向量检索可用。
