# 受控诊断记忆：本地启用与离线验收

本指南对应[受控诊断记忆一期 Spec R2](../superpowers/specs/2026-10-10-governed-diagnostic-memory-design.md)。模拟 Profile 的工作台可使用 Working Run 状态恢复和 Episodic 巡检案例沉淀/审核/有限召回。Semantic、Procedural 的目标端能力需要显式 Target Runtime 和知识治理 Host；默认 `apps/agent-server` 未组装这些能力。向量检索仍通过独立实验入口验证。

## 默认行为

记忆能力默认关闭。未设置 `AGENTOPS_MEMORY_ENABLED=1` 时，Agent 保持无记忆行为，旧版巡检请求仍可运行。启用时需要通过 `AGENTOPS_MEMORY_CONFIG` 指向一个本机绝对路径 JSON 配置文件；配置仅描述 Profile、scope、保存策略、召回策略和 token 预算，不接受模型端点、API Key 或任意查询语句。

仓库提供了仅供本地模拟 Metrics+Logs 巡检使用的[记忆配置](../../examples/diagnostic-memory-simulation.json)。scope 固定标识 `simulation`、`checkout`、`settlement_failure` 和 Logs Lab 模拟数据集；它不是 `group-buy-market` 身份，也不能用于真实目标。配置要求一个 Run 同时有指标和日志证据；缺少任一必需来源时，该 Run 不满足沉淀质量门。未配置的 Trace 缺口会保留在案例限制中，不会阻止该模拟 Profile 的指标与日志案例沉淀。

结合本地模拟指标和日志进行验证时，先按[Logs Web 本地验收指南](./logs-web-elasticsearch-local.md)启动 `settlement_failure` 场景，并在启动 Agent Web 的同一个 PowerShell 会话设置记忆开关和配置绝对路径。`AGENTOPS_LOGS_MCP_URL` 与 `AGENTOPS_EVIDENCE_CURSOR_SECRET` 也必须按该指南配置：

```powershell
$env:AGENTOPS_MEMORY_ENABLED = '1'
$env:AGENTOPS_MEMORY_CONFIG = (Resolve-Path '.\examples\diagnostic-memory-simulation.json').Path
```

之后正常运行 `pnpm web:server`。配置文件不含密钥，只包含固定模拟 scope 和策略；不要把本地数据目录或证据 Blob 提交到 Git。该模拟入口不部署、不修改、不连接 `group-buy-market`。

此 Profile 只允许手动沉淀，默认关闭召回和自动沉淀。UI 中“沉淀本次巡检”要求 Run 已完成且有完整的指标与日志证据；候选先进入 `observation`，需人工审核后才可在同 scope 的后续 Run 中启用历史召回。若只想验证巡检本身，不需要启用记忆，默认关闭即可。

恢复为默认关闭：

```powershell
$env:AGENTOPS_MEMORY_ENABLED = '0'
Remove-Item Env:AGENTOPS_MEMORY_CONFIG -ErrorAction SilentlyContinue
```

用户在前端选择本次 Run 的保存和召回行为；部署 Profile 决定哪些行为允许。保存和召回互相独立：例如可以手动保存但关闭历史召回。新案例先进入 `observation`，只有人工审核通过且证据、scope 和期限仍有效时才会参与同范围召回。失败/取消 Run 可归档，但不能批准为可召回案例。记忆审核不是动作授权，不能批准任何真实写操作。

## 运行离线验收

需要仓库规定的 Node.js 24 和已安装依赖。从仓库根目录执行：

```powershell
node --version # 必须是 v24.x；pnpm 子进程使用的 node 也必须是 v24
pnpm acceptance:memory
```

先用 `Get-Command node` 确认 `node` 指向 Node 24。如果显示 Node 20，先把 Node 24 的 `bin` 目录放到当前 PowerShell 会话 `PATH` 前部，或打开已配置 Node 24 的新终端，再运行验收。仅 `pnpm --version` 正常不代表它启动的 `node` 版本正确；SQLite 原生扩展按 Node ABI 编译，版本不匹配会在运行期得到 `ERR_DLOPEN_FAILED`。验收器会只输出该类固定错误码，不输出本地路径、异常正文或堆栈。

命令编译项目后运行 `apps/acceptance/memory.mjs`。脚本为本次执行创建隔离临时 SQLite 和 loopback Web Runtime，注入 `ScriptedModel` 与受控模拟指标 Tool；完成后移除临时目录，不读写默认 `AGENTOPS_DATA_DIR`、真实业务库或已存在的烟测报告。集成测试用请求 guard 只转发 loopback 请求并拒绝其他地址；CLI 自身只向新建的 loopback Runtime 发请求。该命令不会调用 DeepSeek、LangSmith、Prometheus、ELK 或 `group-buy-market`，模型 HTTP 与外部请求预算都为 0。

输出是脱敏 JSON，固定包含 `status`、各项布尔 `checks`、六种真实运行的 `strategyMatrix`、`modelRequestsSent`、`externalRequestsSent` 和 `externalRequestsBlocked`。检查覆盖：捕获幂等、manual/automatic/skip × recall 开/关的实际 Run 行为、自动/手动竞争去重、来源 Run 不变、失败归档和非终态拒绝、审核后才可召回、跨 scope 与 live 负向隔离、重启后的冻结选择复核、原始证据/Oracle 不进入模型或公开输出、SQLite 事务回滚无残留 case/FTS/outbox、过期 Worker fencing 和部署关闭基线。所有 Runtime `fetch` 都被包装为 loopback-only 并禁止重定向；非 loopback 请求在发送前阻断，失败 JSON 返回固定错误码和阻断计数。搜索夹具包含中英文、Unicode 归一化、profile/revision/service/fault/target/environment/dataset 单字段范围变化、同分排序、过期、索引版本变化、缺证、操作符输入、当前 Run 排除、limit 和无匹配等确定性查询。它只验证机制和固定夹具排序，不输出未评测的诊断准确率。

## 本地数据、备份与限制

- 实际 Web 服务把记忆表保存在 `AGENTOPS_DATA_DIR\agent.sqlite`，与 Run/Checkpoint 共用 SQLite 数据库及迁移；离线验收使用独立临时目录。
- 备份前先停止服务，再备份完整数据目录；不要在服务运行时只复制主 `.sqlite` 文件而漏掉 WAL 状态。恢复前保留原目录副本，并在隔离目录验证数据库可打开。
- `validUntil` 会阻止过期案例被召回；这不等于已配置自动清理/保留运维任务。不要手工删除 SQLite 表或直接编辑 case JSON。清理、保留期限和生产备份策略需在部署前另行确定。
- 审核批准仅允许充分且可回查证据的已完成案例。撤销会阻止后续召回；暂停 Run 恢复时按当前审核、证据和 Profile 策略重验已冻结的选择，不扩展到新的搜索结果。
- `pnpm acceptance:memory` 是离线功能验收，不验证真实业务效果、目标系统权限、多租户隔离、生产备份/恢复演练或在线模型质量。
- 不在生产环境打开自动捕获或召回，除非相应 Profile 的数据分类、scope 指纹、证据保留、审核责任和容量预算已经过项目负责人评审。
