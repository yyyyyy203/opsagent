import { AgentHarness } from '../agent/agent-harness.js';
import type { AgentMemoryHarness } from '../agent/types.js';
import type { DiagnosticMemoryRuntime, RuntimeMemoryAssemblyPorts } from '../contracts/diagnostic-memory.js';
import type {
  ChatModel,
  CheckpointStore,
  Clock,
  DurableRunState,
  EventStore,
  EventPublisherV2Dependencies,
  EvidenceStore,
  EvidenceQueryStore,
  EvidenceBlobStore,
  EvidenceManifestStore,
  StreamingEvidenceRecorder,
  Guardian,
  IdGenerator,
  ImpactSurfaceProvider,
  MessageStore,
  Observability,
  ProfileResolver,
  Tool,
  ToolLifecycleObserver,
} from '../contracts/index.js';
import { randomIdGenerator, systemClock } from '../contracts/index.js';
import { RuleBasedContextCompressor } from '../context-compressor/rule-based-compressor.js';
import { ModelHistorySummarizer } from '../context-compressor/history-summarizer.js';
import { DefaultToolResultCompactor } from '../context-compressor/tool-result-compactor.js';
import type { CompressionValidator, ContextCompressor, ToolResultCompactor } from '../context-compressor/types.js';
import type { RuleBasedCompressorOptions } from '../context-compressor/rule-based-compressor.js';
import { EventBus } from '../event/event-bus.js';
import { EventFactory } from '../event/event-factory.js';
import { BashGuardian } from '../guard/bash-guardian.js';
import { GuardEngine } from '../guard/guard-engine.js';
import { BatchGovernanceEvaluator } from '../guard/governance-evaluator.js';
import { GuardianCoordinator } from '../guard/guardian-coordinator.js';
import { ImpactSurfaceGuardian } from '../guard/impact-surface-guardian.js';
import { McpGuardian } from '../guard/mcp-guardian.js';
import { ProfileGuardian } from '../guard/profile-guardian.js';
import { DeterministicRiskPolicy } from '../guard/risk-policy.js';
import { EvidenceBudgetHook } from '../hooks/evidence-budget-hook.js';
import { AuditHook } from '../hooks/audit-hook.js';
import { CheckpointHook } from '../hooks/checkpoint-hook.js';
import { ControlHookExecutor } from '../hooks/control-hook-executor.js';
import { DiagnosisMemoryHook } from '../hooks/diagnosis-memory-hook.js';
import { HookExecutor } from '../hooks/hook-executor.js';
import { HookRegistry } from '../hooks/hook-registry.js';
import { LifecycleObserverExecutor } from '../hooks/lifecycle-observer-executor.js';
import { PolicyDenyHook } from '../hooks/policy-deny-hook.js';
import { RiskActionHook } from '../hooks/risk-action-hook.js';
import type { ToolHook } from '../hooks/types.js';
import { NoopObservability } from '../observability/noop-observability.js';
import { InMemoryCheckpointStore } from '../storage/in-memory-checkpoint-store.js';
import { InMemoryDurableState } from '../storage/in-memory-durable-state.js';
import { InMemoryEvidenceStore } from '../storage/in-memory-evidence-store.js';
import { VersionedCheckpointStoreAdapter } from '../storage/versioned-checkpoint-adapter.js';
import { ToolBatchExecutor } from '../tool/batch-executor.js';
import { createExternalBashTool } from '../tool/builtin/bash-tool.js';
import { ToolExecutionPipeline } from '../tool/execution-pipeline.js';
import { DefaultToolRunner } from '../tool/tool-runner.js';
import { Toolkit } from '../tool/toolkit.js';
import { ToolAdmission } from '../tool/admission.js';
import { ExternalToolResultService } from './external-tool-result-service.js';
import { DefaultEvidenceRecorder, type EvidenceRecorder } from './evidence-recorder.js';
import { HitlService } from './hitl-service.js';
import { EventFactoryV2 } from '../event/v2/event-factory.js';
import { EventPublisherV2, InMemoryProjectionFailureSink } from '../event/v2/event-publisher.js';
import { DurableOutboxDispatcher } from '../event/v2/durable-outbox-dispatcher.js';
import { InMemoryEventMessageStore } from '../event/v2/in-memory-event-store.js';
import { OutboxedEventPublisher } from '../event/v2/outboxed-event-publisher.js';
import { ReplayBufferV2 } from '../event/v2/replay-buffer.js';
import { PublicEventProjectorV2 } from '../event/projectors/public-projector.js';
import { V1CompatibilityProjector } from '../event/projectors/v1-projector.js';
import { AuditProjectorV2 } from '../event/projectors/audit-projector.js';
import { LangSmithEventProjectorV2 } from '../event/projectors/langsmith-projector.js';
import { EventStreamService } from '../api/event-stream-service.js';
import { EventedChatModel } from '../model/evented-model.js';
import { CompactingChatModel } from '../model/compacting-model.js';
import { RetryingChatModel, type RetryingChatModelOptions } from '../model/retrying-model.js';
import { ObservabilityModelAttemptObserver } from '../observability/model-attempt-observer.js';
import { CompositeModelAttemptObserver } from '../model/model-attempt-observer.js';
import { V2ModelAttemptObserver } from '../model/v2-attempt-observer.js';
import { MessageAssemblerV2 } from '../event/v2/message-assembler.js';
import { InMemoryProjectionCheckpointStore, ProjectionRunnerV2 } from '../event/v2/projection-runner.js';
import { createSqlitePersistence } from '../infrastructure/sqlite/persistence-bundle.js';
import { UnavailableImpactSurfaceProvider } from '../profiles/unavailable-impact-surface-provider.js';
import { DefaultStreamingEvidenceRecorder } from './streaming-evidence-recorder.js';
import { InMemoryInspectionQueryService } from '../storage/in-memory-inspection-query.js';
import type { InspectionQueryService } from '../contracts/read-model.js';
import type { MessageCursorCodec, WebMessageQueries } from '../contracts/web-read-model.js';
import { InMemoryWebMessageQuery } from '../storage/in-memory-web-message-query.js';
import type { RuntimeEventPublisher, RuntimeShutdownRegistry, SharedRuntimeEventPorts } from './runtime-ports.js';
import type { TargetRecoveryGate } from '../contracts/target.js';
import { TargetConfigurationError } from '../contracts/target.js';

type EventMessageStore = EventStore & MessageStore;

/** Ports exposed to late-bound Tool factories without importing infrastructure into the Harness. */
export interface RuntimeToolPorts {
  evidenceBlobs?: EvidenceBlobStore;
  evidenceManifests?: EvidenceManifestStore;
  streamingEvidenceRecorder?: StreamingEvidenceRecorder;
  evidence: EvidenceStore;
  evidenceRecorder: EvidenceRecorder;
  sharedEvents: SharedRuntimeEventPorts;
  registerShutdownHook(callback: () => void | Promise<void>): void;
  toolResultCompactor: ToolResultCompactor;
  /** Shared V2 lifecycle ports for late-bound source/subagent Tools. */
  events: EventPublisherV2Dependencies;
  checkpoints: CheckpointStore;
  /** Shared host-owned durable state for child Runs that must atomically inherit Target scope. */
  durableState?: DurableRunState;
  /** Deferred host policy gate shared with Target-bound source child runtimes. */
  targetRecoveryGate: TargetRecoveryGate;
  clock: Clock;
  ids: IdGenerator;
}

export type RuntimeToolFactory = (ports: RuntimeToolPorts) => readonly Tool[];

export interface AgentRuntimeOptions {
  model: ChatModel;
  /** Optional host-provided gate; bootstrap may configure the per-runtime gate after persistence opens. */
  targetRecoveryGate?: TargetRecoveryGate;
  /** Internal source scope for a Target-bound source child runtime. */
  targetSourceScopeId?: string;
  /** Host/test-injected memory ports. Production assembly is owned by bootstrap. */
  memoryHarness?: AgentMemoryHarness;
  /** Production host assembly, called only after the complete durable ports exist. */
  memoryFactory?: (ports: RuntimeMemoryAssemblyPorts) => DiagnosticMemoryRuntime;
  /** Optional independent model used only for structured L2 history summaries. */
  compactModel?: ChatModel;
  workspaceRoots: string[];
  tools?: Tool[];
  /** Canonical parent-level source Tools; their child-only Tools are never registered here. */
  sourceSubagentTools?: readonly Tool[];
  /** Build tools after optional runtime-owned ports exist and before the Toolkit is frozen. */
  toolFactories?: readonly RuntimeToolFactory[];
  guardians?: Guardian[];
  hooks?: ToolHook[];
  lifecycleObservers?: ToolLifecycleObserver[];
  checkpoints?: CheckpointStore;
  /** Inject one host-owned durable state into nested runtimes; the child never owns or closes it. */
  durableState?: DurableRunState;
  /** Current Target identity registry version for the in-memory durable store; Target root starts fail closed without it. */
  inMemoryTargetIdentityRegistryVersion?: () => number;
  evidence?: EvidenceStore;
  evidenceRecorder?: EvidenceRecorder;
  observability?: Observability;
  /** Observability used only by the V2 event projector (for example LangSmith). */
  eventObservability?: Observability;
  clock?: Clock;
  ids?: IdGenerator;
  includeExternalBash?: boolean;
  actionMode?: 'dry_run' | 'execute';
  modelProvider?: string;
  modelName?: string;
  modelRetry?: RetryingChatModelOptions;
  /** Replace the default compression orchestrator in tests or host-specific composition. */
  compressor?: ContextCompressor;
  /** Optional validator injection for the default layered compressor. */
  compressionValidator?: CompressionValidator;
  /** Narrow tuning/port overrides for the default layered compressor. */
  compression?: Partial<RuleBasedCompressorOptions>;
  /** Resolve the immutable Profile snapshot used by governance-enabled Runs. */
  profileResolver?: ProfileResolver;
  /** Capture the live impact surface once per admitted Tool batch. */
  impactSurfaceProvider?: ImpactSurfaceProvider;
  /** Opt into Profile/Impact/Guardian/RiskPolicy evaluation for new Runs. */
  enableGovernance?: boolean;
  /** Use a durable V2 event/message store. Defaults to the in-memory store for tests. */
  eventMessageStore?: EventMessageStore;
  /** Reuse a parent-owned V2 event store and publisher for a child Run. */
  sharedEvents?: SharedRuntimeEventPorts;
  /** SQLite path for the complete Event, Checkpoint, Evidence and execution persistence bundle. */
  sqlitePath?: string;
  /** Explicit absolute Blob root used only when SQLite-backed L0 Blob storage is desired. */
  evidenceBlobRootPath?: string;
  /** Optional L0 data-plane and model-view ports. */
  l0?: {
    blobStore?: EvidenceBlobStore;
    manifests?: EvidenceManifestStore;
    streamingEvidenceRecorder?: StreamingEvidenceRecorder;
    toolResultCompactor?: ToolResultCompactor;
  };
}

export function createAgentRuntime(options: AgentRuntimeOptions) {
  if (options.memoryFactory !== undefined && options.memoryHarness !== undefined) {
    throw new Error('memoryFactory cannot be combined with memoryHarness.');
  }
  if (options.memoryFactory !== undefined && options.sqlitePath === undefined) {
    throw new Error('memoryFactory requires a complete durable persistence bundle.');
  }
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? randomIdGenerator;
  const shutdownCallbacks: Array<() => void | Promise<void>> = [];
  let shutdownStarted = false;
  const shutdownRegistry: RuntimeShutdownRegistry = {
    register: (callback) => {
      if (shutdownStarted) throw new Error('Runtime shutdown has already started.');
      shutdownCallbacks.push(callback);
    },
  };
  const runShutdownHooks = async (): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    for (const callback of shutdownCallbacks.splice(0)) await callback();
  };
  if (options.enableGovernance === true && options.profileResolver === undefined) {
    throw new Error('profileResolver is required when governance is enabled.');
  }
  if (options.sharedEvents !== undefined && options.sqlitePath !== undefined) {
    throw new Error('sharedEvents cannot be combined with sqlitePath');
  }
  if (options.sharedEvents !== undefined
    && options.eventMessageStore !== undefined
    && options.eventMessageStore !== options.sharedEvents.store) {
    throw new Error('eventMessageStore must match sharedEvents.store');
  }
  if (options.sqlitePath !== undefined && (options.checkpoints !== undefined || options.eventMessageStore !== undefined)) {
    throw new Error('sqlitePath cannot be combined with partial persistence injection');
  }
  if (options.durableState !== undefined && (options.sqlitePath !== undefined || options.checkpoints !== undefined)) {
    throw new Error('durableState cannot be combined with sqlitePath or a separate checkpoint store.');
  }
  const persistence = options.sqlitePath === undefined ? undefined : createSqlitePersistence({
    path: options.sqlitePath,
    clock,
    ids,
    ...(options.evidenceBlobRootPath === undefined ? {} : { evidenceBlobRootPath: options.evidenceBlobRootPath }),
  });
  const inMemoryDurable = options.sharedEvents === undefined
    && persistence === undefined && options.checkpoints === undefined
    ? new InMemoryDurableState(clock, undefined, options.inMemoryTargetIdentityRegistryVersion)
    : undefined;
  const durableState: DurableRunState | undefined = options.durableState ?? persistence ?? inMemoryDurable;
  if (options.memoryHarness !== undefined) {
    if (durableState === undefined) {
      throw new Error('memoryHarness requires durable checkpoint and V2 transition persistence.');
    }
    const { modelWindowTokens, reservedOutputTokens } = options.memoryHarness;
    if (!Number.isSafeInteger(modelWindowTokens) || modelWindowTokens <= 0
      || !Number.isSafeInteger(reservedOutputTokens) || reservedOutputTokens <= 0
      || reservedOutputTokens >= modelWindowTokens) {
      throw new Error('memoryHarness token-window configuration is invalid.');
    }
  }
  const checkpoints = options.checkpoints
    ?? (durableState === undefined ? new InMemoryCheckpointStore() : new VersionedCheckpointStoreAdapter(durableState.checkpoints));
  const evidence = options.evidence ?? persistence?.evidence ?? inMemoryDurable?.evidence ?? new InMemoryEvidenceStore();
  const observability = options.observability ?? new NoopObservability();
  const eventObservability = options.eventObservability ?? observability;
  const events = new EventBus();
  const eventFactory = new EventFactory(clock);
  const localEventStoreV2: EventMessageStore = options.eventMessageStore
    ?? persistence?.eventMessages
    ?? new InMemoryEventMessageStore();
  const replayV2 = new ReplayBufferV2({ maxEvents: 2_000, maxBytes: 4_000_000 });
  const projectionFailuresV2 = persistence?.projectionFailures ?? new InMemoryProjectionFailureSink();
  const localEventPublisherV2 = options.sharedEvents === undefined
    ? new EventPublisherV2(localEventStoreV2, replayV2, projectionFailuresV2)
    : undefined;
  const eventStoreV2: EventMessageStore = options.sharedEvents?.store ?? localEventStoreV2;
  const eventPublisherV2: RuntimeEventPublisher = options.sharedEvents?.source ?? localEventPublisherV2 ?? {
    publish: (event) => options.sharedEvents!.events.publisher.publish(event),
    subscribe: () => () => undefined,
    replayRun: async (runId, afterSequence = 0, limit = 1_000) => (
      (await eventStoreV2.readRun(runId, afterSequence, limit)).length
    ),
  };
  const eventFactoryV2 = options.sharedEvents?.events.factory ?? new EventFactoryV2(clock, ids);
  const durableOutboxDispatcher = options.sharedEvents !== undefined || durableState === undefined
    ? undefined
    : new DurableOutboxDispatcher({ outbox: durableState.outbox, publisher: localEventPublisherV2!, clock });
  const localPublishingV2 = durableOutboxDispatcher === undefined
    ? localEventPublisherV2
    : new OutboxedEventPublisher({
      outbox: durableState!.outbox,
      dispatcher: durableOutboxDispatcher,
      publisher: localEventPublisherV2!,
      eventStore: localEventStoreV2,
      clock,
    });
  const publishingV2 = options.sharedEvents?.events.publisher ?? localPublishingV2!;
  const v2EventDependencies: EventPublisherV2Dependencies = options.sharedEvents?.events ?? {
    factory: eventFactoryV2,
    publisher: publishingV2,
    correlationId: (runId: string) => `run:${runId}`,
    ...(durableOutboxDispatcher === undefined ? {} : { dispatcher: durableOutboxDispatcher }),
  };
  const v1ProjectorV2 = new V1CompatibilityProjector();
  if (options.sharedEvents === undefined) {
    localEventPublisherV2!.subscribe({
      name: 'v1-event-bus',
      project: (event) => Promise.all(v1ProjectorV2.project(event).map((legacy) => events.publish(legacy))).then(() => undefined),
    });
  }
  const projectionCheckpointsV2 = persistence?.projectionCheckpoints ?? new InMemoryProjectionCheckpointStore();
  const auditProjectorV2 = new AuditProjectorV2();
  const auditProjectionRunnerV2 = new ProjectionRunnerV2(auditProjectorV2, projectionCheckpointsV2, projectionFailuresV2, { maxAttempts: 2 });
  const langSmithProjectorV2 = new LangSmithEventProjectorV2(eventObservability);
  const flushEventObservability = async (): Promise<void> => {
    if (options.sharedEvents === undefined) await langSmithProjectorV2.flush();
  };
  const langSmithProjectionRunnerV2 = new ProjectionRunnerV2(langSmithProjectorV2, projectionCheckpointsV2, projectionFailuresV2, { maxAttempts: 2 });
  const messageAssemblerV2 = new MessageAssemblerV2(eventStoreV2);
  if (options.sharedEvents === undefined) {
    localEventPublisherV2!.subscribe(auditProjectionRunnerV2);
    localEventPublisherV2!.subscribe(langSmithProjectionRunnerV2);
    localEventPublisherV2!.subscribe({ name: 'message-assembler', project: (event) => messageAssemblerV2.apply(event).then(() => undefined) });
  }
  const publicProjectorV2 = new PublicEventProjectorV2();
  // Startup recovery is local-only by default. External LangSmith backfill stays explicit.
  const initializeEvents = (): Promise<number> => options.sharedEvents === undefined
    ? Promise.resolve().then(async () => {
      await durableOutboxDispatcher?.drainAll();
      // The V1 bridge is live-delivery only and has no durable projection
      // cursor. Replaying it after draining the Outbox would duplicate events.
      return localEventPublisherV2!.replayAll({ projectorNames: ['audit', 'message-assembler'] });
    })
    : Promise.resolve(0);
  const evidenceBlobs = options.l0?.blobStore ?? persistence?.evidenceBlobs;
  const evidenceManifests = options.l0?.manifests ?? persistence?.evidenceManifests;
  const evidenceQuery = isEvidenceQueryStore(evidence) ? evidence : undefined;
  const queries: InspectionQueryService | undefined = persistence?.queries
    ?? (evidenceQuery === undefined
      ? undefined
      : new InMemoryInspectionQueryService(eventStoreV2, checkpoints, evidenceQuery, evidenceManifests));
  let memory: DiagnosticMemoryRuntime | undefined;
  const cleanupInitialization = (): void => {
    void runShutdownHooks().finally(() => memory?.close()).finally(() => persistence?.close()).catch(() => undefined);
  };
  try {
    if (options.memoryFactory !== undefined) {
      if (persistence === undefined || queries === undefined || durableOutboxDispatcher === undefined) {
        throw new Error('memoryFactory requires owned durable persistence and event dispatch.');
      }
      memory = options.memoryFactory({
        queries: persistence.memory.queries,
        writes: persistence.memory.writes,
        captureSource: persistence.memory.captureSource,
        evidenceQueries: queries,
        evidenceManifests: { getVisible: id => persistence.evidenceManifests.getVisible(id) },
        checkpoints: persistence.checkpoints,
        clock, ids,
        events: { create: (type, runId, payload) => eventFactoryV2.create(type, {
          runId, correlationId: `run:${runId}`, visibility: 'audit', durability: 'durable',
        }, payload) },
        dispatch: async () => { await durableOutboxDispatcher.drainAll(); },
      });
      if (!Number.isSafeInteger(memory.modelWindowTokens) || memory.modelWindowTokens <= 0
        || !Number.isSafeInteger(memory.reservedOutputTokens) || memory.reservedOutputTokens <= 0
        || memory.reservedOutputTokens >= memory.modelWindowTokens) {
        throw new Error('memoryFactory token-window configuration is invalid.');
      }
    }
  } catch (error) {
    cleanupInitialization();
    throw error;
  }
  const toolResultCompactor = options.l0?.toolResultCompactor ?? new DefaultToolResultCompactor();
  const l0DataPlaneRequested = options.evidenceBlobRootPath !== undefined
    || options.l0?.blobStore !== undefined
    || options.l0?.manifests !== undefined;
  if (l0DataPlaneRequested && options.l0?.streamingEvidenceRecorder === undefined
    && (evidenceBlobs === undefined || evidenceManifests === undefined)) {
    cleanupInitialization();
    throw new Error('L0 Blob storage requires both blobStore and manifests ports.');
  }
  const streamingEvidenceRecorder = options.l0?.streamingEvidenceRecorder
    ?? (evidenceBlobs === undefined || evidenceManifests === undefined
      ? undefined
      : new DefaultStreamingEvidenceRecorder({
        blobStore: evidenceBlobs,
        manifests: evidenceManifests,
        clock,
        ids,
        events: { factory: eventFactoryV2, publisher: publishingV2, store: eventStoreV2, correlationId: (runId) => `run:${runId}` },
      }));
  const evidenceRecorder = options.evidenceRecorder ?? new DefaultEvidenceRecorder({
    evidence,
    events: { ...v2EventDependencies, store: eventStoreV2 },
  });
  const sharedEvents: SharedRuntimeEventPorts = options.sharedEvents ?? {
    store: eventStoreV2,
    events: v2EventDependencies,
    source: eventPublisherV2,
    replay: replayV2,
    ...(durableState === undefined ? {} : { durableState }),
  };
  let configuredTargetRecoveryGate = options.targetRecoveryGate;
  const targetRecoveryGate: TargetRecoveryGate = {
    acquireForStart: input => {
      if (configuredTargetRecoveryGate === undefined) throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
      return configuredTargetRecoveryGate.acquireForStart(input);
    },
    authorizeResume: input => {
      if (configuredTargetRecoveryGate === undefined) throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
      return configuredTargetRecoveryGate.authorizeResume(input);
    },
    acquireForResume: input => {
      if (configuredTargetRecoveryGate === undefined) throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
      return configuredTargetRecoveryGate.acquireForResume(input);
    },
  };
  let factoryTools: Tool[] = [];
  try {
    factoryTools = (options.toolFactories ?? []).flatMap((factory) => [...factory({
      ...(evidenceBlobs === undefined ? {} : { evidenceBlobs }),
      ...(evidenceManifests === undefined ? {} : { evidenceManifests }),
      ...(streamingEvidenceRecorder === undefined ? {} : { streamingEvidenceRecorder }),
      evidence,
      evidenceRecorder,
      sharedEvents,
      registerShutdownHook: (callback) => shutdownRegistry.register(callback),
      toolResultCompactor,
      events: v2EventDependencies,
      checkpoints,
      ...(durableState === undefined ? {} : { durableState }),
      targetRecoveryGate,
      clock,
      ids,
    })]);
  } catch (error) {
    cleanupInitialization();
    throw error;
  }
  const decorateModel = (baseModel: ChatModel, identity?: { provider: string; model: string }): ChatModel => {
    const provider = identity?.provider ?? options.modelProvider ?? 'configured';
    const modelName = identity?.model ?? options.modelName ?? 'configured';
    const retryingModel = options.modelRetry === undefined
      ? baseModel
      : new RetryingChatModel(baseModel, {
        ...options.modelRetry,
        onFallback: async (info) => {
          await options.modelRetry?.onFallback?.(info);
          if (options.modelRetry?.fallback !== undefined) {
            await publishingV2.publish(eventFactoryV2.create('MODEL_FALLBACK_ACTIVATED', {
              runId: info.runId,
              correlationId: `run:${info.runId}`,
              visibility: 'audit',
              durability: 'durable',
              stepId: info.stepId,
            }, {
              fromProvider: provider,
              fromModel: modelName,
              toProvider: options.modelRetry.fallbackProvider ?? 'fallback',
              toModel: options.modelRetry.fallbackModel ?? 'fallback',
              reasonCode: info.reason.details.category as string,
            })).then(() => undefined);
          }
        },
        observer: options.modelRetry.observer ?? new CompositeModelAttemptObserver([
          new ObservabilityModelAttemptObserver(observability),
          new V2ModelAttemptObserver({ factory: eventFactoryV2, publisher: publishingV2, provider, model: modelName, correlationId: (runId) => `run:${runId}`, ids, now: () => clock.now().getTime() }),
        ]),
      });
    return new EventedChatModel(new CompactingChatModel(retryingModel, toolResultCompactor), publishingV2, eventFactoryV2, {
      provider,
      model: modelName,
      purpose: 'inspection',
      correlationId: (runId) => `run:${runId}`,
      clock,
      ids,
    });
  };
  const model = decorateModel(options.model);
  const toolkit = new Toolkit();
  if (options.includeExternalBash !== false) toolkit.register(createExternalBashTool());
  for (const tool of options.tools ?? []) toolkit.register(tool);
  for (const tool of factoryTools) toolkit.register(tool);
  for (const tool of options.sourceSubagentTools ?? []) toolkit.register(tool);
  const guard = new GuardEngine([
    new BashGuardian(options.workspaceRoots),
    ...(options.guardians ?? []),
  ]);
  const governanceEvaluator = options.enableGovernance === true
    ? new BatchGovernanceEvaluator({
      resolveTool: (name) => toolkit.get(name),
      impactSurfaceProvider: options.impactSurfaceProvider ?? new UnavailableImpactSurfaceProvider(),
      guardianCoordinator: new GuardianCoordinator([
        new BashGuardian(options.workspaceRoots),
        new McpGuardian(),
        new ProfileGuardian(clock),
        new ImpactSurfaceGuardian(),
        ...(options.guardians ?? []),
      ], { clock }),
      riskPolicy: new DeterministicRiskPolicy(),
      clock,
    })
    : undefined;
  const hooks = new HookExecutor(options.hooks ?? []);
  const controlHooks = new ControlHookExecutor([
    new EvidenceBudgetHook(clock),
    new PolicyDenyHook(),
    new RiskActionHook(clock),
  ]);
  const lifecycleObservers = new LifecycleObserverExecutor([
    new AuditHook(),
    new CheckpointHook(),
    new DiagnosisMemoryHook(),
    ...(options.lifecycleObservers ?? []),
  ]);
  const hookRegistry = new HookRegistry([...new Set([
    'risk-action',
    'external-tool-execution',
    ...(options.hooks ?? []).map((hook) => hook.id),
  ])]);
  const pipeline = new ToolExecutionPipeline(
    toolkit,
    guard,
    hooks,
    new DefaultToolRunner(),
    checkpoints,
    events,
    eventFactory,
    observability,
    clock,
    {
      actionMode: options.actionMode ?? 'dry_run',
      deferV2ResultPublication: durableState !== undefined,
    },
    { factory: eventFactoryV2, publisher: publishingV2, correlationId: (runId) => `run:${runId}` },
    durableState?.executions,
    governanceEvaluator,
    controlHooks,
    lifecycleObservers,
  );
  const batchExecutor = new ToolBatchExecutor(toolkit, pipeline, clock);
  const historySummarizer = options.compactModel === undefined
    ? undefined
    : new ModelHistorySummarizer({ model: options.compactModel, clock });
  const compression = options.compression ?? {};
  const configuredSummarizer = compression.summarizer ?? historySummarizer;
  const configuredValidator = compression.validator ?? options.compressionValidator;
  const configuredEvidenceManifests = compression.evidenceManifests ?? evidenceManifests;
  const defaultCompressorOptions: RuleBasedCompressorOptions = {
    maxMessagesBeforeL1: compression.maxMessagesBeforeL1 ?? 40,
    maxSerializedBytesBeforeL2: compression.maxSerializedBytesBeforeL2 ?? 256_000,
    keepRecentMessages: compression.keepRecentMessages ?? 16,
    toolResultCompactor: compression.toolResultCompactor ?? toolResultCompactor,
    evidence: compression.evidence ?? evidence,
    ...(compression.now === undefined ? { now: () => clock.now() } : { now: compression.now }),
    ...(configuredSummarizer === undefined ? {} : { summarizer: configuredSummarizer }),
    ...(configuredValidator === undefined ? {} : { validator: configuredValidator }),
    ...(configuredEvidenceManifests === undefined ? {} : { evidenceManifests: configuredEvidenceManifests }),
  };
  const defaultCompressor = new RuleBasedContextCompressor(defaultCompressorOptions);
  const agent = new AgentHarness({
    model,
    toolkit,
    batchExecutor,
    checkpoints,
    compressor: options.compressor ?? defaultCompressor,
    events,
    eventFactory,
    observability,
    clock,
    ids,
    admission: new ToolAdmission(toolkit),
    eventStore: eventStoreV2,
    ...(options.enableGovernance === true && options.profileResolver !== undefined
      ? { profileResolver: options.profileResolver }
      : {}),
    ...((memory ?? options.memoryHarness) === undefined ? {} : { memory: memory ?? options.memoryHarness! }),
    ...(durableState === undefined ? {} : { durableState }),
    targetRecoveryGate,
    targetModelDecorator: decorateModel,
    ...(options.targetSourceScopeId === undefined ? {} : { targetSourceScopeId: options.targetSourceScopeId }),
    hookRegistry,
    v2Events: v2EventDependencies,
  });
  // No recovery/worker task can race failed synchronous host assembly and database release.
  const ready = initializeEvents().then(async count => {
    await memory?.worker.drain({ limit: 50 });
    return count;
  });
  return {
    agent,
    configureTargetRecoveryGate(gate: TargetRecoveryGate): void {
      if (configuredTargetRecoveryGate !== undefined && configuredTargetRecoveryGate !== gate) {
        throw new Error('Target Recovery Gate is already configured for this runtime.');
      }
      configuredTargetRecoveryGate = gate;
    },
    toolkit,
    events,
    checkpoints,
    durableState,
    ...(persistence === undefined ? {} : { knowledgeManagementStores: {
      revisions: persistence.knowledge,
      publications: persistence.targetKnowledgeBindings,
    } }),
    evidence,
    evidenceBlobs,
    evidenceManifests,
    queries,
    memory,
    streamingEvidenceRecorder,
    toolResultCompactor,
    evidenceRecorder,
    sharedEvents,
    hitl: new HitlService(
      checkpoints,
      clock,
      v2EventDependencies,
      durableState,
      hookRegistry,
      toolkit,
      targetRecoveryGate,
      options.targetSourceScopeId,
    ),
    externalTools: new ExternalToolResultService(
      checkpoints,
      clock,
      toolkit,
      guard,
      hooks,
      events,
      eventFactory,
      v2EventDependencies,
      durableState,
      hookRegistry,
      targetRecoveryGate,
      options.targetSourceScopeId,
    ),
    eventStoreV2,
    replayV2,
    eventPublisherV2,
    auditProjectorV2,
    projectionFailuresV2,
    projectionCheckpointsV2,
    hookRegistry,
    auditProjectionRunnerV2,
    langSmithProjectionRunnerV2,
    flushEventObservability,
    ready,
    messageAssemblerV2,
    webMessages: (cursorCodec: MessageCursorCodec): WebMessageQueries => (
      persistence?.webMessages(cursorCodec) ?? new InMemoryWebMessageQuery(cursorCodec)
    ),
    replayRun: (runId: string, afterSequence?: number, limit?: number) => eventPublisherV2.replayRun(runId, afterSequence, limit),
    eventStreamV2: new EventStreamService({
      store: eventStoreV2,
      replay: options.sharedEvents?.replay ?? replayV2,
      messages: eventStoreV2,
      source: eventPublisherV2,
      projector: publicProjectorV2,
    }),
    close: async (): Promise<void> => {
      try {
        await ready;
      } finally {
        try {
          await runShutdownHooks();
        } finally {
          try {
            await memory?.close();
          } finally {
            try {
              await flushEventObservability();
            } finally {
              persistence?.close();
            }
          }
        }
      }
    },
  };
}

function isEvidenceQueryStore(value: EvidenceStore): value is EvidenceStore & EvidenceQueryStore {
  return typeof (value as Partial<EvidenceQueryStore>).listByRun === 'function';
}
