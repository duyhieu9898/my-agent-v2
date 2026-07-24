# ADR 0004: Gateway Control Plane and Protocol Contract

- **Status:** Accepted
- **Date:** 2026-07-24
- **Decision owners:** my-agent-v2 maintainers
- **Related architecture:** `docs/ARCHITECTURE.md`
- **Related decisions:**
  - `docs/decisions/0001-modular-monolith-and-openclaw-alignment.md`
  - `docs/decisions/0002-core-runtime-identities-and-agent-ownership.md`
  - `docs/decisions/0003-session-routing-transcript-separation-and-reset-semantics.md`

## Context

`my-agent-v2` needs one stable entry point for the local Control UI, CLI, and future clients.

That entry point must provide:

- process lifecycle and health;
- HTTP and WebSocket transport;
- protocol negotiation;
- runtime validation of external input;
- method dispatch;
- structured errors;
- capability discovery;
- server-push events;
- reconnect and state-refresh behavior;
- graceful shutdown.

The Gateway must not become the owner of agent execution, sessions, transcripts, storage, model providers, tools, browser behavior, or platform business rules.

The current repository already contains a Gateway foundation using `node:http`, `ws`, TypeBox, AJV, request/response/event frames, a `connect` handshake, protocol versioning, method schemas, handler registration, and integration tests.

OpenClaw uses a single long-lived Gateway as its WebSocket control plane. Its current protocol uses typed `req`, `res`, and `event` frames, requires a `connect` request before ordinary RPC, validates frames against schemas, negotiates protocol versions, exposes capability metadata, applies connection-scoped event sequencing, and requires idempotency keys for side-effecting methods.

`my-agent-v2` adopts those control-plane concepts while intentionally omitting OpenClaw's current channel ownership, remote nodes, device pairing, role and scope enforcement, broad RPC surface, and remote deployment complexity from V1.

## Decision

`my-agent-v2` will run one long-lived local Gateway process per host.

The Gateway is the unified transport and control-plane boundary for local clients. It owns protocol and connection concerns, but delegates application behavior to explicit facades and domain contracts.

## Gateway ownership

The Gateway owns:

```text
HTTP server lifecycle
WebSocket server lifecycle
connection acceptance and connectionId creation
connection state
connect handshake
protocol-version negotiation
external frame parsing and validation
method-schema lookup
method-handler dispatch
request and response correlation
structured protocol errors
capability discovery
server-push event delivery
connection-scoped event sequencing
outbound buffering and backpressure policy
graceful admission shutdown
client connection shutdown
```

The Gateway does not own:

```text
agent-loop logic
run and attempt lifecycle rules
model execution
tool execution
policy decisions
approval decisions
browser implementation
platform implementation
session canonicalization rules
transcript mutation rules
direct SQLite access
storage migrations
provider credentials
```

Gateway handlers adapt validated protocol requests to application-facing contracts. They must not reproduce business logic that belongs to another module.

## Runtime topology

V1 uses one Node.js process containing the Gateway and the modular-monolith application runtime.

HTTP and WebSocket share one host and port.

The concrete transport implementation uses:

```text
node:http
ws
```

A web framework such as Fastify is not introduced for the initial Gateway. Adding or replacing the transport framework requires evidence that the existing implementation cannot satisfy active requirements and must not change the protocol contract implicitly.

## HTTP surface

HTTP is used for bounded host-level surfaces such as:

- liveness and readiness checks;
- serving the Control UI;
- static assets;
- future explicitly registered HTTP routes;
- future standards-compatible APIs where WebSocket RPC is inappropriate.

WebSocket remains the primary control protocol for requests, responses, streaming updates, and server-push events.

An HTTP route must have an explicit owner. Adding a route must not bypass the same application, policy, session, or runtime contracts used by WebSocket methods.

Gateway handlers and HTTP routes must not access SQLite directly.

## WebSocket transport and framing

WebSocket messages use text frames containing JSON payloads.

The protocol has three frame families:

```text
req
res
event
```

### Request frame

Conceptual shape:

```json
{
  "type": "req",
  "id": "request-id",
  "method": "method.name",
  "params": {}
}
```

A request contains:

- a client-generated request ID;
- a registered method name;
- parameters validated against that method's schema.

### Response frame

Conceptual success shape:

```json
{
  "type": "res",
  "id": "request-id",
  "ok": true,
  "payload": {}
}
```

Conceptual failure shape:

```json
{
  "type": "res",
  "id": "request-id",
  "ok": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Human-readable summary",
    "details": {},
    "retryable": false,
    "retryAfterMs": 1000
  }
}
```

A request receives exactly one response frame.

The response ID must match the request ID.

Long-running application work must not require multiple response frames for one request. A start method returns a bounded acknowledgement containing the durable operation identity, such as `runId`. Progress and terminal changes are delivered through events and observable-state RPC methods defined by the owning runtime ADR.

### Event frame

Conceptual shape:

```json
{
  "type": "event",
  "event": "run.started",
  "payload": {},
  "seq": 42,
  "stateVersion": 7
}
```

An event contains:

- a registered event name;
- a validated event payload;
- optional connection-scoped sequence metadata;
- optional resource or state-version metadata.

Event payload schemas are protocol contracts. Runtime modules emit application events through an event-facing boundary; the Gateway decides how those events are filtered, sequenced, translated, and delivered to connections.

## Schema authority and validation

TypeBox schemas are the source of truth for external Gateway contracts.

AJV performs runtime validation.

TypeScript types are inferred from or remain mechanically aligned with the schemas. Hand-written TypeScript types must not silently diverge from the runtime contract.

Validation occurs before external data reaches application modules.

The Gateway validates:

- top-level frame shape;
- request identifiers;
- method names;
- method parameters;
- response payloads where practical;
- event names and payloads at the publishing boundary where practical.

Invalid JSON, malformed frames, unknown frame types, unknown methods, invalid parameters, and invalid handshake state return structured protocol errors or close the connection when a normal RPC response is unsafe or impossible.

Raw validation exceptions, stack traces, credentials, and internal object representations must not cross the protocol boundary.

## Method schemas and handlers

Method definition and method execution are separate registries or equivalent explicit structures.

A method definition includes at least:

```text
method name
parameter schema
success payload schema
error behavior
side-effect classification
future capability or scope metadata
```

A method handler receives:

- validated parameters;
- explicit connection context;
- application-facing dependencies provided by bootstrap;
- cancellation or shutdown signal where applicable.

A handler must not receive the raw WebSocket as its application API.

Unknown methods return a stable machine-readable error code.

Method names are part of the external compatibility surface. Renaming or repurposing a published method requires an additive migration, deprecation period, or protocol-version decision.

## Connection lifecycle

The Gateway creates a new `connectionId` for each accepted WebSocket connection, as defined by ADR 0002.

The connection moves through explicit states such as:

```text
accepted
awaiting-connect
connected
closing
closed
```

Before a successful handshake, ordinary methods are not dispatchable.

The first client request must be `connect`.

The Gateway may later emit a pre-connect challenge event before the client sends `connect` when authentication or device identity is implemented. Such a challenge does not authorize ordinary RPC and does not change the requirement that the first client request is `connect`.

A failed handshake may return a structured error and close the connection.

A successful handshake transitions the connection to the connected state and returns a bounded hello payload.

## Connect handshake

The V1 `connect` request negotiates at least:

```text
minimum protocol version
maximum protocol version
client identity metadata
client version
client platform when known
client mode
```

The contract must leave additive room for:

```text
role
scopes
capabilities
commands
permissions
authentication material
device identity
locale
user agent
```

V1 does not claim to enforce authentication, device pairing, roles, or granular scopes unless separately implemented and documented.

Fields reserved for those capabilities must not be treated as trusted authorization merely because a client supplies them.

The successful connect response includes at least:

```text
selected protocol version
Gateway identity or instance metadata
connectionId
health or readiness snapshot
available methods
available event families
available capabilities or feature flags
protocol or payload policy metadata when applicable
```

Capability discovery describes what the connected client may attempt or consume. It does not replace server-side validation or future authorization.

## Protocol versioning

Each client sends a supported protocol range:

```text
minProtocol
maxProtocol
```

The Gateway selects a compatible version within the intersection.

If no compatible version exists, the handshake fails with a structured version-mismatch error and the connection closes.

V1 may initially expose one protocol version. The range contract is retained so future additive and breaking changes do not require replacing the handshake.

Protocol changes should be additive when possible.

A protocol-version increment is required when a previously valid client cannot safely interpret the new wire behavior, including changes such as:

- incompatible frame shapes;
- changed required handshake fields;
- changed semantics of an existing method;
- changed event meaning that old clients could mis-handle;
- removal of a previously supported contract without a compatibility path.

Internal refactoring does not require a version change when the external contract remains equivalent.

## Request IDs and duplicate handling

A request ID correlates one request with one response on a connection.

The Gateway rejects or deterministically handles a duplicate request ID that is already in flight on the same connection.

A request ID is not a durable idempotency key and must not be used as `runId`, `sessionId`, or another domain identity.

Read-only requests may be retried by a client after reconnect.

Every externally retryable side-effecting method must define an idempotency key or equivalent deduplication contract before clients are expected to retry it after uncertain delivery.

Deduplication semantics belong to the application operation, not only to the WebSocket connection, because reconnect creates a new `connectionId`.

## Errors

Protocol errors use stable machine-readable codes and human-readable messages.

The error contract supports:

```text
code
message
details
retryable
retryAfterMs
```

Clients branch on `code` and structured `details`, not on exact message text.

Expected error categories include:

```text
INVALID_JSON
INVALID_FRAME
INVALID_REQUEST
UNKNOWN_METHOD
METHOD_NOT_ALLOWED
PROTOCOL_VERSION_MISMATCH
NOT_CONNECTED
CONFLICT
FORBIDDEN
NOT_FOUND
UNAVAILABLE
RATE_LIMITED
INTERNAL_ERROR
```

Not every category must be implemented in the first slice, but new handlers must reuse or deliberately extend the common error taxonomy rather than inventing incompatible shapes.

Unexpected internal failures are logged with correlation metadata and exposed as a bounded `INTERNAL_ERROR` without stack traces or secrets.

## Event sequencing and recovery

Gateway events are a best-effort observable stream, not the durable source of truth.

The Gateway assigns a monotonically increasing `seq` to delivered events on each connected WebSocket where sequencing is enabled.

Sequence numbers are scoped to the connection and reset for a new connection.

A missing or non-consecutive sequence tells the client that one or more events may have been lost.

On a sequence gap, reconnect, client suspension, or uncertain state, the client refreshes authoritative state through RPC methods such as session history, run status, health, or capability discovery.

The Gateway is not required to replay all missed events in V1.

A future durable event store or resumable subscription protocol requires a separate decision and must not redefine the transcript or domain stores as an implicit event log.

A runtime may include its own operation-scoped sequence inside an event payload, such as a per-run sequence. That sequence is distinct from the outer connection-scoped Gateway `seq`.

## Event delivery and backpressure

The Gateway owns bounded outbound delivery per connection.

A slow or blocked client must not create unbounded process memory growth or stall unrelated connections and runtime work.

The implementation may:

- cap queued bytes or frames;
- coalesce explicitly coalescible state events;
- drop explicitly lossy events;
- close connections that exceed delivery policy;
- emit diagnostics without logging payload contents.

Events that are dropped or coalesced must remain recoverable through authoritative RPC state when correctness depends on them.

Transcript persistence and application state updates must not depend on successful WebSocket event delivery.

## Capability discovery

The Gateway exposes a capability snapshot during handshake or through a dedicated method.

The snapshot may include:

- supported methods;
- supported event families;
- protocol features;
- available agent runtimes;
- available model routes;
- available tools;
- browser availability;
- supported client capabilities;
- future plugin-provided surfaces.

V1 may use static capability registration composed by bootstrap.

Capability metadata must come from registered runtime capabilities rather than scattered hard-coded client assumptions.

The absence of a capability means the client must not assume it exists.

## Client modes, future roles, and authorization

V1 supports trusted local Control UI and CLI clients.

The handshake keeps `client.mode` distinct from future security roles.

Future roles may include:

```text
operator
node
channel adapter
native companion
automation client
worker
```

Client-reported role, scopes, capabilities, commands, or permissions are claims. They do not grant authority without a future server-side authentication and authorization decision.

Remote Gateway exposure, device identity, pairing, token issuance, principal identity, role enforcement, scope enforcement, and node command authorization are deferred and require security-focused decisions before implementation.

The local-only V1 must not present itself as secure for untrusted remote clients merely because the protocol reserves those fields.

## Application boundaries

The Gateway depends only on application-facing facades and domain contracts.

Examples:

```text
Gateway sessions methods → SessionResolver or session application service
Gateway run methods → Agent Runtime facade
Gateway health methods → lifecycle or health service
Gateway browser methods → browser application contract
```

Forbidden examples include:

```text
Gateway handler → SQLite query
Gateway handler → provider SDK
Gateway handler → concrete browser implementation
Gateway handler → direct shell execution
Gateway handler → transcript file mutation
Gateway dispatch loop → embedded agent loop
```

Bootstrap constructs the concrete Gateway, registries, stores, runtime facades, and adapters, then injects the dependencies needed by handlers.

## Graceful shutdown

Shutdown proceeds in controlled phases:

```text
stop accepting new HTTP and WebSocket work
mark Gateway unavailable or draining
reject new application operations
cancel or drain in-flight request handlers according to their contracts
cancel or drain active runs through Agent Runtime
publish bounded shutdown notice when possible
close client connections
close the HTTP server
release downstream runtime and storage resources
```

The Gateway owns transport admission and connection closure. It does not directly terminate provider, browser, tool, or storage resources that are owned by other modules; bootstrap coordinates their shutdown order.

A process signal must not bypass normal cleanup when graceful shutdown remains possible.

## OpenClaw alignment and intentional differences

This decision aligns with current OpenClaw concepts in the following ways:

- one long-lived Gateway provides the control plane;
- control clients connect over WebSocket;
- HTTP and WebSocket can share one port;
- the protocol uses typed request, response, and server-push event frames;
- the first client request is `connect`;
- protocol versions are negotiated during handshake;
- external frames are validated against runtime schemas;
- the handshake reports methods, events, policies, or feature metadata;
- event frames may contain connection-scoped sequence and state-version metadata;
- clients recover from gaps or reconnects using authoritative RPC state;
- side-effecting methods require operation-level idempotency;
- client capability claims are distinct from authorization.

`my-agent-v2` intentionally differs or starts smaller in the following ways:

- V1 Gateway is local-first and does not own messaging-provider connections;
- V1 does not implement OpenClaw's node transport or command surface;
- V1 does not implement device signatures, pairing, device tokens, roles, or scope enforcement;
- V1 has a much smaller method and event catalog;
- V1 does not require published Gateway npm packages;
- V1 does not require durable event replay;
- V1 uses its own application and session ownership boundaries rather than copying OpenClaw's complete Gateway internals;
- V1 uses `node:http` and `ws` without introducing a larger web framework.

## Consequences

### Positive

- Local clients have one stable, typed entry point.
- External data is validated before entering application modules.
- Gateway transport remains separate from agent, session, provider, tool, and storage logic.
- Reconnect does not redefine durable state.
- Clients can detect event loss and recover through RPC.
- Protocol evolution has an explicit negotiation and compatibility path.
- Future auth, roles, nodes, plugins, and remote access have reserved seams without being prematurely implemented.

### Negative

- Method schemas, handler registration, event schemas, and error mappings add implementation overhead.
- Clients must maintain reconnect and refresh logic instead of relying on event replay.
- Explicit capability metadata must remain synchronized with registered behavior.
- Long-running operations require event and status contracts rather than a single blocking RPC.
- Bounded backpressure handling introduces connection-management complexity.

## Risks and trade-offs

### Gateway becoming a god module

New behavior may be implemented directly in handlers because the Gateway is the visible entry point.

Mitigation:

- handlers depend on application facades;
- architecture tests or import rules block direct storage and provider access;
- material ownership changes require an ADR.

### Protocol drift

Runtime schemas, inferred TypeScript types, handlers, client assumptions, and documentation may diverge.

Mitigation:

- TypeBox remains the schema source of truth;
- validate method registration against schemas;
- test request, response, and event compatibility;
- generate shared protocol artifacts only after package extraction is justified.

### False security assumptions

Reserved role, scope, capability, or auth fields may be mistaken for enforcement.

Mitigation:

- document V1 as trusted-local only;
- treat client declarations as untrusted claims;
- require a security ADR before remote or untrusted access.

### Event loss causing stale UI state

A client may miss events during suspension, slow consumption, or reconnect.

Mitigation:

- use connection-scoped sequence numbers;
- detect gaps;
- expose bounded authoritative state RPCs;
- keep events non-authoritative.

### Retry duplicating side effects

A client may reconnect after an uncertain response and repeat a mutation.

Mitigation:

- require operation-level idempotency for retryable side effects;
- do not treat request ID or connection ID as durable deduplication identity;
- test duplicate delivery.

### Slow-client memory growth

Unbounded outbound queues could exhaust process memory.

Mitigation:

- enforce bounded queues and payload policy;
- close or degrade slow connections;
- keep durable state independent of event delivery.

## Rejected alternatives

### Expose independent APIs from every module

Rejected because clients would need to coordinate multiple transports, lifecycle boundaries, versions, and authentication models.

### Put the agent loop inside the Gateway dispatcher

Rejected because it would couple transport lifetime and protocol concerns to model, tool, retry, context, and transcript behavior.

### Let Gateway handlers query SQLite directly

Rejected because it would bypass session and store contracts, leak persistence details, and make alternative storage or testing harder.

### Use HTTP request-response only

Rejected because agent runs, approvals, tool progress, health changes, and future runtime events require server-push behavior.

### Use WebSocket events as durable state

Rejected because clients disconnect, frames can be dropped, sequence scopes reset, and long-term state belongs to domain stores.

### Replay every event after reconnect in V1

Rejected because it would require a durable event store and retention protocol before an active product requirement exists.

### Introduce Fastify immediately

Rejected because `node:http` and `ws` already satisfy the current surface, while a framework would add dependency and abstraction cost without an active requirement.

### Copy the full OpenClaw Gateway protocol

Rejected because OpenClaw's current roles, scopes, node commands, pairing, channels, workers, and broad RPC catalog exceed the active `my-agent-v2` scope.

### Omit protocol negotiation until a breaking change occurs

Rejected because retrofitting version negotiation after clients exist creates avoidable compatibility risk.

## Validation

This decision is correctly applied when:

- one long-lived Gateway accepts local Control UI and CLI connections;
- HTTP and WebSocket share the configured host and port;
- the implementation uses `node:http` and `ws` unless a later decision changes it;
- the first client request is `connect`;
- ordinary methods are rejected before handshake completion;
- incompatible protocol ranges fail deterministically;
- request, response, and event frames are validated through TypeBox and AJV contracts;
- every request receives at most one response;
- long-running work returns a bounded acknowledgement and uses events or status RPCs for later state;
- unknown methods and invalid params return stable structured errors;
- handlers receive validated params and application facades rather than raw persistence or provider dependencies;
- no Gateway handler directly accesses SQLite;
- event sequence numbers are connection-scoped;
- clients can detect sequence gaps and refresh state through RPC;
- event delivery failure does not roll back transcript or domain state;
- outbound buffering is bounded;
- retryable side-effecting methods define idempotency or deduplication semantics;
- capability metadata reflects actually registered behavior;
- V1 does not claim role, scope, device, or remote security enforcement that is not implemented;
- graceful shutdown stops admission before closing downstream resources;
- integration tests cover handshake, version mismatch, invalid frames, unknown methods, request correlation, event sequencing, disconnect, and shutdown.

## Revisit conditions

Revisit this decision when:

- the Gateway is exposed to untrusted or remote clients;
- authentication, device pairing, principals, roles, or scopes are introduced;
- node or worker transports are added;
- a second process requires the protocol as a published package;
- a durable or resumable event stream becomes necessary;
- HTTP APIs become a primary external integration surface;
- the Gateway must run multiple versions of the protocol concurrently;
- payload volume or connection count makes the current `node:http` and `ws` implementation insufficient;
- a subsystem requires independent deployment or failure isolation;
- external plugins may register Gateway methods or HTTP routes dynamically.

## References

- `docs/ARCHITECTURE.md`, section 7, **Gateway architecture**
- `docs/ARCHITECTURE.md`, section 17, **Control UI and session surfaces**
- `docs/ARCHITECTURE.md`, section 19, **Storage and migrations**
- `docs/ARCHITECTURE.md`, section 20, **Events, logs, and audit**
- `docs/ARCHITECTURE.md`, section 21, **Lifecycle and composition**
- `docs/ARCHITECTURE.md`, section 22, **Dependency direction**
- `docs/decisions/0001-modular-monolith-and-openclaw-alignment.md`
- `docs/decisions/0002-core-runtime-identities-and-agent-ownership.md`
- `docs/decisions/0003-session-routing-transcript-separation-and-reset-semantics.md`
- OpenClaw Gateway architecture: `https://docs.openclaw.ai/concepts/architecture`
- OpenClaw Gateway protocol: `https://docs.openclaw.ai/gateway/protocol`
- OpenClaw Gateway client lifecycle: `https://docs.openclaw.ai/gateway/clients`
- OpenClaw external application integrations: `https://docs.openclaw.ai/gateway/external-apps`
