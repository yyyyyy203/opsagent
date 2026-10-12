# Multi-project M1 + M2a Implementation Plan

> **For agentic workers:** Implement sequentially with test-first development. Complete and verify M1 before beginning M2a. Keep the existing legacy profile/run endpoints and checkpoint behavior compatible. Do not stage or overwrite unrelated pre-existing worktree changes.

**Risk revision (2026-10-11 baseline):** At the time of this revision, M1/M2a configuration and persistence foundations existed, but historical identity validation, executable current-policy recovery, and uncertain-start reconciliation were incomplete. R0.1 → R0.2 → R0.3 → R0.4 were added as gates before implementing the complete memory plan or enabling new Target execution. The existing Tasks 1–8 describe the original delivery; their tests are not proof that R0 has passed. See the execution status below for current completion.

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
- R0 adds a versioned Snapshot V2 and historical identity ledger; never silently add required fields to Snapshot V1 or reinterpret existing source/knowledge references. V1 records remain verifiable/readable; unprovable identity blocks execution, not historical reads.
- R0 allocates SQLite v7 for identity/policy/execution claims; the complete memory plan follows with v8. Reconcile version allocation before implementation if another migration has landed.
- Current policy must be checked before successful resume notification and every actual parent/child model/source request. A durable snapshot does not grant permanent permission.
- Unknown initial-commit state retains the durable reservation; only confirmed absence plus a fenced old owner permits a retry with the original requestId/runId.
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
- Tests: first-transition atomicity/rollback, no model/source activity before commit, request idempotency and payload conflict, checkpoint codec legacy migration, Target A/B cross-read denial, root/child snapshot inheritance, and process-restart snapshot reads. Executable recovery, revocation and changed-generation denial require the new R0.3 tests; reopening SQLite alone does not cover them.

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

## R0 — Foundation Risk Remediation (R0.1–R0.3 implemented; R0.4 release gate pending final review)

The corresponding decisions are frozen in [multi-project Spec](../specs/2026-10-11-multi-project-adaptation-design.md) §§4.1, 6, 7 and 11. These are repairs to the foundation, not M2b legacy migration, M3 source implementation or a second Harness. Run tests with injected clocks, IDs and deterministic adapters; do not spend model quota.

### R0.1 — Historical identities and versioned snapshots (R1)

**Files**

- Update `src/contracts/target.ts`, `src/contracts/target-schema.ts` and `src/contracts/index.ts`: distinct V1/V2 snapshot types/parsers, `TargetIdentityRegistry`, source dataDomainId/sourceGeneration/permission identity, Scenario implementation digest and versioned host-only `TargetKnowledgePolicy`. Knowledge references retain `{ id, version, digest, approval }`; existing unspecified references default to optional.
- Update `src/profiles/target-catalog-schema.ts`, `src/profiles/target-resolver.ts`, `src/profiles/target-samples.ts` and installed scenario metadata: versioned config input and identity validation against persisted history before publishing a catalog.
- Add `src/infrastructure/sqlite/target-identity-store.ts` and `src/storage/in-memory-target-identity-store.ts`; append v7 in `src/infrastructure/sqlite/migrations.ts`, expose ports from `persistence-bundle.ts`, and wire them in host bootstrap. Do not instantiate storage in the resolver.
- Update `src/storage/target-binding-state.ts` and the snapshot query path to dispatch V1/V2 validation without changing old checksums or backfilling identities.
- Add `test/target-identity-registry.test.ts`, `test/target-snapshot-version.test.ts`; extend `test/target-resolver.test.ts` and `test/target-binding-durable.test.ts`.

- [x] RED: publish catalog A, reopen storage, then attempt fingerprint reuse with changed generation/domain, generation rollback, targetId tombstone reuse and conflicting profile ownership. Assert rejection and no replacement of accepted history.
- [x] RED: changing only endpoint/credential within a host-verified identical domain/permission preserves identity; changing domain without new generation/fingerprint fails. V1 remains readable but cannot acquire execution without explicit historical proof.
- [x] GREEN: implement immutable identity records, transactional/CAS catalog publication, policyEpoch and sanitized source metadata. Validate scenario version plus digest, not just a matching version string.
- [x] Verify Snapshot V2 digest round-trip, exact MemoryScope separation, DTO redaction, 200-Target bounds and zero external calls. No legacy checkpoint rewrite is needed solely for V2 snapshots.

### R0.2 — Uncertain initial commit and durable execution fencing (R3; depends on R0.1)

**Files**

- Update `src/application/run-execution-coordinator.ts` and `src/application/target-run-service.ts`: explicit `confirmed_absent | confirmed_present | unknown` outcomes, safe fixed error codes, original-key retries and an injected reconciliation port.
- Extend Target persistence ports and v7 with start reservation/claim state (owner, epoch and lease), not another copy of AgentContext or tool execution state. Update `src/infrastructure/sqlite/durable-state-store.ts`, the in-memory durable store and bootstrap injection to fence the first transition inside its transaction.
- Extend `test/run-execution-coordinator.test.ts`, `test/target-run-service.test.ts`, `test/target-binding-durable.test.ts`; add `test/target-start-reconciliation.test.ts`.

- [x] RED: checkpoint reread throws after start failure; a second start must remain blocked. Contrast with a confirmed rollback/null read, where the original reserved Run can safely retry.
- [x] RED: first commit succeeds but acknowledgement is lost; reconciliation returns the original Run. Partial/contradictory records stay unknown; no new Run, model or source request is created.
- [x] RED: crash/restart, two coordinators, lease expiry and delayed old-owner commit. Lease expiry alone must not mean absent; old epoch commit must fail CAS after takeover.
- [x] GREEN: persist and reconcile start state, atomically check ownership at first commit, and use accepted/started in-memory sets only as bounded caches. Never release unknown state in a catch branch or automatically substitute another requestId.
- [x] Verify idempotent results, conflicting request digests, rollback/outbox consistency and preservation of legacy start semantics. Count fake external operations explicitly.

### R0.3 — Executable recovery and current-policy operation gate (R2; depends on R0.1–R0.2)

**Files**

- Add `TargetOperationPolicy`, operation request/permit and `TargetRecoveryGate` ports in `src/contracts/target.ts`; add `src/application/target-recovery-service.ts` to validate current restrictions and acquire original-snapshot runtime leases.
- Update `src/application/target-run-service.ts`, `src/bootstrap/agent-web-runtime.ts`, `src/application/create-runtime.ts`, `src/agent/types.ts` and `src/agent/agent-harness.ts`: inject policy, validate before RUN_RESUMED, and rebuild original-version capabilities rather than latest global config.
- Update `src/tool/execution-pipeline.ts`, `src/model/retrying-model.ts`, `src/mcp/resilience.ts` and `src/application/source-subagent-runner.ts` through injected operation-check ports: actual parent/child/retry/repair/probe attempts all check the same binding and policyEpoch, not only the outer logical ToolCall; validate late results before evidence commit. Assemble checks in bootstrap, not concrete storage/Target globals inside these modules. Preserve Guard/Hook/HITL and generator/V2 ordering.
- Add `test/target-recovery-policy.test.ts`, `test/target-operation-policy.test.ts`; extend `test/target-http-routes.test.ts`, `test/source-subagent-recovery.test.ts`, `test/model-harness-contract.test.ts` and persistence recovery tests.

- [x] RED: after runtime restart, the real Harness integration denies resume for a tombstoned Target and when the internal recovery gate is absent; neither path publishes `RUN_RESUMED` or invokes the model/runtime provider. Service-level tests deny disabled/unresolved Targets, revoked source identity, changed deployment generation, removed Scenario, and changed Scenario digest before runtime acquisition.
- [x] RED: valid recovery acquires the persisted original snapshot despite a newer catalog capture. Endpoint/secret-reference rotation with unchanged source identity remains allowed; an expanded source permission generation is rejected and cannot widen the old Run.
- [x] RED: Target revocation during model/MCP retry waits cancels before another attempt; revocation during a child Subagent operation cancels it without retry; revocation before evidence commit leaves no visible evidence. Policy denial does not increment the source circuit breaker.
- [x] GREEN: Target ownership checks precede resume/confirmation/cancel commands. HTTP tests verify approval cannot bypass the gate while rejection and cancellation remain available. No Target command is routed through the legacy endpoint.
- [x] Verify direct internal resume fails closed without an injected policy gate and legacy unbound resume tests remain unchanged. Missing Target message/evidence/UI routes remain unavailable until M4; they are not counted as delivered.

### R0.4 — Foundation release gate and memory handoff

- [x] Run R0-specific RED/GREEN tests and existing Target, checkpoint, V1/V2, HTTP, model, Source Subagent, admission, memory-scope and circuit tests. Final Node 24 Vitest run: 192 files passed, 3 skipped; 1719 tests passed, 7 skipped.
- [x] Verify the production build and `eslint src` under the repository-required Node 24 runtime; both pass.
- [x] Fresh Node 24 validation after the P2 changes: the underlying lint (`eslint . --ignore-pattern apps/logs-lab/index.mjs`), typecheck (`tsc -p tsconfig.json --noEmit`), build (`tsc -p tsconfig.build.json`) and full Vitest run pass. Vitest reports 192 files passed, 3 skipped and 1730 tests passed, 7 skipped. Real Prometheus/Elasticsearch opt-in tests remain skipped.
- [x] Close the P2 approval-versioning gap: persist `toolDefinitionDigest` in confirmation/external-interruption payloads; require versioned Target runtime Tools; fail closed on missing digest or changed implementation/schema. Follow-up review hardening also binds confirmation/external-result handling to the Durable Target Binding, reconstructs the current Target Tool instead of falling back to a same-name global Tool, rejects inconsistent Checkpoint binding before downstream processing, keeps Target rejection available after revocation, and holds the external-result runtime lease through validation/Guard/Hook/persistence. Tests cover same-version SQLite restart, drift before confirmation and after approval, missing digest, missing Checkpoint binding, revoked-target rejection, external-result drift and unversioned provider Tools. No SQLite/event/message contract migration.
- [x] Independent review of the P2 implementation and surrounding stale-approval paths; the scoped re-review found no remaining Critical, Important, or Minor findings. M2a recovery release gate is closed.
- [x] Full quality gates and independent review passed; hand off to [complete memory plan](2026-10-11-complete-governed-memory-system.md) T1–T7, with v7 as its persistence baseline. M3 source execution is still a separate delivery.

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
- [x] Root/child binding, initial idempotency, restart reads and scope denial have foundation tests.
- [x] R0.3 executable recovery and per-operation policy fencing are behavior-tested; the P2 approval-versioning follow-up is implemented, full quality gates pass, and independent review found no remaining findings.
- [x] Secret/endpoint redaction is tested.
- [x] Existing vector experiment changes remain out of scope.

## Execution Status (2026-10-12)

| Work | Status | Evidence / boundary |
|---|---|---|
| M1 Target registration, resolution, config validation | Foundation and R0.1 complete | Historical cross-restart identity ledger, source/domain identity verification, V1 read-only behavior and V2 integrity checks are implemented and focused-tested. |
| M2a Run binding, immutable snapshot, persistence and scope | Foundation including R0.3 and P2 approval-versioning implemented and independently reviewed | Root/child binding, atomic first transition, durable request reservation, epoch/lease claims, lost-ack reconciliation, current-policy resume, per-operation fencing and tool-definition-bound HITL recovery are implemented and tested. A read-only catalog without an injected Target starter remains non-executable. |
| Original M1/M2a verification | Historical baseline; superseded by fresh R0.4 evidence | Previously: 186 files passed, 3 skipped; 1673 tests passed, 7 skipped using bundled Node 24 for Vitest/SQLite. Node 20.20.0 typecheck/build and an ESLint run with 51 dirty-workspace diagnostics are historical only; fresh repository-required Node 24 results are recorded in the R0 risk-remediation row. |
| R0 risk remediation | R0.1–R0.3 and P2 implementation complete; independent review found no remaining findings | Fresh Node 24 results: full Vitest 192 files passed, 3 skipped; 1730 tests passed, 7 skipped. The lint/typecheck/build commands above pass. SQLite migration rollback and tool-definition-bound confirmation recovery have regression coverage. The separate memory handoff remains unstarted. |
| Real business-source execution / Target picker UI | Not part of M1/M2a | These belong to later source-adapter and UI iterations. No production Prometheus/ELK target is enabled by this foundation. |
| Complete four-kind memory Spec + file-level plan | Written separately; awaiting review | See `docs/superpowers/specs/2026-10-11-complete-governed-memory-system.md` and `docs/superpowers/plans/2026-10-11-complete-governed-memory-system.md`. No Semantic/Procedural implementation has started. |
