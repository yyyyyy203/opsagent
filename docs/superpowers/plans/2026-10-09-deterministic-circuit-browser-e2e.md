# Deterministic Circuit Browser E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Follow the executing-plans and test-driven-development skills. Implement the tasks in order and keep the plan checkboxes current.

**Goal:** Prove in a real browser that the Agent Web UI, Agent Web Runtime, Metrics Lab/MCP, source circuit breaker, V2 SSE, and evidence views work together using deterministic test models and simulated data.

**Architecture:** Add a separate opt-in Playwright fixture, not a production endpoint. The fixture starts Metrics Lab with a deterministic `sourceFactory`, Agent Web Runtime with injected `ScriptedModel` instances and a controllable test clock, and loopback-only test controls for fault injection and advancing time. The initial four-Run sequence is extended by Task 5 to seven parent Runs: exhaust nine physical source attempts across three logical operations, verify requests at circuit-open and at 29,999 ms make no source query, then fail the first eligible probe once. Verify the restarted cooldown immediately and at 29,999 ms, advance the final millisecond, then verify one successful probe, evidence capture, and UI recovery state. Inspect child-source events in the child Run view, consistent with the existing per-Run SSE boundary.

**Tech Stack:** TypeScript, Node.js 24, pnpm 11.19, Playwright, Vite, application runtimes, `ScriptedModel`, Metrics Lab/MCP simulator.

## Global Constraints

- Do not alter production retry, threshold, cooldown, HITL, or data-source configuration.
- Do not call a paid model, production data source, LangSmith, or `group-buy-market`.
- Bind test servers and controls to `127.0.0.1`; use ephemeral internal Metrics Lab ports and an isolated temporary SQLite directory.
- Keep existing default Playwright tests and fixture unchanged; the new test runs only under its dedicated config.
- Preserve pre-existing worktree modifications; do not commit or push.

### Task 1: Add the end-to-end browser contract first [x]

**Files:** `test/e2e/metrics-circuit-web.spec.ts`, `playwright.circuit.config.ts`

- Create a separate Playwright spec for failure → open → blocked → cooldown → probe → recovered.
- Assert the parent links to a child Run and inspect source-resilience UI state in that child Run.
- Assert the open-circuit interval and the 29,999 ms cooldown boundary issue no source query; the final millisecond makes the probe eligible, then exactly one recovery query and a persisted evidence reference are observed.
- First run the contract and observe a meaningful assertion failure, not a loader/configuration failure.

### Task 2: Compose the deterministic real-runtime test fixture [x]

**Files:** `test/e2e/metrics-circuit-fixture-server.mjs`, `playwright.circuit.config.ts`, `package.json`

- Start Metrics Lab with ephemeral loopback ports and deterministic `sourceFactory`; count successful upstream source queries.
- Start the real Agent Web Runtime with the MCP URL, parent/child `ScriptedModel`s, immutable five-minute simulation window, and mutable test clock.
- Add strict loopback-only controls to inject nine failures, inspect remaining failures/query count, reject out-of-order time advances, and advance time by 29,999 ms followed by 1 ms.
- Use isolated browser/agent/control ports with preflight checks; bind Vite and runtime to loopback.
- Add an `e2e:circuit` script that builds and runs only this config.
- Re-run and pass the contract without real-model or Prometheus dependencies.

### Task 3: Document scope and verification [x]

**Files:** `docs/guides/agent-web-local.md`, `docs/implementation-status.md`

- Document the no-paid-model browser command, what the E2E proves, and its limits.
- State that it validates simulated telemetry and the application chain, not production readiness.
- Record exact verification results and remaining limitations.

### Task 4: Verify the isolated path and quality gates [x]

**Files:** none

- Run the dedicated browser E2E, relevant Metrics Web/resilience integration tests, lint, root typecheck/build, web typecheck/build, and full default tests where feasible.
- Confirm the test makes no external model request, consumes exactly nine injected failures before opening, makes zero source queries while open, and makes exactly one query for recovery.
- Review `git diff`; do not overwrite unrelated pre-existing changes.

## Completion Record (2026-10-10)

- Dedicated browser E2E: 1/1 passed; asserted six retry events, circuit-open state, zero source queries while open and at 29,999 ms, recovery eligibility only after the final millisecond, one successful recovery query, child/parent evidence linkage, and absence of raw-source marker from public evidence/UI.
- Full default Vitest: 158 files passed, 3 opt-in files skipped; 1,333 tests passed, 7 skipped.
- Lint, root typecheck/build, Web typecheck/build, and `git diff --check`: passed. `corepack pnpm@10 run e2e:circuit` passed when the Node 24 runtime directory was first in `PATH`; the Corepack/pnpm launcher still emitted its Node 20 engine warning, so the Node 24 `node` executable must resolve first for child processes and the SQLite native module.
- No model, LangSmith, Docker, Prometheus endpoint, or target application was contacted. This proves the deterministic simulated application path only; it does not establish production data-source or model quality.
- Existing worktree changes were retained; no commit or push was made.

## Follow-up: Failed Half-open Probe (2026-10-10)

Approved scope: extend the existing deterministic browser sequence with a failed recovery probe, then a second cooldown and successful recovery. Keep the real breaker, MCP, V2 SSE and UI in the path; no public contract, production policy or persistence migration changes.

### Task 5: Cover probe failure and a fresh cooldown [x]

**Files:** `test/e2e/metrics-circuit-web.spec.ts`, `test/e2e/metrics-circuit-fixture-server.mjs`, `test/mcp-resilience.test.ts`

- Preserve the initial threshold/retry, first cooldown, final evidence linkage and public-data assertions.
- Inject exactly one more failure at the first cooldown boundary. Assert the failed probe is not retried, emits another open state without a recovered state, and creates no parent/child evidence.
- Drive new Runs immediately after reopening and at 29,999 ms of the second cooldown; neither may query the source. Only the final millisecond enables another probe; it succeeds exactly once.
- Extend only loopback test controls and scripted scenarios to support the additional Runs; reject premature or duplicate phase changes.
- Add a mechanism test where the probe takes 500 ms, proving cooldown is measured from failure completion rather than the original opening or probe start.
- Run the browser test, focused resilience tests, required quality checks, and update the guide/status with observed results.

### Task 5 Verification

- Red: the expanded browser contract reached the second fault injection and failed with expected 200 / actual 409 against the original single-injection fixture.
- Green: the fixture now drives seven parent Runs; the final browser run passed 1/1 (9.2 s for the scenario). Both 29,999 ms boundaries wait for the actual opened-state UI before checking that recovery is not yet eligible.
- The failed probe consumes the single injected fault without retrying into a successful query; neither failed parent nor child has evidence. Two new Runs during the reopened interval receive `CIRCUIT_OPEN`, and only the final post-cooldown query succeeds.
- Mechanism tests: 13/13 passed, including cooldown from the failed probe's completion after 500 ms of elapsed operation time.
- Default Vitest: 158 files passed, 3 opt-in files skipped; 1,334 tests passed, 7 skipped. Lint, root/Web typechecks, and root/Web builds passed under Node 24. Sandbox dependency-link errors required rerunning checks outside the sandbox; no dependency or lint-policy changes were made.
- Existing changes were preserved. No production code/contracts were changed by Task 5, no real model/data-source calls were made, and no commit/push was performed.

## Follow-up: Prometheus + Circuit Joint Acceptance (2026-10-10)

- Added `pnpm e2e:circuit:prometheus` and a separate Playwright config; the existing `pnpm e2e:circuit` remains independent of Docker/Prometheus.
- The Prometheus fixture uses the real `PrometheusSettlementSource` against the local Compose service. Its wrapper only observes query count and a redacted count summary; it does not replace the query result. Readiness is gated on the simulator scrape returning 100 total/15 failed.
- Red: running the Prometheus-expected contract against the original fixture reported `sourceMode=deterministic`, proving the former circuit E2E bypassed Prometheus.
- Green: Prometheus circuit browser E2E 1/1 passed (16.8 s); circuit-open and blocked requests made zero Prometheus queries; the post-cooldown recovery made exactly one query and observed 100/15. Evidence remained summary/reference-only and omitted the raw metric name. Original deterministic browser E2E 1/1 passed.
- Focused MCP/metrics tests: 4 files, 51 tests passed. Opt-in Prometheus-to-Web tests: 2/2 passed. Full default Vitest: 158 files passed, 3 opt-in files skipped; 1,334 passed, 7 skipped.
- Node 24 root/Web builds, root/Web typechecks, full lint, and `git diff --check` passed. Sandbox initially blocked local loopback HTTP with `EACCES`; reruns outside the sandbox passed. No paid model, LangSmith, production telemetry, or target application was used.
- Local `agentops-metrics` Prometheus Compose service was started for acceptance and remains available on `127.0.0.1:19090`; stop it with `pnpm lab:backend:stop` when no longer needed.
- No production breaker policy, public contracts, persistence schema, or monitored application was changed. Existing worktree edits were preserved; no commit/push was made.
