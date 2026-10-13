import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { SemanticKnowledgeRevision, TargetKnowledgePublication } from '../src/contracts/knowledge-memory.js';
import { KnowledgeContractError } from '../src/contracts/knowledge-memory.js';
import type { TargetKnowledgePolicy } from '../src/contracts/target.js';
import { startInspectionHttpServer } from '../src/api/http-server.js';
import type { KnowledgeManagementApi } from '../src/api/knowledge-memory-routes.js';

const digest = 'a'.repeat(64);
const scope = { targetId: 'target-a', projectId: 'project-a', deploymentId: 'deploy-a', deploymentGeneration: 1,
  targetFingerprint: 'private-fingerprint', profileId: 'profile-a', profileRevision: 'profile-r1',
  scenarioId: 'settlement', scenarioVersion: '1', serviceIds: ['checkout'], faultTypes: ['settlement_failure'],
  environment: 'simulation' as const, dataClass: 'simulated' as const, datasetId: 'data-a' };
const content = { type: 'domain_glossary' as const, terms: [{ term: 'settlement', definition: 'A completed settlement.',
  sourceReference: { sourceId: 'profile-source', sourceVersion: 'source-v1', digest } }] };
const revision: SemanticKnowledgeRevision = { schemaVersion: 1, id: 'knowledge-a', kind: 'semantic', contentRevision: 1,
  governanceVersion: 1, sourceEpoch: 0, status: 'draft', createdAt: '2026-10-12T00:00:00.000Z', scope,
  provenance: { sourceType: 'operator_provided', sourceId: 'profile-source', sourceVersion: 'source-v1',
    sourceDigest: digest, importedAt: '2026-10-12T00:00:00.000Z' }, contentDigest: digest, content };
const policy: TargetKnowledgePolicy = { schemaVersion: 1, targetId: 'target-a', policyVersion: 'policy-v1', policyEpoch: 1,
  defaultRequiredness: 'optional', requirements: [] };

interface LocalResponse { status: number; json(): Promise<unknown> }
function requestJson(url: string, method = 'GET', body?: unknown): Promise<LocalResponse> {
  const bodyText = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(new URL(url), { method, headers: bodyText === undefined ? {} : {
      'content-type': 'application/json', 'content-length': String(Buffer.byteLength(bodyText)),
    } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, json: async () => JSON.parse(text) as unknown }));
      response.on('error', reject);
    });
    req.on('error', reject);
    if (bodyText !== undefined) req.write(bodyText);
    req.end();
  });
}

describe('Target-scoped governed knowledge API', () => {
  const servers: Array<{ close(): Promise<void>; url: string }> = [];
  afterEach(async () => { for (const server of servers.splice(0).reverse()) await server.close(); });

  function fixture() {
    let current: SemanticKnowledgeRevision = structuredClone(revision);
    let publication: TargetKnowledgePublication | null = null;
    let reviewCalls = 0;
    let createCalls = 0;
    const api: KnowledgeManagementApi = {
      list: async input => {
        if (input.targetId === 'target-missing') throw Object.assign(new Error('missing'), { code: 'TARGET_NOT_FOUND' });
        if (input.targetId !== scope.targetId) throw new KnowledgeContractError('KNOWLEDGE_SCOPE_INVALID');
        return [structuredClone(current)];
      },
      targetStatus: async targetId => {
        if (targetId === 'target-missing') throw Object.assign(new Error('missing'), { code: 'TARGET_NOT_FOUND' });
        if (targetId !== scope.targetId) throw new KnowledgeContractError('KNOWLEDGE_SCOPE_INVALID');
        return { targetId, capabilities: { semanticEnabled: true, proceduralEnabled: true }, requiredKnowledge: [],
          publicationVersion: publication?.publicationVersion ?? 0, publicationState: publication === null ? 'empty' : 'active',
          references: publication?.references ?? [] };
      },
      createSemanticDraft: async (_targetId, input) => { createCalls += 1; return { ...revision, ...input }; },
      reviseSemanticDraft: async () => current,
      createProceduralDraft: async () => { throw new Error('unexpected'); },
      reviseProceduralDraft: async () => { throw new Error('unexpected'); },
      submitForReview: async () => current,
      review: async (_targetId, _kind, input) => {
        reviewCalls += 1;
        current = { ...current, status: input.decision === 'approve' ? 'approved' : 'rejected', governanceVersion: 2 };
        return current;
      },
      revoke: async () => { current = { ...current, status: 'revoked', governanceVersion: current.governanceVersion + 1 }; return current; },
      publish: async (targetId, input) => {
        publication = { targetId, publicationVersion: (publication?.publicationVersion ?? 0) + 1,
          references: input.references, policy, publishedAt: '2026-10-12T00:01:00.000Z' };
        return publication;
      },
    };
    const serverPromise = startInspectionHttpServer({ agent: {} as never, events: {} as never, knowledgeManagement: api });
    return { serverPromise, reviewCalls: () => reviewCalls, createCalls: () => createCalls };
  }

  it('lists bounded exact-scope revisions and omits private scope and reviewer fields', async () => {
    const f = fixture();
    const server = await f.serverPromise; servers.push(server);
    const response = await requestJson(`${server.url}/targets/target-a/knowledge?kind=semantic&limit=10`);
    expect(response.status).toBe(200);
    const body = JSON.stringify(await response.json());
    expect(body).toContain('profile-source');
    expect(body).toContain('profile-r1');
    expect(body).not.toContain('private-fingerprint');
    expect(body).not.toContain('project-a');
    expect(body).not.toContain('reviewerId');
  });

  it.each(['scope', 'actorId', 'status', 'reviewerId', 'approvedBy', 'absolutePath', 'url'])(
    'rejects caller-forged %s in draft request before invoking the service', async field => {
      const f = fixture();
      const server = await f.serverPromise; servers.push(server);
      const response = await requestJson(`${server.url}/targets/target-a/knowledge/semantic/drafts`, 'POST', {
        requestId: 'create-1', source: { sourceId: 'profile-source', sourceVersion: 'source-v1', digest }, content,
        [field]: 'forged',
      });
      expect(response.status).toBe(400);
      expect(f.createCalls()).toBe(0);
    });

  it('normalizes missing and out-of-scope Target queries to indistinguishable 404 responses', async () => {
    const f = fixture();
    const server = await f.serverPromise; servers.push(server);
    const missing = await requestJson(`${server.url}/targets/target-missing/knowledge?kind=semantic`);
    const outside = await requestJson(`${server.url}/targets/other-target/knowledge?kind=semantic`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(await outside.json());
  });

  it('keeps approval separate from publication; an explicit CAS publish is required to bind a revision', async () => {
    const f = fixture();
    const server = await f.serverPromise; servers.push(server);
    const review = await requestJson(`${server.url}/targets/target-a/knowledge/semantic/knowledge-a/review`, 'POST', {
      requestId: 'review-1', contentRevision: 1, governanceVersion: 1, decision: 'approve',
    });
    expect(review.status).toBe(200);
    expect(f.reviewCalls()).toBe(1);
    const before = await requestJson(`${server.url}/targets/target-a/knowledge/status`);
    expect(await before.json()).toMatchObject({ publicationState: 'empty', publicationVersion: 0, references: [] });
    const published = await requestJson(`${server.url}/targets/target-a/knowledge/publication`, 'POST', {
      requestId: 'publish-1', expectedPublicationVersion: 0,
      references: [{ id: 'knowledge-a', version: '1', digest, approval: 'approved' }],
    });
    expect(published.status).toBe(200);
    const after = await requestJson(`${server.url}/targets/target-a/knowledge/status`);
    expect(await after.json()).toMatchObject({ publicationState: 'active', publicationVersion: 1,
      references: [{ id: 'knowledge-a', version: '1', approval: 'approved' }] });
  });

  it('rejects unknown and duplicate query parameters and does not accept a Target scope in the body', async () => {
    const f = fixture();
    const server = await f.serverPromise; servers.push(server);
    expect((await requestJson(`${server.url}/targets/target-a/knowledge?kind=semantic&scope=forged`)).status).toBe(400);
    expect((await requestJson(`${server.url}/targets/target-a/knowledge?kind=semantic&kind=procedural`)).status).toBe(400);
    expect((await requestJson(`${server.url}/targets/target-a/knowledge/publication`, 'POST', {
      requestId: 'publish-1', targetId: 'other-target', expectedPublicationVersion: 0, references: [],
    })).status).toBe(400);
  });
});
