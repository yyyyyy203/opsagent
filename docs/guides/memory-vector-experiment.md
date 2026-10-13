# Memory Vector Experiment (V3)

V3 is an offline shadow experiment for reviewed episodic memory. It does not change the normal memory recall path, case capture/review, or Harness behavior. The experiment is opt-in and uses its own temporary SQLite vector database; it never opens the acceptance or production memory database.

## Local pack

The pack is strict JSON with this shape:

```json
{
  "schemaVersion": 1,
  "space": {
    "provider": "local-provider",
    "model": "model-name",
    "revision": "immutable-model-revision",
    "dimensions": 384,
    "normalization": "l2",
    "metric": "cosine"
  },
  "provenance": "real",
  "generatorRevision": "source-revision-or-reviewed-generator-id",
  "corpusDigest": "64 lowercase hex characters",
  "querySetDigest": "64 lowercase hex characters",
  "entries": [
    { "textDigest": "64 lowercase hex characters", "vector": [0.1, 0.2] }
  ]
}
```

The vector length must equal `space.dimensions` (2–4096), and each vector must be finite and non-zero. Text digests are SHA-256 over the V1 normalization (Unicode NFKC, CRLF to LF, trim); vectors are normalized to L2 when loaded. The pack is bounded to 32 MiB and 2,000 unique text digests. It stores hashes and vectors, not source text. The acceptance runner binds it to the fixed corpus and holdout query-set digests; changed text, labels, provider/model/revision, dimensions, normalization, or metric requires a matching pack.

Generate packs only through a separately reviewed local process. This repository does not download a model, make embedding/API requests, or generate synthetic packs automatically. A `provenance: "real"` string by itself is not source evidence. Before marking a real pack verified, inspect the generator implementation and its revision, inspect the pack source, compute its SHA-256, then pass that exact digest in `AGENTOPS_MEMORY_EMBEDDING_REVIEWED_SHA256`. The runner verifies the attestation against the bytes actually loaded and rejects generator revisions labeled as synthetic, fixture, or test. Never place credentials or raw case/query text in the pack.

## Run

PowerShell example:

```powershell
$env:AGENTOPS_MEMORY_VECTOR_EXPERIMENT = '1'
$env:AGENTOPS_MEMORY_EMBEDDING_PACK = 'D:\local-data\reviewed-memory-vectors.json'
# Set only after source review; the value must match the pack's SHA-256 exactly.
$env:AGENTOPS_MEMORY_EMBEDDING_REVIEWED_SHA256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $env:AGENTOPS_MEMORY_EMBEDDING_PACK).Hash.ToLowerInvariant()
pnpm acceptance:memory-vector
```

The reviewed-hash variable is an operator attestation, not a signature or automated proof of generator provenance. Leave it unset until the source review is complete. The CLI accepts only an absolute local pack path. The report omits the path, raw texts, vectors, and credentials.

Exit codes:

- `0`: a source-reviewed real pack was hash-attested and all 12 holdouts completed all three modes without vector fallback. This verifies the experiment run, not diagnostic correctness or production readiness.
- `1`: explicit opt-in is missing (`VECTOR_EXPERIMENT_NOT_ENABLED`).
- `2`: pack missing/invalid/mismatched, synthetic or unreviewed pack, vector/BM25 failure, or another acceptance check failed. A valid synthetic pack may report `mechanism_verified`; it always reports `realEmbedding: not_provided` and exits `2`.

The fixed holdout includes Chinese, English, synonym, near-neighbor, foreign-dataset, and no-match queries. Relevance labels remain separate from indexed case text and are used only to calculate hit@5, MRR@5, nDCG@5, and empty-recall counts. The report also includes p50/p95 elapsed time, peak observed RSS, and index bytes. These are local observations, not performance guarantees or evidence of semantic improvement.

## Scope and rebuilds

Only reviewed, sufficient, completed, unexpired episodic cases in the requested simulated scope are eligible. Caller-supplied run exclusions apply to both index build and retrieval. Indexing embeds and upserts at most 16 documents per batch; it completes all embedding batches before starting bounded atomic SQLite upserts, so an embedding failure cannot leave partial writes. The acceptance CLI uses a fresh temporary database and discards it when a run fails. Every result is revalidated against the memory store and its evidence references before it can be returned. On pack/space/index failures, the shadow retriever tries the same-scope, same-exclusion BM25 path; abort propagates, and an expired deadline never starts fallback. If BM25 or result revalidation is unavailable, the call fails with the fixed `MEMORY_LOOKUP_FAILED` error rather than presenting corruption as ordinary empty recall or claiming recovery. Concrete SQLite and in-memory stores provide the T5 FTS5/BM25 implementation; the abstract core's fail-closed empty default is not a BM25 adapter.

A provider/model/revision/dimension/metric change creates a new space key; use a fresh dedicated experiment database for a clean rebuild or a materially changed corpus. The vector index is derived data and current eligibility checks prevent stale or revoked rows from escaping, but old rows may remain in the database and count toward its bounded capacity. Do not reuse the application's memory database.

When the experiment is disabled, base memory case saving, review, and ordinary BM25 retrieval continue unchanged. V3 does not enable vector recall by default and does not integrate into production or the Harness.
