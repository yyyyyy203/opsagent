import { randomIdGenerator, systemClock, type Clock, type IdGenerator } from '../contracts/common.js';
import { KnowledgeContractError, type KnowledgeGovernanceReviewPort, type KnowledgeQueryPort,
  type KnowledgeReviewAuthorityPort, type KnowledgeReviewCommand, type KnowledgeRevision, type KnowledgeScope,
  type TargetKnowledgeBindingPublisher, type TargetKnowledgePublication,
  type TargetKnowledgePublishCommand } from '../contracts/knowledge-memory.js';
import { parseKnowledgeGovernanceAuditV1, type KnowledgeGovernanceAuditOutboxPort,
  type KnowledgeGovernanceAuditQueryPort, type KnowledgeGovernanceAuditV1 } from '../contracts/knowledge-governance-audit.js';
import { contentRevisionFromTargetReference, parseKnowledgeRecord, parseKnowledgeReviewCommand,
  parseKnowledgeScope } from '../contracts/knowledge-memory-schema.js';
import { checkpointChecksum, canonicalJson } from '../contracts/stable-json.js';
import type { KnowledgeCommandReplayIntent, KnowledgeCommandReplayPort, KnowledgeDraftStore, KnowledgeDraftWriteCommand, KnowledgePublicationActorPort,
  KnowledgePublicationInspectionPort, KnowledgePublicationSnapshot, KnowledgeRevisionStateQueryPort,
  KnowledgeRevisionStateSnapshot, KnowledgeScopedSearchRequest, KnowledgeScopedSearchStore,
  KnowledgeSourceGovernanceStore, KnowledgeSourceRegistration, KnowledgeSourceState, KnowledgeSourceTransition,
  KnowledgeSourceTransitionCommand, KnowledgeGovernanceAuditAttemptPort, KnowledgeSubmissionCommand,
  KnowledgeGovernanceTransitionCommand, KnowledgeGovernanceTransitionStore } from '../contracts/knowledge-memory-storage.js';
import { isKnowledgeTransitionAllowed } from '../contracts/knowledge-memory.js';
import type { TargetKnowledgeReference } from '../contracts/target.js';
import { knowledgeReplayPayload, assertKnowledgeReplayPayload, normalizeKnowledgePublication, knowledgeContentText, knowledgeSearchTokens, knowledgeQueryTokens,
  rankKnowledgeSearch } from '../contracts/knowledge-storage-behavior.js';

export interface InMemoryGovernedKnowledgeStoreOptions {
  authority: KnowledgeReviewAuthorityPort;
  publicationActors: KnowledgePublicationActorPort;
  clock?: Clock;
  ids?: IdGenerator;
}

interface StoredRevision {
  immutable: KnowledgeRevision;
  governanceVersion: number;
  status: KnowledgeRevision['status'];
  sourceEpoch: number;
  review?: KnowledgeRevision['review'];
  sourceDomainId: string;
  naturalKey: string;
}

interface KnowledgeItem {
  id: string;
  kind: KnowledgeRevision['kind'];
  scopeKey: string;
  targetId: string;
  naturalKey: string;
  latestContentRevision: number;
  createdAt: string;
}

interface CommandReceipt {
  readonly requestId: string;
  readonly operation: string;
  readonly commandDigest: string;
  readonly knowledgeId?: string;
  readonly contentRevision?: number;
  readonly resultJson: string;
}

interface StoredAudit {
  readonly sequence: number;
  readonly event: KnowledgeGovernanceAuditV1;
  state: 'pending' | 'delivered';
  deliveredAt?: string;
  attempts: number;
}

interface StoredPublication {
  readonly digest: string;
  readonly publication: TargetKnowledgePublication;
  readonly scopeKey: string;
}

/** Test-only reference store. Production bootstraps must use the SQLite implementation. */
export class InMemoryGovernedKnowledgeStore implements KnowledgeCommandReplayPort, KnowledgeDraftStore, KnowledgeSourceGovernanceStore,
  KnowledgeScopedSearchStore, KnowledgeQueryPort, KnowledgeGovernanceReviewPort,
  KnowledgeGovernanceTransitionStore,
  TargetKnowledgeBindingPublisher, KnowledgeGovernanceAuditOutboxPort, KnowledgeGovernanceAuditQueryPort,
  KnowledgeRevisionStateQueryPort, KnowledgePublicationInspectionPort, KnowledgeGovernanceAuditAttemptPort {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly items = new Map<string, KnowledgeItem>();
  private readonly itemsByNaturalKey = new Map<string, string>();
  private readonly revisions = new Map<string, StoredRevision>();
  private readonly sources = new Map<string, KnowledgeSourceState>();
  private readonly receipts = new Map<string, CommandReceipt>();
  private readonly audits: StoredAudit[] = [];
  private readonly publications = new Map<string, StoredPublication>();
  private readonly publicationsByRequest = new Map<string, StoredPublication & { requestId: string }>();
  private transactionDepth = 0;

  public constructor(private readonly options: InMemoryGovernedKnowledgeStoreOptions) {
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? randomIdGenerator;
  }

  public registerSource(input: KnowledgeSourceRegistration): Promise<KnowledgeSourceState> {
    return Promise.resolve().then(() => {
      validateDigest(input.sourceDigest);
      validateTime(input.registeredAt);
      const key = sourceKey(input.sourceId, input.dataDomainId);
      const current = this.sources.get(key);
      if (current) {
        if (current.sourceEpoch === 0 && current.validity === 'active' && current.sourceDigest === input.sourceDigest) {
          return structuredClone(current);
        }
        throw error('KNOWLEDGE_GOVERNANCE_CONFLICT');
      }
      const source: KnowledgeSourceState = {
        sourceId: input.sourceId, dataDomainId: input.dataDomainId, sourceEpoch: 0,
        sourceDigest: input.sourceDigest, validity: 'active', updatedAt: input.registeredAt,
      };
      this.sources.set(key, source);
      return structuredClone(source);
    });
  }

  public replayCommand(intent: KnowledgeCommandReplayIntent): Promise<KnowledgeRevision | null> {
    return Promise.resolve().then(() => this.replayHostIntent(intent));
  }

  private replayHostIntent(intent: KnowledgeCommandReplayIntent): KnowledgeRevision | null {
    knowledgeReplayPayload(intent);
    const receipt = this.receipts.get(intent.requestId);
    if (!receipt) return null;
    if (receipt.operation !== intent.operation) throw error('KNOWLEDGE_GOVERNANCE_CONFLICT');
    assertKnowledgeReplayPayload(receipt.resultJson, intent);
    const revision = this.currentRevision(receipt.knowledgeId, receipt.contentRevision);
    if (scopeDigest(revision.scope) !== scopeDigest(intent.scope)) throw error('KNOWLEDGE_GOVERNANCE_CONFLICT');
    return this.currentRevision(receipt.knowledgeId, receipt.contentRevision, true);
  }

  public saveDraft(command: KnowledgeDraftWriteCommand, replayIntent?: KnowledgeCommandReplayIntent): Promise<KnowledgeRevision> {
    return Promise.resolve().then(() => this.inTransaction(() => {
      const normalized = normalizeDraftCommand(command);
      const resultJson = replayIntent === undefined ? '{}' : knowledgeReplayPayload(replayIntent,
        'draft', normalized.requestId, normalized.revision.scope);
      if (replayIntent !== undefined) {
        const prior = this.replayHostIntent(replayIntent);
        if (prior) return prior;
      }
      const digest = commandDigest('draft', normalized);
      const receiptDigest = draftReceiptDigest(normalized);
      const replay = this.replayReceipt(normalized.requestId, 'draft', receiptDigest);
      if (replay) return this.currentRevision(replay.knowledgeId, replay.contentRevision);

      const revision = parseKnowledgeRecord(normalized.revision);
      if (revision.status !== 'draft' || revision.governanceVersion !== 1 || revision.review !== undefined) {
        throw error('KNOWLEDGE_RECORD_INVALID');
      }
      if (revision.sourceEpoch < 0 || revision.contentRevision < 1) throw error('KNOWLEDGE_RECORD_INVALID');
      const scopeKey = scopeDigest(revision.scope);
      const itemKey = naturalItemKey(revision.kind, scopeKey, normalized.naturalKey);
      const currentId = this.itemsByNaturalKey.get(itemKey);
      let item: KnowledgeItem;

      if (normalized.expectedContentRevision === null || normalized.expectedGovernanceVersion === null) {
        if (normalized.expectedContentRevision !== null || normalized.expectedGovernanceVersion !== null
          || revision.contentRevision !== 1 || currentId !== undefined || this.items.has(revision.id)) {
          throw error('KNOWLEDGE_REVISION_CONFLICT');
        }
        item = {
          id: revision.id, kind: revision.kind, scopeKey, targetId: revision.scope.targetId,
          naturalKey: normalized.naturalKey, latestContentRevision: 1, createdAt: revision.createdAt,
        };
      } else {
        if (normalized.expectedContentRevision < 1 || normalized.expectedGovernanceVersion < 1
          || currentId !== revision.id || revision.contentRevision !== normalized.expectedContentRevision + 1) {
          throw error('KNOWLEDGE_REVISION_CONFLICT');
        }
        const previous = this.revisions.get(revisionKey(revision.id, normalized.expectedContentRevision));
        const existingItem = this.items.get(revision.id);
        if (!previous || !existingItem) throw error('KNOWLEDGE_NOT_FOUND');
        if (existingItem.latestContentRevision !== normalized.expectedContentRevision) throw error('KNOWLEDGE_REVISION_CONFLICT');
        if (previous.governanceVersion !== normalized.expectedGovernanceVersion) throw error('KNOWLEDGE_GOVERNANCE_CONFLICT');
        if (previous.immutable.kind !== revision.kind || scopeDigest(previous.immutable.scope) !== scopeKey
          || previous.naturalKey !== normalized.naturalKey) throw error('KNOWLEDGE_SCOPE_INVALID');
        item = { ...existingItem, latestContentRevision: revision.contentRevision };
      }

      this.assertSourceForDraft(revision, normalized.sourceDomainId);
      const audit = this.knowledgeAudit({
        requestId: normalized.requestId, commandDigest: digest, actorId: normalized.actorId, revision,
        afterStatus: 'draft',
      });
      const stored: StoredRevision = {
        immutable: structuredClone(revision), governanceVersion: 1, status: 'draft',
        sourceEpoch: revision.sourceEpoch, sourceDomainId: normalized.sourceDomainId,
        naturalKey: normalized.naturalKey,
      };
      this.items.set(revision.id, item);
      this.itemsByNaturalKey.set(itemKey, revision.id);
      this.revisions.set(revisionKey(revision.id, revision.contentRevision), stored);
      this.appendWithinTransaction(audit);
      this.saveReceipt({ requestId: normalized.requestId, operation: 'draft', commandDigest: receiptDigest,
        knowledgeId: revision.id, contentRevision: revision.contentRevision, resultJson });
      return this.materialize(stored);
    }));
  }

  public submitForReview(command: KnowledgeSubmissionCommand): Promise<KnowledgeRevision> {
    return Promise.resolve().then(() => this.inTransaction(() => {
      const normalized = normalizeSubmissionCommand(command);
      const digest = commandDigest('submit', normalized);
      const replay = this.replayReceipt(normalized.requestId, 'submit', digest);
      if (replay) return this.currentRevision(replay.knowledgeId, replay.contentRevision);
      const stored = this.revisions.get(revisionKey(normalized.knowledgeId, normalized.expectedContentRevision));
      const item = this.items.get(normalized.knowledgeId);
      if (!stored || !item || item.kind !== normalized.kind || item.latestContentRevision !== normalized.expectedContentRevision) {
        throw error('KNOWLEDGE_NOT_FOUND');
      }
      if (stored.governanceVersion !== normalized.expectedGovernanceVersion) throw error('KNOWLEDGE_GOVERNANCE_CONFLICT');
      if (stored.status !== 'draft') throw error('KNOWLEDGE_TRANSITION_INVALID');
      this.assertRevisionSourceCurrent(stored);
      const audit = this.knowledgeAudit({
        requestId: normalized.requestId, commandDigest: digest, actorId: normalized.actorId, revision: this.materialize(stored),
        beforeStatus: 'draft', afterStatus: 'review_pending', governanceVersion: stored.governanceVersion + 1,
      });
      stored.status = 'review_pending';
      stored.governanceVersion += 1;
      this.appendWithinTransaction(audit);
      this.saveReceipt({ requestId: normalized.requestId, operation: 'submit', commandDigest: digest,
        knowledgeId: stored.immutable.id, contentRevision: stored.immutable.contentRevision, resultJson: '{}' });
      return this.materialize(stored);
    }));
  }

  public review(input: KnowledgeReviewCommand, replayIntent?: KnowledgeCommandReplayIntent): Promise<KnowledgeRevision> {
    return Promise.resolve().then(async () => {
      const command = parseKnowledgeReviewCommand(input);
      const digest = commandDigest('review', command);
      if (replayIntent !== undefined) {
        knowledgeReplayPayload(replayIntent, 'review', command.requestId);
        const prior = this.replayHostIntent(replayIntent);
        if (prior) return prior;
      }
      const replay = this.replayReceipt(command.requestId, 'review', digest);
      if (replay) return this.currentRevision(replay.knowledgeId, replay.contentRevision, true);
      const authority = await this.options.authority.resolveFor({ knowledgeId: command.knowledgeId, kind: command.kind });
      return this.inTransaction(() => {
        const resultJson = replayIntent === undefined ? '{}' : knowledgeReplayPayload(replayIntent,
          'review', command.requestId, authority.scope);
        if (replayIntent !== undefined) {
          const prior = this.replayHostIntent(replayIntent);
          if (prior) return prior;
        }
        const repeated = this.replayReceipt(command.requestId, 'review', digest);
        if (repeated) return this.currentRevision(repeated.knowledgeId, repeated.contentRevision, true);
        const stored = this.revisions.get(revisionKey(command.knowledgeId, command.expectedContentRevision));
        const item = this.items.get(command.knowledgeId);
        if (!stored || !item || item.kind !== command.kind) throw error('KNOWLEDGE_NOT_FOUND');
        if (stored.governanceVersion !== command.expectedGovernanceVersion) throw error('KNOWLEDGE_GOVERNANCE_CONFLICT');
        if (stored.immutable.contentDigest !== command.contentDigest) throw error('KNOWLEDGE_DIGEST_MISMATCH');
        if (stored.status !== 'review_pending') throw error('KNOWLEDGE_TRANSITION_INVALID');
        if (canonicalJson(parseKnowledgeScope(authority.scope)) !== canonicalJson(stored.immutable.scope)) {
          throw error('KNOWLEDGE_SCOPE_INVALID');
        }
        this.assertRevisionSourceCurrent(stored, authority.sourceEpoch, authority.sourceDigest);
        if (command.decision === 'approve'
          && (!command.checks.sourceVerified || !command.checks.scopeVerified || !command.checks.contentReviewed)) {
          throw error('KNOWLEDGE_APPROVAL_DENIED');
        }
        const nextStatus = command.decision === 'approve' ? 'approved' : 'rejected';
        const nextVersion = stored.governanceVersion + 1;
        const audit = this.knowledgeAudit({
          requestId: command.requestId, commandDigest: digest, actorId: authority.actorId,
          revision: this.materialize(stored), beforeStatus: 'review_pending', afterStatus: nextStatus,
          governanceVersion: nextVersion,
        });
        stored.status = nextStatus;
        stored.governanceVersion = nextVersion;
        if (command.decision === 'approve') {
          stored.review = {
            reviewerId: authority.actorId, reviewedAt: authority.reviewedAt, checks: structuredClone(command.checks),
            sourceVerification: { sourceEpoch: authority.sourceEpoch, sourceDigest: authority.sourceDigest },
          };
        }
        this.appendWithinTransaction(audit);
        this.saveReceipt({ requestId: command.requestId, operation: 'review', commandDigest: digest,
          knowledgeId: stored.immutable.id, contentRevision: stored.immutable.contentRevision, resultJson });
        return this.materialize(stored);
      });
    });
  }

  public transitionKnowledge(command: KnowledgeGovernanceTransitionCommand): Promise<KnowledgeRevision> {
    return Promise.resolve().then(() => this.inTransaction(() => {
      const normalized = normalizeKnowledgeTransition(command);
      const digest = knowledgeTransitionIntentDigest(normalized);
      const replay = this.replayReceipt(normalized.requestId, 'knowledge_transition', digest);
      if (replay) return this.currentRevision(replay.knowledgeId, replay.contentRevision);
      const stored = this.revisions.get(revisionKey(normalized.knowledgeId, normalized.contentRevision));
      if (!stored || stored.immutable.kind !== normalized.kind) throw error('KNOWLEDGE_NOT_FOUND');
      if (stored.governanceVersion !== normalized.expectedGovernanceVersion) throw error('KNOWLEDGE_GOVERNANCE_CONFLICT');
      if (!isKnowledgeTransitionAllowed(stored.status, normalized.nextStatus)) throw error('KNOWLEDGE_TRANSITION_INVALID');
      const audit = this.knowledgeAudit({
        requestId: normalized.requestId, commandDigest: digest, actorId: normalized.actorId, revision: this.materialize(stored),
        beforeStatus: stored.status, afterStatus: normalized.nextStatus, governanceVersion: stored.governanceVersion + 1,
      });
      stored.status = normalized.nextStatus;
      stored.governanceVersion += 1;
      delete stored.review;
      this.appendWithinTransaction(audit);
      this.saveReceipt({ requestId: normalized.requestId, operation: 'knowledge_transition', commandDigest: digest,
        knowledgeId: stored.immutable.id, contentRevision: stored.immutable.contentRevision, resultJson: '{}' });
      return this.materialize(stored);
    }));
  }

  public getExact(input: { id: string; contentRevision: number; scope: KnowledgeScope }): Promise<KnowledgeRevision | null> {
    return Promise.resolve().then(() => {
      const parsedScope = parseKnowledgeScope(input.scope);
      const stored = this.revisions.get(revisionKey(input.id, input.contentRevision));
      if (!stored || scopeDigest(stored.immutable.scope) !== scopeDigest(parsedScope)) return null;
      const revision = this.materialize(stored);
      if (revision.status !== 'approved' || (revision.validUntil !== undefined && Date.parse(revision.validUntil) <= this.clock.now().getTime())) return null;
      if (!this.isSourceCurrent(stored)) return null;
      return revision;
    });
  }

  public getSourceEpoch(input: { sourceId: string; dataDomainId: string }): Promise<number | null> {
    return Promise.resolve(this.sources.get(sourceKey(input.sourceId, input.dataDomainId))?.sourceEpoch ?? null);
  }

  public getSource(input: { sourceId: string; dataDomainId: string }): Promise<KnowledgeSourceState | null> {
    const source = this.sources.get(sourceKey(input.sourceId, input.dataDomainId));
    return Promise.resolve(source === undefined ? null : structuredClone(source));
  }

  public transitionSource(command: KnowledgeSourceTransitionCommand): Promise<KnowledgeSourceState> {
    return Promise.resolve().then(() => this.inTransaction(() => {
      const normalized = normalizeSourceTransition(command);
      const digest = commandDigest('source_transition', normalized);
      const replay = this.replayReceipt(normalized.requestId, 'source_transition', digest);
      if (replay) {
        const source = this.sources.get(sourceKey(normalized.sourceId, normalized.dataDomainId));
        if (!source) throw error('KNOWLEDGE_STORAGE_UNAVAILABLE');
        return structuredClone(source);
      }
      const key = sourceKey(normalized.sourceId, normalized.dataDomainId);
      const current = this.sources.get(key);
      if (!current) throw error('KNOWLEDGE_NOT_FOUND');
      if (current.sourceEpoch !== normalized.expectedSourceEpoch) throw error('KNOWLEDGE_GOVERNANCE_CONFLICT');
      const nextEpoch = current.sourceEpoch + 1;
      const validity = normalized.transition === 'revalidated' ? 'active' : normalized.transition;
      const source: KnowledgeSourceState = {
        sourceId: current.sourceId, dataDomainId: current.dataDomainId, sourceEpoch: nextEpoch,
        sourceDigest: normalized.sourceDigest, validity, updatedAt: this.clock.now().toISOString(),
      };
      const audit = parseKnowledgeGovernanceAuditV1({
        schemaVersion: 1, auditId: this.ids.next('knowledge-audit'), requestId: normalized.requestId,
        commandDigest: digest, occurredAt: this.clock.now().toISOString(), actorId: normalized.actorId,
        type: 'source_transition', sourceId: normalized.sourceId, dataDomainId: normalized.dataDomainId,
        beforeSourceEpoch: current.sourceEpoch, afterSourceEpoch: nextEpoch,
        validity: normalized.transition, reasonCode: sourceReason(normalized.transition),
      });
      this.sources.set(key, source);
      this.appendWithinTransaction(audit);
      this.saveReceipt({ requestId: normalized.requestId, operation: 'source_transition', commandDigest: digest,
        resultJson: '{}' });
      return structuredClone(source);
    }));
  }

  public search(input: KnowledgeScopedSearchRequest): Promise<readonly KnowledgeRevision[]> {
    return Promise.resolve().then(() => {
      const scope = parseKnowledgeScope(input.scope);
      validateSearchInput(input);
      const references = input.references.map((reference) => normalizeTargetReference(reference));
      const unique = new Set(references.map((reference) => `${reference.id}\u0000${reference.version}\u0000${reference.digest}`));
      if (unique.size !== references.length) return [];
      const tokens = knowledgeQueryTokens(input.query);
      if (tokens.length === 0 || references.length === 0) return [];
      const candidates: KnowledgeRevision[] = [];
      const corpus: string[] = [];
      for (const reference of references) {
        const contentRevision = contentRevisionFromTargetReference(reference);
        const stored = this.revisions.get(revisionKey(reference.id, contentRevision));
        if (!stored || stored.immutable.kind !== input.kind || scopeDigest(stored.immutable.scope) !== scopeDigest(scope)) continue;
        const revision = this.materialize(stored);
        if (revision.status !== 'approved' || revision.contentDigest !== reference.digest) continue;
        if (revision.validUntil !== undefined && Date.parse(revision.validUntil) <= Date.parse(input.now)) continue;
        if (!this.isSourceCurrent(stored)) continue;
        corpus.push(knowledgeContentText(revision));
        const haystack = knowledgeSearchTokens(knowledgeContentText(revision));
        if (!tokens.every((token) => haystack.includes(token))) continue;
        candidates.push(revision);
      }
      return rankKnowledgeSearch(candidates, tokens, corpus).slice(0, input.limit).map((revision) => structuredClone(revision));
    });
  }

  public inspectExact(input: { id: string; contentRevision: number; scope: KnowledgeScope; now: string }): Promise<KnowledgeRevisionStateSnapshot | null> {
    return Promise.resolve().then(() => {
      const revision = this.revisions.get(revisionKey(input.id, input.contentRevision));
      if (!revision || scopeDigest(revision.immutable.scope) !== scopeDigest(parseKnowledgeScope(input.scope))) return null;
      const source = this.sources.get(sourceKey(revision.immutable.provenance.sourceId, revision.sourceDomainId));
      return {
        knowledgeId: revision.immutable.id, kind: revision.immutable.kind,
        contentRevision: revision.immutable.contentRevision, governanceVersion: revision.governanceVersion,
        contentDigest: revision.immutable.contentDigest,
        status: revision.status, sourceEpoch: revision.sourceEpoch,
        currentSourceEpoch: source?.sourceEpoch ?? null,
        sourceValidity: source?.validity ?? 'missing',
        sourceDigestMatches: source?.sourceDigest === revision.immutable.provenance.sourceDigest,
        ...(revision.immutable.validUntil === undefined ? {} : { validUntil: revision.immutable.validUntil }),
        eligibleAt: input.now,
      };
    });
  }

  public get(targetId: string): Promise<TargetKnowledgePublication | null> {
    const publication = this.publications.get(targetId)?.publication;
    return Promise.resolve(publication === undefined ? null : structuredClone(publication));
  }

  public inspectBinding(targetId: string): Promise<KnowledgePublicationSnapshot> {
    const binding = this.publications.get(targetId);
    return Promise.resolve({
      publication: binding ? structuredClone(binding.publication) : null,
      scopeKey: binding?.scopeKey ?? null,
    });
  }

  public publish(command: TargetKnowledgePublishCommand): Promise<TargetKnowledgePublication> {
    return Promise.resolve().then(async () => {
      const normalized = normalizeKnowledgePublication(command);
      const digest = commandDigest('publication', normalized);
      const replay = this.publicationsByRequest.get(normalized.requestId);
      if (replay) {
        if (replay.digest !== digest) throw error('KNOWLEDGE_PUBLICATION_CONFLICT');
        return structuredClone(replay.publication);
      }
      const actor = await this.options.publicationActors.resolveForTarget({ targetId: normalized.targetId, requestId: normalized.requestId });
      return this.inTransaction(() => {
        const repeated = this.publicationsByRequest.get(normalized.requestId);
        if (repeated) {
          if (repeated.digest !== digest) throw error('KNOWLEDGE_PUBLICATION_CONFLICT');
          return structuredClone(repeated.publication);
        }
        if (normalized.scope.targetId !== normalized.targetId || normalized.policy.targetId !== normalized.targetId) {
          throw error('KNOWLEDGE_SCOPE_INVALID');
        }
        const current = this.publications.get(normalized.targetId);
        const currentVersion = current?.publication.publicationVersion ?? 0;
        if (currentVersion !== normalized.expectedPublicationVersion) throw error('KNOWLEDGE_PUBLICATION_CONFLICT');
        const now = this.clock.now().toISOString();
        for (const reference of normalized.references) this.assertReferenceEligible(reference, normalized.scope, now);
        const publication: TargetKnowledgePublication = {
          targetId: normalized.targetId, publicationVersion: currentVersion + 1,
          references: structuredClone(normalized.references), policy: structuredClone(normalized.policy),
          publishedAt: now,
        };
        const audit = parseKnowledgeGovernanceAuditV1({
          schemaVersion: 1, auditId: this.ids.next('knowledge-audit'), requestId: normalized.requestId,
          commandDigest: digest, occurredAt: now, actorId: actor.actorId,
          type: 'binding_publication', targetId: normalized.targetId, scopeDigest: scopeDigest(normalized.scope),
          beforePublicationVersion: currentVersion, afterPublicationVersion: publication.publicationVersion,
          policyVersion: normalized.policy.policyVersion, referenceDigest: checkpointChecksum(normalized.references),
        });
        const scopeKey = scopeDigest(normalized.scope);
        const stored = { digest, publication: structuredClone(publication), scopeKey };
        this.publications.set(normalized.targetId, stored);
        this.publicationsByRequest.set(normalized.requestId, { ...stored, requestId: normalized.requestId });
        this.appendWithinTransaction(audit);
        return structuredClone(publication);
      });
    });
  }

  public listPending(limit: number): Promise<readonly KnowledgeGovernanceAuditV1[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return Promise.reject(error('KNOWLEDGE_AUDIT_INVALID'));
    return Promise.resolve(this.audits.filter((entry) => entry.state === 'pending').slice(0, limit)
      .map((entry) => structuredClone(entry.event)));
  }

  public markDelivered(input: { auditId: string; deliveredAt: string }): Promise<void> {
    return Promise.resolve().then(() => {
      validateTime(input.deliveredAt);
      const row = this.audits.find((entry) => entry.event.auditId === input.auditId);
      if (!row) return;
      if (row.state === 'delivered') return;
      row.state = 'delivered';
      row.deliveredAt = input.deliveredAt;
    });
  }

  public recordDeliveryFailure(auditId: string): Promise<void> {
    return Promise.resolve().then(() => {
      const row = this.audits.find((entry) => entry.event.auditId === auditId);
      if (row && row.state === 'pending') row.attempts += 1;
    });
  }

  public appendWithinTransaction(event: KnowledgeGovernanceAuditV1): void {
    if (this.transactionDepth === 0) throw new Error('Knowledge audit append requires an active transaction');
    const parsed = parseKnowledgeGovernanceAuditV1(event);
    if (this.audits.some((row) => row.event.auditId === parsed.auditId)) throw error('KNOWLEDGE_GOVERNANCE_CONFLICT');
    this.audits.push({ sequence: this.audits.length + 1, event: parsed, state: 'pending', attempts: 0 });
  }

  public list(input: { targetId?: string; afterAuditId?: string; limit: number }): Promise<readonly KnowledgeGovernanceAuditV1[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) return Promise.reject(error('KNOWLEDGE_AUDIT_INVALID'));
    const afterIndex = input.afterAuditId === undefined ? -1 : this.audits.findIndex((row) => row.event.auditId === input.afterAuditId);
    if (input.afterAuditId !== undefined && afterIndex === -1) return Promise.resolve([]);
    const rows = this.audits.slice(afterIndex + 1).filter((row) =>
      input.targetId === undefined || auditTargetId(row.event) === input.targetId);
    return Promise.resolve(rows.slice(0, input.limit).map((row) => structuredClone(row.event)));
  }

  private assertSourceForDraft(revision: KnowledgeRevision, dataDomainId: string): void {
    const source = this.sources.get(sourceKey(revision.provenance.sourceId, dataDomainId));
    if (!source || source.validity !== 'active') throw error('KNOWLEDGE_SOURCE_REVOKED');
    if (source.sourceDigest !== revision.provenance.sourceDigest) throw error('KNOWLEDGE_DIGEST_MISMATCH');
    if (source.sourceEpoch !== revision.sourceEpoch) throw error('KNOWLEDGE_SOURCE_REVOKED');
  }

  private assertRevisionSourceCurrent(stored: StoredRevision, expectedEpoch?: number, expectedDigest?: string, at = this.clock.now().toISOString()): void {
    const source = this.sources.get(sourceKey(stored.immutable.provenance.sourceId, stored.sourceDomainId));
    if (!source || source.validity !== 'active') throw error('KNOWLEDGE_SOURCE_REVOKED');
    if (source.sourceDigest !== stored.immutable.provenance.sourceDigest
      || (expectedDigest !== undefined && source.sourceDigest !== expectedDigest)) throw error('KNOWLEDGE_DIGEST_MISMATCH');
    if (source.sourceEpoch !== stored.sourceEpoch || (expectedEpoch !== undefined && source.sourceEpoch !== expectedEpoch)) {
      throw error('KNOWLEDGE_SOURCE_REVOKED');
    }
    if (stored.immutable.validUntil !== undefined && Date.parse(stored.immutable.validUntil) <= Date.parse(at)) {
      throw error('KNOWLEDGE_EXPIRED');
    }
  }

  private isSourceCurrent(stored: StoredRevision): boolean {
    const source = this.sources.get(sourceKey(stored.immutable.provenance.sourceId, stored.sourceDomainId));
    return source !== undefined && source.validity === 'active' && source.sourceEpoch === stored.sourceEpoch
      && source.sourceEpoch === stored.immutable.sourceEpoch
      && source.sourceDigest === stored.immutable.provenance.sourceDigest;
  }

  private assertReferenceEligible(reference: TargetKnowledgeReference, scope: KnowledgeScope, now: string): void {
    const revisionNumber = contentRevisionFromTargetReference(reference);
    const stored = this.revisions.get(revisionKey(reference.id, revisionNumber));
    if (!stored) throw error('KNOWLEDGE_NOT_FOUND');
    const revision = this.materialize(stored);
    if (canonicalJson(revision.scope) !== canonicalJson(scope)) throw error('KNOWLEDGE_SCOPE_INVALID');
    if (revision.status !== 'approved') throw error('KNOWLEDGE_APPROVAL_DENIED');
    if (revision.contentDigest !== reference.digest) throw error('KNOWLEDGE_DIGEST_MISMATCH');
    if (revision.validUntil !== undefined && Date.parse(revision.validUntil) <= Date.parse(now)) throw error('KNOWLEDGE_EXPIRED');
    if (!this.isSourceCurrent(stored)) throw error('KNOWLEDGE_SOURCE_REVOKED');
  }

  private materialize(stored: StoredRevision): KnowledgeRevision {
    return parseKnowledgeRecord({
      ...structuredClone(stored.immutable), governanceVersion: stored.governanceVersion,
      status: stored.status, sourceEpoch: stored.sourceEpoch,
      ...(stored.review === undefined ? {} : { review: structuredClone(stored.review) }),
    });
  }

  private currentRevision(knowledgeId: string | undefined, contentRevision: number | undefined,
    requireApprovedEligibility = false): KnowledgeRevision {
    if (knowledgeId === undefined || contentRevision === undefined) throw error('KNOWLEDGE_STORAGE_UNAVAILABLE');
    const stored = this.revisions.get(revisionKey(knowledgeId, contentRevision));
    if (!stored) throw error('KNOWLEDGE_STORAGE_UNAVAILABLE');
    if (requireApprovedEligibility && stored.status === 'approved') this.assertRevisionSourceCurrent(stored);
    return this.materialize(stored);
  }

  private replayReceipt(requestId: string, operation: string, digest: string): CommandReceipt | null {
    const receipt = this.receipts.get(requestId);
    if (!receipt) return null;
    if (receipt.operation !== operation || receipt.commandDigest !== digest) throw error('KNOWLEDGE_GOVERNANCE_CONFLICT');
    return receipt;
  }

  private saveReceipt(receipt: CommandReceipt): void {
    this.receipts.set(receipt.requestId, receipt);
  }

  private knowledgeAudit(input: {
    requestId: string; commandDigest: string; actorId: string; revision: KnowledgeRevision;
    beforeStatus?: KnowledgeRevision['status']; afterStatus: KnowledgeRevision['status']; governanceVersion?: number;
  }): KnowledgeGovernanceAuditV1 {
    const revision = input.revision;
    return parseKnowledgeGovernanceAuditV1({
      schemaVersion: 1, auditId: this.ids.next('knowledge-audit'), requestId: input.requestId,
      commandDigest: input.commandDigest, occurredAt: this.clock.now().toISOString(), actorId: input.actorId,
      type: 'knowledge_transition', knowledgeId: revision.id, knowledgeKind: revision.kind,
      contentRevision: revision.contentRevision, governanceVersion: input.governanceVersion ?? revision.governanceVersion,
      ...(input.beforeStatus === undefined ? {} : { beforeStatus: input.beforeStatus }),
      afterStatus: input.afterStatus, targetId: revision.scope.targetId, scopeDigest: scopeDigest(revision.scope),
      sourceEpoch: revision.sourceEpoch, contentDigest: revision.contentDigest,
    });
  }

  private inTransaction<T>(operation: () => T): T {
    const outermost = this.transactionDepth === 0;
    const snapshot = outermost ? {
      items: cloneMap(this.items), itemsByNaturalKey: cloneMap(this.itemsByNaturalKey), revisions: cloneMap(this.revisions),
      sources: cloneMap(this.sources), receipts: cloneMap(this.receipts), audits: structuredClone(this.audits),
      publications: cloneMap(this.publications), publicationsByRequest: cloneMap(this.publicationsByRequest),
    } : null;
    this.transactionDepth += 1;
    try {
      return operation();
    } catch (errorValue) {
      if (snapshot) {
        restoreMap(this.items, snapshot.items);
        restoreMap(this.itemsByNaturalKey, snapshot.itemsByNaturalKey);
        restoreMap(this.revisions, snapshot.revisions);
        restoreMap(this.sources, snapshot.sources);
        restoreMap(this.receipts, snapshot.receipts);
        this.audits.splice(0, this.audits.length, ...snapshot.audits);
        restoreMap(this.publications, snapshot.publications);
        restoreMap(this.publicationsByRequest, snapshot.publicationsByRequest);
      }
      throw errorValue;
    } finally {
      this.transactionDepth -= 1;
    }
  }
}

function normalizeDraftCommand(command: KnowledgeDraftWriteCommand): KnowledgeDraftWriteCommand {
  if (typeof command.requestId !== 'string' || command.requestId.trim() === ''
    || typeof command.actorId !== 'string' || command.actorId.trim() === ''
    || typeof command.naturalKey !== 'string' || command.naturalKey.trim() === ''
    || typeof command.sourceDomainId !== 'string' || command.sourceDomainId.trim() === '') throw error('KNOWLEDGE_RECORD_INVALID');
  if (command.intentDigest !== undefined && !/^[a-f0-9]{64}$/u.test(command.intentDigest)) throw error('KNOWLEDGE_RECORD_INVALID');
  if ((command.expectedContentRevision === null) !== (command.expectedGovernanceVersion === null)) throw error('KNOWLEDGE_REVISION_CONFLICT');
  return { ...structuredClone(command), revision: parseKnowledgeRecord(command.revision) };
}

function normalizeSubmissionCommand(command: KnowledgeSubmissionCommand): KnowledgeSubmissionCommand {
  if (!command.requestId.trim() || !command.actorId.trim() || !command.knowledgeId.trim()
    || !Number.isSafeInteger(command.expectedContentRevision) || command.expectedContentRevision < 1
    || !Number.isSafeInteger(command.expectedGovernanceVersion) || command.expectedGovernanceVersion < 1) {
    throw error('KNOWLEDGE_REVIEW_COMMAND_INVALID');
  }
  return structuredClone(command);
}

function normalizeSourceTransition(command: KnowledgeSourceTransitionCommand): KnowledgeSourceTransitionCommand {
  if (!command.requestId.trim() || !command.actorId.trim() || !command.sourceId.trim() || !command.dataDomainId.trim()
    || !Number.isSafeInteger(command.expectedSourceEpoch) || command.expectedSourceEpoch < 0) throw error('KNOWLEDGE_AUDIT_INVALID');
  validateDigest(command.sourceDigest);
  validateTime(command.occurredAt);
  return structuredClone(command);
}

function normalizeKnowledgeTransition(command: KnowledgeGovernanceTransitionCommand): KnowledgeGovernanceTransitionCommand {
  if (!command.requestId.trim() || !command.actorId.trim() || !command.knowledgeId.trim()
    || !Number.isSafeInteger(command.contentRevision) || command.contentRevision < 1
    || !Number.isSafeInteger(command.expectedGovernanceVersion) || command.expectedGovernanceVersion < 1) {
    throw error('KNOWLEDGE_REVIEW_COMMAND_INVALID');
  }
  validateTime(command.occurredAt);
  return structuredClone(command);
}

function normalizeTargetReference(reference: TargetKnowledgeReference): TargetKnowledgeReference {
  if (!reference.id.trim() || reference.approval !== 'approved' || !/^[1-9]\d*$/u.test(reference.version)
    || !Number.isSafeInteger(Number(reference.version)) || !/^[a-f0-9]{64}$/u.test(reference.digest)) {
    throw error('KNOWLEDGE_RECORD_INVALID');
  }
  return structuredClone(reference);
}

function validateSearchInput(input: KnowledgeScopedSearchRequest): void {
  if (typeof input.query !== 'string' || Buffer.byteLength(input.query, 'utf8') > 512
    || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50) throw error('KNOWLEDGE_RECORD_INVALID');
  validateTime(input.now);
}

function sourceReason(transition: KnowledgeSourceTransition): 'SOURCE_WITHDRAWN' | 'SOURCE_DIGEST_MISMATCH' | 'SOURCE_PERMISSION_REVOKED' | 'SOURCE_REVALIDATED' {
  switch (transition) {
    case 'revoked': return 'SOURCE_WITHDRAWN';
    case 'digest_mismatch': return 'SOURCE_DIGEST_MISMATCH';
    case 'permission_revoked': return 'SOURCE_PERMISSION_REVOKED';
    case 'revalidated': return 'SOURCE_REVALIDATED';
  }
}

function auditTargetId(event: KnowledgeGovernanceAuditV1): string | undefined {
  return event.type === 'source_transition' ? undefined : event.targetId;
}

function commandDigest(operation: string, command: unknown): string {
  return checkpointChecksum({ operation, command });
}

function knowledgeTransitionIntentDigest(command: KnowledgeGovernanceTransitionCommand): string {
  // Match SQLite semantics: occurredAt is generated host metadata, not the caller's
  // transition intent, and must not make a retry conflict with its durable receipt.
  const intent = {
    requestId: command.requestId,
    actorId: command.actorId,
    knowledgeId: command.knowledgeId,
    kind: command.kind,
    contentRevision: command.contentRevision,
    expectedGovernanceVersion: command.expectedGovernanceVersion,
    nextStatus: command.nextStatus,
  };
  return commandDigest('knowledge_transition', intent);
}

function draftReceiptDigest(command: KnowledgeDraftWriteCommand): string {
  return command.intentDigest === undefined ? commandDigest('draft', command)
    : commandDigest('draft_intent', { ...command, revision: {
      ...command.revision,
      // Only the initial identity and authoring timestamps are generated on retries.
      // Revision updates must retain their existing knowledge identity.
      id: command.expectedContentRevision === null ? null : command.revision.id,
      createdAt: null,
      provenance: { ...command.revision.provenance, importedAt: null },
    } });
}

function scopeDigest(scope: KnowledgeScope): string {
  return checkpointChecksum(scope);
}

function naturalItemKey(kind: KnowledgeRevision['kind'], scopeKey: string, naturalKey: string): string {
  return `${kind}\u0000${scopeKey}\u0000${naturalKey}`;
}

function sourceKey(sourceId: string, domainId: string): string {
  return `${sourceId}\u0000${domainId}`;
}

function revisionKey(knowledgeId: string, contentRevision: number): string {
  return `${knowledgeId}\u0000${contentRevision}`;
}

function cloneMap<K, V>(source: Map<K, V>): Map<K, V> {
  return new Map([...source].map(([key, value]) => [key, structuredClone(value)]));
}

function restoreMap<K, V>(target: Map<K, V>, snapshot: Map<K, V>): void {
  target.clear();
  for (const [key, value] of snapshot) target.set(key, value);
}

function validateDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw error('KNOWLEDGE_DIGEST_MISMATCH');
}

function validateTime(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw error('KNOWLEDGE_RECORD_INVALID');
}

function error(code: ConstructorParameters<typeof KnowledgeContractError>[0]): KnowledgeContractError {
  return new KnowledgeContractError(code);
}
