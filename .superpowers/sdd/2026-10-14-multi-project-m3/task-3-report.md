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

## Task 3 fix round 1 — independent review Important findings

### Scope, interpretation, and compatibility

Applied the user's two review corrections after reading this report, the M3 plan, existing implementation/tests and checking Git state. Root causes: sample timestamps were discarded after only a future check, so the host could not authorize observation age/coherence; zero-byte chunks increased retained chunk count without increasing the byte counter and an endlessly ready stream could starve the timeout timer.

Checked [Prometheus instant selector documentation](https://prometheus.io/docs/prometheus/latest/querying/basics/#instant-vector-selectors): a selector uses the most recent sample at or before evaluation within its lookback. Therefore no `sampleUnixSeconds === evaluationUnixSeconds` requirement was introduced. The adapter does not inherit Prometheus's default lookback as a host authorization rule.

Only the Task 3 adapter, its focused tests, and this report are changed. Task 4/5, legacy settlement source/tests, pure Task 2 analyzer, public event/message/ToolResponse contracts, persistence schemas, bootstrap and runtime wiring remain untouched. The pre-existing untracked M3 plan remains excluded. No subagents or push.

The unconnected infrastructure `WindowFreshnessPolicy` now requires `authorizeObservations`; existing window-only policies fail closed at acquisition. This is an intentional local interface tightening authorized by the user, not a public wire/schema or persisted contract migration. Later host wiring must implement both policy methods, bound to its validated Target; that wiring is outside this fix round.

### Changes and behavior

- Retain each present vector observation's mapped metric name, role (`start_boundary`, `end_boundary`, `success_count`, `failure_count`), optional outcome value, query evaluation time and returned sample Unix-seconds time. Freeze observations and their collection, pass them together with the immutable requested window and final injected clock value to the host policy before constructing a typed fact or assessment. The policy receives no raw response, endpoint, credentials or arbitrary model arguments. The bound host policy can use its Target context without expanding adapter request authority.
- Preserve observation metadata in private query captures; do not add it to the reviewed fact or assessment. Continue rejecting nonfinite/future response timestamps structurally. Accept earlier-than-evaluation observations only after host authorization, including mixed times if the host explicitly allows their spread. No adapter age/skew constants or legacy duration default.
- Missing observation policy fails acquisition with `WINDOW_AUTHORITY_REQUIRED`. Denied/invalid-return/throwing observation policy fails with sanitized `OBSERVATIONS_NOT_AUTHORIZED`; stale policy result fails with `STALE_OBSERVATION`. Future response timestamps retain `INVALID_RESPONSE`. None of these rejections returns a complete fact or capture to the caller.
- Reject the first zero-length chunk with stable `INVALID_RESPONSE` before retaining it. Existing reader cancellation/finally cleanup cancels that stream. Every retained chunk is now at least one byte, so retained chunk count is at most `maxResponseBytes` per response. No non-progress counter or timer dependence is needed to bound empty-stream work. Whole-operation timeout and byte limits remain in effect for normal/stalled streams.

### TDD evidence (Node 24.19.0 only)

Used the same prescribed Node executable directly, not the pnpm shim:
`C:\Users\86147\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`.

1. Empty-stream RED: added a genuine endless `Uint8Array(0)` stream inside a test Worker so its microtask starvation cannot hang the test coordinator. Parent watchdog is 1,500 ms, shorter than the adapter timeout of 10,000 ms; worker termination is guaranteed in test cleanup. Corrected an initial test-only built-module path error (`dist/infrastructure`, not `dist/src/infrastructure`) and rebuilt the unchanged baseline before the valid RED. Focused command `node node_modules/vitest/vitest.mjs run test/window-failure-rate-source.test.ts --maxWorkers=2 -t 'endless microtask' --reporter=dot` failed as expected, exit 1, because the result was `{ watchdog: true }` instead of adapter rejection/cancellation.
2. Empty-stream GREEN: after the one-line zero-length rejection and rebuild, the same command passed (1 selected, 49 skipped), exit 0. The test asserts `INVALID_RESPONSE`, cancellation, non-aborted operation signal (termination precedes timeout), and at most two stream pulls (one read plus permitted stream prefetch). The endless stream is not converted into a finite fixture and does not rely on the starved worker's timer.
3. Observation RED: added host-configured age/spread policies and focused tests before extending production policy. `node node_modules/vitest/vitest.mjs run test/window-failure-rate-source.test.ts --maxWorkers=2 --reporter=dot` failed as expected, exit 1: 9 failed, 52 passed. Missing observation authority did not throw; authorization callback was never invoked; old/mixed/rejected/throwing-policy observations still resolved to complete assessments.
4. Observation GREEN: after the minimal interface/metadata/authorization extension and rebuild, `node node_modules/vitest/vitest.mjs run test/window-failure-rate-source.test.ts test/window-failure-rate-scenario.test.ts test/prometheus-snapshot.test.ts --maxWorkers=2` passed 110 tests, exit 0 (61 changed adapter, 30 scenario, 19 unchanged legacy). Covered fresh earlier samples, host age rejection, host coherence rejection and acceptance, future rejection, denied/stale/invalid-return/missing/throwing policy, final injected clock, immutable metadata and private capture separation.

### Verification and remaining limits

- Build: `node node_modules/typescript/bin/tsc -p tsconfig.build.json` passed before focused GREEN and on the final verification rerun, exit 0.
- Typecheck: `node node_modules/typescript/bin/tsc --noEmit` passed on the final tree, exit 0. The first typecheck caught an intentional malformed-policy test assertion whose inline function return widened to string; corrected the test to reuse the typed authorize function, without changing production behavior, then reran successfully.
- Full lint: `node node_modules/eslint/bin/eslint.js . --ignore-pattern apps/logs-lab/index.mjs` passed, exit 0, including the final source-only Worker loader and handshake.
- Full regression suite after rebuild: `node node_modules/vitest/vitest.mjs run --maxWorkers=2 --reporter=dot` passed, exit 0: 211 files passed, 3 skipped; 2,204 tests passed, 7 skipped (2,211 total), duration 369.91 seconds. Existing LangSmith timeout/abort diagnostics were emitted by passing tests. The full suite covered the completed production fixes; the subsequent test-only source-loader/handshake correction was additionally verified with dist absent on the final test tree below. No production changes followed the full run.
- `git diff --check` passed; manual diff review confirms Task 4/5 and forbidden areas are unchanged.

No live Prometheus or Task 4/5 host integration is claimed. Age/skew/coherence values are deliberately supplied only by the injected host policy; the test-host limits are examples, not production defaults. Final local fix commit SHA is returned in the task handoff; this appendix is included in that independent commit.

### Follow-up correction — source-only Worker and clean-build evidence

The user's interim read-only review identified that the initial Worker fixture imported `../dist/...`, creating an unwanted build-output prerequisite. Reproduced it with generated `dist` temporarily moved to an explicit, checked task-local backup: the selected empty-stream test failed with `ERR_MODULE_NOT_FOUND` (exit 1). This is recorded separately from the original empty-stream behavioral RED.

Removed that dependency completely. The test Worker now imports `src/infrastructure/prometheus/window-failure-rate-source.ts`; worker-local `node:module.registerHooks` resolves relative `.js` source specifiers to `.ts` only under the repository source URL. Its load hook uses the already installed TypeScript `transpileModule` in memory, without writing files or emitting dist. This also supports existing TypeScript constructor parameter properties that plain strip-types would not handle, without changing the Task 2 source. Hooks exist only in that isolated test Worker; production imports/execution are unaffected.

The test has a startup handshake: a 5,000-ms parent startup watchdog covers source-loader startup; once the Worker is ready, a 1,500-ms watchdog covers the genuine endless stream. The adapter timeout is 10,000 ms, and the passing assertion requires the operation signal to remain non-aborted. This separates compiler startup overhead from the deterministic non-progress termination assertion.

Clean-source GREEN: with `dist` absent, the direct Node 24 focused command for adapter/scenario/legacy tests passed all 110 tests (61/30/19), exit 0; no build command was invoked during that run. Restored the preserved generated directory afterward; no data was deleted. Final clean-source confirmation after the handshake edit also passed 110/110 at 19:02:55, exit 0, duration 5.52 seconds. The empty-stream worker case passed in 771 ms including source-loader startup. `dist` was absent throughout that run and its task-local backup was restored afterward.

The package script is explicitly `test: pnpm build && vitest run --maxWorkers=2`; its build uses `tsc -p tsconfig.build.json`, so the full-suite build prerequisite is explicit and reproducible. Nevertheless, the final changed focused tests no longer require that prerequisite or any pre-existing dist. Direct verification commands continue to use the prescribed Node 24 executable to avoid the pnpm shim's possible Node 20 selection.
