import { systemClock, type Clock, type IdGenerator } from '../../contracts/common.js';
import type { EventStore, MessageStore } from '../../contracts/event-store.js';
import type { MemoryCaptureSource, MemoryMaintenance, MemoryQueryStore, MemoryWriteUnitOfWork } from '../../contracts/diagnostic-memory.js';
import type {
  AgentStateUnitOfWork,
  DurableEventOutbox,
  DurableTransitionUnitOfWork,
  EvidenceBlobStore,
  EvidenceManifestStore,
  EvidenceQueryStore,
  EvidenceStore,
  ToolExecutionJournal,
  VersionedCheckpointStore,
} from '../../contracts/storage.js';
import type { ProjectionCheckpointStoreV2 } from '../../event/v2/projection-runner.js';
import type { ProjectionFailureSinkV2 } from '../../event/v2/event-publisher.js';
import type { KnowledgeReviewAuthorityPort } from '../../contracts/knowledge-memory.js';
import type { KnowledgePublicationActorPort } from '../../contracts/knowledge-memory-storage.js';
import type { InspectionQueryService } from '../../contracts/read-model.js';
import type { MessageCursorCodec, WebMessageQueries } from '../../contracts/web-read-model.js';
import type { TargetBindingStore, TargetIdentityRegistry, TargetKnowledgePolicyStore, TargetStartStore } from '../../contracts/target.js';
import { SqliteDatabase } from './database.js';
import { SqliteDurableStateStore } from './durable-state-store.js';
import { SqliteEventOutboxStore } from './event-outbox-store.js';
import { SqliteEventMessageStore } from './event-message-store.js';
import { SqliteProjectionCheckpointStore, SqliteProjectionFailureSink } from './projection-store.js';
import { SqliteEvidenceStore } from './sqlite-evidence-store.js';
import { SqliteEvidenceManifestStore } from './blob-manifest-store.js';
import { LocalEvidenceBlobStore } from '../blob/local-evidence-blob-store.js';
import { SqliteInspectionQueryService } from './inspection-query-service.js';
import { SqliteWebMessageQuery } from './web-message-query.js';
import { SqliteDiagnosticMemoryStore } from './diagnostic-memory-store.js';
import { SqliteMemoryCaptureSource } from './memory-capture-source.js';
import { SqliteTargetIdentityStore } from './target-identity-store.js';
import { SqliteGovernedKnowledgeStore } from './knowledge-memory-store.js';
import { SqliteTargetKnowledgeBindingStore } from './target-knowledge-binding-store.js';
import { KnowledgeAuditDispatcher, type KnowledgeAuditSink } from '../../memory/knowledge-audit-dispatcher.js';
import { KnowledgeContractError } from '../../contracts/knowledge-memory.js';

export interface SqlitePersistenceLimits {
  maxEvidenceRawBytes?: number;
}

export interface CreateSqlitePersistenceOptions {
  path: string;
  clock?: Clock;
  limits?: SqlitePersistenceLimits;
  evidenceBlobRootPath?: string;
  ids?: IdGenerator;
  knowledgeReviewAuthority?: KnowledgeReviewAuthorityPort;
  knowledgePublicationActors?: KnowledgePublicationActorPort;
  knowledgeAuditSink?: KnowledgeAuditSink;
}

/** Single ownership boundary for all SQLite-backed Agent state. */
export interface SqlitePersistenceBundle {
  memory: { queries: MemoryQueryStore; writes: MemoryWriteUnitOfWork;
    maintenance: MemoryMaintenance; captureSource: MemoryCaptureSource };
  checkpoints: VersionedCheckpointStore;
  executions: ToolExecutionJournal;
  stateUnitOfWork: AgentStateUnitOfWork;
  transitions: DurableTransitionUnitOfWork;
  outbox: DurableEventOutbox;
  targetBindings: TargetBindingStore;
  targetStarts: TargetStartStore;
  targetIdentityRegistry: TargetIdentityRegistry;
  targetKnowledgePolicies: TargetKnowledgePolicyStore;
  knowledge: SqliteGovernedKnowledgeStore;
  targetKnowledgeBindings: SqliteTargetKnowledgeBindingStore;
  knowledgeAuditDispatcher?: KnowledgeAuditDispatcher;
  evidence: EvidenceStore & EvidenceQueryStore;
  evidenceManifests: EvidenceManifestStore;
  evidenceBlobs?: EvidenceBlobStore;
  eventMessages: EventStore & MessageStore;
  webMessages(cursorCodec: MessageCursorCodec): WebMessageQueries;
  queries: InspectionQueryService;
  projectionCheckpoints: ProjectionCheckpointStoreV2;
  projectionFailures: ProjectionFailureSinkV2;
  close(): void;
}

export function createSqlitePersistence(options: CreateSqlitePersistenceOptions): SqlitePersistenceBundle {
  const database = SqliteDatabase.open(options.path);
  try {
    const clock = options.clock ?? systemClock;
    const durable = new SqliteDurableStateStore(database, clock);
    const targetIdentityStore = new SqliteTargetIdentityStore(database, { clock });
    const knowledge = new SqliteGovernedKnowledgeStore(database, {
      authority: options.knowledgeReviewAuthority ?? unavailableReviewAuthority,
      clock,
      ...(options.ids === undefined ? {} : { ids: options.ids }),
    });
    const targetKnowledgeBindings = new SqliteTargetKnowledgeBindingStore(database, {
      actors: options.knowledgePublicationActors ?? unavailablePublicationActors,
      clock,
      ...(options.ids === undefined ? {} : { ids: options.ids }),
    });
    const knowledgeAuditDispatcher = options.knowledgeAuditSink === undefined ? undefined
      : new KnowledgeAuditDispatcher({ outbox: knowledge, sink: options.knowledgeAuditSink, clock });
    const outbox = new SqliteEventOutboxStore(database);
    const eventMessages = new SqliteEventMessageStore(database);
    const evidence = new SqliteEvidenceStore(database, {
      ...(options.limits?.maxEvidenceRawBytes === undefined ? {} : { maxRawBytes: options.limits.maxEvidenceRawBytes }),
    });
    const evidenceManifests = new SqliteEvidenceManifestStore(database);
    const inspectionQueries = new SqliteInspectionQueryService(database, durable, evidenceManifests, eventMessages);
    const diagnosticMemory = new SqliteDiagnosticMemoryStore(database, { clock });
    const memory: SqlitePersistenceBundle['memory'] = {
      queries: diagnosticMemory,
      writes: diagnosticMemory,
      maintenance: diagnosticMemory,
      captureSource: new SqliteMemoryCaptureSource({ database, queries: inspectionQueries }),
    };
    const evidenceBlobs = options.evidenceBlobRootPath === undefined
      ? undefined
      : new LocalEvidenceBlobStore({
        rootPath: options.evidenceBlobRootPath,
        ...(options.clock === undefined ? {} : { clock }),
        ...(options.ids === undefined ? {} : { ids: options.ids }),
      });
    let closed = false;
    return {
      checkpoints: durable,
      executions: durable,
      stateUnitOfWork: durable,
      transitions: durable,
      outbox,
      targetBindings: durable,
      targetStarts: durable,
      targetIdentityRegistry: targetIdentityStore,
      targetKnowledgePolicies: targetIdentityStore,
      knowledge,
      targetKnowledgeBindings,
      ...(knowledgeAuditDispatcher === undefined ? {} : { knowledgeAuditDispatcher }),
      evidence,
      evidenceManifests,
      ...(evidenceBlobs === undefined ? {} : { evidenceBlobs }),
      eventMessages,
      memory,
      webMessages: (cursorCodec) => new SqliteWebMessageQuery(database, cursorCodec),
      queries: inspectionQueries,
      projectionCheckpoints: new SqliteProjectionCheckpointStore(database),
      projectionFailures: new SqliteProjectionFailureSink(database, () => clock.now().toISOString()),
      close: () => {
        if (closed) return;
        closed = true;
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

const unavailableReviewAuthority: KnowledgeReviewAuthorityPort = {
  resolveFor: () => Promise.reject(new KnowledgeContractError('KNOWLEDGE_APPROVAL_DENIED')),
};

const unavailablePublicationActors: KnowledgePublicationActorPort = {
  resolveForTarget: () => Promise.reject(new KnowledgeContractError('KNOWLEDGE_APPROVAL_DENIED')),
};
