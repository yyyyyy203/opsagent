import type { AgentEventPayloadMap, AgentEventTypeV2, AgentMessage, ChatModel, Clock, IdGenerator, ModelCallOptions, ModelResponse, ModelStreamEvent, Tool } from '../contracts/index.js';
import { TargetConfigurationError, toAgentError } from '../contracts/index.js';
import type { TargetOperationPermit } from '../contracts/target.js';
import type { EventCreationContextV2, EventFactoryV2Like, EventPublisherV2Like } from '../contracts/event-publisher.js';
import { isModelFailureCategory, ModelFailure } from './model-failure.js';

export interface EventedChatModelOptions {
  provider: string;
  model: string;
  purpose: string;
  correlationId: string | ((runId: string) => string);
  messageId?: string;
  clock?: Clock;
  ids?: IdGenerator;
}

export class EventedChatModel implements ChatModel {
  public constructor(
    private readonly delegate: ChatModel,
    private readonly publisher: EventPublisherV2Like,
    private readonly factory: EventFactoryV2Like,
    private readonly config: EventedChatModelOptions,
  ) {}

  public async *stream(
    messages: AgentMessage[], tools: Tool[], options: ModelCallOptions,
  ): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    const clock = this.config.clock ?? { now: () => new Date() };
    const ids = this.config.ids ?? { next: (prefix: string) => `${prefix}-${crypto.randomUUID()}` };
    const attemptId = ids.next('attempt');
    const messageId = this.config.messageId ?? ids.next('message');
    const blockId = ids.next('block');
    const startedAt = clock.now().getTime();
    const base = {
      runId: options.runId,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.replyId === undefined ? {} : { replyId: options.replyId }),
      ...(options.streamId === undefined ? {} : { streamId: options.streamId }),
      correlationId: typeof this.config.correlationId === 'function' ? this.config.correlationId(options.runId) : this.config.correlationId,
      stepId: options.stepId,
      attemptId,
    };
    const targetOperations = options.targetOperations;
    const permit = targetOperations === undefined ? undefined : await targetOperations.authorize({
      operation: 'model', capability: 'model', signal: options.signal,
    });
    const operationSignal = permit === undefined ? options.signal : AbortSignal.any([options.signal, permit.signal]);
    const operationOptions = operationSignal === options.signal ? options : { ...options, signal: operationSignal };
    await validatePermit(targetOperations, permit, options.signal);
    await this.publishWithPermit('MODEL_CALL_STARTED', base, {
      provider: this.config.provider, model: this.config.model, purpose: this.config.purpose, attempt: 1, inputSummary: 'model input available to internal audit only',
    }, targetOperations, permit, options.signal);
    await validatePermit(targetOperations, permit, options.signal);
    let text = '';
    let textStarted = false;
    const upstream = this.delegate.stream(messages, tools, operationOptions);
    try {
      while (true) {
        await validatePermit(targetOperations, permit, options.signal);
        const item = await upstream.next();
        await validatePermit(targetOperations, permit, options.signal);
        if (item.done) {
          if (textStarted) {
            await this.publishWithPermit('CONTENT_BLOCK_COMPLETED', base, { messageId, blockId, blockSummary: 'text output', index: 0, block: { type: 'text', blockId, text } }, targetOperations, permit, options.signal);
            await this.publishWithPermit('MESSAGE_COMPLETED', base, {
              messageId,
              completedAt: clock.now().toISOString(),
              ...(item.value.usage === undefined ? {} : { usage: item.value.usage }),
              ...(item.value.finishReason === undefined ? {} : { finishReason: item.value.finishReason }),
            }, targetOperations, permit, options.signal);
          }
          await this.publishWithPermit('MODEL_CALL_COMPLETED', base, {
            provider: this.config.provider, model: this.config.model, attempt: 1,
            ...(item.value.usage === undefined ? {} : { usage: item.value.usage }),
            ...(item.value.usage?.cachedInputTokens === undefined ? {} : { cacheHit: item.value.usage.cachedInputTokens > 0 }),
            ...(item.value.finishReason === undefined ? {} : { finishReason: item.value.finishReason }),
            durationMs: Math.max(0, clock.now().getTime() - startedAt),
          }, targetOperations, permit, options.signal);
          return item.value;
        }
        if (item.value.type === 'text_delta') {
          if (!textStarted) {
            textStarted = true;
            await this.publishWithPermit('MESSAGE_STARTED', base, { messageId, role: 'assistant', status: 'streaming' }, targetOperations, permit, options.signal);
            await this.publishWithPermit('CONTENT_BLOCK_STARTED', base, { messageId, blockId, blockType: 'text', index: 0 }, targetOperations, permit, options.signal);
          }
          text += item.value.delta;
          await this.publishWithPermit('CONTENT_BLOCK_DELTA', base, { messageId, blockId, delta: item.value.delta, index: 0, blockType: 'text' }, targetOperations, permit, options.signal);
        }
        await validatePermit(targetOperations, permit, options.signal);
        yield item.value;
      }
    } catch (error) {
      if (isTargetOperationDenied(error)) {
        await closeUpstream(upstream);
        throw error;
      }
      try {
        await validatePermit(targetOperations, permit, options.signal);
      } catch (denied) {
        await closeUpstream(upstream);
        throw denied;
      }
      await closeUpstream(upstream);
      const failure = toAgentError(error, 'MODEL_ERROR');
      const category = failure.details?.category;
      const safeError = {
        code: failure.code, message: failure.message, retryable: failure.retryable,
        ...(isModelFailureCategory(category) ? { details: { category } } : {}),
      };
      if (textStarted) {
        await this.publishWithPermit('CONTENT_BLOCK_COMPLETED', base, { messageId, blockId, blockSummary: 'partial text output' , index: 0, block: { type: 'text', blockId, text } }, targetOperations, permit, options.signal);
        await this.publishWithPermit('MESSAGE_FAILED', base, { messageId, error: safeError }, targetOperations, permit, options.signal);
      }
      await this.publishWithPermit('MODEL_CALL_FAILED', base, {
        error: safeError, attempt: 1, retryable: failure.retryable, durationMs: Math.max(0, clock.now().getTime() - startedAt),
        ...(error instanceof ModelFailure && error.usage !== undefined ? { usage: error.usage } : {}),
        ...(error instanceof ModelFailure && error.finishReason !== undefined ? { finishReason: error.finishReason } : {}),
      }, targetOperations, permit, options.signal);
      throw error;
    }
  }

  private async publishWithPermit<T extends AgentEventTypeV2>(
    type: T,
    ids: { runId: string; sessionId?: string; replyId?: string; streamId?: string; correlationId: string; stepId?: string; attemptId?: string; toolCallId?: string },
    payload: AgentEventPayloadMap[T],
    targetOperations: ModelCallOptions['targetOperations'],
    permit: TargetOperationPermit | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    await validatePermit(targetOperations, permit, signal);
    return this.publish(type, ids, payload);
  }

  private publish<T extends AgentEventTypeV2>(
    type: T,
    ids: { runId: string; sessionId?: string; replyId?: string; streamId?: string; correlationId: string; stepId?: string; attemptId?: string; toolCallId?: string },
    payload: AgentEventPayloadMap[T],
  ): Promise<unknown> {
    const context: EventCreationContextV2 = {
      runId: ids.runId, correlationId: ids.correlationId, visibility: type.startsWith('CONTENT_') || type.startsWith('MESSAGE_') ? 'public' : 'audit', durability: type === 'CONTENT_BLOCK_DELTA' ? 'transient' : 'durable',
      ...(ids.sessionId === undefined ? {} : { sessionId: ids.sessionId }),
      ...(ids.replyId === undefined ? {} : { replyId: ids.replyId }),
      ...(ids.streamId === undefined ? {} : { streamId: ids.streamId }),
      ...(ids.stepId === undefined ? {} : { stepId: ids.stepId }), ...(ids.attemptId === undefined ? {} : { attemptId: ids.attemptId }), ...(ids.toolCallId === undefined ? {} : { toolCallId: ids.toolCallId }),
    };
    const event = this.factory.create(type, context, payload);
    return this.publisher.publish(event);
  }
}

async function validatePermit(
  targetOperations: ModelCallOptions['targetOperations'],
  permit: TargetOperationPermit | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (permit !== undefined) await targetOperations!.validate(permit, signal);
}

async function closeUpstream(upstream: AsyncGenerator<ModelStreamEvent, ModelResponse>): Promise<void> {
  try {
    await upstream.return(undefined as never);
  } catch {
    // Keep the original policy or model error; closing the transport is best-effort.
  }
}

function isTargetOperationDenied(error: unknown): error is TargetConfigurationError {
  return error instanceof TargetConfigurationError && error.code === 'TARGET_OPERATION_DENIED';
}
