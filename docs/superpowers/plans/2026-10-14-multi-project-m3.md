# Multi-project adaptation M3 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (or `executing-plans` when delegation is unavailable) and `test-driven-development`. Work one task at a time; tests must demonstrate RED before implementation. Preserve the legacy settlement experiment. Create local task commits as required by SDD; do not push.

**Goal:** Close M3 from `2026-10-11-multi-project-adaptation-design.md`: independently adapt the versioned `window_failure_rate.v1` scenario to each Target, collect and validate a bounded Prometheus snapshot, partition source resilience by immutable Target source identity, and preserve Target binding through Metrics child Runs.

**Architecture:** Keep domain analysis in `profiles/scenarios`, source protocol and parsing in the Prometheus infrastructure adapter, and assemble Target-scoped tools/runtime in bootstrap. Reuse the existing Tool/MCP resilience, EvidenceRecorder, Target recovery and SourceSubagent contracts where they fit. No model-provided URL, PromQL, Target ID, or source scope may widen authority. `settlement-source.ts` and the legacy settlement lab remain unchanged.

## Global Constraints

- `TargetRuntimeProvider.acquire(snapshot)` receives only a host-validated immutable snapshot; no model or HTTP input may supply an endpoint or Tool array.
- Snapshot V1/V2 identity, existing V2 digests, and persisted run bindings remain valid; new behavior is represented by an explicit scenario version and implementation digest.
- Scenario analysis is deterministic and uses validated typed facts. LLM output cannot calculate or override rates, thresholds, sample sufficiency, source scope, or evidence coverage.
- A Prometheus query is generated only from validated metric identifiers and escaped, host-bound selectors; arbitrary PromQL is never accepted from model input.
- Public evidence contains summaries and references, not raw source payload, credentials, private endpoints, or connection configuration.
- Source resilience identity includes project, deployment generation, SourceBinding ID, source generation, data domain, and permission-scope digest. Cancellation is not a logical failure; stale-epoch completion cannot close a newer breaker.
- Existing write-safety, HITL, idempotency, event-contract, and dependency-direction rules remain unchanged. No real write operation is added.
- The legacy settlement experiment and its public behavior are not modified by M3.

**Compatibility decision:** Keep `window_failure_rate.v1@1.0.0` and its digest/schema readable exactly as stored. Introduce a versioned `1.1.0` binding that requires explicit start/end boundary metric mappings and a new implementation digest. V2 snapshots may contain either already-supported `1.0.0` shape or the additive `1.1.0` scenario shape; old serialized V2 values and their digest inputs remain byte-for-byte unchanged. New M3 acceptance fixtures use `1.1.0`. A legacy `1.0.0` binding without verifiable business-window boundaries must not be reported as a complete M3 assessment.

## Task 1 — Version the scenario binding without changing existing snapshots

**Files:** `src/contracts/target.ts`, `src/contracts/target-schema.ts`, `src/profiles/target-catalog-schema.ts`, `src/profiles/scenarios/window-failure-rate-v1.ts`, `src/profiles/target-samples.ts`, `test/target-catalog-schema.test.ts`, `test/target-snapshot-version.test.ts`, `test/target-resolver.test.ts`.

1. Add failing compatibility tests: old `1.0.0` catalog/snapshot values still parse and retain their existing digest; `1.1.0` requires valid start/end timestamp metric names; unknown versions remain rejected by installation lookup; malformed or ambiguous mappings fail closed.
2. Add a versioned boundary mapping (`startMetricName`, `endMetricName`, and a fixed Unix-seconds semantic) to `1.1.0` only. Ensure selectors use the already trusted service/static labels and are not supplied by model arguments.
3. Publish both installed scenario identities; keep the old digest stable and compute a distinct `1.1.0` digest from its full input/output semantics. Update only new M3 sample Targets to `1.1.0`.
4. Run the focused Target catalog/snapshot/resolver tests.

## Task 2 — Add typed facts and deterministic scenario analysis

**Files:** `src/profiles/scenarios/window-failure-rate-v1.ts` (or a versioned sibling), `src/profiles/index.ts`, new `test/window-failure-rate-scenario.test.ts`.

This completes the not-yet-pushed scenario implementation introduced in Task 1. Finalize the `1.1.0` implementation descriptor/digest so it covers the analyzer semantics and its typed input/output; do not change the historical `1.0.0` descriptor or digest. The `1.1.0` installation has not been pushed or deployed, so all new sample/snapshot fixtures must derive their digest from the reviewed installation constant rather than pinning an interim digest.

1. First test the versioned `window_count_snapshot.v1` input and discriminated assessment outputs: complete, insufficient samples, and unavailable/missing-window evidence.
2. Validate finite timestamps, exact equality with the explicit host-authorized requested window, nonnegative safe integer success/failure counts, positive total, and `failed <= total`; reject wrong units, boundary mismatches (including stale/future data relative to the request), zero denominator, and inconsistent totals. Do not hard-code a global window duration or freshness age in the pure analyzer; absolute freshness authorization belongs to the source adapter's injected host policy/clock.
3. Compute rate and configured threshold exclusively in deterministic code; assert 4% is below 5% and above/equal to 2%. Never use LLM output to calculate or override facts.
4. Export only reviewed scenario APIs through the existing profile barrel; do not expose unvalidated `Record<string, unknown>` facts.

## Task 3 — Implement a Target-bound Prometheus window adapter

**Files:** new `src/infrastructure/prometheus/window-failure-rate-source.ts`, new `src/mcp/target-metrics-protocol.ts` only if needed by the existing MCP contract, `src/infrastructure/prometheus/index.ts`, corresponding focused adapter tests.

1. Test request generation from a validated `1.1.0` mapping, exact service/static selectors, both boundary queries, response-size limits, timeout/abort, malformed/ambiguous/missing series, and explicit stale-window errors. The adapter must validate the requested window against an explicit injected host freshness policy/clock; never assume every Target uses the legacy 300-second settlement window.
2. Use a narrow injected query port; only bootstrap resolves the private endpoint/credentials. Generate queries only from validated metric/label identifiers and escaped values. Do not accept raw PromQL or endpoint fields from the model/HTTP request.
3. Require one finite Unix-seconds start and end sample and verify they match the requested immutable window; collect success/failure series and hand the typed fact to the deterministic analyzer.
4. Record raw source payload only through the existing evidence storage path; public evidence remains summary/reference-only. Do not modify the legacy settlement adapter.

## Task 4 — Partition source state and make leases safe

**Files:** new `src/application/target-source-partition-registry.ts` or infrastructure implementation plus a minimal contract in `src/contracts/target.ts`, bootstrap wiring, focused tests.

1. Test partition identity from the full Spec key: project, deployment generation, SourceBinding, source generation, data domain, and permission digest. Same identity reuses one breaker/semaphore; distinct projects/scopes never share them.
2. Test defaults of 3 logical failures, 30-second open interval, exactly one half-open probe; cancellation is not failure, stale-epoch success cannot close a newer circuit, and a second scenario cannot bypass the same partition.
3. Add bounded registry size and reference-counted leases. Releasing one Run cannot close resources still leased by another; shutdown releases all owned resources. Inject clock and limits.
4. Route logical operations through the existing resilience executor; retry attempts do not multiply logical failure counts.

## Task 5 — Bind Metrics Subagent and child Run to the parent Target

**Files:** `src/bootstrap/metrics-subagent.ts`, `src/application/source-subagent-runner.ts` only if a missing invariant is demonstrated, Target runtime provider/bootstrap wiring, new Target Metrics Subagent integration tests.

1. Test that the model sees only the already-bound Target metrics tool plus report tool; no caller-supplied endpoint, Target/source scope, or arbitrary metric selector is accepted.
2. Test child Run inherits the exact parent binding/snapshot digest, target source scope, memory scope, and remaining budgets; wrong or unavailable source scope fails closed.
3. Test retries/circuit events flow through existing V2 events while evidence and reports retain their Target ownership.
4. Keep `SourceSubagentRunner` generic; add only the smallest typed port or adapter needed for Target-specific metrics.

## Task 6 — M3 integration and regression gate

**Files:** Target M3 integration tests and any existing public projection schema/test that must support the new reviewed assessment; no UI changes in this task.

1. Run two Targets concurrently with different metric names, labels, thresholds, and source partitions; assert identical fact shape but different threshold verdicts and no cross-Target evidence, memory, messages, usage, events, or breaker state.
2. Exercise failure/open/cooldown/single-probe/recovery on A while B remains queryable; exercise cancellation and late-epoch completion.
3. Verify source data from wrong scope, invalid counts, wrong units, missing/invalid boundaries, and stale windows never produce a complete/high-confidence assessment.
4. Run focused Target/metrics/MCP tests, then `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` on the repository-supported Node/pnpm toolchain. Report any unrelated baseline failure separately.
5. Confirm `src/infrastructure/prometheus/settlement-source.ts` and legacy settlement tests are unchanged and still pass.

**Out of scope:** M4 Target UI/query ownership expansion and circuit rendering, M5 browser acceptance, Counter semantics, live `group-buy-market` wiring, automatic writes, PR/commit/push. These remain subsequent roadmap increments after M3 passes.
