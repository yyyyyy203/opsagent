import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import process from 'node:process';
import { z } from 'zod';
import type { AgentWebRuntimeOptions } from './agent-web-runtime.js';
import type { ProfileDefinition } from '../profiles/profile-types.js';
import type { ResolvedTargetSnapshotV2, TargetCatalogDefinition, TargetOperationPolicy,
  TargetOperationRequest, TargetOperationPermit } from '../contracts/target.js';
import { TargetConfigurationError } from '../contracts/target.js';
import type { TargetRecoveryFactoryPorts } from './agent-web-runtime.js';
import { StaticProfileResolver } from '../profiles/profile-resolver.js';
import { createStaticTargetResolver } from '../profiles/target-resolver.js';
import { parseTargetCatalog } from '../profiles/target-catalog-schema.js';
import { WINDOW_FAILURE_RATE_INSTALLATIONS } from '../profiles/scenarios/window-failure-rate-v1.js';
import { FetchWindowPrometheusQueryPort } from '../infrastructure/prometheus/http-window-query-port.js';
import { createTargetMetricsSubagentRuntime } from './target-metrics-subagent.js';
import { createTargetLogsWebSource } from './logs-web-source.js';
import { createSharedSourceChildAgentFactory } from './shared-source-child.js';

const identifier = z.string().min(1).max(128).regex(/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u);
const connection = z.object({
  sourceId: identifier,
  version: z.string().min(1).max(128),
  kind: z.enum(['metrics', 'logs']),
  adapterId: identifier,
  enabled: z.boolean(),
  endpoint: z.string().url(),
  secretRef: identifier.optional(),
  allowedServiceIds: z.array(identifier).min(1).max(32),
  dataDomainId: identifier,
  sourceGeneration: z.number().int().positive().safe(),
  permissionScopeDigest: z.string().regex(/^[a-f0-9]{64}$/iu),
}).strict();
const configuration = z.object({
  schemaVersion: z.literal(1),
  catalog: z.unknown(),
  connections: z.object({ schemaVersion: z.literal(2), connections: z.array(connection).max(2_000) }).strict(),
  profiles: z.array(z.unknown()).min(1).max(200),
}).strict();

export interface LocalTargetHostConfig {
  readonly catalog: { schemaVersion: 1; targets: readonly TargetCatalogDefinition[] };
  readonly connections: { schemaVersion: 2; connections: readonly z.infer<typeof connection>[] };
  readonly profiles: readonly ProfileDefinition[];
}

export async function readLocalTargetHostConfig(path: string): Promise<LocalTargetHostConfig> {
  if (!isAbsolute(path)) throw new Error('AGENTOPS_TARGET_CONFIG must be an absolute path.');
  const file = await readFile(path);
  if (file.byteLength > 1024 * 1024) throw new Error('TARGET_CONFIG_TOO_LARGE');
  let value: unknown;
  try { value = JSON.parse(file.toString('utf8')) as unknown; }
  catch { throw new Error('TARGET_CONFIG_INVALID'); }
  const parsed = configuration.safeParse(value);
  if (!parsed.success) throw new Error('TARGET_CONFIG_INVALID');
  const catalog = parseTargetCatalog(parsed.data.catalog, { maxRegisteredTargets: 200 });
  if (catalog.rejected.length !== 0 || catalog.targets.length === 0) throw new Error('TARGET_CONFIG_INVALID');
  const profiles = parsed.data.profiles as ProfileDefinition[];
  new StaticProfileResolver(profiles);
  const profileIds = new Set<string>();
  const targetProfileIds = new Set(catalog.targets.map(target => target.profileId));
  for (const profile of profiles) {
    if (typeof profile !== 'object' || profile === null || profileIds.has(profile.profileId)
      || !targetProfileIds.has(profile.profileId) || profile.allowedActions.length !== 0) {
      throw new Error('TARGET_PROFILE_INVALID');
    }
    profileIds.add(profile.profileId);
  }
  if (profileIds.size !== targetProfileIds.size || catalog.targets.some(target => target.dataClass !== 'simulated'
    || target.environment !== 'simulation' || !profileIds.has(target.profileId))) {
    throw new Error('LOCAL_TARGETS_MUST_BE_SIMULATED_AND_READ_ONLY');
  }
  for (const item of parsed.data.connections.connections) {
    const endpoint = new URL(item.endpoint);
    if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
      || endpoint.username.length > 0 || endpoint.password.length > 0 || endpoint.search.length > 0 || endpoint.hash.length > 0) {
      throw new Error('LOCAL_TARGET_SOURCE_MUST_USE_LOOPBACK_HTTP');
    }
  }
  return {
    catalog: { schemaVersion: 1, targets: catalog.targets },
    connections: parsed.data.connections,
    profiles,
  };
}

export function createLocalTargetRuntime(
  config: LocalTargetHostConfig,
  cursorSecret?: string,
): Pick<AgentWebRuntimeOptions, 'profiles' | 'targetRuntime'> {
  const connections = new Map(config.connections.connections.map(item => [item.sourceId, item]));
  const profileResolver = new StaticProfileResolver(config.profiles);
  const profiles = config.profiles.map(profile => ({ id: profile.profileId, name: profile.serviceName,
    description: '本机模拟 Target，只读巡检。', enabled: true, readOnly: true }));
  return {
    profiles,
    targetRuntime: {
      createResolver: ports => createStaticTargetResolver({
        ...ports,
        catalog: config.catalog,
        connections: config.connections,
        profileResolver,
        installedScenarios: WINDOW_FAILURE_RATE_INSTALLATIONS,
        installedAdapters: [
          { id: 'prometheus-mcp.v1', kind: 'metrics' as const },
          { id: 'elasticsearch-mcp.v1', kind: 'logs' as const },
        ],
        validationTime: new Date().toISOString(),
      }),
      createOperationPolicy: (): TargetOperationPolicy => ({
        authorize: request => Promise.resolve(createPermit(request, connections)),
        validate: (permit, request) => Promise.resolve().then(() => validatePermit(permit, request, connections)),
      }),
      createRuntimeProvider: (ports: TargetRecoveryFactoryPorts) => {
        const childAgentFactory = createSharedSourceChildAgentFactory({
          model: ports.model,
          workspaceRoots: [],
          checkpoints: ports.runtimeTools.checkpoints,
          evidence: ports.runtimeTools.evidence,
          evidenceRecorder: ports.runtimeTools.evidenceRecorder,
          sharedEvents: ports.runtimeTools.sharedEvents,
          targetRecoveryGate: ports.runtimeTools.targetRecoveryGate,
          clock: ports.runtimeTools.clock,
          ids: ports.runtimeTools.ids,
          ...(ports.modelIdentity === undefined ? {} : { modelIdentity: ports.modelIdentity }),
        });
        return {
          acquire: (snapshot: ResolvedTargetSnapshotV2) => Promise.resolve().then(() => {
            const metricsBinding = requiredSource(snapshot, 'metrics');
            const metricsConnection = requiredConnection(connections, metricsBinding.sourceId, 'metrics');
            const metricUrl = new URL(metricsConnection.endpoint);
            if (metricUrl.pathname !== '/' || metricUrl.search.length > 0) throw new Error('TARGET_METRICS_ENDPOINT_INVALID');
            const bearerToken = resolveSecret(metricsConnection.secretRef);
            const metrics = createTargetMetricsSubagentRuntime({
              snapshot,
              sourcePartitions: ports.sourcePartitions,
              queryPort: new FetchWindowPrometheusQueryPort({ url: metricUrl.origin,
                ...(bearerToken === undefined ? {} : { bearerToken }), now: () => ports.runtimeTools.clock.now().getTime() }),
              windowPolicy: createWindowPolicy(snapshot),
              evidenceRecorder: ports.evidenceRecorder,
              childAgentFactory,
              targetBindings: ports.durableState.targetBindings,
              checkpoints: ports.runtimeTools.checkpoints,
              clock: ports.runtimeTools.clock,
              lifecycle: { ...ports.runtimeTools.events, ids: ports.runtimeTools.ids },
              maxResponseBytes: 256 * 1024,
              timeoutMs: 5_000,
            });
            const tools = [metrics.tool];
            const releases: Array<() => void | Promise<void>> = [() => metrics.release()];
            try {
              const logsBinding = snapshot.sourceBindings.find(source => source.kind === 'logs'
                && !snapshot.unavailableOptionalSourceIds.includes(source.sourceId));
              if (logsBinding !== undefined) {
                if (cursorSecret === undefined || Buffer.byteLength(cursorSecret, 'utf8') < 32) {
                  throw new Error('AGENTOPS_EVIDENCE_CURSOR_SECRET is required for Target Logs.');
                }
                const logsConnection = requiredConnection(connections, logsBinding.sourceId, 'logs');
                const partition = ports.sourcePartitions.acquire(snapshot, logsBinding.sourceId);
                try {
                  const logSource = createTargetLogsWebSource(ports.runtimeTools, {
                    mcpUrl: logsConnection.endpoint,
                    model: ports.model,
                    cursorSecret,
                    targetScope: { snapshot, sourceId: logsBinding.sourceId },
                    partition,
                    ...(ports.modelIdentity === undefined ? {} : { modelIdentity: ports.modelIdentity }),
                  });
                  tools.push(logSource.tool);
                  releases.push(() => logSource.release());
                } catch (error) {
                  partition.release();
                  throw error;
                }
              }
              let released = false;
              return {
                model: ports.model,
                ...(ports.modelIdentity === undefined ? {} : { modelIdentity: ports.modelIdentity }),
                tools: Object.freeze(tools),
                release: async () => {
                  if (released) return;
                  released = true;
                  await Promise.allSettled(releases.map(release => Promise.resolve(release())));
                },
              };
            } catch (error) {
              metrics.release();
              throw error;
            }
          }),
        };
      },
      createStarter: ports => ({ startAccepted: options => ports.execution.startAccepted(ports.prepareStart(options)) }),
      sourcePartitionLimits: { maxPartitions: 32, maxConcurrentOperationsPerPartition: 2, maxQueuedOperationsPerPartition: 8 },
    },
  };
}

function requiredSource(snapshot: ResolvedTargetSnapshotV2, kind: 'metrics' | 'logs') {
  const source = snapshot.sourceBindings.find(item => item.kind === kind && item.required
    && !snapshot.unavailableOptionalSourceIds.includes(item.sourceId));
  if (source === undefined) throw new TargetConfigurationError('SOURCE_MAPPING_INVALID');
  return source;
}

function requiredConnection(connections: ReadonlyMap<string, z.infer<typeof connection>>, sourceId: string, kind: 'metrics' | 'logs') {
  const source = connections.get(sourceId);
  if (source === undefined || source.kind !== kind || !source.enabled) throw new TargetConfigurationError('SOURCE_MAPPING_INVALID');
  return source;
}

function resolveSecret(secretRef: string | undefined): string | undefined {
  if (secretRef === undefined) return undefined;
  const value = process.env[secretRef];
  if (value === undefined || value.length === 0) throw new Error('TARGET_SOURCE_SECRET_UNAVAILABLE');
  return value;
}

function createWindowPolicy(snapshot: ResolvedTargetSnapshotV2) {
  const mapping = snapshot.scenario.metricMapping;
  const allowedMetrics = new Set([mapping.metricName, mapping.windowBoundaryMapping?.startMetricName,
    mapping.windowBoundaryMapping?.endMetricName].filter((value): value is string => value !== undefined));
  return {
    authorize(window: { startUnixSeconds: number; endUnixSeconds: number }, now: number) {
      if (window.endUnixSeconds - window.startUnixSeconds !== 300) return 'denied' as const;
      if (now - window.endUnixSeconds > 120) return 'stale' as const;
      if (window.endUnixSeconds - now > 30 || window.startUnixSeconds >= window.endUnixSeconds) return 'denied' as const;
      return 'authorized' as const;
    },
    authorizeObservations(input: { requestedWindow: { startUnixSeconds: number; endUnixSeconds: number };
      observations: readonly { metricName: string; sampleUnixSeconds: number }[]; nowUnixSeconds: number }) {
      const valid = input.observations.length > 0 && input.observations.every(observation => allowedMetrics.has(observation.metricName)
        && observation.sampleUnixSeconds >= input.requestedWindow.endUnixSeconds - 30
        && observation.sampleUnixSeconds <= input.nowUnixSeconds + 30);
      return valid ? 'authorized' as const : 'denied' as const;
    },
  };
}

function createPermit(request: TargetOperationRequest,
  connections: ReadonlyMap<string, z.infer<typeof connection>>): TargetOperationPermit {
  assertRequestAllowed(request, connections);
  return { bindingId: request.binding.bindingId, runId: request.runId, rootRunId: request.rootRunId,
    snapshotDigest: request.snapshot.digest, operation: request.operation, capability: request.capability,
    policyEpoch: 1, signal: request.signal };
}

function validatePermit(permit: TargetOperationPermit, request: TargetOperationRequest,
  connections: ReadonlyMap<string, z.infer<typeof connection>>): void {
  assertRequestAllowed(request, connections);
  if (request.signal.aborted || permit.signal.aborted || permit.bindingId !== request.binding.bindingId
    || permit.runId !== request.runId || permit.rootRunId !== request.rootRunId
    || permit.snapshotDigest !== request.snapshot.digest || permit.operation !== request.operation
    || permit.capability !== request.capability || permit.policyEpoch !== 1) {
    throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
  }
}

function assertRequestAllowed(request: TargetOperationRequest,
  connections: ReadonlyMap<string, z.infer<typeof connection>>): void {
  if (request.signal.aborted || request.binding.targetId !== request.snapshot.targetId
    || request.binding.snapshotDigest !== request.snapshot.digest || request.binding.runId !== request.runId
    || request.binding.rootRunId !== request.rootRunId) throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
  if (request.operation === 'start' || request.operation === 'resume') {
    if (request.capability !== 'target_runtime') throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
    return;
  }
  if (request.operation === 'model' && request.capability === 'model') return;
  if (request.operation === 'source') {
    const binding = request.snapshot.sourceBindings.find(source => source.sourceId === request.capability);
    if (binding !== undefined && !request.snapshot.unavailableOptionalSourceIds.includes(binding.sourceId)
      && connections.has(binding.sourceId)) return;
  }
  throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
}
