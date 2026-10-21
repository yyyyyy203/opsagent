import { z } from 'zod';
import type { DiagnosticMemoryConfig, MemoryPolicyPort, MemoryPreferences, RunMemoryControl } from '../contracts/diagnostic-memory.js';
import { memoryScopeSchema, parseMemoryPreferences, parseRunMemoryControl } from '../contracts/diagnostic-memory-schema.js';
import { sameMemoryScope } from '../memory/memory-scope.js';
import { MemoryError } from '../memory/memory-error.js';
import type { MemoryScope } from '../contracts/diagnostic-memory.js';

const identifier = z.string().min(1).max(256).regex(/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u);
const profile = z.object({
  scope: memoryScopeSchema,
  profilePolicyRevision: identifier,
  captureDefault: z.enum(['manual', 'automatic', 'skip']).default('manual'),
  recallDefault: z.boolean().default(false),
  allowAutomaticCapture: z.boolean().default(false),
  allowRecall: z.boolean().default(true),
}).strict();
const configSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({ enabled: z.literal(true), profiles: z.array(profile).min(1).max(200),
    requiredSources: z.array(z.enum(['metric', 'log', 'trace', 'change'])).min(1).max(4),
    modelWindowTokens: z.number().int().positive().safe(),
    reservedOutputTokens: z.number().int().positive().safe(),
  }).strict(),
]);

/** Deployment files are data, not connection or credential configuration. */
export function parseDiagnosticMemoryConfig(input: unknown): DiagnosticMemoryConfig {
  const value = configSchema.parse(input);
  if (!value.enabled) return value;
  if (value.reservedOutputTokens >= value.modelWindowTokens
    || new Set(value.requiredSources).size !== value.requiredSources.length) throw new MemoryError('MEMORY_DATA_INVALID');
  const seen = new Set<string>();
  for (const item of value.profiles) {
    if (seen.has(item.scope.profileId)) throw new MemoryError('MEMORY_SCOPE_INVALID');
    seen.add(item.scope.profileId);
    // Scope labels are non-sensitive host resource IDs, never endpoints or credentials.
    for (const label of Object.values(item.scope)) {
      if (!identifier.safeParse(label).success || /\b(?:localhost|\d{1,3}(?:\.\d{1,3}){3})\b|\.internal\b|^sk-/iu.test(label)) {
        throw new MemoryError('MEMORY_SCOPE_INVALID');
      }
    }
    if ((item.captureDefault === 'automatic' && !item.allowAutomaticCapture)
      || (item.recallDefault && !item.allowRecall)) throw new MemoryError('MEMORY_POLICY_DENIED');
  }
  return structuredClone(value);
}

export function resolveMemoryControl(config: DiagnosticMemoryConfig, profileId: string,
  preferences?: MemoryPreferences): RunMemoryControl | undefined {
  let selected: MemoryPreferences;
  try { selected = parseMemoryPreferences(preferences ?? {}); }
  catch { throw new MemoryError('MEMORY_DATA_INVALID'); }
  const item = config.enabled ? config.profiles.find(p => p.scope.profileId === profileId) : undefined;
  if (item === undefined) {
    if (selected.capture === 'automatic' || selected.recall === 'enabled') {
      throw new MemoryError('MEMORY_POLICY_DENIED');
    }
    return undefined;
  }
  const capture = selected.capture === undefined || selected.capture === 'profile' ? item.captureDefault : selected.capture;
  const recall = selected.recall === undefined || selected.recall === 'profile' ? item.recallDefault : selected.recall === 'enabled';
  if ((capture === 'automatic' && !item.allowAutomaticCapture) || (recall && !item.allowRecall)) throw new MemoryError('MEMORY_POLICY_DENIED');
  return parseRunMemoryControl({ schemaVersion: 1, scope: item.scope,
    profilePolicyRevision: item.profilePolicyRevision, capture, recall });
}

/** Resolve Target memory from its frozen host snapshot, never from caller-supplied profile scope. */
export function resolveTargetMemoryControl(config: DiagnosticMemoryConfig, scope: MemoryScope,
  preferences?: Pick<MemoryPreferences, 'capture' | 'recall'>): RunMemoryControl | undefined {
  const item = config.enabled ? config.profiles.find(profile => sameMemoryScope(profile.scope, scope)) : undefined;
  if (item === undefined) {
    const selected = preferences ?? {};
    if (selected.capture === 'automatic' || selected.recall === 'enabled') throw new MemoryError('MEMORY_POLICY_DENIED');
    return undefined;
  }
  return resolveMemoryControl(config, item.scope.profileId, preferences);
}

/** Rechecks current host authorization; persisted snapshots are never upgraded. */
export class HostMemoryPolicy implements MemoryPolicyPort {
  public constructor(private readonly current: () => DiagnosticMemoryConfig) {}
  public allows(control: RunMemoryControl, capability: 'capture' | 'recall'): boolean {
    try {
      const config = this.current();
      if (!config.enabled) return false;
      const snapshot = parseRunMemoryControl(control);
      const item = config.profiles.find(p => p.scope.profileId === snapshot.scope.profileId);
      if (item === undefined || item.profilePolicyRevision !== snapshot.profilePolicyRevision
        || !sameMemoryScope(item.scope, snapshot.scope)) return false;
      return capability === 'recall' ? item.allowRecall
        : snapshot.capture !== 'automatic' || item.allowAutomaticCapture;
    } catch { return false; }
  }
}
