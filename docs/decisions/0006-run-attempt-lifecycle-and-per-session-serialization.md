# ADR 0006: Run and Attempt Lifecycle with Per-Session Serialization

- **Status:** Accepted
- **Date:** 2026-07-24
- **Decision owners:** my-agent-v2 maintainers
- **Related architecture:** `docs/ARCHITECTURE.md`
- **Related decisions:**
  - `docs/decisions/0001-modular-monolith-and-openclaw-alignment.md`
  - `docs/decisions/0002-core-runtime-identities-and-agent-ownership.md`
  - `docs/decisions/0003-session-routing-transcript-separation-and-reset-semantics.md`
  - `docs/decisions/0004-gateway-control-plane-and-protocol-contract.md`
  - `docs/decisions/0005-agent-runtime-harness-and-model-provider-boundaries.md`
  - `docs/decisions/0010-runtime-events-logs-transcripts-and-audit-separation.md`
  - `docs/decisions/0015-usage-accounting-and-cumulative-budget-enforcement.md`

## Context

`my-agent-v2` needs a defined lifecycle for one accepted agent invocation and for the model-loop attempts that may occur inside it.

ADR 0002 distinguishes:

```text
runId     = one accepted Agent Runtime invocation
attemptId = one model-loop attempt within a run
```

ADR 0003 requires an accepted run to keep using the resolved `sessionId` it captured, and prevents reset from remapping the session while an active run can still write to that transcript.

ADR 0005 assigns application orchestration to Agent Runtime and assigns execution of one prepared attempt to an Agent Harness.

These decisions require a concurrency boundary that prevents two runs from simultaneously reading, mutating, and appending to the same logical session.

Without an explicit lifecycle and serialization decision, the system could:

- execute overlapping model and tool loops against the same transcript;
- append user messages, tool results, or assistant output out of order;
- reset a session while an active run is still writing to the previous transcript;
- retry an attempt after side effects have already occurred;
- report completion before required transcript state and terminal execution evidence are durable;
- treat Gateway connection loss as run cancellation;
- release a session lock before runtime cleanup and final writes complete.

OpenClaw currently serializes runs through a per-session lane and may also apply a separate global concurrency lane. It additionally protects transcript mutation through a session write lock. OpenClaw supports steering and queue modes for messages arriving during an active run.

GoClaw makes the internal turn pipeline explicit, including a `CheckpointStage` that controls loop exit and a cancellation-surviving `FinalizeStage` that flushes output and session metadata. `my-agent-v2` adopts the stage-boundary, checkpoint-authority, and finalization principles without adopting GoClaw's exact stage count, fixed iteration thresholds, scheduler lanes, memory workers, or multi-tenant scope.

`my-agent-v2` adopts the per-session serialization and lifecycle principles while keeping V1 smaller:

- one active run for a logical session;
- an in-process session-lane coordinator;
- ordinary later prompts queued as separate FIFO runs;
- no same-run steering, collection, or interruption modes in V1;
- no persistent run scheduler or crash recovery in V1;
- no automatic retry after observable output or side effects.

## Decision

Agent Runtime owns the run lifecycle, attempt lifecycle, per-session run lane, cancellation coordination, and terminal result classification.

The runtime flow is a fixed host-owned stage pipeline:

```text
validate run request
→ resolve immutable agent snapshot and session
→ create runId and capture agentRevision + sessionId
→ enqueue and acquire session lane
→ RunSetupStage
→ AttemptSetupStage
→ ContextStage
→ ModelStage
→ ToolStage when tool calls exist
→ ObserveStage
→ CheckpointStage
   ├─ continue → ModelStage
   ├─ retry-attempt → terminalize current attempt → AttemptSetupStage with a new attemptId
   └─ complete | fail | cancel → terminalize current attempt → FinalizeStage
→ emit terminal run event after required durable writes
→ release session lane
```

The stage names are architecture concepts; file and class names may be refined by an execution plan. The boundary and authority rules are fixed.

A run may contain zero, one, or multiple attempts:

- zero attempts when it is cancelled before attempt execution or fails during preparation;
- one attempt in the normal V1 path;
- multiple attempts only when an explicit retry, fallback, compaction-recovery, or harness-recovery policy permits it.

## Fixed V1 stage pipeline

Agent Runtime owns the stage sequence and transitions. A stage receives an immutable or explicitly scoped runtime snapshot, performs one bounded responsibility, and returns a typed outcome plus zero or more progress signals.

The V1 stage responsibilities are:

| Stage | Responsibility |
|---|---|
| `RunSetupStage` | Establish run context after lane acquisition, append input once, and initialize traceable state |
| `AttemptSetupStage` | Create `attemptId`, resolve coherent model/harness/tool snapshots, and prepare attempt-local state |
| `ContextStage` | Load sources, reconstruct structural history, apply deterministic context pruning and token-budget validation, and assemble provider-neutral context plus required provider continuation |
| `ModelStage` | Obtain a durable usage reservation, mark dispatch, execute one normalized model step through the selected Harness and Model Runtime, and settle/release/mark uncertain before returning |
| `ToolStage` | Validate, authorize, approve, schedule, and execute requested tools through Tool Runtime |
| `ObserveStage` | Normalize model/tool observations, compute transcript or state deltas, and emit progress signals |
| `CheckpointStage` | Evaluate all exit, continuation, cancellation, retry, and budget conditions |
| `FinalizeStage` | Commit required terminal state, evidence, summaries, cleanup, and the terminal result |

V1 uses a fixed pipeline rather than dynamically registered stage plugins. Hooks may observe or contribute typed signals only within their declared authority; they must not reorder stages or privately continue the loop.

### `CheckpointStage` authority

`CheckpointStage` is the only component permitted to authorize another model/tool cycle or another attempt.

Its decision is one of:

```text
continue
complete
retry-attempt
cancel
fail
```

The decision is based on a typed checkpoint snapshot containing applicable:

```text
runId and attemptId
iteration and elapsed time
model-call and tool-call counts
run, attempt, provider, approval, and tool deadlines
context/token usage, measurement mode, pruning outcome, and configured limits
last normalized model outcome
last normalized tool outcomes
observed transcript or state delta
progress and no-progress signals
completed or uncertain side effects
retryability and idempotency evidence
cancellation state
```

The following rules apply:

1. Other stages report outcomes and signals; they do not privately start another cycle.
2. Provider adapters do not internally retry or continue a model loop without a checkpoint-visible decision.
3. Harnesses do not hide continuation, fallback, or retry.
4. Tool Runtime returns normalized outcomes and progress signals; it does not decide whether the agent loop continues.
5. A `retry-attempt` decision first terminalizes the current attempt, then applies the explicit safety policy in this ADR and creates a new `attemptId`.
6. Every checkpoint decision is recorded in the Run Journal with the evaluated limits, decisive signals, and stable reason code.
7. Configuration controls thresholds, but not which component owns the decision.
8. `ContextStage` may return `context-prepared` or `context-overflow` signals, but it cannot authorize hidden compaction, another attempt, or another model cycle.
9. Context overflow after all permitted deterministic reductions fails with `CONTEXT_BUDGET_EXCEEDED_AFTER_PRUNING` unless `CheckpointStage` applies an explicit retry or future compaction policy.
10. A cumulative-usage reservation block prevents provider dispatch and is consumed as a typed checkpoint signal; V1 does not silently downgrade the model or wait for a later quota window.
11. A dispatched call with unresolved accounting is terminally visible as uncertain or settlement-required; it is not replayed automatically.

### Progress and no-progress detection

Checkpointing distinguishes ordinary repetition from repeated work that produces no meaningful progress.

A tool-cycle fingerprint may include:

```text
tool name
normalized argument hash
normalized result or outcome-class hash
relevant transcript/state before-and-after hashes
side-effect classification
```

A cycle is considered no-progress only when the configured comparison finds equivalent requests and outcomes with no meaningful transcript, state, or external-progress signal.

V1 must support:

```text
repetition warning threshold
no-progress termination threshold
maximum iteration budget
maximum model-call budget
maximum tool-call budget
maximum elapsed-time budget
cumulative token/cost reservation and settlement state
context/token warning and hard thresholds
context-pruning and token-measurement limits
```

Exact defaults belong to configuration and the execution plan and are recorded in the Run Manifest. The project does not copy GoClaw's numeric thresholds as compatibility guarantees.

Checkpoint evidence uses typed events such as:

```text
checkpoint.started
checkpoint.signal.detected
checkpoint.decision
checkpoint.completed
loop.repetition.warning
loop.no_progress.terminated
loop.budget.exhausted
```

### `FinalizeStage`

`FinalizeStage` runs exactly once for every terminal path that reached run ownership, including completion, failure, timeout, and cancellation.

It is cancellation-safe in the sense that a cancellation request does not skip required consistency and evidence work. Finalization may still use bounded internal deadlines.

It is responsible for applicable:

```text
final output normalization
required transcript and provider-continuation writes
required run-owned state updates
best-effort session runtime summary projection with explicit degraded status
usage and timing summary
terminal run journal evidence and validation that the current attempt is already terminal
terminal runtime outcome publication
resource cleanup and cancellation-handle removal
session-lane release through a guaranteed final path
```

`FinalizeStage` must not call the model, start a new tool side effect, or make a new checkpoint continuation decision.

Finalization is protected by an atomic terminal guard or idempotent sub-operations so duplicate cleanup paths cannot create multiple terminal outcomes. Optional debug-artifact or session-summary failure may mark degraded capture/projection; required transcript, provider-continuation, or terminal journal failure prevents successful completion.

## Run lifecycle

A run progresses through these conceptual states:

```text
accepted
→ queued
→ running
→ completed | failed | cancelled
```

`accepted` and `queued` may initially be represented by one internal record, but their semantics remain distinct:

- **accepted** means the request was validated, the agent and session were resolved, bounded queue admission succeeded, a `runId` was created, and the run captured its target `sessionId`;
- **queued** means the run is waiting to acquire its session lane or a runtime-wide capacity permit;
- **running** means the run owns its session lane and runtime execution has started;
- **completed**, **failed**, and **cancelled** are terminal states.

Exactly one terminal transition is permitted for each `runId`.

The Agent Runtime must guard the terminal transition atomically so that completion, cancellation, timeout, and failure races cannot emit conflicting terminal results.

### Run acceptance

Before a run is accepted, Agent Runtime must reserve capacity in the bounded per-session queue and have a coherent resolved identity snapshot containing at least:

```text
agentId
agentRevision
resourceManifestHash
sessionKey
sessionId
runId
```

The run captures the resolved `sessionId` at acceptance.

If the same `sessionKey` later maps to a new `sessionId`, the accepted run continues to use the captured transcript instance.

A run request rejected during schema validation, agent resolution, ownership validation, session resolution, or queue admission does not create a successful accepted run. Queue-full rejection occurs before transcript input append and before a normal accepted `runId` is exposed.

The Gateway may acknowledge acceptance and return the `runId`, but the Gateway does not own the lifecycle after acceptance.

### Run start

A run becomes `running` only after it has acquired:

1. the per-session lane; and
2. any configured runtime-wide concurrency permit.

`run.started` is emitted when the run enters `running`, not merely when it is placed in a queue.

Queue wait time may be captured as runtime metadata but is not model execution time.

### Run completion

A run becomes `completed` only when:

- the final attempt has completed successfully;
- the final normalized assistant outcome exists;
- transcript entries required by the successful turn have been committed;
- required run-owned state has been updated;
- the required terminal Run Journal entry has committed;
- no terminal cancellation or failure won the transition race.

`run.completed` must not be emitted before required durable state is available through session and transcript APIs.

Streaming deltas and Gateway events are not proof that a run completed.

### Run failure

A run becomes `failed` when it cannot produce and commit a valid completed outcome.

Failure reasons may include:

- context preparation failure;
- model or provider failure;
- harness failure;
- policy or approval failure classified as terminal;
- tool failure classified as terminal;
- transcript or runtime-state persistence failure;
- run timeout;
- retry or fallback exhaustion;
- invariant violation.

A failed run returns or emits a normalized structured error. Raw provider, harness, SQLite, or platform error objects must not become the application contract.

A run timeout is classified as `failed` with a timeout-specific error code. The runtime may abort underlying work as part of enforcing the timeout, but timeout is not treated as an explicit user cancellation.

### Run cancellation

Explicit cancellation is a request, not immediate proof that all work has stopped.

Cancellation behavior is:

- a queued run may be prevented from starting and transition directly to `cancelled`;
- a running run receives a cancellation signal through the active attempt, model request, tool execution, and other cancellable runtime boundaries;
- Agent Runtime waits for required cleanup and transcript consistency work before finalizing `run.cancelled`;
- if completion or failure already won the terminal transition, a later cancellation request reports that the run is already terminal;
- if cancellation wins first, no later completion event may be emitted.

Gateway disconnection does not automatically cancel a run.

A future API may expose an explicit disconnect-cancels-run option, but it must be request policy rather than an inference from `connectionId` lifetime.

## Per-session run lane

Every run is serialized through a lane keyed by:

```text
(agentId, sessionKey)
```

The lane is keyed by the logical route rather than only by `sessionId` so that run execution, reset, and future route-scoped mutations cannot race across a transcript remapping.

The lane guarantees:

1. at most one active run for a logical session;
2. FIFO ordering for ordinary queued runs in V1;
3. no later run reads the session transcript before the earlier run has completed its required writes;
4. a reset cannot remap the logical session while an active run owns the lane;
5. lane ownership survives Gateway client disconnect;
6. lane release occurs in a `finally`-equivalent cleanup path.

The lane coordinator belongs to the Agent Runtime application boundary. Gateway handlers, harnesses, providers, and concrete stores must not implement competing run queues.

### Operations sharing the lane

The following operations must execute under the same logical session serialization boundary when they can affect active transcript routing or ordering:

- agent runs;
- session reset;
- future cancel-and-reset;
- future transcript compaction that rewrites or rotates the active transcript;
- future restore, fork-current, or current-transcript replacement operations;
- maintenance operations that mutate the current transcript.

Read-only history and status operations do not automatically require exclusive lane ownership, but their APIs must document whether they return a point-in-time snapshot while a run is active.

### New prompts while a run is active

In V1, a new normal prompt for the same logical session becomes a new queued run only after a bounded queue slot has been reserved.

Queue admission occurs before the request is reported as accepted. If the configured per-session queue is full, the runtime returns a structured `SESSION_RUN_QUEUE_FULL` rejection.

A rejected prompt:

- does not receive a normal accepted `runId`;
- is not appended to the transcript;
- is not merged into another prompt;
- may produce a bounded technical or application rejection event correlated by request ID and `sessionKey`.

An accepted queued prompt:

- is never evicted to admit a newer prompt;
- is never silently dropped;
- is never merged or debounce-combined with another prompt;
- does not modify the active run;
- does not interrupt an active tool call;
- does not append itself to the active attempt context;
- does not replace the active run.

Queued prompts are processed in arrival order after the active run releases the lane. Queue capacity and observed queue position are configuration/evidence fields, not permission to weaken FIFO or discard accepted work.

OpenClaw-style queue modes such as:

```text
steer
followup
collect
interrupt
```

are deferred.

Adding same-run steering requires an ADR or a material extension to this decision because steering changes transcript ordering, attempt input, tool-result pairing, cancellation behavior, and harness capability requirements.

## Runtime-wide concurrency

Per-session serialization is a correctness invariant.

A separate runtime-wide capacity limiter and bounded resource budgets may cap work across different session lanes to control:

- active model calls;
- active tool executions;
- active browser operations;
- provider rate limits;
- memory consumption;
- CPU usage;
- browser or platform contention;
- local model capacity.

`SessionRunLane` and runtime budgets are separate concepts. The lane protects ordering for one logical session; semaphores or budget contracts protect process-wide resources. A run may own its session lane while waiting for a bounded global resource permit, and that wait remains visible to Checkpoint and Run Journal evidence.

The global limiter is resource policy, not session identity.

Runtime-wide concurrency is not cumulative usage enforcement. Capacity permits bound simultaneous work; `UsageBudgetGate` and `UsageLedgerStore` under ADR 0015 bound and account consumption across calls and sessions. A call requires both when configured.

It must not:

- allow more than one active run in one session lane;
- reorder runs within a session lane;
- merge independent sessions into one transcript boundary;
- be implemented by Gateway connection count.

V1 may begin with a conservative global concurrency value. The concrete default belongs to configuration or an execution plan unless it becomes a product compatibility guarantee.

## Attempt lifecycle

An attempt progresses through these conceptual states:

```text
prepared
→ running
→ completed | failed | cancelled
```

The Agent Runtime creates a fresh `attemptId` when it is ready to dispatch one prepared attempt to a selected harness.

An attempt belongs to exactly one `runId` and inherits the run's captured:

```text
agentId
sessionKey
sessionId
```

`attempt.started` is emitted before the first model request or harness-owned execution step.

An attempt becomes `completed` when the harness returns a normalized successful attempt result and any attempt-level validation succeeds.

An attempt becomes `failed` when the harness, provider, model loop, context recovery, or attempt-owned execution cannot continue successfully.

An attempt becomes `cancelled` when run cancellation terminates that attempt before completion.

A run may fail before creating an attempt. Therefore consumers must not assume every `run.started` has a corresponding `attempt.started`.

## Retry, fallback, and additional attempts

V1 normally executes one attempt per run.

A later attempt may start only when Agent Runtime applies an explicit policy that defines:

- which failure classes are retryable;
- whether the same or another provider/model route is used;
- whether the same or another harness is used;
- whether context must be rebuilt;
- whether prior partial output is visible or durable;
- whether completed tool calls or other side effects occurred;
- maximum attempts and backoff;
- cancellation and timeout budgets across attempts.

The following safety rules apply from the start:

1. A retry creates a new `attemptId` and keeps the same `runId`.
2. User input for the run is appended once, not once per attempt.
3. A failed attempt must not be relabeled as completed because a later attempt succeeds.
4. A completed side-effecting tool call is not automatically rolled back when an attempt fails.
5. Agent Runtime must not replay a completed side-effecting tool call unless idempotency, deduplication, or an explicit recovery policy makes replay safe.
6. Automatic retry must stop once user-visible assistant output or unsafe side effects make replay ambiguous, unless a later ADR defines resumable semantics.
7. Trust, policy, approval, ownership, or schema failures must not silently fall back to a less restrictive route.
8. Attempt history must remain observable through structured events and the durable Run Journal even if only the final run result is returned to the caller. Technical logs remain supplementary.
9. Every additional model call or retry attempt obtains a new usage reservation; no settled, released, or uncertain reservation authorizes replay.
10. A provider call is never replayed merely because usage settlement persistence failed.

Model fallback policy is owned by the model layer and coordinated by Agent Runtime. Harness recovery policy is owned by Agent Runtime and Harness Registry. Neither may create an unrelated new run without an explicit application request, and neither may perform an unreported internal retry. Each additional attempt requires an explicit `CheckpointStage` `retry-attempt` decision.

## Transcript write ordering

The session lane protects runtime-level ordering, but transcript correctness also remains a responsibility of `TranscriptStore`.

The following ordering rules apply:

1. The accepted run's user input is appended exactly once through an atomic batch under lane ownership.
2. Tool requests, normalized tool results, and required provider continuation preserve their logical pairing and commit as one atomic batch.
3. A later queued run cannot append its user input before the active run finishes its required transcript writes.
4. The final assistant result and required provider continuation commit atomically before `run.completed` is emitted.
5. A failed or cancelled run must not fabricate a completed assistant entry.
6. Streaming deltas may be transient and are not automatically durable transcript entries.
7. `TranscriptStore` assigns monotonic per-`sessionId` sequence values in contiguous batch ranges and validates the expected transcript tail.
8. Store ordering never relies on wall-clock timestamps alone.

The exact transcript-entry schema, partial-output retention, and context assembly rules are defined by the sessions, context, and future transcript-focused decisions.

The runtime path must not bypass `TranscriptStore` and write SQLite directly.

## Run Journal ordering

Every accepted run is recorded through the `RunJournalStore` defined by ADR 0010.

Journal entries use a monotonically increasing sequence scoped to `runId`. They record meaningful lifecycle boundaries, decisions, persistence summaries, and terminal outcomes without becoming a general event-sourcing log.

Required ordering invariants are:

- `run.accepted` and the run manifest are durable before the run is treated as traceable;
- lane queue and acquisition evidence precedes attempt execution;
- each executed stage has typed start and terminal evidence where meaningful;
- every model/tool cycle has one checkpoint decision before another cycle starts;
- context-pressure, pruning, token-measurement, and post-pruning overflow signals precede the checkpoint decision that consumes them;
- a durable usage reservation and dispatch marker precede each provider call, and settlement/release/uncertain evidence precedes the checkpoint decision consuming that outcome;
- every started attempt has one terminal journal entry;
- policy and approval decisions are recorded before a side-effecting tool starts;
- tool start precedes its terminal outcome;
- transcript or domain commit evidence precedes successful run terminal evidence;
- exactly one terminal run journal entry is committed;
- no later journal entry may claim successful work after the terminal run outcome;
- optional debug-artifact failure is marked as degraded capture rather than silently omitted.

Required journal-write failure follows the fail-closed behavior in ADR 0010. The Run Journal is durable evidence, but it is not a persistent scheduler and does not imply automatic run resumption after restart.

## Event ordering

Runtime lifecycle events must preserve these invariants:

```text
run.started
  attempt.started
    stage.started
    context/model/tool/observe events
    checkpoint.decision
    stage.completed | stage.failed | stage.cancelled
  attempt.completed | attempt.failed | attempt.cancelled
  finalize.started
  finalize.completed | finalize.failed
run.completed | run.failed | run.cancelled
```

Rules:

- `run.started` occurs at most once;
- every started attempt emits exactly one terminal attempt event;
- a run emits exactly one terminal run event;
- an attempt terminal event precedes the terminal run event derived from it;
- no model, tool, attempt, or run-progress event is emitted after the terminal run event;
- a later attempt may begin only after the previous attempt is terminal;
- event delivery failure does not roll back durable runtime state;
- clients recover authoritative state through application APIs rather than event replay assumptions.

The Gateway may translate or forward these events but must not reorder lifecycle semantics.

## Timeouts

Timeout ownership is layered:

- Agent Runtime owns the overall run deadline;
- an attempt may have a bounded attempt deadline;
- model transport may have request and inactivity timeouts;
- Tool Runtime owns tool execution timeouts;
- approval waiting may use a separately configured deadline.

A lower-level timeout is normalized and returned to Agent Runtime as an outcome and checkpoint signal. `CheckpointStage` determines whether the current attempt fails, an explicitly safe retry starts, cancellation wins, or the run fails.

Timeouts must propagate cancellation signals where supported and must not release the session lane while owned work can still mutate the transcript.

A component that cannot be forcefully cancelled must declare that limitation. Its late result must be ignored after the owning attempt or run has become terminal.

## Finalization, cleanup, and lane release

`FinalizeStage` owns terminal cleanup coordination. The session lane is released only after Agent Runtime has attempted to:

- stop or detach the active harness execution;
- cancel outstanding model and tool work;
- complete required transcript and runtime-state writes;
- commit the required terminal Run Journal outcome;
- emit the terminal runtime outcome after required durable writes;
- release attempt-local provider, browser, process, or temporary resources;
- unregister active-run cancellation handles.

Cleanup occurs for completed, failed, and cancelled runs.

Non-critical cleanup failures are logged and surfaced through diagnostics where appropriate. A failure that compromises transcript consistency or makes the terminal result unreliable must cause the run to fail rather than report success.

The lane must still be released through a guaranteed cleanup path so one broken run cannot permanently deadlock the session in memory.

## Run registry and durability

V1 may keep queued and active run state in memory.

Durable records remain:

- session routing state;
- transcript entries;
- per-run manifests and ordered Run Journal evidence;
- owned debug-artifact metadata and references when capture is enabled;
- other explicitly persisted domain state.

Gateway or process restart may lose:

- queued runs;
- executable active-run state and the ability to resume it;
- transient streaming events;
- in-memory cancellation handles;
- waiters for a `runId`.

The Run Journal may retain evidence written before the crash. That evidence can show the last observed durable phase, but it must not be interpreted as a resumable scheduler record or proof that an unrecorded action did not occur.

V1 does not claim automatic resumption or exactly-once run execution across process crashes.

After restart, incomplete work must not be presented as a completed run merely because partial transcript entries or streamed output exist.

Persistent scheduling, automatic recovery, distributed workers, and exactly-once or at-least-once execution require a later ADR. The V1 Run Journal is evidence, not recovery authority.

## Idempotency and duplicate submission

The session lane prevents simultaneous execution but does not by itself prevent duplicate logical submissions.

A future externally retryable `agent.run` method must support an idempotency key or equivalent deduplication contract before clients are promised safe retry after uncertain delivery.

Duplicate requests with the same accepted idempotency identity must resolve to the same logical run result or an explicit in-progress state rather than creating independent runs.

Idempotency retention, persistence, and expiry are deferred to the Gateway method or run-persistence design.

## OpenClaw alignment and intentional differences

This decision aligns with current OpenClaw behavior in the following ways:

- runs are serialized by a per-session lane;
- different sessions may run concurrently subject to a separate global limit;
- serialization prevents transcript, tool, and session-state races;
- timeout and cancellation propagate through the active runtime;
- runtime lifecycle events distinguish start, progress, completion, and failure;
- transcript mutation requires protection beyond uncoordinated direct writes;
- a harness executes within a host-owned run lifecycle rather than owning session routing.

This decision also aligns with GoClaw's use of explicit checkpoint and finalization stages, bounded tool-loop guards, and separate per-session and runtime-wide concurrency controls. The alignment is conceptual rather than a commitment to GoClaw's exact stage count or default limits.

`my-agent-v2` intentionally differs or starts smaller in these ways:

- V1 uses a bounded reject-new FIFO queue for ordinary same-session prompts;
- accepted prompts are never merged, evicted, or silently dropped;
- same-run `steer`, `collect`, and `interrupt` modes are deferred;
- no global lane name or OpenClaw queue configuration is adopted as a public contract;
- SQLite transactions and store contracts provide persistence protection; a process-aware file lock is deferred while one process owns writes;
- V1 has a durable per-run evidence journal, but no persistent execution queue, resumable scheduler, or automatic restart recovery;
- V1 normally has one attempt and does not implement OpenClaw's provider failover or retry chain;
- automatic retry after visible output or completed side effects is prohibited until resumable semantics are explicitly designed.

## Consequences

### Positive

- Transcript and tool ordering remain deterministic within a logical session.
- Session reset cannot race with active transcript writes.
- Gateway reconnect does not redefine or cancel application work.
- Multiple sessions may use safe parallelism without permitting same-session collisions.
- Retries and future fallback can add attempts without changing `runId` semantics.
- Runtime events and durable journal entries have defined nesting and terminal ordering.
- Each prompt can be inspected independently through `runId + sequence`.
- Failure and cancellation cannot masquerade as successful completion.
- One checkpoint authority makes continuation, budgets, retry, and no-progress behavior inspectable and testable.
- A mandatory FinalizeStage makes terminal writes and cleanup consistent across success, failure, and cancellation.

### Negative

- A long-running turn blocks later turns for the same logical session.
- Queue wait time may become visible under tool-heavy workloads.
- Cancellation requires cooperation from model, harness, tool, and provider boundaries.
- The runtime must propagate identity, deadlines, and cancellation signals through many contracts.
- In-memory queues do not survive process restart.
- Future steering or interruption modes require careful transcript and harness changes.
- Explicit stages, checkpoint snapshots, progress fingerprints, and finalization guards add contracts and tests.

## Risks and trade-offs

### Head-of-line blocking

One slow run delays every later run in the same session.

Mitigation:

- enforce run, model, tool, and approval timeouts;
- expose queued and active status;
- support explicit cancellation;
- add future interruption or steering only through a deliberate compatibility decision.

### Lane leak or deadlock

An exception during runtime cleanup could leave a session permanently busy.

Mitigation:

- acquire and release through one structured runtime owner;
- release in a guaranteed cleanup path;
- test completion, failure, timeout, and cancellation paths;
- expose active-lane diagnostics.

### Duplicate side effects after retry

A retry may repeat a tool call whose first result was lost or whose attempt later failed.

Mitigation:

- do not enable broad automatic retry in V1;
- track completed tool-call identity and status;
- require idempotency or explicit recovery policy before replay;
- stop automatic fallback after unsafe side effects or visible output.

### Cancellation races

A run may complete while a cancellation request is being processed.

Mitigation:

- use one atomic terminal transition;
- report whether cancellation was accepted;
- ignore late lower-level results after terminalization;
- emit exactly one terminal run event.

### Incorrect progress classification

A weak fingerprint may terminate useful repeated work or fail to stop a true loop.

Mitigation:

- combine request, outcome, and state-delta signals;
- make thresholds configurable and visible in the Run Manifest;
- journal the decisive fingerprint and reason code;
- test repeated read-only work, changing external state, and true no-progress loops separately.

### Checkpoint bypass

A provider, Harness, tool, or hook may accidentally start another cycle or retry internally.

Mitigation:

- expose no direct self-looping callback in V1 contracts;
- return typed outcomes and signals to Agent Runtime;
- test that every second model call has a preceding checkpoint decision;
- reject unreported retry or fallback in provider and Harness adapters.

### Direct transcript mutation bypasses the lane

Maintenance code, plugins, or future processes could write to the current transcript outside Agent Runtime.

Mitigation:

- expose transcript mutation only through owned contracts;
- require current-transcript replacement operations to acquire the session lane;
- add a stronger store-level write lock before supporting multiple writer processes or external maintenance.

### Process crash loses executable active state

An in-memory queue cannot prove whether an interrupted provider or tool side effect occurred.

Mitigation:

- do not claim automatic resumption or exactly-once execution;
- keep durable transcript writes atomic;
- surface restart as interrupted work rather than success;
- use the Run Journal only to diagnose the last recorded phase;
- require a persistent scheduler and recovery ADR before automatic resumption is implemented.

## Rejected alternatives

### Allow concurrent runs for the same session

Rejected because transcript reads, appends, tool calls, context assembly, and reset would race and produce nondeterministic history.

### Key the lane only by `sessionId`

Rejected because reset can replace the current transcript while retaining the same logical session. Route-scoped mutation and reset must serialize with runs across that remapping.

### Use one global serial queue for all sessions

Rejected because it prevents safe parallelism across independent sessions and turns a slow session into a system-wide bottleneck.

### Let Gateway connections own run queues

Rejected because connection lifetime is transient, reconnect creates a new `connectionId`, and future origins may not use WebSocket at all.

### Let each harness manage session concurrency

Rejected because different harnesses would enforce different ordering, and harnesses do not own session routing, reset, transcript persistence, or run identity.

### Append queued prompts into the active run by default

Rejected because it changes attempt input after acceptance, complicates tool-result pairing, requires harness-specific steering support, and makes cancellation and event ordering harder to reason about.

### Drop or merge queued prompts under pressure

Rejected because an accepted prompt is user-visible work with its own lifecycle. Eviction, debounce merging, or drop-old behavior would destroy evidence and violate the one-prompt-per-run contract.

### Automatically retry every failed attempt

Rejected because model output or side-effecting tools may already have produced observable results, making replay unsafe or duplicative.

### Let each stage decide whether to continue

Rejected because continuation rules would become distributed across Harness, provider, Tool Runtime, and hooks, making budgets inconsistent and debug evidence incomplete.

### Use only a maximum-iteration counter

Rejected because iteration count alone cannot distinguish cancellation, context pressure, repeated no-progress behavior, retry safety, side effects, or successful terminal model output.

### Skip finalization on cancellation

Rejected because cancellation still requires transcript consistency, terminal evidence, summary updates, cleanup, and session-lane release.

### Mark a run completed before transcript commit

Rejected because clients could refresh authoritative state and fail to find the result announced by the completion event.

### Cancel runs when the originating connection closes

Rejected because connections do not own durable application work and clients may reconnect while a valid run continues.

### Implement a durable distributed queue in V1

Rejected because one local process does not yet require distributed scheduling, leases, recovery workers, or persistent queue complexity.

### Check cumulative usage only when a run is accepted

Rejected because one run may execute multiple model calls and route/context estimates are model-call-specific. Each provider dispatch needs its own atomic reservation.

### Retry a provider call when usage settlement fails

Rejected because the first call may already have completed and been billed. Accounting recovery must not create duplicate provider work.

## Validation

This decision is correctly applied when:

- Agent Runtime creates and owns each `runId` and `attemptId` lifecycle;
- every accepted run captures one immutable `agentRevision` and resource-manifest hash;
- agent/resource edits after acceptance do not change the active run;
- one `(agentId, sessionKey)` lane permits at most one active run;
- ordinary queued runs execute FIFO within that lane;
- per-session queues are bounded and reject new work with `SESSION_RUN_QUEUE_FULL` before acceptance when full;
- accepted prompts are never merged, evicted, or silently dropped;
- queue rejection does not append transcript input or create a normal accepted run;
- different session lanes may execute independently subject to a separate capacity limit;
- reset and current-transcript replacement cannot race with an active run;
- a run continues using its captured `sessionId` even if later routing changes;
- `run.started` occurs after lane acquisition;
- user input is appended once per run, not once per attempt;
- every started attempt has exactly one terminal attempt event and one terminal journal entry;
- every terminal run has exactly one terminal journal entry and at most one terminal runtime outcome;
- `run.completed` occurs only after required transcript state and terminal Run Journal evidence commit;
- explicit cancellation can stop queued work and propagates to active work;
- Gateway disconnection alone does not cancel the run;
- timeouts are normalized and cannot produce a later conflicting completion;
- no automatic retry replays completed side effects without a safe policy;
- lane release is tested for completion, failure, timeout, cancellation, and cleanup exceptions;
- process restart is not represented as successful resumption;
- Gateway handlers, harnesses, and concrete stores do not create independent run queues;
- the fixed V1 stage order is observable and cannot be reordered by hooks;
- every additional model/tool cycle has one preceding `checkpoint.decision`;
- only `CheckpointStage` returns `continue`, `complete`, `retry-attempt`, `cancel`, or `fail`;
- provider, Harness, and Tool Runtime tests prove that they cannot continue or retry privately;
- no-progress detection uses request, outcome, and state-delta signals rather than tool name alone;
- `FinalizeStage` executes exactly once for completed, failed, and cancelled runs;
- FinalizeStage does not start model calls or new tool side effects;
- runtime-wide model, tool, and browser budgets remain separate from per-session ordering.
- cumulative usage caps remain separate from run-local budgets and runtime capacity permits;
- each provider dispatch has a durable reservation and dispatch marker before network I/O;
- settlement, release, or uncertain state is recorded before a later checkpoint-authorized model cycle;
- cap blocks and accounting uncertainty do not trigger implicit model downgrade or provider replay.

Minimum automated validation should include:

1. two same-session runs never overlap;
2. two different-session runs can overlap when capacity permits;
3. FIFO ordering is preserved for three queued runs;
4. a queued run can be cancelled before starting;
5. an active cancellation emits one terminal outcome;
6. a completion-versus-cancellation race emits one terminal outcome;
7. reset conflicts or waits behind an active session lane;
8. a failed attempt may fail the run without emitting completion;
9. a later allowed attempt uses a new `attemptId` and the same `runId`;
10. transcript commit failure prevents `run.completed`;
11. required Run Journal failure prevents successful terminal completion and is reported explicitly;
12. journal entries remain monotonic and grouped by `runId`;
13. optional artifact failure marks degraded capture without fabricating success evidence;
14. lane ownership is released after exceptions;
15. connection closure does not alter run identity or terminal state;
16. a second model cycle cannot start without a checkpoint decision;
17. cancellation, max iteration, max tool calls, context pressure, and no-progress each produce typed checkpoint decisions;
18. a changing state delta prevents a false no-progress termination;
19. a repeated identical no-progress cycle warns and then terminates at configured thresholds;
20. provider and Harness internal retries are rejected or surfaced as explicit outcomes;
21. FinalizeStage runs once on success, failure, timeout, and cancellation;
22. finalization failure cannot emit `run.completed`;
23. two sessions respect independent session lanes while sharing bounded model/tool/browser permits;
24. a full per-session queue rejects the new request before transcript append and run acceptance;
25. older accepted queued prompts are never evicted by newer prompts;
26. rapid prompt submissions remain distinct FIFO runs and are not debounce-merged;
27. context overflow after permitted pruning produces a typed context signal and checkpoint decision rather than hidden compaction or provider retry.

## Revisit conditions

Revisit this decision when:

- same-run steering, collection, interruption, or prompt injection is required;
- multiple writer processes can mutate one session transcript;
- persistent scheduling, run resumption, or restart recovery is required;
- production availability requires relaxing the mandatory journal-write guarantee;
- runs move to background workers or distributed nodes;
- exactly-once or at-least-once execution becomes a product contract;
- a run must span multiple sessions or agents;
- transcript branching permits parallel runs from one logical session;
- tool execution becomes resumable across attempts;
- global capacity requires priorities, fairness classes, or preemption;
- checkpoint decisions must pause for human review or support a persistent suspended state;
- post-pruning context overflow needs a new recovery route or provider-specific token-count lifecycle;
- compaction becomes a first-class checkpoint decision and recovery stage;
- a native Harness cannot expose cycle boundaries required by the host checkpoint contract;
- a harness requires long-lived native threads that outlive one run;
- cancel-and-reset must become one atomic user operation.

## References

- `docs/decisions/0015-usage-accounting-and-cumulative-budget-enforcement.md`
- `docs/ARCHITECTURE.md`, section 6, **Core identities**
- `docs/ARCHITECTURE.md`, section 9.4, **Run and attempt loop**
- `docs/ARCHITECTURE.md`, section 9.7, **Runtime events**
- `docs/ARCHITECTURE.md`, section 11, **Sessions and transcripts**
- `docs/ARCHITECTURE.md`, section 21, **Lifecycle and composition**
- `docs/decisions/0002-core-runtime-identities-and-agent-ownership.md`
- `docs/decisions/0003-session-routing-transcript-separation-and-reset-semantics.md`
- `docs/decisions/0004-gateway-control-plane-and-protocol-contract.md`
- `docs/decisions/0005-agent-runtime-harness-and-model-provider-boundaries.md`
- `docs/decisions/0010-runtime-events-logs-transcripts-and-audit-separation.md`
- OpenClaw, **Command queue**: `https://docs.openclaw.ai/concepts/queue`
- OpenClaw, **Steering queue**: `https://docs.openclaw.ai/concepts/queue-steering`
- OpenClaw, **Agent loop**: `https://docs.openclaw.ai/concepts/agent-loop`
- OpenClaw, **Agent runtime architecture**: `https://docs.openclaw.ai/agent-runtime-architecture`
- GoClaw, **How GoClaw Works**: `https://docs.goclaw.sh/how-goclaw-works`
- GoClaw, **Context Pruning**: `https://docs.goclaw.sh/context-pruning`
- GoClaw, **Sessions and History**: `https://docs.goclaw.sh/sessions-and-history`
