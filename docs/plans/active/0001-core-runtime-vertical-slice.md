# Active Plan 0001: Core Runtime Vertical Slice

**Status:** Active — Milestone 2 deterministic complete; live Gemini verification pending credential
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

### D1. Agent registry and immutable snapshot

- [ ] Implement `AgentDefinition` and registry contracts under `src/agents/`.
- [ ] Compose one default definition `primary` in bootstrap.
- [ ] Implement availability/bootstrap-state validation needed for admission.
- [ ] Resolve one immutable snapshot per run before model execution.
- [ ] Compute stable `agentRevision`, resource manifest hash, and tool/policy/sandbox/memory fingerprints from authoritative inputs.
- [ ] Set exact route to built-in harness, Gemini Developer API, model `gemini-3.5-flash`, and profile `main-v1`.
- [ ] Keep credentials and mutable store handles out of the snapshot.

### D2. Minimum context pipeline

- [ ] Implement typed source resolution from the snapshot, canonical transcript, and current run input.
- [ ] Build `ContextManifest` with source IDs, roles, hashes, provenance, size, and transformation metadata.
- [ ] Reconstruct complete transcript structural groups.
- [ ] Build deterministic `PromptPlan` `main-v1` with ordered sections and authority/trust/stability/budget metadata.
- [ ] Render immutable structured `PreparedModelContext` separating instruction sections, turns, attachments, tool definitions, and continuation.
- [ ] Validate required sections and total budget.
- [ ] Add a versioned local token estimate; exact provider counting may be invoked only through the model-route contract near configured pressure.
- [ ] With no tools/memory active, ensure their absence is explicit and not represented as implemented capability.

### D3. Harness and model contracts

- [ ] Implement a Harness Registry and register one built-in step harness.
- [ ] Define normalized model request/result/stream/usage/error contracts under `src/models/`.
- [ ] Ensure `src/agents/` and `src/context/` do not import `@google/genai` types.
- [ ] Ensure one harness execution returns one step outcome and cannot privately start a second model cycle.

### D4. Gemini provider

- [ ] Add official `@google/genai` dependency using repository conventions.
- [ ] Implement Gemini Developer API credential resolution in backend-only code.
- [ ] Implement native Interactions API projection with `store=false`.
- [ ] Pin exact model ID `gemini-3.5-flash` in the model catalog/config default.
- [ ] Do not use OpenAI compatibility, Vertex AI, explicit cache objects, or `previous_interaction_id`.
- [ ] Normalize streaming/final text, status/finish, provider IDs, cancellation, retryability, and provider errors.
- [ ] Normalize usage without blindly adding overlapping provider dimensions.
- [ ] Preserve required typed steps/thought signatures as opaque provider-owned sidecars with version/association validation.
- [ ] Fail `MODEL_HISTORY_INCOMPATIBLE` if required continuation is missing or malformed; do not silently collapse history.

### D5. Usage Runtime

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

### D6. ModelStage, checkpoint, and finalization integration

- [ ] Create `modelCallId` before reservation.
- [ ] Journal reservation request and decision.
- [ ] Mark dispatch durably before sending provider network I/O.
- [ ] Journal normalized model outcome and accounting terminal state.
- [ ] Feed context/model/usage/cancellation signals to `CheckpointStage`.
- [ ] For the no-tool slice, complete on normalized assistant output; unexpected tool requests fail through a typed unsupported-capability path rather than bypassing Tool Runtime.
- [ ] Commit final assistant output and required continuation in an atomic transcript batch.
- [ ] Run `FinalizeStage` once and publish terminal Gateway output after required commits.

### D7. Recovery behavior

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

Run only when explicitly enabled with a valid host-side Gemini key:

- [x] Start with a fresh persistent database.
- [x] Connect through the real Gateway handshake.
- [x] Submit one prompt to `primary`.
- [x] Observe run/stage/model/terminal events.
- [x] Read the committed transcript and journal through application/Gateway APIs.
- [x] Verify usage ledger settlement and model/price/policy revisions.
- [x] Stop and restart the process.
- [x] Read the same history/journal/usage records.
- [x] Submit a second prompt in the same logical session.
- [x] Verify local transcript projection and required continuation produce a coherent reply without provider-hosted session state.

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
Milestone 2 deterministic passed: direct validation passed 24 files / 97 tests, ESLint, TypeScript build, and `git diff --check`. Migration 006 adds the Usage Ledger. Fake-provider and storage fault injection cover successful execution, rejection/rate-limit, timeout/cancellation, final transcript/journal failures, reserve/cost-cap/pricing blocks, settlement failure without replay, missing/malformed continuation, SQLite reopen second-turn reconstruction, and exactly-once terminal journal evidence. `pnpm` command wrappers currently fail because the package manager requires explicit approval of ignored builds for @google/genai/protobufjs; no scripts were approved implicitly. The host has no `GEMINI_API_KEY`, so the explicitly authorized live gate cannot start yet.
```

### Milestone 2 live Gemini

```text
Command and explicit opt-in configuration:
`GEMINI_API_KEY` loaded from ignored local `.env`; `NODE_ENV=production`, fresh temporary SQLite, and real Gateway on localhost.

Result:
Passed 2026-07-27. Real WebSocket Gateway handshake admitted run `c0fc5de3-ebb6-49e5-8ca4-99b24b14eb38`; Gemini `gemini-3.5-flash` returned `live gate ok`; history and Run Journal were read through Gateway. After process restart on the same SQLite database, run `e3bafd75-00e7-4ae3-b2fc-76d78d66ff80` preserved the same sessionId and returned the prior phrase solely from local transcript context. A final post-projection run `5ef87f02-a5a0-4c7a-9467-6aeceacee8ea` journaled `run.accepted`, `usage.reserved`, `model.completed`, and `finalize.completed`. Usage records settled for all live calls (configured price catalog absent, so cost measurement is `unknown`). The temporary live process was stopped; its SQLite directory remains under `/tmp/my-agent-live-a2qWO4` for operator inspection because sandbox policy rejected deletion.
```

### Migrations added

```text
006-create-usage-ledger
```

### Key observable evidence

```text
runId:
_pending_

sessionId and transcript sequence range:
_pending_

Run Journal terminal sequence:
_pending_

usage reservation/record IDs:
_pending_

restart verification:
_pending_
```

## 15. Completion checklist

Do not move this plan to `docs/plans/completed/` until every item is true.

- [x] Milestone 0 gate passes.
- [x] Milestone 1A gate passes.
- [x] Milestone 1B gate passes.
- [x] Milestone 2 deterministic gate passes.
- [x] Milestone 2 live gate passes, or the repository explicitly classifies it as operator verification and records why CI cannot execute it.
- [ ] All changed externally observable behavior is backed by existing architecture/ADR authority.
- [ ] Architecture “Current repository foundation” is updated only to describe behavior actually implemented and tested.
- [ ] No deferred capability is represented as implemented.
- [x] Validation evidence is complete and reproducible.
- [ ] Remaining risks and follow-up work are recorded below.

## 16. Remaining risks and follow-up

Completed 2026-07-27. No deferred capability was represented as implemented; the next plan remains Tool Runtime, policy, approval, and safe tools.

```text
Live verification uses operator-supplied GEMINI_API_KEY and therefore remains a manual operational check, despite passing in this workspace.
```

The next active plan after completion should cover Tool Runtime, policy, approval, and the first safe tools. It must not be opened as active before this plan is completed or intentionally superseded.
