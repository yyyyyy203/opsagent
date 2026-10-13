import { describe, expect, it } from 'vitest';
import type { DiagnosticMemoryConfig } from '../src/contracts/diagnostic-memory.js';
import { HostMemoryPolicy, parseDiagnosticMemoryConfig, resolveMemoryControl } from '../src/bootstrap/memory-policy.js';
import { readDiagnosticMemoryConfig } from '../src/bootstrap/diagnostic-memory.js';
import { simulationMemoryScope } from './fixtures/diagnostic-memory.js';

const deployment = () => ({ enabled: true, profiles: [{ scope: simulationMemoryScope(),
  profilePolicyRevision: 'policy-v1' }], requiredSources: ['metric'],
modelWindowTokens: 32_768, reservedOutputTokens: 4_096 });

function expectPolicyDenied(action: () => unknown): void {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'MEMORY_POLICY_DENIED' });
}

describe('host memory policy', () => {
  it('makes enabled defaults restrictive and resolves only the host Profile scope', () => {
    const config = parseDiagnosticMemoryConfig(deployment());
    expect(config).toMatchObject({ profiles: [{ captureDefault: 'manual', recallDefault: false,
      allowAutomaticCapture: false, allowRecall: true }] });
    expect(resolveMemoryControl(config, 'simulation')).toMatchObject({ schemaVersion: 1,
      scope: simulationMemoryScope(), capture: 'manual', recall: false, profilePolicyRevision: 'policy-v1' });
    expect(resolveMemoryControl(config, 'missing')).toBeUndefined();
    expect(resolveMemoryControl({ enabled: false }, 'simulation')).toBeUndefined();
    expect(resolveMemoryControl({ enabled: false }, 'simulation', { capture: 'manual', recall: 'disabled' })).toBeUndefined();
    expect(resolveMemoryControl(config, 'missing', { capture: 'profile', recall: 'profile' })).toBeUndefined();
    expect(resolveMemoryControl(config, 'simulation', { capture: 'skip', recall: 'enabled' }))
      .toMatchObject({ capture: 'skip', recall: true });
  });

  it('denies explicit capability escalation, including disabled/unconfigured Profiles', () => {
    const config = parseDiagnosticMemoryConfig(deployment());
    for (const [profile, preferences] of [['simulation', { capture: 'automatic' }],
      ['missing', { recall: 'enabled' }]] as const) {
      expectPolicyDenied(() => resolveMemoryControl(config, profile, preferences));
    }
    expectPolicyDenied(() => resolveMemoryControl({ enabled: false }, 'simulation', { recall: 'enabled' }));
    const denied = parseDiagnosticMemoryConfig({ ...deployment(), profiles: [{ ...deployment().profiles[0], allowRecall: false }] });
    expectPolicyDenied(() => resolveMemoryControl(denied, 'simulation', { recall: 'enabled' }));
  });

  it('rechecks every scope dimension and policy revision without upgrading old controls', () => {
    let current: DiagnosticMemoryConfig = parseDiagnosticMemoryConfig(deployment());
    const policy = new HostMemoryPolicy(() => current);
    const control = resolveMemoryControl(current, 'simulation')!;
    expect(policy.allows(control, 'capture')).toBe(true);
    expect(policy.allows(control, 'recall')).toBe(true);
    for (const key of ['profileId', 'profileRevision', 'serviceId', 'faultType', 'targetFingerprint', 'datasetId'] as const) {
      expect(policy.allows({ ...control, scope: { ...simulationMemoryScope(), [key]: 'other' } }, 'capture')).toBe(false);
    }
    current = parseDiagnosticMemoryConfig({ ...deployment(), profiles: [{ ...deployment().profiles[0], profilePolicyRevision: 'policy-v2' }] });
    expect(policy.allows(control, 'capture')).toBe(false);
    current = { enabled: false };
    expect(policy.allows(control, 'recall')).toBe(false);
  });

  it('retains all 200 host-configured Target scopes without truncating or aliasing them', () => {
    const profiles = Array.from({ length: 200 }, (_, index) => ({
      scope: { ...simulationMemoryScope(), profileId: `project-${index}.profile`,
        targetFingerprint: `fingerprint-${index}`, datasetId: `dataset-${index}` },
      profilePolicyRevision: 'policy-v1',
    }));

    const config = parseDiagnosticMemoryConfig({ ...deployment(), profiles });

    expect(config.enabled).toBe(true);
    if (config.enabled) {
      expect(config.profiles).toHaveLength(200);
      expect(resolveMemoryControl(config, 'project-199.profile')?.scope).toMatchObject({
        profileId: 'project-199.profile', targetFingerprint: 'fingerprint-199', datasetId: 'dataset-199',
      });
    }
  });

  it.each([
    { ...deployment(), endpoint: 'https://example.test' },
    { ...deployment(), profiles: [...deployment().profiles, ...deployment().profiles] },
    { ...deployment(), modelWindowTokens: 0 },
    { ...deployment(), reservedOutputTokens: 32_768 },
    { ...deployment(), profiles: [{ ...deployment().profiles[0], captureDefault: 'automatic' }] },
    { ...deployment(), profiles: [{ ...deployment().profiles[0], recallDefault: true, allowRecall: false }] },
    { ...deployment(), profiles: [{ ...deployment().profiles[0], apiKey: 'secret' }] },
  ])('rejects invalid or contradictory deployment config', (input: unknown) => {
    expect(() => parseDiagnosticMemoryConfig(input)).toThrow();
  });

  it('defaults deployment to disabled and fails closed on missing/relative enabled config', async () => {
    expect(await readDiagnosticMemoryConfig({})).toEqual({ enabled: false });
    await expect(readDiagnosticMemoryConfig({ AGENTOPS_MEMORY_ENABLED: '1' })).rejects.toThrow();
    await expect(readDiagnosticMemoryConfig({ AGENTOPS_MEMORY_ENABLED: '1', AGENTOPS_MEMORY_CONFIG: 'relative.json' })).rejects.toThrow();
  });
});
