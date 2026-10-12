import { describe, expect, it } from 'vitest';
import { KnowledgeContractError } from '../src/contracts/knowledge-memory.js';
import { SemanticSourceRegistry } from '../src/memory/semantic-source-registry.js';

const source = {
  sourceType: 'controlled_runbook',
  sourceId: 'settlement-runbook',
  sourceVersion: 'runbook/v1',
  sourceDigest: 'a'.repeat(64),
  dataDomainId: 'market-a-knowledge',
  allowedTargetIds: ['market-a-sim'],
} as const;

describe('SemanticSourceRegistry', () => {
  it.each(['target_profile', 'controlled_runbook', 'operator_provided'] as const)('admits host-owned %s sources', sourceType => {
    const registry = new SemanticSourceRegistry({ schemaVersion: 1, sources: [{ ...source, sourceType }] });
    expect(registry.resolve({ targetId: 'market-a-sim', reference: {
      sourceId: source.sourceId, sourceVersion: source.sourceVersion, digest: source.sourceDigest,
    } }).sourceType).toBe(sourceType);
  });

  it.each(['https://untrusted.invalid/source', 'C:/untrusted.md', '../runbook', 'Bearer test-secret'])(
    'rejects an arbitrary or secret-like source identity: %s', sourceId => {
      const registry = new SemanticSourceRegistry({ schemaVersion: 1, sources: [source] });
      expect(() => registry.resolve({ targetId: 'market-a-sim', reference: {
        sourceId, sourceVersion: source.sourceVersion, digest: source.sourceDigest,
      } })).toThrowError(new KnowledgeContractError('KNOWLEDGE_RECORD_INVALID'));
    });

  it.each([
    { ...source, sourceType: 'model_output' },
    { ...source, allowedTargetIds: ['market-a-sim', 'market-a-sim'] },
    { ...source, sourceDigest: 'invalid' },
    { ...source, dataDomainId: 'C:/caller-path' },
  ])('rejects malformed host manifest entries', entry => {
    expect(() => new SemanticSourceRegistry({ schemaVersion: 1, sources: [entry] }))
      .toThrowError(new KnowledgeContractError('KNOWLEDGE_RECORD_INVALID'));
  });
  it('resolves only an exact host-allowlisted source reference for its Target', () => {
    const registry = new SemanticSourceRegistry({ schemaVersion: 1, sources: [source] });

    expect(registry.resolve({ targetId: 'market-a-sim', reference: {
      sourceId: source.sourceId, sourceVersion: source.sourceVersion, digest: source.sourceDigest,
    } })).toEqual(source);
  });

  it('rejects unknown source identities and digest/version substitutions with stable errors', () => {
    const registry = new SemanticSourceRegistry({ schemaVersion: 1, sources: [source] });

    expect(() => registry.resolve({ targetId: 'market-a-sim', reference: {
      sourceId: 'unlisted-source', sourceVersion: source.sourceVersion, digest: source.sourceDigest,
    } })).toThrowError(new KnowledgeContractError('KNOWLEDGE_NOT_FOUND'));
    expect(() => registry.resolve({ targetId: 'market-a-sim', reference: {
      sourceId: source.sourceId, sourceVersion: source.sourceVersion, digest: 'b'.repeat(64),
    } })).toThrowError(new KnowledgeContractError('KNOWLEDGE_DIGEST_MISMATCH'));
    expect(() => registry.resolve({ targetId: 'market-a-sim', reference: {
      sourceId: source.sourceId, sourceVersion: 'runbook/v2', digest: source.sourceDigest,
    } })).toThrowError(new KnowledgeContractError('KNOWLEDGE_DIGEST_MISMATCH'));
  });

  it('does not implicitly share a source with a Target outside its host allowlist', () => {
    const registry = new SemanticSourceRegistry({ schemaVersion: 1, sources: [source] });

    expect(() => registry.resolve({ targetId: 'market-b-sim', reference: {
      sourceId: source.sourceId, sourceVersion: source.sourceVersion, digest: source.sourceDigest,
    } })).toThrowError(new KnowledgeContractError('KNOWLEDGE_SCOPE_INVALID'));
  });

  it('rejects duplicate manifest identities and non-manifest URL/path fields', () => {
    expect(() => new SemanticSourceRegistry({ schemaVersion: 1, sources: [source, source] }))
      .toThrowError(new KnowledgeContractError('KNOWLEDGE_RECORD_INVALID'));
    expect(() => new SemanticSourceRegistry({ schemaVersion: 1, sources: [{
      ...source, url: 'https://untrusted.invalid/runbook', path: 'C:/untrusted.md',
    }] })).toThrowError(new KnowledgeContractError('KNOWLEDGE_RECORD_INVALID'));
  });
});
