import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAgentWebRuntime } from '../../dist/bootstrap/agent-web-runtime.js';
import { createLocalTargetRuntime, readLocalTargetHostConfig } from '../../dist/bootstrap/local-target-runtime.js';
import { startLocalTargetSimulator } from '../../dist/bootstrap/local-target-simulator.js';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const root = await mkdtemp(join(tmpdir(), 'opsagent-local-inspection-e2e-'));
const targetConfigPath = join(root, 'targets.json');
const cursorSecret = 'local-inspection-e2e-cursor-secret-over-32-bytes';
let simulator;
let runtime;
let closing = false;

try {
  simulator = await startLocalTargetSimulator({ metricsPort: 0, logsPort: 0, legacyMetricsPort: 0 });
  const example = JSON.parse(await readFile(join(repoRoot, 'examples/local-inspection-targets.json'), 'utf8'));
  example.connections.connections = example.connections.connections.map(connection => ({
    ...connection,
    endpoint: connection.kind === 'metrics' ? simulator.metricsUrl : simulator.logsMcpUrl,
  }));
  await writeFile(targetConfigPath, JSON.stringify(example), { mode: 0o600 });
  const config = await readLocalTargetHostConfig(targetConfigPath);
  const local = createLocalTargetRuntime(config, cursorSecret);
  const webPort = Number(process.env.AGENTOPS_LOCAL_INSPECTION_AGENT_PORT ?? 45700);
  const frontendPort = Number(process.env.AGENTOPS_LOCAL_INSPECTION_WEB_PORT ?? 45773);
  runtime = await startAgentWebRuntime({
    dataDirectory: join(root, 'data'),
    workspaceRoots: [join(root, 'workspace')],
    model: createLocalInspectionModel(),
    host: '127.0.0.1',
    port: webPort,
    allowedOrigins: [`http://127.0.0.1:${frontendPort}`],
    profiles: local.profiles,
    targetRuntime: local.targetRuntime,
    metrics: { profileId: 'simulation', mcpUrl: simulator.legacyMetricsMcpUrl },
    logs: { profileId: 'simulation', mcpUrl: simulator.logsMcpUrl, cursorSecret },
  });
} catch (error) {
  await close();
  throw error;
}

process.stdout.write(`${JSON.stringify({ status: 'ready', url: runtime.url })}\n`);
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });

async function close() {
  if (closing) return;
  closing = true;
  try { await runtime?.close(); }
  finally {
    await simulator?.close();
    await rm(root, { recursive: true, force: true });
  }
}

function createLocalInspectionModel() {
  return {
    currentWindow: undefined,
    async *stream(messages, tools, options) {
    const names = new Set(tools.map(tool => tool.name));
    if (names.has('metrics_subagent') && names.has('logs_subagent')) {
      const text = messages.flatMap(message => message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []))
        .join('\n');
      const targetId = value(text, 'targetId');
      const profileId = value(text, 'profile');
      const start = value(text, 'start');
      const end = value(text, 'end');
      this.currentWindow = { start, end };
      if (!hasToolResult(messages, 'metrics_subagent')) {
        return { toolCalls: [{ id: `e2e-metrics-${options.runId}`, name: 'metrics_subagent', input: {
          profileId, service: 'checkout', start, end, question: '检查当前 Target 失败率',
        } }] };
      }
      if (!hasToolResult(messages, 'logs_subagent')) {
        return { toolCalls: [{ id: `e2e-logs-${options.runId}`, name: 'logs_subagent', input: {
          profileId, service: 'checkout', start, end, question: '检查同一窗口内的模拟日志',
        } }] };
      }
      const textResult = `${targetId} 的本地模拟指标与日志均已取证。`;
      yield { type: 'text_delta', delta: textResult };
      return { text: textResult, toolCalls: [] };
    }

    const sourceTool = names.has('metrics.window_snapshot') ? 'metrics.window_snapshot'
      : names.has('logs.capture') ? 'logs.capture' : undefined;
    if (sourceTool === undefined) throw new Error(`Unexpected source tools: ${[...names].join(',')}`);
    if (!hasToolResult(messages, sourceTool)) {
      return { toolCalls: [{ id: `e2e-${options.runId}-${sourceTool}`, name: sourceTool,
        input: sourceTool === 'logs.capture' ? { service: 'checkout', ...this.currentWindow } : {} }] };
    }
    const evidenceId = findEvidenceId(messages, sourceTool);
    if (evidenceId === undefined) throw new Error(`${sourceTool} did not produce evidence.`);
    if (!hasToolResult(messages, 'source_report')) {
      return { toolCalls: [{ id: `e2e-${options.runId}-report`, name: 'source_report', input: {
        summary: '模拟来源已完成只读取证。',
        findings: [{ kind: 'observation', statement: '来源返回了同一窗口的可回查证据。', evidenceIds: [evidenceId] }],
        businessTraceIds: [], missingEvidence: [],
      } }] };
    }
    const textResult = `${sourceTool} 取证完成。`;
    yield { type: 'text_delta', delta: textResult };
    return { text: textResult, toolCalls: [] };
    },
  };
}

function value(text, name) {
  const match = new RegExp(`(?:^|\\n)${name}=([^\\n]+)`, 'u').exec(text)?.[1];
  if (match === undefined) throw new Error(`Trusted Target ${name} is missing.`);
  return match;
}

function hasToolResult(messages, toolName) {
  return messages.some(message => message.blocks.some(block => block.type === 'tool_result' && block.result.toolName === toolName));
}

function findEvidenceId(messages, toolName) {
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_result' && block.result.toolName === toolName) {
        return block.result.response?.evidenceIds?.[0]
          ?? block.result.response?.blocks.find(responseBlock => responseBlock.type === 'evidence_ref')?.evidenceId;
      }
    }
  }
  return undefined;
}
