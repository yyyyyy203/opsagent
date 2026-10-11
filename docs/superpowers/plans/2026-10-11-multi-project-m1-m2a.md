# Multi-project M1 + M2a Implementation Plan

> **For agentic workers:** Implement sequentially with test-first development. Complete and verify M1 before beginning M2a. Keep the existing legacy profile/run endpoints and checkpoint behavior compatible. Do not stage or overwrite unrelated pre-existing worktree changes.

**Goal:** Implement host-owned Target configuration resolution (M1), then persist an immutable Target binding atomically with a new Run's first checkpoint/event transition (M2a), while retaining legacy unbound Runs as legacy.

**Architecture:** Add a small public Target contract and a profile-layer catalog/resolver that validates a strict, bounded Target Catalog against installed scenario definitions and a private connection registry. Emit a credential-free catalog DTO. For M2a, pass only host-resolved binding metadata into the Harness, persist the snapshot and Run association inside the existing DurableTransition transaction, add an optional `targetBindingId` to AgentContext with a versioned checkpoint codec, and enforce Target ownership through a Target-scoped application query/start facade. Keep SQLite and event projection ownership at the host runtime.

**Stack:** TypeScript, Zod, Node.js 24, pnpm, Vitest, SQLite (`better-sqlite3`).

## Decisions Frozen by This Plan

- M1 accepts only the installed, versioned `window_failure_rate.v1` scenario descriptor. M1 validates configuration and mappings but performs no analysis, model call, or source network call; scenario execution belongs to M3.
- Target Catalog and private Connection Registry are separate inputs. The resolved/public Target DTO never contains endpoint, index, secret value, `secretRef`, or arbitrary configuration fields.
- Invalid individual Target entries are isolated; duplicate `targetId` or `profileId` conflicts quarantine all colliding entries. A malformed catalog envelope or a catalog over its configured bound is rejected as a whole; no partially validated catalog is published.
- Default registration bound is 200 Targets. The bound is host-controlled and not request-controlled. Existing memory profile parsing is adjusted only as needed to avoid silently limiting this supported target count; each scope remains exact and isolated.
- A Target snapshot is immutable and carries canonical digest, project/deployment generations, Target/profile/scenario identities and versions, validated metric mapping/rule, source references, approved knowledge references, Target-derived memory scope, and capture time. It contains no connection secrets or URLs.
- New Target Runs use a distinct Target-scoped application entry point. Legacy `/runs` and profile flows remain unchanged and cannot start or access arbitrary Target Runs.
- First root transition commits snapshot + Run binding + initial checkpoint + initial V2 outbox event in the same durable transaction. Child Run binding must use the same snapshot/root lineage in its first durable transition. No source/model request may occur before the root binding transaction succeeds.
- Existing checkpoints without `targetBindingId` remain legacy/unbound; no binding is inferred from `profileId`.
- Memory-system changes after M2a require a complete Semantic/Procedural design Spec and separate implementation checklist. Existing vector experiment changes are out of scope and must remain untouched.

## File Map

### M1 — Target identity and configuration

- Add `src/contracts/target.ts`: strict Target identities, catalog config, validated scenario binding, source references, knowledge references, resolved immutable snapshot, safe catalog DTO, resolver/catalog ports and stable error codes.
- Export the Target contract through `src/contracts/index.ts`.
- Add `src/profiles/target-catalog-schema.ts`: strict Zod schemas, bounded identifiers/catalog size, and parser that isolates invalid entries while rejecting duplicate identity collisions and invalid catalog envelopes.
- Add `src/profiles/target-resolver.ts`: resolve by opaque `targetId`, cross-check source/scenario/profile/target fingerprint consistency, derive exact `MemoryScope`, construct canonical immutable snapshot and sanitized DTO.
- Add `src/profiles/scenarios/window-failure-rate-v1.ts`: installed metadata/validator for integer window-snapshot metric mapping; no network or analysis behavior.
- Add two static, distinct simulation Target fixtures under `src/profiles/target-samples.ts` (market-a / market-b) to demonstrate different metric names, label conventions, thresholds, dataset IDs, and source references without secrets.
- Add `test/target-catalog-schema.test.ts`, `test/target-resolver.test.ts`, and update memory config tests for the explicit 200-profile bound.
- Do not wire new web routes or real sources in M1.

### M2a — New Run binding, persistence, and scope

- Extend `src/contracts/context.ts` with optional `targetBindingId`; extend `src/agent/types.ts` with host-only resolved-binding input, never accepted by public JSON parsing.
- Extend `src/contracts/storage.ts` with versioned Target snapshot/binding record types and atomic binding fields on `DurableTransitionUnitOfWork.commit`.
- Add SQLite migration for immutable Target snapshots, Run bindings, and idempotent request reservations; do not rewrite old checkpoints or backfill legacy records.
- Extend `src/storage/durable-codec.ts` and checkpoint schema version/migrations with an optional `targetBindingId`; preserve strict parsing of old versions.
- Extend `src/infrastructure/sqlite/durable-state-store.ts` and in-memory durable state so snapshot/binding reservation and the first checkpoint/outbox transition are atomic and collision-safe.
- Add Target binding queries to `SqlitePersistenceBundle` and the matching test/in-memory implementation.
- Add `src/application/target-run-service.ts`: resolve selection, derive request digest/idempotency behavior, create a host-bound Run, bind child Runs to the same snapshot/root lineage, and expose Target-scoped read guards. No access based only on profile name.
- Integrate the new service into the host bootstrap through injected complete persistence ports; do not create a second SQLite owner, event dispatcher, projector, or event store.
- Add isolated Target-scoped routes `/targets` and `/targets/:targetId/runs` (with detail/list access checks only for bound Runs); preserve existing legacy routes and response contracts.
- Tests: first-transition atomicity/rollback, no model/source activity before commit, request idempotency and payload conflict, checkpoint codec legacy migration, Target A/B cross-read denial, root/child snapshot inheritance, process-restart restore by original snapshot, revoked/changed generation fail-closed, and legacy Runs remain unbound.

## Execution Tasks

### Task 1 — M1 contract and parser (RED → GREEN)

1. Write schema tests for valid two-Target config, unknown fields, malformed IDs, missing refs, profile/Target collisions, duplicate-ID quarantine, per-entry invalid isolation, catalog bound and missing scenario version.
2. Run the focused tests and confirm they fail because the Target catalog types/parser do not exist.
3. Implement contracts and strict schema/parser only; keep error details free of raw configuration values.
4. Run focused tests and typecheck.

### Task 2 — M1 resolver and safe catalog (RED → GREEN)

1. Write resolver tests for snapshot digest stability, deep immutability, target fingerprint/data-domain consistency, source reference existence/kind, scenario mapping semantics, exact derived MemoryScope, and DTO secret redaction.
2. Run tests and confirm failure.
3. Implement scenario registry/validator, resolver, static sample Targets, and safe DTO.
4. Add a deterministic 200-Target registration/resolve test and a no-network assertion.
5. Run focused Target and memory-policy tests; inspect emitted DTOs for connection/secret fields.

### Task 3 — M1 verification checkpoint

Run lint/typecheck/build and the targeted tests. Review the diff for compatibility and unintended edits. Only after M1 passes, begin M2a.

### Task 4 — M2a contract/codec (RED → GREEN)

1. Add tests for v3 legacy checkpoint reads and v4 `targetBindingId` persistence/round-trip, plus rejection of malformed references.
2. Add tests proving host-only binding metadata cannot enter through HTTP request JSON.
3. Add contract + codec implementation and update schema version using the existing migration style.

### Task 5 — M2a atomic persistence (RED → GREEN)

1. Add persistence tests showing snapshot, binding, checkpoint, and RUN_STARTED outbox event commit together; injected failure rolls all of them back.
2. Add idempotency tests: same request key and digest returns the same Run; same key with different Target or payload is rejected.
3. Implement SQLite/in-memory stores and bounded indexes/constraints.

### Task 6 — M2a application scope and recovery (RED → GREEN)

1. Add application tests for Target resolution before accepting work, no external model/source call before binding commit, child binding inheritance, exact Target-scoped reads, A/B isolation, and restore from stored snapshot rather than latest catalog state.
2. Implement TargetRunService and bootstrap injection using one host-owned persistence bundle.
3. Add new Target routes/DTO and route tests; verify legacy `/runs` remains unchanged and cannot access Target-bound Runs.

### Task 7 — M2a verification checkpoint

Run Target, durable persistence, HTTP, checkpoint, source-subagent, memory isolation, and legacy acceptance tests. Then run lint, typecheck, full test suite, and build. Report any environment-blocked command explicitly; do not claim complete on partial checks.

### Task 8 — Complete memory Spec (after M2a)

1. Re-audit current memory contracts, episodic implementation, vector experiment boundary, and existing user changes.
2. Write a separate reviewed Spec for Working/Episodic/Semantic/Procedural memory with explicit provenance, approval/revocation, scope, lifecycle, retrieval, persistence/schema, events, UI/API, migration, and failure rules.
3. Write a separate file-level implementation plan and tests/acceptance matrix.
4. Since this changes durable semantics and introduces new memory classes, pause for user review of the Spec before touching memory implementation unless the user explicitly approves that exact Spec.

## Global Constraints

- Preserve all pre-existing unrelated worktree changes; inspect every overlapping file before editing.
- No real API key, endpoint, index name, or secret in fixtures, events, DTOs, snapshots, checkpoints, tests, or logs.
- No model or source request in M1/M2a tests; use deterministic fakes and assert zero calls on failed binding.
- Keep event contracts unchanged; Target labels are joined from binding records in read-side DTOs rather than added to existing event payloads.
- Do not use `process.cwd()` for config or data paths. Inject explicit paths at bootstrap.
- Do not stage, commit, push, or clean user changes unless requested.

## Self-Review Checklist

- [x] Ordered M1 before M2a; memory work follows both.
- [x] Spec-derived scope excludes M3 source execution and full scenario analysis.
- [x] Test-first failure checkpoints are explicit.
- [x] Public contract and SQLite migration impacts are listed.
- [x] Legacy Runs remain unbound; no guessed migration.
- [x] Root/child binding, idempotency, restart, and scope denial are covered.
- [x] Secret/endpoint redaction is tested.
- [x] Existing vector experiment changes remain out of scope.

## Execution Status (2026-10-11)

| Work | Status | Evidence / boundary |
|---|---|---|
| M1 Target registration, resolution, config validation | Complete | Strict bounded catalog, source/scenario/Profile cross-validation, secret-free DTO, isolated invalid entries, and multi-Target fixtures are implemented and covered by resolver/schema tests. |
| M2a Run binding, immutable snapshot, persistence and scope | Complete for the M2a contract | Root binding + snapshot + first checkpoint/outbox are atomic; child Runs inherit the root snapshot; idempotency and Target-scoped reads/routes are covered; legacy Runs remain unbound. Host can mount a read-only catalog without a starter, but starting is fail-closed unless a Target-aware execution port is injected. |
| M1/M2a verification | Tests/build/typecheck passed; full lint blocked | Full Vitest: 186 files passed, 3 skipped; 1673 tests passed, 7 skipped (Vitest used the bundled Node 24 runtime for the installed SQLite native module). Node 20.20.0 typecheck/build passed. Full ESLint reports 51 errors in the current dirty workspace's memory fixture/tests and `allowDefaultProject` list; Target core source lint passes. |
| Real business-source execution / Target picker UI | Not part of M1/M2a | These belong to later source-adapter and UI iterations. No production Prometheus/ELK target is enabled by this foundation. |
| Complete four-kind memory Spec + file-level plan | Written separately; awaiting review | See `docs/superpowers/specs/2026-10-11-complete-governed-memory-system.md` and `docs/superpowers/plans/2026-10-11-complete-governed-memory-system.md`. No Semantic/Procedural implementation has started. |
