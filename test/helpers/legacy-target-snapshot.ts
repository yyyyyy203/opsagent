import type { ResolvedTargetSnapshot, ResolvedTargetSnapshotV2 } from '../../src/contracts/target.js';

/** Build a byte-compatible V1 shape from a V2 fixture without retaining V2-only fields. */
export function legacySnapshotUnsigned(snapshot: ResolvedTargetSnapshotV2): Omit<ResolvedTargetSnapshot, 'digest'> {
  const value: Record<string, unknown> = { ...snapshot };
  delete value.scenarioImplementationDigest;
  delete value.sourceIdentities;
  delete value.knowledgePolicy;
  delete value.publicationVersion;
  delete value.identityRegistryVersion;
  delete value.digest;
  value.schemaVersion = 1;
  return value as unknown as Omit<ResolvedTargetSnapshot, 'digest'>;
}
