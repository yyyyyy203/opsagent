# Task 3 — Target-bound Prometheus window adapter

## Scope and compatibility

Implemented in the user-selected isolated worktree `D:\agentops\.worktrees\event-message-v2`, branch `codex/event-message-v2`.
Read the Task 3 brief, repository AGENTS.md, M3 implementation plan, multi-project design, Target metric/scenario contracts, reviewed Task 2 analyzer, and existing MCP interfaces before implementation.
This is an infrastructure adapter addition. No public event/message/ToolResponse contract, persisted schema, checkpoint semantics, application dependency, runtime/bootstrap wiring, or legacy settlement experiment changes. Historical scenario 1.0.0 remains readable upstream; this new adapter requires the reviewed 1.1.0 boundary mapping. No migrations are needed.
The existing untracked M3 plan was present before work and is excluded from this commit. No subagents were dispatched and nothing was pushed.

## Implementation and controller rulings

- Added `src/infrastructure/prometheus/window-failure-rate-source.ts` and its existing infrastructure barrel export.
- Takes the trusted scenario binding at acquisition, copies it to prevent caller mutation, checks metric/label identifiers and mapping ambiguity, and generates four exact-match queries: start boundary, end boundary, success count, failure count. Trusted service/static selectors apply to every query. Label values use JSON string escaping; no arbitrary PromQL, URL, credentials, or endpoint request fields are accepted.
- Requires injected `WindowFreshnessPolicy` and `nowUnixSeconds` clock. Strict immutable Unix-seconds requests are authorized before network work and checked again before evidence returns. Missing policy/clock, nonfinite clock, denied/throwing policy, stale windows, and extra request fields fail closed. There is no adapter-wide duration/skew assumption or legacy 300-second default.
- Uses `WindowPrometheusQueryPort`: the host transport returns status and an unread `ReadableStream<Uint8Array>`. Only later bootstrap resolves private connection settings. The port contract prohibits prebuffering. The adapter owns reading, counts bytes before retaining chunks, enforces injected `maxResponseBytes` per response, cancels excess/stalled/error bodies, and parses bounded UTF-8 JSON. Four responses bound capture storage to four times the configured per-response byte limit (plus parsed-object overhead). Injected `timeoutMs` bounds the whole collection, including waiting on ports/readers that ignore cancellation. Late transport responses are disposed after cancellation.
- Requires vector envelopes, one finite decimal sample for each mapped series, exact returned selector/name/outcome scope, and consistent exporter identity across queries. Multiple series are ambiguous, never aggregated. Missing outcomes fail closed; missing boundaries produce the reviewed unavailable fact with explicit missing evidence. Invalid sample timestamps, warnings/infos, invalid JSON and malformed envelopes are rejected. Numeric boundaries must exactly match the host request through the reviewed analyzer.
- Uses Task 2 `HostAuthorizedRequestedWindowV1`, `WindowCountSnapshotV1`, `parseWindowCountSnapshotV1`, and `assessWindowFailureRateV1`; count/rate/threshold/sample-sufficiency logic is not duplicated.
- Returns separate `fact`, `assessment`, and private `rawCapture` material. No application EvidenceRecorder import, direct persistence, ToolResponse production, public evidence publication, or event publication. Task 5 must route the private captures through its existing EvidenceRecorder/storage path and only expose reviewed summaries/references.
- No `target-metrics-protocol.ts` added: the existing MCP connection is ToolResponse-oriented, while this task's adapter has a byte-stream query port and no MCP tool/wiring change. Extending the MCP/public wire contract here is unnecessary.

## TDD and verification

All commands use the prescribed executable directly:
`C:\Users\86147\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe` (`v24.19.0`).
No pnpm shim was invoked, avoiding Node 20/native SQLite ABI selection. Direct commands below execute the same package script gates.

1. Baseline: `node node_modules/vitest/vitest.mjs run test/window-failure-rate-scenario.test.ts --maxWorkers=2` — 30 passed.
2. Tests added before adapter implementation. Initial run uncovered a fixture import error (parseTargetCatalog is not in the profiles barrel); corrected only the test import, then reran.
3. RED: focused missing-export assertion failed as expected, exit 1. Added an explicitly unimplemented typed scaffold and ran the adapter suite: 41 behavioral tests failed with `NOT_IMPLEMENTED`, one temporary export assertion passed, exit 1. No production behavior was implemented before these failures.
4. GREEN: implemented minimum adapter; adapter/scenario run passed 72 tests. Removed the temporary export-only assertion after the behavioral RED/GREEN proof and added transport/immutability/policy/analyzer regression coverage.
5. Final focused command: `node node_modules/vitest/vitest.mjs run test/window-failure-rate-source.test.ts test/window-failure-rate-scenario.test.ts test/prometheus-snapshot.test.ts --maxWorkers=2` — 98 passed (49 adapter, 30 scenario, 19 unchanged legacy Prometheus tests).
6. `node node_modules/typescript/bin/tsc --noEmit` — passed.
7. `node node_modules/typescript/bin/tsc -p tsconfig.build.json` — passed.
8. `node node_modules/eslint/bin/eslint.js . --ignore-pattern apps/logs-lab/index.mjs` — final full lint passed, exit 0. Initial full lint found one unnecessary test assertion; removed it before rerunning.
9. Full suite: `node node_modules/vitest/vitest.mjs run --maxWorkers=2 --reporter=dot` after build — passed, exit 0: 211 files passed, 3 files skipped; 2,192 tests passed, 7 skipped (2,199 total), duration 366.84 seconds. Existing LangSmith timeout/abort tests emitted transport diagnostics but passed; no adapter regression or native SQLite ABI failure occurred.

## Review and concerns

Confirmed `settlement-source.ts`, legacy settlement tests, bootstrap/runtime wiring, and public contracts have no task diff. Focused tests cover both Target mappings (4% under 5%, over 2%), exact escaped/static selectors, a 601-second authorized window, missing/ambiguous/wrong-scope data, malformed values, authorization/freshness, bounded streamed reads, timeout, abort, raw separation, and reviewed analyzer reuse.
Task 5/bootstrap must supply a host policy that authorizes the actual Target window/freshness, the correct scoped transport returning unread bytes, explicit resource limits, and application EvidenceRecorder routing. This task does not connect a live endpoint or claim end-to-end M3 integration. Extra exporter dimensions fail closed unless their identities agree; no aggregation semantics are inferred.

Final typecheck rerun and `git diff --check` also passed after the last test-fixture edit. Manual implementation review confirmed the scope and controller rulings above.

Local implementation commit: recorded by the final task handoff (the report is included in that commit).
