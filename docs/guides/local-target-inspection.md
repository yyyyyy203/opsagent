# 本地多 Target 双来源巡检

本指南启动正式 `apps/agent-server` Target 组装和本地合成来源。它为两个示例 Target 提供一致的 300 秒模拟指标窗口与日志记录，不连接 `group-buy-market`、生产 Prometheus/ELK 或外部业务系统。Target 模拟器仅绑定 `127.0.0.1`，只提供只读查询。

## 启动本地来源

需要 Node.js 24、仓库依赖和可运行的 `pnpm`。在仓库根目录的第一个终端运行：

```powershell
pnpm local:target-lab
```

该命令先构建项目，再启动 Prometheus HTTP API、Target Logs MCP 和旧 simulation 入口所需的 Metrics MCP。默认地址分别为 `http://127.0.0.1:19390`、`http://127.0.0.1:19391/mcp` 和 `http://127.0.0.1:19392/mcp`；启动输出会列出实际地址。指标查询严格限制为示例 Profile 的四个窗口查询，边界值根据每次查询的宿主时间生成；Logs MCP 根据同一请求窗口生成一条合成错误日志。无需 Docker。

## 启动 Agent 宿主

第二个终端设置本地数据目录、工作区、Target 配置和来源地址。工作区使用专用空目录，不需要访问被监测项目：

```powershell
$repo = (Resolve-Path '.').Path
$env:AGENTOPS_DATA_DIR = Join-Path $env:TEMP 'opsagent-local-target-data'
$env:AGENTOPS_WORKSPACE_ROOTS = Join-Path $env:TEMP 'opsagent-local-target-workspace'
$env:AGENTOPS_HOST = '127.0.0.1'
$env:AGENTOPS_PORT = '4200'
$env:AGENTOPS_WEB_PROFILE = 'simulation'
$env:AGENTOPS_TARGET_CONFIG = (Resolve-Path (Join-Path $repo 'examples/local-inspection-targets.json')).Path
$env:AGENTOPS_METRICS_MCP_URL = 'http://127.0.0.1:19392/mcp'
$env:AGENTOPS_LOGS_MCP_URL = 'http://127.0.0.1:19391/mcp'
```

`AGENTOPS_TARGET_CONFIG` 必须是绝对路径。该样例只注册 `market-a-sim` 和 `market-b-sim` 两个模拟、只读 Target；它们查询相同的合成数据，但阈值分别为 5% 和 2%。

Agent 仍需服务端 OpenAI-compatible 模型配置。真实模型会产生服务商费用；模型密钥只放在 Agent 进程的环境变量中：

```powershell
$env:AGENTOPS_MODEL_BASE_URL = 'https://你的兼容服务地址/v1'
$env:AGENTOPS_MODEL = '你的模型名称'
$modelKey = Read-Host '输入模型 API Key（不回显）' -AsSecureString
$env:AGENTOPS_MODEL_API_KEY = [System.Net.NetworkCredential]::new('', $modelKey).Password
Remove-Variable modelKey
$cursorSecret = Read-Host '输入本地 Evidence cursor secret（至少 32 字节，不回显）' -AsSecureString
$env:AGENTOPS_EVIDENCE_CURSOR_SECRET = [System.Net.NetworkCredential]::new('', $cursorSecret).Password
Remove-Variable cursorSecret
New-Item -ItemType Directory -Force $env:AGENTOPS_DATA_DIR, $env:AGENTOPS_WORKSPACE_ROOTS | Out-Null
pnpm web:server
```

如果同时使用 Target Logs 与 legacy Logs 工作台，`AGENTOPS_EVIDENCE_CURSOR_SECRET` 必须至少有 32 个 UTF-8 字节，并在宿主重启后保持不变。不要把密钥或本地数据目录提交到仓库。

## 打开工作台并验收

第三个终端启动前端：

```powershell
$env:VITE_AGENT_API_URL = 'http://127.0.0.1:4200'
pnpm web:dev
```

打开 Vite 输出的地址，在“Target 项目巡检”中分别选择两个 Target 并发起巡检。正常情况下，Run 会产生 Metrics 和 Logs 两个子 Run；证据页显示窗口失败率及日志摘要。当前样例 96 次成功、4 次失败：A 的 4% 低于 5% 阈值，B 的 4% 达到 2% 阈值。切换 Target 后，历史和证据按 Target 隔离。页面只展示摘要和证据引用，不展示原始来源正文或连接地址。

旧的“模拟巡检”入口仍由 `AGENTOPS_METRICS_MCP_URL` 和 `AGENTOPS_LOGS_MCP_URL` 提供，因此可以在工作台切回后检查兼容路径。改变示例配置只影响重启后的新 Run；已保存的 Run 保留启动时的 Profile 和阈值快照。来源端口如被占用，可通过 `AGENTOPS_LOCAL_TARGET_METRICS_PORT`、`AGENTOPS_LOCAL_TARGET_LOGS_PORT`、`AGENTOPS_LOCAL_TARGET_LEGACY_METRICS_PORT` 设置空闲端口，并同步修改 Target JSON 与宿主 MCP 环境变量。

停止服务时分别在三个终端按 `Ctrl+C`。Target 配置和模拟器不启动 Docker、不执行真实动作，也不会修改被监测项目。
