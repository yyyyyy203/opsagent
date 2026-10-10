import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createOfflineFetchBoundary, safeAcceptanceFailureCode } from '../apps/acceptance/memory.mjs';

const requiredChecks = [
  'captureOnce',
  'manualCaptureWithoutRecall',
  'captureRecallMatrix',
  'sourceRunUnchanged',
  'failedArchiveNeverRecalled',
  'approvedOnly',
  'scopeIsolation',
  'resumeRevalidation',
  'noRawPublicData',
  'transactionRollback',
  'staleWorkerRejected',
  'noOracleLeak',
  'disabledBaseline',
] as const;

describe('offline governed diagnostic memory acceptance', () => {
  it('reports only a safe stable code when the CLI catches an unexpected failure', () => {
    expect(safeAcceptanceFailureCode({ code: 'ERR_DLOPEN_FAILED', message: 'native ABI details' }))
      .toBe('ERR_DLOPEN_FAILED');
    expect(safeAcceptanceFailureCode({ code: 'secret=never-print-this', message: 'private detail' }))
      .toBe('MEMORY_ACCEPTANCE_INTERNAL_ERROR');
    expect(safeAcceptanceFailureCode({ code: 'AUTH_TOKEN_SECRET', message: 'private detail' }))
      .toBe('MEMORY_ACCEPTANCE_INTERNAL_ERROR');
    expect(safeAcceptanceFailureCode(new Error('private detail')))
      .toBe('MEMORY_ACCEPTANCE_INTERNAL_ERROR');
  });

  it('blocks external URLs and refuses loopback redirects before following them', async () => {
    const originalFetch = globalThis.fetch;
    const delegate = vi.fn<typeof fetch>((input, init) => originalFetch(input, init));
    const boundary = createOfflineFetchBoundary(delegate);
    await expect(boundary.fetch('https://example.invalid/outbound')).rejects.toMatchObject({
      code: 'MEMORY_ACCEPTANCE_EXTERNAL_REQUEST_FORBIDDEN',
    });
    expect(delegate).not.toHaveBeenCalled();
    expect(boundary.counts()).toEqual({ externalRequestsSent: 0, externalRequestsBlocked: 1 });

    const server = createServer((_request, response) => {
      response.writeHead(302, { location: 'https://example.invalid/redirect-target' });
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('loopback_fixture_failed');
      await expect(boundary.fetch(`http://127.0.0.1:${address.port}/redirect`)).rejects.toBeInstanceOf(TypeError);
      expect(delegate).toHaveBeenCalledTimes(1);
      expect(delegate.mock.calls[0]?.[1]?.redirect).toBe('error');
      expect(boundary.counts()).toEqual({ externalRequestsSent: 0, externalRequestsBlocked: 1 });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('runs isolated review, scoped recall, restart, revocation, and disabled-baseline checks without external requests', async () => {
    const originalFetch = globalThis.fetch;
    const localRequest = vi.fn<typeof fetch>((input, init) => originalFetch(input, init));
    const externalRequest = vi.fn<typeof fetch>(() => Promise.reject(new Error('EXTERNAL_REQUEST_FORBIDDEN')));
    const guardedRequest = vi.fn<typeof fetch>((input, init) => {
      const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      const url = new URL(rawUrl);
      const isLoopbackHttp = url.protocol === 'http:'
        && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname.toLowerCase());
      return isLoopbackHttp ? localRequest(input, init) : externalRequest(input, init);
    });
    vi.stubGlobal('fetch', guardedRequest);

    try {
      const acceptance = await import('../apps/acceptance/memory.mjs');
      const result = await acceptance.runMemoryAcceptance({ request: guardedRequest });

      expect(result.status).toBe('passed');
      expect(Object.keys(result.checks).sort()).toEqual([...requiredChecks].sort());
      expect(result.checks).toEqual(Object.fromEntries(requiredChecks.map((check) => [check, true])));
      expect(result.strategyMatrix).toHaveLength(6);
      for (const capture of ['manual', 'automatic', 'skip'] as const) {
        for (const recall of [false, true]) {
          expect(result.strategyMatrix).toContainEqual(expect.objectContaining({
            capture,
            recall,
            captureOutcome: capture === 'manual' ? 'saved_manually' : capture === 'automatic' ? 'saved_automatically' : 'not_saved',
            recalled: recall,
          }));
        }
      }
      expect(result.modelRequestsSent).toBe(0);
      expect(result.externalRequestsSent).toBe(0);
      expect(result.externalRequestsBlocked).toBe(0);
      expect(localRequest).toHaveBeenCalled();
      expect(externalRequest).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('PRIVATE_RAW');
      expect(JSON.stringify(result)).not.toContain('oracle');
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);
});
