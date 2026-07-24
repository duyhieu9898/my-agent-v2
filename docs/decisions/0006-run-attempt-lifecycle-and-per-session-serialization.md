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
- report completion before required transcript state is durable;
- treat Gateway connection loss as run cancellation;
- release a session lock before runtime cleanup and final writes complete.

OpenClaw currently serializes runs through a per-session lane and may also apply a separate global concurrency lane. It additionally protects transcript mutation through a session write lock. OpenClaw supports steering and queue modes for messages arriving during an active run.

`my-agent-v2` adopts the per-session serialization and lifecycle principles while keeping V1 smaller:

- one active run for a logical session;
- an in-process session-lane coordinator;
- ordinary later prompts queued as separate FIFO runs;
- no same-run steering, collection, or interruption modes in V1;
- no persistent run scheduler or crash recovery in V1;
- no automatic retry after observable output or side effects.

## Decision

Agent Runtime owns the run lifecycle, attempt lifecycle, per-session run lane, cancellation coordination, and terminal result classification.

The runtime flow is:

```text
validate run request
→ resolve agent and session
→ create runId and capture sessionId
→ enqueue in session lane
→ acquire session lane
→ mark run started
→ append run input once
→ load transcript and resources
→ assemble context
→ resolve model route and harness
→ create attemptId
→ execute prepared attempt
→ persist required transcript/runtime state
→ emit terminal run event
→ clean up runtime resources
→ release session lane
```

A run may contain zero, one, or multiple attempts:

- zero attempts when it is cancelled before attempt execution or fails during preparation;
- one attempt in the normal V1 path;
- multiple attempts only when an explicit retry, fallback, compaction-recovery, or harness-recovery policy permits it.

## Run lifecycle

A run progresses through these conceptual states:

```text
accepted
→ queued
→ running
→ completed | failed | cancelled
```

`accepted` and `queued` may initially be represented by one internal record, but their semantics remain distinct:

- **accepted** means the request was validated, the agent and session were resolved, a `runId` was created, and the run captured its target `sessionId`;
- **queued** means the run is waiting to acquire its session lane or a runtime-wide capacity permit;
- **running** means the run owns its session lane and runtime execution has started;
- **completed**, **failed**, and **cancelled** are terminal states.

Exactly one terminal transition is permitted for each `runId`.

The Agent Runtime must guard the terminal transition atomically so that completion, cancellation, timeout, and failure races cannot emit conflicting terminal results.

### Run acceptance

Before a run is accepted, Agent Runtime must have a coherent resolved identity snapshot containing at least:

```text
agentId
sessionKey
sessionId
runId
```

The run captures the resolved `sessionId` at acceptance.

If the same `sessionKey` later maps to a new `sessionId`, the accepted run continues to use the captured transcript instance.

A run request rejected during schema validation, agent resolution, ownership validation, or session resolution does not create a successful accepted run.

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

In V1, a new normal prompt for the same logical session becomes a new queued run.

It does not:

- modify the active run;
- interrupt an active tool call;
- append itself to the active attempt context;
- replace the active run;
- coalesce automatically with other queued prompts.

Queued prompts are processed in arrival order after the active run releases the lane.

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

A separate runtime-wide capacity limiter may cap parallel runs across different session lanes to control:

- provider rate limits;
- memory consumption;
- CPU usage;
- browser or platform contention;
- local model capacity.

The global limiter is resource policy, not session identity.

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
8. Attempt history must remain observable through structured events and logs even if only the final run result is returned to the caller.

Model fallback policy is owned by the model layer and coordinated by Agent Runtime. Harness recovery policy is owned by Agent Runtime and Harness Registry. Neither may create an unrelated new run without an explicit application request.

## Transcript write ordering

The session lane protects runtime-level ordering, but transcript correctness also remains a responsibility of `TranscriptStore`.

The following ordering rules apply:

1. The accepted run's user input is appended exactly once under lane ownership.
2. Tool calls and tool results preserve their logical pairing and order.
3. A later queued run cannot append its user input before the active run finishes its required transcript writes.
4. `run.completed` is emitted only after the successful turn's required writes commit.
5. A failed or cancelled run must not fabricate a completed assistant entry.
6. Streaming deltas may be transient and are not automatically durable transcript entries.
7. Store operations use explicit ordering fields or transactional append semantics rather than wall-clock timestamps alone.

The exact transcript-entry schema, partial-output retention, and context assembly rules are defined by the sessions, context, and future transcript-focused decisions.

The runtime path must not bypass `TranscriptStore` and write SQLite directly.

## Event ordering

Runtime lifecycle events must preserve these invariants:

```text
run.started
  attempt.started
    context/model/tool events
  attempt.completed | attempt.failed | attempt.cancelled
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

A lower-level timeout is normalized and returned to Agent Runtime. Agent Runtime determines whether it fails the attempt, triggers an allowed retry, or fails the run.

Timeouts must propagate cancellation signals where supported and must not release the session lane while owned work can still mutate the transcript.

A component that cannot be forcefully cancelled must declare that limitation. Its late result must be ignored after the owning attempt or run has become terminal.

## Cleanup and lane release

The session lane is released only after Agent Runtime has attempted to:

- stop or detach the active harness execution;
- cancel outstanding model and tool work;
- complete required transcript and runtime-state writes;
- emit or record the terminal run outcome;
- release attempt-local provider, browser, process, or temporary resources;
- unregister active-run cancellation handles.

Cleanup occurs for completed, failed, and cancelled runs.

Non-critical cleanup failures are logged and surfaced through diagnostics where appropriate. A failure that compromises transcript consistency or makes the terminal result unreliable must cause the run to fail rather than report success.

The lane must still be released through a guaranteed cleanup path so one broken run cannot permanently deadlock the session in memory.

## Run registry and durability

V1 may keep queued and active run state in memory.

Durable sources of truth remain:

- session routing state;
- transcript entries;
- other explicitly persisted domain state.

Gateway or process restart may lose:

- queued runs;
- active-run progress;
- transient streaming events;
- in-memory cancellation handles;
- waiters for a `runId`.

V1 does not claim automatic resumption or exactly-once run execution across process crashes.

After restart, incomplete work must not be presented as a completed run merely because partial transcript entries or streamed output exist.

Persistent run records, recovery, distributed workers, and exactly-once or at-least-once scheduling require a later ADR.

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

`my-agent-v2` intentionally differs or starts smaller in these ways:

- V1 queues ordinary same-session prompts as separate FIFO runs;
- same-run `steer`, `collect`, and `interrupt` modes are deferred;
- no global lane name or OpenClaw queue configuration is adopted as a public contract;
- SQLite transactions and store contracts provide persistence protection; a process-aware file lock is deferred while one process owns writes;
- V1 has no durable run ledger, persistent queue, or automatic restart recovery;
- V1 normally has one attempt and does not implement OpenClaw's provider failover or retry chain;
- automatic retry after visible output or completed side effects is prohibited until resumable semantics are explicitly designed.

## Consequences

### Positive

- Transcript and tool ordering remain deterministic within a logical session.
- Session reset cannot race with active transcript writes.
- Gateway reconnect does not redefine or cancel application work.
- Multiple sessions may use safe parallelism without permitting same-session collisions.
- Retries and future fallback can add attempts without changing `runId` semantics.
- Runtime events have a defined nesting and terminal ordering.
- Failure and cancellation cannot masquerade as successful completion.

### Negative

- A long-running turn blocks later turns for the same logical session.
- Queue wait time may become visible under tool-heavy workloads.
- Cancellation requires cooperation from model, harness, tool, and provider boundaries.
- The runtime must propagate identity, deadlines, and cancellation signals through many contracts.
- In-memory queues do not survive process restart.
- Future steering or interruption modes require careful transcript and harness changes.

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

### Direct transcript mutation bypasses the lane

Maintenance code, plugins, or future processes could write to the current transcript outside Agent Runtime.

Mitigation:

- expose transcript mutation only through owned contracts;
- require current-transcript replacement operations to acquire the session lane;
- add a stronger store-level write lock before supporting multiple writer processes or external maintenance.

### Process crash loses active state

An in-memory queue cannot prove whether an interrupted provider or tool side effect occurred.

Mitigation:

- do not claim automatic resumption or exactly-once execution;
- keep durable transcript writes atomic;
- surface restart as interrupted work rather than success;
- require a persistent run-ledger ADR before recovery is implemented.

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

### Automatically retry every failed attempt

Rejected because model output or side-effecting tools may already have produced observable results, making replay unsafe or duplicative.

### Mark a run completed before transcript commit

Rejected because clients could refresh authoritative state and fail to find the result announced by the completion event.

### Cancel runs when the originating connection closes

Rejected because connections do not own durable application work and clients may reconnect while a valid run continues.

### Implement a durable distributed queue in V1

Rejected because one local process does not yet require distributed scheduling, leases, recovery workers, or persistent queue complexity.

## Validation

This decision is correctly applied when:

- Agent Runtime creates and owns each `runId` and `attemptId` lifecycle;
- one `(agentId, sessionKey)` lane permits at most one active run;
- ordinary queued runs execute FIFO within that lane;
- different session lanes may execute independently subject to a separate capacity limit;
- reset and current-transcript replacement cannot race with an active run;
- a run continues using its captured `sessionId` even if later routing changes;
- `run.started` occurs after lane acquisition;
- user input is appended once per run, not once per attempt;
- every started attempt has exactly one terminal attempt event;
- every accepted run has at most one terminal run outcome;
- `run.completed` occurs only after required transcript state commits;
- explicit cancellation can stop queued work and propagates to active work;
- Gateway disconnection alone does not cancel the run;
- timeouts are normalized and cannot produce a later conflicting completion;
- no automatic retry replays completed side effects without a safe policy;
- lane release is tested for completion, failure, timeout, cancellation, and cleanup exceptions;
- process restart is not represented as successful resumption;
- Gateway handlers, harnesses, and concrete stores do not create independent run queues.

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
11. lane ownership is released after exceptions;
12. connection closure does not alter run identity or terminal state.

## Revisit conditions

Revisit this decision when:

- same-run steering, collection, interruption, or prompt injection is required;
- multiple writer processes can mutate one session transcript;
- persistent run status or restart recovery is required;
- runs move to background workers or distributed nodes;
- exactly-once or at-least-once execution becomes a product contract;
- a run must span multiple sessions or agents;
- transcript branching permits parallel runs from one logical session;
- tool execution becomes resumable across attempts;
- global capacity requires priorities, fairness classes, or preemption;
- a harness requires long-lived native threads that outlive one run;
- cancel-and-reset must become one atomic user operation.

## References

- `docs/ARCHITECTURE.md`, section 6, **Core identities**
- `docs/ARCHITECTURE.md`, section 9.4, **Run and attempt loop**
- `docs/ARCHITECTURE.md`, section 9.7, **Runtime events**
- `docs/ARCHITECTURE.md`, section 11, **Sessions and transcripts**
- `docs/ARCHITECTURE.md`, section 21, **Lifecycle and composition**
- `docs/decisions/0002-core-runtime-identities-and-agent-ownership.md`
- `docs/decisions/0003-session-routing-transcript-separation-and-reset-semantics.md`
- `docs/decisions/0004-gateway-control-plane-and-protocol-contract.md`
- `docs/decisions/0005-agent-runtime-harness-and-model-provider-boundaries.md`
- OpenClaw, **Command queue**: `https://docs.openclaw.ai/concepts/queue`
- OpenClaw, **Steering queue**: `https://docs.openclaw.ai/concepts/queue-steering`
- OpenClaw, **Agent loop**: `https://docs.openclaw.ai/concepts/agent-loop`
- OpenClaw, **Agent runtime architecture**: `https://docs.openclaw.ai/agent-runtime-architecture`
