import type { IdGenerator, Clock } from '../../contracts/common.js';
import { systemClock, randomIdGenerator } from '../../contracts/common.js';
import { KnowledgeContractError, type TargetKnowledgeBindingPublisher, type TargetKnowledgePublication,
  type TargetKnowledgePublishCommand } from '../../contracts/knowledge-memory.js';
import { parseKnowledgeGovernanceAuditV1 } from '../../contracts/knowledge-governance-audit.js';
import { assertGovernedPublicationFence, normalizeKnowledgePublication, validateKnowledgePublicationPolicy, validateKnowledgeReference } from '../../contracts/knowledge-storage-behavior.js';
import { checkpointChecksum, canonicalJson } from '../../contracts/stable-json.js';
import type { GovernedKnowledgePublicationPort, GovernedKnowledgePublicationCommand, KnowledgePublicationActorPort, KnowledgePublicationInspectionPort, KnowledgePublicationSnapshot } from '../../contracts/knowledge-memory-storage.js';
import type { SqliteDatabase } from './database.js';
import { appendSqliteKnowledgeAuditWithinTransaction, assertSqliteKnowledgeReferenceEligible, supersedeSqliteKnowledgeWithinPublication } from './knowledge-memory-store.js';
import { inspectSqlitePublicationFence } from './target-identity-store.js';

interface PublicationRow {
  request_id: string;
  command_digest: string;
  target_id: string;
  publication_version: number;
  scope_key: string;
  policy_version: string;
  publication_json: string;
  published_at: string;
}
export interface SqliteTargetKnowledgeBindingStoreOptions {
  actors: KnowledgePublicationActorPort;
  clock?: Clock;
  ids?: IdGenerator;
}

/** Same-database Target knowledge publication pointer and append-only history. */
export class SqliteTargetKnowledgeBindingStore implements TargetKnowledgeBindingPublisher, KnowledgePublicationInspectionPort, GovernedKnowledgePublicationPort {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  public constructor(private readonly database: SqliteDatabase, private readonly options: SqliteTargetKnowledgeBindingStoreOptions) {
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? randomIdGenerator;
  }

  public get(targetId: string): Promise<TargetKnowledgePublication | null> {
    const row = this.database.raw.prepare(`SELECT binding_json FROM target_knowledge_bindings WHERE target_id = ?`).get(targetId) as { binding_json: string } | undefined;
    return Promise.resolve(row === undefined ? null : parsePublication(JSON.parse(row.binding_json) as unknown));
  }

  public inspectBinding(targetId: string): Promise<KnowledgePublicationSnapshot> {
    return Promise.resolve(this.inspectBindingSync(targetId));
  }

  private inspectBindingSync(targetId: string): KnowledgePublicationSnapshot {
    const row = this.database.raw.prepare(`SELECT scope_key, binding_json FROM target_knowledge_bindings WHERE target_id = ?`).get(targetId) as
      { scope_key: string; binding_json: string } | undefined;
    return row === undefined
      ? { publication: null, scopeKey: null }
      : { publication: parsePublication(JSON.parse(row.binding_json) as unknown), scopeKey: row.scope_key };
  }

  public inspectPublishedSelection(targetId: string) {
    return Promise.resolve().then(() => this.database.raw.transaction(() => ({
      binding: this.inspectBindingSync(targetId), hostPolicy: inspectSqlitePublicationFence(this.database, targetId).policy,
    }))());
  }

  public publish(input: TargetKnowledgePublishCommand): Promise<TargetKnowledgePublication> {
    return this.publishAtomic(input);
  }

  public publishGoverned(input: GovernedKnowledgePublicationCommand): Promise<TargetKnowledgePublication> {
    const captured = structuredClone(input);
    return this.publishAtomic(captured.command, captured);
  }

  private publishAtomic(input: TargetKnowledgePublishCommand, governed?: GovernedKnowledgePublicationCommand): Promise<TargetKnowledgePublication> {
    return Promise.resolve().then(async () => {
      const command = normalizeKnowledgePublication(input);
      let digest = checkpointChecksum({ operation: 'publication', command });
      const prior = this.findPublication(command.requestId);
      if (prior && governed === undefined) return replayPublication(prior, digest);
      const authority = await this.options.actors.resolveForTarget({ targetId: command.targetId, requestId: command.requestId });
      if (!authority.actorId.trim()) throw failure('KNOWLEDGE_AUDIT_INVALID');
      if (governed !== undefined) digest = checkpointChecksum({ operation: 'governed_publication', actorId: authority.actorId,
        command: { ...command, publishedAt: null } });
      return this.database.raw.transaction(() => {
        const repeated = this.findPublication(command.requestId);
        if (repeated) return replayPublication(repeated, digest);
        if (governed !== undefined) assertGovernedPublicationFence({ ...governed, command },
          inspectSqlitePublicationFence(this.database, command.targetId));
        if (command.scope.targetId !== command.targetId || command.policy.targetId !== command.targetId) throw failure('KNOWLEDGE_SCOPE_INVALID');
        const current = this.database.raw.prepare(`SELECT publication_version FROM target_knowledge_bindings WHERE target_id = ?`)
          .get(command.targetId) as { publication_version: number } | undefined;
        const currentVersion = current?.publication_version ?? 0;
        if (currentVersion !== command.expectedPublicationVersion) throw failure('KNOWLEDGE_PUBLICATION_CONFLICT');
        const now = this.clock.now().toISOString();
        for (const reference of command.references) {
          const revision = assertSqliteKnowledgeReferenceEligible(this.database, reference, command.scope, now);
          if (governed !== undefined) {
            const pin = governed.expectedRevisions.find(pin => canonicalJson(pin.reference) === canonicalJson(reference))!;
            if (revision.governanceVersion !== pin.governanceVersion) throw failure('KNOWLEDGE_GOVERNANCE_CONFLICT');
            if (revision.sourceEpoch !== pin.sourceEpoch) throw failure('KNOWLEDGE_SOURCE_REVOKED');
          }
        }
        if (governed !== undefined) {
          const previous = this.database.raw.prepare('SELECT binding_json FROM target_knowledge_bindings WHERE target_id = ?')
            .get(command.targetId) as { binding_json: string } | undefined;
          for (const old of previous === undefined ? [] : parsePublication(JSON.parse(previous.binding_json) as unknown).references) {
            if (command.references.some(ref => ref.id === old.id && Number(ref.version) > Number(old.version))) {
              supersedeSqliteKnowledgeWithinPublication(this.database, old, command.scope, {
                requestId: command.requestId, commandDigest: digest, actorId: authority.actorId, now, ids: this.ids });
            }
          }
        }
        const publication: TargetKnowledgePublication = {
          targetId: command.targetId, publicationVersion: currentVersion + 1,
          references: structuredClone(command.references), policy: structuredClone(command.policy), publishedAt: now,
        };
        const scopeKey = checkpointChecksum(command.scope);
        const publicationJson = canonicalJson(publication);
        const event = parseKnowledgeGovernanceAuditV1({
          schemaVersion: 1, auditId: this.ids.next('knowledge-audit'), requestId: command.requestId,
          commandDigest: digest, occurredAt: now, actorId: authority.actorId,
          type: 'binding_publication', targetId: command.targetId, scopeDigest: scopeKey,
          beforePublicationVersion: currentVersion, afterPublicationVersion: publication.publicationVersion,
          policyVersion: command.policy.policyVersion, referenceDigest: checkpointChecksum(command.references),
        });
        this.database.raw.prepare(`
          INSERT INTO diagnostic_knowledge_publications(request_id, command_digest, target_id, publication_version,
            scope_key, policy_version, publication_json, published_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(command.requestId, digest, command.targetId, publication.publicationVersion, scopeKey,
          command.policy.policyVersion, publicationJson, publication.publishedAt);
        if (current === undefined) {
          this.database.raw.prepare(`INSERT INTO target_knowledge_bindings(target_id, publication_version, scope_key, policy_version, binding_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`).run(command.targetId, publication.publicationVersion, scopeKey,
            command.policy.policyVersion, publicationJson, publication.publishedAt);
        } else {
          const updated = this.database.raw.prepare(`UPDATE target_knowledge_bindings SET publication_version = ?, scope_key = ?,
            policy_version = ?, binding_json = ?, updated_at = ? WHERE target_id = ? AND publication_version = ?`)
            .run(publication.publicationVersion, scopeKey, command.policy.policyVersion, publicationJson,
              publication.publishedAt, command.targetId, currentVersion);
          if (updated.changes !== 1) throw failure('KNOWLEDGE_PUBLICATION_CONFLICT');
        }
        appendSqliteKnowledgeAuditWithinTransaction(this.database, event);
        return structuredClone(publication);
      }).immediate();
    });
  }

  private findPublication(requestId: string): PublicationRow | null {
    const row = this.database.raw.prepare(`SELECT request_id, command_digest, target_id, publication_version, scope_key,
      policy_version, publication_json, published_at FROM diagnostic_knowledge_publications WHERE request_id = ?`)
      .get(requestId) as PublicationRow | undefined;
    return row ?? null;
  }
}

function replayPublication(row: PublicationRow, expectedDigest: string): TargetKnowledgePublication {
  if (row.command_digest !== expectedDigest) throw failure('KNOWLEDGE_PUBLICATION_CONFLICT');
  return parsePublication(JSON.parse(row.publication_json) as unknown);
}

function parsePublication(value: unknown): TargetKnowledgePublication {
  if (typeof value !== 'object' || value === null) throw failure('KNOWLEDGE_STORAGE_UNAVAILABLE');
  const publication = value as Partial<TargetKnowledgePublication>;
  if (typeof publication.targetId !== 'string' || !publication.targetId.trim()
    || typeof publication.publicationVersion !== 'number' || !Number.isSafeInteger(publication.publicationVersion)
    || publication.publicationVersion < 1
    || !Array.isArray(publication.references) || typeof publication.publishedAt !== 'string'
    || typeof publication.policy !== 'object' || publication.policy === null) throw failure('KNOWLEDGE_STORAGE_UNAVAILABLE');
  const scopePolicy = publication.policy;
  validateKnowledgePublicationPolicy(scopePolicy);
  return {
    targetId: publication.targetId, publicationVersion: publication.publicationVersion,
    references: publication.references.map(validateKnowledgeReference), policy: structuredClone(scopePolicy), publishedAt: publication.publishedAt,
  };
}

function failure(code: ConstructorParameters<typeof KnowledgeContractError>[0]): KnowledgeContractError {
  return new KnowledgeContractError(code);
}
