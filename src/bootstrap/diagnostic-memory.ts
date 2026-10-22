import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { DiagnosticMemoryConfig, DiagnosticMemoryRuntime, MemoryEvidenceValidator,
  MemoryCaptureWorkerPort, RuntimeMemoryAssemblyPorts } from '../contracts/diagnostic-memory.js';
import { MemoryCaptureService } from '../memory/capture-service.js';
import { MemoryCaptureWorker } from '../memory/capture-worker.js';
import { MemoryReviewService } from '../memory/review-service.js';
import { BoundedMemoryRecall } from '../memory/bounded-recall.js';
import { BoundedMemoryHintRenderer } from '../memory/hint-renderer.js';
import { MemoryError } from '../memory/memory-error.js';
import { sameMemoryScope } from '../memory/memory-scope.js';
import { HostMemoryPolicy, parseDiagnosticMemoryConfig } from './memory-policy.js';
import { MemoryQueryService } from '../application/memory-query-service.js';
import { KnowledgeManagementService, type KnowledgeManagementTargetContextPort } from '../application/knowledge-management-service.js';
import { TargetKnowledgePublicationService, type TargetKnowledgePublicationServiceOptions } from '../application/target-knowledge-publication-service.js';
import { SemanticKnowledgeService, type SemanticReviewAttestationPort } from '../memory/semantic-knowledge-service.js';
import { ProceduralTemplateService, type ProceduralReviewAttestationPort, type ProceduralReadonlyCapabilityRegistryPort,
  type ProceduralSourceRegistryPort, type ProceduralTargetContextPort } from '../memory/procedural-template-service.js';
import type { SemanticSourceRegistry } from '../memory/semantic-source-registry.js';
import type { Clock, IdGenerator } from '../contracts/common.js';
import type { TargetKnowledgeCapabilityPort, TargetKnowledgePolicyStore } from '../contracts/target.js';
import type { TargetKnowledgePublicationContextPort, TargetKnowledgePublicationStorage,
  TargetKnowledgeRevisionStorage } from '../contracts/knowledge-memory-storage.js';
import type { MemoryCoordinatorPort, EpisodicMemoryCoordinatorPorts } from '../contracts/diagnostic-memory.js';

export interface TargetKnowledgeManagementHostOptions {
  readonly targets: KnowledgeManagementTargetContextPort & ProceduralTargetContextPort;
  readonly semanticSources: SemanticSourceRegistry;
  readonly proceduralSources: ProceduralSourceRegistryPort;
  readonly proceduralCapabilities: ProceduralReadonlyCapabilityRegistryPort;
  readonly semanticReviewAttestations: SemanticReviewAttestationPort;
  readonly proceduralReviewAttestations: ProceduralReviewAttestationPort;
  readonly publicationContexts: TargetKnowledgePublicationContextPort;
}

export interface TargetKnowledgeManagementAssemblyOptions extends TargetKnowledgeManagementHostOptions {
  readonly revisions: TargetKnowledgeRevisionStorage;
  readonly publications: TargetKnowledgePublicationStorage;
  readonly policies: TargetKnowledgePolicyStore;
  readonly capabilities: TargetKnowledgeCapabilityPort;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

/** Compatibility helper for hosts that only need explicit governed publication. */
export function createTargetKnowledgePublicationService(options: TargetKnowledgePublicationServiceOptions) {
  return new TargetKnowledgePublicationService(options);
}

/** Formal Target host composition. The durable replay receipt is mandatory for Procedural governance commands. */
export function createTargetKnowledgeManagementService(options: TargetKnowledgeManagementAssemblyOptions) {
  const semantic = new SemanticKnowledgeService({ sourceRegistry: options.semanticSources,
    targets: options.targets, drafts: options.revisions, sources: options.revisions, queries: options.revisions,
    reviews: options.revisions, reviewAttestations: options.semanticReviewAttestations,
    ...(options.clock === undefined ? {} : { clock: options.clock }), ...(options.ids === undefined ? {} : { ids: options.ids }) });
  const procedural = new ProceduralTemplateService({ sourceRegistry: options.proceduralSources,
    capabilityRegistry: options.proceduralCapabilities, targets: options.targets, drafts: options.revisions,
    sources: options.revisions, queries: options.revisions, reviews: options.revisions,
    // Do not remove: this is the formal target-host receipt-first replay boundary.
    replay: options.revisions, transitions: options.revisions, reviewAttestations: options.proceduralReviewAttestations,
    ...(options.clock === undefined ? {} : { clock: options.clock }), ...(options.ids === undefined ? {} : { ids: options.ids }) });
  const publicationService = new TargetKnowledgePublicationService({ contexts: options.publicationContexts,
    queries: options.revisions, publications: options.publications,
    ...(options.clock === undefined ? {} : { clock: options.clock }) });
  return new KnowledgeManagementService({ targets: options.targets, revisions: options.revisions,
    publications: options.publications, policies: options.policies, capabilities: options.capabilities,
    semantic, procedural, publicationService, ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.ids === undefined ? {} : { ids: options.ids }) });
}

/** One-time deployment opt-in. File size and trust shape are checked before assembly. */
export async function readDiagnosticMemoryConfig(env: Readonly<Record<string, string | undefined>>): Promise<DiagnosticMemoryConfig> {
  if (env.AGENTOPS_MEMORY_ENABLED === undefined || env.AGENTOPS_MEMORY_ENABLED === '0') return { enabled: false };
  if (env.AGENTOPS_MEMORY_ENABLED !== '1' || env.AGENTOPS_MEMORY_CONFIG === undefined
    || !isAbsolute(env.AGENTOPS_MEMORY_CONFIG)) throw new MemoryError('MEMORY_DATA_INVALID');
  const file = await open(env.AGENTOPS_MEMORY_CONFIG, 'r');
  try {
    const bytes = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 64 * 1024) throw new MemoryError('MEMORY_DATA_INVALID');
    let config: DiagnosticMemoryConfig;
    try { config = parseDiagnosticMemoryConfig(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) as unknown); }
    catch { throw new MemoryError('MEMORY_DATA_INVALID'); }
    if (!config.enabled) throw new MemoryError('MEMORY_DISABLED');
    return config;
  } finally { await file.close(); }
}

export function createDiagnosticMemoryRuntime(input: { config: DiagnosticMemoryConfig;
  ports: RuntimeMemoryAssemblyPorts;
  createCoordinator?: (input: { ports: RuntimeMemoryAssemblyPorts;
    episodic: EpisodicMemoryCoordinatorPorts }) => MemoryCoordinatorPort }): DiagnosticMemoryRuntime | undefined {
  const config = parseDiagnosticMemoryConfig(input.config);
  if (!config.enabled) return undefined;
  const ports = input.ports;
  let closing = false;
  const policy = new HostMemoryPolicy(() => closing ? { enabled: false } : config);
  const evidence: MemoryEvidenceValidator = { validate: async (request, operation) => {
    const check = (): void => {
      operation.signal?.throwIfAborted();
      if (ports.clock.now().getTime() >= operation.deadlineMs) throw new DOMException('Memory validation timed out.', 'TimeoutError');
    };
    check();
    if (request.refs.length === 0 || request.refs.length > 20
      || !config.profiles.some(p => sameMemoryScope(p.scope, request.scope))) return false;
    const source = await ports.captureSource.inspect(request.sourceRunId, operation);
    check();
    if (source === null || !source.isParent || source.context.memoryControl === undefined
      || source.context.profileId !== request.scope.profileId
      || !sameMemoryScope(source.context.memoryControl.scope, request.scope)) return false;
    const seen = new Set<string>();
    for (const ref of request.refs) {
      if (seen.has(ref.evidenceId) || !source.context.evidenceIds.includes(ref.evidenceId)) return false;
      seen.add(ref.evidenceId);
      const metadata = await ports.evidenceQueries.getEvidence(request.sourceRunId, ref.evidenceId);
      check();
      if (metadata === null || metadata.evidenceId !== ref.evidenceId || metadata.runId !== ref.ownerRunId
        || metadata.source !== ref.source || metadata.rawSha256 !== ref.rawSha256
        || metadata.capturedAt !== ref.capturedAt || metadata.state === 'partial') return false;
      if (metadata.state === 'committed') {
        const manifest = await ports.evidenceManifests.getVisible(ref.evidenceId);
        check();
        if (manifest === null || manifest.state !== 'committed' || manifest.runId !== ref.ownerRunId
          || manifest.evidenceId !== ref.evidenceId || manifest.source !== ref.source
          || manifest.rawSha256 !== ref.rawSha256
          || (manifest.retentionUntil !== undefined && (!Number.isFinite(Date.parse(manifest.retentionUntil))
            || Date.parse(manifest.retentionUntil) <= ports.clock.now().getTime()))) return false;
      }
    }
    return true;
  } };
  const capture = new MemoryCaptureService({ source: ports.captureSource, queries: ports.queries,
    writes: ports.writes, policy, ids: ports.ids, requiredSources: config.requiredSources,
    events: ports.events, dispatch: ports.dispatch });
  const reviews = new MemoryReviewService({ queries: ports.queries, writes: ports.writes,
    evidence, events: ports.events, dispatch: ports.dispatch });
  const rawWorker = new MemoryCaptureWorker({ source: ports.captureSource, writes: ports.writes,
    clock: ports.clock, ownerId: ports.ids.next('memory-worker'), events: ports.events, dispatch: ports.dispatch });
  let drainTail: Promise<unknown> = Promise.resolve();
  // Every explicit request schedules one bounded batch; serialization is not a polling loop.
  const worker: MemoryCaptureWorkerPort = {
    drain: request => {
      if (closing) return Promise.reject(new MemoryError('MEMORY_DISABLED'));
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 50) return Promise.reject(new MemoryError('MEMORY_DATA_INVALID'));
      const result = drainTail.then(() => rawWorker.drain(request));
      drainTail = result.catch(() => undefined);
      return result;
    },
    close: async () => { closing = true; await drainTail; await rawWorker.close(); },
  };
  const recall = new BoundedMemoryRecall({ queries: ports.queries, evidence });
  const episodic = { policy, recall, renderer: new BoundedMemoryHintRenderer() } satisfies EpisodicMemoryCoordinatorPorts;
  const coordinator = input.createCoordinator?.({ ports, episodic });
  const queries = new MemoryQueryService({ profiles: config.profiles, policy, queries: ports.queries,
    checkpoints: ports.checkpoints, evidenceQueries: ports.evidenceQueries, recall, clock: ports.clock, enabled: () => !closing });
  return { profiles: config.profiles, policy, requiredSources: config.requiredSources,
    modelWindowTokens: config.modelWindowTokens, reservedOutputTokens: config.reservedOutputTokens,
    recall, renderer: episodic.renderer, ...(coordinator === undefined ? {} : { coordinator }), worker,
    capture: { capture: (command, operation) => closing ? Promise.reject(new MemoryError('MEMORY_DISABLED')) : capture.capture(command, operation) },
    reviews: { review: (command, operation) => closing ? Promise.reject(new MemoryError('MEMORY_DISABLED')) : reviews.review(command, operation) },
    queries, close: () => worker.close() };
}
