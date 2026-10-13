import { describe, expect, it } from 'vitest';
import { TargetConfigurationError } from '../src/contracts/index.js';
import type { AgentMessage, Clock, IdGenerator, ModelResponse, TargetOperationGuard, TargetOperationPermit, Tool } from '../src/contracts/index.js';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import { EventedChatModel } from '../src/model/evented-model.js';
import type { EventPublisherV2 } from '../src/event/v2/event-publisher.js';

const clock: Clock = { now: () => new Date('2026-09-08T00:00:00.000Z') };
const ids: IdGenerator = { next: (prefix) => `${prefix}-1` };
const messages: AgentMessage[] = [{ id: 'msg-0', role: 'user', createdAt: clock.now().toISOString(), blocks: [{ type: 'text', text: 'check' }] }];
const tools: Tool[] = [];

async function collect(model: EventedChatModel): Promise<void> {
  const stream = model.stream(messages, tools, { signal: new AbortController().signal, runId: 'run-1', stepId: 'step-1' });
  while (true) { const item = await stream.next(); if (item.done) return; }
}

describe('EventedChatModel', () => {
  it('publishes model lifecycle and text block events while preserving ModelResponse', async () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    const publisher = { publish: (event: { type: string; payload: unknown }) => { events.push(event); return Promise.resolve(event); } } as unknown as EventPublisherV2;
    const base = {
      async *stream(): AsyncGenerator<{ type: 'text_delta'; delta: string }, ModelResponse> {
        await Promise.resolve();
        yield { type: 'text_delta', delta: 'hi' };
        return { text: 'hi', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 1, cachedInputTokens: 1 } };
      },
    };
    const model = new EventedChatModel(base, publisher, new EventFactoryV2(clock, ids), {
      provider: 'openai-compatible', model: 'deepseek-chat', purpose: 'diagnosis', correlationId: 'corr-1', messageId: 'msg-1',
    });
    await collect(model);
    expect(events.map((event) => event.type)).toEqual([
      'MODEL_CALL_STARTED', 'MESSAGE_STARTED', 'CONTENT_BLOCK_STARTED', 'CONTENT_BLOCK_DELTA',
      'CONTENT_BLOCK_COMPLETED', 'MESSAGE_COMPLETED', 'MODEL_CALL_COMPLETED',
    ]);
    const messageCompleted = events.find((event) => event.type === 'MESSAGE_COMPLETED')?.payload as { finishReason?: string };
    const completed = events.at(-1)?.payload as { usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }; durationMs?: unknown; finishReason?: string; cacheHit?: boolean };
    expect(messageCompleted.finishReason).toBe('stop');
    expect(completed.usage).toEqual({ inputTokens: 2, outputTokens: 1, cachedInputTokens: 1 });
    expect(completed.finishReason).toBe('stop');
    expect(completed.cacheHit).toBe(true);
    expect(typeof completed.durationMs).toBe('number');
  });

  it('does not publish streamed model content after its Target permit is revoked', async () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    const publisher = { publish: (event: { type: string; payload: unknown }) => { events.push(event); return Promise.resolve(event); } } as unknown as EventPublisherV2;
    const permitController = new AbortController();
    const permit: TargetOperationPermit = {
      bindingId: 'binding-1', runId: 'run-1', rootRunId: 'run-1', snapshotDigest: 'snapshot-1',
      operation: 'model', capability: 'model', policyEpoch: 1, signal: permitController.signal,
    };
    let validations = 0;
    const targetOperations: TargetOperationGuard = {
      authorize: async () => permit,
      validate: async () => {
        validations += 1;
        if (validations > 3) throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
      },
    };
    const base = {
      async *stream(): AsyncGenerator<{ type: 'text_delta'; delta: string }, ModelResponse> {
        yield { type: 'text_delta', delta: 'private output' };
        return { text: 'private output', toolCalls: [], finishReason: 'stop' };
      },
    };
    const model = new EventedChatModel(base, publisher, new EventFactoryV2(clock, ids), {
      provider: 'openai-compatible', model: 'deepseek-chat', purpose: 'diagnosis', correlationId: 'corr-1',
    });
    const stream = model.stream(messages, tools, {
      signal: new AbortController().signal, runId: 'run-1', stepId: 'step-1', targetOperations,
    });

    await expect(stream.next()).rejects.toMatchObject({ code: 'TARGET_OPERATION_DENIED' });
    expect(events.map(event => event.type)).not.toContain('CONTENT_BLOCK_DELTA');
    expect(events.map(event => event.type)).not.toContain('MESSAGE_STARTED');
    expect(events.map(event => event.type)).not.toContain('MODEL_CALL_COMPLETED');
  });
});
