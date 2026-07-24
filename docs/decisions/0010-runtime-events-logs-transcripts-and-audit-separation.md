# ADR 0010: Runtime Events, Logs, Run Journals, Transcripts, and Audit Separation

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
  - `docs/decisions/0006-run-attempt-lifecycle-and-per-session-serialization.md`
  - `docs/decisions/0007-context-assembly-and-transcript-mutation-authority.md`
  - `docs/decisions/0008-tool-runtime-policy-approval-and-sandbox-boundaries.md`
  - `docs/decisions/0009-storage-ownership-sqlite-and-migration-policy.md`
  - `docs/decisions/0015-usage-accounting-and-cumulative-budget-enforcement.md`

## Context

`my-agent-v2` needs several observable records for different consumers and purposes:

```text
runtime events
Gateway client events
technical logs
run journals
debug artifacts
session transcripts
future audit records
diagnostics, metrics, and traces
```

These records overlap in identifiers and timing, but they are not interchangeable.

The project is currently being developed and debugged. During this phase, ordinary production logging is not sufficient. Maintainers need to inspect one prompt as one coherent run, follow every meaningful runtime decision in order, identify the first incorrect step, compare a failing run with a corrected run, and promote verified behavior into regression evidence.

This requirement is not a claim that OpenClaw logging is inadequate. It is a local development requirement for `my-agent-v2`: V1 observability is intentionally development-first, while production deployments may later use a less detailed capture profile without replacing the architecture.

Without an explicit separation and evidence decision, implementation could drift into unsafe or unreliable patterns such as:

- using Pino log text as the source of truth for run state or tests;
- interleaving many prompts in one global log stream with no stable per-run order;
- reconstructing a transcript by replaying client events;
- storing complete prompts and tool outputs in an audit ledger;
- treating a Gateway event sequence as a durable global event log;
- driving domain behavior by parsing log strings;
- writing operational notices into the user-visible transcript merely for observability;
- assuming the absence of an audit row proves that no action occurred;
- requiring optional telemetry exporters for correct run completion;
- publishing terminal runtime events before required transcript and evidence writes commit;
- logging credentials, raw approval secrets, or unbounded tool payloads;
- capturing payloads without a redaction, size, retention, and access policy;
- defining one unbounded event table that mixes conversation content, metrics, logs, evidence, and compliance data.

The architecture already establishes several relevant boundaries:

- ADR 0004 defines Gateway events as a connection-delivered observable stream, not durable state;
- ADR 0006 defines run and attempt lifecycle transitions, per-session serialization, and terminal ordering;
- ADR 0007 makes `TranscriptStore` the canonical durable conversation-history boundary;
- ADR 0008 requires normalized tool, policy, approval, and execution lifecycle boundaries;
- ADR 0009 makes SQLite the initial canonical database behind domain-owned stores.

OpenClaw distinguishes structured diagnostics, technical logs, transcripts, audit history, and optional telemetry exports. `my-agent-v2` adopts those separation and privacy principles, then adds a local development-oriented `RunJournalStore` for deterministic per-run evidence and future test/debug loops.

## Decision

`my-agent-v2` will maintain five primary record classes with separate authority, purpose, schema, retention, and failure semantics:

| Record class | Primary purpose | Canonical authority | Durable in V1 |
|---|---|---|---|
| Runtime event | Typed lifecycle observation and in-process coordination | Owning application/runtime module | No general event store |
| Technical log | Human and operator diagnosis | Logging subsystem | File or configured log sink |
| Run Journal | Ordered, queryable execution evidence for one run | `RunJournalStore`, written through Agent Runtime and trusted lifecycle boundaries | Yes |
| Transcript entry | Canonical conversation and tool history | `TranscriptStore`, mutated through authorized session/runtime services | Yes |
| Audit record | Metadata-only accountability index | Future audit subsystem projecting trusted lifecycle boundaries | Deferred |

Debug artifacts are supporting payload objects referenced by Run Journal entries. They are not transcript entries, log lines, or audit records.

Gateway client events, metrics, traces, and diagnostics are projections or exports from these owned boundaries. They are not additional sources of domain truth.

The high-level flow is:

```text
owning runtime accepts or changes state
→ append required Run Journal evidence
→ commit required transcript or domain state
→ append the corresponding durable journal outcome
→ emit typed runtime event
→ project authorized event to Gateway clients
→ optionally derive logs, diagnostics, metrics, traces, or future audit records
```

Required journal writes are part of the V1 execution contract. Optional telemetry, client delivery, and Pino sinks are not.

## Runtime events

Runtime events are typed application records describing lifecycle transitions or observable runtime progress.

They are produced by the module that owns the lifecycle being reported.

Examples include:

```text
run.started
attempt.started
stage.started
context.prepared
model.requested
model.delta
model.completed
tool.requested
policy.evaluated
approval.requested
approval.resolved
tool.started
tool.completed
checkpoint.signal.detected
checkpoint.decision
stage.completed
attempt.completed
attempt.failed
attempt.cancelled
finalize.started
normalization.applied
finalize.completed
finalize.failed
run.completed
run.failed
run.cancelled
```

### Runtime event ownership

Ownership follows the operation:

- Agent Runtime owns run and attempt events;
- Context owns context-preparation events;
- Model Runtime owns normalized model transport observations;
- Tool Runtime owns tool, policy, approval, and execution events;
- Browser Runtime owns browser lifecycle observations;
- Gateway owns connection and protocol events.

An observer may transform or forward an event, but it must not redefine the lifecycle outcome.

### Runtime event envelope

A runtime event contract should carry only identities applicable at the emission point, such as:

```text
schemaVersion
eventName
occurredAt
sourceModule
agentId
sessionKey
sessionId
runId
attemptId
modelCallId
toolCallId
parentOperationId
normalized payload
```

Missing identities are omitted rather than fabricated.

Runtime events are typed discriminated unions. Domain code must not depend on parsing human-readable event text.

### Runtime event timing and delivery

A lifecycle event represents an observed transition; it does not itself make the transition durable.

Terminal success events are emitted only after required durable transcript, domain, and Run Journal writes have succeeded.

Runtime event observers are isolated. A failed optional observer must not corrupt the owning operation. The required Run Journal writer is not treated as an optional observer.

Runtime events may be dropped after process failure and are not a replay or recovery API. Durable evidence for completed and partial runs belongs to the Run Journal.

## Run Journal

The Run Journal is the development and verification evidence boundary for Agent Runtime execution.

It is a curated, append-oriented timeline of meaningful decisions and state transitions. It is not a copy of every internal function call and not a general-purpose event-sourcing system.

`RunJournalStore` is a domain contract consumed by Agent Runtime and trusted lifecycle services. Its concrete SQLite implementation is composed by bootstrap under ADR 0009.

### Per-run organization

Every accepted prompt creates a distinct `runId`. Journal entries are read in this order:

```text
runId + sequence
```

Sequence starts within the run and is monotonically increasing. A global total order across all sessions is not required.

The hierarchy is:

```text
sessionKey
└── runId
    └── attemptId
        ├── modelCallId
        └── toolCallId
```

This prevents many prompts and sessions from becoming one interleaved evidence stream.

### Required timeline

The exact event set may evolve through versioned schemas, but V1 must make the following meaningful phases observable when they occur.

Queue rejection occurs before a normal run is accepted and therefore is not required to have a Run Journal. It is exposed as a bounded application/technical event such as `run_queue.rejected` with request ID, `sessionKey`, capacity, and reason code, without prompt content.

```text
run_queue.admitted
run.accepted
agent.resolved
agent.snapshot.resolved
agent.resource.loaded | agent.resource.skipped | agent.resource.rejected | agent.resource.truncated
agent.bootstrap.started | agent.bootstrap.completed | agent.bootstrap.failed when applicable
session.resolved
run_lane.queued
run_lane.acquired
transcript.batch.started
transcript.batch.committed | transcript.batch.failed
transcript.input_appended
transcript.loaded
history.selection.started
history.selection.completed | history.selection.failed
memory.retrieval.started
memory.retrieval.completed | memory.retrieval.failed
memory.selection.completed
memory.write.requested | memory.superseded | memory.deleted | memory.purged when applicable
memory.write.completed | memory.write.failed when applicable
model_route.resolved
harness.selected
attempt.started
context.preparation.started
prompt.plan.started
prompt.section.included | prompt.section.skipped | prompt.section.truncated | prompt.section.rejected
prompt.plan.completed
prompt.rendered
context.prepared
provider.request.projected
usage.reservation.requested
usage.reservation.granted | usage.reservation.blocked
usage.dispatch.marked when granted
model.requested
model.completed | model.failed
usage.settlement.completed | usage.reservation.released | usage.settlement.uncertain
model.continuation.persisted
model.history.incompatible (when applicable)
history.repair.started | history.repair.completed | history.repair.failed (when explicitly invoked)
tool.requested
policy.evaluated
approval.requested
approval.resolved
tool.started
tool.completed
transcript.batch.started
transcript.batch.committed | transcript.batch.failed
transcript.appended
checkpoint.started
checkpoint.signal.detected (when applicable)
checkpoint.decision
checkpoint.completed
loop.repetition.warning (when applicable)
loop.no_progress.terminated | loop.budget.exhausted (when applicable)
attempt.completed | attempt.failed | attempt.cancelled
finalize.started
normalization.applied (when applicable)
finalize.completed | finalize.failed
run.completed | run.failed | run.cancelled
run_lane.released
```

A future implementation may add phases, but it must not remove evidence required to determine:

- what was selected;
- what input state was used;
- what decision was made;
- which side effect was attempted;
- what durable state changed, including committed transcript sequence ranges and memory/index revisions;
- where failure first became observable;
- which terminal outcome won.

### Stage and checkpoint taxonomy

Stage evidence uses stable architecture-level identifiers rather than class names or log text.

Applicable journal entries include:

```text
stageId
stagePhase: setup | iteration | finalize
iteration
attemptId
stage.started
stage.completed | stage.failed | stage.cancelled
```

`CheckpointStage` entries include a bounded snapshot of evaluated budgets and decisive signals:

```text
checkpoint decision
stable reason code
iteration and elapsed time
model-call and tool-call counts
context/token usage and limits
run-local model-call budget and cumulative usage reservation/settlement status
cancellation state
retryability and side-effect safety
progress or no-progress fingerprints
```

Every additional model/tool cycle must be preceded by one durable `checkpoint.decision` authorizing `continue`. A new attempt must be preceded by a `retry-attempt` decision and the prior attempt terminal record. Journal readers can therefore prove why the loop continued or stopped without parsing Pino output.

### Transcript and history evidence

Transcript evidence is structured around batches and sequence ranges rather than human-readable messages.

Applicable metadata includes:

```text
transcriptBatchId
sessionId
expectedTailSequence
committedStartSequence and committedEndSequence
entry count and entry-class counts
structural group IDs or aggregate hash
provider-continuation count and validation status
history cursor schema version
history selected start/end sequence
selected structural-group count
history structure validation result
```

Journal evidence does not duplicate full transcript bodies. It proves what range was read or changed and links privileged debug artifacts only when the capture profile permits them.

A failed atomic batch records that no transcript sequence range committed. A stale-tail conflict is distinguishable from a storage outage or schema failure.

### Memory evidence

Memory evidence proves which durable knowledge was considered or changed without turning the Run Journal into a second memory store.

Retrieval metadata includes:

```text
agentId and runId
memory index revision
search-policy version
query hash and search mode
candidate count
selected memory IDs and revisions
selected content hashes
scores or ranking positions
result and token budgets
included token estimate
recall snapshot hash
skip or rejection reasons
```

Mutation metadata includes:

```text
operation ID
memory ID and revision
provenance references
policy and approval outcome
before and after status
content hash
index revision before and after
transaction result
```

Journal rows do not duplicate unrestricted memory bodies. Authorized debug artifacts may contain bounded redacted projections when the capture profile and access policy permit them.

### Journal entry envelope

Each journal entry includes at least:

```text
eventId
schemaVersion
runId
sequence
occurredAt
sourceModule
eventName
status
applicable correlation IDs
parentOperationId
stageId and iteration when applicable
normalized bounded metadata
artifact references or content hashes
normalized error metadata
```

Durations may be recorded on completion entries or as explicit start/end pairs.

Journal consumers must use typed fields and versioned schemas. Tests must not parse human-readable messages.

### Run manifest

Each run has a manifest or equivalent first-class metadata record containing enough information to explain the execution environment:

```text
runId
agentId
agentRevision
agent availability and bootstrap state at admission
resource-manifest version, aggregate hash, and typed resource references
resource precedence-policy version
sessionKey
sessionId
acceptedAt
captureProfile
application build or Git revision
configuration fingerprint
agent-definition fingerprint
model provider and exact model ID
provider adapter, API surface, and SDK version
provider store mode
provider request and interaction correlation IDs when available
harness ID and version
registered tool fingerprint
policy fingerprint
memory configuration and policy fingerprint
memory index revision and frozen recall-snapshot hash
context manifest, Prompt Plan, prompt-profile, renderer, sanitization, budget, pruning-policy, token-estimator, and token-count-policy versions
prompt-plan, rendered-system, stable-prefix, conversation-projection, tool-definition, attachment, continuation-reference, and provider-request hashes
context-component hashes
per-resource role, mutability, source hash, included hash, and transformation status
transcript session ID, head sequence before admission, and terminal head sequence
transcript batch IDs and committed sequence ranges
history selection range, structural-group count, and validation status
context tokens before/after pruning, measurement mode, count preflight status, and reduction summary
derived-data cache generation or aggregate hit/miss/rebuild summary when relevant
provider-reported input, output, cached, tool-use, and thinking usage when available
usage reservation ID, usage record ID, cap-policy revisions, estimation-rule version, price revision, and accounting status
usage and timing summary
terminal status and normalized error
```

The manifest records fingerprints and references rather than duplicating every payload.

Agent resource evidence must distinguish loaded, skipped, rejected, and truncated resources. Required identity or operating-rule overflow is recorded as a context-preparation failure; optional truncation records its deterministic rule, original/included sizes, and hashes. A resource modified after run admission does not change the active run manifest.

Bootstrap evidence records the resource hash, prior and next bootstrap state, responsible run or management command, and failure reason. Bootstrap completion does not silently delete source material.

For V1 model execution, the exact model ID must be recorded as `gemini-3.5-flash` when that route is used.

Gemini model-call evidence records bounded metadata such as:

```text
API surface: Interactions API
store mode: false
provider request ID when available
interaction ID when returned
provider status or finish reason
ordered response step types
function-call and function-result counts
thought-signature count and hashes
continuation persisted and validated status
input, output, cached, tool-use, and provider-reported thinking usage when available
implicit prompt-cache support and observed cached-token count when available
explicit provider cache object used: false
provider normalization or explicit history-repair decisions
```

Raw thought signatures and private model reasoning are not Run Journal payloads. The journal proves that required continuation was observed, persisted, and reused through counts, hashes, references, and validation results.

### Normalization evidence

Any material transformation between provider/Harness output, transcript representation, and client projection is observable as a typed normalization decision.

A normalization record includes applicable:

```text
normalization rule ID
source and target representation
before hash
artifact reference when capture permits
after hash
reason code
truncation or redaction status
```

Expected normalization includes provider-only metadata removal, tool-only empty-content handling, bounded truncation, and conversion into host-normalized result types.

Normalization must not silently repair malformed tool calls, collapse provider history, remove unexpected model content, or change a policy/tool outcome. Such recovery requires an explicit typed repair operation and journal evidence.

### Prompt-plan and provider-request evidence

Prompt planning is a first-class evidence boundary for each model call.

Typed events include:

```text
prompt.plan.started
prompt.source.resolved
prompt.section.included
prompt.section.skipped
prompt.section.truncated
prompt.section.rejected
prompt.plan.completed
prompt.rendered
provider.request.projected
```

Applicable metadata includes prompt profile/version, Context Manifest and Prompt Plan hashes, section IDs/source refs, authority/trust/stability/budget classes, renderer and transformation versions, measurements, sanitization/delimiter rules, stable/run/dynamic hashes, rendered-system/conversation/tool/attachment/continuation hashes, and provider-request hash.

Journal rows do not copy unrestricted bodies or raw requests. Development capture may attach redacted manifests, Prompt Plans, rendered sections, or requests as bounded access-controlled artifacts.

Prompt evidence proves what the host planned, transformed, and projected. It does not turn prompt text into authorization or substitute for canonical resources, transcript, registry, policy, or continuation storage.

### Context-pruning and cache evidence

Context reduction is represented as typed evidence rather than inferred from a smaller prompt body. Applicable events include:

```text
context.measurement.completed
context.pruning.started
context.result.soft_trimmed
context.result.hard_cleared
context.pruning.completed
context.budget.exceeded
cache.derived.hit
cache.derived.miss
cache.derived.rebuilt
provider.prompt_cache.observed
```

Required pruning metadata includes policy/rule version, protected structural range, eligible-result IDs, before/after hashes and byte/token measurements, artifact references, measurement mode, token-count preflight count, and terminal reason. Raw omitted payloads remain in their owning transcript/artifact boundary rather than journal rows.

Derived-data cache events are diagnostic and may be aggregated; they prove optimization behavior but never authorize execution or substitute for source revision/hash evidence. Provider implicit-cache evidence records support status, stable-prefix hash/tokens, total input tokens, provider-reported cached tokens, and hit ratio when derivable. Cache misses are valid execution outcomes.

### Usage accounting evidence

Usage evidence proves what was reserved, dispatched, settled, released, blocked, or left uncertain without turning the Run Journal into the cumulative accounting store.

Typed events include:

```text
usage.reservation.requested
usage.reservation.granted
usage.reservation.blocked
usage.dispatch.marked
usage.settlement.completed
usage.reservation.released
usage.settlement.uncertain
usage.reconciliation.completed
```

Applicable metadata includes:

```text
usageReservationId and usageRecordId
modelCallId, runId, attemptId
provider and exact model ID
matched cap-policy IDs and revisions
UTC window starts
estimated/reserved tokens and cost
measurement mode and estimation-rule version
normalized actual usage
price revision and derived cost
remaining headroom when safely reportable
terminal accounting status and stable reason code
```

The journal never scans or aggregates itself to enforce a cap. `UsageLedgerStore` under ADR 0015 is authoritative for cumulative totals and reservation state.

A reservation block precedes any provider request. A dispatch marker precedes provider network I/O. A settlement, release, or uncertain record precedes the checkpoint decision that consumes the model-call outcome.

Raw provider billing payloads, prompt/response bodies, credentials, and private reasoning are excluded. Debug artifacts are not required for accounting correctness.

### Debug artifacts

Large or sensitive payloads do not belong inline in journal rows or Pino messages.

Examples include:

```text
resolved agent and redacted Context manifests
redacted Prompt Plan
redacted rendered system/developer sections
assembled context
normalized model request
normalized model response
tool arguments
tool result
browser observation
screenshot
transcript delta
diagnostic bundle
```

These are stored as bounded debug artifacts. A journal entry references an artifact using metadata such as:

```text
artifactId
contentType
sizeBytes
contentHash
redactionStatus
storageLocation
```

Binary data is never embedded directly into a JSON log line.

Raw provider continuation signatures are excluded from ordinary debug artifacts. A privileged provider-history diagnostic may expose only bounded metadata by default; raw export requires a separate explicit security decision.

Artifact storage may use files for large blobs with SQLite metadata and ownership references. The database remains the authority for indexing and deletion relationships.

### Capture profiles

V1 defines three capture profiles:

#### `development`

```text
technical log level: debug or trace
Run Journal: full meaningful lifecycle and decisions
debug artifacts: enabled for normalized/redacted payloads
redaction: mandatory
automatic journal deletion: disabled
```

This is the default during active architecture and implementation development.

#### `verification`

```text
technical log level: info or debug
Run Journal: complete stable evidence schema
debug artifacts: only payloads required for comparison or replay
export and pinning: enabled
```

This profile is used to produce evidence bundles and regression fixtures.

#### `production`

```text
technical log level: info or warn
Run Journal: lifecycle, decisions, timings, identifiers, and normalized errors
debug artifacts: disabled by default
retention: configurable
```

Production may reduce payload capture, but it must preserve enough structured metadata to identify the run path and terminal result.

Capture profiles change detail and retention. They do not change identity semantics, lifecycle ordering, policy decisions, or transcript authority.

A later control surface may temporarily enable detailed capture for one run, one session, or a bounded duration without enabling global trace capture.

### Evidence pinning, export, and comparison

A run may be marked as pinned evidence.

Pinned evidence:

- is excluded from ordinary clear operations by default;
- records why and when it was pinned;
- can be exported as a versioned evidence bundle;
- can be compared with another run through typed fields and artifact hashes.

Supported application operations should eventually include equivalents of:

```text
journal list
journal show <runId>
journal export <runId>
journal diff <runId> <runId>
journal pin <runId>
journal unpin <runId>
```

CLI syntax is not fixed by this ADR; the domain capabilities are.

### Manual clear and retention

During development, Run Journal and debug artifacts are not silently auto-pruned.

Clear operations are explicit and independently scoped:

```text
clear one run
clear one session's unpinned runs
clear runs before a date
clear all unpinned runs
```

A destructive clear operation must:

- support a dry-run or preview;
- report affected runs, entries, artifacts, and size;
- require explicit confirmation for broad deletion;
- exclude pinned evidence unless explicitly overridden;
- delete journal entries and owned artifacts coherently;
- not delete transcripts, technical logs, or audit records unless separately requested.

Session reset does not clear Run Journal evidence.

Usage-ledger retention and reconciliation are independently scoped; clearing development evidence does not erase cumulative accounting state.

The system reports journal and artifact storage usage. Warning and hard-limit behavior is explicit configuration. Reaching a limit must not silently delete evidence. A configured degraded profile may disable optional artifact capture, but required journal lifecycle writes remain fail-closed.

### Test and debug-loop access

The journal exposes typed query/export contracts suitable for automated tooling.

A debug loop can:

```text
inspect failed run
→ find the first divergent or failed phase
→ inspect referenced artifacts
→ change implementation
→ rerun
→ diff both journals
```

A verification loop can:

```text
export a verified run
→ replace model or tools with controlled fakes where needed
→ execute a regression fixture
→ assert lifecycle order, policy decisions, transcript delta, and terminal state
```

Live model verification must account for model nondeterminism. Tests should prefer structural and semantic assertions over exact response text unless a fake provider makes output deterministic.

The Run Journal records observable execution and decisions. It must not claim to capture or expose private model chain-of-thought.

### Run Journal failure semantics

A run is not accepted as fully traceable until its run manifest and `run.accepted` evidence can be written.

The following journal writes are required:

- run acceptance and identity resolution;
- lane acquisition;
- attempt start and terminal outcome;
- model request and normalized completion or failure;
- policy and approval decisions;
- tool start and terminal outcome;
- required transcript/domain commit summaries;
- exactly one terminal run outcome.

If a required journal write fails:

- the operation fails closed before an unrecorded side effect when possible;
- an active run transitions to a normalized failure if consistency can still be recorded;
- the application reports observability degradation explicitly;
- it must not announce successful completion without the required terminal evidence.

Failure to store an optional debug artifact does not automatically fail a correct run. It marks the affected entry and run as `captureDegraded` with a normalized reason.

## Gateway client events

Gateway events are authorized projections for connected clients.

They may include lifecycle progress and streaming output, but they remain:

- connection-delivered;
- subject to gaps and reconnects;
- filtered by client capability and future scope;
- non-authoritative for durable state;
- sequenced independently from Run Journal entries.

Clients recover durable state through RPC and application APIs. A Gateway sequence number is never a Run Journal sequence number.

Content-bearing streams such as `model.delta` must not automatically be copied into technical logs or audit records. Detailed capture follows the active Run Journal capture profile and redaction rules.

## Technical logs

Pino provides structured technical logs for developers and operators.

Logs are optimized for terminal reading, filtering, and unexpected implementation diagnostics. They are not the test evidence API and are not parsed to reconstruct authoritative run history.

Logs may include stable fields such as:

```text
level
time
module
operation
connectionId
agentId
sessionKey
sessionId
runId
attemptId
modelCallId
toolCallId
errorCode
durationMs
bounded size and count measurements
```

Human-readable messages remain concise. Domain code must not branch on log output or use successful logging as proof that state was committed.

### Log levels

The initial levels follow Pino conventions:

```text
fatal
error
warn
info
debug
trace
```

Expected usage:

- `fatal`: process cannot safely continue;
- `error`: operation failed or an invariant was violated;
- `warn`: degraded, suspicious, or recoverable behavior requiring attention;
- `info`: bounded lifecycle and operational milestones;
- `debug`: implementation diagnostics useful during investigation;
- `trace`: high-volume low-level details enabled deliberately.

Normal high-frequency streaming deltas must not produce unbounded `info` logs.

### Structured errors and content

Logs record normalized error metadata where applicable:

```text
error code
error category
operation
retryability
provider or tool identity
status
bounded cause metadata
```

Provider responses, shell output, browser content, prompts, tool arguments, transcripts, and credentials are not logged by default. Detailed payloads belong in access-controlled debug artifacts under an appropriate capture profile.

### Log retention

Log retention is operational configuration and may use rotation, truncation, collection, or deletion.

Loss or rotation of technical logs does not delete Run Journal evidence, transcripts, sessions, or future audit records.

## Transcripts

Transcripts are canonical conversation and tool history used by product surfaces and context assembly.

They contain ordered entries associated with a `sessionId`, such as:

```text
user message
assistant message
tool call
tool result
compaction entry
structured session notice
```

A transcript is not a complete execution trace. It intentionally omits queueing, provider retries, internal selection decisions, technical timing, connection state, and many failed intermediate operations.

`TranscriptStore` remains the only canonical transcript persistence contract. The logger, Gateway broadcaster, Run Journal store, diagnostics exporter, audit projector, Harness, provider adapter, and tool implementation must not append canonical transcript history directly.

A journal may reference transcript entry IDs and before/after ranges, but it must not become an alternate transcript source of truth.

## Audit records

A future audit subsystem will provide a durable, metadata-only accountability ledger for selected trusted lifecycle boundaries.

Audit answers questions such as who or which agent invoked a capability, what policy decision applied, whether approval was granted, and whether the action completed.

Audit does not replace:

- Run Journal execution evidence;
- transcripts;
- technical logs;
- task or run state;
- external identity-provider audit logs.

Audit may eventually require stronger integrity, retention, actor identity, or compliance guarantees. Until that implementation exists, `my-agent-v2` must not claim complete auditability or compliance-grade evidence.

Run Journal is development and verification evidence, not a compliance ledger. It may be manually cleared and may contain debug artifacts under explicit profiles.

## Diagnostics, metrics, and traces

Diagnostics, metrics, and traces are derived observability products.

They may consume runtime events, technical log records, and bounded Run Journal metadata. They do not gain authority to change run, transcript, or policy outcomes.

OpenTelemetry and external exporters are optional. Export failure must not invalidate a run whose required local journal and domain writes succeeded.

Metrics use bounded labels. Raw `sessionKey`, prompt text, tool arguments, filesystem paths, and other high-cardinality or sensitive values are not used as metric labels by default.

## Privacy, redaction, and access

Secrets and raw credentials are never written to technical logs, Run Journal metadata, debug artifacts, diagnostics, traces, or audit records.

Opaque Gemini thought signatures are not credentials, but they are treated as sensitive provider-continuation data. Ordinary observability records contain only counts, hashes, references, and validation status.

Redaction is centralized and applied before persistence or export.

Content handling defaults are:

```text
technical logs: metadata only
Run Journal: metadata, decisions, references, and hashes
debug artifacts: profile-controlled, bounded, redacted content
transcripts: canonical user and model content under session access rules
audit: metadata only
telemetry: bounded metadata unless separately authorized
```

Redaction is not authorization. Journal and artifact APIs require explicit local application authority and future scope checks when remote access is introduced.

A record must indicate when content was omitted, truncated, redacted, or failed to capture. Silent partial evidence is not acceptable.

## Schema evolution

Runtime event, Gateway event, Run Journal, debug artifact, transcript, log-field, and audit schemas evolve independently.

Run Journal and artifact records include explicit schema versions. Evidence export bundles include a bundle version and the schema versions of contained records.

Breaking changes to typed application or public Gateway contracts require their normal compatibility process. Internal diagnostic fields may evolve more freely, but stable test and evidence contracts must remain versioned and documented.

## Retention and deletion

Each record class has independent retention:

- transcripts follow session and user-history policy;
- curated memory follows independent explicit delete/purge policy;
- technical logs follow operator logging configuration;
- Run Journal follows capture-profile and manual-clear policy;
- debug artifacts follow their owning journal run and may be cleared with it;
- diagnostics and telemetry exports are bounded operational data;
- future audit follows its own retention and integrity policy.

User-facing reset and deletion operations document which classes they affect.

Default relationships are:

- session reset creates a new transcript instance but does not clear journal evidence;
- clearing technical logs does not clear journals;
- clearing a journal does not clear transcripts;
- clearing a journal does not clear future audit records;
- ordinary journal clear excludes pinned evidence.

## OpenClaw alignment and intentional differences

This decision aligns with OpenClaw principles by:

- separating technical logs from structured diagnostics;
- treating transcripts as conversation history rather than an audit ledger;
- keeping audit metadata-only and separate from transcripts and logs;
- minimizing sensitive content in ordinary diagnostics;
- keeping optional telemetry outside runtime correctness.

`my-agent-v2` intentionally adds a deeper local development evidence layer:

- durable per-run Run Journal entries;
- per-run monotonic sequencing;
- capture profiles;
- debug artifact references;
- manual clear and evidence pinning;
- typed export and diff contracts for test/debug loops.

This is a local development choice, not a requirement that OpenClaw adopt the same storage model.

V1 still does not implement:

- a persistent general-purpose event store;
- event sourcing or arbitrary replay of domain state;
- a durable scheduler or automatic run resumption;
- a complete audit ledger;
- compliance-grade retention or tamper evidence;
- mandatory external telemetry.

## Consequences

### Positive

- One prompt is inspectable as one ordered run rather than a fragment of a global log stream.
- Maintainers can locate the first incorrect runtime phase and inspect bounded evidence.
- Failing and corrected runs can be compared using typed schemas.
- Verified runs can become regression evidence without parsing Pino text.
- Production can reduce payload capture through profiles without replacing lifecycle contracts.
- Transcript, log, journal, and audit responsibilities remain clear.
- Sensitive content has a defined storage, redaction, and access boundary.

### Negative

- V1 gains additional persistent schema, storage usage, and write overhead.
- Required journal writes add failure paths to the run lifecycle.
- Development capture can consume substantial disk space.
- Export, diff, pinning, and manual-clear tooling require implementation and tests.
- Schema evolution must preserve evidence-reader compatibility.

## Risks and trade-offs

### Resource evidence leaks sensitive or misleading state

Agent resources may contain personal data or secrets, while a hash-only manifest may still be misleading if role, scope, or truncation is omitted.

Mitigation:

- journal typed role, scope, mutability, decision, and bounded sizes;
- store bodies only as redacted access-controlled artifacts under an enabled profile;
- never place raw credentials in resources or artifacts;
- distinguish source hash from included hash;
- version precedence and transformation rules.

### Excessive capture volume

Development payloads may grow quickly.

Mitigation:

- keep journal metadata bounded;
- store large content as artifacts;
- show storage usage and thresholds;
- require manual clear during development;
- allow production and targeted capture profiles.

### Evidence becomes an alternate source of truth

Developers may attempt to reconstruct or mutate domain state from journal rows.

Mitigation:

- keep journal APIs read-oriented except lifecycle append and retention operations;
- reference transcript and domain IDs rather than duplicate canonical records;
- document that replay is a test/debug operation, not production recovery.

### Required journal failure blocks work

Fail-closed evidence can reduce availability.

Mitigation:

- keep required entries compact;
- separate optional artifacts from required metadata;
- test disk-full and SQLite failure behavior;
- report degraded capture explicitly;
- revisit only when production availability requires a different profile guarantee.

### Redaction creates false confidence

Sensitive values may appear in nested provider or tool structures.

Mitigation:

- central redaction before persistence;
- allowlist safe metadata where practical;
- recursive secret-pattern tests;
- size limits and truncation markers;
- treat artifact access as sensitive even after redaction.

### Provider metadata is over-captured

Native Gemini steps may contain sensitive or high-volume continuation data.

Mitigation:

- journal only typed summaries, counts, hashes, references, and validation status;
- persist raw required continuation only in the owned provider sidecar;
- exclude raw signatures from normal artifacts and exports;
- test recursive redaction and bounded metadata schemas.

### Test fixtures overfit nondeterministic model output

Live Gemini responses may vary.

Mitigation:

- assert lifecycle and invariants;
- use fake model/tool adapters for deterministic replay;
- use semantic evaluation for live model comparisons;
- record exact model, adapter, policy, context, checkpoint-budget, and normalization-rule fingerprints.

## Rejected alternatives

### Record only `agentId` without its resolved revision

Rejected because two runs with the same agent ID may use different identity resources, policies, tools, or model defaults and therefore cannot be compared or reproduced from the ID alone.

### Copy all agent resource bodies into every journal row

Rejected because it duplicates sensitive content, expands storage, obscures the timeline, and weakens independent retention and access controls. Manifests and optional artifacts are the proper boundaries.

### Use one giant prompt-text snapshot as the evidence API

Rejected because it loses source-to-section mapping, trust and authority classes, budget decisions, structured turns, tools, attachments, continuation, and transformation provenance.

### Use technical logs as the evidence and test API

Rejected because logs rotate, mix concurrent work, optimize for human diagnosis, and do not provide stable typed schemas or required durability.

### Store every internal runtime event permanently

Rejected because a Run Journal is a curated evidence timeline, not an unbounded copy of all high-frequency events or an event-sourcing architecture.

### Log checkpoint decisions only as human-readable text

Rejected because test and debug loops require typed reasons, evaluated budgets, and progress fingerprints that remain stable across log formatting changes.

### Let normalization silently repair output

Rejected because invisible repair makes the observed transcript or client result diverge from provider behavior without evidence and can hide repeatable bugs.

### Put execution evidence into the transcript

Rejected because queueing, provider selection, policy details, retries, and diagnostics are not conversation history and would pollute user/model context.

### Use transcripts as the audit or evidence ledger

Rejected because transcripts may reset or compact and do not record complete execution decisions or failed intermediate operations.

### Store raw payloads inline in one JSONL file

Rejected because large and sensitive content would make timelines unreadable, retention coarse, redaction fragile, and random access expensive.

### Use one universal observability table

Rejected because runtime events, logs, journals, transcripts, artifacts, and audit have different authority, schemas, access, retention, and failure semantics.

### Auto-delete old development evidence by default

Rejected because silent pruning would remove the material needed to reproduce and verify bugs. Manual clear and explicit configured production retention are preferred.

### Require OpenTelemetry for V1 correctness

Rejected because external telemetry is optional infrastructure and does not replace local durable evidence.

### Copy raw Gemini continuation into technical logs or journal rows

Rejected because the continuation is required provider state, not human-readable diagnostic text. Observability retains bounded proof while the owned sidecar retains the exact opaque value.

### Treat cache hits as correctness evidence

Rejected because application and provider caches are optional optimizations. Correctness evidence comes from source revisions, Prompt Plan and request hashes, canonical stores, and provider outcomes; cache presence must not change semantics.

### Store pruned payloads inline in journal rows

Rejected because pruning evidence needs hashes, measurements, rule IDs, and artifact references, not a second copy of large or sensitive tool output.

### Capture private model chain-of-thought

Rejected because the system only records observable inputs, outputs, tool calls, decisions, and lifecycle metadata. Private model reasoning is not required for correctness evidence.

### Use the Run Journal as the Usage Ledger

Rejected because per-run development evidence has different retention, query, failure, and transaction semantics and cannot atomically reserve cumulative budget across concurrent sessions.

## Validation

This decision is correctly applied when:

- each accepted run has one manifest and ordered journal entries scoped by `runId`;
- every manifest records `agentId`, immutable `agentRevision`, resource-manifest hash, and tool/policy/sandbox fingerprints;
- resource evidence distinguishes loaded, skipped, rejected, and truncated inputs with typed roles and hashes;
- required-resource overflow and bootstrap transitions are represented by typed events;
- a resource edit after admission cannot change the active run manifest;
- journal sequence is monotonic within a run and independent of Gateway sequencing;
- required stage, model, policy, tool, checkpoint, finalization, transcript-commit, attempt-terminal, and run-terminal boundaries are journaled;
- each model call records prompt profile, Prompt Plan identity, section decisions, renderer/transformation versions, and provider-request projection hashes;
- context evidence records source guarding, protected structural range, pruning decisions, before/after measurements, estimator/count policy, and post-pruning overflow status;
- derived-data cache evidence cannot replace source revision/hash evidence or policy checks;
- Gemini evidence records implicit caching only, cached-token usage when available, and that no explicit cache object was used;
- each provider call records usage reservation/grant-or-block, durable dispatch, and settlement/release/uncertain evidence in lifecycle order;
- usage evidence references Usage Ledger identities and policy/price revisions without becoming the cumulative enforcement authority;
- clearing Run Journal evidence does not delete usage records or active/uncertain reservations;
- prompt bodies and raw requests remain out of ordinary journal rows while redacted debug artifacts are explicit and access-controlled;
- every additional model/tool cycle has a preceding durable checkpoint decision;
- transcript batch evidence identifies expected tail, committed range, and all-or-nothing outcome;
- history selection evidence identifies sequence range, structural-group count, and validation result;
- queue-full rejection is observable without fabricating an accepted run journal;
- checkpoint entries contain typed reason codes, evaluated limits, and bounded progress fingerprints;
- stage entries identify stage ID, phase, attempt, and iteration where applicable;
- material provider/Harness/transcript/client normalization is represented by a stable rule ID and before/after evidence;
- exactly one terminal run journal entry exists for every terminal run;
- successful terminal client events follow required transcript/domain and journal writes;
- Pino logs are not parsed to drive domain behavior or automated verification;
- `TranscriptStore` remains the only canonical transcript persistence contract;
- journal entries reference transcript records rather than replacing them;
- detailed content is stored only as bounded, redacted, access-controlled artifacts under an enabled capture profile;
- API keys and credentials never appear in logs, journals, artifacts, diagnostics, or audit;
- raw Gemini thought signatures never appear in ordinary logs, journals, Gateway events, or user-visible transcript history;
- Gemini journal evidence includes API surface, `store=false`, step types, continuation counts/hashes, and persistence validation;
- provider-history incompatibility and any explicit repair are represented as typed journal events;
- artifact capture failure marks `captureDegraded` and does not silently disappear;
- journal write failure follows the declared fail-closed behavior;
- development, verification, and production profiles are covered by configuration tests;
- manual clear supports preview, broad-operation confirmation, and pinned-evidence exclusion;
- session reset and each clear operation affect only documented record classes;
- typed journal export can be consumed without parsing log text;
- transcript fixtures can assert atomic batch boundaries, contiguous sequence ranges, and structural history selection;
- tests cover event ordering, stage ordering, checkpoint authority, no-progress decisions, finalization, normalization evidence, journal ordering, redaction, disk/storage failure, terminal uniqueness, and evidence diff semantics;
- pruning evidence can be compared without storing omitted payloads inline;
- provider cached-token evidence remains optional usage metadata and a cache miss is not an error;
- no component claims event sourcing, automatic run recovery, or compliance-grade audit guarantees.

## Revisit conditions

Revisit this decision when:

- production availability requirements cannot tolerate required local journal writes;
- a persistent general-purpose event store or domain replay becomes a product requirement;
- automatic run resumption or distributed workers require a durable scheduler and recovery ledger;
- journal volume requires partitioning, compression, or a backend other than the V1 topology;
- evidence must be tamper-evident, signed, or immutable;
- audit records become required for legal, security, or compliance guarantees;
- multiple users require separate evidence access and deletion authority;
- remote clients require resumable event cursors rather than RPC refresh;
- a public test/evaluation SDK stabilizes around Run Journal contracts;
- unified retention or legal deletion must span transcripts, journals, logs, artifacts, and audit;
- model providers expose new observability data with separate privacy requirements;
- checkpoint schemas become a public test/evaluation API requiring compatibility guarantees;
- agent-resource manifests, revisions, or bootstrap evidence become a public replay/evaluation API;
- memory retrieval or mutation evidence becomes a public replay/evaluation API or requires content-level capture;
- normalization rules require independent versioning or user-visible compatibility contracts;
- context-pruning evidence becomes a public replay/evaluation contract;
- cache telemetry requires stable schemas, cross-process aggregation, or cost-accounting guarantees.

## References

- `docs/decisions/0015-usage-accounting-and-cumulative-budget-enforcement.md`
- `docs/decisions/0014-memory-ownership-retrieval-and-evolution.md`
- `docs/ARCHITECTURE.md`, section 7, **Gateway architecture**
- `docs/ARCHITECTURE.md`, section 9, **Agent Runtime architecture**
- `docs/ARCHITECTURE.md`, section 11, **Sessions and transcripts**
- `docs/ARCHITECTURE.md`, section 13, **Tool Runtime**
- `docs/ARCHITECTURE.md`, section 20, **Storage and migrations**
- `docs/ARCHITECTURE.md`, section 21, **Events, logs, Run Journal, and audit**
- `docs/decisions/0004-gateway-control-plane-and-protocol-contract.md`
- `docs/decisions/0006-run-attempt-lifecycle-and-per-session-serialization.md`
- `docs/decisions/0007-context-assembly-and-transcript-mutation-authority.md`
- `docs/decisions/0008-tool-runtime-policy-approval-and-sandbox-boundaries.md`
- `docs/decisions/0009-storage-ownership-sqlite-and-migration-policy.md`
- OpenClaw logging: `https://docs.openclaw.ai/logging`
- OpenClaw OpenTelemetry export: `https://docs.openclaw.ai/gateway/opentelemetry`
- OpenClaw audit history: `https://docs.openclaw.ai/gateway/audit`
- OpenClaw diagnostics export: `https://docs.openclaw.ai/gateway/diagnostics`
- OpenClaw session management: `https://docs.openclaw.ai/concepts/session`
- Gemini Interactions API: `https://ai.google.dev/gemini-api/docs/interactions-overview`
- Gemini thought signatures: `https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures`
- GoClaw, **Context Pruning**: `https://docs.goclaw.sh/context-pruning`
- GoClaw, **Caching**: `https://docs.goclaw.sh/caching`
- Gemini context caching: `https://ai.google.dev/gemini-api/docs/caching`
- Gemini token counting and usage: `https://ai.google.dev/gemini-api/docs/tokens`
- GoClaw Gemini provider reference: `https://docs.goclaw.sh/provider-gemini`
- GoClaw, **How GoClaw Works**: `https://docs.goclaw.sh/how-goclaw-works`
- GoClaw, **Agents Explained**: `https://docs.goclaw.sh/agents-explained`
- GoClaw, **Sessions and History**: `https://docs.goclaw.sh/sessions-and-history`
- GoClaw, **System Prompt Anatomy**: `https://docs.goclaw.sh/system-prompt-anatomy`
- GoClaw, **Context Files**: `https://docs.goclaw.sh/context-files`
- GoClaw source, **System Prompt Anatomy**: `https://github.com/nextlevelbuilder/goclaw-docs/blob/master/agents/system-prompt-anatomy.md`
- GoClaw source, **Context Files**: `https://github.com/nextlevelbuilder/goclaw-docs/blob/master/agents/context-files.md`
