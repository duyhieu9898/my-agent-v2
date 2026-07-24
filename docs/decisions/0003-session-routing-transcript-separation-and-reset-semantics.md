# ADR 0003: Session Routing, Transcript Separation, and Reset Semantics

- **Status:** Accepted
- **Date:** 2026-07-24
- **Decision owners:** my-agent-v2 maintainers
- **Related architecture:** `docs/ARCHITECTURE.md`
- **Related decisions:**
  - `docs/decisions/0001-modular-monolith-and-openclaw-alignment.md`
  - `docs/decisions/0002-core-runtime-identities-and-agent-ownership.md`

## Context

`my-agent-v2` needs to route client and future channel activity to a stable logical conversation while storing transcript history under a replaceable transcript identity.

ADR 0002 distinguishes:

```text
sessionKey = logical conversation route
sessionId  = one transcript instance
```

The repository foundation already separates `SessionStore`, `TranscriptStore`, and `SessionResolver`. This ADR defines how those boundaries cooperate, which subsystem owns the mapping, and what happens when a logical conversation is reset.

Without a durable distinction between route and transcript, the system would be forced to choose between:

- replacing the visible conversation identity whenever history is reset;
- retaining old transcript state inside a supposedly fresh conversation;
- coupling Gateway connections to durable history;
- allowing transport handlers or storage adapters to invent routing rules;
- making future presentation surfaces, channels, and multi-agent routing difficult to add safely.

OpenClaw uses the same fundamental separation: a session row maps a `sessionKey` to a current `sessionId`, while transcript events are stored separately. Resetting a session creates a fresh `sessionId` for the same key. `my-agent-v2` adopts that model while keeping session business rules in the sessions subsystem rather than assigning them to Gateway transport code.

## Decision

`my-agent-v2` will model session routing and transcript history as two separate domain concerns.

```text
routing input
→ SessionResolver
→ canonical sessionKey
→ SessionStore
→ current sessionId
→ TranscriptStore
→ ordered transcript entries
```

A `sessionKey` resolves to one current `sessionId` at a time.

The sessions subsystem owns this relationship through `SessionResolver`, `SessionStore`, and `TranscriptStore` contracts. Gateway handlers, Agent Runtime, UI clients, storage adapters, and future channels consume these contracts but do not redefine their semantics.

## Session routing

### Routing input

Callers provide a typed `SessionRoute` rather than constructing a persistence key or record directly.

A V1 route contract is conceptually:

```ts
interface SessionRoute {
  agentId: string;
  surface: "main" | "web" | "cli";
  conversationId?: string;
}
```

The route may later gain validated account, channel, room, thread, workspace, or peer fields. Those additions must remain structured inputs and preserve the identity semantics defined by ADR 0002.

`runId`, `attemptId`, `connectionId`, and `sessionId` are not route components. Clients do not serialize `SessionRoute` into a canonical key themselves.

### Canonicalization authority

`SessionResolver` is the authority for:

- validating routing input;
- applying supported route rules;
- producing a canonical `sessionKey`;
- validating that the key belongs to the resolved `agentId`;
- resolving the current session entry;
- creating the entry and initial transcript identity when absent.

Clients may submit a documented session selector, but the selector is not automatically trusted as canonical.

A `sessionKey` is a routing selector, not an authentication or authorization token. Possession of a key must not by itself grant access to a session.

### Initial route forms

V1 may support canonical keys such as:

```text
agent:primary:main
agent:primary:web:<conversation-id>
agent:primary:cli:<conversation-id>
```

These examples do not require all future route types to use the same shape. New externally visible key forms require documented canonicalization rules and compatibility tests.

### Resolve-or-create behavior

Resolving or creating a session for a canonical key must behave atomically from the caller's perspective.

Concurrent requests for the same new `sessionKey` must not create multiple current session entries or leave an ambiguous mapping.

The sessions subsystem may implement this with a transaction, unique constraint, compare-and-set operation, or equivalent store capability.

## SessionStore ownership

`SessionStore` owns the session index and current route mapping.

A session entry contains at least:

```text
sessionKey
sessionId
agentId
createdAt
updatedAt
```

The store may later include explicitly classified metadata such as:

- title;
- route or channel binding;
- presentation-surface metadata;
- model or harness overrides;
- pinning;
- timestamps and counters.

The store contract must not expose SQLite concepts to callers.

A concrete store persists session entries but does not decide how routing input becomes a canonical key or when a reset is allowed.

## TranscriptStore ownership

`TranscriptStore` owns transcript entries scoped by `sessionId`.

V1 transcripts are logically ordered and append-oriented. Entries may include:

- user messages;
- assistant messages;
- tool calls;
- tool results;
- structured notices;
- future compaction or custom entries.

Callers must address transcript operations with `sessionId`, not only `sessionKey`.

Each transcript entry has an opaque `entryId` and a monotonic `sequence` scoped to one `sessionId`.

`TranscriptStore` allocates sequence values. Callers do not provide authoritative sequence numbers. Sequence values are strictly increasing, never reused, and provide the canonical history order; timestamps are descriptive metadata only.

Atomic append batches allocate a contiguous sequence range so structurally related entries cannot become partially committed. The storage and mutation details are governed by ADR 0007 and ADR 0009.

Existing transcript entries are not rewritten as part of a normal reset. Future correction, redaction, branching, compaction, or archival behavior requires explicit contracts and may add new entry types or transcript relationships.

V1 does not require OpenClaw's tree-structured transcript model. Linear ordered history is sufficient until branching, fork, restore, or compaction-successor behavior has an active product requirement.

### Transcript sequencing and cursor semantics

History reads use transcript sequence, not timestamps or array offsets.

A bounded response is conceptually:

```ts
interface HistoryPage {
  sessionId: string;
  entries: TranscriptEntry[];
  headSequence: number;
  nextCursor?: string;
}
```

History cursors are opaque application tokens bound to at least:

```text
sessionId
sequence position or bounded range
cursor schema version
```

A cursor is not an authorization token and does not replace capability checks.

A cursor created for one `sessionId` is invalid after the same `sessionKey` is reset to a new transcript. The history API returns an explicit cursor/session mismatch or refresh-required result rather than silently applying the old cursor to the new transcript.

Cursor encoding is an application contract. Database row offsets, SQLite row IDs, and implementation-specific pagination tokens are not stable public semantics.

## Session resolution contract

A successful session resolution returns one coherent snapshot containing at least:

```text
agentId
sessionKey
sessionId
```

Agent Runtime captures that resolved `sessionId` when accepting a run, as required by ADR 0002.

If the `sessionKey` is later remapped, an already accepted run continues to use the captured `sessionId`; it must not silently switch transcripts.

Consumers must not independently fetch a session entry and then infer that it remains current indefinitely. Operations that require current mapping consistency must use a sessions contract that performs the required check atomically.

## Reset semantics

### Reset in place

Resetting a logical session means:

```text
same agentId
same sessionKey
new sessionId
fresh current transcript
```

The sessions subsystem creates the new `sessionId` and atomically updates the `SessionStore` mapping.

The previous transcript is no longer current, but it is not automatically deleted. Retention, archival, export, and permanent deletion are separate policies.

### Metadata classification

Session data must be classified by lifecycle rather than copied indiscriminately during reset.

Route-scoped state may survive reset, including future examples such as:

- logical title;
- channel or client binding;
- presentation-surface state;
- stable labels or bookmarks.

Transcript-scoped state does not survive reset, including:

- transcript entries;
- transcript token and compaction state;
- transcript-local provider or harness continuation state;
- transient failure or recovery state.

Each future metadata field must declare whether it is route-scoped or transcript-scoped before implementation. Model, harness, credential-profile, and policy override persistence must be decided by their owning ADRs rather than inferred here.

### Active-run safety

V1 must not remap a `sessionKey` while an active run owns the current `sessionId`.

A reset request during an active run must fail with a conflict or wait behind the same per-session serialization boundary. It must not create a new current transcript while the active run can still append to the old one.

A future atomic cancel-and-reset operation requires the run-lifecycle ADR to define cancellation, completion, and transcript-write ordering.

### Reset idempotency

A reset is a side-effecting operation.

Gateway or other external APIs exposing reset must support idempotency or request deduplication before clients are expected to retry it after uncertain delivery.

Repeated delivery of one logical reset request must not rotate the session multiple times.

## New logical sessions

Creating a new logical conversation is different from resetting an existing one.

```text
new logical session → new sessionKey + new sessionId
reset existing session → same sessionKey + new sessionId
```

V1 does not need a general-purpose user-facing `sessions.create` or fork API. When introduced, new-session creation must go through the sessions subsystem and must not be implemented by a client inventing an arbitrary persistence key.

Forking, branching, and creating a child session from existing history are deferred.

## History access

Session-list and transcript-history APIs use application contracts rather than exposing store internals.

V1 history reads are bounded and cursor-based. Tail reads may be offered as a convenience, but the durable contract is based on `(sessionId, sequence)` and an opaque cursor rather than offset pagination.

A response identifies the `sessionId` and current `headSequence` so clients can distinguish:

- new transcript entries;
- an unchanged transcript;
- a cursor that is no longer valid;
- a logical-session reset that produced a new transcript identity.

External history responses do not automatically expose every internal transcript field. Provider continuation sidecars, internal scaffolding, credential-like content, and maintenance metadata require filtering and capability checks at the application boundary.

The durable transcript is the source of conversation history. Gateway event delivery is not a replacement for transcript persistence.

## Failure and consistency rules

The following rules apply:

1. A session entry must never reference a missing current transcript after a successful create or reset operation.
2. A transcript must not become current for more than one unrelated `sessionKey` unless a later branching decision explicitly permits shared ancestry or references.
3. Failure to create the new transcript or update the route mapping must leave the previous mapping current.
4. Gateway disconnection does not reset or delete a session.
5. Gateway restart must not change durable session identity or current route mapping.
6. Store implementations must preserve agent ownership when resolving, listing, resetting, or reading sessions.
7. A client-supplied key must not bypass agent or future principal authorization checks.
8. Runtime events may announce session changes, but consumers recover authoritative state from session APIs.

## OpenClaw alignment and intentional differences

This decision aligns with current OpenClaw behavior in the following ways:

- session routing uses a stable `sessionKey` representing a conversation bucket;
- a session row maps that key to the current `sessionId`;
- transcript events are stored separately from mutable session metadata;
- reset creates a fresh `sessionId` for the same session key;
- session keys are routing selectors, not authorization tokens;
- session state and transcript history are isolated per agent;
- clients query application or Gateway APIs instead of reading local storage directly.

`my-agent-v2` intentionally differs or starts smaller in these ways:

- session business rules are owned by `src/sessions/`; Gateway is an adapter and control-plane entry point, not the domain owner;
- V1 uses an ordered linear transcript rather than OpenClaw's current append-only tree structure;
- automatic idle, daily, channel-specific, cron, webhook, and incognito session policies are deferred;
- transcript branching, forks, restore checkpoints, and compaction-successor rotation are deferred;
- SQLite is an implementation behind store contracts rather than part of the session-domain API.

## Additional consistency invariants

The following invariants also apply:

1. Transcript sequence is monotonic and unique within one `sessionId`.
2. An atomic append batch either commits its full contiguous sequence range or commits nothing.
3. History cursors are bound to one `sessionId` and cannot cross reset boundaries.
4. History readers never infer authoritative order from timestamps.
5. A normal reset does not delete prior transcript entries or reuse their sequence space.

## Consequences

### Positive

- Logical conversations can survive transcript reset.
- Transcript history and session presentation state can evolve independently.
- Gateway reconnect and restart do not redefine conversation identity.
- Future channels and multi-agent routing can add canonical route rules without replacing transcript contracts.
- Storage implementations can change without changing session-domain semantics.
- Active runs retain a stable transcript target.

### Negative

- Resolve, create, reset, and history operations require coordination across two stores.
- Metadata must be explicitly classified as route-scoped or transcript-scoped.
- Atomicity and concurrency handling are required even in a single-user system.
- Retaining old transcripts requires future retention and cleanup policy.

## Risks and trade-offs

### Stale route snapshots

A caller may resolve a session and later operate after the mapping has changed.

Mitigation:

- runs capture the resolved `sessionId` at acceptance;
- current-mapping-sensitive operations use atomic sessions contracts;
- reset is blocked or serialized while a run is active.

### Orphaned transcripts

A failed create or reset could leave a transcript that is not referenced by a current session entry.

Mitigation:

- use transactional or compensating store operations;
- make orphan detection possible through validation or maintenance tooling;
- never discard the prior mapping until the new mapping is committed.

### Accidental metadata leakage across reset

Copying an entire session entry may retain transcript-local model state, counters, or provider continuation data.

Mitigation:

- classify every field by lifecycle;
- construct the reset entry explicitly;
- test preserved and cleared fields separately.

### Session key treated as authority

A caller may use knowledge of a session key to access another agent's session.

Mitigation:

- validate `agentId` ownership explicitly;
- apply future principal and capability checks independently;
- never treat key possession as authentication.

## Rejected alternatives

### Store all history directly under `sessionKey`

Rejected because reset would either erase history, mix old and fresh history, or require changing the logical route identity.

### Replace `sessionKey` on every reset

Rejected because route bindings, labels, presentation surfaces, and external references may need to remain stable while transcript history is replaced.

### Let Gateway handlers query SQLite directly

Rejected because it merges transport, business rules, and persistence and violates ADR 0001 dependency direction.

### Let clients construct arbitrary canonical keys

Rejected because routing rules, ownership validation, compatibility, and future channel isolation would become client-specific and unsafe.

### Delete the previous transcript during reset

Rejected because reset and permanent deletion have different recovery and user-data consequences.

### Implement branching transcripts immediately

Rejected because V1 has no active fork, restore, or parallel-history requirement. The linear contract is smaller and can later be extended through a dedicated ADR.

### Allow reset to remap during an active run

Rejected because the run could append to a transcript that is no longer current, producing confusing results and inconsistent history.

### Order history by timestamp

Rejected because timestamps can collide, arrive out of order, or change representation and therefore cannot provide a durable transcript order.

### Expose database offsets as cursors

Rejected because offsets and row IDs leak storage implementation and become invalid under migrations, filtering, or transcript replacement.

### Reuse a history cursor after reset

Rejected because reset creates a new `sessionId`; silently applying an old cursor would mix two transcript lifecycles.

## Validation

This decision is correctly applied when:

- `SessionResolver` canonicalizes routing input and performs resolve-or-create behavior;
- `SessionStore` and `TranscriptStore` remain separate contracts;
- session entries explicitly store `agentId`, `sessionKey`, and current `sessionId`;
- transcript reads and appends are scoped by `sessionId`;
- every transcript entry has a store-assigned monotonic sequence unique within its `sessionId`;
- atomic append batches commit contiguous sequence ranges or no entries;
- history APIs use opaque cursors bound to `sessionId` and sequence position;
- a cursor from a previous transcript is rejected or requires refresh after reset;
- concurrent resolution of one new key produces one current mapping;
- reset preserves `sessionKey`, creates a new `sessionId`, and retains the prior transcript;
- failed reset leaves the prior mapping current;
- reset is rejected or serialized while a run is active;
- route-scoped and transcript-scoped metadata have separate tests;
- reconnect and Gateway restart preserve durable session mapping;
- clients cannot use a session key to bypass ownership checks;
- Gateway handlers depend on sessions contracts and do not access SQLite directly;
- runtime events are treated as notifications rather than the history source of truth;
- integration tests cover create, resolve, append, reset, retry, conflict, and restart behavior.

## Revisit conditions

Revisit this decision when:

- transcript branching, fork, merge, or restore becomes a product requirement;
- cursor compatibility must be published outside the local client set;
- history requires snapshot isolation across multiple concurrent writers or processes;
- compaction rotates the active transcript to a successor;
- session keys need aliases, renaming, or many-to-one routing;
- one logical session needs multiple simultaneously current transcript branches;
- active-run reset requires atomic cancellation and replacement;
- incognito or memory-only sessions are introduced;
- multi-user authorization changes access to session routes;
- transcript retention, deletion, export, or legal data policies are introduced;
- sessions move to a distributed or remotely replicated store.

## References

- `docs/ARCHITECTURE.md`, section 6, **Core identities**
- `docs/ARCHITECTURE.md`, section 9, **Agent Runtime architecture**
- `docs/ARCHITECTURE.md`, section 11, **Sessions and transcripts**
- `docs/ARCHITECTURE.md`, section 17, **Control UI and session surfaces**
- `docs/ARCHITECTURE.md`, section 19, **Storage and migrations**
- `docs/ARCHITECTURE.md`, section 22, **Dependency direction**
- `docs/decisions/0001-modular-monolith-and-openclaw-alignment.md`
- `docs/decisions/0002-core-runtime-identities-and-agent-ownership.md`
- OpenClaw Session management: `https://docs.openclaw.ai/concepts/session`
- OpenClaw Session management deep dive: `https://docs.openclaw.ai/reference/session-management-compaction`
- OpenClaw Security: `https://docs.openclaw.ai/gateway/security`
- OpenClaw TUI session lifecycle: `https://docs.openclaw.ai/web/tui`
- GoClaw, **Sessions and History**: `https://docs.goclaw.sh/sessions-and-history`
