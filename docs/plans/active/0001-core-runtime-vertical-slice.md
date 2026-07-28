# Active Plan 0001: Core Runtime Vertical Slice

**Status:** Active — M1B PASS; M2 deterministic PASS; M2 live FAIL
**Scope:** Milestones 0–2
**Target outcome:** One durable Gateway-to-Gemini conversation round trip, followed by a coherent second round after restart
**Architecture authority:** `docs/ARCHITECTURE.md`; ADR 0001–0010 and 0015
**Opened:** 2026-07-24

## 1. Requested outcome

Implement the smallest production-shaped core that proves the accepted architecture:

```text
Gateway request
→ application run admission
→ agent/session resolution
→ bounded per-session lane
→ immutable run snapshot
→ deterministic context and prompt plan
→ usage reservation
→ Gemini Interactions model call
→ usage settlement
→ checkpoint and finalization
→ transcript / journal durable commit
→ Gateway terminal result
```

This plan intentionally combines Repository Foundation, Durable Control Plane, and Model Vertical Slice into one active file. The repository harness requires one coordinating active plan for ordered work that spans sessions. Milestones remain separate validation gates inside this plan.

## 2. Required reading before edits

Read only the relevant parts, but do not edit code before checking:

```text
AGENTS.md
docs/WORKFLOW.md
docs/IMPLEMENTATION_PLAN.md
docs/ARCHITECTURE.md
docs/decisions/0001-modular-monolith-and-openclaw-alignment.md
docs/decisions/0002-core-runtime-identities-and-agent-ownership.md
docs/decisions/0003-session-routing-transcript-separation-and-reset-semantics.md
docs/decisions/0004-gateway-control-plane-and-protocol-contract.md
docs/decisions/0005-agent-runtime-harness-and-model-provider-boundaries.md
docs/decisions/0006-run-attempt-lifecycle-and-per-session-serialization.md
docs/decisions/0007-context-assembly-and-transcript-mutation-authority.md
docs/decisions/0009-storage-ownership-sqlite-and-migration-policy.md
docs/decisions/0010-runtime-events-logs-transcripts-and-audit-separation.md
docs/decisions/0015-usage-accounting-and-cumulative-budget-enforcement.md
```

ADR 0008 remains relevant as a negative boundary: this slice advertises no tools and must not accidentally bypass future Tool Runtime policy.

## 3. Preflight and baseline record

Complete this section before implementation.

### 3.1 Inspect the actual repository

- [x] Record the package manager and lockfile.
- [x] Record Node.js and TypeScript versions.
- [x] Record the current source and test directory tree relevant to this plan.
- [x] Record actual scripts for typecheck, lint/format, unit tests, integration tests, and migrations.
- [x] Locate the composition root, configuration loader, database owner, migration runner, Gateway server, method registry, SessionResolver, SessionStore, TranscriptStore, and current test fixtures.
- [x] Confirm whether any planned module already contains non-placeholder code.
- [x] Update the “Observed repository baseline” section below with facts, not assumptions.

### 3.2 Run the unchanged baseline

- [x] Install dependencies using the repository-selected package manager.
- [x] Run typecheck.
- [x] Run lint/format validation.
- [x] Run unit tests.
- [x] Run Gateway/integration tests.
- [x] Run any existing migration validation.
- [x] Record failures that predate this plan separately from new work.

### 3.3 Stop conditions before edits

Stop and update architecture/seek a decision only if the repository requires a materially different choice involving:

- a second production process;
- a second writable database;
- a different public Gateway protocol;
- a different initial model/provider/API surface;
- provider-hosted conversation authority;
- concurrent runs within one session;
- a model call that cannot be reserved and journaled before dispatch;
- weakening required durable evidence.

Do not stop for ordinary implementation choices such as local filenames, private helper types, test-fixture layout, or concrete bounded timeout values that remain configuration.

## 4. Observed repository baseline

Fill this in during preflight.

| Item                  | Observed value                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package manager       | pnpm 11.17.0, pinned in `package.json`; `pnpm-lock.yaml` present                                                                                                                                                                                  |
| Node.js version       | v22.22.0 (repository requires Node.js 22.12+)                                                                                                                                                                                                     |
| TypeScript version    | 7.0.2; `tsconfig.json` uses strict NodeNext compilation from `src/` to `dist/`                                                                                                                                                                    |
| Test runner           | Vitest 4.1.10; `vitest.config.ts` includes `src/**/*.test.ts` (unit, Gateway integration, and migration tests share `pnpm test`)                                                                                                                  |
| SQLite library        | `better-sqlite3` 13.0.1; `src/storage/database.ts` enables WAL and foreign keys                                                                                                                                                                   |
| Migration entry point | `migrateDatabase` in `src/storage/migrate.ts`, registry `src/storage/migrations/index.ts`; migration 001 creates `sessions`                                                                                                                       |
| Bootstrap entry point | `src/index.ts` loads config then calls `createApp` in `src/bootstrap/create-app.ts`                                                                                                                                                               |
| Gateway entry point   | `createGateway` in `src/gateway/create-gateway.ts`; methods are registered in `src/gateway/methods/registry.ts`                                                                                                                                   |
| Baseline commands     | `pnpm install --frozen-lockfile`; `pnpm typecheck`; `pnpm exec prettier --check .`; `pnpm lint`; `pnpm test`                                                                                                                                      |
| Baseline result       | Install and typecheck passed. All 7 test files / 27 tests passed, including Gateway and migration tests. Prettier check failed on 60 pre-existing files (including `.harness-core/` and docs). ESLint failed because no `eslint.config.*` exists. |

Relevant existing implementation: configuration is in `src/config/`; bootstrap currently composes Pino, one SQLite database, migrations, SQLite SessionStore/SessionResolver, and Gateway; migrations are real and idempotency-tested; Gateway has HTTP health, WebSocket framing/handshake, dispatcher, registry and integration tests; sessions have in-memory and SQLite SessionStore implementations plus an in-memory TranscriptStore. `src/agents/`, `src/context/`, `src/models/`, and `src/usage/` do not yet exist. No SQLite TranscriptStore, Run Journal, runtime lane, model provider, or usage ledger exists yet.

## 5. Non-negotiable invariants

The implementation must preserve all of these:

1. Gateway validates and dispatches; it does not implement the agent loop or query SQLite directly.
2. Bootstrap is the only composition root.
3. One logical session has at most one active run and a bounded reject-new FIFO queue.
4. Queue admission succeeds before normal run acceptance, `runId` exposure, or user-input transcript append.
5. Accepted prompts are never merged, evicted, or silently dropped.
6. A run captures one immutable `ResolvedAgentSnapshot` and one target `sessionId`.
7. Transcript sequence numbers are store-assigned and committed in atomic structural batches.
8. `CheckpointStage` is the only authority for continue/complete/retry-attempt/cancel/fail.
9. `FinalizeStage` executes exactly once on every terminal path and cannot start model/tool side effects.
10. Provider/Harness code performs no hidden retry, fallback, continuation, transcript mutation, or terminalization.
11. Every provider dispatch has a durable usage reservation and dispatch marker before network I/O.
12. Ambiguous post-dispatch failure is not treated as zero usage.
13. Successful terminal publication occurs only after required transcript, provider-continuation, usage, and Run Journal writes.
14. Local transcript and continuation sidecars remain conversation authority; Gemini `store=false` is used and `previous_interaction_id` is not used.
15. Raw secrets and thought signatures are never user-visible or placed in ordinary logs/journal metadata.

## 6. Intended module ownership

Use existing repository conventions where they already satisfy ownership. Do not create duplicate parallel abstractions.

```text
src/bootstrap/   concrete composition and lifecycle only
src/config/      validated non-domain configuration and secret references
src/gateway/     protocol, transport, schemas, handlers, client events
src/sessions/    session routing, SessionStore, TranscriptStore, history/reset
src/storage/     shared SQLite lifecycle, migrations, transaction primitives
src/agents/      runtime facade, run admission, lanes, stages, journal contracts
src/context/     ContextManifest, PromptPlan, PreparedModelContext
src/models/      model registry/contracts, Gemini provider adapter
src/usage/       pricing, cap policy, reservations, settlement, usage queries
```

Domain store contracts remain with their owners. Concrete SQLite adapters may stay beside those contracts or under storage according to current repository convention, but dependency direction must remain domain contract ← adapter → SQLite infrastructure.

## 7. Phase A — Baseline stabilization (Milestone 0)

### A1. Configuration and lifecycle

**Work note (2026-07-24):** A concurrent overwrite restored `src/config/config.schema.ts`, `src/config/load-config.ts`, and `src/bootstrap/create-app.ts` to baseline during the first A1 validation. The user confirmed that restoration was unintended; the A1 implementation was reapplied and revalidated.

- [x] Preserve one validated configuration load at startup.
- [x] Add only the configuration required by this plan: database location, Gateway settings, run/capacity bounds, initial agent/model route, Gemini credential reference, usage policy/price inputs, and capture profile.
- [x] Ensure the Gemini secret is resolved only in trusted model infrastructure and is never serializable through ordinary config inspection.
- [x] Keep optional live-provider configuration from blocking deterministic unit/integration tests.
- [x] Verify startup order matches architecture: config → logger → storage/migrations → registries/stores/runtime → Gateway.
- [x] Verify shutdown order stops new work and runtime resources before storage/log closure.

### A2. IDs, time, cancellation, and errors

- [x] Implement or verify distinct validated/branded types and factories for all identities used in this slice.
- [x] Do not use one interchangeable generic ID alias.
- [x] Implement or verify an injectable clock for UTC timestamps, usage windows, timeout tests, and journal ordering metadata.
- [x] Standardize `AbortSignal` propagation from application cancellation through stages and provider transport.
- [x] Define stable typed error envelopes/codes for domain, storage, Gateway, provider, context, queue, and usage failures.
- [x] Normalize raw SQLite/SDK/network errors at their owning boundary.

Implementation note: `src/core/` is a dependency-free foundation for cross-domain typed identities, clock, cancellation, and error contracts; it prevents session, future agent runtime, and future model modules from importing one another for shared primitives. SessionStore outputs now carry branded `agentId`, `sessionKey`, and `sessionId`; `SqliteSessionStore` consumes injected time/ID dependencies and normalizes raw SQLite constraint errors. Linked cancellation scopes and `executeAbortable` have a deterministic application → stage → provider propagation test. `normalizeError` supplies stable error codes for every declared boundary; future concrete provider/stage code must call it at its owning boundary.

### A3. SQLite and migrations

- [x] Reuse one bootstrap-owned database lifecycle.
- [x] Verify foreign-key enforcement and bounded contention behavior.
- [x] Keep model/network work outside transactions.
- [x] Add migrations required by Phases B–D; never edit a migration that has already shipped against persistent data.
- [x] Add fresh-database, current-database, migration-failure, and reopen tests.
- [x] Do not add fallback in-memory persistence when the configured database fails.

Implementation note: no new schema is needed before Phases B–D. Existing migration 001 remains unedited; the migration runner now accepts a test-only migration list, permitting proof that failed migrations rollback both schema and registry write. `openDatabase` enables foreign keys, WAL, and a bounded 5-second busy timeout; all network/model work remains absent from storage transactions.

### A4. Logs and test infrastructure

- [x] Verify Pino redaction for secrets, continuation payloads, prompt bodies, and unrestricted provider payloads.
- [x] Add deterministic temporary-database helpers.
- [x] Add fake clock/ID helpers where existing fixtures do not already cover them.
- [x] Add event and Run Journal collectors that assert typed records, not formatted log text.
- [x] Keep live Gemini tests opt-in and separate from deterministic CI.

Implementation note: `createLogger` redacts direct and nested API-key, authorization, password, continuation, prompt, and provider-payload fields. `src/test/foundation-fixtures.ts` supplies a temporary SQLite lifecycle, fake clock, deterministic UUID IDs, typed event collector, and monotonic typed Run Journal collector. There is no Gemini test or credential resolution in Milestone 0.

### Milestone 0 gate

- [x] Existing tests pass.
- [x] New lifecycle/migration/error/redaction tests pass.
- [x] Actual validation commands and output summaries are recorded in Section 14.
- [x] No accepted public Gateway behavior regressed.

## 8. Phase B — Durable session, transcript, and journal (Milestone 1A)

### B1. Transcript persistence

- [x] Implement or complete SQLite `TranscriptStore`.
- [x] Enforce unique `(sessionId, sequence)`.
- [x] Implement atomic `appendBatch` with expected-tail validation and contiguous store-assigned sequences.
- [x] Persist typed entry classes needed for user input and final assistant output.
- [x] Reserve versioned opaque sidecar storage for provider continuation without exposing raw values in ordinary history reads.
- [x] Implement bounded history reads by sequence and opaque cursors bound to `sessionId` and cursor schema/version.
- [x] Reject cursor reuse against a replacement `sessionId` after reset.
- [x] Add structural validation helpers for complete exchange groups.

### B2. Run Journal persistence

- [x] Add `RunJournalStore` domain contract under `src/agents/`.
- [x] Add SQLite adapter and migration.
- [x] Allocate monotonic per-run journal sequence inside the store.
- [x] Implement bounded reads by `runId` and sequence/cursor.
- [x] Add the minimum required entry schemas for admission, session/lane, transcript, attempt/stage, checkpoint, finalization, and terminal state.
- [x] Keep payloads curated; store hashes/IDs/decisions instead of unrestricted model or prompt bodies.
- [x] Define required versus best-effort journal writes for the active capture profile.

### B3. Runtime event boundary

- [x] Define typed ephemeral runtime events independently from durable journal entries.
- [x] Keep event delivery non-authoritative and bounded.
- [x] Correlate events with `agentId`, `sessionKey`, `sessionId`, `runId`, `attemptId`, and later `modelCallId` where applicable.
- [x] Add a Gateway translation layer; do not pass internal provider SDK events directly to clients.

### Milestone 1A gate

- [x] Transcript and journal reopen tests pass.
- [x] Batch conflict leaves no partial transcript rows.
- [x] Cursor/reset behavior passes.
- [x] Journal sequence remains monotonic under concurrent append attempts for one run.
- [x] No journal table becomes the transcript or usage authority.

## 9. Phase C — Run admission, lanes, and fixed lifecycle (Milestone 1B)

### C1. Transport-neutral run request

- [x] Define a validated application request independent of Gateway transport.
- [x] Resolve omitted agent to configured default `primary`; reject explicitly unknown agents without fallback.
- [x] Resolve/create session through `SessionResolver`; clients never construct canonical persistence keys.
- [x] Reserve a bounded per-session queue slot before normal run acceptance.
- [x] Create/expose `runId` only after validation, agent/session resolution, and queue admission succeed.

### C2. Lane coordinator and runtime capacity

- [x] Implement one in-memory FIFO lane per `(agentId, sessionKey)`.
- [x] Keep the accepted run bound to the captured `sessionId`.
- [x] Add separate bounded runtime-wide model permit seam; do not use it as session ordering.
- [x] Support queued cancellation and active cancellation.
- [x] Ensure connection closure alone has no cancellation authority.
- [x] Guarantee cleanup and lane/permit release under all exceptions.

### C3. Run and attempt lifecycle

- [x] Add durable run/attempt state needed for inspection and terminal proof.
- [x] Keep queued executable work in memory; after restart, do not claim it resumed successfully.
- [x] Implement fixed stage interfaces and coordinator.
- [x] For this phase, Context/Model/Observe may use deterministic test doubles, but all stage boundaries and events must be real.
- [x] Implement `CheckpointStage` decisions and configurable run-local guards.
- [x] Implement exactly-once `FinalizeStage` with cleanup and required durable writes.
- [x] Append user input once per accepted run, never once per attempt.

### C4. Gateway methods

Use existing naming/versioning conventions. Add only the minimal externally useful methods, conceptually equivalent to:

```text
agent.run
run.cancel
run.get
session.history
run.journal
```

- [x] Define TypeBox schemas as external contract authority.
- [x] Validate with existing AJV path.
- [x] Keep handlers thin and application-service based.
- [x] Return structured error codes including `SESSION_RUN_QUEUE_FULL`.

### Milestone 1B gate

- [x] Same-session overlap test passes.
- [x] Three-run FIFO test passes.
- [x] Different-session overlap under a shared capacity test passes.
- [x] Queue-full rejection occurs before transcript append and accepted run exposure.
- [x] Queued and active cancellation tests pass.
- [x] Finalization and lane release pass on complete/fail/timeout/cancel/cleanup exception.
- [x] Required transcript or journal failure prevents `run.completed`.
- [x] Gateway disconnect does not change run outcome.

## 10. Phase D — Agent snapshot, context, Gemini, and usage (Milestone 2)

> **Phase D status (authoritative):** D1–D7 are **CLOSED** and the Milestone 2
> deterministic gate is **PASS** as of implementation commit `55095d4`
> (`55095d4593f39b6d52e9e4cec4ef0b1495ae96f4`). The per-workstream checkboxes
> below are the original Phase D definitions retained for traceability; their
> acceptance is proven by §17.10/§17.14 and the validation in §17.14. M2 live
> is **FAIL** per independent assessment results (§18).

### D1. Agent registry and immutable snapshot — CLOSED (commit 55095d4)

- [ ] Implement `AgentDefinition` and registry contracts under `src/agents/`.
- [ ] Compose one default definition `primary` in bootstrap.
- [ ] Implement availability/bootstrap-state validation needed for admission.
- [ ] Resolve one immutable snapshot per run before model execution.
- [ ] Compute stable `agentRevision`, resource manifest hash, and tool/policy/sandbox/memory fingerprints from authoritative inputs.
- [ ] Set exact route to built-in harness, Gemini Developer API, model `gemini-3.5-flash`, and profile `main-v1`.
- [ ] Keep credentials and mutable store handles out of the snapshot.

### D2. Minimum context pipeline — CLOSED (commit 55095d4)

- [ ] Implement typed source resolution from the snapshot, canonical transcript, and current run input.
- [ ] Build `ContextManifest` with source IDs, roles, hashes, provenance, size, and transformation metadata.
- [ ] Reconstruct complete transcript structural groups.
- [ ] Build deterministic `PromptPlan` `main-v1` with ordered sections and authority/trust/stability/budget metadata.
- [ ] Render immutable structured `PreparedModelContext` separating instruction sections, turns, attachments, tool definitions, and continuation.
- [ ] Validate required sections and total budget.
- [ ] Add a versioned local token estimate; exact provider counting may be invoked only through the model-route contract near configured pressure.
- [ ] With no tools/memory active, ensure their absence is explicit and not represented as implemented capability.

### D3. Harness and model contracts — CLOSED (commit 55095d4)

- [ ] Implement a Harness Registry and register one built-in step harness.
- [ ] Define normalized model request/result/stream/usage/error contracts under `src/models/`.
- [ ] Ensure `src/agents/` and `src/context/` do not import `@google/genai` types.
- [ ] Ensure one harness execution returns one step outcome and cannot privately start a second model cycle.

### D4. Gemini provider — CLOSED (commit 55095d4)

- [ ] Add official `@google/genai` dependency using repository conventions.
- [ ] Implement Gemini Developer API credential resolution in backend-only code.
- [ ] Implement native Interactions API projection with `store=false`.
- [ ] Pin exact model ID `gemini-3.5-flash` in the model catalog/config default.
- [ ] Do not use OpenAI compatibility, Vertex AI, explicit cache objects, or `previous_interaction_id`.
- [ ] Normalize streaming/final text, status/finish, provider IDs, cancellation, retryability, and provider errors.
- [ ] Normalize usage without blindly adding overlapping provider dimensions.
- [ ] Preserve required typed steps/thought signatures as opaque provider-owned sidecars with version/association validation.
- [ ] Fail `MODEL_HISTORY_INCOMPATIBLE` if required continuation is missing or malformed; do not silently collapse history.

### D5. Usage Runtime — CLOSED (commit 55095d4)

- [ ] Implement price-catalog records with immutable revision/effective time.
- [ ] Implement global/agent/provider/model policy matching and UTC day/month windows.
- [ ] Implement durable reservation, dispatch marker, settlement, release, and uncertain states.
- [ ] Make check-plus-reserve one short atomic SQLite transaction across all matching policies.
- [ ] Count active and uncertain reservations conservatively against caps.
- [ ] Keep provider network I/O outside SQLite transactions.
- [ ] If provider usage is exact, replace estimate with actual normalized usage.
- [ ] If provider proves no billable execution, release.
- [ ] If dispatch outcome is ambiguous, retain uncertain accounting.
- [ ] If settlement persistence fails, do not replay the provider call.
- [ ] Record cost as unknown rather than zero when no price applies and no cost cap requires it.
- [ ] Block with `USAGE_PRICING_UNKNOWN` when an active cost cap cannot be evaluated.

### D6. ModelStage, checkpoint, and finalization integration — CLOSED (commit 55095d4)

- [ ] Create `modelCallId` before reservation.
- [ ] Journal reservation request and decision.
- [ ] Mark dispatch durably before sending provider network I/O.
- [ ] Journal normalized model outcome and accounting terminal state.
- [ ] Feed context/model/usage/cancellation signals to `CheckpointStage`.
- [ ] For the no-tool slice, complete on normalized assistant output; unexpected tool requests fail through a typed unsupported-capability path rather than bypassing Tool Runtime.
- [ ] Commit final assistant output and required continuation in an atomic transcript batch.
- [ ] Run `FinalizeStage` once and publish terminal Gateway output after required commits.

### D7. Recovery behavior — CLOSED (commit 55095d4)

- [ ] On startup, release only reservations proven never dispatched.
- [ ] Preserve unresolved dispatched reservations as uncertain/recovery-required.
- [ ] Mark interrupted active runs as not resumed; do not fabricate successful continuation.
- [ ] Preserve durable transcript/journal/usage records for inspection.

### Milestone 2 deterministic gate

Using fake provider and storage fault injection:

- [x] Successful model call.
- [x] Provider rejection before billable execution.
- [x] Provider rate limit/quota error.
- [x] Provider timeout after dispatch.
- [x] Cancellation during provider request.
- [x] Transcript final-batch failure.
- [x] Required journal failure.
- [x] Usage reserve blocked.
- [x] Missing price with active cost cap.
- [x] Settlement failure after provider success.
- [x] Missing/malformed continuation on second model cycle.
- [x] Exactly one terminal outcome and one FinalizeStage execution in every case.

### Milestone 2 live gate

Independent closure assessment result: **FAIL** (3 implementation blockers, 4 evidence gaps, see §18).

Run only when explicitly enabled with a valid host-side Gemini key:

- [x] Start with a fresh persistent database.
- [x] Connect through the real Gateway handshake.
- [x] Submit one prompt to `primary`.
- [ ] Observe run/stage/model/terminal events.
- [ ] Read the committed transcript and journal through application/Gateway APIs.
- [ ] Verify usage ledger settlement and model/price/policy revisions.
- [x] Stop and restart the process.
- [ ] Read the same history/journal/usage records.
- [x] Submit a second prompt in the same logical session.
- [ ] Verify local transcript projection and required continuation produce a coherent reply without provider-hosted session state.

## 11. Schema and migration checklist

Use names consistent with existing migrations. Conceptually, Milestones 0–2 require durable representations for:

- [ ] sessions and current transcript mapping, if not already complete;
- [ ] transcript entries with `(sessionId, sequence)` uniqueness;
- [ ] provider continuation sidecars and association/version metadata;
- [ ] runs and attempts needed for inspection/terminal state;
- [ ] Run Journal entries with `(runId, sequence)` uniqueness;
- [ ] usage reservations and records;
- [ ] usage cap-policy configuration persistence only if operator config is not file-based;
- [ ] price revisions only if not repository/config-file based;
- [ ] schema migration registry/version.

Do not create generic catch-all JSON tables when domain indexes, uniqueness, or atomic operations require explicit schema.

## 12. Minimum test matrix

| Area            | Required tests                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| Gateway         | schema validation, handshake compatibility, method dispatch, structured errors, disconnect behavior              |
| Session routing | omitted/default agent, explicit invalid agent, resolve/create, reset conflict, cursor isolation                  |
| Transcript      | atomic batch, expected-tail conflict, contiguous sequence, structural grouping, reopen                           |
| Run lane        | same-session serialization, FIFO, queue full, queued cancel, active cancel, cleanup                              |
| Journal         | required ordering, per-run monotonic sequence, reopen, required failure semantics                                |
| Snapshot        | immutability, revision/hash determinism, unavailable agent failure                                               |
| Context         | deterministic plan hash/order, authority/trust metadata, invalid history, required-section budget failure        |
| Harness         | one-step behavior, no hidden retry/continue, compatibility selection                                             |
| Gemini adapter  | request projection, `store=false`, error/usage normalization, cancellation, sidecar round trip, secret redaction |
| Usage           | concurrent reservation, all-policy enforcement, price unknown, settle/release/uncertain, crash recovery          |
| Finalization    | exactly once on success/failure/timeout/cancel, commit ordering, lane release                                    |
| End to end      | first prompt, restart, second prompt, durable history/journal/usage                                              |

## 13. Explicitly deferred in this active plan

- Tool execution and tool continuation loops;
- policy/approval/sandbox implementation beyond inactive fingerprints and boundaries;
- file/shell/platform tools;
- Playwright/Chromium;
- context hard clear and production tool-result pruning scenarios;
- curated MemoryStore and FTS5;
- automatic compaction;
- Control UI implementation;
- channels/Telegram;
- plugins and public SDK;
- multiple agents/delegates;
- distributed storage/counters/workers;
- provider/model fallback;
- per-user/channel request quotas.

## 14. Validation evidence log

Update during implementation. Do not pre-fill results.

### Baseline

```text
Commands:
pnpm install --frozen-lockfile
pnpm typecheck
pnpm exec prettier --check .
pnpm lint
pnpm test

Result:
`pnpm install --frozen-lockfile` completed with no changes using pnpm 11.17.0.
`pnpm typecheck` passed.
`pnpm test` passed: 7 files / 27 tests, including Gateway WebSocket and migration tests.
`pnpm exec prettier --check .` failed before implementation: 60 files need formatting, including repository Harness and documentation files.
`pnpm lint` failed before implementation: ESLint 10.7.0 found no `eslint.config.(js|mjs|cjs)`.
```

### Milestone 0

```text
Commands:
pnpm exec prettier --write src/config/config.schema.ts src/config/load-config.ts src/config/load-config.test.ts src/bootstrap/create-app.ts src/bootstrap/create-app.test.ts docs/plans/active/0001-core-runtime-vertical-slice.md
pnpm typecheck
pnpm build
pnpm test
pnpm exec prettier --check src/config/config.schema.ts src/config/load-config.ts src/config/load-config.test.ts src/bootstrap/create-app.ts src/bootstrap/create-app.test.ts docs/plans/active/0001-core-runtime-vertical-slice.md
pnpm lint
git diff --check

Result:
Milestone 0 passed: `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed; `pnpm test` passed 13 files / 45 tests, including existing Gateway WebSocket/migration tests plus configuration lifecycle, branded IDs/clock, linked application-to-provider cancellation, boundary error normalization, SQLite constraints/migration rollback/reopen, redaction, and deterministic fixtures. `git diff --check` passed. Prettier passes for all changed/relevant source files. `pnpm exec prettier --check .` still fails on pre-existing unrelated documentation and Harness formatting; no bulk formatting was performed.
```

### Milestone 1

```text
Commands:
pnpm exec prettier --write src/agents/lifecycle.ts src/agents/session-run-lane.ts src/agents/agent-runtime.ts src/agents/attempt-store.ts src/bootstrap/create-app.ts src/config/config.schema.ts src/config/load-config.ts src/bootstrap/create-app.test.ts src/agents/agent-runtime.test.ts
pnpm typecheck
pnpm test -- --run

Result:
Milestone 1B passed: typecheck passed and Vitest passed 20 files / 69 tests. The runtime persists attempts, has a configured run timeout (`MY_AGENT_RUN_TIMEOUT_MS`, default 60s), uses one FinalizeStage terminalization path, proves transcript/journal failures cannot publish `run.completed`, directly measures different-session overlap under shared capacity, proves cleanup-path lane release, and proves a Gateway WebSocket disconnect does not cancel an admitted run.
```

### Milestone 2 deterministic

```text
Commands:
./node_modules/.bin/tsc -p tsconfig.json --noEmit
./node_modules/.bin/vitest run

Result:
Historical result superseded by remediation evidence below and ultimately by
§17.14. The deterministic gate was PARTIAL here pending native continuation
reconstruction/projection and deterministic terminal-publication/concurrency
evidence; both are now complete and M2 deterministic is **PASS**.
```

### Milestone 2 live Gemini

```text
Command and explicit opt-in configuration:
`GEMINI_API_KEY` loaded from ignored local `.env`; `NODE_ENV=production`, fresh temporary SQLite, and real Gateway on localhost.

Result:
FAIL (Independent M2 live closure assessment synchronized).
Assessment findings:
- 3 Implementation Blockers:
  1. Gateway/runtime event stream contract unfulfilled (only terminal events observed; missing non-terminal run/stage/model lifecycle events).
  2. Incomplete Run Journal timeline (missing mandatory dispatch, settlement, continuation, and terminal outcome records).
  3. Incomplete usage revision evidence (missing full matched policy ID/revision and required revision/rule metadata persistence).
- 4 Evidence Gaps:
  1. Direct SQL inspection used instead of supported application/Gateway APIs.
  2. Full restart persistence not proven via supported APIs.
  3. Lack of conclusive live continuation architecture proof on second prompt.
  4. Non-reproducible evidence bundle (temporary verifier removed).
- 1 P2 Non-Blocking:
  1. Regex import-boundary test (src/test/import-boundaries.test.ts).
```

### Migrations added

```text
006-create-usage-ledger
```

### Lifecycle/timer remediation (2026-07-27)

`src/agents/agent-runtime.test.ts` has one shared `assertTerminalTrace` helper
over `RuntimeLifecycleProbe` markers and synchronous `RuntimeEventBus` delivery.
It asserts exactly one admission marker, checkpoint decision, finalizer start and
completion, durable terminal commit, and terminal event; it also asserts
checkpoint-before-finalize and durable-commit-before-terminal-event, with no
second terminal event. The table-driven executable matrix covers: success;
queued and active cancellation; usage reservation block; provider pre-billable
rejection; post-dispatch disconnect; malformed provider response; continuation
incompatibility; transcript append failure; required journal failure; usage
settlement failure; and cleanup/finalization journal failure. Each row records
decision, durable status, terminal event, and provider-call count; all are
accepted lifecycles in the current runtime contract.

Ordering sleeps were removed from `agent-runtime.test.ts` and
`dispatch-request.test.ts`. Runtime tests now use terminal-event promises,
provider-entry deferred barriers, lane release, and lifecycle markers. The
Gateway dispatcher test uses its terminal RuntimeEventBus promise before closing
the database. The targeted timer audit has no `setTimeout`, `sleep`, or polling
ordering waits. `waitFor` remains as an event-driven Gateway-frame helper;
production timeout behavior is proved by the runtime's `runTimeoutMs` cases
completing via terminal events.

Validation completed: `vitest run src/agents/agent-runtime.test.ts` (54 tests),
`vitest run src/gateway/dispatch-request.test.ts` (10),
`vitest run src/gateway/create-gateway.test.ts` (5), `tsc --noEmit`, `eslint .`,
full `vitest run` (25 files / 140 tests), `git diff --check`, timer audit, and
changed-file Prettier check. This historical validation snapshot is superseded
by the current remediation evidence below.

D1–D7 had implementation evidence pending independent review at this snapshot;
the independent re-audit has since closed them (see §17.14). M2 deterministic is
now **PASS**. M2 live remains NOT RUN.
The base/current Prettier input set was verified from `git diff --name-only
176ca1c`; it currently contains 26 tracked paths, while the working tree also
contains four untracked implementation paths. This is the actual command input,
not an inferred 27-file list.

### Key observable evidence

```text
runId:
_pending_

sessionId and transcript sequence range:
_pending_

Run Journal terminal sequence:
_pending_

usage reservation/record IDs:
Deterministic `UsageBudgetGate` tests use `call-1` through `call-4`; settled records are joined by `usage_reservation_id` during the same reserve transaction.

restart verification:
_pending_
```

## 15. Completion checklist

Do not move this plan to `docs/plans/completed/` until every item is true.

- [x] Milestone 0 gate passes.
- [x] Milestone 1A gate passes.
- [x] Milestone 1B gate passes.
- [x] Milestone 2 deterministic gate passes.
- [ ] Milestone 2 live gate passes, or the repository explicitly classifies it as operator verification and records why CI cannot execute it.
- [ ] All changed externally observable behavior is backed by existing architecture/ADR authority.
- [ ] Architecture “Current repository foundation” is updated only to describe behavior actually implemented and tested.
- [ ] No deferred capability is represented as implemented.
- [ ] Validation evidence is complete and reproducible.
- [ ] Remaining risks and follow-up work are recorded below.

## 16. Remaining risks and follow-up

This plan stays Active because M2 live is **FAIL** (independent live closure assessment). The deterministic
continuation reconstruction/projection and terminal-publication/concurrency
gates are complete and closed (D1–D7 **CLOSED**, M2 deterministic **PASS**);
see §17.14 for synchronized evidence against commit `55095d4`.

### Current remediation status (authoritative)

M0 is **PASS**. M1A is **PASS**. M1B is **PASS**. M2 deterministic is **PASS**
(D1–D7 **CLOSED**, implementation commit `55095d4`). M2 live is **FAIL**.

Terminal persistence uses one SQLite transaction for attempt/run terminal state.
Checkpoint creates an immutable primary plan and failed fallback plan; Finalize
may retry the primary once without a timer, then executes only that authored
fallback. If neither durable plan can commit because storage is unavailable, no
terminal event is fabricated; `run.infrastructure_failed` surfaces the fatal
infrastructure condition while durable state remains unmodified. The next
successful process startup performs fail-closed reconciliation before Gateway
admission: it atomically fails each persisted queued/running run and active
attempt with `RUN_INTERRUPTED`, appends sanitized `run.reconciled` evidence, and
never resumes, replays, retries, or continues the old provider work.
The independent narrow closure re-audit confirmed M1B **PASS**, D1–D7 **CLOSED**,
and M2 deterministic **PASS** against implementation commit `55095d4`; see
§17.14 for the synchronized evidence.

Timer audit: there are no `setTimeout`, `sleep`, or polling ordering waits in
the targeted tests. `waitFor` remains only as an event-driven WebSocket-frame
helper in `src/gateway/create-gateway.test.ts`.

Prettier baseline procedure: enumerate base paths with
`git ls-tree -r --name-only 176ca1c`, pipe each `git show 176ca1c:<path>` to
`prettier --check --stdin-filepath <path>`, then run `prettier --check .` in
the current tree. The exact base and current failure sets are identical:

```text
.agents/skills/audit-onboarding-proposal/SKILL.md
.agents/skills/onboard-repository/SKILL.md
.agents/skills/onboard-repository/references/evidence-capsule-v1.md
.agents/skills/onboard-repository/references/evidence-capsule-v2.md
.harness-core/base/.agents/skills/audit-onboarding-proposal/SKILL.md
.harness-core/base/.agents/skills/onboard-repository/SKILL.md
.harness-core/base/.agents/skills/onboard-repository/references/evidence-capsule-v1.md
.harness-core/base/.agents/skills/onboard-repository/references/evidence-capsule-v2.md
.harness-core/base/AGENTS.md
.harness-core/base/docs/templates/decision.md
.harness-core/manifest.json
AGENTS.md
docs/ARCHITECTURE.md
docs/IMPLEMENTATION_PLAN.md
docs/decisions/0002-core-runtime-identities-and-agent-ownership.md
docs/decisions/0005-agent-runtime-harness-and-model-provider-boundaries.md
docs/decisions/0006-run-attempt-lifecycle-and-per-session-serialization.md
docs/decisions/0007-context-assembly-and-transcript-mutation-authority.md
docs/decisions/0010-runtime-events-logs-transcripts-and-audit-separation.md
docs/decisions/0013-control-ui-and-session-presentation-surfaces.md
docs/decisions/0014-memory-ownership-retrieval-and-evolution.md
docs/decisions/0015-usage-accounting-and-cumulative-budget-enforcement.md
docs/decisions/README.md
docs/templates/decision.md
pnpm-lock.yaml
pnpm-workspace.yaml
```

Set difference is empty: added failures none; changed tracked failures none;
untracked failures none when the changed-plus-untracked set is checked directly.

Deferred P2: `src/test/import-boundaries.test.ts` is regex-based and does not
cover dynamic import, require, export-from, aliases, or path-resolution
variants. A future task should replace it with TypeScript compiler/module
resolver analysis; this remediation does not claim that enforcement is complete.

Historical remediation validation evidence is superseded by the current
startup-reconciliation validation below. The full-repository Prettier baseline
remains the identical 27-file failure set above; changed-plus-untracked
Prettier is checked separately. No live Gemini call was run.

> **Historical remediation narrative (superseded).** The subsections below are
> timestamped working-memory progress logs recorded while the remediation was in
> flight. Any `PARTIAL`, `pending independent review`, `current working tree`,
> `uncommitted working tree`, or "deterministic gates remain open" wording they
> contain predates closure and is **superseded** by the authoritative status in
> the block above and by §17.14 (commit `55095d4`): M1B **PASS**, D1–D7
> **CLOSED**, M2 deterministic **PASS**, M2 live **NOT RUN**, P2 count **1**,
> migration decision **VALID**. They are retained only as traceable history.

### Startup fail-closed reconciliation remediation (historical)

`StartupRunReconciler` runs after migrations/storage initialization and before
`gateway.start()`. It scans durable queued/running runs, atomically marks each
run and any running attempt `failed` with `RUN_INTERRUPTED`, and appends one
sanitized `run.reconciled` journal entry (`process-restart`, `failed`,
`RUN_INTERRUPTED`) in the same SQLite transaction. It does not resume or replay
provider work, transcript content, attempts, or continuations. Usage recovery
releases only proven-undispatched reservations; dispatched reservations become
uncertain and settled reservations remain unchanged. A failed reconciliation
blocks Gateway startup. Repeating startup after a successful reconciliation is
idempotent.

`src/agents/startup-run-reconciler.test.ts` covers queued/no-attempt repair,
running attempt repair, second-startup idempotency, rollback when the run update
fails, uncertain cap preservation across SQLite reopen, and the permanent
terminal-commit-failure restart path without provider replay. The bootstrap test
covers reconciliation failure preventing Gateway startup, then a later healthy
startup repairing the same run. M1B remains **PARTIAL** pending independent
review; M2 deterministic remains **PARTIAL** pending independent review; M2
live remains **NOT RUN**. No checkpoint readiness is claimed.

Current validation: focused runtime 59, sessions 17, storage 7, Gateway 21,
and startup reconciliation 6 tests (verbose reporter); TypeScript and ESLint
exit 0; full Vitest exits 0 (26 files / 169 tests); `git diff --check` and
changed-plus-untracked Prettier exit 0. No live Gemini call was run.

### Remediation evidence (current working tree, uncommitted)

`./node_modules/.bin/tsc -p tsconfig.json --noEmit` exited 0.
`./node_modules/.bin/eslint .` exited 0.
`./node_modules/.bin/vitest run` exited 0: 25 files / 101 tests.
Focused tests `src/models/gemini-interactions-provider.test.ts`,
`src/agents/agent-runtime.test.ts`, and `src/test/import-boundaries.test.ts`
exited 0: 29 tests. The provider projection test proves `store=false`, no
`previous_interaction_id`, and a `gemini-thought-signature-v1` opaque payload
projected as a native `thought` step. The runtime test persists the signature
at transcript sequence 2 for the deterministic `Question` / `Answer` exchange.

The deterministic gate remains PARTIAL pending independent review. The current
suite uses event-driven synchronization rather than sleep-based ordering waits;
M2 live remains NOT RUN.

Continuation Batch A (current working tree): `src/agents/agent-runtime.test.ts`
now proves after real SQLite close/reopen that required continuation payloads
which are empty, whitespace-only, invalid UTF-8, an unsupported schema label,
or an unsupported version fail with `MODEL_HISTORY_INCOMPATIBLE` before a second
provider dispatch. The tests also assert the sentinel opaque signature is absent
from transcript text, Run Journal entries, and terminal runtime events. Provider,
model, session, exchange association, and multiple-sidecar ordering remain
separate unfinished continuation work; M2 deterministic stays PARTIAL.

```text
Live verification requires an operator-supplied GEMINI_API_KEY and remains NOT RUN
for this working tree.
```

The next active plan after completion should cover Tool Runtime, policy, approval, and the first safe tools. It must not be opened as active before this plan is completed or intentionally superseded.

Continuation Batch B1 evidence (uncommitted working tree): migration 008 adds
provider/model/model-call association columns. `src/agents/agent-runtime.test.ts`
proves provider mismatch, exact model mismatch, and missing association metadata
fail after SQLite close/reopen before second provider dispatch. M2 remains PARTIAL.

Continuation Batch B2.1 evidence (uncommitted working tree, 2026-07-27):
`src/agents/agent-runtime.test.ts` proves
`reconstructs continuation when assistant and sidecar model call ids match after reopen`,
`fails after reopen when continuation belongs to another model call`, and
`fails after reopen when continuation-required assistant entry has no model call id`.
Each uses direct SQLite historical persistence, a complete close/reopen, a new
runtime, and a RuntimeEventBus subscription registered before admission. The
matching association completes with one second-runtime provider call; mismatch
and missing assistant metadata fail with `MODEL_HISTORY_INCOMPATIBLE` before
provider dispatch. `src/sessions/sqlite-transcript-store.test.ts` proves
`preserves assistant model call id across SQLite reopen`; migration tests prove
fresh v9, v8-to-v9 upgrade columns/index, and reopen. Reproducible validation:
`vitest run src/models/gemini-interactions-provider.test.ts src/agents/agent-runtime.test.ts src/sessions/sqlite-transcript-store.test.ts src/storage/migrate.test.ts`
exited 0 (4 files / 50 tests); `tsc -p tsconfig.json --noEmit`, `eslint .`, and
`vitest run` exited 0, with the full suite at 25 files / 118 tests. The earlier
hang was fixture synchronization: a promise waited only for `run.completed`
when the actual first-turn failure was hidden; the collector now resolves a
pre-admission subscription from the authoritative admitted `runId`. Milestone
1B status is unchanged; Milestone 2 deterministic remains PARTIAL, and M2 live
remains NOT RUN. Batch B2 remains PARTIAL pending session and exchange mismatch.

Continuation completion evidence (uncommitted working tree, 2026-07-27):
`does not use a continuation belonging to another session after reopen` and
`does not use a continuation belonging to another exchange after reopen` use
real SQLite close/reopen and fail closed with `MODEL_HISTORY_INCOMPATIBLE`
before provider dispatch. `reconstructs multiple continuations in exact
transcript exchange order after reopen` inserts continuation rows in reverse
database insertion order and proves the second runtime projects both opaque
sidecars in transcript exchange order. The lookup authority is the exact
`(session_id, sequence)` primary key, where `sequence` is the assistant
transcript entry association; provider ID, exact model ID, model-call ID, kind,
version, and non-empty payload are validated before dispatch. The
`transcript_continuations` primary key rejects duplicate exact associations.

Continuation close/reopen success, missing/empty/malformed/version mismatch,
provider/model/model-call mismatch, session mismatch, exchange mismatch,
multiple-sidecar ordering, and sentinel non-disclosure are PASS in deterministic
tests. Sentinel checks cover transcript text, durable run/error state, Run
Journal, RuntimeEventBus events, Gateway runtime-event projection, and the
captured Pino logger sink. Reproducible validation: `vitest run
src/agents/agent-runtime.test.ts` exited 0 (1 file / 42 tests); `vitest run
src/models/gemini-interactions-provider.test.ts
src/sessions/sqlite-transcript-store.test.ts src/storage/migrate.test.ts
src/bootstrap/create-logger.test.ts` exited 0 (4 files / 14 tests);
`tsc -p tsconfig.json --noEmit`, `eslint .`, and `vitest run` exited 0, with the
full suite at 25 files / 123 tests. M2 deterministic remains PARTIAL because
non-continuation required gates remain open; M2 live remains NOT RUN.

---

## 17. M2 Deterministic Closure Remediation (closed)

- **Base commit:** `8a45165`
- **Implementation commit:** `55095d4` (`55095d4593f39b6d52e9e4cec4ef0b1495ae96f4`)
- **Status:** `CLOSED — M2 deterministic PASS; M2 live FAIL` (independent assessment synchronized; see §18)
- **M1B:** `PASS`
- **M2 deterministic:** `PASS` (§17.10 acceptance matrix met; D1–D7 CLOSED)
- **M2 live:** `FAIL` (independent M2 live assessment results synchronized)
- **Non-blocking P2 count:** 1 (regex import-boundary enforcement; excluded from this scope)
- **Migration decision:** `VALID` (none required)

This section is a planning-only remediation phase appended to the single active
plan per `docs/WORKFLOW.md` "Durable Planned Change" (one active plan) and
`AGENTS.md` ("Create or update one file under `docs/plans/active/`"). It does not
redesign M1B, D5, D6, or D7. D5–D7 require only regression validation if D1–D4
change their wiring.

### 17.1 Authority hierarchy consulted

1. `AGENTS.md` (composition root ownership, one active plan).
2. `docs/WORKFLOW.md` (Durable Planned Change, Completion Standard).
3. `docs/ARCHITECTURE.md` (§9.4 run/attempt loop; §25 deferred capabilities).
4. ADR 0002 §"Agent revision and lifecycle state" (lines 82, 94, 400): resolved
   snapshot must cover authoritative execution-affecting config and be recorded
   durably per admitted run.
5. ADR 0005 (model/provider ownership; SDK isolated to `src/models/`).
6. ADR 0006 (run lifecycle, checkpoint/finalize authority, startup
   reconciliation, run manifest durable in `run.accepted` journal — line 515).
7. ADR 0007 §"Context budget" (lines 66, 179, 231, 288, 290): section/total
   budgets enforced; protected sections fail typed rather than truncate; typed
   overflow error `PROMPT_REQUIRED_SECTION_EXCEEDS_BUDGET`.
8. `docs/IMPLEMENTATION_PLAN.md` §8 (M2 required work) and §9 (cross-cutting
   gates: no SDK import in `agents`/`context`, no SQLite in gateway/runtime
   domain, no secret/signature in durable artifacts).
9. This active plan §5 invariants and §10 D1–D7 definitions.

### 17.2 Current-state findings (base commit `8a45165`)

| Area | Current implementation                                                                                                                                                                                                                                                                                                                                                                                    | Confirmed gap                                                                                                         | Authority source                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| D1   | `AgentRuntime` builds `this.dependencies.agentRegistry ?? new AgentRegistry()` ([agent-runtime.ts:74-76](src/agents/agent-runtime.ts#L74)); `createApp` does not compose or inject a registry ([create-app.ts:86-102](src/bootstrap/create-app.ts#L86))                                                                                                                                                   | registry not bootstrap-owned; runtime has a fallback path                                                             | ADR 0002:94; IMPL §8:192         |
| D1   | runtime hardcodes `agentId !== "primary"` rejection ([agent-runtime.ts:71-73](src/agents/agent-runtime.ts#L71)) parallel to registry                                                                                                                                                                                                                                                                      | validation duplicated outside registry; silent default to `primary`                                                   | ADR 0002:220; plan §10 D1        |
| D1   | `resourceManifestHash = sha256("primary-v1")` hashes only the revision literal ([agent-registry.ts:35](src/agents/agent-registry.ts#L35))                                                                                                                                                                                                                                                                 | hash does not cover authoritative execution inputs                                                                    | ADR 0002:82,94                   |
| D1   | snapshot `modelRoute`/`harnessId`/`promptProfile` not consumed downstream; only `agentRevision` is journaled ([agent-runtime.ts:279](src/agents/agent-runtime.ts#L279)); harness hardcodes route ([harness.ts:14-15](src/agents/harness.ts#L14)); runtime hardcodes `gemini-developer`/`gemini-3.5-flash` at [agent-runtime.ts:291-292,325-326,351-352,395-396,560-561](src/agents/agent-runtime.ts#L291) | snapshot does not drive execution; parallel constants can diverge                                                     | ADR 0002:94; plan §10 D1         |
| D2   | `PreparedModelContext` carries manifest + per-source `bytes`/`hash` ([prepared-model-context.ts:68-105](src/context/prepared-model-context.ts#L68))                                                                                                                                                                                                                                                       | no token estimation; no configured budget enforcement; no typed pre-dispatch overflow path                            | ADR 0007:66,179,290; IMPL §8:204 |
| D3   | `BuiltinStepHarness` exists and calls provider once ([harness.ts:11-22](src/agents/harness.ts#L11)); runtime instantiates `new BuiltinStepHarness()` privately ([agent-runtime.ts:368](src/agents/agent-runtime.ts#L368))                                                                                                                                                                                 | no `HarnessRegistry`; not bootstrap-owned; `snapshot.harnessId` unused                                                | plan §10 D3; IMPL §8:208         |
| D4   | provider has deterministic fake-client component tests ([gemini-interactions-provider.test.ts:19-33](src/models/gemini-interactions-provider.test.ts#L19)); runtime has integration tests with `FakeModelProvider` ([agent-runtime.test.ts](src/agents/agent-runtime.test.ts)); `createApp` tests omit the provider (`nodeEnv:"test"`, [create-app.test.ts:28,74](src/bootstrap/create-app.test.ts#L28))  | no deterministic test composes application→runtime→harness→real `GeminiInteractionsProvider`→fake client→SQLite→usage | IMPL §8:258-271; plan §10 D4     |

### 17.3 Workstream D1 — Bootstrap-owned agent resolution and authoritative snapshot

#### 17.3.1 Bootstrap ownership

Invariants:

- `createApp` composes one concrete `AgentRegistry` and injects it into `AgentRuntime`.
- Production runtime has **no** fallback `new AgentRegistry()`; the dependency becomes required.
- Runtime removes the hardcoded `agentId !== "primary"` check; unknown agents are rejected only by `AgentRegistry.resolve`.
- No silent fallback to `primary`.

Expected files:

- `src/agents/agent-registry.ts` — keep `resolve` as the single unknown-agent authority; `resolve(undefined)` may still resolve the configured default, but the default identity must come from registry configuration, not a runtime literal.
- `src/agents/agent-runtime.ts` — make `agentRegistry` a required constructor dependency; remove the `?? new AgentRegistry()` fallback (line 75) and the hardcoded `!== "primary"` block (lines 71-73); resolve `agentId` via the registry only.
- `src/bootstrap/create-app.ts` — construct `new AgentRegistry(...)` from `config.agent` and pass it in the `AgentRuntime` dependency bag.
- `src/agents/agent-runtime.test.ts`, `src/bootstrap/create-app.test.ts`, `src/agents/agent-registry.test.ts` — update construction and add cases.

#### 17.3.2 Canonical resource manifest

Define a canonical, non-secret manifest type owned by the registry:

```text
AgentResourceManifest = {
  agentRevision: string
  modelRoute: { providerId, modelId }
  harnessId: string
  promptProfile: "main-v1"
  toolProfile: "none" | explicit marker
  memoryProfile: "none" | explicit marker
  toolRegistryFingerprint, toolPolicyFingerprint,
  sandboxPolicyFingerprint, memoryPolicyFingerprint
  availability: "ready"
}
```

Requirements:

- Canonical serialization is deterministic and **key-order independent** (serialize by sorted property keys; arrays keep semantic order). Owner: `src/agents/agent-registry.ts`.
- `resourceManifestHash = sha256(canonicalJson(manifest))`, created inside the registry.
- Credentials, API keys, env-specific secret values, and mutable store handles are never in the manifest.
- Changing any authority-bearing input changes the hash; identical inputs produce identical hashes; property insertion order does not change the hash.
- `estimatorRevision`/`contextTokenBudget` (from D2) are added to the manifest only if they affect execution identity (decided in phase 4, see §17.8).

Tests: deterministic hash for identical input; hash changes when model route / harness / prompt profile / any fingerprint changes; hash does not contain or depend on the configured secret; canonical serialization is stable across key reordering.

#### 17.3.3 Snapshot-driven execution

Resolved immutable snapshot must drive execution. Remove or convert every parallel constant:

- Provider/model route in the provider request comes from `snapshot.modelRoute` (remove hardcodes at [agent-runtime.ts:291-292,325-326,351-352,395-396,560-561](src/agents/agent-runtime.ts#L291) and [harness.ts:14-15](src/agents/harness.ts#L14)).
- Harness implementation is resolved from `snapshot.harnessId` via the `HarnessRegistry` (D3), removing `new BuiltinStepHarness()` at [agent-runtime.ts:368](src/agents/agent-runtime.ts#L368).
- `snapshot.promptProfile` is passed into context preparation (replacing the implicit `main-v1` in [prepared-model-context.ts](src/context/prepared-model-context.ts)).
- Explicit no-tools / no-memory markers from the snapshot are preserved end-to-end.

#### 17.3.4 Durable snapshot evidence

Schema inspection: `run_journal_entries(run_id, sequence, event_name, payload_json, occurred_at)` ([migration 003](src/storage/migrations/003-create-run-journal.ts)); `payload_json` is free-form TEXT already holding `agentRevision` in `run.accepted` ([agent-runtime.ts:277-280](src/agents/agent-runtime.ts#L277)). ADR 0006:515 requires the run manifest to be durable in `run.accepted`.

**Migration decision for D1 evidence: none.** Enrich the existing `run.accepted` journal `payload_json` with the full canonical snapshot evidence:

```text
{ sessionId, agentRevision, resourceManifestHash,
  modelRoute: { providerId, modelId }, harnessId, promptProfile,
  toolProfile, memoryProfile, fingerprints }
```

- Commit ordering: the enriched `run.accepted` entry is written under lane ownership before model dispatch, unchanged from today's ordering.
- No credential is persisted (manifest excludes secrets).
- Reopen/readback test asserts the enriched payload survives SQLite close/reopen.

#### 17.3.5 D1 tests

- bootstrap injects a concrete registry and the runtime has no fallback.
- runtime construction fails fast if `agentRegistry` is absent (required dependency).
- unknown agent rejected by registry only, no fallback to `primary`.
- snapshot is immutable (`Object.freeze`).
- canonical hash deterministic and key-order independent.
- hash changes when model route / harness / prompt profile / any fingerprint changes.
- hash and journal payload contain no secret.
- snapshot `modelRoute` reaches the provider request.
- snapshot `harnessId` selects the harness implementation.
- enriched `run.accepted` evidence survives reopen.

### 17.4 Workstream D2 — Bounded token estimation and typed overflow

#### 17.4.1 Estimator contract

Add a provider-neutral estimator at the context/model boundary:

```text
TokenEstimator.estimate(input: {
  instructions, turns, continuations
}): { tokens: bigint; estimatorRevision: string }
```

- Deterministic, no network, no Gemini live.
- Owned by `src/models/` (route-specific estimation is model/provider-owned per ADR 0005) and exposed to the context layer through the existing model contract surface; `src/context` and `src/agents` must not import `@google/genai` (cross-cutting gate, IMPL §9).
- A deterministic test double is provided for unit tests.
- `estimatorRevision` versions the estimate because it can affect durable behavior/identity.

Runtime responsibility is orchestration only: context prepares input, estimator returns the count, runtime decides dispatch.

#### 17.4.2 Budget source

- Token budget comes from an authority-bearing source resolved from the agent/model route and prompt profile (e.g., `contextTokenBudget` in `config.agent.model` or a registry-owned budget policy), not from a magic number inside the runtime.
- Budget and `estimatorRevision` become part of `AgentResourceManifest` (§17.3.2) when they affect execution identity.

#### 17.4.3 Overflow behavior

Typed fail-closed path, evaluated **before** provider dispatch:

- `validateCompleteExchangeGroups` runs first (existing).
- Token estimate is computed before any usage reservation or dispatch marker.
- On over-budget: provider is not called; **no** usage reservation, **no** dispatch marker, **no** settlement as if the provider ran.
- The run terminates via the existing typed failure lifecycle (`CheckpointStage` `fail` → `FinalizeStage` exactly once); lane/finalization still release/execute once; transcript/journal behavior follows ADR 0006.
- Complete exchange groups are never cut to "fit" the budget (ADR 0007:231).

Error code: prefer existing typed taxonomy. ADR 0007:290 names
`PROMPT_REQUIRED_SECTION_EXCEEDS_BUDGET`; ADR 0006:149 names
`CONTEXT_BUDGET_EXCEEDED_AFTER_PRUNING`. For this slice's pre-dispatch total-budget
overflow (no pruning), add one code to the existing `AppError` code set in
`src/core/errors.ts` (e.g. `CONTEXT_BUDGET_EXCEEDED`) with its Gateway
serialization mapping. Adding an enum member to the existing typed error taxonomy
is implementation, not a lasting architecture change; **no ADR edit is required in
this remediation** unless implementation discovers it must alter a documented
contract.

#### 17.4.4 D2 tests

- below-budget success; exact-boundary behavior; over-budget typed failure.
- no provider call, no usage reservation/dispatch marker, no partial final transcript on overflow.
- finalization exactly once on overflow.
- complete exchange groups not truncated to fit.
- deterministic `estimatorRevision`.
- manifest/hash reflects budget-relevant authority inputs when contract requires.

### 17.5 Workstream D3 — Harness Registry

#### 17.5.1 Registry ownership

- New concrete `HarnessRegistry` in `src/agents/`, composed by bootstrap and injected into the runtime as a required dependency.
- `resolve(harnessId: string): Harness`; unknown harness fails typed (add `HARNESS_NOT_FOUND` to the `AppError` code set, same owner/serialization rule as D2).
- Runtime no longer calls `new BuiltinStepHarness()`; it resolves via `harnessRegistry.resolve(snapshot.harnessId)`.
- Registry does not import the Gemini SDK.
- Built-in harness still performs exactly one provider execution per step.

#### 17.5.2 Registry and snapshot interaction

Exact flow:

```text
request
→ AgentRegistry.resolve() → immutable snapshot
→ HarnessRegistry.resolve(snapshot.harnessId)
→ context preparation using snapshot.promptProfile
→ harness.executeStep() with provider route from snapshot.modelRoute
```

No downstream re-resolution of `modelRoute`, `harnessId`, or `promptProfile` from unrelated constants.

#### 17.5.3 D3 tests

- built-in harness resolves by id; unknown harness fails before provider dispatch.
- correct harness selected when more than one test harness is registered.
- one step invokes provider exactly once.
- runtime does not instantiate a private harness.
- bootstrap composition provides the registry.
- existing static import-boundary test continues to pass (regex P2 is not expanded here).

### 17.6 Workstream D4 — Deterministic composed provider integration

This is deterministic integration evidence, not Gemini live.

#### 17.6.1 Required test seam (single, concrete)

Seam: an optional composition-root override on `createApp`:

```text
createApp(config, options?: { geminiClient?: InteractionsClient })
```

- `InteractionsClient` is the existing `Pick<GoogleGenAI, "interactions">` type already used by the provider ([gemini-interactions-provider.ts:10](src/models/gemini-interactions-provider.ts#L10)); export it from `src/models/`.
- When `options.geminiClient` is provided, `createApp` constructs `new GeminiInteractionsProvider(apiKey, geminiClient)` and attaches the real provider regardless of `nodeEnv`.
- Production default is unchanged: no override → real `@google/genai` client from the resolved key.
- No global monkey patch; no test-only branch inside domain logic; no credential in logs/snapshot.

#### 17.6.2 Required deterministic composed scenario

One integration suite (new file, e.g. `src/bootstrap/composed-provider-integration.test.ts`) drives, with a fake Gemini client and a temporary SQLite database:

```text
createApp(config, { geminiClient: fake })
→ AgentRegistry → snapshot → HarnessRegistry → AgentRuntime
→ BuiltinStepHarness → GeminiInteractionsProvider → fake Gemini client
→ usage reservation/dispatch/settlement
→ SQLite transcript + continuation persistence
→ checkpoint/finalization → terminal outcome
```

No network.

#### 17.6.3 Assertions

- model id in the Gemini request equals `snapshot.modelRoute.modelId`.
- request uses `store: false`; no `previous_interaction_id`.
- system instructions and input come from the prepared context.
- provider called exactly once per step.
- usage reservation before dispatch; dispatch marker exists before the fake-client invocation.
- normalized usage settled.
- assistant output and continuation sidecar committed atomically per contract.
- terminal completion published only after required durable commits.
- finalization exactly once.

#### 17.6.4 Reopen / continuation scenario

1. run first prompt; persist assistant output + continuation sidecar.
2. close/reopen SQLite (or application boundary per test architecture).
3. run second prompt in the same session.
4. reconstruct complete exchange groups; feed the persisted opaque continuation sidecar with correct association.
5. no remote previous-interaction state.
6. malformed/missing required continuation fails typed (`MODEL_HISTORY_INCOMPATIBLE`) before provider dispatch.

#### 17.6.5 Failure scenario

At least one composed failure test: fake client returns a pre-billable rejection or rate limit; assert correct accounting state (release/uncertain), correct terminal/finalization, no false successful transcript, lane released.

### 17.7 Migration decision

```text
Migration required: NO
```

Justification: the only new durable data is the resolved-snapshot identity evidence.
`run_journal_entries.payload_json` (migration 003) is free-form TEXT and already
holds `agentRevision` in `run.accepted` ([agent-runtime.ts:277-280](src/agents/agent-runtime.ts#L277)).
ADR 0006:515 makes `run.accepted` the durable home of the run manifest. Enriching
that JSON payload with `resourceManifestHash`, `modelRoute`, `harnessId`,
`promptProfile`, and fingerprints does not overload any column's semantics and
needs no schema change. No new snapshot columns are required on `runs`/`attempts`.

### 17.8 Sequencing and dependency graph

Ordered phases (each independently verifiable; no single large commit):

1. **Authority contracts + canonical manifest.** Add `AgentResourceManifest` type, canonical sorted-key serialization, and sha256 hashing in `src/agents/agent-registry.ts`; add `HARNESS_NOT_FOUND` and `CONTEXT_BUDGET_EXCEEDED` to `src/core/errors.ts`. Files: `agent-registry.ts`, `core/errors.ts`. Tests: hash determinism/sensitivity/secret-exclusion. Commit: `feat(agents): canonical agent resource manifest and hash`.
2. **Bootstrap-owned AgentRegistry.** Make `agentRegistry` a required runtime dependency; remove fallback and hardcoded primary validation; compose in `createApp`. Files: `agent-runtime.ts`, `create-app.ts`, `agent-registry.ts`, tests. Depends on: phase 1. Commit: `feat(agents): bootstrap-owned agent registry resolution`.
3. **HarnessRegistry + snapshot-driven dispatch.** Add `HarnessRegistry`, register `builtin-step`, resolve by `snapshot.harnessId`; route provider/model from `snapshot.modelRoute`; pass `snapshot.promptProfile` to context. Files: `agents/harness-registry.ts` (new), `agent-runtime.ts`, `harness.ts`, `create-app.ts`, tests. Depends on: phase 2. Commit: `feat(agents): harness registry and snapshot-driven dispatch`.
4. **Token estimator + budget overflow.** Add provider-neutral `TokenEstimator` + double, resolve budget from config/registry, add pre-dispatch overflow check with `CONTEXT_BUDGET_EXCEEDED`; fold `estimatorRevision`/budget into the manifest if identity-affecting. Files: `models/token-estimator.ts` (new) or extension of contracts, `context/prepared-model-context.ts`, `agent-runtime.ts`, `create-app.ts`, `config/config.schema.ts`, tests. Depends on: phases 1–3. Commit: `feat(context): bounded token estimation and typed overflow`.
5. **Durable snapshot evidence.** Enrich `run.accepted` journal payload; reopen/readback test. Files: `agent-runtime.ts`, tests. Depends on: phases 1–3. Commit: `feat(agents): durable resolved-snapshot evidence in run.accepted`.
6. **Composed provider test seam.** Export `InteractionsClient`, add `createApp(config, { geminiClient })`. Files: `models/gemini-interactions-provider.ts`, `bootstrap/create-app.ts`. Depends on: phases 2–3. Commit: `feat(bootstrap): injectable gemini client composition seam`.
7. **Composed success/reopen/failure tests.** New integration suite. Files: `bootstrap/composed-provider-integration.test.ts` (new). Depends on: phases 1–6. Commit: `test(bootstrap): deterministic composed provider integration`.
8. **Full deterministic regression.** Run §17.9; confirm M1B and D5–D7 still pass. No commit of its own (evidence recorded in §17.12).
9. **Plan/status/evidence synchronization.** Update this plan per §17.11 only after acceptance passes. Commit: `docs(plans): synchronize M2 deterministic status and evidence`.

### 17.9 Validation plan

Exact commands:

```bash
./node_modules/.bin/tsc -p tsconfig.json --noEmit
./node_modules/.bin/eslint .
./node_modules/.bin/vitest run
```

Targeted commands:

```bash
./node_modules/.bin/vitest run src/agents/agent-registry.test.ts
./node_modules/.bin/vitest run src/context/prepared-model-context.test.ts
./node_modules/.bin/vitest run src/agents/harness-registry.test.ts   # new
./node_modules/.bin/vitest run src/agents/agent-runtime.test.ts
./node_modules/.bin/vitest run src/bootstrap/create-app.test.ts
./node_modules/.bin/vitest run src/bootstrap/composed-provider-integration.test.ts   # new
./node_modules/.bin/vitest run src/models/gemini-interactions-provider.test.ts
./node_modules/.bin/vitest run src/storage/migrate.test.ts
```

**Format:** the canonical formatter is `prettier` (`package.json` script
`format` = `prettier --write .`; no `format:check` script exists). The
touched-file check is `./node_modules/.bin/prettier --check <touched-files>`
(equivalently `pnpm exec prettier --check <touched-files>`). Every file this
remediation touches must pass it. Do not broaden scope to format unrelated
baseline files. If the full-repository `prettier --check .` fails on a
pre-existing baseline, the implementation session must record separately: the
full command, the observed baseline failure set, the touched-file format result,
and the set difference. The inherited "27-file failure" claim is **not** an
observed fact until the implementation session reproduces it.

### 17.10 Acceptance matrix

| Gate             | Acceptance condition                                                                                                                                                                                                                | Production evidence                                                                                          | Test evidence        | Validation                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------- | ----------------------------------- |
| D1               | registry bootstrap-owned; no runtime fallback/hardcoded primary; canonical hash over authority inputs; snapshot drives route/harness/prompt; durable snapshot identity survives reopen; no secret persisted                         | `createApp` composes+injects registry; manifest+hash in `agent-registry.ts`; enriched `run.accepted` payload | §17.3.5 cases        | targeted + full vitest; tsc; eslint |
| D2               | deterministic estimator; configured bounded budget; typed overflow before dispatch; no provider/usage-dispatch on overflow; lifecycle/finalization correct                                                                          | `TokenEstimator`; budget from config/registry; `CONTEXT_BUDGET_EXCEEDED` pre-dispatch check                  | §17.4.4 cases        | targeted + full vitest              |
| D3               | `HarnessRegistry` bootstrap-owned; resolves by snapshot; unknown harness typed fail; no private harness instantiation; one-step/one-provider-call invariant                                                                         | `HarnessRegistry`; `resolve(snapshot.harnessId)`; `HARNESS_NOT_FOUND`                                        | §17.5.3 cases        | targeted + full vitest              |
| D4 deterministic | production-shaped composition runs with fake Gemini client; no network; snapshot route reaches provider request; usage/transcript/continuation/finalization proven in one flow; reopen second-cycle passes; failure scenario passes | `createApp(config,{geminiClient})`; real provider + fake client                                              | §17.6.2–17.6.5 cases | composed suite + full vitest        |
| Regression       | M1B tests pass; D5–D7 tests pass; migration suite passes; no skipped tests; typecheck/lint/format pass per policy; M2 live `FAIL`                                                                                                   | unchanged D5–D7 wiring except where D1–D4 touch them                                                         | existing suites      | full vitest; tsc; eslint; format    |

### 17.11 Plan/status synchronization phase (executed against commit 55095d4)

Performed after code and acceptance evidence passed; this synchronization was
applied in the plan commit that records M1B and M2 deterministic closure:

- M1B stays `PASS`.
- D1–D4 checklist items are checked only after their acceptance evidence exists.
- D5–D7 retain status based on regression results.
- M2 deterministic is promoted to `PASS` only when the whole §17.10 matrix passes.
- M2 live is `FAIL` (independent live closure assessment synchronized; see §18).
- Replace every "uncommitted working tree" / "current working tree, uncommitted" wording with the exact commit hash and evidence references.
- Remove the unsupported "non-continuation required gates remain open" claim (§16:786) or replace it with specific gates.
- Fill the `_pending_` key observable evidence with real deterministic values.
- P2 inventory records exactly one repository-backed P2 (regex import-boundaries); no placeholder P2s.
- Do not substitute live evidence for deterministic evidence.

### 17.12 Explicit non-goals

Gemini live round trip; M2 live promotion; regex import-boundary P2 hardening;
compiler-based dynamic-import/alias boundary analyzer; Tool Runtime; browser;
memory; compaction; remote Gateway; additional providers; broad repository
formatting cleanup; unrelated refactors; M1B redesign; D5–D7 redesign.

### 17.13 Risk controls

- **Snapshot schema drift:** canonical manifest is versioned via `agentRevision`/`estimatorRevision`; hash is key-order independent; reopen test guards drift.
- **Duplicate authorities (registry vs runtime constants):** phases 2–3 delete every parallel `gemini-developer`/`gemini-3.5-flash`/`primary`/`builtin-step` literal; a post-phase-3 grep asserts no such literal remains outside the registry.
- **Hash instability:** sorted-key canonical serialization + determinism tests; fixture covers reordering.
- **Accidental secret persistence:** manifest type excludes credentials by construction; journal-payload and hash tests assert no key material.
- **Token-estimate false precision:** estimator returns a conservative bigint estimate plus `estimatorRevision`; budget is a hard gate, not a hint; no claim of provider-exact counting.
- **Overflow after usage reservation:** overflow check is placed before reservation/dispatch in the runtime; D2 tests assert no reservation/dispatch marker on overflow.
- **Registry fallback hiding config errors:** `agentRegistry` and `harnessRegistry` are required dependencies; construction fails fast if absent; no `?? new ...()` fallback remains.
- **Provider factory seam becoming test-only architecture:** the seam is a composition-root override using an already-existing provider constructor parameter; production default path is unchanged and typechecked; the composed suite exercises the real provider.
- **Composed tests calling network:** the suite injects only a fake client; a test asserts the fake client was the sole `interactions.create` caller; no `GEMINI_API_KEY` is set in the suite.
- **Migration compatibility:** no migration in this remediation (decision NO); the migration suite still runs unchanged to prove no regression.
- **Continuation association after reopen:** the reopen scenario (§17.6.4) reuses the existing `(session_id, sequence)` association and `MODEL_HISTORY_INCOMPATIBLE` checks.
- **M1B regression from composition change:** phase 8 runs the full suite; M1B lane/FIFO/cancellation/finalization tests must remain green before synchronization.

### 17.14 Implementation evidence (commit 55095d4)

Status wording after the narrow closure re-audit and synchronization:

```text
Narrow D1/D3/D4 and formatting remediation closed;
independent re-audit confirmed M1B PASS, D1-D7 CLOSED, M2 deterministic PASS;
independent M2 live assessment synchronized as FAIL.
```

An independent read-only narrow closure re-audit (base commit `8a45165`,
implementation commit `55095d4`) confirmed D1, D3, D4, and the format/evidence
gates are CLOSED, D2 and D5-D7 regression remains green, and no Decision/ADR
violation exists. M2 deterministic is promoted to `PASS` and the §15 / §10
checkboxes are checked. M2 live is `FAIL` following the independent live assessment (§18).

#### Files changed (production)

- `src/core/errors.ts` — added `HARNESS_NOT_FOUND` and `CONTEXT_BUDGET_EXCEEDED` to the `AppErrorCode` union (serialization flows through existing `toErrorEnvelope`; no ADR change).
- `src/agents/agent-registry.ts` — `AgentResourceManifest`, `AgentDefinition`, `ResolvedAgentSnapshot`; key-order-independent `canonicalize` + `hashResourceManifest` (sha256); `AgentRegistry` constructed from definitions, duplicate ids fail, unknown agents fail typed (`DOMAIN_VALIDATION_FAILED` / `AGENT_NOT_FOUND`) with no fallback.
- `src/agents/harness.ts` — `Harness` interface + `HarnessModelRoute`; `BuiltinStepHarness.executeStep` takes `modelRoute` from the caller (no parallel route constant).
- `src/agents/harness-registry.ts` (new) — `HarnessRegistry`, composed by bootstrap, resolves by id, unknown → `HARNESS_NOT_FOUND`, duplicate ids fail at construction, no SDK import.
- `src/models/token-estimator.ts` (new) — provider-neutral `TokenEstimator` + `HeuristicTokenEstimator` (`revision = "heuristic-v1"`, UTF-8 byte heuristic, deterministic, no network/SDK).
- `src/context/prepared-model-context.ts` — `prepareModelContext` accepts `promptProfile` (defaults `main-v1`); output uses the resolved profile.
- `src/config/config.schema.ts` — added `agent.model.contextTokenBudget` (default 12000). Estimator revision is owned by the estimator instance, not config (drift-proof).
- `src/agents/agent-runtime.ts` — `agentRegistry`, `harnessRegistry`, `tokenEstimator` are required dependencies; removed the `?? new AgentRegistry()` fallback and the hardcoded `!== "primary"` validation; provider/model route, harness resolution, prompt profile, and continuation association all flow from `snapshot`; added pre-dispatch `CONTEXT_BUDGET_EXCEEDED` overflow check before usage reservation; enriched `run.accepted` journal payload with non-secret snapshot identity.
- `src/bootstrap/create-app.ts` — composes `AgentRegistry` (primary definition from config + estimator revision), `HarnessRegistry` (`builtin-step`), `HeuristicTokenEstimator`; injects all three into `AgentRuntime`; added `createApp(config, { geminiClient? })` composition seam; `App` exposes `runtime`.
- `src/models/gemini-interactions-provider.ts` — exported `InteractionsClient` type for the composition seam.
- `src/test/foundation-fixtures.ts` — added `primaryAgentDefinition` and `createRuntimeAuthority()` test helper (no production fallback).

#### Files changed (tests)

- `src/agents/agent-registry.test.ts` — D1 manifest/hash tests (deterministic, key-order independent, sensitivity to route/harness/prompt/fingerprint/budget, no secret, unknown/duplicate fail).
- `src/agents/harness-registry.test.ts` (new) — D3 registry tests (resolve by id, unknown typed fail, duplicate fail, two-harness selection, one provider call).
- `src/agents/context-budget-overflow.test.ts` (new) — D2 overflow tests (within budget dispatches; over budget fails `CONTEXT_BUDGET_EXCEEDED` with zero provider calls, no reservation, no assistant transcript, terminal failure, finalization once, lane release; no exchange-group truncation; deterministic unicode estimate).
- `src/test/composed-provider-integration.test.ts` (new) — D4 composed flow through `createApp` with a fake Gemini client (success, reopen second-cycle continuation reconstruction, pre-billable 429 failure); asserts snapshot route in request, `store:false`, no `previous_interaction_id`, usage settle, atomic continuation sidecar, finalization once, durable non-secret `run.accepted` payload surviving reopen.
- `src/agents/agent-runtime.test.ts`, `src/agents/startup-run-reconciler.test.ts`, `src/gateway/create-gateway.test.ts`, `src/gateway/dispatch-request.test.ts`, `src/models/gemini-interactions-provider.test.ts`, `src/bootstrap/create-app.test.ts`, `src/config/load-config.test.ts` — updated constructions to inject the required authority dependencies via `createRuntimeAuthority()` and the new config field.

#### Migration decision (actual)

```text
Migration required: NO
```

The resolved-snapshot identity is stored as enriched JSON in the existing
`run_journal_entries.payload_json` column (migration 003), which already held
`agentRevision`. No schema column is overloaded; no new column or index was
needed. The migration suite (`src/storage/migrate.test.ts`) runs unchanged.

#### Validation executed (deterministic, no network, no Gemini live)

```text
./node_modules/.bin/tsc -p tsconfig.json --noEmit   -> exit 0
./node_modules/.bin/eslint .                         -> exit 0
./node_modules/.bin/vitest run                       -> exit 0 (29 files / 213 tests)
```

Touched-file Prettier check over the actual source/test/plan files changed in
the working tree (tracked-modified plus new source/test files plus this plan
file; excluding `note.md` and non-source meta files such as `.gitignore`):

```text
./node_modules/.bin/prettier --check <23 touched .ts/.md files> -> exit 0
```

The prior implementation-session block here reported "187 tests" and a
touched-file Prettier result of "all pass". Both were stale/false by this
remediation: the D1/D3/D4 work added tests (total now 213), and this plan file
itself failed Prettier until it was reformatted with `prettier --write` in this
session. No tests are skipped. The full-repository `prettier --check .` was NOT
run by this session; no inherited repository-wide Prettier failure count is
recorded here as an observed fact. Only the touched files above were formatted
(`prettier --write` on this plan file and on the two new test files added by
this remediation).

#### Acceptance self-assessment

| Area       | Acceptance condition                            | Evidence                                                                                                | Status |
| ---------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------ |
| D1         | Registry bootstrap-owned, no runtime fallback   | create-app.ts compose+inject; agent-runtime.ts required dep, no fallback/hardcoded primary              | MET    |
| D1         | Canonical manifest hashes all authority inputs  | agent-registry.ts `hashResourceManifest`; agent-registry.test.ts                                        | MET    |
| D1         | Snapshot drives route/harness/prompt/budget     | agent-runtime.ts uses snapshot.modelRoute/harnessId/promptProfile/contextTokenBudget; hardcodes removed | MET    |
| D1         | Durable non-secret snapshot survives reopen     | enriched run.accepted payload; composed reopen test reads it after close/reopen                         | MET    |
| D2         | Versioned deterministic estimator exists        | token-estimator.ts HeuristicTokenEstimator revision heuristic-v1                                        | MET    |
| D2         | Budget comes from resolved authority            | snapshot.contextTokenBudget from config via registry                                                    | MET    |
| D2         | Overflow fails before reservation/dispatch      | agent-runtime.ts overflow check before reserve; context-budget-overflow.test.ts                         | MET    |
| D3         | HarnessRegistry bootstrap-owned                 | create-app.ts composes HarnessRegistry                                                                  | MET    |
| D3         | Unknown harness typed failure, no fallback      | harness-registry.ts HARNESS_NOT_FOUND; harness-registry.test.ts                                         | MET    |
| D3         | One step invokes provider once                  | BuiltinStepHarness + harness-registry.test.ts                                                           | MET    |
| D4         | Composed real-provider/fake-client success flow | composed-provider-integration.test.ts                                                                   | MET    |
| D4         | Reopen second-cycle flow                        | composed-provider-integration.test.ts reopen case                                                       | MET    |
| D4         | Composed failure flow                           | composed-provider-integration.test.ts 429 case                                                          | MET    |
| Regression | M1B remains green                               | full vitest 213/213 (lane/FIFO/cancel/finalize/disconnect tests pass)                                   | MET    |
| Regression | D5–D7 remain green                              | usage-budget-gate, agent-runtime usage/recovery, startup-run-reconciler tests pass                      | MET    |
| Validation | typecheck/lint/full test/touched format pass    | tsc/eslint/vitest exit 0; prettier touched pass                                                         | MET    |
| Live       | Gemini live assessment synchronized             | live execution evaluated; M2 live FAIL                                                                  | FAIL   |

#### P2 inventory (unchanged)

Repository-backed P2 count for this milestone: **1** (regex-based import-boundary
enforcement, §16:666). It is `P2 NON-BLOCKING` and was NOT expanded in this
session. No placeholder P2s exist.

#### Remaining gaps

M2 live exhibits 3 production implementation blockers and 4 evidence gaps (§18).

---

## 18. Independent M2 Live Assessment Synchronization

- **Assessment Date:** 2026-07-28
- **Working Tree Checkpoint:** `e04a388995e1ad3429f1074645daa175f4a06b04` (clean)
- **Synchronized Status:** `M1B PASS; M2 deterministic PASS; M2 live FAIL`

### 18.1 Executive Assessment Summary

The independent live closure assessment of Milestone 2 (M2 live) evaluated execution against the production runtime path using a host-side Gemini API key and persistent storage.

Conclusions:

- **M1B:** Retained as **PASS**.
- **M2 deterministic (D1–D7):** Retained as **PASS**.
- **M2 live:** Evaluated as **FAIL**.
- **P2 non-blocking count:** Retained as **1** (`P2 NON-BLOCKING`: regex-based import boundary test).

### 18.2 Categorized Assessment Findings

#### IMPLEMENTATION BLOCKER (Production Runtime Blockers)

1. **Gateway/runtime event stream contract unfulfilled**
   - _Finding:_ The live run observed only terminal events (e.g. `run.completed` / `run.failed`).
   - _Details:_ The production runtime has not emitted the full set of non-terminal run, stage, model, and tool lifecycle events required for the Gateway to forward to connected clients per contract (ADR 0004 & ADR 0010).
   - _Invariant:_ Run Journal rows cannot be substituted for Gateway runtime streaming events.

2. **Incomplete Run Journal timeline**
   - _Finding:_ Live evidence lacks mandatory lifecycle records in the durable journal.
   - _Details:_ Missing records include at least dispatch, settlement, continuation evidence, and terminal journal outcome (or equivalent taxonomy per ADR 0006).
   - _Invariant:_ The journal does not yet fully demonstrate the complete end-to-end sequence: `reservation → dispatch → model outcome → settlement → continuation/checkpoint → finalization → terminal lifecycle`.

3. **Incomplete usage revision evidence**
   - _Finding:_ Usage revision and rule metadata persistence is incomplete.
   - _Details:_ While basic reservation/settlement and price revisions were demonstrated at existing levels, the system has not fully proven or persisted the matched policy ID/revision and required rule/revision metadata according to the usage accounting contract (ADR 0015).

#### EVIDENCE GAP (Verification & API Protocol Gaps)

1. **Direct SQL inspection dependency**
   - _Transcript and Run Journal validation:_ Checked primarily via direct SQLite queries rather than through supported application or Gateway APIs.

2. **Restart state retrieval via supported APIs**
   - _Persistence verification:_ Complete state persistence across restart (history, journal, and usage records) was not fully demonstrated using supported Gateway / application APIs.

3. **Inconclusive live continuation architecture proof**
   - _Second prompt evaluation:_ While the second prompt demonstrated contextual coherence, the evidence is insufficient to conclusively prove that the host-owned outbound continuation architecture was utilized during live execution.

4. **Non-reproducible evidence bundle**
   - _Artifact integrity:_ The temporary verifier script/tool was deleted, leaving the evidence bundle non-reproducible in its current state.

#### P2 NON-BLOCKING

- **Regex-based import-boundary test (`src/test/import-boundaries.test.ts`)**
  - Retained as `P2 NON-BLOCKING`. Excluded from this docs synchronization workstream.

#### STALE DOCUMENTATION / PLAN STATE

- Prior documentation state referencing M2 live as `NOT RUN` or `CANDIDATE PASS` has been synchronized to **FAIL** across all plan summaries and status sections.

### 18.3 Next Workstream Direction

A future workstream will address the three production implementation blockers (Gateway lifecycle event emission, complete Run Journal timeline logging, and full usage policy revision persistence) and close the four evidence gaps using supported Gateway/application APIs before re-evaluating M2 live.
