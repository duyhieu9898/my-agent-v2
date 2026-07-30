# my-agent-v2 V1 Implementation Plan

**Status:** Execution in progress — Milestone 3 active
**Architecture baseline:** `docs/ARCHITECTURE.md` and ADR 0001–0015
**Active execution plan:** `docs/plans/active/0002-tool-runtime.md`
**Last updated:** 2026-07-28

## 1. Purpose

This document converts the accepted `my-agent-v2` architecture into an implementation sequence.

The immediate objective is not to implement every accepted subsystem. It is to prove one durable, observable, end-to-end agent path:

```text
local client
→ Gateway
→ validated run admission
→ SessionResolver and per-session lane
→ immutable agent snapshot
→ ContextManifest / PromptPlan / PreparedModelContext
→ Gemini Interactions API
→ usage settlement
→ transcript and Run Journal commit
→ terminal response
```

After this path works and survives restart, the remaining tool, browser, pruning, memory, and UI capabilities can be added behind already accepted boundaries.

## 2. Execution rules

Implementation follows these rules:

1. The repository is the system of record. Inspect the current tree and existing tests before creating or replacing code.
2. `AGENTS.md`, `docs/WORKFLOW.md`, `docs/ARCHITECTURE.md`, and accepted ADRs are implementation authority.
3. Architecture documents define boundaries and invariants. The active plan defines task-local sequencing and file-level implementation choices.
4. Work proceeds as vertical slices with executable evidence, not as disconnected framework construction.
5. Keep one active execution plan for the current coordinated workstream. Move it to `docs/plans/completed/` only after its accepted exit criteria pass.
6. Existing behavior must be preserved unless an accepted ADR explicitly replaces it.
7. No document may claim a subsystem is implemented until code and relevant tests exist.
8. New architecture decisions require a new ADR. Local naming, file organization, or test-fixture choices remain in the active plan.
9. Secrets, raw Gemini thought signatures, private reasoning, and unrestricted payloads must not enter logs, normal Gateway payloads, transcripts, or Run Journal metadata.
10. Completion claims require actual commands, test output, migration evidence, and an end-to-end observable run.

## 3. Current repository baseline

The accepted architecture records that the repository already contains foundations for:

```text
src/bootstrap/
src/config/
src/gateway/
src/sessions/
src/storage/
```

Existing behavior includes application lifecycle, configuration loading, an HTTP health endpoint, WebSocket Gateway framing and handshake, TypeBox/AJV validation, session routing concepts, SessionStore contracts, an in-memory TranscriptStore, a SQLite SessionStore, migrations, and unit/Gateway integration tests.

The first implementation task is therefore a baseline audit and extension of the current code. It is not a greenfield rewrite.

Reserved module roots such as `src/agents/`, `src/context/`, `src/models/`, and `src/usage/` are architectural seams until code and tests prove implementation.

## 4. V1 delivery sequence

| Milestone                     | Outcome                                                                                                         | Exit signal                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **0 — Foundation hardening**  | Existing repository foundation is understood, repeatable, and ready for durable runtime work.                   | Baseline and new foundation tests pass; startup, migrations, shutdown, IDs, errors, clocks, config, and logging have explicit ownership. |
| **1 — Durable control plane** | Gateway can admit, serialize, inspect, and persist run/session evidence without a model call.                   | Same-session FIFO and different-session concurrency tests pass; transcript and journal survive restart.                                  |
| **2 — Model vertical slice**  | One prompt reaches pinned Gemini through the host-owned runtime pipeline and commits a durable terminal result. | End-to-end prompt succeeds with transcript, journal, usage ledger, cancellation/failure behavior, and restart verification.              |
| **3 — Tool Runtime**          | Model requests can execute policy-controlled host tools and continue through checkpoints.                       | Safe read-only tools and one controlled side-effect path pass lifecycle, policy, transcript, and retry tests.                            |
| **4 — Browser Runtime**       | Playwright/Chromium executes observe–act–observe operations through Tool Runtime.                               | Browser lifecycle, stale refs, artifacts, navigation policy, cancellation, and evidence tests pass.                                      |
| **5 — Context robustness**    | Large tool-heavy histories are bounded predictably.                                                             | Source caps, soft pruning, exact preflight threshold, and overflow behavior pass structural tests.                                       |
| **6 — Curated memory**        | Explicit cross-session memory is searchable and recallable.                                                     | SQLite FTS5, provenance, policy-controlled writes, snapshot recall, and prompt-section evidence pass.                                    |
| **7 — Control UI**            | Local users can inspect and operate sessions, runs, usage, memory, and artifacts through Gateway APIs.          | UI remains a pure Gateway client and all primary operational surfaces work.                                                              |

Milestone 3 is active under `docs/plans/active/0002-tool-runtime.md`. M3-R2
closed at `9c9792c3ebe8153c20427a4992c0c32d10d75796`; M3-R3-1 workspace
containment and symlink safety closed at
`9861678e7daa1b61e1736afa80fb7276a321e2ad`. M3-R3 remains in progress;
M3-R3B — fs-safe create/write publication and TOCTOU safety (M3-R3-2) is the next
checkpoint. Overall M3 remains open under the active plan.
Milestones 4–7 remain queued. Their detailed execution plans should be created
only when the preceding milestone has validated its dependencies.

## 5. Critical path

```text
Milestone 0
  repository proof and lifecycle foundation
        ↓
Milestone 1
  durable sessions, transcript, run lane, journal
        ↓
Milestone 2
  immutable agent snapshot, context, Gemini, usage, finalization
        ↓
Milestone 3
  Tool Runtime and policy
        ↓
Milestone 4
  Playwright browser
        ↓
Milestone 5
  production-strength context pressure handling
        ↓
Milestone 6
  curated memory
        ↓
Milestone 7
  operational Control UI
```

The first externally meaningful product checkpoint is the completion of Milestone 2.

## 6. Milestone 0 — Foundation hardening

### Milestone 0 goal

Make the existing foundation safe to extend without changing its accepted modular-monolith direction.

### Milestone 0 required work

- Inventory actual package manager, TypeScript configuration, scripts, test runner, migration runner, and source tree.
- Run and record the unmodified baseline validation commands.
- Reconcile current code with the “Current repository foundation” section of `docs/ARCHITECTURE.md`.
- Preserve the existing Gateway protocol, TypeBox/AJV contract ownership, and startup/shutdown behavior.
- Ensure all persistent stores share one bootstrap-owned SQLite lifecycle.
- Ensure migration application is deterministic, versioned, and tested on a fresh database and an already-current database.
- Establish typed identity factories for `agentId`, `sessionKey`, `sessionId`, `runId`, `attemptId`, `modelCallId`, and journal sequence ownership without introducing one generic interchangeable ID type.
- Establish a clock abstraction for durable timestamps, timeout tests, and UTC usage windows.
- Normalize application/domain/storage/provider errors into stable typed codes; domain modules must not branch on raw SQLite or SDK error text.
- Confirm Pino logging is concise and redacted; logs remain diagnostics rather than test or durable-evidence APIs.
- Add deterministic test helpers for temporary databases, fake clocks, ID factories, abort signals, and event collection.

### Milestone 0 exit evidence

- Repository baseline commands are documented in the active plan.
- Fresh startup applies migrations exactly once.
- Second startup does not reapply completed migrations.
- Failed migration prevents startup without falling back to in-memory persistence.
- Shutdown closes Gateway/runtime resources before closing storage.
- Secret-redaction and normalized-error tests pass.
- Existing Gateway/session tests remain green.

## 7. Milestone 1 — Durable control plane

### Milestone 1 goal

Build the durable and concurrency-safe host path that exists before any provider request.

### Milestone 1 required work

- Complete the SQLite `TranscriptStore` adapter with monotonic `(sessionId, sequence)` ordering.
- Implement atomic `appendBatch({ sessionId, expectedTailSequence, entries })` semantics.
- Implement opaque sequence-bound history cursors that cannot cross a reset-created `sessionId`.
- Add domain contracts and SQLite adapter for `RunJournalStore` with per-run monotonic sequence.
- Add the accepted bounded reject-new FIFO per-session queue and one active lane per `(agentId, sessionKey)`.
- Add a separate bounded runtime-wide model capacity permit seam.
- Add transport-neutral run admission and cancellation application services under `src/agents/`; Gateway handlers only validate/map/forward.
- Persist run identity and terminal status needed for inspection, while keeping the executable queue in memory for V1.
- Implement the pre-model subset of the fixed pipeline:

```text
admission
→ queue/lane acquisition
→ RunSetupStage
→ AttemptSetupStage
→ ContextStage placeholder boundary
→ terminal test stage
→ CheckpointStage
→ FinalizeStage
```

- Append accepted user input once per run, after queue admission and lane acquisition rules permit it.
- Emit typed runtime events and required Run Journal entries in the accepted order.
- Expose minimal Gateway methods needed to submit, cancel, inspect, and read history through application services.

### Milestone 1 exit evidence

- A full per-session queue rejects before normal run acceptance and before transcript append.
- Three same-session accepted runs execute FIFO and never overlap.
- Different sessions may overlap when the runtime-wide test permit allows it.
- Cancellation works while queued and while active, with one terminal outcome.
- Disconnecting the submitting Gateway connection does not cancel the run.
- Transcript append batches are all-or-nothing and maintain contiguous store-assigned sequences.
- Run Journal sequence is monotonic per run and survives database reopen.
- Required transcript or journal commit failure prevents a successful terminal result.
- Reset cannot race an active run and a history cursor from the old `sessionId` cannot read the replacement transcript.

## 8. Milestone 2 — Model vertical slice

### Milestone 2 goal

Run one real model call through all accepted host-owned boundaries and return a durable terminal response.

### Milestone 2 required work

#### Agent definition and snapshot

- Add an `AgentDefinition` registry composed by bootstrap.
- Configure one default agent, `primary`, without introducing a global mutable singleton.
- Implement immutable `ResolvedAgentSnapshot` resolution once per admitted run.
- Include `agentRevision`, resource-manifest hash, exact model/harness route, prompt profile `main-v1`, tool/policy/sandbox fingerprints, and disabled/deferred memory configuration.
- Fail unknown, disabled, or unavailable agents before model execution.

#### Context and prompt plan

- Implement the minimum valid `ContextManifest` for the initial no-tool/no-memory vertical slice.
- Implement versioned `PromptPlan` profile `main-v1` with deterministic section order, source IDs, authority, trust, stability, budget class, renderer version, and hashes.
- Render structured immutable `PreparedModelContext`; do not pass one untyped replacement prompt string through the runtime.
- Read canonical transcript structural groups and fail invalid durable structure rather than silently repairing it.
- Include bounded token estimation and the accepted typed overflow path. Full tool-result pruning remains exercised later when tool outputs exist.

#### Harness and provider

- Register one built-in step-oriented harness through a Harness Registry.
- Add a model registry/runtime contract independent of provider SDK types.
- Implement the Gemini Developer API adapter with official `@google/genai`.
- Pin exact model `gemini-3.5-flash`.
- Use native Gemini Interactions API with `store=false`.
- Do not use Vertex AI, the OpenAI-compatible endpoint, explicit cache objects, or `previous_interaction_id`.
- Keep API-key resolution inside trusted backend model infrastructure.
- Normalize streaming/final output, finish status, errors, cancellation, and provider usage.
- Preserve required typed steps/thought signatures only as opaque versioned continuation sidecars. Never expose raw signatures in logs, journal metadata, Gateway history, or visible transcript content.

#### Usage accounting

- Implement `UsageLedgerStore`, operator-configured price catalog, cap-policy matching, and UTC day/month windows.
- Support global/agent/provider/model token and cost caps.
- For every model call:

```text
create modelCallId
→ atomically reserve all matching cap headroom
→ durably mark dispatched
→ call provider outside the transaction
→ settle actual usage, release proven non-billable rejection, or retain uncertain state
```

- Keep accounting active when no cap is configured.
- Fail closed with `USAGE_PRICING_UNKNOWN` when an active cost cap cannot be evaluated.
- Keep provider external quota/rate-limit errors distinct from local cumulative-cap errors.

#### Runtime pipeline and finalization

Implement and expose the fixed stage order:

```text
RunSetupStage
→ AttemptSetupStage
→ ContextStage
→ ModelStage
→ ObserveStage
→ CheckpointStage
→ FinalizeStage
```

`ToolStage` remains a registered boundary but is not an active capability in this slice because no tools are advertised.

- Only `CheckpointStage` may return `continue`, `complete`, `retry-attempt`, `cancel`, or `fail`.
- The built-in harness and provider may execute one step but may not continue, retry, or terminalize privately.
- `FinalizeStage` runs exactly once for success, failure, timeout, and cancellation.
- Successful completion requires durable final assistant transcript state, required provider continuation, terminal Run Journal evidence, and usage accounting state.
- Publish a terminal Gateway response/event only after required durable writes.

### Milestone 2 exit evidence

A repository-owned integration or opt-in live test proves:

1. A CLI or Gateway client sends one prompt to `primary`.
2. The request receives a `runId`, waits for its session lane, and starts one attempt.
3. The resolved agent/model/harness/prompt identities are visible in typed journal evidence.
4. Gemini receives one native Interactions request using `gemini-3.5-flash` and `store=false`.
5. The terminal assistant response is committed once to the transcript.
6. Provider usage is normalized and settled in the Usage Ledger.
7. The Run Journal records reservation, dispatch, model outcome, settlement, checkpoint, finalization, and terminal result.
8. Restarting the process preserves session history, journal evidence, usage records, and required continuation metadata.
9. A second prompt in the same logical session includes the correct prior structural exchange and does not depend on provider-hosted conversation state.
10. Provider rejection, timeout, cancellation, transcript failure, journal failure, and accounting failure each produce one deterministic terminal outcome.

## 9. Cross-cutting validation gates

Every milestone must run the repository’s actual equivalents of:

```text
typecheck
lint/format check
unit tests
integration tests
migration tests
```

Additional required gates:

- No direct SQLite imports from Gateway handlers or Agent Runtime domain logic.
- No provider SDK types outside `src/models/` provider adapter surfaces.
- No Gateway objects inside `ResolvedAgentSnapshot` or model/runtime contracts.
- No raw secret or thought-signature matches in captured logs, journals, artifacts, snapshots, or fixtures.
- No tests that parse human-readable Pino output as the primary evidence API.
- Every concurrency test has bounded timeouts and asserts lane/permit cleanup.
- Live Gemini tests are opt-in, clearly separated from deterministic CI tests, and never run without an explicit secret-bearing environment configuration.

## 10. Commit and plan discipline

Suggested implementation checkpoints:

```text
chore: record repository baseline and validation commands
feat: harden storage lifecycle and shared test primitives
feat: add durable transcript batches and run journal
feat: add per-session run admission and lifecycle pipeline
feat: add immutable agent snapshot and prompt plan
feat: add Gemini Interactions provider
feat: add usage reserve-dispatch-settle ledger
feat: complete durable model vertical slice
```

Exact commit boundaries may adapt to the repository, but each commit should remain buildable and should not knowingly leave migrations or durable schema consumers out of sync.

At the end of each phase, update the active plan with:

- actual files changed;
- actual commands run;
- test results;
- migration versions added;
- observed evidence;
- unresolved risks.

## 11. Out of scope through Milestone 2

Do not implement or represent as complete:

- Tool Runtime execution beyond its inactive boundary;
- shell/file side-effect tools;
- approval UI;
- Playwright/Chromium Browser Runtime;
- messaging channels or Telegram;
- dynamic plugins;
- multiple agents or delegates;
- vector memory or automatic memory extraction;
- curated-memory writes/recall beyond disabled snapshot configuration;
- durable compaction;
- Redis, PostgreSQL, distributed queues, or multiple SQLite writers;
- explicit Gemini cache objects or server-side conversation state;
- per-user/channel request quotas;
- automatic model fallback or cheaper-model substitution;
- production-grade Control UI.

## 12. Definition of the first usable core

Milestones 0–2 are complete only when the following user-visible flow works with durable evidence:

```text
prompt
→ validated Gateway admission
→ serialized durable session
→ deterministic host-owned runtime
→ Gemini Interactions call
→ usage accounting
→ durable transcript and Run Journal
→ final response
→ restart
→ coherent second prompt in the same session
```

Only after this proof should the project open the next active plan for Tool Runtime.
