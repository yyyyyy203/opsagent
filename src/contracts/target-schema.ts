import { z } from 'zod';
import { checkpointChecksum } from './stable-json.js';
import { memoryScopeSchema } from './diagnostic-memory-schema.js';
import {
  TargetConfigurationError,
  type ResolvedTargetSnapshot,
  type TargetRunBindingRecord,
  type TargetRunRequestRecord,
} from './target.js';

const identifier = z.string().min(1).max(256).refine(value => value.trim().length > 0);
const revision = z.string().min(1).max(128).refine(value => value.trim().length > 0);
const timestamp = z.string().max(64).datetime({ offset: true });
const snapshotDigest = z.string().regex(/^sha256:v1:[a-f0-9]{64}$/u);
const hexDigest = z.string().regex(/^[a-f0-9]{64}$/iu);

const profileSnapshot = z.object({
  profileId: identifier,
  revision: identifier,
  digest: z.string().min(1).max(256),
  serviceName: z.string().min(1).max(256),
  serviceLevel: z.enum(['S0', 'S1', 'S2', 'S3']),
  timezone: z.string().min(1).max(128),
  allowedActions: z.array(identifier).max(256),
  forbiddenActions: z.array(identifier).max(256),
  changeFreezePeriods: z.array(z.object({
    id: identifier,
    startsAt: timestamp,
    endsAt: timestamp,
    reason: z.string().max(2_000).optional(),
  }).strict()).max(256),
  impactPolicy: z.object({
    unavailable: z.object({
      S0: z.literal('deny'), S1: z.literal('deny'), S2: z.literal('confirm'), S3: z.literal('confirm'),
    }).strict(),
  }).strict(),
  policyVersion: identifier,
  capturedAt: timestamp,
  source: z.enum(['legacy_checkpoint', 'resolved']),
}).strict();

const metricMapping = z.object({
  metricName: z.string().min(1).max(256),
  outcomeLabel: identifier,
  successValue: z.string().min(1).max(128),
  failureValue: z.string().min(1).max(128),
  serviceSelector: z.object({ label: identifier, value: identifier }).strict(),
  staticLabels: z.record(identifier, identifier),
}).strict();

const scenario = z.object({
  id: z.literal('window_failure_rate.v1'),
  version: revision,
  serviceId: identifier,
  serviceName: z.string().min(1).max(256),
  metricSemantics: z.literal('integer_window_snapshot'),
  metricMapping,
  threshold: z.number().finite().min(0).max(1),
  minSamples: z.number().int().positive().safe(),
}).strict();

const sourceBinding = z.object({
  sourceId: identifier,
  version: revision,
  kind: z.enum(['metrics', 'logs', 'trace', 'change']),
  adapterId: identifier,
  required: z.boolean(),
  allowedServiceIds: z.array(identifier).min(1).max(32),
}).strict();

const knowledgeRef = z.object({
  id: identifier,
  version: revision,
  digest: hexDigest,
  approval: z.literal('approved'),
}).strict();

const snapshotBase = z.object({
  schemaVersion: z.literal(1),
  targetId: identifier,
  projectId: identifier,
  deploymentId: identifier,
  deploymentGeneration: z.number().int().positive().safe(),
  environment: z.enum(['simulation', 'development', 'staging', 'production']),
  dataClass: z.enum(['simulated', 'live']),
  datasetId: identifier.optional(),
  targetFingerprint: identifier,
  profile: profileSnapshot,
  scenario,
  sourceBindings: z.array(sourceBinding).min(1).max(8),
  unavailableOptionalSourceIds: z.array(identifier).max(8),
  knowledgeRefs: z.array(knowledgeRef).max(20),
  memoryScope: memoryScopeSchema,
  capturedAt: timestamp,
  digest: snapshotDigest,
});

const resolvedSnapshot = z.discriminatedUnion('dataClass', [
  snapshotBase.extend({
    dataClass: z.literal('simulated'),
    environment: z.enum(['simulation', 'development', 'staging']),
    datasetId: identifier,
  }).strict(),
  snapshotBase.extend({
    dataClass: z.literal('live'),
    environment: z.enum(['development', 'staging', 'production']),
    datasetId: z.never().optional(),
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.profile.profileId !== value.memoryScope.profileId
    || value.profile.revision !== value.memoryScope.profileRevision
    || value.scenario.serviceId !== value.memoryScope.serviceId
    || value.scenario.id !== value.memoryScope.faultType
    || value.targetFingerprint !== value.memoryScope.targetFingerprint
    || value.environment !== value.memoryScope.environment
    || value.dataClass !== value.memoryScope.dataClass
    || (value.dataClass === 'simulated' && (value.memoryScope.dataClass !== 'simulated'
      || value.datasetId !== value.memoryScope.datasetId))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['memoryScope'], message: 'Target memory scope does not match its snapshot.' });
  }
  if (new Set(value.sourceBindings.map(source => source.sourceId)).size !== value.sourceBindings.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceBindings'], message: 'Target source IDs must be unique.' });
  }
});

const bindingRecord = z.object({
  bindingId: identifier,
  targetId: identifier,
  runId: identifier,
  rootRunId: identifier,
  snapshotDigest,
  createdAt: timestamp,
  requestId: identifier.optional(),
  requestDigest: snapshotDigest.optional(),
}).strict().superRefine((value, ctx) => {
  const hasRequest = value.requestId !== undefined && value.requestDigest !== undefined;
  const partialRequest = (value.requestId === undefined) !== (value.requestDigest === undefined);
  if (partialRequest || (value.runId === value.rootRunId) !== hasRequest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['requestId'], message: 'Root Run request identity is invalid.' });
  }
});

const requestRecord = z.object({
  requestId: identifier,
  targetId: identifier,
  requestDigest: snapshotDigest,
  runId: identifier,
  createdAt: timestamp,
}).strict();

export function parseResolvedTargetSnapshot(value: unknown): ResolvedTargetSnapshot {
  try {
    const parsed = resolvedSnapshot.parse(value) as ResolvedTargetSnapshot;
    const { digest, ...unsigned } = parsed;
    const expected = `sha256:v1:${checkpointChecksum({ algorithm: 'sha256', version: 1, target: unsigned })}`;
    if (digest !== expected) throw new Error('Target snapshot digest mismatch.');
    return deepFreeze(structuredClone(parsed));
  } catch {
    throw new TargetConfigurationError('TARGET_SNAPSHOT_UNAVAILABLE');
  }
}

export function parseTargetRunBindingRecord(value: unknown): TargetRunBindingRecord {
  try {
    const parsed = bindingRecord.parse(value);
    return structuredClone({
      bindingId: parsed.bindingId,
      targetId: parsed.targetId,
      runId: parsed.runId,
      rootRunId: parsed.rootRunId,
      snapshotDigest: parsed.snapshotDigest,
      createdAt: parsed.createdAt,
      ...(parsed.requestId === undefined ? {} : { requestId: parsed.requestId }),
      ...(parsed.requestDigest === undefined ? {} : { requestDigest: parsed.requestDigest }),
    });
  } catch {
    throw new TargetConfigurationError('TARGET_BINDING_INVALID');
  }
}

export function parseTargetRunRequestRecord(value: unknown): TargetRunRequestRecord {
  try {
    return structuredClone(requestRecord.parse(value));
  } catch {
    throw new TargetConfigurationError('TARGET_BINDING_INVALID');
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
