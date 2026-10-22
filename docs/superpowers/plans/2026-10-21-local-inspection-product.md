# 本地多项目只读巡检系统实施计划

- 日期：2026-10-21（Asia/Shanghai）
- 依据：[Spec 与 L01–L14](../specs/2026-10-21-local-inspection-product-design.md)
- 状态：S1 本地实现与 L01–L03 验收通过；S2 完成（S2.1/S2.2 正向召回、撤销/到期/禁用/跨 scope、拒绝、来源吊销、必需知识门禁均通过普通 Target 宿主组合验收；存储失败/超时/Abort/预算按 Spec §4.2 保持协调器层覆盖）；L04–L05 通过；S3–S6 待实施。远端同步以 STATUS 最新 Git 核对为准。
- 分类：bootstrap/应用编排/适配器/API-Web/基础设施；不改变 Harness 顺序或真实动作边界。

## 1. 顺序与工作量

| 阶段 | 交付 | 前置 | 粗估有效开发工时 |
| --- | --- | --- | --- |
| S0 | 基线、既有提交同步、方案及验证清单 | 无 | 0.5–1 天 |
| S1 | 普通服务的多 Target 双来源运行 | S0 | 3–5 天 |
| S2 | 三类记忆与治理接线 | S1 | 3–5 天 |
| S3 | 五族场景、离线质量集与在线验收工具 | S1；记忆对照依赖 S2 | 4–7 天 |
| S4 | 持久化周期巡检 | S1、调度契约决定 | 4–6 天 |
| S5 | 站内通知、处理状态、复查与导出 | S4、结果契约决定 | 3–5 天 |
| S6 | 统一启动、恢复/留存、持续运行与发布 | 前述离线阶段 | 4–7 天，另加 24 小时实测 |

合计约 21.5–36 天有效开发工时，仅为范围估算，不承诺日历交付日期；包含实现与回归，不含在线凭据等待、网络阻塞和独立的对外部署项目。S3 在线验证受阻时，可继续 S4–S6 离线工作，但最终仅能标“工程闭环通过”。每个阶段再按表中职责拆小提交，不把整份计划当一个大提交。

## 2. 通用执行与质量门

1. 开始时读取 AGENTS/PROJECT/STATUS/相关 DECISIONS，检查分支、工作区、远端差异和当前接口。保留他人修改。
2. 下表标“拟新增”的路径是目标位置；若仓库已有等价模块，复用并在计划说明调整，不机械新建重复抽象。修改新模块时补公开入口及严格类型。
3. 新公共契约、调度持久化、结果状态及清理/恢复规则先写详细决策并在 DECISIONS 登记，再改代码。保持旧协议和 simulation 默认行为。
4. 先用小范围确定性测试定位行为，再运行当阶段完整质量门：

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm web:typecheck
pnpm web:build
git diff --check
```

macOS 若命中已知临时目录符号链接限制，可用 `TMPDIR=/private/tmp pnpm test` 并记录原因；不得把变通运行写成原命令通过。Node 24、pnpm 11.19.0 为声明基线；实际版本不一致要记录。端口受沙箱限制时按工具权限流程执行，不能跳过后声称通过。

5. 有关 Target/记忆的阶段增加既有 `pnpm e2e:multi-target`、`pnpm e2e:memory:multisource`、`pnpm acceptance:memory`。新增命令在首次建立时登记；后文拟新增命令不是当前已可运行的命令。
6. 每阶段更新 STATUS 与验收记录：本次执行命令、结果、未执行项、实际版本、相关未提交文件和下一步。先满足验收再标阶段完成，只提交本任务文件并普通 push，核对远端 HEAD；网络/冲突阻塞单列，不强推。

## 3. S0：基线与交付收尾

- [x] 重新检查 `bdfb20e` 之后变化，核对前轮多来源韧性通过记录，不重复实现已完成项目。
- [ ] 核对 `origin` 与当前分支，查询远端 SHA；本次 `git ls-remote` 先报 `Could not resolve host: github.com`，再次读取远端时连接持续挂起并中止，待网络恢复后核对与普通推送。
- [x] 为本计划建立 `docs/verification/2026-10-22-local-inspection-product-acceptance.md`；L01–L03 有本轮证据，L04–L14 保持 not_run。
- [x] 确认双模拟 Target、来源端口/数据目录、离线与在线模型模式的配置样例范围。

退出：本地基线、模拟配置与验收目录已核对；远端 SHA 和推送仍是交付待办。网络阻塞不妨碍独立本地实现，但不能据此宣称同步完成。

## 4. S1：普通宿主与 Target 双来源

| 文件 | 任务 |
| --- | --- |
| `src/bootstrap/local-target-runtime.ts`（已新增） | 读取绝对配置文件，校验 Target/Profile/来源绑定；仅接受 simulated、只读 Profile 和 loopback HTTP 来源，拒绝 URL 凭据与查询参数 |
| `src/profiles/target-catalog-schema.ts`、`src/profiles/target-resolver.ts` | 复用现有解析；仅为接线实际缺口做兼容扩展，不重新发明 Target Schema |
| `src/bootstrap/agent-web-runtime.ts`、`src/application/create-runtime.ts`、`src/bootstrap/index.ts`、`apps/agent-server/index.mjs` | 接入 `AGENTOPS_TARGET_CONFIG`，在普通宿主组装同一 persistence 下的 Target Resolver、OperationPolicy、RuntimeProvider、Starter 和恢复门；保留 legacy simulation |
| `src/bootstrap/target-metrics-subagent.ts`、`src/bootstrap/logs-web-source.ts`、`src/bootstrap/lazy-elk-evidence-source.ts`、`src/bootstrap/log-evidence-tools.ts`、`src/infrastructure/elk/paged-evidence-source.ts` | Metrics 使用冻结 300 秒窗口；Logs 分页/快照按 Target source partition 执行并重校验来源许可 |
| `examples/local-inspection-targets.json`、`docs/guides/local-target-inspection.md` | 两个共享合成数据集的模拟 Target，阈值分别为 5%/2%；记录本地模拟器、宿主与工作台启动步骤 |
| `src/bootstrap/local-target-simulator.ts`、`src/infrastructure/simulator/target-prometheus-server.ts`、`apps/local-target-simulator/index.mjs` | 提供动态窗口的 loopback Prometheus API、同窗口 Logs MCP 和 legacy Metrics MCP；新增 `pnpm local:target-lab` |
| `apps/agent-web/src/components/EvidencePanel.tsx`、`TaskComposer.tsx`、`src/state/run-view.ts` | 显示确定性阈值 assessment；修正分页请求超过 API 上限及异步提交清空后续输入的竞态 |
| `test/local-target-runtime.test.ts`、`test/local-target-runtime-host.test.ts`、`test/local-target-simulator.test.ts` | 配置边界、普通 agent-server 进程入口、双来源/阈值、主动取消、配置重启后的历史快照和隔离 |
| `test/e2e/local-inspection-fixture-server.mjs`、`test/e2e/local-inspection-web.spec.ts`、`playwright.local-inspection.config.ts` | 浏览器经正式 Target bootstrap 访问本地来源；ScriptedModel 仅由专用测试入口注入 |

- [x] 配置校验和普通 `apps/agent-server` 进程组装通过；legacy simulation 浏览器路径仍可用。
- [x] A/B 双来源巡检、确定性阈值、证据回查、活动 Run 取消/Abort、跨 Target 读写/证据拒绝、重启后历史快照和新配置生效通过。
- [x] 测试经正式 Resolver、OperationPolicy、RuntimeProvider 和实际 loopback Metrics/Logs 服务运行；ScriptedModel 只从专用测试入口注入。
- [x] 完整质量门及既有双 Target/多来源 E2E 通过，结果见[验收记录](../../verification/2026-10-22-local-inspection-product-acceptance.md)。

退出：L01–L03 通过。S1 本地实现验收完成并已有独立本地提交；GitHub 远端核对/推送仍待网络恢复，不代表远端已同步。

## 5. S2：记忆治理和模型输入

| 文件 | 任务 |
| --- | --- |
| `src/contracts/diagnostic-memory.ts`、`src/application/create-runtime.ts` | 以可选、向后兼容的 late-bound port 将同一 SQLite governed knowledge store 注入记忆组装；不新增数据库所有者或表 |
| `src/bootstrap/diagnostic-memory.ts`、`src/bootstrap/inspection-runtime.ts`、`src/bootstrap/agent-web-runtime.ts`、`src/bootstrap/memory-policy.ts` | S2.1 已完成：当宿主提供治理端口且 Episodic memory 启用时组装 `MemoryCoordinator`，共享 Episodic 召回端口；缺少配置保持旧的 Episodic-only/关闭行为 |
| `src/bootstrap/local-target-runtime.ts`、`examples/local-inspection-targets.json`、`examples/local-inspection-memory.json` | S2.2 已接入模拟 scope、可信来源/能力注册、loopback 单操作员审核/发布装配和显式记忆策略；默认关闭/拒绝行为保持 |
| `src/memory/memory-coordinator.ts`、`src/application/target-knowledge-publication-service.ts`、`src/agent/agent-harness.ts`、`src/infrastructure/sqlite/knowledge-memory-store.ts` | S2.2 修复发布知识 policy overlay 校验、受限 FTS 任一词召回和检索上限；协调器知识预算上限 4 KiB；资格检查与 Episodic 1 KiB 上限不变 |
| `src/api/knowledge-memory-routes.ts`、`apps/agent-web/src/components/knowledge-view.ts`、`MemoryPanel.tsx`（位于同 components 目录） | 沿用 API/页面，补能力关闭、必需知识缺失、发布与召回状态可见性 |
| `test/local-target-runtime-host.test.ts`、`docs/guides/local-target-inspection.md` | 普通宿主端到端创建/提交/审核/发布 Semantic 与 Procedural，验证 ID/version/digest、A 模型输入、B 隔离、记忆关闭对照；记录 loopback 单操作员边界 |

- [x] S2.1：协调器由普通运行时 memory seam 传入，使用同一 SQLite revision/search store，且接收同一 Episodic policy/recall/renderer；47 项运行时/协调器回归通过。此项只证明装配可用，不代表 Target 知识已启用或完成 L04/L05。
- [x] S2.2：本地 Target 的 Semantic/Procedural 创建→提交→审核→发布→引用→召回进入普通宿主模型输入；逐类型检查 ID/version/digest、Target A/B 隔离和禁用记忆对照。loopback 主机测试记录独立验证。
- [x] 后续组合验收：普通 Target 宿主中验证有效期内召回、撤销后不注入、到期后不注入且其他有效知识继续召回；Web 浏览器完成草稿创建、提交、批准、发布、A 召回和 B 隔离。记录见[本地知识验收记录](../../verification/2026-10-22-local-knowledge-integration.md)。
- [x] 将拒绝、来源状态变化、必需知识门禁与普通 Target 宿主组合验收（新增来源吊销与必需知识策略两个最小治理路由，见[决策](../../superpowers/decisions/2026-10-22-knowledge-governance-host-surface.md)）；存储失败、超时、Abort、逐类型预算断言保持协调器层确定性覆盖（Spec §4.2 禁止普通宿主开启故障注入）。记录见[本地知识验收记录](../../verification/2026-10-22-local-knowledge-integration.md)。
- [x] 运行 `pnpm acceptance:memory`、双 Target/多来源 E2E 和全质量门；结果见[本地知识验收记录](../../verification/2026-10-22-local-knowledge-integration.md)。

退出：L04–L05 通过，模型上下文能证明知识生效，禁用时旧诊断不回退。S2 完成；故障注入类边界（存储失败/超时/Abort/预算）由协调器层确定性覆盖，不在普通宿主注入故障（Spec §4.2）。

## 6. S3：诊断场景与质量验收

| 文件 | 任务 |
| --- | --- |
| `src/profiles/scenarios/`、`src/profiles/index.ts` | 新增独立版本的延迟、流量、依赖与资源场景；确定性计算、阈值和缺失规则留在场景/适配器边界 |
| `src/infrastructure/simulator/`、`src/bootstrap/metrics-lab.ts`、`src/bootstrap/logs-lab.ts` | 增加一致时间窗的指标/日志模拟输入，覆盖正常与歧义，不改业务项目 |
| `test/fixtures/local-inspection-quality-cases.ts`（拟新增） | 至少 11 个具名样本及结构化预期；复用来源异常夹具 |
| `src/acceptance/evaluator.ts`、`src/acceptance/real-model-runner.ts` | 增加适用场景检查与安全报告，保持现有报告版本兼容；变更 schema 先记决策 |
| `apps/acceptance/local-inspection-quality.mjs`（拟新增）、`package.json` | 新增离线 `acceptance:local-quality`；在线路径显式 opt-in，整批预算有限且无自动重跑 |
| `test/local-inspection-quality.test.ts`（拟新增）、既有 acceptance tests | 计算边界、引用、错误/缺失/矛盾信息、预算、Abort，以及失败报告不能人工“刷绿” |
| `docs/guides/real-model-langsmith-acceptance.md` | 补当前版本四样本选择、整批上限和人工复核步骤，保留现有 probe 准入 |

- [ ] L06 离线全部通过；报告记录模拟来源与模型模式。
- [ ] 准备可审阅的在线运行清单、预算、输出目录和安全凭据配置方式。
- [ ] 获得在线调用授权且配置具备时，执行四例；缺少授权/凭据/probe 未通过则将 L07 保持 not_run/blocked，继续独立阶段。
- [ ] 逐个 Run 人工审核，unsupported claims 为 0，保存真实 usage/引用/限制，不输出凭据。

退出分开登记：离线工程通过与在线质量通过。计划落盘或离线脚本成功不视为用户已授权付费调用。

## 7. S4：定时巡检

先新增 `docs/superpowers/decisions/2026-10-21-inspection-scheduling.md`（拟新增），确定 Spec §7 的状态图、唯一约束、事务分段、崩溃对账、增量 DDL、路由及错误码，再更新 DECISIONS。

| 文件 | 任务 |
| --- | --- |
| `src/contracts/inspection-schedule.ts`（拟新增）及公开入口 | Schedule/Occurrence 判别联合、端口、版本化 Schema；限制间隔、模板与输入大小 |
| `src/application/inspection-scheduler.ts`（拟新增） | 注入 Clock/Timer/Store/TargetRunService；有界 tick、去重、补偿、暂停与对账 |
| `src/infrastructure/sqlite/inspection-schedule-store.ts`（拟新增）、`migrations.ts`、`persistence-bundle.ts`（后两者同目录） | 唯一约束、CAS revision、事务更新；遵循现有单持久化所有者 |
| `src/api/inspection-schedule-routes.ts`（拟新增）、`src/api/http-server.ts` | Target-scoped 列表、创建、编辑、启停和发生记录；严格 DTO 与归属检查 |
| `src/bootstrap/target-host-runtime.ts`、`src/bootstrap/agent-web-runtime.ts` | 生命周期组装，停服停止接收 tick，等待有界清理 |
| `apps/agent-web/src/components/InspectionSchedules.tsx`（拟新增）、`apps/agent-web/src/api/client.ts` | 显示间隔、下次时间、启停、跳过原因及对应 Run；不展示内部来源配置 |
| `test/inspection-scheduler.test.ts`、`test/inspection-scheduler-sqlite.test.ts`（拟新增） | 重复/并发 tick、回拨、重启补偿、接受后回填前崩溃、队列满、暂停/修改冲突与 Target 撤权 |

- [ ] 在每个事务边界故障注入，证明稳定 requestId 恢复后只对应一个 Run。
- [ ] 用假 Clock 测逻辑，再用真实进程重启验证磁盘状态；不只以内存测试验收。
- [ ] 新表升级、旧数据可读、不兼容二进制拒绝启动验证通过。
- [ ] 新增 `pnpm e2e:local-inspection`（拟建）覆盖调度 UI；跑完整质量门。

退出：L08–L09 通过；运行队列有界，没有第二个 Agent 主循环。

## 8. S5：通知与处理闭环

先新增 `docs/superpowers/decisions/2026-10-21-inspection-result-tracking.md`（拟新增），确定独立处理状态、通知去重、复查关联、报告 DTO 和迁移；不改变 Run 或记忆审核语义。

| 文件 | 任务 |
| --- | --- |
| `src/contracts/inspection-result.ts`（拟新增） | 通知、处理状态、复查关联、导出契约；区分终态与诊断结果 |
| `src/application/inspection-result-service.ts`（拟新增） | 终态消费/对账、幂等站内通知、CAS 处理状态、复查发起与安全导出 |
| `src/infrastructure/sqlite/inspection-result-store.ts`（拟新增）及既有 migrations/bundle | 去重键、关联/审计保存，与既有 durable outbox 生命周期衔接 |
| `src/api/inspection-result-routes.ts`（拟新增）、`src/api/http-server.ts` | Target-scoped 通知/处理/复查/导出，未知和跨 Target 资源安全拒绝 |
| `apps/agent-web/src/components/InspectionInbox.tsx`（拟新增）、`RunStatus.tsx`、`RunList.tsx`（后两者同目录）、API client | 未读、确认、解决、复查与导出；不把 resolved 显示成系统已恢复 |
| `test/inspection-result-service.test.ts`、`test/inspection-result-sqlite.test.ts`（拟新增）、本地 E2E | 消费前后崩溃、重复终态、审核与处理状态独立、导出字段白名单、复查新窗口与跨 Target |

- [ ] 确定性健康结果缺失时展示待复核，不解析自由文本推断健康。
- [ ] 断线/重启后站内通知仍可见，重复投递不产生重复通知。
- [ ] 全质量门与本地浏览器闭环通过。

退出：L10 通过；本阶段不发送外部消息。

## 9. S6：运维、持续运行与发布

先记录 `docs/superpowers/decisions/2026-10-21-local-inspection-data-lifecycle.md`（拟新增），明确停服备份的一致性、引用保护、清理事务/失败补偿和 Schema 兼容；未完成引用证明前清理仅 dry-run。

| 文件 | 任务 |
| --- | --- |
| `apps/local-inspection/index.mjs`、`src/bootstrap/local-inspection-config.ts`（拟新增） | 统一自检/启动/停止；显式路径、同目录单宿主保护、端口冲突、自有子进程管理、模型模式区分 |
| `src/api/health-routes.ts`（拟新增）、`src/api/http-server.ts` | 最小健康/就绪安全 DTO，区分存储故障与来源降级 |
| `src/application/inspection-maintenance-service.ts`、`src/infrastructure/local-inspection-backup.ts`（拟新增） | 停服备份、清单/校验和、恢复到新目录、引用保护与 dry-run 清理；IO 留在基础设施 |
| `apps/local-inspection/maintenance.mjs`（拟新增）、`package.json` | 建立 `inspection:doctor`、`inspection:start`、`inspection:backup`、`inspection:restore`、`inspection:retention` 命令；帮助中注明危险参数和默认暂停 |
| `test/local-inspection-maintenance.test.ts`（拟新增） | WAL 一致关闭、缺失/损坏 blob、Schema 不兼容、空间不足、引用保护、恢复默认停调度 |
| `apps/acceptance/local-inspection-soak.mjs`（拟新增） | 24 小时实测、故障注入与有界统计；产物隔离，禁止自动调用在线模型 |
| `.github/workflows/quality-gates.yml` | 保留已有质量门，加入必要的离线 E2E 与恢复检查；24 小时实测独立运行，不阻塞每次 PR |
| `docs/guides/local-inspection-operations.md`（拟新增）、本计划验收记录 | 安装、启停、故障处理、备份恢复、升级/回退及实际支持平台 |

- [ ] 在新数据目录按文档启动；端口/配置/凭据缺失可解释，停止后没有自有进程泄漏。
- [ ] 备份恢复到另一目录后，检查历史、证据、记忆审核、处理状态及调度对账；不覆盖原数据。
- [ ] 迁移前备份，模拟升级失败，按指南恢复旧版本可读数据；不进行未经验证的逆向迁移。
- [ ] 按 Spec §9 运行 24 小时实际测试，保存计数与资源基线；没有实际运行则 L13 为 not_run。
- [ ] 运行完整质量门、本地 E2E、既有 `acceptance:multi-target-capacity` 和 `acceptance:multi-target-load`，记录环境和差异。
- [ ] 独立提交/推送、核对远端 SHA 与对应 CI；网络失败保留阻塞与待办。

退出：L11–L14 通过；若 L07 未通过，只能交付“本地工程闭环通过”，不能称“真实模型诊断可用”或“生产上线完成”。

## 10. 风险、暂停条件与后续工作

| 风险/条件 | 处理 |
| --- | --- |
| 普通宿主与测试夹具组装差异 | S1 以正式 bootstrap 为验收入口；不复制 test-only policy/model 到产品 |
| 接线要求改变既有契约 | 先记录最小兼容决定和迁移，再实施；不为满足计划破坏已发布字段 |
| 模型质量或 LangSmith probe 失败 | 保留真实失败；不自动重跑、不放宽人工复核标准；不阻塞无依赖的离线阶段 |
| 新调度发生重复/孤儿 Run | S4 不通过，不进入自动长期运行；先修事务边界和对账 |
| 留存删除破坏引用 | 清理维持 dry-run；未证明安全的对象全部保留 |
| 环境缺少持久化/端口权限 | 记录受阻检查，使用已授权测试目录/权限流程；不登记假通过 |
| GitHub 不可达 | 本地小步提交，STATUS 写明待同步；恢复后普通 push 并核验 |

对外认证授权、外部告警入口、外部通知、真实业务接入与动作执行均为后续独立里程碑，需对应 Spec/Plan。当前无可信旧数据库，不为 M2b 编造迁移数据。每完成一个阶段更新本表状态和 STATUS，不能用本方案替代实现证据。
