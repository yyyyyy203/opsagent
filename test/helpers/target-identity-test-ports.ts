import type { TargetIdentityAuditRecord, TargetIdentityRegistry, TargetKnowledgePolicy,
  TargetKnowledgePolicyStore } from '../../src/contracts/target.js';
import { applyTargetIdentityCatalog, defaultTargetKnowledgePolicy, emptyTargetIdentitySnapshot,
  nextTargetKnowledgePolicy } from '../../src/storage/target-identity-state.js';

/** Deterministic ephemeral ports for Resolver tests; persistence behavior has dedicated SQLite tests. */
export function createTargetIdentityTestPorts(): {
  identityRegistry: TargetIdentityRegistry;
  knowledgePolicies: TargetKnowledgePolicyStore;
  identityRegistryVersion: () => number;
} {
  let snapshot = emptyTargetIdentitySnapshot();
  let audit: TargetIdentityAuditRecord[] = [];
  const policies = new Map<string, TargetKnowledgePolicy>();
  return {
    identityRegistryVersion: () => snapshot.version,
    identityRegistry: {
      readSnapshot: async () => structuredClone(snapshot),
      publishCatalog: async input => {
        const result = applyTargetIdentityCatalog(snapshot, input);
        snapshot = result.snapshot;
        audit = [...audit, ...result.audit.map((entry, index) => ({ ...entry, sequence: audit.length + index + 1 }))];
        return structuredClone(result.publication);
      },
      listAudit: async targetId => structuredClone(audit.filter(entry => targetId === undefined || entry.targetId === targetId)),
    },
    knowledgePolicies: {
      get: async targetId => structuredClone(policies.get(targetId) ?? defaultTargetKnowledgePolicy(targetId)),
      compareAndSet: async input => {
        const next = nextTargetKnowledgePolicy(policies.get(input.targetId) ?? null, input);
        policies.set(input.targetId, next);
        return structuredClone(next);
      },
    },
  };
}
