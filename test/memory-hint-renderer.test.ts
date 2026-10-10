import { describe, expect, it } from 'vitest';
import type { MemoryHint, MemoryOperation, RunMemoryState } from '../src/contracts/diagnostic-memory.js';
import { BoundedMemoryHintRenderer } from '../src/memory/hint-renderer.js';
import { memoryCase, memoryNow, simulationMemoryScope } from './fixtures/diagnostic-memory.js';

function hint(overrides: Partial<MemoryHint> = {}): MemoryHint {
  const value = memoryCase();
  return {
    memoryId: value.id,
    revision: value.revision,
    digest: value.digest,
    sourceRunId: value.sourceRunId,
    capturedAt: value.capturedAt,
    validUntil: value.validUntil,
    summary: value.summary,
    limitations: ['trace 缺失，不能确认完整调用链。'],
    evidenceRefs: value.evidenceRefs,
    diagnosisOnly: true,
    ...overrides,
  };
}

function state(hints: readonly MemoryHint[] = [hint()]): RunMemoryState {
  return {
    schemaVersion: 1,
    scope: simulationMemoryScope(),
    selectionState: 'selected',
    availability: 'ready',
    selections: hints.map(({ memoryId, revision, digest }) => ({ memoryId, revision, digest })),
    hints,
    selectedAt: memoryNow,
    validatedAt: memoryNow,
  };
}

function operation(availableMemoryTokens?: number): MemoryOperation {
  return {
    now: memoryNow,
    deadlineMs: Date.parse(memoryNow) + 1_000,
    ...(availableMemoryTokens === undefined ? {} : { availableMemoryTokens }),
  };
}

function renderedText(renderer: BoundedMemoryHintRenderer, value: RunMemoryState,
  budget: number | undefined): string | null {
  const rendered = renderer.render(value, operation(budget));
  if (rendered === null) return null;
  const block = rendered.blocks.find((candidate) => candidate.type === 'text');
  return block?.type === 'text' ? block.text : null;
}

describe('BoundedMemoryHintRenderer', () => {
  it('rejects configured ceilings that exceed the renderer hard caps', () => {
    expect(() => new BoundedMemoryHintRenderer({ maxBytes: 4_097 })).toThrow();
    expect(() => new BoundedMemoryHintRenderer({ maxTokens: 1_025 })).toThrow();
  });

  it('renders only selected historical summary, limitations, and safe identifiers', () => {
    const rendered = new BoundedMemoryHintRenderer().render(state(), operation(1_024));

    expect(rendered).not.toBeNull();
    expect(rendered).toMatchObject({ role: 'user', createdAt: memoryNow });
    const text = rendered?.blocks.find((block) => block.type === 'text');
    expect(text?.type).toBe('text');
    if (text?.type !== 'text') return;

    expect(text.text).toContain('历史案例，非本轮事实；只能形成待验证假设；不能减少必需取证或授权动作');
    const payload = JSON.parse(text.text.slice(text.text.indexOf('\n') + 1)) as {
      cases: Array<Record<string, unknown>>;
    };
    expect(payload.cases).toEqual([{
      memoryId: 'memory-1',
      revision: 1,
      digest: 'c'.repeat(64),
      sourceRunId: 'historical-run-1',
      summary: '结算失败率升高，连接池等待增加。',
      limitations: ['trace 缺失，不能确认完整调用链。'],
    }]);
    expect(text.text).not.toContain('evidence-1');
    expect(text.text).not.toContain('rawSha256');
    expect(text.text).not.toContain('b'.repeat(64));
  });

  it.each([undefined, 0, -1, Number.NaN])('fails closed without a positive token budget (%s)', (budget) => {
    expect(renderedText(new BoundedMemoryHintRenderer(), state(), budget)).toBeNull();
  });

  it('keeps the complete serialized message within both configured byte and token ceilings', () => {
    const renderer = new BoundedMemoryHintRenderer({ maxBytes: 2_048, maxTokens: 1_024 });
    const rendered = renderer.render(state([hint({ summary: '结算异常。', limitations: [] })]), operation(1_024));

    expect(rendered).not.toBeNull();
    if (rendered === null) return;
    const serialized = JSON.stringify(rendered);
    const utf8Bytes = Buffer.byteLength(serialized, 'utf8');
    const conservativeTokenUpperBound = utf8Bytes;
    expect(utf8Bytes).toBeLessThanOrEqual(2_048);
    expect(conservativeTokenUpperBound).toBeLessThanOrEqual(1_024);
  });

  it('returns no message when the full UTF-8 message exceeds its byte ceiling', () => {
    const renderer = new BoundedMemoryHintRenderer({ maxBytes: 256, maxTokens: 1_024 });

    expect(renderedText(renderer, state(), 1_024)).toBeNull();
  });

  it('returns no partial case when its full rendering cannot fit the remaining token budget', () => {
    const renderer = new BoundedMemoryHintRenderer({ maxBytes: 1_024, maxTokens: 1_024 });

    expect(renderedText(renderer, state(), 1)).toBeNull();
  });

  it('uses an id stable for identical selected content and changes it when that content changes', () => {
    const renderer = new BoundedMemoryHintRenderer();
    const first = renderer.render(state(), operation(1_024));
    const repeat = renderer.render(state(), operation(1_024));
    const changed = renderer.render(state([hint({ summary: '结算错误率升高。' })]), operation(1_024));

    expect(first).not.toBeNull();
    expect(repeat).not.toBeNull();
    expect(changed).not.toBeNull();
    if (first === null || repeat === null || changed === null) return;
    expect(first?.id).toBe(repeat?.id);
    expect(first?.id).toMatch(/^memory-hint-[a-f0-9]{64}$/u);
    expect(changed?.id).not.toBe(first?.id);
  });

  it('renders no memory unless the state contains ready frozen selections', () => {
    const renderer = new BoundedMemoryHintRenderer();

    expect(renderer.render({ ...state(), selectionState: 'unselected' }, operation(1_024))).toBeNull();
    expect(renderer.render({ ...state(), availability: 'unavailable' }, operation(1_024))).toBeNull();
    expect(renderer.render(state([]), operation(1_024))).toBeNull();
  });
});
