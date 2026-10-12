import { checkpointChecksum, type ProfileResolver, type ResolvedProfileSnapshot } from '../contracts/index.js';
import {
  TargetConfigurationError,
  type TargetCatalogDefinition,
  type TargetCatalogDto,
  type TargetCatalogRejection,
  type TargetIdentityCandidate,
  type TargetIdentityRegistry,
  type TargetKnowledgePolicy,
  type TargetKnowledgePolicyStore,
  type TargetSourceIdentity,
  type TargetResolver,
  type TargetScenarioBinding,
  type TargetSourceBinding,
  type TargetSourceKind,
  type ResolvedTargetSnapshotV2,
} from '../contracts/target.js';
import type { MemoryScope } from '../contracts/diagnostic-memory.js';
import { parseTargetCatalog } from './target-catalog-schema.js';

export interface TargetScenarioVersion {
  id: string;
  version: string;
  implementationDigest: string;
}

export interface TargetSourceAdapter {
  id: string;
  kind: TargetSourceKind;
}

interface PrivateConnectionDefinition {
  sourceId: string;
  version: string;
  kind: TargetSourceKind;
  adapterId: string;
  enabled: boolean;
  endpoint?: string;
  secretRef?: string;
  allowedServiceIds: string[];
  dataDomainId: string;
  sourceGeneration: number;
  permissionScopeDigest: string;
}

interface TargetResolverEntry {
  definition: TargetCatalogDefinition;
  profile: ResolvedProfileSnapshot;
  unavailableOptionalSourceIds: readonly string[];
  sourceIdentities: readonly TargetSourceIdentity[];
}

export interface CreateStaticTargetResolverOptions {
  catalog: unknown;
  /** Private host configuration. It is never returned from this module. */
  connections: unknown;
  profileResolver: ProfileResolver;
  installedScenarios: readonly TargetScenarioVersion[];
  installedAdapters: readonly TargetSourceAdapter[];
  identityRegistry: TargetIdentityRegistry;
  knowledgePolicies: TargetKnowledgePolicyStore;
  validationTime: string;
  maxRegisteredTargets?: number;
}

const DEFAULT_MAX_REGISTERED_TARGETS = 200;

/**
 * Loads a bounded Target catalog from host-owned data. Bad Target entries are
 * isolated; ambiguous identity collisions are quarantined rather than picked.
 */
export async function createStaticTargetResolver(
  options: CreateStaticTargetResolverOptions,
): Promise<StaticTargetResolver> {
  if (!isTimestamp(options.validationTime)) throw new TargetConfigurationError('TARGET_CATALOG_INVALID');
  const parsed = parseTargetCatalog(options.catalog, {
    maxRegisteredTargets: options.maxRegisteredTargets ?? DEFAULT_MAX_REGISTERED_TARGETS,
  });
  const privateConnections = parsePrivateConnections(options.connections);
  const scenarioRegistry = buildScenarioRegistry(options.installedScenarios);
  const adapterRegistry = buildAdapterRegistry(options.installedAdapters);
  const rejected: TargetCatalogRejection[] = [...parsed.rejected];
  const candidates: TargetCatalogDefinition[] = [];
  const profiles = new Map<string, ResolvedProfileSnapshot>();
  const unavailableOptionals = new Map<string, readonly string[]>();

  const sourceIdentities = new Map<string, readonly TargetSourceIdentity[]>();
  const identityCandidates: TargetIdentityCandidate[] = [];

  for (let acceptedIndex = 0; acceptedIndex < parsed.targets.length; acceptedIndex += 1) {
    const definition = parsed.targets[acceptedIndex];
    if (definition === undefined) continue;
    const index = parsed.targetIndices[acceptedIndex] ?? acceptedIndex;
    const installedDigest = scenarioRegistry.get(scenarioKey(definition.scenario));
    if (installedDigest === undefined) {
      rejected.push(rejection(index, definition.targetId, 'SCENARIO_VERSION_UNSUPPORTED'));
      continue;
    }
    if (installedDigest !== definition.scenario.implementationDigest) {
      rejected.push(rejection(index, definition.targetId, 'SCENARIO_DIGEST_MISMATCH'));
      continue;
    }
    const sourceValidation = validateSources(definition, privateConnections, adapterRegistry);
    if (sourceValidation === undefined) {
      rejected.push(rejection(index, definition.targetId, 'SOURCE_MAPPING_INVALID'));
      continue;
    }
    try {
      const profile = await options.profileResolver.resolve({
        profileId: definition.profileId,
        capturedAt: options.validationTime,
        signal: new AbortController().signal,
      });
      if (profile.profileId !== definition.profileId || profile.revision !== definition.profileRevision) {
        rejected.push(rejection(index, definition.targetId, 'TARGET_BINDING_INVALID'));
        continue;
      }
      candidates.push(definition);
      profiles.set(definition.targetId, cloneProfile(profile));
      unavailableOptionals.set(definition.targetId, sourceValidation.unavailableOptionalSourceIds);
      sourceIdentities.set(definition.targetId, sourceValidation.sourceIdentities);
      identityCandidates.push({
        targetId: definition.targetId,
        projectId: definition.projectId,
        deploymentId: definition.deploymentId,
        deploymentGeneration: definition.deploymentGeneration,
        scenarioId: definition.scenario.id,
        primaryServiceId: definition.scenario.serviceId,
        profileId: definition.profileId,
        targetFingerprint: definition.targetFingerprint,
        dataClass: definition.dataClass,
        ...(definition.datasetId === undefined ? {} : { datasetId: definition.datasetId }),
        sourceIdentities: sourceValidation.sourceIdentities,
      });
    } catch {
      rejected.push(rejection(index, definition.targetId, 'TARGET_BINDING_INVALID'));
    }
  }

  const identitySnapshot = await options.identityRegistry.readSnapshot();
  const publication = await options.identityRegistry.publishCatalog({
    expectedVersion: identitySnapshot.version,
    presentTargetIds: parsed.presentTargetIds,
    candidates: identityCandidates,
    publishedAt: options.validationTime,
  });
  const candidateIndices = new Map(parsed.targets.map((definition, acceptedIndex) => [
    definition.targetId, parsed.targetIndices[acceptedIndex] ?? acceptedIndex,
  ]));
  for (const conflict of publication.rejected) {
    const index = candidateIndices.get(conflict.targetId);
    if (index !== undefined) rejected.push(rejection(index, conflict.targetId, conflict.reasonCode));
  }
  const acceptedIds = new Set(publication.acceptedTargetIds);
  const acceptedCandidates = candidates.filter(definition => acceptedIds.has(definition.targetId));

  return new StaticTargetResolver(acceptedCandidates, profiles, unavailableOptionals, sourceIdentities, rejected,
    options.profileResolver, scenarioRegistry, privateConnections, adapterRegistry, options.knowledgePolicies);
}

export class StaticTargetResolver implements TargetResolver {
  private readonly entries = new Map<string, TargetResolverEntry>();
  public readonly rejected: readonly TargetCatalogRejection[];

  /** @internal Prefer createStaticTargetResolver so every entry is cross-validated. */
  public constructor(
    definitions: readonly TargetCatalogDefinition[],
    profiles: ReadonlyMap<string, ResolvedProfileSnapshot>,
    unavailableOptionalSourceIds: ReadonlyMap<string, readonly string[]>,
    sourceIdentities: ReadonlyMap<string, readonly TargetSourceIdentity[]>,
    rejected: readonly TargetCatalogRejection[],
    private readonly profileResolver: ProfileResolver,
    private readonly scenarios: ReadonlyMap<string, string>,
    private readonly connections: ReadonlyMap<string, PrivateConnectionDefinition>,
    private readonly adapters: ReadonlyMap<string, TargetSourceKind>,
    private readonly knowledgePolicies: TargetKnowledgePolicyStore,
  ) {
    for (const definition of definitions) {
      const profile = profiles.get(definition.targetId);
      if (profile === undefined) throw new TargetConfigurationError('TARGET_BINDING_INVALID');
      this.entries.set(definition.targetId, {
        definition: cloneTarget(definition),
        profile,
        unavailableOptionalSourceIds: [...(unavailableOptionalSourceIds.get(definition.targetId) ?? [])],
        sourceIdentities: (sourceIdentities.get(definition.targetId) ?? []).map(cloneSourceIdentity),
      });
    }
    this.rejected = Object.freeze(rejected.map(item => Object.freeze({ ...item })));
  }

  public listCatalog(): readonly TargetCatalogDto[] {
    return Object.freeze([...this.entries.values()].map(({ definition, unavailableOptionalSourceIds }) => {
      const unavailable = new Set(unavailableOptionalSourceIds);
      const sourceKinds = [...new Set(definition.sourceBindings
        .filter(source => !unavailable.has(source.sourceId))
        .map(source => source.kind))];
      return Object.freeze({
        targetId: definition.targetId,
        projectId: definition.projectId,
        projectName: definition.projectName,
        deploymentId: definition.deploymentId,
        environment: definition.environment,
        displayName: definition.displayName,
        description: definition.description,
        scenario: Object.freeze({ id: definition.scenario.id, version: definition.scenario.version,
          serviceId: definition.scenario.serviceId, serviceName: definition.scenario.serviceName }),
        sourceKinds: Object.freeze(sourceKinds),
        readOnly: true as const,
        enabled: definition.enabled,
        canStart: definition.enabled,
      });
    }));
  }

  public resolve(input: { targetId: string; capturedAt: string; signal: AbortSignal }): Promise<ResolvedTargetSnapshotV2> {
    return Promise.resolve().then(async () => {
      throwIfAborted(input.signal);
      if (!isIdentifier(input.targetId) || !isTimestamp(input.capturedAt)) {
        throw new TargetConfigurationError('TARGET_BINDING_INVALID');
      }
      const entry = this.entries.get(input.targetId);
      if (entry === undefined) throw new TargetConfigurationError('TARGET_NOT_FOUND');
      if (!entry.definition.enabled) throw new TargetConfigurationError('TARGET_DISABLED');
      const installedDigest = this.scenarios.get(scenarioKey(entry.definition.scenario));
      if (installedDigest === undefined) {
        throw new TargetConfigurationError('SCENARIO_VERSION_UNSUPPORTED');
      }
      if (installedDigest !== entry.definition.scenario.implementationDigest) {
        throw new TargetConfigurationError('SCENARIO_DIGEST_MISMATCH');
      }
      if (validateSources(entry.definition, this.connections, this.adapters) === undefined) {
        throw new TargetConfigurationError('SOURCE_MAPPING_INVALID');
      }

      const profile = await this.profileResolver.resolve({
        profileId: entry.definition.profileId,
        capturedAt: input.capturedAt,
        signal: input.signal,
      });
      if (profile.profileId !== entry.definition.profileId || profile.revision !== entry.definition.profileRevision) {
        throw new TargetConfigurationError('TARGET_BINDING_INVALID');
      }
      const memoryScope = deriveMemoryScope(entry.definition);
      const knowledgePolicy = resolveKnowledgePolicy(
        await this.knowledgePolicies.get(entry.definition.targetId),
        entry.definition.targetId,
        entry.definition.knowledgeRefs,
      );
      const unsigned = {
        schemaVersion: 2 as const,
        targetId: entry.definition.targetId,
        projectId: entry.definition.projectId,
        deploymentId: entry.definition.deploymentId,
        deploymentGeneration: entry.definition.deploymentGeneration,
        environment: entry.definition.environment,
        dataClass: entry.definition.dataClass,
        ...(entry.definition.datasetId === undefined ? {} : { datasetId: entry.definition.datasetId }),
        targetFingerprint: entry.definition.targetFingerprint,
        profile: cloneProfile(profile),
        scenario: cloneScenario(entry.definition.scenario),
        scenarioImplementationDigest: installedDigest,
        sourceBindings: entry.definition.sourceBindings.map(cloneSourceBinding),
        sourceIdentities: entry.sourceIdentities.map(cloneSourceIdentity),
        unavailableOptionalSourceIds: [...entry.unavailableOptionalSourceIds],
        knowledgeRefs: entry.definition.knowledgeRefs.map(reference => ({ ...reference })),
        knowledgePolicy,
        memoryScope,
        capturedAt: input.capturedAt,
      };
      const digest = `sha256:v2:${checkpointChecksum({ algorithm: 'sha256', version: 2, target: unsigned })}`;
      return deepFreeze({ ...unsigned, digest });
    });
  }
}

function parsePrivateConnections(input: unknown): ReadonlyMap<string, PrivateConnectionDefinition> {
  if (!isRecord(input) || Object.keys(input).some(key => key !== 'schemaVersion' && key !== 'connections')
    || input.schemaVersion !== 2 || !Array.isArray(input.connections) || input.connections.length > 2_000) {
    throw new TargetConfigurationError('TARGET_CATALOG_INVALID');
  }
  const valid: PrivateConnectionDefinition[] = [];
  const invalidIds = new Set<string>();
  const counts = new Map<string, number>();
  for (const candidate of input.connections) {
    if (isRecord(candidate) && isIdentifier(candidate.sourceId)) {
      counts.set(candidate.sourceId, (counts.get(candidate.sourceId) ?? 0) + 1);
    }
    const parsed = parsePrivateConnection(candidate);
    if (parsed === undefined) {
      if (isRecord(candidate) && isIdentifier(candidate.sourceId)) invalidIds.add(candidate.sourceId);
      continue;
    }
    valid.push(parsed);
  }
  const result = new Map<string, PrivateConnectionDefinition>();
  for (const item of valid) {
    if (counts.get(item.sourceId) !== 1) invalidIds.add(item.sourceId);
    else result.set(item.sourceId, item);
  }
  for (const id of invalidIds) result.delete(id);
  return result;
}

function parsePrivateConnection(value: unknown): PrivateConnectionDefinition | undefined {
  const allowedKeys = new Set(['sourceId', 'version', 'kind', 'adapterId', 'enabled', 'endpoint', 'secretRef',
    'allowedServiceIds', 'dataDomainId', 'sourceGeneration', 'permissionScopeDigest']);
  if (!isRecord(value) || Object.keys(value).some(key => !allowedKeys.has(key))
    || !isIdentifier(value.sourceId) || !isRevision(value.version)
    || !isSourceKind(value.kind) || !isIdentifier(value.adapterId) || typeof value.enabled !== 'boolean'
    || !isIdentifier(value.dataDomainId) || !Number.isSafeInteger(value.sourceGeneration) || (value.sourceGeneration as number) < 1
    || typeof value.permissionScopeDigest !== 'string' || !/^[a-f0-9]{64}$/iu.test(value.permissionScopeDigest)
    || !Array.isArray(value.allowedServiceIds)) return undefined;
  const allowedServiceIds: string[] = [];
  for (const serviceId of value.allowedServiceIds as unknown[]) {
    if (!isIdentifier(serviceId)) return undefined;
    allowedServiceIds.push(serviceId);
  }
  if (allowedServiceIds.length === 0 || allowedServiceIds.length > 32
    || new Set(allowedServiceIds).size !== allowedServiceIds.length) return undefined;
  if (value.endpoint !== undefined && !isSafeEndpoint(value.endpoint)) return undefined;
  if (value.secretRef !== undefined && !isIdentifier(value.secretRef)) return undefined;
  return {
    sourceId: value.sourceId,
    version: value.version,
    kind: value.kind,
    adapterId: value.adapterId,
    enabled: value.enabled,
    ...(typeof value.endpoint === 'string' ? { endpoint: value.endpoint } : {}),
    ...(typeof value.secretRef === 'string' ? { secretRef: value.secretRef } : {}),
    allowedServiceIds,
    dataDomainId: value.dataDomainId,
    sourceGeneration: value.sourceGeneration as number,
    permissionScopeDigest: value.permissionScopeDigest.toLowerCase(),
  };
}

function validateSources(
  definition: TargetCatalogDefinition,
  connections: ReadonlyMap<string, PrivateConnectionDefinition>,
  adapters: ReadonlyMap<string, TargetSourceKind>,
): { unavailableOptionalSourceIds: readonly string[]; sourceIdentities: readonly TargetSourceIdentity[] } | undefined {
  const unavailableOptionalSourceIds: string[] = [];
  const sourceIdentities: TargetSourceIdentity[] = [];
  for (const source of definition.sourceBindings) {
    if (adapters.get(source.adapterId) !== source.kind) return undefined;
    const connection = connections.get(source.sourceId);
    const valid = connection !== undefined
      && connection.enabled
      && connection.version === source.version
      && connection.kind === source.kind
      && connection.adapterId === source.adapterId
      && source.allowedServiceIds.every(serviceId => connection.allowedServiceIds.includes(serviceId));
    if (!valid) {
      if (source.required) return undefined;
      unavailableOptionalSourceIds.push(source.sourceId);
    } else if (connection !== undefined) {
      sourceIdentities.push({
        sourceId: connection.sourceId,
        dataDomainId: connection.dataDomainId,
        sourceGeneration: connection.sourceGeneration,
        permissionScopeDigest: connection.permissionScopeDigest,
      });
    }
  }
  const requiredKinds = new Set(definition.sourceBindings.filter(source => source.required).map(source => source.kind));
  if (!requiredKinds.has('metrics')) return undefined;
  return { unavailableOptionalSourceIds, sourceIdentities };
}

function buildScenarioRegistry(scenarios: readonly TargetScenarioVersion[]): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const scenario of scenarios) {
    if (!isIdentifier(scenario.id) || !/^\d+\.\d+\.\d+$/u.test(scenario.version)
      || !isSnapshotDigestV1(scenario.implementationDigest) || result.has(`${scenario.id}@${scenario.version}`)) {
      throw new TargetConfigurationError('TARGET_CATALOG_INVALID');
    }
    result.set(`${scenario.id}@${scenario.version}`, scenario.implementationDigest);
  }
  return result;
}

function buildAdapterRegistry(adapters: readonly TargetSourceAdapter[]): ReadonlyMap<string, TargetSourceKind> {
  const result = new Map<string, TargetSourceKind>();
  for (const adapter of adapters) {
    if (!isIdentifier(adapter.id) || !isSourceKind(adapter.kind) || result.has(adapter.id)) {
      throw new TargetConfigurationError('TARGET_CATALOG_INVALID');
    }
    result.set(adapter.id, adapter.kind);
  }
  return result;
}

function deriveMemoryScope(definition: TargetCatalogDefinition): MemoryScope {
  const base = {
    profileId: definition.profileId,
    profileRevision: definition.profileRevision,
    serviceId: definition.scenario.serviceId,
    faultType: definition.scenario.id,
    targetFingerprint: definition.targetFingerprint,
  };
  if (definition.dataClass === 'simulated') {
    return { ...base, environment: definition.environment, dataClass: 'simulated', datasetId: definition.datasetId };
  }
  return { ...base, environment: definition.environment, dataClass: 'live' };
}

function scenarioKey(scenario: TargetScenarioBinding): string {
  return `${scenario.id}@${scenario.version}`;
}

function isSafeEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const endpoint = new URL(value);
    return (endpoint.protocol === 'http:' || endpoint.protocol === 'https:')
      && endpoint.username.length === 0 && endpoint.password.length === 0
      && endpoint.search.length === 0 && endpoint.hash.length === 0;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128
    && /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(value);
}

function isRevision(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128
    && /^[\p{L}\p{N}][\p{L}\p{N}._:/-]*$/u.test(value);
}

function isTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function isSourceKind(value: unknown): value is TargetSourceKind {
  return value === 'metrics' || value === 'logs' || value === 'trace' || value === 'change';
}

function rejection(index: number, targetId: string, reasonCode: TargetCatalogRejection['reasonCode']): TargetCatalogRejection {
  return { index, targetId, reasonCode };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw Object.assign(new Error('Target resolution aborted.'), { code: 'ABORTED' });
}

function cloneTarget(target: TargetCatalogDefinition): TargetCatalogDefinition {
  return structuredClone(target);
}

function cloneProfile(profile: ResolvedProfileSnapshot): ResolvedProfileSnapshot {
  return structuredClone(profile);
}

function cloneScenario(scenario: TargetScenarioBinding): TargetScenarioBinding {
  return { id: scenario.id, version: scenario.version, serviceId: scenario.serviceId,
    serviceName: scenario.serviceName, metricSemantics: scenario.metricSemantics,
    threshold: scenario.threshold, minSamples: scenario.minSamples, metricMapping: { ...scenario.metricMapping,
    serviceSelector: { ...scenario.metricMapping.serviceSelector },
    staticLabels: { ...scenario.metricMapping.staticLabels } } };
}

function cloneSourceBinding(source: TargetSourceBinding): TargetSourceBinding {
  return { ...source, allowedServiceIds: [...source.allowedServiceIds] };
}

function cloneSourceIdentity(identity: TargetSourceIdentity): TargetSourceIdentity {
  return { ...identity };
}

function resolveKnowledgePolicy(
  policy: TargetKnowledgePolicy | null,
  targetId: string,
  references: TargetCatalogDefinition['knowledgeRefs'],
): TargetKnowledgePolicy {
  if (policy !== null && (policy.targetId !== targetId || policy.schemaVersion !== 1
    || !Number.isSafeInteger(policy.policyEpoch) || policy.policyEpoch < 0
    || !isRevision(policy.policyVersion) || policy.defaultRequiredness !== 'optional')) {
    throw new TargetConfigurationError('TARGET_BINDING_INVALID');
  }
  const configured = new Map((policy?.requirements ?? []).map(requirement => [
    `${requirement.id}\u0000${requirement.version}\u0000${requirement.digest}`, requirement,
  ]));
  const requirements = references.map(reference => {
    const requirement = configured.get(`${reference.id}\u0000${reference.version}\u0000${reference.digest}`);
    if (requirement !== undefined) return { ...requirement };
    return { id: reference.id, version: reference.version, digest: reference.digest, requiredness: 'optional' as const };
  });
  if (policy !== null && policy.requirements.some(requirement => !references.some(reference =>
    reference.id === requirement.id && reference.version === requirement.version && reference.digest === requirement.digest))) {
    throw new TargetConfigurationError('TARGET_BINDING_INVALID');
  }
  return {
    schemaVersion: 1,
    targetId,
    policyVersion: policy?.policyVersion ?? 'default/v1',
    policyEpoch: policy?.policyEpoch ?? 0,
    defaultRequiredness: 'optional',
    requirements,
  };
}

function isSnapshotDigestV1(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:v1:[a-f0-9]{64}$/u.test(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
