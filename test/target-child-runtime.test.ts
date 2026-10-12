import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatModel, ModelResponse, ModelStreamEvent, Tool } from '../src/contracts/index.js';
import type {
  TargetOperationGuard,
  TargetOperationPermit,
  TargetRecoveryGate,
  TargetRunBindingRecord,
  TargetRunRuntimeLease,
} from '../src/contracts/target.js';
import { TargetConfigurationError } from '../src/contracts/target.js';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { InMemoryDurableState } from '../src/storage/in-memory-durable-state.js';
import { createStaticTargetResolver } from '../src/profiles/target-resolver.js';
import { multiProjectConnectionRegistry, multiProjectProfiles, multiProjectTargetCatalog } from '../src/profiles/target-samples.js';
import { WINDOW_FAILURE_RATE_INSTALLATION } from '../src/profiles/scenarios/window-failure-rate-v1.js';
import { StaticProfileResolver } from '../src/profiles/profile-resolver.js';
import { createTargetIdentityTestPorts } from './helpers/target-identity-test-ports.js';

const now = '2026-10-12T02:00:00.000Z';

describe('Target-bound source child Harness', () => {
  it('uses only host-created source-scoped Tools and fences model/source operations', async () => {
    const clock = { now: () => new Date(now) };
    const ports = createTargetIdentityTestPorts();
    const resolver = await createStaticTargetResolver({
      ...ports,
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
      installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
      validationTime: now,
    });
    const snapshot = await resolver.resolve({
      targetId: 'market-a-sim',
      capturedAt: now,
      signal: new AbortController().signal,
    });
    const runId = 'child-source-scope-test';
    const requestId = 'request-child-source-scope-test';
    const requestDigest = `sha256:v1:${'a'.repeat(64)}`;
    const durable = new InMemoryDurableState(clock);
    await durable.targetBindings.reserveRequest({ requestId, targetId: snapshot.targetId, requestDigest, runId, createdAt: now });
    const claimResult = await durable.targetStarts.claimStart({
      requestId, runId, targetId: snapshot.targetId, requestDigest, ownerId: 'owner-1', now,
      leaseUntil: new Date(Date.parse(now) + 60_000).toISOString(),
    });
    if (claimResult.status !== 'claimed') throw new Error('test start claim was not acquired');
    const binding: TargetRunBindingRecord = {
      bindingId: 'binding-child-source-scope-test', targetId: snapshot.targetId, runId, rootRunId: runId,
      snapshotDigest: snapshot.digest, createdAt: now, requestId, requestDigest,
    };

    const sourceTool: Tool = {
      name: 'metrics.settlement', description: 'read settlement metrics', kind: 'evidence', source: 'mcp',
      targetSourceId: 'market-a-metrics', inputSchema: z.object({}).strict(),
      call: () => ({ blocks: [{ type: 'json', value: { status: 'ok' } }] }),
    };
    const reportTool: Tool = {
      name: 'source_report', description: 'submit source report', kind: 'utility', source: 'builtin',
      inputSchema: z.object({}).strict(), call: () => ({ blocks: [{ type: 'json', value: { accepted: true } }] }),
    };
    const rootOnlyTool: Tool = {
      name: 'root.metrics_subagent', description: 'root-only capability', kind: 'evidence', source: 'subagent',
      targetSourceId: 'market-a-metrics', inputSchema: z.object({}).strict(), call: () => ({ blocks: [] }),
    };
    const visibleToolNames: string[][] = [];
    const model: ChatModel = {
      async *stream(_messages, tools): AsyncGenerator<ModelStreamEvent, ModelResponse> {
        visibleToolNames.push(tools.map(tool => tool.name));
        await Promise.resolve();
        if (visibleToolNames.length === 1) {
          return { toolCalls: [{ id: 'metrics-call-1', name: 'metrics.settlement', input: {} }] };
        }
        yield { type: 'text_delta', delta: 'done' };
        return { text: 'done', toolCalls: [] };
      },
    };
    const authorizations: Array<{ operation: string; capability: string }> = [];
    const validations: TargetOperationPermit[] = [];
    const operations: TargetOperationGuard = {
      authorize: async input => {
        authorizations.push({ operation: input.operation, capability: input.capability });
        return {
          bindingId: binding.bindingId, runId, rootRunId: runId, snapshotDigest: snapshot.digest,
          operation: input.operation, capability: input.capability, policyEpoch: 1, signal: input.signal,
        };
      },
      validate: async permit => { validations.push(permit); },
    };
    const lease: TargetRunRuntimeLease = { model, tools: [rootOnlyTool], operations, release: vi.fn() };
    let gateSourceScope: string | undefined;
    let denyResume = false;
    const gate: TargetRecoveryGate = {
      acquireForStart: async input => { gateSourceScope = input.sourceScopeId; return lease; },
      authorizeResume: async () => {
        if (denyResume) throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
      },
      acquireForResume: async () => {
        if (denyResume) throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
        return lease;
      },
    };
    const runtime = createAgentRuntime({
      model,
      workspaceRoots: [],
      tools: [sourceTool, reportTool],
      includeExternalBash: false,
      durableState: durable,
      targetRecoveryGate: gate,
      targetSourceScopeId: 'market-a-metrics',
      clock,
    });
    await runtime.ready;
    try {
      const started = await runtime.agent.reply({
        runId,
        profileId: snapshot.profile.profileId,
        message: 'inspect metrics',
        trustedTargetBinding: { binding, snapshot, startClaim: claimResult.claim },
      });

      expect(started.status).toBe('completed');
      expect(gateSourceScope).toBe('market-a-metrics');
      expect(visibleToolNames).toEqual([
        ['metrics.settlement', 'source_report'],
        ['metrics.settlement', 'source_report'],
      ]);
      expect(authorizations).toContainEqual({ operation: 'model', capability: 'model' });
      expect(authorizations).toContainEqual({ operation: 'source', capability: 'market-a-metrics' });
      expect(validations.length).toBeGreaterThan(0);

      const eventsBeforeDeniedResume = await runtime.eventStoreV2.readRun(runId, 0, 1_000);
      denyResume = true;
      const resume = runtime.agent.resumeStream(runId);
      await expect(resume.next()).rejects.toMatchObject({ code: 'TARGET_OPERATION_DENIED' });
      const eventsAfterDeniedResume = await runtime.eventStoreV2.readRun(runId, 0, 1_000);
      expect(eventsAfterDeniedResume.map(event => event.type)).not.toContain('RUN_RESUMED');
      expect(eventsAfterDeniedResume.length).toBe(eventsBeforeDeniedResume.length);
      expect(visibleToolNames).toHaveLength(2);
    } finally {
      await runtime.close();
    }
  });
});
