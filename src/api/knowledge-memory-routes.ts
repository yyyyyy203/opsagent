import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { KnowledgeKind, KnowledgeRevision } from '../contracts/knowledge-memory.js';
import { KnowledgeContractError } from '../contracts/knowledge-memory.js';
import { proceduralKnowledgeContentSchema, safeKnowledgeIdentifierSchema,
  semanticKnowledgeContentSchema } from '../contracts/knowledge-memory-schema.js';
import type { KnowledgeManagementService } from '../application/knowledge-management-service.js';

export type KnowledgeManagementApi = Pick<KnowledgeManagementService,
  'list' | 'targetStatus' | 'createSemanticDraft' | 'reviseSemanticDraft' | 'createProceduralDraft'
  | 'reviseProceduralDraft' | 'submitForReview' | 'review' | 'revoke' | 'publish' | 'revokeSource' | 'updatePolicy'>;

const id = safeKnowledgeIdentifierSchema;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const source = z.object({ sourceId: id, sourceVersion: id, digest }).strict();
const reference = z.object({ id, version: z.string().regex(/^[1-9]\d*$/u), digest,
  approval: z.literal('approved') }).strict();
const draftFields = { requestId: id, source, validUntil: z.string().datetime({ offset: true }).optional() };
const semanticDraftBody = z.object({ ...draftFields, content: semanticKnowledgeContentSchema }).strict();
const proceduralDraftBody = z.object({ ...draftFields, content: proceduralKnowledgeContentSchema }).strict();
const revisionFields = { expectedContentRevision: z.number().int().positive().safe(),
  expectedGovernanceVersion: z.number().int().positive().safe() };
const semanticReviseBody = semanticDraftBody.extend(revisionFields).strict();
const proceduralReviseBody = proceduralDraftBody.extend(revisionFields).strict();
const submitBody = z.object({ requestId: id, contentRevision: z.number().int().positive().safe(),
  governanceVersion: z.number().int().positive().safe() }).strict();
const reviewBody = submitBody.extend({ decision: z.enum(['approve', 'reject']), reasonCode: id.optional() }).strict();
const revokeBody = z.object({ requestId: id, contentRevision: z.number().int().positive().safe(),
  expectedGovernanceVersion: z.number().int().positive().safe() }).strict();
const publishBody = z.object({ requestId: id, expectedPublicationVersion: z.number().int().nonnegative().safe(),
  references: z.array(reference).max(20) }).strict();
const sourceRevokeBody = z.object({ requestId: id, sourceVersion: id,
  expectedSourceEpoch: z.number().int().nonnegative().safe() }).strict();
const policyVersion = z.string().min(1).max(128).regex(/^[\p{L}\p{N}][\p{L}\p{N}._:/-]*$/u)
  .refine(value => !value.includes('://'));
const policyRequirement = z.object({ id, version: z.string().regex(/^[1-9]\d*$/u), digest,
  requiredness: z.enum(['optional', 'required']), knowledgeClass: z.enum(['semantic', 'procedural']).optional() }).strict();
const policyBody = z.object({ requestId: id, policyVersion, expectedPolicyEpoch: z.number().int().nonnegative().safe().nullable(),
  requirements: z.array(policyRequirement).max(20) }).strict();
const statuses = ['draft', 'review_pending', 'approved', 'rejected', 'revoked', 'expired', 'conflict', 'superseded'] as const;
const knowledgePath = /^\/targets\/([^/]+)\/knowledge(?:\/(.*))?$/u;

/** Target IDs are selectors only; scope and actor always come from the injected host application. */
export async function handleKnowledgeMemoryRoute(request: IncomingMessage, response: ServerResponse, url: URL,
  api: KnowledgeManagementApi | undefined, readRequestBody: () => Promise<Record<string, unknown>>): Promise<boolean> {
  const match = knowledgePath.exec(url.pathname);
  if (match === null) return false;
  if (api === undefined) throw fail('KNOWLEDGE_STORAGE_UNAVAILABLE', 503);
  const method = request.method ?? 'GET';
  const targetId = pathId(match[1]!);
  const action = match[2] ?? '';
  try {
    if (method === 'GET' && action === 'status') {
      queryKeys(url, []);
      json(response, 200, await api.targetStatus(targetId));
      return true;
    }
    if (method === 'GET' && action === '') {
      queryKeys(url, ['kind', 'status', 'afterId', 'afterRevision', 'limit']);
      const query = z.object({ kind: z.enum(['semantic', 'procedural']), status: z.enum(statuses).optional(),
        afterId: id.optional(), afterRevision: z.coerce.number().int().positive().safe().optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20) }).strict().parse({
        ...(url.searchParams.has('kind') ? { kind: url.searchParams.get('kind') } : {}),
        ...(url.searchParams.has('status') ? { status: url.searchParams.get('status') } : {}),
        ...(url.searchParams.has('afterId') ? { afterId: url.searchParams.get('afterId') } : {}),
        ...(url.searchParams.has('afterRevision') ? { afterRevision: url.searchParams.get('afterRevision') } : {}),
        ...(url.searchParams.has('limit') ? { limit: url.searchParams.get('limit') } : {}),
      });
      if ((query.afterId === undefined) !== (query.afterRevision === undefined)) throw fail('KNOWLEDGE_RECORD_INVALID', 400);
      const revisions = await api.list({ targetId, kind: query.kind, ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.afterId === undefined ? {} : { after: { id: query.afterId, contentRevision: query.afterRevision! } }),
        limit: query.limit });
      json(response, 200, { items: revisions.map(publicRevision) });
      return true;
    }
    if (method === 'GET' && action === 'publication') {
      queryKeys(url, []);
      json(response, 200, await api.targetStatus(targetId));
      return true;
    }
    if (method === 'PUT' && action === 'policy') {
      queryKeys(url, []);
      const body = await readRequestBody();
      const input = policyBody.parse(body);
      json(response, 200, await api.updatePolicy(targetId, {
        requestId: input.requestId,
        policyVersion: input.policyVersion,
        expectedPolicyEpoch: input.expectedPolicyEpoch,
        requirements: input.requirements.map(requirement => ({
          id: requirement.id,
          version: requirement.version,
          digest: requirement.digest,
          requiredness: requirement.requiredness,
          ...(requirement.knowledgeClass === undefined ? {} : { knowledgeClass: requirement.knowledgeClass }),
        })),
      }));
      return true;
    }
    if (method !== 'POST') throw fail('NOT_FOUND', 404);
    queryKeys(url, []);
    const body = await readRequestBody();
    const createMatch = /^(semantic|procedural)\/drafts$/u.exec(action);
    if (createMatch !== null) {
      const kind = createMatch[1] as KnowledgeKind;
      const result = kind === 'semantic'
        ? await (async () => {
          const input = semanticDraftBody.parse(body);
          return api.createSemanticDraft(targetId, { requestId: input.requestId, source: input.source, content: input.content,
            ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }) });
        })()
        : await (async () => {
          const input = proceduralDraftBody.parse(body);
          return api.createProceduralDraft(targetId, { requestId: input.requestId, source: input.source, content: input.content,
            ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }) });
        })();
      json(response, 201, publicRevision(result));
      return true;
    }
    const reviseMatch = /^(semantic|procedural)\/([^/]+)\/revisions$/u.exec(action);
    if (reviseMatch !== null) {
      const kind = reviseMatch[1] as KnowledgeKind;
      const knowledgeId = pathId(reviseMatch[2]!);
      const result = kind === 'semantic'
        ? await (async () => {
          const input = semanticReviseBody.parse(body);
          return api.reviseSemanticDraft(targetId, { requestId: input.requestId, source: input.source,
            content: input.content, knowledgeId, expectedContentRevision: input.expectedContentRevision,
            expectedGovernanceVersion: input.expectedGovernanceVersion,
            ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }) });
        })()
        : await (async () => {
          const input = proceduralReviseBody.parse(body);
          return api.reviseProceduralDraft(targetId, { requestId: input.requestId, source: input.source,
            content: input.content, knowledgeId, expectedContentRevision: input.expectedContentRevision,
            expectedGovernanceVersion: input.expectedGovernanceVersion,
            ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }) });
        })();
      json(response, 200, publicRevision(result));
      return true;
    }
    const submitMatch = /^(semantic|procedural)\/([^/]+)\/submit$/u.exec(action);
    if (submitMatch !== null) {
      const kind = submitMatch[1] as KnowledgeKind;
      const knowledgeId = pathId(submitMatch[2]!);
      const input = submitBody.parse(body);
      json(response, 200, publicRevision(await api.submitForReview(targetId, kind, { ...input, knowledgeId })));
      return true;
    }
    const reviewMatch = /^(semantic|procedural)\/([^/]+)\/review$/u.exec(action);
    if (reviewMatch !== null) {
      const kind = reviewMatch[1] as KnowledgeKind;
      const knowledgeId = pathId(reviewMatch[2]!);
      const input = reviewBody.parse(body);
      json(response, 200, publicRevision(await api.review(targetId, kind, { requestId: input.requestId, knowledgeId,
        contentRevision: input.contentRevision, governanceVersion: input.governanceVersion, decision: input.decision,
        ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }) })));
      return true;
    }
    const revokeMatch = /^(semantic|procedural)\/([^/]+)\/revoke$/u.exec(action);
    if (revokeMatch !== null) {
      const kind = revokeMatch[1] as KnowledgeKind;
      const knowledgeId = pathId(revokeMatch[2]!);
      const input = revokeBody.parse(body);
      json(response, 200, publicRevision(await api.revoke(targetId, kind, { ...input, knowledgeId })));
      return true;
    }
    if (action === 'publication') {
      const input = publishBody.parse(body);
      json(response, 200, await api.publish(targetId, input));
      return true;
    }
    const sourceRevokeMatch = /^sources\/([^/]+)\/revoke$/u.exec(action);
    if (sourceRevokeMatch !== null) {
      const sourceId = pathId(sourceRevokeMatch[1]!);
      const input = sourceRevokeBody.parse(body);
      json(response, 200, await api.revokeSource(targetId, { ...input, sourceId }));
      return true;
    }
    throw fail('NOT_FOUND', 404);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof URIError) throw fail('KNOWLEDGE_RECORD_INVALID', 400);
    if (error instanceof KnowledgeContractError) {
      if (error.code === 'KNOWLEDGE_NOT_FOUND' || error.code === 'KNOWLEDGE_SCOPE_INVALID') throw fail('NOT_FOUND', 404);
      throw fail(error.code, knowledgeStatus(error.code));
    }
    if (isTargetNotFound(error)) throw fail('NOT_FOUND', 404);
    throw error;
  }
}

function publicRevision(value: KnowledgeRevision): Record<string, unknown> {
  const { scope, provenance, review, ...revision } = value;
  return {
    ...revision,
    applicability: {
      profileRevision: scope.profileRevision,
      scenarioId: scope.scenarioId,
      scenarioVersion: scope.scenarioVersion,
      serviceIds: scope.serviceIds,
      faultTypes: scope.faultTypes,
      environment: scope.environment,
      dataClass: scope.dataClass,
      ...(scope.dataClass === 'simulated' ? { datasetId: scope.datasetId } : {}),
    },
    source: { type: provenance.sourceType, id: provenance.sourceId, version: provenance.sourceVersion,
      digest: provenance.sourceDigest, importedAt: provenance.importedAt },
    ...(review === undefined ? {} : { review: { reviewedAt: review.reviewedAt, checks: review.checks } }),
  };
}

function queryKeys(url: URL, allowed: readonly string[]): void {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw fail('KNOWLEDGE_RECORD_INVALID', 400);
  }
}
function pathId(value: string): string { return id.parse(decodeURIComponent(value)); }
function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}
function fail(code: string, statusCode: number): Error { return Object.assign(new Error('Knowledge request cannot be completed.'), { code, statusCode }); }
function knowledgeStatus(code: string): number {
  if (code === 'KNOWLEDGE_STORAGE_UNAVAILABLE') return 503;
  if (code === 'KNOWLEDGE_REVISION_CONFLICT' || code === 'KNOWLEDGE_GOVERNANCE_CONFLICT'
    || code === 'KNOWLEDGE_PUBLICATION_CONFLICT' || code === 'KNOWLEDGE_DIGEST_MISMATCH') return 409;
  if (code === 'KNOWLEDGE_APPROVAL_DENIED' || code === 'KNOWLEDGE_EXPIRED' || code === 'KNOWLEDGE_SOURCE_REVOKED'
    || code === 'KNOWLEDGE_REQUIRED_DISABLED' || code === 'KNOWLEDGE_TRANSITION_INVALID') return 422;
  return 400;
}
function isTargetNotFound(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'code' in value
    && typeof value.code === 'string' && ['TARGET_NOT_FOUND', 'TARGET_DISABLED', 'TARGET_BINDING_INVALID'].includes(value.code);
}
