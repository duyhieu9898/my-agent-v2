# ADR 0010: Runtime Events, Logs, Transcripts, and Audit Separation

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

## Context

`my-agent-v2` needs several observable records for different consumers and purposes:

```text
runtime events
Gateway client events
technical logs
session transcripts
future audit records
diagnostics and metrics
```

These records overlap in identifiers and timing, but they are not interchangeable.

Without an explicit separation decision, the implementation could drift into unsafe or unreliable patterns such as:

- using Pino logs as the source of truth for run state;
- reconstructing a transcript by replaying client events;
- storing complete prompts and tool outputs in an audit ledger;
- treating a Gateway event sequence as a durable global event log;
- driving domain behavior by parsing log strings;
- writing operational notices into the user-visible transcript merely for observability;
- assuming the absence of an audit row proves that no action occurred;
- requiring optional telemetry exporters for correct run completion;
- publishing terminal runtime events before required transcript writes commit;
- logging credentials, raw approval payloads, or sensitive tool arguments;
- defining one unbounded event table that mixes conversation content, metrics, logs, and compliance data.

The architecture already establishes several relevant boundaries:

- ADR 0004 defines Gateway events as a connection-delivered observable stream, not durable state;
- ADR 0006 defines run and attempt lifecycle transitions and requires terminal events to follow required durable writes;
- ADR 0007 makes `TranscriptStore` the canonical durable conversation-history boundary;
- ADR 0008 requires normalized tool, policy, approval, and execution lifecycle events;
- ADR 0009 makes SQLite the initial canonical database while deferring a full persistent event and audit store.

OpenClaw currently distinguishes the same categories:

- structured in-process diagnostics events are separate from technical logs;
- OpenTelemetry exporters consume diagnostics and log records without becoming runtime correctness dependencies;
- session transcripts remain conversation history;
- the audit ledger is metadata-only and explicitly does not replace transcripts, task history, run history, or logs;
- diagnostics bundles minimize or omit payload content and treat redacted operational metadata as sensitive.

`my-agent-v2` adopts those separation and privacy principles while keeping V1 smaller:

- Pino technical logs;
- typed in-process runtime events;
- Gateway projections for authorized clients;
- durable transcript entries through `TranscriptStore`;
- no persistent general-purpose event store in V1;
- no claim of a complete durable audit ledger in V1;
- no mandatory OpenTelemetry exporter in V1;
- metadata-first diagnostics with payload capture disabled by default.

## Decision

`my-agent-v2` will maintain four primary record classes with separate authority, purpose, schema, retention, and failure semantics:

| Record class | Primary purpose | Canonical authority | Durable in V1 |
|---|---|---|---|
| Runtime event | Typed lifecycle observation and in-process coordination | Owning application/runtime module | No general event store |
| Technical log | Operator diagnosis and debugging | Logging subsystem | File or configured log sink |
| Transcript entry | Canonical conversation and tool history | `TranscriptStore`, mutated through authorized session/runtime services | Yes |
| Audit record | Metadata-only accountability index | Future audit subsystem projecting trusted lifecycle boundaries | Deferred |

Gateway client events, metrics, traces, and diagnostics are projections or exports from these owned boundaries. They are not additional sources of domain truth.

The high-level flow is:

```text
owning runtime changes state
→ commit required durable state
→ emit typed runtime event
→ project event to authorized Gateway clients
→ optionally derive logs, diagnostics, metrics, traces, or audit records
```

No optional observer, telemetry plugin, log writer, or client connection is required for the underlying domain operation to be valid unless a later ADR explicitly makes a durable audit write part of that operation's acceptance criteria.

## Runtime events

Runtime events are typed application records describing lifecycle transitions or observable runtime progress.

They are produced by the module that owns the lifecycle being reported.

Examples include:

```text
run.started
attempt.started
context.prepared
model.requested
model.delta
model.completed
tool.requested
approval.requested
approval.resolved
tool.started
tool.completed
attempt.completed
attempt.failed
run.completed
run.failed
run.cancelled
```

Future modules may add namespaced events for sessions, browser operations, platform operations, plugins, or system lifecycle.

### Runtime event ownership

The event producer must own or receive an authoritative transition from the owning boundary.

Examples:

- Agent Runtime emits run and attempt lifecycle events;
- Context owns context-preparation observations;
- Model Runtime emits normalized model-call lifecycle observations;
- Tool Runtime emits tool, policy, approval, and execution observations;
- sessions services emit reset or transcript-rotation observations;
- Gateway emits connection and transport lifecycle observations;
- bootstrap emits application startup and shutdown lifecycle observations.

A consumer must not synthesize an authoritative lifecycle event by parsing log text or guessing from partial output.

The Gateway may project or rename an internal event for its public protocol, but it does not become the owner of the underlying run, attempt, tool, or session transition.

### Runtime event envelope

A runtime event envelope should contain, where applicable:

```text
eventId
schemaVersion
eventName
occurredAt
agentId
sessionKey
sessionId
runId
attemptId
toolCallId
source module
normalized payload
```

Only identifiers available and meaningful at the event's emission point are included.

The implementation must not fabricate missing provenance. For example, a Gateway connection event does not need a `runId`, and a model delta does not invent a `toolCallId`.

`connectionId` may be included for Gateway-origin or delivery correlation but is not a durable session or run identity.

Event payloads are discriminated by `eventName` and versioned at the contract boundary. External Gateway projections use runtime validation consistent with ADR 0004.

The exact generator for `eventId` is an implementation choice until events become a published or durable cross-process contract.

### Event timing

Lifecycle events are emitted after the transition they report has occurred.

In particular:

- `run.started` follows acquisition of required run lanes and transition to running;
- `tool.started` follows validation, policy, approval, and execution-target resolution;
- `tool.completed` follows normalized execution completion;
- `run.completed` follows required transcript and run-owned durable writes;
- `run.failed` and `run.cancelled` follow terminal-state arbitration and required consistency cleanup.

A progress event such as `model.delta` reports observed progress and does not imply model or run completion.

An event name ending in `.completed`, `.failed`, or `.cancelled` must represent a closed lifecycle outcome for the referenced operation.

### Event delivery semantics

V1 runtime events are in-process notifications, not an event-sourced database.

Consumers must tolerate:

- observer failure;
- duplicate delivery introduced by future adapters;
- missing optional progress events;
- client disconnect;
- Gateway sequence gaps;
- events not retained after process restart.

Runtime-event consumers must be idempotent where duplicate observation could cause side effects.

A failed optional event observer is logged and isolated. It does not roll back a completed domain transition.

An observer that is required for security or correctness must not be registered as an ordinary optional event subscriber. Its behavior belongs inside the authoritative operation or a future transactional/outbox design approved by another ADR.

### Event ordering

Within one synchronous producer path, events preserve producer order.

Cross-module or cross-run global ordering is not guaranteed.

Ordering should instead be interpreted using the relevant identities and lifecycle contracts:

```text
(agentId, sessionKey, runId, attemptId, toolCallId)
```

Gateway connection-level sequence numbers are a delivery-gap mechanism defined by ADR 0004. They are not a durable global runtime sequence and must not be persisted as business ordering authority.

A future durable event or audit ledger may introduce its own monotonic sequence. That sequence remains separate from Gateway connection sequencing.

## Gateway client events

Gateway events are authorized protocol projections for Control UI, CLI, and future clients.

They may be derived from internal runtime events but are not required to expose the internal payload unchanged.

Gateway projection may:

- remove internal-only fields;
- redact sensitive fields;
- convert internal errors to protocol errors;
- aggregate high-frequency updates;
- omit events unsupported by the negotiated protocol version;
- map internal event names to stable public names;
- attach connection-level sequence metadata.

Clients must not treat received events as the only copy of durable state.

After reconnect or a detected sequence gap, clients refresh through RPC or state-query methods rather than demanding complete event replay.

`model.delta` and similar content-bearing streams may contain authorized user-visible output. They must not automatically be copied into technical logs, audit records, or payload-free diagnostics.

## Technical logs

Pino is the V1 technical logging implementation.

Logs exist for operators and developers to diagnose system behavior. They are not a domain API, transcript, audit ledger, or event store.

Logs may contain structured fields such as:

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
toolCallId
error code
duration
bounded size and count measurements
```

Logs should use stable field names for machine filtering while keeping the human-readable message concise.

Domain code must not branch on log output, parse log strings, or use successful logging as proof that state was committed.

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

### Structured errors

Logs should record normalized error metadata, including where applicable:

```text
error code
error category
operation
retryability
provider or tool identity
status
bounded cause metadata
```

Raw error objects may be attached only through the central logger's safe serialization path.

Provider responses, shell output, browser content, prompts, tool arguments, and transcript bodies must not be logged by default.

### Log retention and availability

Log retention is operational configuration and may use rotation, truncation, external collection, or deletion.

Loss or rotation of a log file does not change transcript, session, run, or audit state.

A log-tail API is an operator convenience. It must enforce authorization, bounded reads, and redaction and must not expose arbitrary host files.

## Transcripts

The transcript is the canonical durable conversation and model-visible history defined by ADR 0007.

It may contain normalized entries such as:

```text
user message
assistant message
tool call
tool result
compaction entry
structured session notice
future custom transcript entry
```

Transcript entries exist to preserve conversation semantics and future context reconstruction.

They are not written merely because an operational event occurred.

Examples of data that normally belong outside the transcript include:

```text
Gateway connection accepted
queue depth changed
logger rotation completed
OTLP export failed
health probe succeeded
internal retry timer scheduled
CPU or memory sample
```

A runtime or system notice enters the transcript only when it is intentionally part of the session's durable model/user context under ADR 0007.

### Transcript authority

Only `TranscriptStore`, invoked by Agent Runtime or another explicitly authorized session service, persists canonical transcript entries.

The logger, Gateway event broadcaster, diagnostics exporter, audit projector, Harness, provider adapter, and tool implementation must not append canonical transcript history directly.

Transcript writes and terminal runtime events follow ADR 0006 and ADR 0007 ordering rules.

### Transcript privacy

Transcripts may contain private user content and sensitive tool results even after secret redaction.

Transcript access therefore requires stronger product-level authorization and retention rules than ordinary health metadata.

Redaction is a safety layer, not a substitute for access control.

History surfaces must apply pagination, size limits, content filtering, and capability checks appropriate to the caller.

## Audit records

A future audit subsystem will provide a durable, metadata-only accountability ledger for selected trusted lifecycle boundaries.

The audit ledger does not replace:

```text
transcripts
technical logs
runtime events
run or task history
provider records
external identity-provider audit logs
```

The first durable audit implementation requires its own execution plan and may require a focused ADR if storage integrity, retention, actor identity, or compliance guarantees differ materially from this decision.

### Audit content model

Audit records should answer bounded operator questions such as:

- which agent initiated a run;
- which logical session and run were involved;
- which capability or tool was requested;
- what policy decision occurred;
- whether approval was requested and resolved;
- whether the action succeeded, failed, timed out, was cancelled, or was blocked;
- when the trusted boundary observed the lifecycle transition;
- what normalized reason or error code applied.

An audit record may contain:

```text
audit event id
schema version
ledger sequence
occurredAt
actor or agent identity
sessionKey or a protected reference
runId
attemptId when material
action or capability name
policy decision
approval outcome
terminal status
normalized reason or error code
duration and bounded counts
source event reference
redaction classification
```

It must not contain by default:

```text
raw user messages
complete prompts or system instructions
assistant response bodies
raw tool arguments
raw tool results
credentials or tokens
browser page content
shell stdout or stderr
attachments
provider request or response bodies
```

Sensitive correlation identifiers may later be represented by installation-local fingerprints or pseudonyms when the operator does not require the raw value.

### Audit coverage

Audit records are written only from declared trusted boundaries.

The audit contract must document:

- which event families are covered;
- which paths are not covered;
- whether start and terminal records both exist;
- how crash-ambiguous actions are classified;
- how duplicate events are deduplicated;
- retention and pruning behavior;
- query authorization.

Absence of an audit record must not be presented as proof that no action occurred unless the implementation has a separately validated complete-coverage guarantee for that action path.

Plugin or implementation paths that bypass declared lifecycle boundaries are architecture violations, not acceptable hidden audit gaps.

### Audit integrity

When persistent audit is introduced, records are append-oriented.

Corrections should append a superseding or reconciliation record rather than silently rewriting historical outcomes, except for retention deletion or a documented migration.

The ledger sequence is owned by the audit store and is distinct from:

```text
Gateway connection sequence
transcript entry sequence
runtime event producer order
SQLite row id from another table
```

A persistent audit implementation must fail explicitly if it cannot meet its declared durability or integrity guarantees.

Until such an implementation exists, `my-agent-v2` must not claim complete auditability or compliance-grade evidence.

## Diagnostics, metrics, and traces

Diagnostics are bounded machine-readable operational observations used to derive metrics, traces, support summaries, and health information.

They may be generated from runtime events and logging context, but they remain a separate projection.

Diagnostics should default to metadata such as:

```text
durations
status and error category
queue state
provider, model, Harness, or tool identifier
byte and token counts
retry or fallback counts
resource measurements
lifecycle phase
```

Raw content capture is disabled by default.

If future diagnostics allow prompt, message, tool-input, or tool-output capture, that capability must be:

- explicitly enabled;
- bounded by size and count;
- redacted;
- restricted to trusted sinks;
- excluded from the ordinary public event bus;
- documented as potentially sensitive.

OpenTelemetry export may be added as an optional observer or plugin. Export failure must not fail a valid run or tool operation.

Trace context may be propagated through trusted internal request, run, model, and tool boundaries to correlate logs and diagnostics. Trace identifiers do not replace `runId`, `attemptId`, or domain identities.

## Privacy and redaction

Every record class follows data minimization appropriate to its purpose.

The default rule is:

```text
transcript: content required for conversation semantics
runtime event: minimum payload required for lifecycle consumers
Gateway event: minimum authorized client projection
log: operational metadata, no raw content by default
audit: metadata-only
diagnostics: bounded payload-free measurements by default
```

Known credentials and secret-like values must be redacted before leaving the process through logs, diagnostics, support exports, or client events where applicable.

Producers must still avoid attaching secrets in the first place. Sink-level redaction is defense in depth and may not recognize every sensitive value.

Structured identifiers, timing, channel names, agent names, file paths, and stable fingerprints can still be sensitive even when message content is absent. They require appropriate access controls and retention.

A support or diagnostics export must be treated as sensitive until reviewed.

## Schema evolution

Runtime event, Gateway event, transcript entry, log-field, and audit schemas evolve independently.

A change to one record class does not automatically require matching fields in every other class.

Rules:

- public Gateway event changes follow ADR 0004 protocol compatibility rules;
- transcript entry changes require migration and history compatibility planning under ADR 0007 and ADR 0009;
- audit records include an explicit schema version;
- runtime events use discriminated typed contracts;
- logs favor stable fields but remain an operational interface rather than a domain protocol;
- exporters translate from owned internal contracts rather than forcing domain modules to depend on vendor telemetry schemas.

OpenTelemetry semantic conventions or another exporter format must not become the canonical internal domain model.

## Failure semantics

Record classes fail independently according to their purpose.

### Runtime event observer failure

An optional subscriber failure is isolated and logged. The authoritative operation continues according to its own state and durable writes.

### Gateway delivery failure

A disconnected or slow client may miss events. The operation continues, and the client later refreshes state through RPC.

### Log sink failure

The application should report or surface degraded logging where possible. A non-critical log write failure does not roll back domain state.

A configuration that requires an unavailable mandatory operator log sink may fail startup, but this must be explicit configuration behavior rather than accidental coupling.

### Transcript write failure

A required transcript write failure is a run or session-operation failure under ADR 0006 and ADR 0007. The runtime must not emit successful terminal completion.

### Audit write failure

No persistent audit store exists in V1.

When one is added, its declared guarantee determines behavior. A best-effort activity index may tolerate a missed record with a surfaced health error; a security- or compliance-required ledger may need transactional or outbox-backed fail-closed behavior. That choice requires explicit authority and validation.

### Telemetry export failure

Metrics, trace, or diagnostics export failure is isolated from domain execution and reported through health/logging signals.

## Retention and deletion

Each record class has independent retention:

- transcript retention follows session and user-history policy;
- log retention follows operator logging configuration;
- diagnostics retention is bounded and operational;
- Gateway events normally expire with connection/process memory;
- audit retention follows the future audit policy;
- metrics and traces follow exporter/backend configuration.

Deleting one class does not imply deletion of the others.

User-facing delete and reset operations must document which classes they affect. For example, resetting a transcript does not necessarily delete technical logs or future metadata-only audit records.

Retention jobs must use the owning store or subsystem rather than deleting arbitrary files or rows across module boundaries.

## OpenClaw alignment and intentional differences

`my-agent-v2` aligns with OpenClaw by:

- separating diagnostics events from technical logs;
- allowing telemetry exporters to subscribe without becoming runtime dependencies;
- treating transcripts as conversation history rather than an audit ledger;
- keeping audit metadata-only and separate from transcripts and logs;
- minimizing content in diagnostics and support artifacts;
- correlating operations with structured identifiers and trace context;
- treating redacted logs and operational metadata as sensitive.

`my-agent-v2` intentionally starts smaller by omitting:

- a durable audit ledger;
- message-delivery audit coverage;
- persistent stability bundles;
- an OpenTelemetry plugin and signal catalog;
- compliance-grade retention or tamper-evidence claims;
- a persistent general-purpose event store;
- remote log or audit APIs beyond active product needs;
- optional raw content capture in telemetry.

These capabilities may be added through the boundaries defined here without changing transcript authority or making logs the source of truth.

## Consequences

### Positive

- Conversation history remains clean and semantically meaningful.
- Client streaming does not become a hidden durability dependency.
- Operators receive structured diagnostics without coupling domain behavior to logs.
- Future metrics, traces, and audit projections can subscribe to stable lifecycle boundaries.
- Audit design can minimize sensitive content instead of copying transcripts.
- Runtime completion remains grounded in owned state transitions and durable writes.
- Retention and access control can match the sensitivity and purpose of each record class.
- Optional telemetry can fail without corrupting agent execution.

### Negative

- Similar identifiers and statuses may appear in multiple record classes.
- Producers and projectors require explicit schemas and mapping code.
- Debugging may require correlating transcript, runtime event, and log views rather than reading one universal stream.
- V1 cannot provide complete historical event replay or compliance-grade audit claims.
- A future durable audit store will add migration, retention, query, and integrity work.
- High-frequency event consumers must implement aggregation and backpressure carefully.

## Risks and trade-offs

### Record classes drift into inconsistent status names

Run, tool, log, Gateway, and audit projections may use incompatible terminal labels.

Mitigation:

- define normalized lifecycle enums in owning contracts;
- map explicitly at boundaries;
- test terminal-state projection;
- avoid copying provider-specific statuses into public or audit contracts.

### Logs accidentally become a public API

Scripts or UI code may start parsing human-oriented messages.

Mitigation:

- expose typed RPC and event contracts;
- use stable structured fields for operator filtering only;
- never implement application behavior by parsing log text.

### Runtime events leak content

Convenience payloads may include prompts, messages, shell output, or browser content.

Mitigation:

- metadata-first event schemas;
- separate explicitly authorized content events such as `model.delta`;
- central redaction and payload bounds;
- tests for sensitive-data omission.

### Audit is mistaken for complete evidence

Partial coverage may be presented as proof of absence.

Mitigation:

- publish coverage and gaps;
- classify unknown or crash-ambiguous outcomes explicitly;
- do not claim complete auditability before validation;
- keep trusted action paths inside declared runtime boundaries.

### Optional observers block the run loop

Slow exporters or event consumers may add latency or failure coupling.

Mitigation:

- bounded asynchronous delivery;
- subscriber timeouts and isolation;
- aggregation for high-frequency progress;
- keep correctness-critical work inside the authoritative operation.

### Duplicate or missing events cause side effects

Future adapters may redeliver events or lose non-durable progress.

Mitigation:

- idempotent consumers;
- use durable RPC state for recovery;
- do not trigger irreversible behavior from an untrusted duplicate-prone observer without deduplication.

### Redaction creates false confidence

Pattern-based redaction may miss sensitive context or identifiers.

Mitigation:

- do not attach unnecessary content;
- enforce access control;
- bound retention;
- treat exports as sensitive;
- test known credential patterns and structured secret fields.

## Rejected alternatives

### Use logs as the runtime event bus

Rejected because log levels, formatting, rotation, and sinks are operational concerns. Parsing logs would make domain behavior depend on diagnostics configuration and best-effort output.

### Use Gateway events as the durable event store

Rejected because Gateway delivery is connection-scoped, can contain gaps, and is intentionally recoverable through RPC rather than replay.

### Store all runtime events permanently in V1

Rejected because current product requirements do not justify event-sourcing complexity, retention volume, migration burden, or replay semantics.

### Put technical events into the transcript

Rejected because queue, connection, health, retry, and exporter details are not conversation history and would pollute future model context and user-visible history.

### Use transcripts as the audit ledger

Rejected because transcripts contain content, may be reset or compacted, and do not provide a bounded metadata index or complete action outcomes.

### Store raw prompts, tool arguments, and results in audit records

Rejected because an audit index should minimize content and exposure. Detailed content remains in its owned store or external system when retention is required.

### Use one universal observability table

Rejected because logs, transcripts, runtime events, and audit records have different authority, schemas, retention, access control, and failure behavior.

### Require OpenTelemetry for V1 correctness

Rejected because telemetry export is optional infrastructure and must not become a condition for completing a local agent run.

### Emit successful terminal events before persistence

Rejected because clients could observe completion while transcript and durable state remain unavailable or failed.

### Treat redaction as sufficient authorization

Rejected because redacted metadata and partially masked text can still reveal sensitive behavior and identity correlations.

## Validation

This decision is correctly applied when:

- Pino logs are not parsed to drive domain behavior;
- runtime events use typed discriminated contracts and explicit ownership;
- event payloads carry only applicable identities and do not fabricate provenance;
- terminal runtime events follow required durable state writes;
- Gateway event delivery can fail or gap without losing canonical state;
- clients refresh through RPC after reconnect or sequence gaps;
- `TranscriptStore` remains the only canonical transcript persistence contract;
- operational diagnostics do not enter transcripts unless explicitly defined as durable session context;
- technical logs omit raw prompts, credentials, tool payloads, and transcript bodies by default;
- log fields include useful correlation IDs without treating trace IDs as domain identity;
- diagnostics and metrics default to bounded metadata without raw content;
- optional telemetry/exporter failure does not fail a valid run;
- no component claims a durable general event store or complete audit ledger before implementation;
- a future audit implementation is metadata-only by default and documents coverage, retention, and unknown outcomes;
- audit, transcript, log, and Gateway sequence numbers remain distinct;
- reset and delete behavior documents which record classes are affected;
- tests cover redaction, event ordering around persistence, terminal-state uniqueness, client gap recovery, and observer isolation.

## Revisit conditions

Revisit this decision when:

- a persistent event store or event replay becomes a product requirement;
- distributed workers require cross-process event transport and stronger ordering;
- audit records become required for security, legal, or compliance guarantees;
- audit writes must be transactional with tool or run state;
- multiple processes need a durable outbox or message broker;
- remote clients require resumable event cursors rather than RPC refresh;
- users require unified retention or deletion across transcripts, logs, and audit;
- telemetry content capture becomes a supported product feature;
- plugin-provided observers need a public diagnostics or event SDK;
- event volume requires a dedicated backpressure, sampling, or aggregation architecture;
- trace context must propagate to remote nodes or external tool runtimes;
- tamper evidence, signing, or immutable audit storage becomes necessary.

## References

- `docs/ARCHITECTURE.md`, section 7, **Gateway architecture**
- `docs/ARCHITECTURE.md`, section 9, **Agent Runtime architecture**
- `docs/ARCHITECTURE.md`, section 11, **Sessions and transcripts**
- `docs/ARCHITECTURE.md`, section 12, **Tool Runtime**
- `docs/ARCHITECTURE.md`, section 19, **Storage and migrations**
- `docs/ARCHITECTURE.md`, section 20, **Events, logs, and audit**
- `docs/decisions/0004-gateway-control-plane-and-protocol-contract.md`
- `docs/decisions/0006-run-attempt-lifecycle-and-per-session-serialization.md`
- `docs/decisions/0007-context-assembly-and-transcript-mutation-authority.md`
- `docs/decisions/0008-tool-runtime-policy-approval-and-sandbox-boundaries.md`
- `docs/decisions/0009-storage-ownership-sqlite-and-migration-policy.md`
- OpenClaw logging: `https://docs.openclaw.ai/logging`
- OpenClaw OpenTelemetry export: `https://docs.openclaw.ai/gateway/opentelemetry`
- OpenClaw audit records: `https://docs.openclaw.ai/cli/audit`
- OpenClaw diagnostics export: `https://docs.openclaw.ai/gateway/diagnostics`
- OpenClaw session management: `https://docs.openclaw.ai/concepts/session`
