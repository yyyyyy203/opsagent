import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import type { Tool } from '../src/contracts/index.js';
import { systemClock } from '../src/contracts/index.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

describe('external Bash HITL flow', () => {
  it('confirms, pauses for host execution, ingests result and resumes', async () => {
    let sequence = 0;
    const runtime = createAgentRuntime({
      model: new ScriptedModel([
        { toolCalls: [{ id: 'bash-1', name: 'bash', input: { command: 'pnpm test', cwd: 'D:\\agentops' } }] },
        { text: '巡检完成', toolCalls: [] },
      ]),
      workspaceRoots: ['D:\\agentops'],
      ids: { next: (prefix) => `${prefix}-${++sequence}` },
      actionMode: 'dry_run',
    });

    const first = await runtime.agent.reply({ message: '检查项目', profileId: 'group-buy-market' });
    expect(first.status).toBe('awaiting_confirmation');
    expect((await runtime.eventStoreV2.readRun(first.runId, 0, 100)).map((item) => item.type)).toContain('CONFIRMATION_REQUESTED');
    await runtime.hitl.decide({
      runId: first.runId,
      toolCallId: 'bash-1',
      confirmed: true,
      actor: 'tester',
      decidedAt: systemClock.now().toISOString(),
    });
    expect((await runtime.eventStoreV2.readRun(first.runId, 0, 200)).map((item) => item.type)).toContain('CONFIRMATION_RESOLVED');

    const second = await drain(runtime.agent.resumeStream(first.runId));
    expect(second.status).toBe('paused');
    const paused = await runtime.checkpoints.load(first.runId);
    expect(paused?.pendingInterrupt?.interruptType).toBe('external_tool_execution');
    expect(typeof paused?.pendingInterrupt?.payload.toolDefinitionDigest).toBe('string');

    await runtime.externalTools.submit({
      runId: first.runId,
      toolCallId: 'bash-1',
      response: { blocks: [{ type: 'text', text: 'tests passed' }] },
    });
    const final = await drain(runtime.agent.resumeStream(first.runId));
    expect(final.status).toBe('completed');
    expect(final.finalText).toBe('巡检完成');
  });

  it('rejects a static Tool confirmation after its implementation version changes', async () => {
    let implementationVersion = 'confirmation.v1';
    let operationCalls = 0;
    const tool: Tool = {
      name: 'test.confirmation',
      description: 'A versioned test operation requiring confirmation.',
      kind: 'utility',
      get implementationVersion() { return implementationVersion; },
      inputSchema: z.object({}).strict(),
      requireUserConfirm: true,
      call: async () => {
        operationCalls += 1;
        return { blocks: [{ type: 'text', text: 'done' }] };
      },
    };
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ toolCalls: [{ id: 'confirm-versioned', name: tool.name, input: {} }] }]),
      workspaceRoots: [],
      tools: [tool],
      includeExternalBash: false,
    });

    try {
      const pending = await runtime.agent.reply({ message: 'run the controlled operation', profileId: 'group-buy-market' });
      expect(pending.status).toBe('awaiting_confirmation');
      const checkpoint = await runtime.checkpoints.load(pending.runId);
      expect(typeof checkpoint?.pendingInterrupt?.payload.toolDefinitionDigest).toBe('string');

      implementationVersion = 'confirmation.v2';
      await expect(runtime.hitl.decide({
        runId: pending.runId,
        toolCallId: 'confirm-versioned',
        confirmed: true,
        actor: 'tester',
        decidedAt: systemClock.now().toISOString(),
      })).rejects.toThrow();

      const unchanged = await runtime.checkpoints.load(pending.runId);
      expect(unchanged?.confirmedToolCallIds).not.toContain('confirm-versioned');
      expect(operationCalls).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it('rejects an external Tool result after its implementation version changes', async () => {
    let implementationVersion = 'external.v1';
    const tool: Tool = {
      name: 'test.external-operation',
      description: 'A host-executed versioned test operation.',
      kind: 'utility',
      source: 'external',
      get implementationVersion() { return implementationVersion; },
      inputSchema: z.object({}).strict(),
      userFacingLabel: () => 'Run test operation',
    };
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ toolCalls: [{ id: 'external-versioned', name: tool.name, input: {} }] }]),
      workspaceRoots: [],
      tools: [tool],
      includeExternalBash: false,
    });

    try {
      const paused = await runtime.agent.reply({ message: 'request host operation', profileId: 'group-buy-market' });
      expect(paused.status).toBe('paused');
      const checkpoint = await runtime.checkpoints.load(paused.runId);
      expect(checkpoint?.pendingInterrupt?.interruptType).toBe('external_tool_execution');
      expect(typeof checkpoint?.pendingInterrupt?.payload.toolDefinitionDigest).toBe('string');

      implementationVersion = 'external.v2';
      await expect(runtime.externalTools.submit({
        runId: paused.runId,
        toolCallId: 'external-versioned',
        response: { blocks: [{ type: 'text', text: 'external operation completed' }] },
      })).rejects.toThrow();

      const unchanged = await runtime.checkpoints.load(paused.runId);
      expect(unchanged?.status).toBe('paused');
      expect(unchanged?.pendingInterrupt?.interruptType).toBe('external_tool_execution');
    } finally {
      await runtime.close();
    }
  });
});

async function drain<T>(stream: AsyncGenerator<unknown, T>): Promise<T> {
  while (true) {
    const item = await stream.next();
    if (item.done) return item.value;
  }
}
