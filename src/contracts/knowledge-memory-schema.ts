import { z } from 'zod';
import { checkpointChecksum } from './stable-json.js';
import {
  KnowledgeContractError,
  type KnowledgeDiagnosisQualificationV1,
  type KnowledgeReviewCommand,
  type KnowledgeRevision,
  type KnowledgeScope,
  type KnowledgeStatus,
  type KnowledgeKind,
} from './knowledge-memory.js';
import type { TargetKnowledgeReference } from './target.js';

const networkAddressPattern = /(?:\b[a-z][a-z\d+.-]*:\/\/|\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b|\b(?:localhost|[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)*):\d{1,5}\b|\[[\da-f:]{2,}\](?::\d{1,5})?|(?<![a-z\d:])(?:[a-f\d]{0,4}:){1,7}:[a-f\d]{0,4}(?![a-z\d:])|(?<![a-z\d:])(?:[a-f\d]{1,4}:){7}[a-f\d]{1,4}(?![a-z\d:]))/iu;
const basicAuthorizationPattern = /\b(?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?basic\s+([a-z\d+/]+={0,2})(?![a-z\d+/=])/giu;
const credentialPattern = /(?:\bbearer\s+[a-z\d._~+/-]{20,}=*|\bbasic\s+[a-z\d+/]{16,}={0,2}|\b(?:[a-z\d]+_)*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|credentials?)\s*[:=]\s*["']?[^\s"']{6,}|(?:^|[^a-z\d])(?:sk-[a-z\d_-]{12,}|gh[pousr]_[a-z\d_]{12,}|github_pat_[a-z\d_]{20,})|\bAKIA[0-9A-Z]{16}\b)/iu;
function containsBasicAuthorizationCredential(value: string): boolean {
  for (const match of value.matchAll(basicAuthorizationPattern)) {
    const encoded = match[1];
    if (!encoded || encoded.length % 4 === 1) continue;

    const decoded = Buffer.from(encoded, 'base64');
    const canonical = decoded.toString('base64');
    const hasPadding = encoded.endsWith('=');
    if (hasPadding ? canonical !== encoded : canonical.replace(/=+$/u, '') !== encoded) continue;
    if (decoded.includes(0x3a)) return true;
  }
  return false;
}
const containsNetworkAddressOrCredential = (value: string): boolean =>
  networkAddressPattern.test(value) || credentialPattern.test(value)
  || containsBasicAuthorizationCredential(value);
const shellPromptPattern = /(?:^|\n)\s*(?:\$\s+|PS\s+[A-Z]:\\)/iu;
const shellCommandPatterns = [
  /\bkubectl\s+(?:get|describe|logs|rollout|exec|delete|apply|scale|patch)\b/iu,
  /\bdocker\s+(?:run|exec|build|compose|rm|stop|restart|inspect)\b/iu,
  /\bgit\s+(?:status|diff|log|show|branch|checkout|switch|commit|push|pull|fetch|reset|rebase|merge)\b/iu,
  /\b(?:pnpm|npm|yarn)\s+(?:install|run|test|build|start|exec|add|remove|publish)\b/iu,
  /\b(?:node|python3?|rg|grep|find|cat|ls|head|tail|sed|awk|jq)\s+[-\w./]/iu,
  /\b(?:curl|wget)\s+(?:-[A-Za-z]|--[a-z-]+)\b/iu,
  /\b(?:rm\s+-[rf]+|chmod\s+(?:[0-7]{3,4}|[ugoa]*[+=-][rwxXst]+)|chown\s+\S+:\S+\s+\S+)\b/iu,
  /\bsystemctl\s+(?:start|stop|restart|reload|enable|disable)\b/iu,
  /\b(?:bash|sh)\s+-c\b|\b(?:powershell(?:\.exe)?|pwsh)\s+-Command\b/iu,
  /\b(?:mysql\s+-e|psql\s+-c|sqlite3\s+\S+\s+['"])/iu,
  /\bInvoke-(?:WebRequest|RestMethod|Expression|Command)\b/iu,
] as const;
const sqlStatementPattern = /\b(?:SELECT\s+.{1,256}?\s+FROM\s+\S+|INSERT\s+INTO\s+\S+|UPDATE\s+\S+\s+SET\b|DELETE\s+FROM\s+\S+|ALTER\s+TABLE\s+\S+|DROP\s+(?:TABLE|DATABASE)\s+\S+|CREATE\s+(?:TABLE|INDEX|DATABASE)\s+\S+|TRUNCATE\s+TABLE\s+\S+)/iu;
const sqlPrivilegeStatementPattern = /\b(?:GRANT|REVOKE)\s+(?:ALL(?:\s+PRIVILEGES)?|(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|USAGE|EXECUTE|CREATE|CONNECT|TEMP(?:ORARY)?)(?:\s*,\s*(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|USAGE|EXECUTE|CREATE|CONNECT|TEMP(?:ORARY)?))*)(?:\s+PRIVILEGES)?\s+ON\s+(?:(?:TABLE|SCHEMA|DATABASE|SEQUENCE|FUNCTION|PROCEDURE|TYPE)\s+)?[\w.-]+\s+(?:TO|FROM)\s+[\w.-]+/iu;
const sqlRoleIdentifierPattern = String.raw`(?:"[^"\r\n]+"|[\w.-]+)`;
const sqlRoleListPattern = String.raw`${sqlRoleIdentifierPattern}(?:\s*,\s*${sqlRoleIdentifierPattern})*`;
const sqlRoleMembershipStatementPattern = new RegExp(
  String.raw`(?:^|[\r\n]|:\s*)\s*(?:GRANT\s+(?:ROLE\s+)?${sqlRoleListPattern}\s+TO\s+${sqlRoleListPattern}|REVOKE\s+(?:${sqlRoleListPattern}\s+FROM\s+${sqlRoleListPattern}|(?:ADMIN|GRANT)\s+OPTION\s+FOR\s+${sqlRoleListPattern}\s+FROM\s+${sqlRoleListPattern}))\s*;`,
  'iu',
);
const rawHttpRequestPattern = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/[^\s]*\s+HTTP\/\d(?:\.\d)?(?:\s|$)/iu;
const toolJsonPattern = (value: string): boolean => value.includes('{') && value.includes('}')
  && /"(?:tool|toolName|tool_name|name)"\s*:/iu.test(value)
  && /"(?:arguments|input)"\s*:/iu.test(value);
const executableDeclarationPattern = /(?:^|\n)\s*(?:(?:const|let|var)\s+[$\w]+\s*=|(?:async\s+)?function\s+[$\w]+\s*\(|def\s+[$\w]+\s*\()/imu;
const executableInvocationPattern = /\b(?:await\s+)?[$\w]+(?:\.[$\w]+)*\s*\([^()\n]*\)/iu;
const containsExecutableOrRequestSyntax = (value: string): boolean => shellPromptPattern.test(value)
  || shellCommandPatterns.some((pattern) => pattern.test(value))
  || sqlStatementPattern.test(value) || sqlPrivilegeStatementPattern.test(value)
  || sqlRoleMembershipStatementPattern.test(value) || rawHttpRequestPattern.test(value)
  || toolJsonPattern(value) || executableDeclarationPattern.test(value)
  || executableInvocationPattern.test(value) || /```|=>/u.test(value);
const proceduralProse = (maxBytes: number) => boundedText(maxBytes).refine(
  (value) => !containsExecutableOrRequestSyntax(value),
  'Procedural prose cannot contain command, query, request, Tool JSON, or code syntax',
);
export const safeKnowledgeIdentifierSchema = z.string().min(1).max(256)
  .refine((value) => value.trim().length > 0)
  .refine((value) => !containsNetworkAddressOrCredential(value),
    'Knowledge identifiers cannot contain network addresses or credential-like values');
const identifier = safeKnowledgeIdentifierSchema;
const boundedText = (maxBytes: number) => z.string().min(1).max(maxBytes)
  .refine((value) => value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes)
  .refine((value) => !containsNetworkAddressOrCredential(value),
    'Knowledge content cannot contain network addresses or credential-like values');
const timestamp = z.string().max(64).datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)));
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const positiveVersion = z.number().int().positive().safe();
const epoch = z.number().int().nonnegative().safe();

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    value.forEach((entry) => { deepFreeze(entry); });
  } else {
    Object.values(value as Record<string, unknown>).forEach((entry) => { deepFreeze(entry); });
  }
  return Object.freeze(value);
}

const knowledgeScopeBaseSchema = z.object({
  targetId: identifier,
  projectId: identifier,
  deploymentId: identifier,
  deploymentGeneration: positiveVersion,
  targetFingerprint: identifier,
  profileId: identifier,
  profileRevision: identifier,
  scenarioId: identifier,
  scenarioVersion: identifier,
  serviceIds: z.array(identifier).min(1).max(64),
  faultTypes: z.array(identifier).min(1).max(64),
}).strict();

export const knowledgeScopeSchema = z.discriminatedUnion('dataClass', [
  knowledgeScopeBaseSchema.extend({
    environment: z.enum(['simulation', 'development', 'staging']),
    dataClass: z.literal('simulated'),
    datasetId: identifier,
  }).strict(),
  knowledgeScopeBaseSchema.extend({
    environment: z.enum(['development', 'staging', 'production']),
    dataClass: z.literal('live'),
  }).strict(),
]).superRefine((scope, ctx) => {
  if (new Set(scope.serviceIds).size !== scope.serviceIds.length) {
    ctx.addIssue({ code: 'custom', path: ['serviceIds'], message: 'Knowledge scope service IDs must be unique.' });
  }
  if (new Set(scope.faultTypes).size !== scope.faultTypes.length) {
    ctx.addIssue({ code: 'custom', path: ['faultTypes'], message: 'Knowledge scope fault types must be unique.' });
  }
});

const sourceReferenceSchema = z.object({ sourceId: identifier, sourceVersion: identifier, digest }).strict();
const provenanceSchema = z.object({
  sourceType: z.enum(['target_profile', 'controlled_runbook', 'operator_provided']),
  sourceId: identifier,
  sourceVersion: identifier,
  sourceDigest: digest,
  importedAt: timestamp,
}).strict();
const reviewChecksSchema = z.object({
  sourceVerified: z.boolean(),
  scopeVerified: z.boolean(),
  contentReviewed: z.boolean(),
}).strict();
const reviewRecordSchema = z.object({
  reviewerId: identifier,
  reviewedAt: timestamp,
  checks: reviewChecksSchema,
  sourceVerification: z.object({ sourceEpoch: epoch, sourceDigest: digest }).strict(),
}).strict();

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): boolean {
  return new Set(values.map(key)).size === values.length;
}

const sourceReferencesSchema = z.array(sourceReferenceSchema).min(1).max(16)
  .refine((values) => uniqueBy(values, (value) => `${value.sourceId}\u0000${value.sourceVersion}`),
    'Knowledge source references must be unique');
const serviceTopologySchema = z.object({
  type: z.literal('service_topology'),
  effectiveFrom: timestamp,
  effectiveUntil: timestamp.optional(),
  services: z.array(z.object({
    serviceId: identifier,
    displayName: boundedText(128),
    description: boundedText(512).optional(),
  }).strict()).min(1).max(64)
    .refine((values) => uniqueBy(values, (value) => value.serviceId), 'Topology service IDs must be unique'),
  dependencies: z.array(z.object({
    fromServiceId: identifier,
    toServiceId: identifier,
    relation: z.enum(['depends_on', 'calls', 'publishes_to', 'reads_from', 'writes_to']),
  }).strict()).max(256)
    .refine((values) => uniqueBy(values, (value) => `${value.fromServiceId}\u0000${value.toServiceId}\u0000${value.relation}`),
      'Topology dependencies must be unique'),
}).strict().superRefine((value, ctx) => {
  const serviceIds = new Set(value.services.map((service) => service.serviceId));
  for (const [index, dependency] of value.dependencies.entries()) {
    if (!serviceIds.has(dependency.fromServiceId) || !serviceIds.has(dependency.toServiceId)) {
      ctx.addIssue({ code: 'custom', path: ['dependencies', index], message: 'Topology edges must reference declared services.' });
    }
  }
  if (value.effectiveUntil && Date.parse(value.effectiveUntil) <= Date.parse(value.effectiveFrom)) {
    ctx.addIssue({ code: 'custom', path: ['effectiveUntil'], message: 'Topology validity must have positive duration.' });
  }
});

const metricDefinitionSchema = z.object({
  type: z.literal('metric_definition'),
  metricName: z.string().min(1).max(256).regex(/^[a-zA-Z_:][a-zA-Z0-9_:]*$/u),
  businessMeaning: boundedText(2048),
  unit: boundedText(64),
  labels: z.array(z.object({ name: identifier, meaning: boundedText(512) }).strict()).max(64)
    .refine((values) => uniqueBy(values, (value) => value.name), 'Metric label names must be unique'),
  allowedAggregations: z.array(z.enum(['count', 'sum', 'avg', 'min', 'max', 'rate', 'increase', 'last'])).min(1).max(8)
    .refine((values) => new Set(values).size === values.length, 'Metric aggregations must be unique'),
  windowSemantics: z.array(z.enum(['instant', 'fixed_window', 'rolling_window', 'cumulative'])).min(1).max(4)
    .refine((values) => new Set(values).size === values.length, 'Metric window semantics must be unique'),
  sourceReferences: sourceReferencesSchema,
}).strict();

const domainGlossarySchema = z.object({
  type: z.literal('domain_glossary'),
  terms: z.array(z.object({
    term: boundedText(128),
    definition: boundedText(2048),
    sourceReference: sourceReferenceSchema,
  }).strict()).min(1).max(64)
    .refine((values) => uniqueBy(values, (value) => value.term.toLocaleLowerCase('en-US')),
      'Glossary terms must be unique'),
}).strict();

// Defense in depth only: T4 must resolve this exact ID against the host-owned readonly capability registry.
const readOnlyCapabilityId = z.string().min(1).max(128)
  .regex(/^[a-z][a-z0-9_-]*\.(?:query|search|lookup|list|read|get|fetch|inspect|aggregate|capture|calculate|detect|rank|correlate|trace)(?:_[a-z0-9]+)*$/iu,
    'Procedural capabilities must use a recognized read-only or deterministic-analysis verb');

const semanticContentSchema = z.union([
  serviceTopologySchema,
  metricDefinitionSchema,
  domainGlossarySchema,
]);

/** Public strict content parsers shared by API boundaries and the governance services. */
export const semanticKnowledgeContentSchema = semanticContentSchema;

const proceduralContentSchema = z.object({
  type: z.literal('investigation_template'),
  templateId: identifier,
  scenario: z.object({ id: identifier, version: identifier }).strict(),
  applicableTo: z.object({
    serviceIds: z.array(identifier).min(1).max(64),
    faultTypes: z.array(identifier).min(1).max(64),
    environments: z.array(z.enum(['simulation', 'development', 'staging', 'production'])).min(1).max(4)
      .refine((values) => new Set(values).size === values.length, 'Applicable environments must be unique'),
  }).strict().superRefine((value, ctx) => {
    if (new Set(value.serviceIds).size !== value.serviceIds.length) {
      ctx.addIssue({ code: 'custom', path: ['serviceIds'], message: 'Applicable service IDs must be unique.' });
    }
    if (new Set(value.faultTypes).size !== value.faultTypes.length) {
      ctx.addIssue({ code: 'custom', path: ['faultTypes'], message: 'Applicable fault types must be unique.' });
    }
  }),
  preconditions: z.array(proceduralProse(512)).min(1).max(32),
  requiredEvidence: z.array(z.object({
    category: z.enum(['metric', 'log', 'trace', 'change']),
    minimumCount: z.number().int().positive().safe(),
  }).strict()).max(8).refine((values) => new Set(values.map((value) => value.category)).size === values.length,
    'Required evidence categories must be unique'),
  steps: z.array(z.object({
    step: positiveVersion,
    goal: proceduralProse(512),
    capabilityId: readOnlyCapabilityId,
    completionCriterion: proceduralProse(512),
  }).strict()).min(1).max(32).refine((values) => uniqueBy(values, (value) => String(value.step)),
    'Procedural step numbers must be unique').refine((values) => values.every((value, index) => value.step === index + 1),
    'Procedural steps must be sequential'),
  stopConditions: z.array(proceduralProse(512)).min(1).max(32),
  expectedReportFields: z.array(identifier).min(1).max(32)
    .refine((values) => new Set(values).size === values.length, 'Report fields must be unique'),
  limitations: z.array(proceduralProse(512)).max(32),
  sourceReferences: sourceReferencesSchema,
}).strict();

export const proceduralKnowledgeContentSchema = proceduralContentSchema;

const commonRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: identifier,
  contentRevision: positiveVersion,
  governanceVersion: positiveVersion,
  sourceEpoch: epoch,
  status: z.enum(['draft', 'review_pending', 'approved', 'rejected', 'revoked', 'expired', 'conflict', 'superseded']),
  createdAt: timestamp,
  validUntil: timestamp.optional(),
  scope: knowledgeScopeSchema,
  provenance: provenanceSchema,
  contentDigest: digest,
  review: reviewRecordSchema.optional(),
});

export const knowledgeRecordSchema = z.discriminatedUnion('kind', [
  commonRecordSchema.extend({ kind: z.literal('semantic'), content: semanticContentSchema }).strict(),
  commonRecordSchema.extend({ kind: z.literal('procedural'), content: proceduralContentSchema }).strict(),
]).superRefine((record, ctx) => {
  const scopedServices = new Set(record.scope.serviceIds);
  const scopedFaultTypes = new Set(record.scope.faultTypes);
  if (record.kind === 'semantic' && record.content.type === 'service_topology'
    && record.content.services.some((service) => !scopedServices.has(service.serviceId))) {
    ctx.addIssue({ code: 'custom', path: ['scope'], message: 'Topology services must stay within the record Target scope.' });
  }
  if (record.kind === 'procedural') {
    const applicableTo = record.content.applicableTo;
    if (record.content.scenario.id !== record.scope.scenarioId
      || record.content.scenario.version !== record.scope.scenarioVersion
      || applicableTo.serviceIds.some((serviceId) => !scopedServices.has(serviceId))
      || applicableTo.faultTypes.some((faultType) => !scopedFaultTypes.has(faultType))
      || applicableTo.environments.some((environment) => environment !== record.scope.environment)) {
      ctx.addIssue({ code: 'custom', path: ['scope'], message: 'Procedural applicability must stay within the record Target scope.' });
    }
  }
  if (record.validUntil && Date.parse(record.validUntil) <= Date.parse(record.createdAt)) {
    ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'Knowledge validity must follow creation time.' });
  }
  if (record.status === 'approved') {
    if (!record.review) {
      ctx.addIssue({ code: 'custom', path: ['review'], message: 'Approved knowledge requires a review record.' });
    } else {
      if (!record.review.checks.sourceVerified || !record.review.checks.scopeVerified || !record.review.checks.contentReviewed) {
        ctx.addIssue({ code: 'custom', path: ['review', 'checks'], message: 'Approval requires all declared checks.' });
      }
      if (record.review.sourceVerification.sourceEpoch !== record.sourceEpoch
        || record.review.sourceVerification.sourceDigest !== record.provenance.sourceDigest) {
        ctx.addIssue({ code: 'custom', path: ['review', 'sourceVerification'], message: 'Review must match the current source epoch and digest.' });
      }
      if (Date.parse(record.review.reviewedAt) < Date.parse(record.createdAt)) {
        ctx.addIssue({ code: 'custom', path: ['review', 'reviewedAt'], message: 'Review cannot predate the revision.' });
      }
    }
  }
  if (checkpointChecksum(record.content) !== record.contentDigest) {
    ctx.addIssue({ code: 'custom', path: ['contentDigest'], message: 'Knowledge content digest does not match content.' });
  }
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > 24 * 1024) {
    ctx.addIssue({ code: 'custom', message: 'Knowledge revision exceeds its byte budget.' });
  }
});

export const knowledgeReviewCommandSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: identifier,
  knowledgeId: identifier,
  kind: z.enum(['semantic', 'procedural']),
  expectedContentRevision: positiveVersion,
  expectedGovernanceVersion: positiveVersion,
  contentDigest: digest,
  decision: z.enum(['approve', 'reject']),
  checks: reviewChecksSchema,
  reasonCode: identifier.refine((value) => value.length <= 128).optional(),
}).strict().superRefine((command, ctx) => {
  if (command.decision === 'approve'
    && (!command.checks.sourceVerified || !command.checks.scopeVerified || !command.checks.contentReviewed)) {
    ctx.addIssue({ code: 'custom', path: ['checks'], message: 'Approval requires all checks to be true.' });
  }
});

const targetKnowledgeReferenceSchema = z.object({
  id: identifier,
  version: z.string().regex(/^[1-9]\d*$/u)
    .refine((value) => Number.isSafeInteger(Number(value))),
  digest,
  approval: z.literal('approved'),
}).strict();

const knowledgeLimitationReasons = [
  'KNOWLEDGE_NOT_FOUND', 'KNOWLEDGE_NOT_APPROVED', 'KNOWLEDGE_REVOKED', 'KNOWLEDGE_EXPIRED',
  'KNOWLEDGE_SUPERSEDED', 'KNOWLEDGE_CONFLICT', 'KNOWLEDGE_SCOPE_MISMATCH', 'KNOWLEDGE_DIGEST_MISMATCH',
  'KNOWLEDGE_SOURCE_REVOKED', 'KNOWLEDGE_TYPE_DISABLED', 'KNOWLEDGE_STORAGE_UNAVAILABLE',
  'KNOWLEDGE_DEADLINE_EXCEEDED', 'KNOWLEDGE_BUDGET_EXCEEDED', 'KNOWLEDGE_REQUIRED_DISABLED',
  'OPTIONAL_KNOWLEDGE_OMITTED',
] as const;
const missingKnowledgeSchema = z.object({
  reference: targetKnowledgeReferenceSchema,
  kind: z.enum(['semantic', 'procedural']),
  requiredness: z.enum(['optional', 'required']),
  reasonCode: z.enum(knowledgeLimitationReasons),
}).strict();

export const knowledgeDiagnosisQualificationSchema = z.object({
  schemaVersion: z.literal(1),
  diagnosisReady: z.boolean(),
  missingKnowledge: z.array(missingKnowledgeSchema).max(64),
  limitationReasons: z.array(z.enum(knowledgeLimitationReasons)).max(16)
    .refine((values) => new Set(values).size === values.length, 'Knowledge limitation reasons must be unique'),
}).strict().superRefine((qualification, ctx) => {
  const referenceKeys = qualification.missingKnowledge.map((item) => `${item.reference.id}\u0000${item.reference.version}`);
  if (new Set(referenceKeys).size !== referenceKeys.length) {
    ctx.addIssue({ code: 'custom', path: ['missingKnowledge'], message: 'Missing knowledge references must be unique.' });
  }
  if (qualification.diagnosisReady && qualification.missingKnowledge.some((item) => item.requiredness === 'required')) {
    ctx.addIssue({ code: 'custom', path: ['diagnosisReady'], message: 'A required knowledge gap prevents a ready diagnosis.' });
  }
  if (qualification.diagnosisReady && qualification.limitationReasons.some((reason) => reason !== 'OPTIONAL_KNOWLEDGE_OMITTED')) {
    ctx.addIssue({ code: 'custom', path: ['diagnosisReady'], message: 'A blocking knowledge limitation prevents a ready diagnosis.' });
  }
});

export function parseKnowledgeScope(value: unknown): KnowledgeScope {
  const parsed = knowledgeScopeSchema.safeParse(value);
  if (!parsed.success) throw new KnowledgeContractError('KNOWLEDGE_SCOPE_INVALID');
  return deepFreeze(structuredClone(parsed.data));
}

export function parseKnowledgeRecord(value: unknown): KnowledgeRevision {
  if (typeof value === 'object' && value !== null && 'scope' in value) {
    const scopeResult = knowledgeScopeSchema.safeParse(value.scope);
    if (!scopeResult.success) throw new KnowledgeContractError('KNOWLEDGE_SCOPE_INVALID');
  }
  const parsed = knowledgeRecordSchema.safeParse(value);
  if (!parsed.success) {
    if (parsed.error.issues.some((issue) => issue.path[0] === 'scope')) {
      throw new KnowledgeContractError('KNOWLEDGE_SCOPE_INVALID');
    }
    if (parsed.error.issues.length === 1 && parsed.error.issues[0]?.path[0] === 'contentDigest') {
      throw new KnowledgeContractError('KNOWLEDGE_DIGEST_MISMATCH');
    }
    throw new KnowledgeContractError('KNOWLEDGE_RECORD_INVALID');
  }
  return deepFreeze(structuredClone(parsed.data));
}

export function parseKnowledgeReviewCommand(value: unknown): KnowledgeReviewCommand {
  const parsed = knowledgeReviewCommandSchema.safeParse(value);
  if (!parsed.success) throw new KnowledgeContractError('KNOWLEDGE_REVIEW_COMMAND_INVALID');
  return deepFreeze(structuredClone(parsed.data));
}

export function parseKnowledgeDiagnosisQualification(value: unknown): KnowledgeDiagnosisQualificationV1 {
  const parsed = knowledgeDiagnosisQualificationSchema.safeParse(value);
  if (!parsed.success) throw new KnowledgeContractError('KNOWLEDGE_QUALIFICATION_INVALID');
  return deepFreeze(structuredClone(parsed.data));
}

/** Produces the existing Target reference shape; version is the content revision, not governance state. */
export function targetKnowledgeReferenceFor(input: {
  id: string;
  contentRevision: number;
  contentDigest: string;
  status: KnowledgeStatus;
}): TargetKnowledgeReference {
  if (input.status !== 'approved') throw new KnowledgeContractError('KNOWLEDGE_APPROVAL_DENIED');
  if (!Number.isSafeInteger(input.contentRevision) || input.contentRevision < 1
    || !digest.safeParse(input.contentDigest).success || !identifier.safeParse(input.id).success) {
    throw new KnowledgeContractError('KNOWLEDGE_RECORD_INVALID');
  }
  return { id: input.id, version: String(input.contentRevision), digest: input.contentDigest, approval: 'approved' };
}

export function contentRevisionFromTargetReference(reference: TargetKnowledgeReference): number {
  if (!/^[1-9]\d*$/u.test(reference.version)) throw new KnowledgeContractError('KNOWLEDGE_RECORD_INVALID');
  const revision = Number(reference.version);
  if (!Number.isSafeInteger(revision)) throw new KnowledgeContractError('KNOWLEDGE_RECORD_INVALID');
  return revision;
}

// These aliases keep type imports explicit for consumers building exhaustive discriminated handling.
export type { KnowledgeKind, KnowledgeStatus, KnowledgeScope };
