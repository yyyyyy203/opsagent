import { systemClock, randomIdGenerator, type Clock, type IdGenerator } from '../../contracts/common.js';
import { KnowledgeContractError, isKnowledgeTransitionAllowed, type KnowledgeGovernanceReviewPort,
  type KnowledgeQueryPort, type KnowledgeReviewAuthorityPort, type KnowledgeReviewCommand,
  type KnowledgeRevision, type KnowledgeScope } from '../../contracts/knowledge-memory.js';
import { parseKnowledgeGovernanceAuditV1, type KnowledgeGovernanceAuditOutboxPort,
  type KnowledgeGovernanceAuditQueryPort, type KnowledgeGovernanceAuditV1 } from '../../contracts/knowledge-governance-audit.js';
import { contentRevisionFromTargetReference, parseKnowledgeRecord, parseKnowledgeReviewCommand,
  parseKnowledgeScope } from '../../contracts/knowledge-memory-schema.js';
import { canonicalJson, checkpointChecksum } from '../../contracts/stable-json.js';
import type { KnowledgeCommandReplayIntent, KnowledgeProceduralReplayCapability, KnowledgeDraftStore, KnowledgeDraftWriteCommand, KnowledgeGovernanceAuditAttemptPort,
  KnowledgeGovernanceTransitionCommand, KnowledgeGovernanceTransitionStore, KnowledgeRevisionStateQueryPort,
  KnowledgeRevisionStateSnapshot, KnowledgeScopedSearchRequest, KnowledgeScopedSearchStore,
  KnowledgeSourceGovernanceStore, KnowledgeSourceRegistration, KnowledgeSourceState,
  KnowledgeSourceTransition, KnowledgeSourceTransitionCommand, KnowledgeSubmissionCommand } from '../../contracts/knowledge-memory-storage.js';
import type { TargetKnowledgeReference } from '../../contracts/target.js';
import type { SqliteDatabase } from './database.js';
import { knowledgeReplayPayload, assertKnowledgeReplayPayload, knowledgeContentText, knowledgeQueryTokens, rankKnowledgeSearch } from '../../contracts/knowledge-storage-behavior.js';

interface SourceRow { source_id: string; data_domain_id: string; source_epoch: number; source_digest: string; validity: KnowledgeSourceState['validity']; updated_at: string }
interface RevisionRow {
  knowledge_id: string; content_revision: number; kind: KnowledgeRevision['kind']; scope_key: string;
  source_id: string; source_domain_id: string; source_digest: string; revision_json: string;
  content_digest: string; valid_until: string | null; governance_version: number;
  status: KnowledgeRevision['status']; source_epoch: number; review_json: string | null; updated_at: string;
}
interface ReceiptRow {
  request_id: string; command_digest: string; operation: string; knowledge_id: string | null;
  content_revision: number | null; result_json: string; actor_id: string; governance_version: number | null;
}
interface AuditRow { sequence: number; audit_json: string }

export interface SqliteGovernedKnowledgeStoreOptions {
  authority: KnowledgeReviewAuthorityPort;
  clock?: Clock;
  ids?: IdGenerator;
}

/** SQLite implementation for governed Semantic/Procedural revisions and their independent audit outbox. */
export class SqliteGovernedKnowledgeStore implements KnowledgeProceduralReplayCapability, KnowledgeDraftStore, KnowledgeSourceGovernanceStore,
  KnowledgeScopedSearchStore, KnowledgeQueryPort, KnowledgeGovernanceReviewPort, KnowledgeGovernanceTransitionStore,
  KnowledgeGovernanceAuditOutboxPort, KnowledgeGovernanceAuditQueryPort,
  KnowledgeRevisionStateQueryPort, KnowledgeGovernanceAuditAttemptPort {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  public constructor(private readonly database: SqliteDatabase, private readonly options: SqliteGovernedKnowledgeStoreOptions) {
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? randomIdGenerator;
  }

  public registerSource(input: KnowledgeSourceRegistration): Promise<KnowledgeSourceState> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      validateDigest(input.sourceDigest);
      validateTime(input.registeredAt);
      const current = selectSource(this.database, input.sourceId, input.dataDomainId);
      if (current) {
        if (current.sourceEpoch === 0 && current.validity === 'active' && current.sourceDigest === input.sourceDigest) return current;
        throw failure('KNOWLEDGE_GOVERNANCE_CONFLICT');
      }
      this.database.raw.prepare(`
        INSERT INTO diagnostic_knowledge_sources(source_id, data_domain_id, source_epoch, source_digest, validity, updated_at)
        VALUES (?, ?, 0, ?, 'active', ?)
      `).run(input.sourceId, input.dataDomainId, input.sourceDigest, input.registeredAt);
      return {
        sourceId: input.sourceId, dataDomainId: input.dataDomainId, sourceEpoch: 0,
        sourceDigest: input.sourceDigest, validity: 'active' as const, updatedAt: input.registeredAt,
      };
    }).immediate());
  }

  public replayCommand(intent: KnowledgeCommandReplayIntent): Promise<KnowledgeRevision | null> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => this.replayHostIntent(intent))());
  }

  public saveDraftWithReplayIntent(command: KnowledgeDraftWriteCommand,
    intent: KnowledgeCommandReplayIntent): Promise<KnowledgeRevision> {
    return this.saveDraft(command, intent);
  }

  public reviewWithReplayIntent(command: KnowledgeReviewCommand,
    intent: KnowledgeCommandReplayIntent): Promise<KnowledgeRevision> {
    return this.review(command, intent);
  }

  private replayHostIntent(intent: KnowledgeCommandReplayIntent): KnowledgeRevision | null {
    knowledgeReplayPayload(intent);
    const receipt = this.database.raw.prepare(`
      SELECT request_id, command_digest, operation, knowledge_id, content_revision, result_json, actor_id, governance_version
      FROM diagnostic_knowledge_reviews WHERE request_id = ?
    `).get(intent.requestId) as ReceiptRow | undefined;
    if (!receipt) return null;
    if (receipt.operation !== intent.operation) throw failure('KNOWLEDGE_GOVERNANCE_CONFLICT');
    assertKnowledgeReplayPayload(receipt.result_json, intent);
    const revision = this.readReceiptRevision(receipt);
    if (scopeDigest(revision.scope) !== scopeDigest(intent.scope)) throw failure('KNOWLEDGE_GOVERNANCE_CONFLICT');
    if (revision.status === 'approved') this.assertSourceCurrent(revision);
    return revision;
  }

  public saveDraft(command: KnowledgeDraftWriteCommand, replayIntent?: KnowledgeCommandReplayIntent): Promise<KnowledgeRevision> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      const normalized = normalizeDraft(command);
      const resultJson = replayIntent === undefined ? '{}' : knowledgeReplayPayload(replayIntent,
        'draft', normalized.requestId, normalized.revision.scope);
      if (replayIntent !== undefined) {
        const prior = this.replayHostIntent(replayIntent);
        if (prior) return prior;
      }
      const digest = commandDigest('draft', normalized);
      const receiptDigest = draftReceiptDigest(normalized);
      const receipt = this.findReceipt(normalized.requestId, 'draft', receiptDigest);
      if (receipt) return this.readReceiptRevision(receipt);
      const revision = parseKnowledgeRecord(normalized.revision);
      if (revision.status !== 'draft' || revision.governanceVersion !== 1 || revision.review !== undefined) throw failure('KNOWLEDGE_RECORD_INVALID');
      const scopeKey = scopeDigest(revision.scope);
      const source = selectSource(this.database, revision.provenance.sourceId, normalized.sourceDomainId);
      assertDraftSource(revision, source);
      const natural = this.database.raw.prepare(`
        SELECT knowledge_id, latest_content_revision FROM diagnostic_knowledge_items
        WHERE kind = ? AND scope_key = ? AND natural_key = ?
      `).get(revision.kind, scopeKey, normalized.naturalKey) as { knowledge_id: string; latest_content_revision: number } | undefined;

      if (normalized.expectedContentRevision === null) {
        if (normalized.expectedGovernanceVersion !== null || revision.contentRevision !== 1 || natural
          || this.database.raw.prepare('SELECT 1 FROM diagnostic_knowledge_items WHERE knowledge_id = ?').get(revision.id)) {
          throw failure('KNOWLEDGE_REVISION_CONFLICT');
        }
        this.database.raw.prepare(`
          INSERT INTO diagnostic_knowledge_items(knowledge_id, kind, scope_key, target_id, natural_key, latest_content_revision, created_at)
          VALUES (?, ?, ?, ?, ?, 1, ?)
        `).run(revision.id, revision.kind, scopeKey, revision.scope.targetId, normalized.naturalKey, revision.createdAt);
      } else {
        const expectedContent = normalized.expectedContentRevision;
        const expectedGovernance = normalized.expectedGovernanceVersion;
        if (expectedGovernance === null || revision.contentRevision !== expectedContent + 1
          || natural?.knowledge_id !== revision.id || natural.latest_content_revision !== expectedContent) {
          throw failure('KNOWLEDGE_REVISION_CONFLICT');
        }
        const previous = this.loadRevision(revision.id, expectedContent);
        if (!previous || previous.governanceVersion !== expectedGovernance) throw failure('KNOWLEDGE_GOVERNANCE_CONFLICT');
        if (previous.kind !== revision.kind || scopeDigest(previous.scope) !== scopeKey) throw failure('KNOWLEDGE_SCOPE_INVALID');
        const updated = this.database.raw.prepare(`
          UPDATE diagnostic_knowledge_items SET latest_content_revision = ?
          WHERE knowledge_id = ? AND latest_content_revision = ?
        `).run(revision.contentRevision, revision.id, expectedContent);
        if (updated.changes !== 1) throw failure('KNOWLEDGE_REVISION_CONFLICT');
      }
      this.database.raw.prepare(`
        INSERT INTO diagnostic_knowledge_revisions(
          knowledge_id, content_revision, kind, scope_key, source_id, source_domain_id, source_digest,
          revision_json, content_digest, created_at, valid_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(revision.id, revision.contentRevision, revision.kind, scopeKey,
        revision.provenance.sourceId, normalized.sourceDomainId, revision.provenance.sourceDigest,
        canonicalJson(revision), revision.contentDigest, revision.createdAt, revision.validUntil ?? null);
      this.database.raw.prepare(`
        INSERT INTO diagnostic_knowledge_revision_states(knowledge_id, content_revision, governance_version, status, source_epoch, review_json, updated_at)
        VALUES (?, ?, 1, 'draft', ?, NULL, ?)
      `).run(revision.id, revision.contentRevision, revision.sourceEpoch, revision.createdAt);
      const event = knowledgeAudit(this.ids, {
        requestId: normalized.requestId, commandDigest: digest, actorId: normalized.actorId, revision,
        governanceVersion: 1, afterStatus: 'draft', occurredAt: this.clock.now().toISOString(),
      });
      appendSqliteKnowledgeAuditWithinTransaction(this.database, event);
      this.insertReceipt(normalized.requestId, receiptDigest, 'draft', revision.id, revision.contentRevision, resultJson, normalized.actorId, 1);
      return this.loadRevision(revision.id, revision.contentRevision)!;
    }).immediate());
  }

  public submitForReview(command: KnowledgeSubmissionCommand): Promise<KnowledgeRevision> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      const normalized = normalizeSubmission(command);
      const digest = commandDigest('submit', normalized);
      const receipt = this.findReceipt(normalized.requestId, 'submit', digest);
      if (receipt) return this.readReceiptRevision(receipt);
      const stored = this.loadRevision(normalized.knowledgeId, normalized.expectedContentRevision);
      const item = this.database.raw.prepare('SELECT latest_content_revision FROM diagnostic_knowledge_items WHERE knowledge_id = ?')
        .get(normalized.knowledgeId) as { latest_content_revision: number } | undefined;
      if (!stored || stored.kind !== normalized.kind || item?.latest_content_revision !== normalized.expectedContentRevision) {
        throw failure('KNOWLEDGE_NOT_FOUND');
      }
      if (stored.governanceVersion !== normalized.expectedGovernanceVersion) throw failure('KNOWLEDGE_GOVERNANCE_CONFLICT');
      if (stored.status !== 'draft') throw failure('KNOWLEDGE_TRANSITION_INVALID');
      this.assertSourceCurrent(stored);
      const nextVersion = stored.governanceVersion + 1;
      const updated = this.database.raw.prepare(`
        UPDATE diagnostic_knowledge_revision_states SET governance_version = ?, status = 'review_pending', updated_at = ?
        WHERE knowledge_id = ? AND content_revision = ? AND governance_version = ? AND status = 'draft'
      `).run(nextVersion, this.clock.now().toISOString(), stored.id, stored.contentRevision, stored.governanceVersion);
      if (updated.changes !== 1) throw failure('KNOWLEDGE_GOVERNANCE_CONFLICT');
      const event = knowledgeAudit(this.ids, {
        requestId: normalized.requestId, commandDigest: digest, actorId: normalized.actorId, revision: stored,
        governanceVersion: nextVersion, beforeStatus: 'draft', afterStatus: 'review_pending', occurredAt: this.clock.now().toISOString(),
      });
      appendSqliteKnowledgeAuditWithinTransaction(this.database, event);
      this.insertReceipt(normalized.requestId, digest, 'submit', stored.id, stored.contentRevision, '{}', normalized.actorId, nextVersion);
      return this.loadRevision(stored.id, stored.contentRevision)!;
    }).immediate());
  }

  public review(input: KnowledgeReviewCommand, replayIntent?: KnowledgeCommandReplayIntent): Promise<KnowledgeRevision> {
    return Promise.resolve().then(async () => {
      const command = parseKnowledgeReviewCommand(input);
      const digest = commandDigest('review', command);
      if (replayIntent !== undefined) {
        knowledgeReplayPayload(replayIntent, 'review', command.requestId);
        const replay = await this.replayCommand(replayIntent);
        if (replay) return replay;
      }
      const prior = this.peekReceipt(command.requestId, 'review', digest);
      if (prior) return this.readReceiptRevision(prior, true);
      const authority = await this.options.authority.resolveFor({ knowledgeId: command.knowledgeId, kind: command.kind });
      return this.database.raw.transaction(() => {
        const resultJson = replayIntent === undefined ? '{}' : knowledgeReplayPayload(replayIntent,
          'review', command.requestId, authority.scope);
        if (replayIntent !== undefined) {
          const replay = this.replayHostIntent(replayIntent);
          if (replay) return replay;
        }
        const receipt = this.findReceipt(command.requestId, 'review', digest);
        if (receipt) return this.readReceiptRevision(receipt, true);
        const stored = this.loadRevision(command.knowledgeId, command.expectedContentRevision);
        if (!stored || stored.kind !== command.kind) throw failure('KNOWLEDGE_NOT_FOUND');
        if (stored.governanceVersion !== command.expectedGovernanceVersion) throw failure('KNOWLEDGE_GOVERNANCE_CONFLICT');
        if (stored.contentDigest !== command.contentDigest) throw failure('KNOWLEDGE_DIGEST_MISMATCH');
        if (stored.status !== 'review_pending') throw failure('KNOWLEDGE_TRANSITION_INVALID');
        const trustedScope = parseKnowledgeScope(authority.scope);
        if (canonicalJson(trustedScope) !== canonicalJson(stored.scope)) throw failure('KNOWLEDGE_SCOPE_INVALID');
        this.assertSourceCurrent(stored, authority.sourceEpoch, authority.sourceDigest);
        if (command.decision === 'approve'
          && (!command.checks.sourceVerified || !command.checks.scopeVerified || !command.checks.contentReviewed)) {
          throw failure('KNOWLEDGE_APPROVAL_DENIED');
        }
        const nextStatus = command.decision === 'approve' ? 'approved' : 'rejected';
        const nextVersion = stored.governanceVersion + 1;
        const review = command.decision === 'approve' ? {
          reviewerId: authority.actorId, reviewedAt: authority.reviewedAt, checks: structuredClone(command.checks),
          sourceVerification: { sourceEpoch: authority.sourceEpoch, sourceDigest: authority.sourceDigest },
        } : undefined;
        const updated = this.database.raw.prepare(`
          UPDATE diagnostic_knowledge_revision_states SET governance_version = ?, status = ?, review_json = ?, updated_at = ?
          WHERE knowledge_id = ? AND content_revision = ? AND governance_version = ? AND status = 'review_pending'
        `).run(nextVersion, nextStatus, review === undefined ? null : canonicalJson(review), authority.reviewedAt,
          stored.id, stored.contentRevision, stored.governanceVersion);
        if (updated.changes !== 1) throw failure('KNOWLEDGE_GOVERNANCE_CONFLICT');
        const event = knowledgeAudit(this.ids, {
          requestId: command.requestId, commandDigest: digest, actorId: authority.actorId, revision: stored,
          governanceVersion: nextVersion, beforeStatus: 'review_pending', afterStatus: nextStatus,
          occurredAt: this.clock.now().toISOString(),
        });
        appendSqliteKnowledgeAuditWithinTransaction(this.database, event);
        if (nextStatus === 'approved') this.insertSearchRow(stored);
        this.insertReceipt(command.requestId, digest, 'review', stored.id, stored.contentRevision, resultJson, authority.actorId, nextVersion);
        return this.loadRevision(stored.id, stored.contentRevision)!;
      }).immediate();
    });
  }

  public transitionKnowledge(command: KnowledgeGovernanceTransitionCommand): Promise<KnowledgeRevision> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      const normalized = normalizeGovernanceTransition(command);
      const digest = knowledgeTransitionIntentDigest(normalized);
      const receiptOperation = governanceReceiptOperation(normalized.nextStatus);
      const receipt = this.findKnowledgeTransitionReceipt(normalized, receiptOperation, digest);
      if (receipt) return this.readReceiptRevision(receipt);
      const stored = this.loadRevision(normalized.knowledgeId, normalized.contentRevision);
      if (!stored || stored.kind !== normalized.kind) throw failure('KNOWLEDGE_NOT_FOUND');
      if (stored.governanceVersion !== normalized.expectedGovernanceVersion) throw failure('KNOWLEDGE_GOVERNANCE_CONFLICT');
      if (!isKnowledgeTransitionAllowed(stored.status, normalized.nextStatus)) throw failure('KNOWLEDGE_TRANSITION_INVALID');
      const nextVersion = stored.governanceVersion + 1;
      const updated = this.database.raw.prepare(`
        UPDATE diagnostic_knowledge_revision_states SET governance_version = ?, status = ?, review_json = NULL, updated_at = ?
        WHERE knowledge_id = ? AND content_revision = ? AND governance_version = ? AND status = ?
      `).run(nextVersion, normalized.nextStatus, normalized.occurredAt, stored.id, stored.contentRevision,
        stored.governanceVersion, stored.status);
      if (updated.changes !== 1) throw failure('KNOWLEDGE_GOVERNANCE_CONFLICT');
      const event = knowledgeAudit(this.ids, {
        requestId: normalized.requestId, commandDigest: digest, actorId: normalized.actorId, revision: stored,
        governanceVersion: nextVersion, beforeStatus: stored.status, afterStatus: normalized.nextStatus,
        occurredAt: this.clock.now().toISOString(),
      });
      appendSqliteKnowledgeAuditWithinTransaction(this.database, event);
      this.database.raw.prepare('DELETE FROM diagnostic_knowledge_fts WHERE knowledge_id = ? AND content_revision = ?')
        .run(stored.id, stored.contentRevision);
      this.insertReceipt(normalized.requestId, digest, receiptOperation, stored.id, stored.contentRevision, '{}', normalized.actorId, nextVersion);
      return this.loadRevision(stored.id, stored.contentRevision)!;
    }).immediate());
  }

  public getExact(input: { id: string; contentRevision: number; scope: KnowledgeScope }): Promise<KnowledgeRevision | null> {
    return Promise.resolve().then(() => {
      const scopeKey = scopeDigest(parseKnowledgeScope(input.scope));
      const row = this.database.raw.prepare(`
        SELECT r.knowledge_id, r.content_revision, r.kind, r.scope_key, r.source_id, r.source_domain_id,
          r.source_digest, r.revision_json, r.content_digest, r.valid_until,
          s.governance_version, s.status, s.source_epoch, s.review_json, s.updated_at
        FROM diagnostic_knowledge_revisions r JOIN diagnostic_knowledge_revision_states s
          ON s.knowledge_id = r.knowledge_id AND s.content_revision = r.content_revision
        WHERE r.knowledge_id = ? AND r.content_revision = ? AND r.scope_key = ?
      `).get(input.id, input.contentRevision, scopeKey) as RevisionRow | undefined;
      if (row === undefined) return null;
      const revision = materializeRevision(row);
      if (revision.status !== 'approved' || (revision.validUntil !== undefined && Date.parse(revision.validUntil) <= this.clock.now().getTime())) return null;
      const source = selectSource(this.database, revision.provenance.sourceId, row.source_domain_id);
      if (!source || source.validity !== 'active' || source.sourceEpoch !== revision.sourceEpoch
        || source.sourceDigest !== revision.provenance.sourceDigest) return null;
      return revision;
    });
  }

  public getSourceEpoch(input: { sourceId: string; dataDomainId: string }): Promise<number | null> {
    return Promise.resolve(selectSource(this.database, input.sourceId, input.dataDomainId)?.sourceEpoch ?? null);
  }

  public getSource(input: { sourceId: string; dataDomainId: string }): Promise<KnowledgeSourceState | null> {
    return Promise.resolve(selectSource(this.database, input.sourceId, input.dataDomainId));
  }

  public transitionSource(command: KnowledgeSourceTransitionCommand): Promise<KnowledgeSourceState> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      const normalized = normalizeSourceTransition(command);
      const digest = commandDigest('source_transition', normalized);
      const receipt = this.findReceipt(normalized.requestId, 'source_transition', digest);
      if (receipt) {
        const current = selectSource(this.database, normalized.sourceId, normalized.dataDomainId);
        if (!current) throw failure('KNOWLEDGE_STORAGE_UNAVAILABLE');
        return current;
      }
      const current = selectSource(this.database, normalized.sourceId, normalized.dataDomainId);
      if (!current) throw failure('KNOWLEDGE_NOT_FOUND');
      if (current.sourceEpoch !== normalized.expectedSourceEpoch) throw failure('KNOWLEDGE_GOVERNANCE_CONFLICT');
      const nextEpoch = current.sourceEpoch + 1;
      const validity = normalized.transition === 'revalidated' ? 'active' : normalized.transition;
      const now = this.clock.now().toISOString();
      const source: KnowledgeSourceState = {
        sourceId: current.sourceId, dataDomainId: current.dataDomainId, sourceEpoch: nextEpoch,
        sourceDigest: normalized.sourceDigest, validity, updatedAt: now,
      };
      const event = parseKnowledgeGovernanceAuditV1({
        schemaVersion: 1, auditId: this.ids.next('knowledge-audit'), requestId: normalized.requestId,
        commandDigest: digest, occurredAt: now, actorId: normalized.actorId,
        type: 'source_transition', sourceId: normalized.sourceId, dataDomainId: normalized.dataDomainId,
        beforeSourceEpoch: current.sourceEpoch, afterSourceEpoch: nextEpoch,
        validity: normalized.transition, reasonCode: sourceReason(normalized.transition),
      });
      const updated = this.database.raw.prepare(`
        UPDATE diagnostic_knowledge_sources SET source_epoch = ?, source_digest = ?, validity = ?, updated_at = ?
        WHERE source_id = ? AND data_domain_id = ? AND source_epoch = ?
      `).run(nextEpoch, source.sourceDigest, source.validity, source.updatedAt,
        source.sourceId, source.dataDomainId, current.sourceEpoch);
      if (updated.changes !== 1) throw failure('KNOWLEDGE_GOVERNANCE_CONFLICT');
      this.database.raw.prepare('DELETE FROM diagnostic_knowledge_fts WHERE source_id = ? AND source_domain_id = ?')
        .run(source.sourceId, source.dataDomainId);
      appendSqliteKnowledgeAuditWithinTransaction(this.database, event);
      this.insertReceipt(normalized.requestId, digest, 'source_transition', null, null, '{}', normalized.actorId);
      return source;
    }).immediate());
  }

  public search(input: KnowledgeScopedSearchRequest): Promise<readonly KnowledgeRevision[]> {
    return Promise.resolve().then(() => {
      const scope = parseKnowledgeScope(input.scope);
      validateSearch(input);
      const references = input.references.map(normalizeReference);
      if (references.length === 0 || new Set(references.map((ref) => `${ref.id}\u0000${ref.version}\u0000${ref.digest}`)).size !== references.length) return [];
      const match = buildFtsMatch(input.query);
      if (!match) return [];
      const refClauses = references.map(() => '(r.knowledge_id = ? AND r.content_revision = ? AND r.content_digest = ?)').join(' OR ');
      const refParams = references.flatMap((reference) => [reference.id, contentRevisionFromTargetReference(reference), reference.digest]);
      const eligibleSql = `
        SELECT DISTINCT r.knowledge_id, r.content_revision, r.kind, r.scope_key, r.source_id, r.source_domain_id,
          r.source_digest, r.revision_json, r.content_digest, r.valid_until,
          s.governance_version, s.status, s.source_epoch, s.review_json, s.updated_at
        FROM diagnostic_knowledge_fts
        JOIN diagnostic_knowledge_revisions r
          ON r.knowledge_id = diagnostic_knowledge_fts.knowledge_id
          AND r.content_revision = diagnostic_knowledge_fts.content_revision
        JOIN diagnostic_knowledge_revision_states s
          ON s.knowledge_id = r.knowledge_id AND s.content_revision = r.content_revision
        JOIN diagnostic_knowledge_sources source
          ON source.source_id = r.source_id AND source.data_domain_id = r.source_domain_id
        WHERE diagnostic_knowledge_fts.kind = ?
          AND diagnostic_knowledge_fts.target_id = ? AND diagnostic_knowledge_fts.scope_key = ?
          AND r.kind = ? AND r.scope_key = ?
          AND s.status = 'approved' AND s.source_epoch = source.source_epoch
          AND source.validity = 'active' AND source.source_digest = r.source_digest
          AND (r.valid_until IS NULL OR julianday(r.valid_until) > julianday(?))
          AND (${refClauses})
      `;
      const parameters = [input.kind, scope.targetId, scopeDigest(scope), input.kind, scopeDigest(scope), input.now, ...refParams];
      const rows = this.database.raw.prepare(`${eligibleSql} AND diagnostic_knowledge_fts MATCH ?`).all(...parameters, match) as RevisionRow[];
      const corpus = this.database.raw.prepare(eligibleSql).all(...parameters) as RevisionRow[];
      return rankKnowledgeSearch(rows.map(materializeRevision), knowledgeQueryTokens(input.query), corpus.map((row) => knowledgeContentText(materializeRevision(row))))
        .slice(0, input.limit);
    });
  }

  public inspectExact(input: { id: string; contentRevision: number; scope: KnowledgeScope; now: string }): Promise<KnowledgeRevisionStateSnapshot | null> {
    return Promise.resolve().then(() => {
      const revision = this.loadRevision(input.id, input.contentRevision);
      if (!revision || scopeDigest(revision.scope) !== scopeDigest(parseKnowledgeScope(input.scope))) return null;
      const source = selectSource(this.database, revision.provenance.sourceId,
        this.readRevisionSourceDomain(input.id, input.contentRevision));
      return {
        knowledgeId: revision.id, kind: revision.kind, contentRevision: revision.contentRevision,
        governanceVersion: revision.governanceVersion, contentDigest: revision.contentDigest,
        status: revision.status, sourceEpoch: revision.sourceEpoch, currentSourceEpoch: source?.sourceEpoch ?? null,
        sourceValidity: source?.validity ?? 'missing', sourceDigestMatches: source?.sourceDigest === revision.provenance.sourceDigest,
        ...(revision.validUntil === undefined ? {} : { validUntil: revision.validUntil }),
        eligibleAt: input.now,
      };
    });
  }

  public listPending(limit: number): Promise<readonly KnowledgeGovernanceAuditV1[]> {
    if (!validLimit(limit, 500)) return Promise.reject(failure('KNOWLEDGE_AUDIT_INVALID'));
    const rows = this.database.raw.prepare(`
      SELECT a.sequence, a.audit_json FROM diagnostic_knowledge_outbox o
      JOIN diagnostic_knowledge_audits a ON a.audit_id = o.audit_id
      WHERE o.state = 'pending' ORDER BY a.sequence LIMIT ?
    `).all(limit) as AuditRow[];
    return Promise.resolve(rows.map((row) => parseKnowledgeGovernanceAuditV1(JSON.parse(row.audit_json) as unknown)));
  }

  public markDelivered(input: { auditId: string; deliveredAt: string }): Promise<void> {
    return Promise.resolve().then(() => {
      validateTime(input.deliveredAt);
      this.database.raw.prepare(`
        UPDATE diagnostic_knowledge_outbox SET state = 'delivered', delivered_at = ?
        WHERE audit_id = ? AND state = 'pending'
      `).run(input.deliveredAt, input.auditId);
    });
  }

  public recordDeliveryFailure(auditId: string): Promise<void> {
    return Promise.resolve().then(() => {
      this.database.raw.prepare(`UPDATE diagnostic_knowledge_outbox SET attempts = attempts + 1 WHERE audit_id = ? AND state = 'pending'`).run(auditId);
    });
  }

  public appendWithinTransaction(event: KnowledgeGovernanceAuditV1): void {
    appendSqliteKnowledgeAuditWithinTransaction(this.database, event);
  }

  public list(input: { targetId?: string; afterAuditId?: string; limit: number }): Promise<readonly KnowledgeGovernanceAuditV1[]> {
    if (!validLimit(input.limit, 500)) return Promise.reject(failure('KNOWLEDGE_AUDIT_INVALID'));
    if (input.afterAuditId !== undefined) {
      const cursor = this.database.raw.prepare('SELECT sequence FROM diagnostic_knowledge_audits WHERE audit_id = ?').get(input.afterAuditId) as { sequence: number } | undefined;
      if (!cursor) return Promise.resolve([]);
      const rows = input.targetId === undefined
        ? this.database.raw.prepare('SELECT sequence, audit_json FROM diagnostic_knowledge_audits WHERE sequence > ? ORDER BY sequence LIMIT ?').all(cursor.sequence, input.limit) as AuditRow[]
        : this.database.raw.prepare(`SELECT sequence, audit_json FROM diagnostic_knowledge_audits
            WHERE sequence > ? AND target_id = ? ORDER BY sequence LIMIT ?`).all(cursor.sequence, input.targetId, input.limit) as AuditRow[];
      return Promise.resolve(rows.map((row) => parseKnowledgeGovernanceAuditV1(JSON.parse(row.audit_json) as unknown)));
    }
    const rows = input.targetId === undefined
      ? this.database.raw.prepare('SELECT sequence, audit_json FROM diagnostic_knowledge_audits ORDER BY sequence LIMIT ?').all(input.limit) as AuditRow[]
      : this.database.raw.prepare(`SELECT sequence, audit_json FROM diagnostic_knowledge_audits
          WHERE target_id = ? ORDER BY sequence LIMIT ?`).all(input.targetId, input.limit) as AuditRow[];
    return Promise.resolve(rows.map((row) => parseKnowledgeGovernanceAuditV1(JSON.parse(row.audit_json) as unknown)));
  }

  private loadRevision(id: string, contentRevision: number): KnowledgeRevision | null {
    const row = this.database.raw.prepare(`
      SELECT r.knowledge_id, r.content_revision, r.kind, r.scope_key, r.source_id, r.source_domain_id,
        r.source_digest, r.revision_json, r.content_digest, r.valid_until,
        s.governance_version, s.status, s.source_epoch, s.review_json, s.updated_at
      FROM diagnostic_knowledge_revisions r JOIN diagnostic_knowledge_revision_states s
        ON s.knowledge_id = r.knowledge_id AND s.content_revision = r.content_revision
      WHERE r.knowledge_id = ? AND r.content_revision = ?
    `).get(id, contentRevision) as RevisionRow | undefined;
    return row === undefined ? null : materializeRevision(row);
  }

  private assertSourceCurrent(revision: KnowledgeRevision, expectedEpoch?: number, expectedDigest?: string, at = this.clock.now().toISOString()): void {
    const domain = this.readRevisionSourceDomain(revision.id, revision.contentRevision);
    const source = selectSource(this.database, revision.provenance.sourceId, domain);
    assertCurrentSource(revision, source, expectedEpoch, expectedDigest, at);
  }

  private readRevisionSourceDomain(id: string, contentRevision: number): string {
    const row = this.database.raw.prepare(`SELECT source_domain_id FROM diagnostic_knowledge_revisions WHERE knowledge_id = ? AND content_revision = ?`)
      .get(id, contentRevision) as { source_domain_id: string } | undefined;
    if (!row) throw failure('KNOWLEDGE_NOT_FOUND');
    return row.source_domain_id;
  }

  private insertSearchRow(revision: KnowledgeRevision): void {
    const domain = this.readRevisionSourceDomain(revision.id, revision.contentRevision);
    this.database.raw.prepare(`
      INSERT INTO diagnostic_knowledge_fts(knowledge_id, content_revision, kind, target_id, scope_key, source_id, source_domain_id, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(revision.id, revision.contentRevision, revision.kind, revision.scope.targetId,
      scopeDigest(revision.scope), revision.provenance.sourceId, domain, knowledgeContentText(revision));
  }

  private findReceipt(requestId: string, operation: string, digest: string): ReceiptRow | null {
    const row = this.peekReceipt(requestId, operation, digest);
    return row ?? null;
  }

  private findKnowledgeTransitionReceipt(command: KnowledgeGovernanceTransitionCommand, operation: string,
    digest: string): ReceiptRow | null {
    const row = this.database.raw.prepare(`
      SELECT request_id, command_digest, operation, knowledge_id, content_revision, result_json, actor_id, governance_version
      FROM diagnostic_knowledge_reviews WHERE request_id = ?
    `).get(command.requestId) as ReceiptRow | undefined;
    if (!row) return null;
    if (row.operation !== operation) throw failure('KNOWLEDGE_GOVERNANCE_CONFLICT');
    if (row.command_digest === digest) return row;

    // Pre-fix receipts hashed occurredAt into command_digest. Accept their replay only
    // when every durable semantic field matches; the new timestamp is host metadata.
    const revision = row.knowledge_id !== null && row.content_revision !== null
      ? this.loadRevision(row.knowledge_id, row.content_revision) : null;
    if (row.actor_id !== command.actorId || row.knowledge_id !== command.knowledgeId
      || row.content_revision !== command.contentRevision
      || row.governance_version !== command.expectedGovernanceVersion + 1
      || revision?.kind !== command.kind) {
      throw failure('KNOWLEDGE_GOVERNANCE_CONFLICT');
    }
    return row;
  }

  private peekReceipt(requestId: string, operation: string, digest: string): ReceiptRow | null {
    const row = this.database.raw.prepare(`
      SELECT request_id, command_digest, operation, knowledge_id, content_revision, result_json, actor_id, governance_version
      FROM diagnostic_knowledge_reviews WHERE request_id = ?
    `).get(requestId) as ReceiptRow | undefined;
    if (!row) return null;
    if (row.operation !== operation || row.command_digest !== digest) throw failure('KNOWLEDGE_GOVERNANCE_CONFLICT');
    return row;
  }

  private readReceiptRevision(receipt: ReceiptRow, requireApprovedEligibility = false): KnowledgeRevision {
    if (!receipt.knowledge_id || receipt.content_revision === null) throw failure('KNOWLEDGE_STORAGE_UNAVAILABLE');
    const current = this.loadRevision(receipt.knowledge_id, receipt.content_revision);
    if (!current) throw failure('KNOWLEDGE_STORAGE_UNAVAILABLE');
    if (requireApprovedEligibility && current.status === 'approved') this.assertSourceCurrent(current);
    return current;
  }

  private insertReceipt(requestId: string, digest: string, operation: string, knowledgeId: string | null,
    contentRevision: number | null, resultJson: string, actorId: string, governanceVersion: number | null = null): void {
    this.database.raw.prepare(`
      INSERT INTO diagnostic_knowledge_reviews(request_id, command_digest, operation, knowledge_id, content_revision, governance_version, actor_id, result_json, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(requestId, digest, operation, knowledgeId, contentRevision, governanceVersion, actorId, resultJson, this.clock.now().toISOString());
  }
}

export function appendSqliteKnowledgeAuditWithinTransaction(database: SqliteDatabase, input: KnowledgeGovernanceAuditV1): void {
  if (!database.raw.inTransaction) throw new Error('Knowledge audit append requires an active SQLite transaction');
  const event = parseKnowledgeGovernanceAuditV1(input);
  database.raw.prepare(`
    INSERT INTO diagnostic_knowledge_audits(audit_id, request_id, command_digest, actor_id, target_id, occurred_at, audit_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(event.auditId, event.requestId, event.commandDigest, event.actorId,
    'targetId' in event ? event.targetId : null, event.occurredAt, canonicalJson(event));
  database.raw.prepare(`INSERT INTO diagnostic_knowledge_outbox(audit_id, state, attempts, created_at, delivered_at)
    VALUES (?, 'pending', 0, ?, NULL)`).run(event.auditId, event.occurredAt);
}

export function assertSqliteKnowledgeReferenceEligible(database: SqliteDatabase, reference: TargetKnowledgeReference,
  scope: KnowledgeScope, now: string): KnowledgeRevision {
  const contentRevision = contentRevisionFromTargetReference(reference);
  const row = database.raw.prepare(`
    SELECT r.knowledge_id, r.content_revision, r.kind, r.scope_key, r.source_id, r.source_domain_id,
      r.source_digest, r.revision_json, r.content_digest, r.valid_until,
      s.governance_version, s.status, s.source_epoch, s.review_json, s.updated_at
    FROM diagnostic_knowledge_revisions r JOIN diagnostic_knowledge_revision_states s
      ON s.knowledge_id = r.knowledge_id AND s.content_revision = r.content_revision
    WHERE r.knowledge_id = ? AND r.content_revision = ?
  `).get(reference.id, contentRevision) as RevisionRow | undefined;
  if (!row) throw failure('KNOWLEDGE_NOT_FOUND');
  const revision = materializeRevision(row);
  if (scopeDigest(revision.scope) !== scopeDigest(parseKnowledgeScope(scope))) throw failure('KNOWLEDGE_SCOPE_INVALID');
  if (revision.contentDigest !== reference.digest) throw failure('KNOWLEDGE_DIGEST_MISMATCH');
  if (revision.status !== 'approved') throw failure('KNOWLEDGE_APPROVAL_DENIED');
  if (revision.validUntil !== undefined && Date.parse(revision.validUntil) <= Date.parse(now)) throw failure('KNOWLEDGE_EXPIRED');
  const source = selectSource(database, revision.provenance.sourceId, row.source_domain_id);
  assertCurrentSource(revision, source, undefined, undefined, now);
  return revision;
}

export function selectSqliteKnowledgeSource(database: SqliteDatabase, sourceId: string, dataDomainId: string): KnowledgeSourceState | null {
  return selectSource(database, sourceId, dataDomainId);
}

function selectSource(database: SqliteDatabase, sourceId: string, dataDomainId: string): KnowledgeSourceState | null {
  const row = database.raw.prepare(`SELECT source_id, data_domain_id, source_epoch, source_digest, validity, updated_at
    FROM diagnostic_knowledge_sources WHERE source_id = ? AND data_domain_id = ?`).get(sourceId, dataDomainId) as SourceRow | undefined;
  return row === undefined ? null : {
    sourceId: row.source_id, dataDomainId: row.data_domain_id, sourceEpoch: row.source_epoch,
    sourceDigest: row.source_digest, validity: row.validity, updatedAt: row.updated_at,
  };
}

function materializeRevision(row: RevisionRow): KnowledgeRevision {
  const immutable = JSON.parse(row.revision_json) as Record<string, unknown>;
  const review = row.review_json === null ? undefined : JSON.parse(row.review_json) as NonNullable<KnowledgeRevision['review']>;
  return parseKnowledgeRecord({
    ...immutable, governanceVersion: row.governance_version, status: row.status, sourceEpoch: row.source_epoch,
    ...(review === undefined ? {} : { review }),
  });
}

function assertDraftSource(revision: KnowledgeRevision, source: KnowledgeSourceState | null): void {
  if (!source || source.validity !== 'active' || source.sourceEpoch !== revision.sourceEpoch) throw failure('KNOWLEDGE_SOURCE_REVOKED');
  if (source.sourceDigest !== revision.provenance.sourceDigest) throw failure('KNOWLEDGE_DIGEST_MISMATCH');
}

function assertCurrentSource(revision: KnowledgeRevision, source: KnowledgeSourceState | null,
  expectedEpoch?: number, expectedDigest?: string, at = new Date().toISOString()): void {
  if (!source || source.validity !== 'active') throw failure('KNOWLEDGE_SOURCE_REVOKED');
  if (source.sourceDigest !== revision.provenance.sourceDigest
    || (expectedDigest !== undefined && expectedDigest !== source.sourceDigest)) throw failure('KNOWLEDGE_DIGEST_MISMATCH');
  if (source.sourceEpoch !== revision.sourceEpoch || (expectedEpoch !== undefined && expectedEpoch !== source.sourceEpoch)) {
    throw failure('KNOWLEDGE_SOURCE_REVOKED');
  }
  if (revision.validUntil !== undefined && Date.parse(revision.validUntil) <= Date.parse(at)) throw failure('KNOWLEDGE_EXPIRED');
}

function normalizeDraft(command: KnowledgeDraftWriteCommand): KnowledgeDraftWriteCommand {
  if (!command.requestId.trim() || !command.actorId.trim() || !command.naturalKey.trim() || !command.sourceDomainId.trim()
    || ((command.expectedContentRevision === null) !== (command.expectedGovernanceVersion === null))) throw failure('KNOWLEDGE_RECORD_INVALID');
  if (command.intentDigest !== undefined && !/^[a-f0-9]{64}$/u.test(command.intentDigest)) throw failure('KNOWLEDGE_RECORD_INVALID');
  return { ...structuredClone(command), revision: parseKnowledgeRecord(command.revision) };
}

function normalizeSubmission(command: KnowledgeSubmissionCommand): KnowledgeSubmissionCommand {
  if (!command.requestId.trim() || !command.actorId.trim() || !command.knowledgeId.trim()
    || !positive(command.expectedContentRevision) || !positive(command.expectedGovernanceVersion)) throw failure('KNOWLEDGE_REVIEW_COMMAND_INVALID');
  return structuredClone(command);
}

function normalizeGovernanceTransition(command: KnowledgeGovernanceTransitionCommand): KnowledgeGovernanceTransitionCommand {
  if (!command.requestId.trim() || !command.actorId.trim() || !command.knowledgeId.trim()
    || !positive(command.contentRevision) || !positive(command.expectedGovernanceVersion)) throw failure('KNOWLEDGE_REVIEW_COMMAND_INVALID');
  validateTime(command.occurredAt);
  return structuredClone(command);
}

function normalizeSourceTransition(command: KnowledgeSourceTransitionCommand): KnowledgeSourceTransitionCommand {
  if (!command.requestId.trim() || !command.actorId.trim() || !command.sourceId.trim() || !command.dataDomainId.trim()
    || !Number.isSafeInteger(command.expectedSourceEpoch) || command.expectedSourceEpoch < 0) throw failure('KNOWLEDGE_AUDIT_INVALID');
  validateDigest(command.sourceDigest);
  validateTime(command.occurredAt);
  return structuredClone(command);
}

function validateSearch(input: KnowledgeScopedSearchRequest): void {
  if (typeof input.query !== 'string' || Buffer.byteLength(input.query, 'utf8') > 512 || !validLimit(input.limit, 50)) throw failure('KNOWLEDGE_RECORD_INVALID');
  validateTime(input.now);
}

function normalizeReference(reference: TargetKnowledgeReference): TargetKnowledgeReference {
  if (!reference.id.trim() || reference.approval !== 'approved' || !/^[1-9]\d*$/u.test(reference.version)
    || !Number.isSafeInteger(Number(reference.version)) || !/^[a-f0-9]{64}$/u.test(reference.digest)) throw failure('KNOWLEDGE_RECORD_INVALID');
  return reference;
}

function buildFtsMatch(query: string): string {
  const tokens = knowledgeQueryTokens(query);
  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND ');
}

function knowledgeAudit(ids: IdGenerator, input: { requestId: string; commandDigest: string; actorId: string; revision: KnowledgeRevision;
  governanceVersion: number; beforeStatus?: KnowledgeRevision['status']; afterStatus: KnowledgeRevision['status']; occurredAt: string }): KnowledgeGovernanceAuditV1 {
  const revision = input.revision;
  return parseKnowledgeGovernanceAuditV1({
    schemaVersion: 1, auditId: ids.next('knowledge-audit'), requestId: input.requestId,
    commandDigest: input.commandDigest, occurredAt: input.occurredAt, actorId: input.actorId,
    type: 'knowledge_transition', knowledgeId: revision.id, knowledgeKind: revision.kind,
    contentRevision: revision.contentRevision, governanceVersion: input.governanceVersion,
    ...(input.beforeStatus === undefined ? {} : { beforeStatus: input.beforeStatus }), afterStatus: input.afterStatus,
    targetId: revision.scope.targetId, scopeDigest: scopeDigest(revision.scope), sourceEpoch: revision.sourceEpoch,
    contentDigest: revision.contentDigest,
  });
}

function sourceReason(transition: KnowledgeSourceTransition): 'SOURCE_WITHDRAWN' | 'SOURCE_DIGEST_MISMATCH' | 'SOURCE_PERMISSION_REVOKED' | 'SOURCE_REVALIDATED' {
  switch (transition) {
    case 'revoked': return 'SOURCE_WITHDRAWN';
    case 'digest_mismatch': return 'SOURCE_DIGEST_MISMATCH';
    case 'permission_revoked': return 'SOURCE_PERMISSION_REVOKED';
    case 'revalidated': return 'SOURCE_REVALIDATED';
  }
}

function governanceReceiptOperation(status: KnowledgeGovernanceTransitionCommand['nextStatus']): 'revoke' | 'supersede' | 'expire' | 'conflict' {
  switch (status) {
    case 'revoked': return 'revoke';
    case 'superseded': return 'supersede';
    case 'expired': return 'expire';
    case 'conflict': return 'conflict';
  }
}

function commandDigest(operation: string, command: unknown): string { return checkpointChecksum({ operation, command }); }
function knowledgeTransitionIntentDigest(command: KnowledgeGovernanceTransitionCommand): string {
  // The timestamp is host-generated execution metadata. A retry with the same requestId
  // must replay the original receipt even when the retry happens at a later instant.
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
function scopeDigest(scope: KnowledgeScope): string { return checkpointChecksum(scope); }
function positive(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function validLimit(value: number, max: number): boolean { return Number.isSafeInteger(value) && value >= 1 && value <= max; }
function validateDigest(value: string): void { if (!/^[a-f0-9]{64}$/u.test(value)) throw failure('KNOWLEDGE_DIGEST_MISMATCH'); }
function validateTime(value: string): void { if (!Number.isFinite(Date.parse(value))) throw failure('KNOWLEDGE_RECORD_INVALID'); }
function failure(code: ConstructorParameters<typeof KnowledgeContractError>[0]): KnowledgeContractError { return new KnowledgeContractError(code); }
