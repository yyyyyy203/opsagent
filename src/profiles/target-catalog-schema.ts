import { z } from 'zod';
import {
  TargetConfigurationError,
  type TargetCatalogDefinition,
  type TargetCatalogParseResult,
} from '../contracts/target.js';

const identifier = z.string().min(1).max(128)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u);
const revision = z.string().min(1).max(128)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}._:/-]*$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/iu);
const metricName = z.string().min(1).max(256)
  .regex(/^[a-zA-Z_:][a-zA-Z0-9_:]*$/u);
const labelName = z.string().min(1).max(128)
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/u);
const boundedText = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0);

const metricMapping = z.object({
  metricName,
  outcomeLabel: labelName,
  successValue: boundedText(128),
  failureValue: boundedText(128),
  serviceSelector: z.object({ label: labelName, value: boundedText(128) }).strict(),
  staticLabels: z.record(labelName, boundedText(128)).refine(value => Object.keys(value).length <= 32),
}).strict().superRefine((value, ctx) => {
  if (value.successValue === value.failureValue) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['failureValue'], message: 'Outcome values must differ.' });
  }
  if (Object.hasOwn(value.staticLabels, value.outcomeLabel)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['staticLabels'], message: 'Outcome label cannot also be static.' });
  }
  if (Object.hasOwn(value.staticLabels, value.serviceSelector.label)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['serviceSelector'], message: 'Service label cannot also be static.' });
  }
  if (value.serviceSelector.label === value.outcomeLabel) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['serviceSelector'], message: 'Service and outcome labels must differ.' });
  }
});

const sourceBinding = z.object({
  sourceId: identifier,
  version: revision,
  kind: z.enum(['metrics', 'logs', 'trace', 'change']),
  adapterId: identifier,
  required: z.boolean(),
  allowedServiceIds: z.array(identifier).min(1).max(32),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.allowedServiceIds).size !== value.allowedServiceIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedServiceIds'], message: 'Service IDs must be unique.' });
  }
});

const knowledgeReference = z.object({
  id: identifier,
  version: identifier,
  digest,
  approval: z.literal('approved'),
}).strict();

const scenario = z.object({
  id: z.literal('window_failure_rate.v1'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  serviceId: identifier,
  serviceName: boundedText(128),
  metricSemantics: z.literal('integer_window_snapshot'),
  metricMapping,
  threshold: z.number().finite().min(0).max(1),
  minSamples: z.number().int().positive().safe(),
}).strict();

const commonTarget = z.object({
  targetId: identifier,
  projectId: identifier,
  projectName: boundedText(120),
  deploymentId: identifier,
  deploymentGeneration: z.number().int().positive().safe(),
  environment: z.enum(['simulation', 'development', 'staging', 'production']),
  dataClass: z.enum(['simulated', 'live']),
  targetFingerprint: identifier,
  profileId: identifier,
  profileRevision: revision,
  displayName: boundedText(120),
  description: z.string().max(500),
  enabled: z.boolean(),
  scenario,
  sourceBindings: z.array(sourceBinding).min(1).max(8),
  knowledgeRefs: z.array(knowledgeReference).max(20),
}).strict();

const target = z.discriminatedUnion('dataClass', [
  commonTarget.extend({
    dataClass: z.literal('simulated'),
    environment: z.enum(['simulation', 'development', 'staging']),
    datasetId: identifier,
  }).strict(),
  commonTarget.extend({
    dataClass: z.literal('live'),
    environment: z.enum(['development', 'staging', 'production']),
    datasetId: z.never().optional(),
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.scenario.id !== 'window_failure_rate.v1') return;
  const sourceIds = value.sourceBindings.map(source => source.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceBindings'], message: 'Source IDs must be unique.' });
  }
  const metricSource = value.sourceBindings.find(source => source.kind === 'metrics' && source.required);
  if (metricSource === undefined || !metricSource.allowedServiceIds.includes(value.scenario.serviceId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceBindings'], message: 'Scenario requires an allowed metrics source.' });
  }
  if (value.sourceBindings.some(source => !source.allowedServiceIds.includes(value.scenario.serviceId))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceBindings'], message: 'Every source scope must include the Target service.' });
  }
  const knowledgeIds = value.knowledgeRefs.map(reference => reference.id);
  if (new Set(knowledgeIds).size !== knowledgeIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['knowledgeRefs'], message: 'Knowledge references must be unique.' });
  }
});

const catalogEnvelope = z.object({
  schemaVersion: z.literal(1),
  targets: z.array(z.unknown()).max(10_000),
}).strict();

const safeIdentity = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u;

/** Parse a host-owned catalog. Bad entries are isolated; identity collisions fail closed. */
export function parseTargetCatalog(
  input: unknown,
  options: { maxRegisteredTargets?: number } = {},
): TargetCatalogParseResult {
  const envelope = catalogEnvelope.safeParse(input);
  if (!envelope.success) throw new TargetConfigurationError('TARGET_CATALOG_INVALID');
  const maxRegisteredTargets = options.maxRegisteredTargets ?? 200;
  if (!Number.isSafeInteger(maxRegisteredTargets) || maxRegisteredTargets < 1 || maxRegisteredTargets > 10_000) {
    throw new TargetConfigurationError('TARGET_CATALOG_INVALID');
  }
  if (envelope.data.targets.length > maxRegisteredTargets) {
    throw new TargetConfigurationError('TARGET_CATALOG_LIMIT_EXCEEDED');
  }

  const targetIdCounts = new Map<string, number>();
  const profileIdCounts = new Map<string, number>();
  envelope.data.targets.forEach((candidate) => {
    if (!isRecord(candidate)) return;
    countSafe(candidate.targetId, targetIdCounts);
    countSafe(candidate.profileId, profileIdCounts);
  });

  const accepted: TargetCatalogDefinition[] = [];
  const rejected: TargetCatalogParseResult['rejected'][number][] = [];
  envelope.data.targets.forEach((candidate, index) => {
    const identity = safeCandidateIdentity(candidate);
    const collides = identity !== undefined
      && ((targetIdCounts.get(identity.targetId) ?? 0) > 1 || (profileIdCounts.get(identity.profileId) ?? 0) > 1);
    const parsed = target.safeParse(candidate);
    if (collides || !parsed.success) {
      rejected.push({
        index,
        ...(identity === undefined ? {} : { targetId: identity.targetId }),
        reasonCode: 'TARGET_BINDING_INVALID',
      });
      return;
    }
    accepted.push(parsed.data as TargetCatalogDefinition);
  });
  return { targets: accepted, rejected };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeCandidateIdentity(value: unknown): { targetId: string; profileId: string } | undefined {
  if (!isRecord(value) || typeof value.targetId !== 'string' || typeof value.profileId !== 'string'
    || !safeIdentity.test(value.targetId) || !safeIdentity.test(value.profileId)) return undefined;
  return { targetId: value.targetId, profileId: value.profileId };
}

function countSafe(value: unknown, counts: Map<string, number>): void {
  if (typeof value !== 'string' || !safeIdentity.test(value)) return;
  counts.set(value, (counts.get(value) ?? 0) + 1);
}
