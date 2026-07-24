# ADR 0002: Core Runtime Identities and Agent Ownership

- **Status:** Accepted
- **Date:** 2026-07-24
- **Decision owners:** my-agent-v2 maintainers
- **Related architecture:** `docs/ARCHITECTURE.md`
- **Related decisions:** `docs/decisions/0001-modular-monolith-and-openclaw-alignment.md`

## Context

`my-agent-v2` needs stable identities for configured agents, logical conversations, transcript instances, runtime invocations, model-loop attempts, and Gateway connections.

These concepts participate in different lifecycles and are owned by different modules. Treating them as interchangeable would create coupling between Gateway transport, session persistence, Agent Runtime execution, policy, events, and future multi-agent routing.

The initial product has one local Gateway and one configured agent named `primary`. It may also begin with one model-loop attempt per run. These V1 constraints must not become permanent assumptions such as:

- a process-wide agent singleton;
- one transcript for the entire lifetime of a logical conversation;
- one attempt for every run;
- one run owned by a WebSocket connection;
- connection state used as durable conversation state.

The architecture therefore distinguishes:

```text
agentId
sessionKey
sessionId
runId
attemptId
connectionId
```

The project needs one decision that defines the meaning, ownership, relationships, and lifecycle boundaries of these identities before later ADRs define session reset behavior, Gateway protocol details, run serialization, events, policy, and persistence.

## Decision

The six core identities are separate domain concepts and must remain explicit in contracts, runtime events, logs, policy inputs, and persistence where relevant.

No identity may be substituted for another merely because V1 currently has a single agent, a single Gateway, or a single attempt per run.

### `agentId`

`agentId` identifies one configured agent definition.

An agent definition conceptually owns or selects:

```text
identity and display metadata
workspace
agent state directory
credential references
session namespace
model defaults
harness defaults and selection policy
tool policy
sandbox policy
skills and bootstrap resources
```

V1 defines one agent:

```text
primary
```

`primary` is a configured default, not a domain-wide singleton.

Application and domain contracts must either carry an `agentId` explicitly or receive an already-resolved agent definition. They must not obtain ownership from an implicit global variable.

Concrete agent definitions and registries are composed by `src/bootstrap/`. Bootstrap may configure the default agent, but runtime modules remain responsible for operating on the explicit resolved identity they receive.

Future agents and delegates must have distinct ownership boundaries for workspace, state, credentials, sessions, policy, sandbox configuration, and runtime defaults. A delegate acts under its own `agentId` and authority rather than impersonating another agent.

### `sessionKey`

`sessionKey` identifies a stable logical conversation route.

Examples include:

```text
agent:primary:main
agent:primary:web:<conversation-id>
agent:primary:cli:<conversation-id>
```

A `sessionKey` may survive transcript replacement or reset. Session-level metadata and future presentation surfaces may remain attached to the same logical route while the current transcript instance changes.

Canonicalization and validation of session routing input belong to `SessionResolver` or a future routing boundary. Clients and transport handlers must not create persistence records or invent undocumented key formats directly.

Although the canonical string may contain an agent segment, agent ownership must also be represented and validated explicitly. Authorization, routing, and persistence must not rely only on parsing `agentId` from the key string.

The exact textual grammar of every future session-key variant is outside this ADR and may be extended through a later compatibility decision.

### `sessionId`

`sessionId` identifies one transcript instance.

A session entry associates a logical `sessionKey` with a current `sessionId` and an owning `agentId`.

A future reset may replace the current `sessionId` for a `sessionKey` without changing the logical route. Transcript entries, compaction records, and transcript-scoped runtime state belong to the `sessionId`, not merely to the `sessionKey`.

The sessions subsystem creates and persists `sessionId` values when it creates a transcript instance. Gateway handlers and Agent Runtime code must use session contracts rather than manufacture or persist transcript identities directly.

Detailed reset, archival, and historical mapping semantics are deferred to a session-routing ADR.

### `runId`

`runId` identifies one accepted Agent Runtime invocation.

A run begins when the Agent Runtime accepts a validated run request and ends in one terminal state:

```text
completed
failed
cancelled
```

The Agent Runtime creates the `runId` at the run boundary.

Each run is associated with exactly one:

```text
agentId
sessionKey
resolved sessionId
```

The run captures the `sessionId` resolved when the run is accepted. If the logical `sessionKey` is later remapped to another transcript instance, the existing run does not silently move to the new `sessionId`.

A run may originate from a Gateway request, CLI action, future channel, automation, or another application boundary. It is not owned by the originating transport connection and does not use `connectionId` as its durable identity.

Detailed run-state persistence, cancellation authority, and per-session serialization are deferred to the run-lifecycle ADR.

### `attemptId`

`attemptId` identifies one model-loop attempt within a run.

The Agent Runtime creates an `attemptId` when an attempt starts and passes it through harness, model, tool, event, logging, and error-correlation boundaries where applicable.

Every `attemptId` belongs to exactly one `runId`.

A run may contain multiple attempts because of:

- retry policy;
- provider failure;
- context overflow;
- compaction recovery;
- model fallback;
- harness recovery.

V1 may execute one attempt per run, but contracts and events must not encode a permanent one-to-one relationship.

The Agent Harness participates in the attempt lifecycle but does not replace or redefine the Agent Runtime's run identity.

### `connectionId`

`connectionId` identifies one accepted Gateway client connection.

The Gateway creates it when accepting a connection and retires it when that connection closes.

It may be used for:

- connection state;
- handshake state;
- event sequencing;
- diagnostics and logs;
- associating protocol activity with a client connection.

It must not be used as:

- a durable session identity;
- a transcript identity;
- an agent identity;
- a run identity;
- proof that a reconnecting client owns prior work.

Reconnect creates a new `connectionId`. Durable state is recovered through explicit session, run, and application APIs rather than by preserving connection identity.

### Relationship invariants

The following invariants apply:

1. A configured agent is identified by one `agentId`.
2. A session entry belongs to exactly one `agentId`.
3. A `sessionKey` identifies a logical route, while a `sessionId` identifies one transcript instance.
4. A `sessionKey` resolves to one current `sessionId` at a time unless a later ADR explicitly introduces a different model.
5. A run belongs to exactly one `agentId`, one `sessionKey`, and the `sessionId` resolved at acceptance.
6. An attempt belongs to exactly one `runId`.
7. A connection may initiate or observe multiple runs and sessions, but does not own their durable identity.
8. Closing or replacing a connection does not by itself delete, replace, complete, or re-identify a session or run.
9. Multi-agent support must extend these relationships rather than introduce a separate identity model.

### Authority for creating and resolving identities

The intended authority boundaries are:

| Identity | Creation or resolution authority |
|---|---|
| `agentId` | Configuration and agent definitions composed by bootstrap; resolved through an agent-facing contract or registry |
| `sessionKey` | Canonicalized and validated by `SessionResolver` or a future routing boundary |
| `sessionId` | Created by the sessions subsystem when creating a transcript instance |
| `runId` | Created by Agent Runtime when accepting a run |
| `attemptId` | Created by Agent Runtime when starting an attempt |
| `connectionId` | Created by Gateway when accepting a client connection |

Concrete stores may persist identities but do not become the domain authority for their meaning.

Transport handlers may receive or expose identities through validated schemas but do not redefine their semantics.

### Identifier representation

Core identifiers are opaque values outside the module that owns their creation.

Consumers may compare, persist, log, and transmit them through validated contracts, but must not depend on undocumented encoding details.

This ADR does not require UUID, ULID, database sequence, or another specific generator. A later implementation may choose a representation appropriate to uniqueness, ordering, storage, and protocol needs without changing identity semantics.

Changing an identifier's externally documented representation or compatibility guarantees requires a separate decision or protocol version change when applicable.

### Related correlation identifiers

Gateway request IDs, tool-call IDs, approval IDs, event sequence numbers, device identities, authenticated principals, and audit-record IDs are related correlation concepts but are outside the scope of this ADR.

They must not be treated as aliases for any core identity defined here.

## OpenClaw alignment and intentional differences

This decision aligns with the current OpenClaw architecture in the following ways:

- each configured `agentId` owns an isolated workspace, state directory, credentials or auth profiles, and session store;
- session routing uses a stable session key while reset starts a new `sessionId`;
- an accepted agent command exposes a `runId` after resolving `sessionKey` and `sessionId`;
- runs are serialized through a per-session lane;
- Gateway connections are transport-scoped and do not replace durable agent or session identity;
- delegates use their own identity, scoped permissions, tool policy, and sandbox boundary.

`my-agent-v2` intentionally differs from OpenClaw in these details:

- the V1 default agent ID is `primary` rather than OpenClaw's `main`;
- session business rules remain owned by the `sessions` subsystem even though clients access them through the Gateway;
- `attemptId` is promoted to an explicit internal runtime identity. OpenClaw documents an attempt loop and retry paths, but does not require the same public identity contract;
- remote device identity, pairing, authenticated principals, and channel account identity are deferred and remain distinct from `connectionId` and `agentId` when introduced.

## Consequences

### Positive

- Gateway transport lifetime remains independent from durable application state.
- Session reset can replace transcript history without replacing the logical conversation route.
- Runtime events, logs, policy checks, and future audit records can correlate work consistently.
- Multiple attempts, providers, and harness recovery can be introduced without redefining `runId`.
- Multi-agent routing and delegates can be added without replacing singleton-based assumptions throughout the codebase.
- Ownership and creation authority are explicit, reducing accidental cross-module coupling.

### Negative

- More identifiers must be propagated through contracts and tests.
- V1 code carries concepts such as `attemptId` and explicit `agentId` even when only one value exists.
- Mapping logical routes to transcript instances adds indirection compared with storing all history under one conversation identifier.
- Logs and diagnostics must present enough context to make the distinct identifiers understandable.

## Risks and trade-offs

### Identifier proliferation

Developers may find the number of identifiers cumbersome and omit required correlation fields.

Mitigation:

- define small shared identity types within the owning modules;
- use structured runtime context objects rather than long positional argument lists;
- test boundary mappings and emitted events;
- document which identity is required by each contract.

### Accidental inference from string formats

Code may parse ownership from `sessionKey` and treat the parsed value as authoritative.

Mitigation:

- persist and validate `agentId` explicitly;
- keep canonicalization in the sessions or routing boundary;
- treat identifier strings as opaque outside their owning module.

### Hidden singleton assumptions

The single V1 agent may lead modules to import a global `primary` value or shared mutable runtime state.

Mitigation:

- compose the default in bootstrap;
- pass resolved agent context explicitly;
- include non-default agent IDs in unit tests where practical, even before full multi-agent routing exists.

### Identity without lifecycle state

An identifier alone does not define whether a run, attempt, session, or connection is active or terminal.

Mitigation:

- keep lifecycle state in the owning runtime or store;
- do not infer state from identifier presence;
- define lifecycle transitions in later focused ADRs.

## Rejected alternatives

### Use one conversation ID for `sessionKey` and `sessionId`

Rejected because logical session metadata and presentation surfaces may outlive one transcript instance. Reset and transcript replacement would otherwise require replacing the entire logical conversation identity or mixing old and new transcript state.

### Use `connectionId` as the session identity

Rejected because connections are transient, clients reconnect, and future non-Gateway origins may start work without a WebSocket connection.

### Use `runId` as `attemptId`

Rejected because retries, provider fallback, compaction recovery, and harness recovery may create multiple attempts within one user-visible run.

### Treat `primary` as a process-wide singleton

Rejected because it would couple sessions, credentials, policy, workspaces, models, and runtime state to one implicit agent and make future agents or delegates require invasive changes.

### Let every module generate any identifier it needs

Rejected because duplicate creation authority would make correlation unreliable and allow Gateway, storage, harness, or provider code to redefine domain lifecycles independently.

### Standardize all identifiers on a specific encoding now

Rejected because the current architectural requirement is semantic separation and ownership. Selecting UUID, ULID, database sequences, or sortable encodings is an implementation decision until external compatibility, ordering, or distributed generation requirements make it material.

## Validation

This decision is correctly applied when:

- contracts do not use one core identity as a substitute for another;
- agent-facing operations carry or receive an explicitly resolved `agentId`;
- `primary` is configured at composition boundaries rather than imported as mutable global runtime state;
- session entries explicitly associate `sessionKey`, `sessionId`, and `agentId`;
- session-key canonicalization remains inside `SessionResolver` or the routing boundary;
- transcript operations are scoped by `sessionId`;
- Agent Runtime creates and propagates `runId` and `attemptId` according to their lifecycles;
- runtime events can correlate at least `agentId`, `sessionKey`, `sessionId`, `runId`, and `attemptId` when those concepts exist at the emission point;
- Gateway creates a new `connectionId` for each accepted connection;
- reconnect does not change durable session or run identity;
- unit and integration tests use mismatched or non-default identities to prove that ownership is validated instead of inferred;
- no Gateway handler or concrete store silently becomes the authority for identity semantics outside its declared boundary.

## Revisit conditions

Revisit this decision when:

- agent identity must be renamed, aliased, deleted, or migrated;
- a `sessionKey` must resolve to multiple active transcript branches;
- sessions may transfer ownership between agents;
- runs may span multiple sessions or agents;
- distributed workers require globally coordinated identifier generation;
- externally published protocols require stable identifier encodings;
- remote authentication introduces a principal identity that must be related to, but remain distinct from, `agentId`;
- persistent run recovery changes which module owns run or attempt creation;
- delegates require a richer principal, actor, or delegation-chain model.

## References

- `docs/ARCHITECTURE.md`, section 6, **Core identities**
- `docs/ARCHITECTURE.md`, section 8, **Agent definition and ownership**
- `docs/ARCHITECTURE.md`, section 9, **Agent Runtime architecture**
- `docs/ARCHITECTURE.md`, section 11, **Sessions and transcripts**
- `docs/ARCHITECTURE.md`, section 18, **Multi-agent routing and delegates**
- `docs/ARCHITECTURE.md`, section 21, **Lifecycle and composition**
- `docs/ARCHITECTURE.md`, section 22, **Dependency direction**
- `docs/decisions/0001-modular-monolith-and-openclaw-alignment.md`
- OpenClaw Gateway architecture: `https://docs.openclaw.ai/concepts/architecture`
- OpenClaw Agent runtime architecture: `https://docs.openclaw.ai/agent-runtime-architecture`
- OpenClaw Agent loop: `https://docs.openclaw.ai/concepts/agent-loop`
- OpenClaw Session management: `https://docs.openclaw.ai/concepts/session`
- OpenClaw Multi-agent routing: `https://docs.openclaw.ai/concepts/multi-agent`
- OpenClaw Delegate architecture: `https://docs.openclaw.ai/concepts/delegate-architecture`
