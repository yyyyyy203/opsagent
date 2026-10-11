# 完整受治理记忆系统设计 Spec

日期：2026-10-11。状态：**待评审，未实施**。

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

长期记录都包含受严格 Schema 校验的 `id`、`kind`、`scope`、单调递增 `revision`、`status`、`createdAt`、`validUntil`（可选）、`provenance`、`contentDigest` 和 `schemaVersion`。未经解析的 JSON 不进入核心或模型上下文。

- `Working` 的范围是 `runId`，由 Checkpoint 保存；不进入长期索引。
- `Episodic` 使用现有完整 `MemoryScope`，包括 Profile/revision、服务、故障、Target fingerprint、环境、数据分类及模拟 dataset。
- `Semantic` 与 `Procedural` 记录必须使用宿主生成的完整 scope，并由 Target 快照中的精确引用关联。现有不可变字段 `TargetKnowledgeReference { id, version, digest, approval }` 保持原样，其中 `id` 对应知识 ID、`version` 对应 revision；实现必须按三元组精确解析，不得将其改名或重新解释。自由文本、LLM 参数和浏览器请求不能指定 scope、状态、批准者或可见 Target。
- 匹配使用完整 scope 和精确版本/摘要，不支持隐式通配符、按 Profile 名相似匹配或“同项目自动共享”。跨 Target 复用必须由操作员将知识显式复制/导入到目标 scope，校验来源后形成新 revision 并重新审核。
- Target 快照保持历史可审计性；但审核撤销、过期、来源撤回或 scope 策略撤销要在每次查询和恢复时重新检查。已撤销知识立即停止注入，不因旧 Checkpoint 冻结而继续有效。
- 模拟知识只能在相同模拟 dataset 中使用，永不晋级为 live；真实环境不能读取模拟记忆或知识。
- 缺少可靠 Profile revision、Target fingerprint、来源摘要或时间有效性的知识不发布、不召回。不能从 `process.cwd()`、当前目录或用户问题推断路径/身份。

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
draft -> review_pending -> approved -> superseded
                  |             |-> revoked
                  |             |-> expired（时间/来源失效）
                  -> rejected
```

- 一旦建立，revision 的 payload、scope、来源和 digest 不可原地修改；修订生成新 revision。
- `approved` 必须含审核者、审核时间、声明检查结果和当前来源验证结果；审批使用 `expectedRevision` CAS 与幂等 `requestId`。
- 同一 scope/naturalKey 若出现互相矛盾且无法根据权威版本确定的记录，进入 `conflict` 隔离状态，不让模型自行选择；由操作员确认替代/废弃关系。
- revoke/supersede/来源撤回与 FTS 索引更新及 audit outbox 必须一个持久化事务。撤销后立即不可检索；历史 revision 保留审计，不物理覆盖。
- `validUntil` 到期只停止召回，不删除审计内容；source digest/上游版本变化时必须重新审核或重新确认。

## 6. Procedural：审核后的只读调查模板

Procedural 表示“如何调查”，不是事实库或自动化脚本。每个模板至少包括：

- `templateId` / revision / digest、精确 scope、适用场景 ID+版本、适用服务/故障类型/环境。
- 明确前置条件、所需证据类别与覆盖要求、按序编号的调查步骤、每步完成标准、停止条件、预期报告结构、已知限制与来源。
- 步骤可以引用宿主登记的只读 capability ID（例如某类指标/日志查询），但不得包含 MCP URL、任意 Tool JSON、Shell/SQL/HTTP 语句、凭据或可执行代码。

模板由版本化 Profile/Runbook 导入或人工撰写形成 draft；模型从历史成功案例提出的只能是 draft suggestion。由操作员检查来源、适用条件、漏项和风险后审核。内容修订、scope 变化、Scenario 不兼容或来源失效均撤销原批准并要求新 revision 审核。

召回时先用确定性场景、Target、服务、故障和环境条件过滤；词法相似度只用于同一适用集合内排序。模板只提供调查建议：不得跳过 Profile 必需证据、数据源状态检查、四轮 Tool Admission、Loop Guard、人工确认或执行后验证；不得调用工具、改变风险等级、生成授权或降低证据门槛。最终工具仍由 Agent 正常生成并经过统一执行管线。

## 7. 统一检索、预算和降级

新增独立 `MemoryCoordinator` / `MemoryRetrievalRequest` 小接口；不将四类记忆绑成一个巨大门面。每次请求由宿主提供可信 Target snapshot、当前 Run scope/stage、允许类型、模型剩余 token、deadline 和 excludeRunIds。

1. Working 从当前 Context 读取，不查询长期库。
2. Episodic 沿用现有明确开关、过滤和 revalidate。
3. Semantic/Procedural 仅读取 Target snapshot 引用中的精确 revision/digest 且当前仍 approved、未过期、scope 相同、来源未撤回的记录。
4. 所有类型先执行确定性资格与范围过滤，再对候选执行 FTS/BM25 或固定词法排序，随后稳定 tie-break、证据/来源复核和按类型预算裁剪。
5. 每类 `limit`、总条数、文本字节和 token 预算均有硬上限；任一类型不可用不得导致全库扫描或扩大到其他 scope。

注入模型视图时以显式区块标记类型和来源：Semantic 是“受控参考定义”，Procedural 是“建议调查清单”，Episodic 是“历史案例”；均不是当前 Run 证据。历史/知识引用不能加入本轮 `evidenceIds` 或生成 `EVIDENCE_COLLECTED`。对阈值/指标映射冲突优先采用绑定快照，并返回知识冲突状态而不是覆盖它。

知识检索失败默认 `working_only` / omit-knownledge：记录安全的固定原因码，当前 Run 仍可使用自身证据继续；若 Profile 声明某知识为必需，则把缺失加入 `missingEvidence`/诊断限制，但不把“检索失败”包装成事实。Abort 传播；不会静默伪造空成功。全阶段保持既有 AsyncGenerator/V2 事件主契约。

向量只允许继续作为受限、可丢弃的 shadow index。未经单独真实语料评估、资源验收和新设计决策，不得成为 Semantic/Procedural 生产检索的必需后端。

## 8. 持久化、事件和 API/UI

### 8.1 持久化

在当前 SQLite schema v6 后追加迁移，不改写 v1-v6；迁移前保留备份和能力预检。建议同库建立：

| 表 | 职责 |
|---|---|
| `diagnostic_knowledge_items` | Semantic/Procedural 当前读模型，按 `(kind, scope_key, natural_key)` 做受控唯一性与状态约束 |
| `diagnostic_knowledge_revisions` | append-only 的版本化记录 JSON、摘要/校验和、来源和状态快照 |
| `diagnostic_knowledge_reviews` | requestId 幂等结果、CAS revision、操作者、审核声明和审核时间 |
| `diagnostic_knowledge_fts` | 仅索引当前批准且未过期的有限文本，随审批/撤销事务更新 |
| `diagnostic_knowledge_outbox` 或既有 V2 durable outbox | 在同一事务记录审核/更新通知，优先复用已有 outbox |

FTS 建索引和检索都要先约束 kind、scopeKey、Target 引用与状态；Schema/数据库能力不符合时迁移 fail-closed，旧版运行路径不得被部分迁移改变。

### 8.2 事件

使用既有 `MEMORY_RETRIEVAL_STARTED/COMPLETED/FAILED`、`MEMORY_UPDATE_SCHEDULED/COMPLETED/FAILED`；更新候选的 `candidateType` 区分 `semantic` / `procedural`。禁止把知识全文、检索文本、端点、证据原文或未审核内容写入 public event、SSE、LangSmith。审核与撤销是显式 API 命令，不把 Event 当命令总线。不改变已发布事件 schema；如果确需更细事件，先独立 schema-version 决策。

### 8.3 API 与页面

沿用一个 Agent Web Memory 区域，按“案例 / 系统知识 / 调查模板”分区，不建新前端应用。新增受控查询和命令端点：

- 查询能力和按当前 Target/类型分页列出 Semantic/Procedural，详情显示 revision、来源、适用范围、审核者、有效期、引用。
- 本地操作员可提交新建/修订草稿、审核批准/拒绝、撤销/替代；请求只传内容和幂等/CAS 字段，scope、actorId、当前 Target binding 由服务端推导。
- 返回 DTO 不含源文件绝对路径、内网地址、密钥、原始数据、完整证据或未授权 scope。
- 页面明确区分“事实定义”“历史案例”“建议流程”；Procedural 页面显示只读声明并不能执行模板。来源变更、冲突、到期、撤销和越界都可见且使用固定状态码。

本地单操作员 API 不能直接暴露公网；多人协作/生产权限管理需另外设计认证、RBAC、审计归属及 CSRF 防护。

## 9. 契约兼容与迁移

- 已发布 `MemoryFacade`、Episodic `DiagnosticMemoryCase`、事件、消息块、ToolResponse 和旧 API 字段不删改、不重解释。
- 新增可选能力字段/API 或独立新类型；不把 `MemoryCapabilities.kind: 'episodic'` 原地改为多值。若要统一能力发现，新增 `availableKinds` 可选字段或版本化 DTO。
- `AgentContext` 已有字段保持原语义。新知识引用快照以可选、版本化结构添加；旧 Checkpoint 无新字段时仍按原路径读取，不推断 Target/Knowledge binding。
- schema v7 只追加表/索引；不得重写用户已有 v5 Memory migration 或 v6 Target migration。之前数据库的 v6→v7 upgrade、失败回滚、重开、旧 checkpoint 读取均需测试。
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

### 明确不作为通过条件的声明

本 Spec 实施本身不证明根因诊断准确率提升、不证明知识来源完整、不授权自动动作、不等于生产多租户安全、不代表真实业务系统已接入，也不表示向量检索可用。
