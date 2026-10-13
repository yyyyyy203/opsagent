import { describe, expect, it } from 'vitest';
import { ApiClient } from '../apps/agent-web/src/api/client.js';

describe('browser API client', () => {
  it('uses the public HTTP contract and asks SSE for notification-only frames', async () => {
    const requests: Request[] = [];
    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:4100/',
      fetchImpl: (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      },
      eventSourceFactory: () => ({ close: () => undefined }),
    });

    await client.getMessages('run/1', { limit: 20 });
    const events = client.openRunEvents('run/1', 'event-7', () => undefined);
    events.close();

    expect(requests[0]?.url).toBe('http://127.0.0.1:4100/runs/run%2F1/messages?limit=20');
    expect(requests[0]?.method).toBe('GET');
    expect(client.lastEventSourceUrl).toBe('http://127.0.0.1:4100/runs/run%2F1/events?snapshots=none&lastEventId=event-7');
  });

  it('surfaces a conflict without retrying a confirmation command', async () => {
    let calls = 0;
    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:4100',
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(new Response(JSON.stringify({ error: 'REVISION_CONFLICT', message: 'stale confirmation' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }));
      },
      eventSourceFactory: () => ({ close: () => undefined }),
    });

    await expect(client.decideConfirmation('run-1', {
      toolCallId: 'tool-1', confirmed: true, expectedRevision: 3,
    })).rejects.toEqual(expect.objectContaining({ code: 'REVISION_CONFLICT', status: 409 }));
    expect(calls).toBe(1);
  });

  it('posts cancellation to the encoded Run endpoint without a body', async () => {
    let captured: Request | undefined;
    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:4100',
      fetchImpl: (input, init) => {
        captured = new Request(input, init);
        return Promise.resolve(new Response(JSON.stringify({ runId: 'run/1', status: 'cancelling' }), { status: 202 }));
      },
      eventSourceFactory: () => ({ close: () => undefined }),
    });

    await expect(client.cancelRun('run/1')).resolves.toEqual({ runId: 'run/1', status: 'cancelling' });
    expect(captured?.url).toBe('http://127.0.0.1:4100/runs/run%2F1/cancel');
    expect(captured?.method).toBe('POST');
    expect(captured?.body).toBeNull();
  });

  it('binds the default browser fetch to the global object', async () => {
    const originalFetch = globalThis.fetch;
    let invokedWithGlobal = false;
    globalThis.fetch = function (this: unknown): Promise<Response> {
      if (this !== globalThis) return Promise.reject(new Error('fetch receiver was not globalThis'));
      invokedWithGlobal = true;
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    };
    try {
      await new ApiClient({ baseUrl: 'http://127.0.0.1:4100' }).listProfiles();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(invokedWithGlobal).toBe(true);
  });

  it('uses the governed memory endpoints and sends only the documented command fields', async () => {
    const requests: Request[] = [];
    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:4100',
      fetchImpl: (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(new Response(JSON.stringify({ enabled: true }), { status: 200 }));
      },
      eventSourceFactory: () => ({ close: () => undefined }),
    });

    await client.memoryCapabilities('simulation');
    await client.listMemoryCases('simulation', { status: 'observation', afterId: 'case/1', limit: 20 });
    await client.getRunMemory('run/1');
    await client.getRunMemoryCapture('run/1');
    await client.captureRunMemory('run/1', { requestId: 'capture-1', expectedCheckpointRevision: 4 });
    await client.reviewMemory('case/1', {
      profileId: 'simulation', requestId: 'review-1', expectedRevision: 2,
      decision: 'approved', claimCheck: 'supported',
    });

    expect(requests.map(({ url, method }) => [url, method])).toEqual([
      ['http://127.0.0.1:4100/memory/capabilities?profileId=simulation', 'GET'],
      ['http://127.0.0.1:4100/memory/cases?profileId=simulation&limit=20&status=observation&afterId=case%2F1', 'GET'],
      ['http://127.0.0.1:4100/runs/run%2F1/memory', 'GET'],
      ['http://127.0.0.1:4100/runs/run%2F1/memory/capture', 'GET'],
      ['http://127.0.0.1:4100/runs/run%2F1/memory/capture', 'POST'],
      ['http://127.0.0.1:4100/memory/cases/case%2F1/review', 'POST'],
    ]);
    expect(await requests[4]?.clone().json()).toEqual({ requestId: 'capture-1', expectedCheckpointRevision: 4 });
    expect(await requests[5]?.clone().json()).toEqual({ profileId: 'simulation', requestId: 'review-1',
      expectedRevision: 2, decision: 'approved', claimCheck: 'supported' });
  });

  it('uses safe Target catalog and knowledge endpoints without caller-owned scope or actor fields', async () => {
    const requests: Request[] = [];
    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:4100',
      fetchImpl: (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      },
      eventSourceFactory: () => ({ close: () => undefined }),
    });

    await client.listTargets();
    await client.getTargetReadiness('target/a');
    await client.getTargetKnowledgeStatus('target/a');
    await client.listTargetKnowledge('target/a', 'semantic', { status: 'approved', limit: 10 });
    await client.reviewTargetKnowledge('target/a', 'semantic', 'knowledge/a', {
      requestId: 'review-1', contentRevision: 2, governanceVersion: 3, decision: 'approve',
    });
    await client.publishTargetKnowledge('target/a', {
      requestId: 'publish-1', expectedPublicationVersion: 4,
      references: [{ id: 'knowledge/a', version: '2', digest: 'a'.repeat(64), approval: 'approved' }],
    });

    expect(requests.map(({ url, method }) => [url, method])).toEqual([
      ['http://127.0.0.1:4100/targets', 'GET'],
      ['http://127.0.0.1:4100/targets/target%2Fa/readiness', 'GET'],
      ['http://127.0.0.1:4100/targets/target%2Fa/knowledge/status', 'GET'],
      ['http://127.0.0.1:4100/targets/target%2Fa/knowledge?kind=semantic&status=approved&limit=10', 'GET'],
      ['http://127.0.0.1:4100/targets/target%2Fa/knowledge/semantic/knowledge%2Fa/review', 'POST'],
      ['http://127.0.0.1:4100/targets/target%2Fa/knowledge/publication', 'POST'],
    ]);
    expect(await requests[4]?.clone().json()).toEqual({ requestId: 'review-1', contentRevision: 2,
      governanceVersion: 3, decision: 'approve' });
    expect(JSON.stringify(await requests[5]?.clone().json())).not.toMatch(/scope|actor|reviewer|profile|threshold|endpoint/iu);
  });

  it('surfaces memory revision conflicts without retrying a capture or review command', async () => {
    let calls = 0;
    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:4100',
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(new Response(JSON.stringify({ error: 'MEMORY_REVISION_CONFLICT', message: 'stale' }), { status: 409 }));
      },
      eventSourceFactory: () => ({ close: () => undefined }),
    });

    await expect(client.reviewMemory('case-1', { profileId: 'simulation', requestId: 'review-1',
      expectedRevision: 1, decision: 'approved', claimCheck: 'supported' }))
      .rejects.toEqual(expect.objectContaining({ code: 'MEMORY_REVISION_CONFLICT', status: 409 }));
    expect(calls).toBe(1);
  });
});
