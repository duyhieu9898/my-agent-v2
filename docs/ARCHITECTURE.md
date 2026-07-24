# my-agent-v2 Architecture

## 1. Status and purpose

This document defines the long-lived architectural boundaries, terminology, dependency rules, and extension seams of `my-agent-v2`.

It is the architecture source of truth for coding agents, Codex CLI, and the repository harness.

This document does not define a step-by-step implementation sequence. Execution work belongs in:

```text
docs/plans/active/
```

Material architecture changes require an Architecture Decision Record in:

```text
docs/decisions/
```

`my-agent-v2` intentionally adopts useful concepts and terminology from OpenClaw while remaining a smaller, local-first, single-user system.

The objective is not feature parity. The objective is to preserve architectural seams that allow future OpenClaw-inspired capabilities to be added without replacing the core design.

---

## 2. Product direction

`my-agent-v2` is a personal AI assistant that runs locally and can:

* communicate through a local Control UI and CLI;
* manage sessions and conversation history;
* execute model-driven agent runs;
* read and modify files;
* execute shell and platform operations;
* control a browser;
* enforce policy and approval before side effects;
* record structured runtime events;
* expand later to additional platforms, agents, channels, runtimes, and plugins.

### 2.1 Initial constraints

The first production-capable version targets:

* one trusted local user;
* Linux;
* one primary agent;
* one active serialized run per session;
* one local Gateway;
* local persistent storage;
* one initial model provider;
* one initial agent harness;
* one initial browser provider;
* manual updates;
* minimal configuration.

These are scope constraints, not permanent architectural assumptions.

The design must not make it necessary to rewrite the Gateway, Agent Runtime, session model, or tool contracts when adding:

* Windows or macOS;
* multiple agents;
* additional model providers;
* additional agent harnesses;
* messaging channels;
* remote nodes;
* plugin loading;
* multiple Control UI surfaces.

---

## 3. Architectural style

### 3.1 Modular monolith first

The system begins as a modular monolith under `src/`.

Subsystems are separated by:

* explicit ownership;
* stable contracts;
* dependency direction;
* runtime validation at boundaries;
* composition through `src/bootstrap/`.

A subsystem is not automatically a workspace package or separate process.

### 3.2 Extract packages only after boundaries stabilize

Code may move to `packages/` when at least one of these conditions is true:

* multiple applications need the same library;
* a wire protocol must be shared with external clients;
* a plugin SDK must expose stable public contracts;
* a dependency must be isolated;
* independent versioning is required;
* the module contract is stable enough to publish.

Expected future candidates include:

```text
packages/gateway-protocol/
packages/gateway-client/
packages/agent-core/
packages/plugin-sdk/
```

### 3.3 Build vertical slices

Implementation must progress through end-to-end behavior rather than disconnected infrastructure.

Preferred flow:

```text
Gateway request
→ validated application command
→ Agent Runtime or domain service
→ provider/tool/store
→ structured event
→ Gateway response or server-push event
→ automated test
```

New abstractions require an active consumer or an explicitly approved extension seam.

---

## 4. Repository organization

```text
my-agent-v2/
├── AGENTS.md
├── README.md
├── apps/
├── config/
├── docs/
├── extensions/
├── packages/
├── scripts/
├── skills/
├── src/
├── test/
└── ui/
```

### 4.1 `src/`

Contains the main Node.js implementation.

Current and planned module roots include:

```text
src/
├── agents/
├── bootstrap/
├── browser/
├── config/
├── context/
├── gateway/
├── models/
├── platform/
├── plugins/
├── policy/
├── sessions/
└── storage/
```

### 4.2 `ui/`

Contains the browser Control UI.

The UI is a Gateway client. It must not import backend runtime or storage modules.

### 4.3 `apps/`

Contains independently runnable native or platform companion applications.

Examples:

```text
apps/linux/
apps/windows/
apps/macos/
```

The Gateway and Agent Runtime do not belong in `apps/`.

### 4.4 `packages/`

Contains stable reusable libraries and public contracts after extraction criteria are met.

### 4.5 `extensions/`

Contains optional capability integrations.

V1 does not require dynamic loading, installation, manifests, or a plugin marketplace, but future extensions must follow the plugin boundaries in this document.

### 4.6 `skills/`

Contains reusable agent instructions and task-specific knowledge resources.

Skills are resources consumed by an Agent Runtime or harness. They are not executable plugins by default.

### 4.7 `docs/`

Documentation ownership is:

```text
docs/ARCHITECTURE.md       long-lived architecture
docs/product/              product intent and scope
docs/decisions/            architecture decision records
docs/plans/active/         executable implementation plans
docs/plans/completed/      completed plans and validation evidence
docs/WORKFLOW.md           Codex CLI and harness workflow
```

---

## 5. High-level runtime topology

```text
Control UI / CLI / Future Channels / Future Native Apps
                         │
                         ▼
                      Gateway
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
     Agent Routing   Session APIs   System APIs
          │
          ▼
                Agent Runtime Facade
                         │
                 Harness Selection
                         │
                  Agent Harness
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
       Context        Model Runtime   Tool Runtime
          │              │              │
          ▼              ▼       ┌──────┴──────┐
      Sessions       Providers    ▼             ▼
     Transcripts                Platform      Browser
                                 Tools         Runtime

Cross-cutting boundaries:

Config
Policy and Approval
Events
Storage
Plugin Registry
Workspace
Agent Definition
Observability
```

---

## 6. Core identities

The following identities must remain distinct.

### 6.1 `agentId`

Identifies the configured agent that owns:

* identity;
* workspace;
* model defaults;
* harness selection;
* credentials;
* policy;
* sessions;
* runtime state.

V1 uses:

```text
primary
```

but ownership must not be inferred from a global singleton.

### 6.2 `sessionKey`

A stable logical conversation route.

Examples:

```text
agent:primary:main
agent:primary:web:<conversation-id>
agent:primary:cli:<conversation-id>
```

The session key survives transcript replacement or reset when a logical session surface should remain attached.

Clients must not invent undocumented session keys. Canonicalization belongs to the session resolver or future routing layer.

### 6.3 `sessionId`

Identifies one transcript instance.

A logical session key may later point to a new session ID after reset while retaining session-level state such as metadata or presentation surfaces.

### 6.4 `runId`

Identifies one Agent Runtime invocation.

A run begins with an accepted application command and ends in:

* completed;
* failed;
* cancelled.

### 6.5 `attemptId`

Identifies one model-loop attempt inside a run.

Retries, provider failover, or compaction recovery may create multiple attempts for one run.

V1 may initially have one attempt per run, but the run model must not prevent multiple attempts later.

### 6.6 `connectionId`

Identifies one Gateway client connection.

Connection state must not be used as durable session identity.

---

## 7. Gateway architecture

### 7.1 Role

The Gateway is the long-lived control-plane process and unified entry point for clients.

V1 runs one local Gateway per host.

The Gateway owns:

* HTTP server lifecycle;
* WebSocket lifecycle;
* connection state;
* protocol negotiation;
* frame validation;
* request dispatch;
* capability discovery;
* server-push event delivery;
* connection-level sequencing;
* future authentication and role negotiation;
* graceful shutdown.

The Gateway does not own:

* agent-loop logic;
* model execution;
* tool execution;
* browser implementation;
* direct SQLite access;
* session business rules;
* transcript mutation rules.

### 7.2 Transport

HTTP and WebSocket share the Gateway host and port.

HTTP is used for:

* health and readiness checks;
* serving the Control UI;
* future static or plugin-owned content;
* future capability-specific routes where WebSocket RPC is unsuitable.

WebSocket is the primary control protocol for:

* requests;
* responses;
* server-push events;
* streaming runtime updates.

### 7.3 Protocol envelopes

The protocol uses three frame families:

```text
req
res
event
```

A request contains:

* request ID;
* method;
* params.

A response contains:

* matching request ID;
* success payload or structured error.

An event contains:

* event name;
* payload;
* optional sequence metadata.

Protocol schemas are runtime contracts. TypeBox schemas are the source of truth, AJV performs validation, and TypeScript types are inferred from the schemas.

Unvalidated external data must not enter application modules.

### 7.4 Connection handshake

The first valid client request must be `connect`.

The handshake negotiates at least:

* minimum protocol version;
* maximum protocol version;
* client identity metadata;
* client mode.

The successful response may include:

* selected protocol version;
* Gateway identity;
* health snapshot;
* available capabilities;
* supported methods or feature flags;
* future role and scope metadata.

V1 does not require remote device pairing, signatures, or granular scopes, but the handshake must not make those additions impossible.

Protocol violations during handshake may close the connection instead of fabricating normal RPC responses.

### 7.5 Event sequencing and refresh

Gateway events are an observable stream, not the durable source of truth.

Clients must be able to detect a sequence gap and refresh relevant state through RPC.

The architecture must not require the Gateway to replay every missed event.

Durable state belongs to stores; events notify clients that state changed.

### 7.6 Idempotency and duplicate requests

Methods with side effects must eventually support an idempotency key or equivalent deduplication contract.

This is required for safe client retry after reconnect or uncertain delivery.

Read-only methods do not require persistent deduplication.

### 7.7 Capability discovery

The Gateway handshake or a dedicated RPC should expose the capabilities available to the connected client.

Potential capabilities include:

* Gateway methods;
* event families;
* agent runtimes;
* model providers;
* tools;
* browser availability;
* future node commands;
* future plugin-provided surfaces.

V1 may return a minimal static capability snapshot.

### 7.8 Future roles

The initial client modes are local Control UI and CLI.

The protocol must leave room for future roles such as:

* control client;
* channel adapter;
* native companion;
* node;
* automation client.

Role-specific capabilities must be explicit rather than inferred from transport.

---

## 8. Agent definition and ownership

An agent is a configured runtime identity, not only a string ID.

Conceptually an `AgentDefinition` owns:

```text
agentId
display identity
workspace
agent state directory
session store namespace
credential references
model defaults
agent harness policy
tool policy
sandbox policy
skills and bootstrap resources
```

V1 has one `primary` definition.

Future agents and delegates must use separate:

* workspaces;
* credentials;
* session namespaces;
* policy;
* runtime state.

A delegate must act under its own identity and permissions rather than impersonating the principal user.

---

## 9. Agent Runtime architecture

### 9.1 Runtime facade

`src/agents/` owns the application-facing Agent Runtime facade.

The facade accepts a transport-neutral run request and emits structured runtime events.

Gateway code calls the facade. Gateway code must not implement the agent loop.

### 9.2 Agent harness

An Agent Harness owns one prepared model-driven loop.

A harness is responsible for:

* receiving prepared run input;
* driving model output;
* handling native tool calls;
* producing runtime events;
* returning the completed turn result.

Conceptual contract:

```ts
interface AgentHarness {
  readonly id: string;

  supports(input: HarnessSelectionInput): boolean;

  run(
    request: AgentHarnessRequest,
  ): AsyncIterable<AgentRuntimeEvent>;
}
```

V1 has one built-in harness.

Future harnesses may include:

* a Codex-backed harness;
* a plugin-provided harness;
* a provider-specialized harness.

### 9.3 Harness registry and selection

Harness selection is separate from model-provider selection.

The Agent Runtime uses a Harness Registry to:

* register available harnesses;
* resolve an explicit harness ID;
* apply an `auto` selection policy;
* validate provider-route compatibility;
* manage harness lifecycle.

A provider name alone must not implicitly become a harness contract.

### 9.4 Run and attempt loop

A run is serialized per session in V1.

The runtime flow is:

```text
accept run
→ resolve agent and session
→ acquire per-session run lane
→ load transcript and resources
→ assemble context
→ select harness and model route
→ start attempt
→ request model output
→ execute approved tool calls
→ append transcript/runtime state
→ repeat until completion
→ publish final result
→ release run lane
```

An attempt may fail and be replaced by another attempt because of:

* provider failure;
* retry policy;
* context overflow;
* compaction;
* model fallback;
* harness recovery.

### 9.5 Context assembly

`src/context/` owns context preparation.

Context may include:

* system rules;
* agent identity;
* workspace bootstrap files;
* skills;
* session transcript;
* tool definitions;
* attachments;
* runtime metadata;
* policy-derived instructions;
* accumulated session notices.

Context assembly must remain separate from provider transport.

### 9.6 Compaction and runtime hooks

The architecture reserves explicit hooks for:

* before context assembly;
* context pruning;
* before compaction;
* compaction instructions;
* after compaction;
* before model request;
* after model response;
* before tool call;
* after tool result;
* run completion and failure.

V1 may implement only the hooks needed by active slices.

Compaction must not be hidden inside the Gateway or model provider.

### 9.7 Runtime events

The runtime emits structured events such as:

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

The Gateway translates or forwards these events to clients.

---

## 10. Model runtime and providers

`src/models/` owns model resolution and provider transport.

The model layer is distinct from the Agent Harness.

It owns:

* provider registry;
* model catalog;
* model resolution;
* credentials lookup;
* request normalization;
* provider-specific parameters;
* streaming transport;
* usage metadata;
* provider error normalization;
* future provider failover.

Agent Runtime depends on model contracts, not provider SDKs.

A prepared model-runtime snapshot may be built per agent and replaced atomically when configuration, credentials, or plugins change.

V1 may implement one provider and one published runtime snapshot.

---

## 11. Sessions and transcripts

### 11.1 `SessionStore`

`SessionStore` owns session index and routing metadata.

A session entry includes at least:

```text
sessionKey
sessionId
agentId
createdAt
updatedAt
```

Future metadata may include:

* title;
* channel binding;
* workspace reference;
* model override;
* harness override;
* pinning;
* session-surface metadata.

### 11.2 `SessionResolver`

The resolver converts routing input into a canonical session key and resolves or creates the session entry.

Gateway clients and channels do not construct session persistence records directly.

### 11.3 `TranscriptStore`

`TranscriptStore` owns ordered transcript entries by `sessionId`.

Transcript entries may include:

* user messages;
* assistant messages;
* tool calls;
* tool results;
* compaction entries;
* structured notices;
* future custom runtime state.

Session index and transcript storage are separate abstractions even if both use SQLite.

### 11.4 Transcript safety

Future transcript-history APIs must not automatically expose every raw internal field.

History surfaces may require:

* pagination;
* size limits;
* credential-like text filtering;
* internal scaffolding removal;
* capability checks.

---

## 12. Tool Runtime

The Tool Runtime owns:

* tool contracts;
* parameter schemas;
* Tool Registry;
* tool lookup;
* policy evaluation;
* approval coordination;
* execution lifecycle;
* timeout and cancellation;
* result normalization;
* before and after tool hooks.

Agent Runtime must not import concrete filesystem, shell, browser, platform, or MCP implementations.

Tool implementations may come from:

* built-in tools;
* platform adapters;
* Browser Runtime;
* MCP clients;
* future plugins.

---

## 13. Policy, approval, and sandbox

Policy is an enforcement boundary, not only prompt text.

Every side-effecting tool call must receive a decision:

```text
allow
deny
require-approval
```

Policy input may include:

* agent ID;
* session key;
* run ID;
* tool name;
* validated arguments;
* workspace;
* platform;
* client origin;
* requested side effect;
* configured capability tier.

Future multi-agent and delegate configurations may assign different policies per agent.

Sandboxing is separate from policy:

* policy decides whether an action may run;
* sandboxing constrains how it runs.

V1 may use host execution with strict policy and limited tools before adding stronger sandbox backends.

---

## 14. Platform boundary

`src/platform/` owns operating-system-specific behavior.

Core runtime modules must not directly depend on:

* `systemctl`;
* `apt`;
* `/proc`;
* Linux service semantics;
* Windows PowerShell;
* Windows Service Manager;
* hard-coded platform-specific paths.

Conceptual implementations include:

```text
LinuxPlatform
WindowsPlatform
MacOSPlatform
```

V1 implements Linux only.

Platform capabilities may expose structured operations such as:

* process inspection;
* service status and restart;
* package information;
* filesystem metadata;
* shell process management.

---

## 15. Browser Runtime

`src/browser/` is an independent runtime boundary.

It owns:

* browser provider lifecycle;
* browser sessions;
* tabs and pages;
* observations;
* element references;
* navigation state;
* screenshots and artifacts;
* browser-specific error normalization.

The Agent Runtime accesses browser behavior through registered browser tools or a Browser Provider contract.

The initial provider may wrap an external implementation such as Playwright MCP.

The core must not depend on Playwright-specific references or selectors.

Observation and reference validity must be explicit. Navigation or state-changing actions may invalidate prior references.

---

## 16. Plugin and extension architecture

### 16.1 Manifest as control plane

A future plugin manifest is metadata and must be readable without executing plugin runtime code.

It may describe:

* plugin identity;
* version;
* declared capabilities;
* configuration schema;
* activation metadata;
* setup metadata;
* catalog or UI metadata;
* entrypoints.

### 16.2 Runtime module as data plane

The runtime module registers executable behavior such as:

* tools;
* hooks;
* model providers;
* agent harnesses;
* channels;
* Gateway methods;
* HTTP routes;
* services;
* skills or resource loaders.

### 16.3 One-way registry model

The registration flow is:

```text
plugin or built-in module
→ registers capabilities
→ Plugin Registry
→ core runtimes consume registry
```

Core modules must not special-case individual plugins.

V1 uses static registration of built-in capabilities but should follow the same direction.

### 16.4 Public SDK boundary

Future extensions must not import arbitrary `src/**` internals.

They may depend only on:

* published contracts;
* stable SDK entrypoints;
* runtime helpers intentionally exposed by the host.

This allows internal modules to evolve without breaking extensions.

### 16.5 Discovery and safety gates

Dynamic plugin discovery is deferred.

When added, candidate code must be rejected before execution when it violates path, ownership, or trust requirements.

Loading untrusted code is not equivalent to registering a data-only skill.

---

## 17. Control UI and session surfaces

### 17.1 Control UI

The Control UI communicates with the Gateway through the Gateway protocol.

It may consume Gateway HTTP routes for static content but must not import backend implementation modules.

### 17.2 Session surfaces

A session may have multiple presentation surfaces.

V1 provides the transcript/chat surface.

A future dashboard or board is a presentation face of the same logical session, not a separate agent or conversation.

Presentation state may attach to `sessionKey` rather than `sessionId`, allowing transcript reset while persistent session-level surfaces remain.

### 17.3 Sandboxed agent-authored content

Future agent-authored widgets or applications must run in a sandboxed content boundary.

Access to host capabilities must be declared and granted explicitly, such as:

* data reads;
* allowlisted actions;
* sending a prompt to the session;
* network origins.

The Control UI shell remains native application code; only untrusted or agent-authored content is sandboxed.

---

## 18. Multi-agent routing and delegates

Multi-agent routing is deferred but must not require a new session or policy architecture.

A future router may select an agent using:

* channel;
* account;
* peer or conversation;
* workspace;
* explicit client request;
* task type.

Each agent owns isolated:

* identity;
* workspace;
* credentials;
* session namespace;
* policy;
* sandbox configuration;
* model and harness defaults.

Delegates act under their own account and identity with least-privilege permissions.

No agent may silently share another agent's credential store or writable workspace.

---

## 19. Storage and migrations

`src/storage/` owns concrete persistent infrastructure.

Domain modules depend on store contracts rather than SQLite.

SQLite is the initial storage engine.

Every persistent schema change requires a versioned migration recorded in `schema_migrations`.

Rules:

* do not modify a migration after it has run on persistent user data;
* add a new migration for each schema change;
* apply migrations transactionally where supported;
* keep domain mapping outside Gateway handlers;
* test migrations against an in-memory database;
* close storage after Gateway and active runtime resources stop.

---

## 20. Events, logs, and audit

### 20.1 Technical logs

Pino logs provide technical diagnostics.

Logs may include:

* module;
* connection ID;
* agent ID;
* session key;
* run ID;
* attempt ID;
* tool call ID;
* error metadata.

Secrets and raw credentials must not be logged.

### 20.2 Application events

Application events describe observable system behavior and may be persisted or streamed.

They are not replaced by logs.

### 20.3 Audit

Actions with side effects should eventually produce an audit record containing:

* actor or agent;
* session and run;
* capability invoked;
* policy decision;
* approval result;
* normalized action summary;
* completion status.

Transcript, event history, and audit records are related but distinct.

---

## 21. Lifecycle and composition

`src/bootstrap/` is the composition root.

Only bootstrap creates concrete implementations and connects them.

Expected startup order:

```text
load and validate config
→ initialize logger
→ open storage
→ apply migrations
→ construct agent definitions
→ construct registries
→ construct providers and stores
→ publish model runtime snapshot
→ construct Agent Runtime
→ construct Gateway
→ start Gateway
```

Expected shutdown order:

```text
stop accepting new Gateway work
→ close client connections
→ cancel or drain active runs
→ stop browser and plugin services
→ stop providers
→ close storage
→ flush final logs
```

No domain module may import bootstrap.

---

## 22. Dependency direction

Allowed high-level direction:

```text
index
→ bootstrap
→ concrete infrastructure and application modules
```

Runtime dependencies:

```text
Gateway
→ application-facing Agent Runtime and domain services

Agent Runtime
→ agent definitions
→ sessions and transcripts contracts
→ context
→ harness registry
→ model contracts
→ tool runtime
→ event sink

Tool Runtime
→ policy
→ tool contracts
→ registered tool implementations

Concrete stores
→ domain types
→ storage infrastructure

UI
→ Gateway protocol only
```

Forbidden dependencies include:

```text
sessions → gateway
models → gateway
browser → agent runtime
platform → agent runtime
policy → gateway transport
domain modules → bootstrap
UI → backend implementation
plugins → arbitrary src/** internals
Gateway handlers → SQLite
```

Cross-module imports must reflect ownership rather than convenience.

---

## 23. Current repository foundation

The current repository already contains initial implementations for:

```text
src/bootstrap/
src/config/
src/gateway/
src/sessions/
src/storage/
```

The current foundation includes:

* application startup and shutdown lifecycle;
* centralized config loading;
* HTTP Gateway health endpoint;
* WebSocket Gateway;
* request, response, and event schemas;
* protocol version negotiation;
* connect handshake;
* Gateway method schema registry;
* Gateway handler registry;
* TypeBox and AJV runtime validation;
* session entry and session key concepts;
* session resolver and SessionStore contracts;
* TranscriptStore contract and in-memory implementation;
* SQLite SessionStore implementation;
* versioned database migration foundation;
* unit and Gateway integration tests.

Empty or reserved roots such as `agents`, `browser`, `context`, `models`, `platform`, `plugins`, and `policy` represent planned module boundaries, not completed implementations.

Architecture documentation must not claim that a reserved module is implemented until code and tests exist.

---

## 24. Deferred capabilities

The following are explicitly deferred:

* remote Gateway exposure;
* authentication and device pairing;
* remote nodes;
* messaging channels;
* multi-agent routing;
* delegate agents;
* dynamic plugin discovery and installation;
* plugin marketplace;
* multiple model providers;
* multiple agent harnesses;
* compaction;
* persistent event store;
* full audit store;
* strong sandbox backend;
* dashboard boards and widgets;
* Windows and macOS implementations;
* distributed or background worker execution.

Deferred does not mean architecturally forbidden.

Each capability should be added through the boundaries defined above.

---

## 25. OpenClaw alignment and intentional differences

`my-agent-v2` aligns with the following concepts:

* one long-lived Gateway control plane;
* typed WebSocket requests, responses, and server-push events;
* connect handshake and protocol negotiation;
* Gateway capability discovery and future client roles;
* an Agent Runtime separate from Gateway transport;
* agent harness registry and selection;
* model/provider transport separate from harness selection;
* attempt-loop, context, compaction-hook, and tool boundaries;
* separation of session routing metadata and transcript history;
* registry-based plugin architecture;
* manifest control plane and runtime data plane;
* Control UI as a Gateway client;
* session-attached presentation surfaces;
* per-agent workspace, credentials, policy, and session ownership;
* local-first modular-monolith organization.

`my-agent-v2` intentionally starts smaller by omitting:

* messaging-provider ownership;
* remote access;
* node pairing;
* granular scopes;
* dynamic plugin loading;
* multiple agents;
* multiple harnesses;
* multiple provider routes;
* dashboard widgets;
* compaction;
* broad configuration surfaces.

Alignment means preserving compatible concepts and extension seams, not copying all OpenClaw source code or behavior.

---

## 26. Architecture governance

A change requires an ADR when it:

* reverses a dependency direction;
* merges two boundaries declared separate here;
* changes durable identity semantics;
* changes Gateway frame or handshake semantics;
* exposes new plugin-facing public contracts;
* changes storage ownership;
* allows external modules to import internal implementation;
* introduces a second process or distributed component;
* changes per-agent isolation;
* changes policy or approval authority.

Execution plans may refine implementation details but must not silently redefine these invariants.

Codex CLI and the repository harness should treat violations as plan blockers and request an ADR before implementation.
