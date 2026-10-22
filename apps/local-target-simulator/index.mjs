import process from 'node:process';
import { startLocalTargetSimulator } from '../../dist/bootstrap/local-target-simulator.js';

const simulator = await startLocalTargetSimulator({
  metricsPort: readPort('AGENTOPS_LOCAL_TARGET_METRICS_PORT', 19_390),
  logsPort: readPort('AGENTOPS_LOCAL_TARGET_LOGS_PORT', 19_391),
  legacyMetricsPort: readPort('AGENTOPS_LOCAL_TARGET_LEGACY_METRICS_PORT', 19_392),
});
process.stdout.write(`${JSON.stringify({
  status: 'ready', metricsUrl: simulator.metricsUrl, logsMcpUrl: simulator.logsMcpUrl,
  legacyMetricsMcpUrl: simulator.legacyMetricsMcpUrl,
})}\n`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await simulator.close();
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });

function readPort(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be an integer.`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error(`${name} is outside the valid port range.`);
  return port;
}
