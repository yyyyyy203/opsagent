import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createLocalTargetRuntime, readLocalTargetHostConfig } from '../src/bootstrap/local-target-runtime.js';
import { createTargetIdentityTestPorts } from './helpers/target-identity-test-ports.js';

const examplePath = fileURLToPath(new URL('../examples/local-inspection-targets.json', import.meta.url));

describe('local Target host configuration', () => {
  it('loads two simulated, read-only Targets with Metrics and Logs bindings', async () => {
    const config = await readLocalTargetHostConfig(examplePath);
    const runtime = createLocalTargetRuntime(config, 'local-test-cursor-secret-with-more-than-32-bytes');
    const resolver = await runtime.targetRuntime!.createResolver({
      ...createTargetIdentityTestPorts(),
      knowledgePublications: { inspectBinding: async () => ({ publication: null, scopeKey: null }) },
      knowledgeCapabilities: { getForTarget: async () => ({ semanticEnabled: false, proceduralEnabled: false }) },
    });

    expect(runtime.profiles?.map(profile => profile.id)).toEqual([
      'market-a.local.settlement', 'market-b.local.settlement',
    ]);
    expect(resolver.listCatalog()).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: 'market-a-sim', sourceKinds: ['metrics', 'logs'], readOnly: true }),
      expect.objectContaining({ targetId: 'market-b-sim', sourceKinds: ['metrics', 'logs'], readOnly: true }),
    ]));

    const snapshots = await Promise.all(['market-a-sim', 'market-b-sim'].map(targetId =>
      resolver.resolve({ targetId, capturedAt: '2026-10-22T00:00:00.000Z', signal: new AbortController().signal })));
    expect(snapshots.map(snapshot => snapshot.scenario.threshold)).toEqual([0.05, 0.02]);
    expect(snapshots.every(snapshot => snapshot.sourceBindings.some(source => source.kind === 'metrics')
      && snapshot.sourceBindings.some(source => source.kind === 'logs'))).toBe(true);
  });

  it('rejects non-loopback endpoints and Profiles that permit actions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsagent-target-config-'));
    try {
      const original = JSON.parse(await readFile(examplePath, 'utf8')) as {
        connections: { connections: Array<{ endpoint: string }> };
        profiles: Array<{ allowedActions: string[] }>;
      };
      const remote = structuredClone(original);
      remote.connections.connections[0]!.endpoint = 'https://metrics.example.test';
      const remotePath = join(root, 'remote.json');
      await writeFile(remotePath, JSON.stringify(remote));
      await expect(readLocalTargetHostConfig(remotePath)).rejects.toThrow('LOCAL_TARGET_SOURCE_MUST_USE_LOOPBACK_HTTP');

      const credentialed = structuredClone(original);
      credentialed.connections.connections[0]!.endpoint = 'http://user:secret@127.0.0.1:19390/?token=secret';
      const credentialedPath = join(root, 'credentialed.json');
      await writeFile(credentialedPath, JSON.stringify(credentialed));
      await expect(readLocalTargetHostConfig(credentialedPath)).rejects.toThrow('LOCAL_TARGET_SOURCE_MUST_USE_LOOPBACK_HTTP');

      const writable = structuredClone(original);
      writable.profiles[0]!.allowedActions = ['restart'];
      const writablePath = join(root, 'writable.json');
      await writeFile(writablePath, JSON.stringify(writable));
      await expect(readLocalTargetHostConfig(writablePath)).rejects.toThrow('TARGET_PROFILE_INVALID');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires an explicit absolute config path', async () => {
    await expect(readLocalTargetHostConfig('examples/local-inspection-targets.json'))
      .rejects.toThrow('AGENTOPS_TARGET_CONFIG must be an absolute path.');
  });
});
