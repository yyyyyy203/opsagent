import { z } from 'zod';
import { systemClock, type Clock } from '../contracts/common.js';
import { KnowledgeContractError, type KnowledgeQueryPort } from '../contracts/knowledge-memory.js';
import { safeKnowledgeIdentifierSchema } from '../contracts/knowledge-memory-schema.js';
import type { GovernedKnowledgePublicationPort, KnowledgeRevisionStateQueryPort,
  TargetKnowledgePublicationContextPort } from '../contracts/knowledge-memory-storage.js';
import type { TargetKnowledgePolicy } from '../contracts/target.js';

const publicationRequest = z.object({
  requestId: safeKnowledgeIdentifierSchema,
  targetId: safeKnowledgeIdentifierSchema,
  expectedPublicationVersion: z.number().int().nonnegative().safe(),
  references: z.array(z.object({ id: safeKnowledgeIdentifierSchema, version: z.string().regex(/^[1-9]\d*$/u),
    digest: z.string().regex(/^[a-f0-9]{64}$/u), approval: z.literal('approved') }).strict()).max(20),
}).strict();

export interface TargetKnowledgePublicationServiceOptions {
  readonly contexts: TargetKnowledgePublicationContextPort;
  readonly queries: KnowledgeQueryPort & KnowledgeRevisionStateQueryPort;
  readonly publications: GovernedKnowledgePublicationPort;
  readonly clock?: Clock;
}

/** Approval never calls this service. Only explicit operator publication does. */
export class TargetKnowledgePublicationService {
  private readonly clock: Clock;
  public constructor(private readonly options: TargetKnowledgePublicationServiceOptions) {
    this.clock = options.clock ?? systemClock;
  }

  public async publish(input: unknown) {
    const parsed = publicationRequest.safeParse(input);
    if (!parsed.success) throw new KnowledgeContractError('KNOWLEDGE_RECORD_INVALID');
    const request = parsed.data;
    const now = this.clock.now().toISOString();
    const context = await this.options.contexts.resolvePublicationContext({ targetId: request.targetId,
      capturedAt: now, signal: new AbortController().signal });
    const expectedRevisions = [];
    for (const reference of request.references) {
      const query = { id: reference.id, contentRevision: Number(reference.version), scope: context.scope };
      const state = await this.options.queries.inspectExact({ ...query, now });
      if (state === null) throw new KnowledgeContractError('KNOWLEDGE_NOT_FOUND');
      if (state.contentDigest !== reference.digest) throw new KnowledgeContractError('KNOWLEDGE_DIGEST_MISMATCH');
      // This captures CAS pins only. The transaction independently checks current
      // status, source epoch/digest and expiry using its own injected clock.
      expectedRevisions.push({ reference, governanceVersion: state.governanceVersion, sourceEpoch: state.sourceEpoch });
    }
    const policy: TargetKnowledgePolicy = context.hostPolicy ?? { schemaVersion: 1, targetId: request.targetId,
      policyVersion: 'default/v1', policyEpoch: 0, defaultRequiredness: 'optional', requirements: [] };
    return this.options.publications.publishGoverned({ context, expectedRevisions, command: {
      ...request, scope: context.scope, policy, publishedAt: now,
    } });
  }
}
