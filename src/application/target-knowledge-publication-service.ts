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
    const knowledgeClasses = new Map<string, 'semantic' | 'procedural'>();
    for (const reference of request.references) {
      const query = { id: reference.id, contentRevision: Number(reference.version), scope: context.scope };
      const state = await this.options.queries.inspectExact({ ...query, now });
      if (state === null) throw new KnowledgeContractError('KNOWLEDGE_NOT_FOUND');
      if (state.contentDigest !== reference.digest) throw new KnowledgeContractError('KNOWLEDGE_DIGEST_MISMATCH');
      knowledgeClasses.set(`${reference.id}\u0000${reference.version}\u0000${reference.digest}`, state.kind);
      // This captures CAS pins only. The transaction independently checks current
      // status, source epoch/digest and expiry using its own injected clock.
      expectedRevisions.push({ reference, governanceVersion: state.governanceVersion, sourceEpoch: state.sourceEpoch });
    }
    const basePolicy: TargetKnowledgePolicy = context.hostPolicy ?? { schemaVersion: 1, targetId: request.targetId,
      policyVersion: 'default/v1', policyEpoch: 0, defaultRequiredness: 'optional', requirements: [] };
    const requirements = new Map(basePolicy.requirements.map(requirement => [
      `${requirement.id}\u0000${requirement.version}\u0000${requirement.digest}`, requirement,
    ]));
    for (const [key, knowledgeClass] of knowledgeClasses) {
      const existing = requirements.get(key);
      if (existing?.knowledgeClass !== undefined && existing.knowledgeClass !== knowledgeClass) {
        throw new KnowledgeContractError('KNOWLEDGE_PUBLICATION_CONFLICT');
      }
      if (existing === undefined) {
        const [id, version, digest] = key.split('\u0000');
        requirements.set(key, { id: id!, version: version!, digest: digest!, requiredness: 'optional', knowledgeClass });
      } else if (existing.knowledgeClass === undefined) {
        requirements.set(key, { ...existing, knowledgeClass });
      }
    }
    const policy: TargetKnowledgePolicy = { ...basePolicy, requirements: [...requirements.values()] };
    return this.options.publications.publishGoverned({ context, expectedRevisions, command: {
      ...request, scope: context.scope, policy, publishedAt: now,
    } });
  }
}
