import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { DiagnosticMemoryRuntime, MemoryErrorCode } from '../contracts/diagnostic-memory.js';
import type { Clock } from '../contracts/common.js';
import type { VersionedCheckpointStore } from '../contracts/storage.js';
import type { InspectionQueryService } from '../contracts/read-model.js';
import { canonicalJson } from '../contracts/stable-json.js';
import { disabledMemoryCapabilities } from '../application/memory-query-service.js';

export interface MemoryRoutePorts {
  runtime?: DiagnosticMemoryRuntime;
  checkpoints?: VersionedCheckpointStore;
  runQueries?: InspectionQueryService;
  clock: Clock;
  schedule: () => Promise<void>;
}
const id = z.string().min(1).max(256).refine(value => value.trim().length > 0);
const captureBody = z.object({ requestId: id, expectedCheckpointRevision: z.number().int().positive().safe() }).strict();
const reviewBody = z.object({ profileId: id, requestId: id, expectedRevision: z.number().int().positive().safe(),
  decision: z.enum(['approved', 'rejected']), claimCheck: z.enum(['supported', 'unsupported']) }).strict();
const statuses: Readonly<Record<MemoryErrorCode, number>> = {
  MEMORY_SCOPE_INVALID: 404, MEMORY_DATA_INVALID: 400, MEMORY_REVISION_CONFLICT: 409,
  MEMORY_REQUEST_CONFLICT: 409, MEMORY_APPROVAL_DENIED: 422, MEMORY_EVIDENCE_UNAVAILABLE: 422,
  MEMORY_SOURCE_CONFLICT: 409, MEMORY_RUN_NOT_TERMINAL: 422, MEMORY_POLICY_DENIED: 400,
  MEMORY_CAPACITY_EXCEEDED: 503, MEMORY_LOOKUP_FAILED: 503, MEMORY_CAPTURE_FAILED: 503, MEMORY_DISABLED: 503,
};

/** Commands accept only untrusted preferences/IDs. Authorization is derived by the local host. */
export async function handleMemoryRoute(request: IncomingMessage, response: ServerResponse, url: URL,
  ports: MemoryRoutePorts, readBody: () => Promise<Record<string, unknown>>): Promise<boolean> {
  const method = request.method ?? 'GET';
  const runMatch = /^\/runs\/([^/]+)\/memory(\/capture)?$/u.exec(url.pathname);
  const caseMatch = /^\/memory\/cases\/([^/]+)(\/review)?$/u.exec(url.pathname);
  if (!url.pathname.startsWith('/memory/') && runMatch === null) return false;
  try {
    if (method === 'GET' && url.pathname === '/memory/capabilities') {
      queryKeys(url, ['profileId']);
      const profileId = requiredQuery(url, 'profileId');
      json(response, 200, ports.runtime?.queries.capabilities(profileId) ?? disabledMemoryCapabilities());
      return true;
    }
    const runtime = ports.runtime;
    if (runtime === undefined) throw fail('MEMORY_DISABLED', 503);
    if (method === 'GET' && url.pathname === '/memory/cases') {
      queryKeys(url, ['profileId', 'status', 'afterId', 'limit']);
      const input = z.object({ status: z.enum(['observation', 'approved', 'rejected']).optional(),
        afterId: id.optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).parse({
        ...(url.searchParams.has('status') ? { status: url.searchParams.get('status') } : {}),
        ...(url.searchParams.has('afterId') ? { afterId: url.searchParams.get('afterId') } : {}),
        ...(url.searchParams.has('limit') ? { limit: url.searchParams.get('limit') } : {}),
      });
      json(response, 200, await runtime.queries.list(requiredQuery(url, 'profileId'), {
        limit: input.limit, ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
      }));
      return true;
    }
    if (caseMatch?.[1] !== undefined) {
      const memoryId = pathId(caseMatch[1]);
      if (method === 'GET' && caseMatch[2] === undefined) {
        queryKeys(url, ['profileId']);
        const value = await runtime.queries.get(requiredQuery(url, 'profileId'), memoryId);
        if (value === null) throw fail('NOT_FOUND', 404);
        json(response, 200, value);
        return true;
      }
      if (method === 'POST' && caseMatch[2] !== undefined) {
        queryKeys(url, []);
        const body = reviewBody.parse(await readBody());
        const profile = runtime.profiles.find(p => p.scope.profileId === body.profileId);
        if (profile === undefined || !runtime.policy.allows({ schemaVersion: 1, scope: profile.scope,
          profilePolicyRevision: profile.profilePolicyRevision, capture: 'manual', recall: false }, 'capture')) throw fail('NOT_FOUND', 404);
        const now = ports.clock.now();
        const result = await runtime.reviews.review({ memoryId, scope: profile.scope, requestId: body.requestId,
          expectedRevision: body.expectedRevision, decision: body.decision, claimCheck: body.claimCheck,
          actorId: 'local-operator', reviewedAt: now.toISOString() }, { now: now.toISOString(),
          deadlineMs: now.getTime() + 5_000, clock: ports.clock });
        json(response, 200, result);
        return true;
      }
    }
    if (runMatch?.[1] !== undefined) {
      queryKeys(url, []);
      const runId = pathId(runMatch[1]);
      if (method === 'GET') {
        json(response, 200, runMatch[2] === undefined ? await runtime.queries.getRun(runId) : await runtime.queries.getCapture(runId));
        return true;
      }
      if (method === 'POST' && runMatch[2] !== undefined) {
        const body = captureBody.parse(await readBody());
        const source = await ports.checkpoints?.load(runId);
        const run = await ports.runQueries?.getRun(runId);
        if (source === undefined || source === null || run === undefined || run === null) throw fail('NOT_FOUND', 404);
        const profile = runtime.profiles.find(p => p.scope.profileId === source.context.profileId);
        if (profile === undefined) throw fail('NOT_FOUND', 404);
        const control = source.context.memoryControl;
        if (control === undefined) throw fail('MEMORY_SCOPE_INVALID', 422);
        if (canonicalJson(profile.scope) !== canonicalJson(control.scope)
          || !runtime.policy.allows(control, 'capture')) throw fail('NOT_FOUND', 404);
        if (run.parentRunId !== undefined) throw fail('MEMORY_POLICY_DENIED', 422);
        const previous = await runtime.queries.getCapture(runId);
        const now = ports.clock.now();
        const ticket = await runtime.capture.capture({ sourceRunId: runId, scope: control.scope,
          requestId: body.requestId, expectedCheckpointRevision: body.expectedCheckpointRevision,
          actorId: 'local-operator', requestedAt: now.toISOString() }, { now: now.toISOString(),
          deadlineMs: now.getTime() + 5_000, clock: ports.clock });
        // A persistent enqueue is followed by one explicit bounded host drain, never a new Run.
        await ports.schedule();
        json(response, previous.state === 'not_saved' && ticket.state === 'queued' ? 202 : 200, ticket);
        return true;
      }
    }
    throw fail('NOT_FOUND', 404);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof URIError) throw fail('MEMORY_DATA_INVALID', 400);
    if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      && Object.hasOwn(statuses, error.code) && !('statusCode' in error)) {
      throw fail(error.code, statuses[error.code as MemoryErrorCode]);
    }
    throw error;
  }
}

function queryKeys(url: URL, allowed: readonly string[]): void {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw fail('MEMORY_DATA_INVALID', 400);
  }
}
function requiredQuery(url: URL, key: string): string { return id.parse(url.searchParams.get(key)); }
function pathId(value: string): string { return id.parse(decodeURIComponent(value)); }
function fail(code: string, statusCode: number): Error { return Object.assign(new Error('Memory request cannot be completed.'), { code, statusCode }); }
function json(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}
