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
* retain explicit curated memory across sessions;
* execute model-driven agent runs;
* read and modify files;
* execute shell and platform operations;
* control a browser;
* enforce policy and approval before side effects;
* record structured runtime events;
* retain clear per-run execution evidence for development, verification, and debugging;
* expand later to additional platforms, agents, channels, runtimes, and plugins.

### 2.1 Initial constraints

The first production-capable version targets:

* one trusted local user;
* Linux;
* one primary agent;
* one active serialized run per session;
* one local Gateway;
* local persistent storage;
* one curated-memory tier using SQLite FTS5;
* one initial model provider;
* one initial agent harness;
* one initial browser provider;
* manual updates;
* minimal configuration.

These are scope constraints, not permanent architectural assumptions.

The design must not make it necessary to rewrite the Gateway, Agent Runtime, session or memory model, or tool contracts when adding:

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
├── memory/
├── platform/
├── plugins/
├── policy/
├── sessions/
├── storage/
└── usage/
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
     ┌────┴────┐         ▼       ┌──────┴──────┐
     ▼         ▼      Providers   ▼             ▼
 Sessions    Memory             Platform      Browser
Transcripts Runtime              Tools         Runtime

Cross-cutting boundaries:

Config
Policy and Approval
Events
Storage
Plugin Registry
Workspace
Agent Definition
Memory Retrieval
Observability and Run Journal
Usage Accounting and Cumulative Budgets
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

An agent is a configured, versioned runtime identity, not only a string ID.

### 8.1 Agent definition and revision

Conceptually an `AgentDefinition` owns or selects:

```text
agentId
display identity
agent-definition revision
workspace
agent state directory
session store namespace
memory namespace and recall policy
credential references
model and harness defaults
tool policy
sandbox policy
prompt profile and resource catalog
versioned resource definitions
availability and bootstrap state
```

V1 has one `primary` definition. `primary` is the configured default, not a global singleton.

Every run freezes one immutable `ResolvedAgentSnapshot` containing the effective agent revision, workspace, model route, harness selection, typed resources, prompt profile, tool/policy/sandbox fingerprints, and memory retrieval configuration. Configuration changes publish a new revision for later runs and do not mutate an active run.

An omitted `agentId` may resolve to `primary`. An explicitly unknown, disabled, or unavailable agent fails with a typed error and does not silently fall back.

### 8.2 Agent resources

Agent resources are typed by role and mutability rather than inferred only from filenames.

V1 roles are:

```text
operating-rules
personality-guidance
identity
user-profile
capability-guidance
tool-guidance
bootstrap
skill
knowledge
```

V1 mutability classes are:

```text
host-managed
user-managed
agent-writable-with-approval
generated
```

A resource definition includes an ID, role, resolved path or loader, required flag, mutability, precedence, context-inclusion policy, size limit, and content hash.

Names such as `IDENTITY.md`, `USER.md`, `TOOLS.md`, and `BOOTSTRAP.md` may be conventions. The repository root `AGENTS.md` remains development/harness guidance and is not automatically a production agent resource.

Host safety and policy instructions precede agent operating rules, identity, tool/capability guidance, user profile, task resources, memory, transcript projection, and current user input. The precedence policy is versioned and represented in Context Manifest and Prompt Plan. Prompt position guides the model but never replaces Tool Registry, Policy Engine, validated identity, or store authority.

Required safety, operating-rules, and identity resources are never silently truncated. Optional skills and knowledge may use a declared deterministic truncation policy with evidence.

### 8.3 Availability and bootstrap

Agent availability and bootstrap progress are separate:

```text
AgentAvailability = ready | disabled | unavailable
AgentBootstrapState = pending | running | completed | failed
```

Availability controls admission of new runs. Bootstrap state records explicit onboarding or first-run preparation. Bootstrap completion or failure is journaled and source resources are not silently deleted.

Ordinary model/tool execution cannot silently rewrite identity, operating rules, tool policy, sandbox policy, or model route. A future management operation must pass policy and approval, update atomically, publish a new revision, and produce Run Journal evidence.

Future agents and delegates must use separate workspaces, credentials, session and memory namespaces, policy, resources, and runtime state. A delegate acts under its own identity and permissions rather than impersonating the principal user.

---

## 9. Agent Runtime architecture

### 9.1 Runtime facade

`src/agents/` owns the application-facing Agent Runtime facade.

The facade accepts a transport-neutral run request, resolves one immutable `ResolvedAgentSnapshot`, and emits structured runtime events.

Gateway code calls the facade. Gateway code must not implement the agent loop.

### 9.2 Agent harness

An Agent Harness executes prepared model-driven steps inside a host-owned attempt pipeline.

A harness is responsible for:

* receiving prepared step input;
* driving one normalized model step;
* translating native tool requests into host-owned tool calls;
* producing normalized runtime observations;
* returning a typed step outcome and progress signals.

Conceptual V1 contract:

```ts
interface AgentHarness {
  readonly id: string;

  supports(input: HarnessSelectionInput): boolean;

  executeStep(
    request: PreparedHarnessStep,
  ): Promise<HarnessStepOutcome>;
}
```

A Harness does not privately continue, retry, fall back, or terminalize the run. Every additional cycle is authorized by Agent Runtime `CheckpointStage`.

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

A run is serialized per session in V1. Each logical session has a bounded reject-new FIFO queue: queue admission succeeds before acceptance, and accepted prompts are never merged, evicted, or silently dropped.

The V1 runtime uses a fixed stage pipeline:

```text
accept run
→ resolve agent definition, availability, and immutable ResolvedAgentSnapshot
→ resolve session
→ acquire per-session run lane and runtime permits
→ RunSetupStage
→ AttemptSetupStage
→ ContextStage
→ ModelStage: reserve usage → mark dispatch → provider call → settle/release/uncertain
→ ToolStage when requested
→ ObserveStage
→ CheckpointStage
   ├─ continue → ModelStage
   ├─ retry-attempt → terminalize attempt → AttemptSetupStage
   └─ complete | fail | cancel → terminalize attempt → FinalizeStage
→ publish the terminal result after required durable writes
→ release the session lane
```

Stages return typed outcomes and progress signals. Hooks cannot reorder the pipeline or privately continue it.

`CheckpointStage` is the sole authority for:

```text
continue
complete
retry-attempt
cancel
fail
```

It evaluates cancellation, elapsed time, iteration/model/tool budgets, cumulative usage reservation/settlement outcomes, context/token pressure, pruning and token-measurement outcomes, normalized model and tool outcomes, side-effect safety, retryability, and repeated no-progress fingerprints. `ContextStage` performs only the permitted deterministic reductions; overflow afterward is reported as `CONTEXT_BUDGET_EXCEEDED_AFTER_PRUNING`. Any retry or future compaction must return through an explicit checkpoint decision. Exact thresholds and measurement policies are configuration recorded in the Run Manifest.

`FinalizeStage` runs exactly once for completion, failure, timeout, and cancellation. It performs required output normalization, transcript/provider-continuation commits, a best-effort bounded session runtime summary projection, terminal Run Journal evidence, terminal event publication, cleanup, and guaranteed lane release. It cannot call the model or start new tool side effects.

An attempt may fail and be replaced by another attempt because of:

* provider failure;
* retry policy;
* context overflow;
* compaction;
* model fallback;
* harness recovery.

### 9.5 Context assembly and Prompt Plan

`src/context/` owns context preparation.

The V1 pipeline runs for each model call:

```text
resolve typed sources and bounded canonical tool/artifact representations
→ build ContextManifest
→ reconstruct complete structural exchange groups
→ build versioned PromptPlan (`main-v1`)
→ estimate full request pressure including tools, attachments, output, and thinking reserves
→ protect current/recent groups and apply deterministic soft pruning when needed
→ obtain bounded exact model-route token count near the warning threshold
→ enforce section and total budgets
→ render immutable PreparedModelContext
→ validate
→ apply provider projection
```

Inputs come from immutable agent snapshot, canonical stores, and validated run request: safety/policy instructions; operating rules, personality, and identity; tool/capability guidance plus independently resolved tool schemas; user profile; bounded memory recall; bootstrap, skills, and knowledge; transcript; attachments; runtime notices; and provider continuation.

`ContextManifest` records resolved sources, provenance, roles, precedence, mutability, hashes, sizes, and transformations.

`PromptPlan` records exact ordered semantic sections, prompt profile/version, section/source IDs, authority, trust, required status, stability, budget class, renderer/transformation versions, hashes, and inclusion decisions.

V1 has one explicit profile, `main-v1`. Prompt mode is not inferred from session key, origin, provider, or Harness. Task/minimal/delegate profiles are deferred.

`PreparedModelContext` is structured rather than one prompt string. System/developer sections, conversation turns, tool definitions, attachments, and continuation remain distinct until provider projection.

Resource IDs and prompt section IDs are distinct. Prompt order and primacy guide the model but do not create authorization.

Trust classes are:

```text
trusted-instruction
managed-context
untrusted-data
```

Untrusted labels, filenames, web content, browser observations, attachment text, and tool output are delimited, bounded, normalized, and cannot create sections, schemas, policy rules, or capability grants.

Transcript is reconstructed into complete structural exchange groups. Invalid durable structure fails rather than being silently repaired.

Protected safety, operating-rules, identity, and required tool-contract sections fail when they cannot fit. Optional/bounded sections may be skipped or deterministically truncated only with versioned Run Journal evidence.

Provider projection consumes immutable `PreparedModelContext`, preserves semantic ordering and required-section decisions, and combines owned continuation without rewriting transcript history.

V1 context pruning is enabled and non-destructive. Tool Runtime keeps large original payloads in owned artifact storage and exposes a bounded canonical result; later model calls may head-tail trim eligible old tool, media, or browser results while preserving hashes and artifact references. Current input, current tool cycle, required continuation, protected Prompt Plan sections, and recent complete structural exchange groups are never split.

Hard clear is disabled by default and may later be enabled only for durable artifact-backed results that can be explicitly re-read. Normal user/assistant conversation is not silently removed. If permitted reductions cannot fit the request, context preparation fails; it does not auto-compact. Local token estimates are versioned, and the selected model route may provide exact preflight counting near configured limits.

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

V1 implements context-pruning hooks needed by the active model/tool loop. Compaction hooks remain reserved and may be inert until durable compaction is designed.

Compaction must not be hidden inside the Gateway or model provider.

### 9.7 Runtime events

The runtime emits structured events such as:

```text
run_queue.admitted
run.accepted
run.started
agent.snapshot.resolved
agent.resource.loaded
agent.resource.skipped
agent.resource.rejected
agent.resource.truncated
memory.retrieval.started
memory.retrieval.completed
memory.selection.completed
memory.write.requested
memory.write.completed
memory.write.failed
agent.bootstrap.started
agent.bootstrap.completed
agent.bootstrap.failed
attempt.started
stage.started
transcript.batch.committed
history.selection.completed
context.prepared
model.requested
model.delta
model.completed
tool.requested
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
* provider continuation preservation;
* normalized provider usage and billing certainty;
* provider error normalization;
* future provider failover.

Agent Runtime depends on model contracts, not provider SDKs. Provider adapters receive immutable structured `PreparedModelContext` plus Prompt Plan identity/hashes; they do not rediscover files or assemble an alternative prompt.

A prepared model-runtime snapshot may be built per agent and replaced atomically when configuration, credentials, or plugins change.

### 10.1 Initial Gemini route

V1 uses:

```text
provider: Gemini Developer API
SDK: @google/genai
API: Interactions API
authentication: API key
model: gemini-3.5-flash
store: false
```

The model ID is pinned; V1 does not use `gemini-flash-latest`.

V1 uses native Gemini transport rather than the OpenAI-compatible endpoint. The Gemini adapter owns typed Interactions steps, streaming, function-call/result mapping, thinking configuration, usage mapping, cancellation, provider errors, and opaque continuation metadata.

The API key is resolved only in trusted backend infrastructure and never enters transcript, Gateway payloads, logs, Run Journal payloads, or debug artifacts.

V1 does not use Vertex AI, provider-hosted conversation state, or `previous_interaction_id`. Local `SessionStore`, `TranscriptStore`, context assembly, and provider-continuation sidecars remain the state authority. Provider interaction IDs are correlation metadata only.

Gemini prompt caching is provider-managed and implicit only. `PromptPlan` keeps the agent-revision-stable prefix deterministic, but the adapter does not reorder semantic sections for cache optimization. V1 creates no explicit provider cache object, stores no provider cache ID, and does not change `store=false` or local transcript authority. Provider-reported cached-token usage is normalized and journaled when available; cache hits and misses are both valid.

### 10.2 Provider continuation

Stateless multi-step Gemini requests may require exact provider-returned typed steps or thought signatures.

The adapter and transcript/context boundaries must preserve this opaque continuation exactly, including ordering and association with the originating provider step or content part.

Opaque continuation:

* is not normal user-visible transcript content;
* is not private chain-of-thought exposed to the host;
* is not copied into ordinary logs, events, journals, or artifacts;
* is persisted only when required for later stateless replay;
* is represented in observability by counts, hashes, references, and validation status.

Missing required continuation fails explicitly as incompatible model history. V1 does not silently collapse tool cycles, fabricate signatures, or rewrite history during ordinary context projection.

V1 implements one provider and one published runtime snapshot. Additional providers, model fallback, server-side Gemini state, and alternate API surfaces are deferred.

### 10.3 Usage accounting and cumulative budgets

`src/usage/` owns durable model-call accounting and operator-configured cumulative token/cost caps.

The model-call path is:

```text
prepare exact provider/model route and candidate request
→ calculate bounded reservation estimate
→ UsageBudgetGate atomically reserves all matching cap headroom
→ persist dispatch marker
→ call provider
→ normalize actual usage and billing certainty
→ settle, release, or mark uncertain
→ CheckpointStage consumes the outcome
```

Usage accounting remains enabled with no cap configured. `UsageLedgerStore` is the accounting and enforcement authority; Run Journal records references and decisions only.

V1 cap scopes are global, agent, provider, and exact model. Windows are UTC day and UTC month. Metrics are provider total tokens and configured cost in integer micros. Every matching enabled policy applies.

Versioned operator price records calculate cost outside the provider adapter. Unknown price remains unknown, never zero. A matching cost cap fails closed when no compatible price revision exists.

Reservation check and insert are one short SQLite transaction. Provider network I/O occurs only after commit and outside the transaction. Dispatch is marked durably before network I/O. Actual provider usage replaces the estimate when known.

A post-dispatch timeout or disconnect with unknown billing becomes an `uncertain` reservation and continues to consume headroom until explicit reconciliation. Settlement failure does not cause provider replay.

Run-local model-call/iteration budgets, runtime concurrency permits, provider rate limits, and local cumulative caps remain separate controls.

V1 does not implement per-user/channel request quotas, invoices, payments, tenant plans, distributed counters, or automatic provider-billing reconciliation.

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

* bounded `SessionRuntimeSummary` projection for the most recent finalized run;
* title;
* channel binding;
* workspace reference;
* model override;
* harness override;
* pinning;
* session-surface metadata.

### 11.2 `SessionResolver`

The resolver accepts a typed `SessionRoute`, validates its components, converts it into a canonical session key, and resolves or creates the session entry.

V1 route fields include `agentId`, a supported surface such as `main`, `web`, or `cli`, and an optional validated conversation ID. Gateway clients and channels do not construct canonical keys or session persistence records directly.

### 11.3 `TranscriptStore`

`TranscriptStore` owns ordered transcript entries by `sessionId`.

Every entry has an opaque `entryId` and a store-assigned monotonic `sequence` scoped to that transcript. `(sessionId, sequence)` is the authoritative order; timestamps are metadata.

Transcript entries may include:

* user messages;
* assistant messages;
* tool calls;
* tool results;
* compaction entries;
* structured notices;
* future custom runtime state.

A model exchange may carry provider continuation sidecar metadata, such as Gemini typed steps or thought signatures required for later stateless requests. This metadata is associated with transcript/model-exchange records but omitted from normal history surfaces.

Structurally related entries are appended through atomic batches with expected-tail validation and one contiguous sequence range. Tool request/result pairs and required provider continuation commit together or not at all.

History reads are bounded and use opaque cursors bound to `sessionId` and sequence position. A cursor does not cross a reset into the new current `sessionId`.

Session index and transcript storage are separate abstractions even if both use SQLite.

### 11.4 Session runtime summary

A bounded `SessionRuntimeSummary` may expose the last finalized run ID/status, exact model ID, token and tool counts, duration, transcript count, terminal transcript head sequence, and last checkpoint outcome for UI and diagnostics. Measurements are marked `exact` or `unknown`; evidence surfaces do not present heuristic token estimates as exact values.

It is a best-effort projection updated by `FinalizeStage`, not a transcript, Run Journal, or terminal-state authority. Failure is journaled as degraded projection and does not erase an otherwise durable run outcome. It contains no raw model/tool payloads, thought signatures, or credentials.

### 11.5 Transcript safety

Future transcript-history APIs must not automatically expose every raw internal field.

History surfaces may require:

* opaque cursor reads and tail limits;
* structural exchange-group validation;
* size limits;
* credential-like text filtering;
* internal scaffolding removal;
* capability checks.

---

## 12. Memory Runtime

`src/memory/` owns durable cross-session memory contracts, retrieval, mutation rules, and memory-specific validation.

Memory is distinct from:

```text
Transcript        ordered history of one transcript instance
Agent resources   versioned identity, rules, user profile, skills, and managed inputs
Run Journal       evidence of how one run executed
Memory            selected knowledge intended for reuse across future runs or sessions
```

### 12.1 V1 scope

V1 implements one **durable curated-memory tier** backed by SQLite.

It supports:

* explicit memory creation, supersession, deletion, listing, and search;
* per-agent ownership and isolation;
* typed memory kinds;
* provenance and confidence metadata;
* revision and status history;
* SQLite FTS5 text search;
* bounded recall into model context;
* Run Journal evidence for retrieval and mutation;
* explicit manual clear and purge operations.

V1 does not implement automatic episodic summaries, vector embeddings, a semantic knowledge graph, background consolidation, dreaming workers, passive channel extraction, or automatic memory flush during compaction.

### 12.2 Memory entry model

A memory entry includes at least:

```text
memoryId
agentId
kind
content
status
confidence
source references
content hash
validFrom
optional validUntil
optional supersedesMemoryId
createdAt
updatedAt
```

V1 memory kinds may include:

```text
fact
preference
decision
project
person
procedure
reminder
note
```

Status is explicit:

```text
active
superseded
deleted
```

Confidence distinguishes at least:

```text
explicit   directly requested or stated by the user
inferred   proposed by the agent from evidence
```

Memory is not overwritten in place when its meaning changes. A replacement creates a new entry and marks the previous entry as superseded so earlier runs remain explainable.

Every committed entry retains provenance such as source type, `sessionId`, `runId`, and applicable transcript entry IDs. Raw credentials, authentication tokens, private keys, provider continuation data, private model reasoning, and unrestricted debug payloads are prohibited memory content.

### 12.3 Write authority

Memory mutation is an externally observable side effect.

Model-requested writes must use registered memory tools through the Tool Runtime:

```text
validated memory proposal
→ policy evaluation
→ approval when required
→ Memory Runtime mutation
→ SQLite transaction and index update
→ Run Journal evidence
→ normalized tool result
```

A user-explicit request to remember or forget may be allowed by policy. Agent-inferred memory requires approval by default in V1.

An in-run `MemoryCandidate` is a validated proposal, not committed memory. A persistent candidate review queue and background extraction are deferred.

The Context Assembler, Harness, provider adapter, and CheckpointStage cannot write memory directly. `CheckpointStage` may observe memory-related outcomes and decide loop continuation, but it does not own memory extraction or mutation.

A memory committed during a run does not silently alter that run's already selected recall snapshot. It becomes eligible for later runs.

### 12.4 Retrieval and context injection

Memory retrieval uses an application-facing contract rather than direct SQLite queries.

V1 search uses:

```text
SQLite FTS5
+ exact agent/kind/status filters
+ bounded result count
+ versioned deterministic ranking policy
```

The public contract leaves room for future `vector` and `hybrid` modes, but V1 implements text search only.

At run setup, the Memory Runtime performs at most one normal recall selection for the current user input. The selected results are frozen as a `MemoryRecallSnapshot` for that run. Later model calls in the same run reuse that snapshot unless a future ADR explicitly authorizes dynamic recall.

The immutable `ResolvedAgentSnapshot` contains memory enablement, namespace, search-policy version, and token budget. The `MemoryRecallSnapshot` contains the actual selected memory IDs, revisions, content hashes, scores, and bounded rendered content. Context assembly renders selected memory only as bounded `retrieved-memory` / `managed-context` Prompt Plan sections. `MEMORY.md` is not a canonical prompt injection path.

Context assembly includes memory through a dedicated manifest section after authoritative host/agent instructions and before task transcript content. Memory cannot override host safety, policy, operating rules, or agent identity.

Recall has an explicit token and result budget. Empty or irrelevant searches produce an empty memory section rather than fabricated context.

### 12.5 Reproducibility and evidence

Each retrieval records structured evidence including:

```text
agentId
runId
memory index revision
search-policy version
query hash
search mode
candidate count
selected memory IDs and revisions
selected content hashes
scores or ranking positions
result and token budgets
included token estimate
skip or rejection reasons
```

Each mutation records:

```text
operation ID
memory ID and revision
source/provenance references
policy and approval result
before/after status
content hash
index revision before and after
transaction result
```

Run Journal rows contain IDs, hashes, scores, and decisions rather than unrestricted memory bodies. Redacted content may appear only in authorized debug artifacts under the active capture profile.

The global or per-agent memory index revision advances after committed create, supersede, delete, purge, or rebuild operations. A run records the revision used for recall.

### 12.6 Clear, delete, and retention

Memory deletion is independent from transcript reset, transcript deletion, Run Journal clear, agent-resource updates, and log rotation.

Normal delete preserves status/provenance history where policy permits. Explicit purge or broad clear requires scoped commands, preview, affected-count reporting, confirmation, policy checks, and journal evidence.

V1 does not silently expire or auto-delete memory. Optional future retention or TTL policy requires an explicit decision because it changes what the agent can remember.

### 12.7 Future evolution

Future capabilities may add:

* persisted candidate review queues;
* episodic summaries;
* embedding and hybrid search;
* semantic entities and relations;
* automatic consolidation;
* memory sharing between agents;
* compaction-time memory extraction;
* background workers and retention policies.

They must extend this boundary without turning transcript, agent resources, or Run Journal records into memory aliases.

---

## 13. Tool Runtime

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
* tool execution traits and batch planning;
* progress-signal production for CheckpointStage;
* before and after tool hooks.

Agent Runtime must not import concrete filesystem, shell, browser, platform, or MCP implementations.

Tool implementations may come from:

* built-in tools;
* platform adapters;
* Browser Runtime;
* MCP clients;
* future plugins.

When one model step requests multiple tools, V1 plans the whole batch before I/O. Only registered read-only tools explicitly marked parallel-safe may use bounded parallel execution. Side-effecting, privileged, shell, browser-mutating, unknown, or mixed batches run sequentially. Policy and approvals resolve before parallel I/O, and normalized results are observed in original model-call order.

Tool Runtime returns outcomes and progress signals. It never decides whether the Agent Runtime loop continues.

---

## 14. Policy, approval, and sandbox

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

## 15. Platform boundary

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

## 16. Browser Runtime

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

V1 uses one in-process `PlaywrightBrowserProvider` implemented with the Playwright library in TypeScript/Node.js and controlling Chromium. Playwright MCP, Rod, a Go browser sidecar, and a raw-CDP-first provider are outside the V1 implementation path.

Playwright `CDPSession` may be used only as a narrowly scoped implementation escape hatch for Chromium capabilities not exposed by the normal Playwright API. CDP sessions and values must not appear in core, tool, Gateway, transcript, or Agent Runtime contracts.

The core must not depend on Playwright-specific references, locators, pages, browser contexts, selectors, or CDP identifiers.

Observation and reference validity must be explicit. Navigation or state-changing actions may invalidate prior references.

---

## 17. Plugin and extension architecture

### 17.1 Manifest as control plane

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

### 17.2 Runtime module as data plane

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

### 17.3 One-way registry model

The registration flow is:

```text
plugin or built-in module
→ registers capabilities
→ Plugin Registry
→ core runtimes consume registry
```

Core modules must not special-case individual plugins.

V1 uses static registration of built-in capabilities but should follow the same direction.

### 17.4 Public SDK boundary

Future extensions must not import arbitrary `src/**` internals.

They may depend only on:

* published contracts;
* stable SDK entrypoints;
* runtime helpers intentionally exposed by the host.

This allows internal modules to evolve without breaking extensions.

### 17.5 Discovery and safety gates

Dynamic plugin discovery is deferred.

When added, candidate code must be rejected before execution when it violates path, ownership, or trust requirements.

Loading untrusted code is not equivalent to registering a data-only skill.

---

## 18. Control UI and session surfaces

### 18.1 Control UI

The Control UI communicates with the Gateway through the Gateway protocol.

It may consume Gateway HTTP routes for static content but must not import backend implementation modules.

### 18.2 Session surfaces

A session may have multiple presentation surfaces.

V1 provides the transcript/chat surface.

A future dashboard or board is a presentation face of the same logical session, not a separate agent or conversation.

Presentation state may attach to `sessionKey` rather than `sessionId`, allowing transcript reset while persistent session-level surfaces remain.

### 18.3 Sandboxed agent-authored content

Future agent-authored widgets or applications must run in a sandboxed content boundary.

Access to host capabilities must be declared and granted explicitly, such as:

* data reads;
* allowlisted actions;
* sending a prompt to the session;
* network origins.

The Control UI shell remains native application code; only untrusted or agent-authored content is sandboxed.

---

## 19. Multi-agent routing and delegates

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

## 20. Storage and migrations

`src/storage/` owns concrete persistent infrastructure.

Domain modules depend on store contracts rather than SQLite.

`MemoryStore` and its FTS index are domain-owned contracts implemented by storage adapters. Memory callers do not issue FTS or table queries directly.

`UsageLedgerStore` is a usage-domain contract implemented by storage adapters. It persists model-call reservations, dispatch markers, terminal accounting states, normalized usage, price/policy revisions, and bounded cumulative queries. Run Journal and transcript stores are not accounting substitutes.

SQLite is the initial storage engine.

Every persistent schema change requires a versioned migration recorded in `schema_migrations`.

Transcript persistence enforces unique `(sessionId, sequence)`, supports indexed bounded sequence reads, and commits append batches with expected-tail validation in short transactions. Public history cursors do not expose SQLite offsets or row IDs.

Required Gemini continuation is persisted as versioned, opaque sidecar data. Raw signatures are not indexed or duplicated into logs, journals, Gateway events, or normal history output. The API key is not stored in ordinary application tables.

A process-local `InMemoryDerivedDataCache` may retain rebuildable parsed resources, rendered stable prompt fragments, normalized tool schemas, model capability metadata, and deterministic renderer/sanitizer results. Keys include correctness-relevant revisions, content hashes, and implementation versions. TTL/LRU controls eviction only; a miss or failure recomputes from authoritative sources.

The derived cache never owns policy/approval decisions, current transcripts, session queues, memory writes/recall results, provider continuation, browser state, or credentials. Redis, persistent cache tables, and cross-process invalidation are deferred.

Rules:

* do not modify a migration after it has run on persistent user data;
* add a new migration for each schema change;
* apply migrations transactionally where supported;
* keep domain mapping outside Gateway handlers;
* test migrations, transcript sequences, memory FTS synchronization, usage reservation concurrency/recovery, and store behavior against an in-memory database;
* close storage after Gateway and active runtime resources stop.

---

## 21. Events, logs, Run Journal, and audit

### 21.1 Development-first observability

V1 observability is designed first for architecture development, debugging, verification, and regression evidence.

Every meaningful runtime decision and state transition must be traceable without parsing unstructured log text.

Production may later reduce payload capture through configuration, but it must not replace identity, lifecycle, ordering, or evidence contracts.

### 21.2 Technical logs

Pino logs provide concise technical diagnostics for developers and operators.

Logs may include:

* module;
* connection ID;
* agent ID;
* session key;
* session ID;
* run ID;
* attempt ID;
* model-call ID;
* tool-call ID;
* normalized error metadata;
* bounded timings and sizes.

Secrets, credentials, raw prompts, unbounded tool payloads, and transcript bodies must not be logged by default.

Technical logs may rotate or be cleared independently. They are not the evidence API and must not be parsed by domain code or tests.

### 21.3 Application events

Application events describe observable system behavior and in-process lifecycle coordination.

They are typed and may be streamed to authorized Gateway clients or optional telemetry observers.

Runtime and Gateway events are not durable state and are not replaced by logs.

### 21.4 Run Journal

`RunJournalStore` is the durable, ordered evidence boundary for each Agent Runtime run.

Entries are grouped by:

```text
runId + monotonically increasing per-run sequence
```

A journal records meaningful boundaries such as:

```text
run acceptance and identity resolution
agent revision, availability, bootstrap state, and immutable snapshot resolution
resource loading, rejection, truncation, and precedence decisions
prompt profile, Context Manifest, Prompt Plan, section/budget/trust decisions, stable-prefix hash, and provider-request hashes
context source guards, pruning policy/rules, protected structural range, token measurements before/after reduction, and overflow result
derived-data cache hit/miss/rebuild summary when relevant and provider implicit-cache usage
session-lane queue and acquisition
context preparation
harness and model-route selection
stage start and terminal boundaries
model request and normalized outcome
usage reservation, dispatch marker, cap decision, settlement/release/uncertain outcome, and ledger references
checkpoint signals and decisions
finalization and output-normalization decisions
policy and approval decisions
tool start and terminal outcome
transcript or domain commit summary
attempt and run terminal outcome
```

Each run includes a manifest with build, configuration, `agentId`, immutable `agentRevision`, typed resource-manifest hash and transformations, exact model route, provider API surface and SDK version, provider store mode, harness, tool, policy, sandbox, context, usage, timing, and terminal fingerprints or references.

For Gemini, journal evidence records the Interactions API, `store=false`, provider request/interaction correlation IDs when available, response step types, continuation counts and hashes, persistence validation, normalized finish/status, provider-reported input/output/cached/tool-use/thinking token usage, and that explicit provider cache objects were not used. Usage evidence additionally records reservation/record IDs, matched cap-policy revisions, estimate/measurement rule, price revision, actual normalized usage, derived cost when known, and accounting status without becoming the cumulative ledger. It never stores raw thought signatures or private model reasoning.

The Run Journal is not:

* a transcript;
* a Pino log;
* an audit ledger;
* a general-purpose event store;
* a persistent scheduler or automatic recovery record.

Required journal entries are part of V1 correctness. Successful terminal state is not announced before required transcript/domain and terminal journal writes succeed.

### 21.5 Debug artifacts and capture profiles

Large or sensitive evidence is stored as bounded, redacted debug artifacts referenced from journal entries.

Examples include redacted Context Manifests, Prompt Plans, rendered sections, normalized model requests/responses, tool arguments/results, browser observations, screenshots, and transcript deltas.

V1 supports capture profiles:

```text
development   full structured lifecycle plus redacted debug artifacts
verification  stable evidence needed for export, comparison, and tests
production    lifecycle metadata and errors; payload artifacts off by default
```

Capture profiles change detail and retention, not lifecycle semantics.

Run evidence may be pinned, exported, and compared. Typed journal APIs are the basis for future test and debug loops; tests must not parse Pino text.

### 21.6 Retention and manual clear

Development journals are not silently auto-pruned.

Manual clear is scoped by run, session, or date and supports preview, affected-size reporting, broad-operation confirmation, and pinned-evidence protection.

Session reset, transcript deletion, log rotation, journal clear, usage-ledger retention/reconciliation, and future audit retention are independent operations.

Storage usage and warning or hard-limit state must be visible. Limits do not silently delete evidence. Optional artifact capture may degrade explicitly, while required journal metadata remains fail-closed.

### 21.7 Audit

Actions with side effects should eventually produce a metadata-only audit record containing:

* actor or agent;
* session and run;
* capability invoked;
* policy decision;
* approval result;
* normalized action summary;
* completion status.

Audit is distinct from the development Run Journal. Audit may later require stronger completeness, retention, integrity, and actor guarantees.

Transcript, runtime event, technical log, Run Journal, debug artifact, and audit records are related but distinct.

---

## 22. Lifecycle and composition

`src/bootstrap/` is the composition root.

Only bootstrap creates concrete implementations and connects them.

Expected startup order:

```text
load and validate config
→ initialize logger
→ open storage
→ apply migrations
→ construct agent definitions, typed resource catalog, and snapshot resolver
→ validate initial agent availability and bootstrap state
→ construct registries
→ construct providers, domain stores, MemoryStore/FTS index, UsageLedgerStore, price catalog, and artifact storage
→ recover never-dispatched and unresolved dispatched usage reservations conservatively
→ construct runtime-wide model, tool, and browser budgets
→ publish model runtime snapshot
→ construct Agent Runtime stage pipeline
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
→ flush required Run Journal state
→ close storage
→ flush final logs
```

No domain module may import bootstrap.

---

## 23. Dependency direction

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
→ agent definition and immutable snapshot contracts
→ typed agent resources and context manifests
→ sessions and transcripts contracts
→ memory contracts and frozen recall snapshot
→ context
→ harness registry
→ model contracts
→ tool runtime
→ runtime budget contracts
→ usage accounting and UsageBudgetGate contracts
→ RunJournalStore
→ event sink

Usage Runtime
→ normalized model-usage contracts
→ UsageLedgerStore
→ versioned price and cap-policy configuration
→ RunJournalStore evidence sink

Memory Runtime
→ memory store contracts
→ text-search adapter
→ RunJournalStore

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

## 24. Current repository foundation

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

Empty or reserved roots such as `agents`, `browser`, `context`, `memory`, `models`, `platform`, `plugins`, `policy`, and `usage` represent planned module boundaries, not completed implementations. The immutable `ResolvedAgentSnapshot`, typed agent-resource catalog, `ContextManifest`, versioned `PromptPlan` with `main-v1`, structured `PreparedModelContext`, deterministic tool-result context pruning, revision/hash-keyed in-memory derived-data cache, agent revision/bootstrap lifecycle, `RunJournalStore`, its SQLite adapter, debug-artifact storage, capture profiles, the Gemini `@google/genai` Interactions adapter with implicit prompt-cache evidence, provider-continuation sidecars, and the Usage Runtime with durable reserve/dispatch/settle accounting are accepted V1 architecture but are not implemented until code and tests exist.

Architecture documentation must not claim that a reserved module is implemented until code and tests exist.

---

## 25. Deferred capabilities

The following are explicitly deferred:

* remote Gateway exposure;
* authentication and device pairing;
* remote nodes;
* messaging channels;
* per-user, per-channel, group, hourly, and weekly request quotas;
* invoices, payments, tenant plans, chargeback, and commercial billing;
* distributed usage counters and automatic provider-billing reconciliation;
* multi-agent routing;
* delegate agents;
* agent self-evolution or ordinary-run mutation of identity, rules, policy, or model route;
* dynamic or remote agent-resource management;
* dynamic plugin discovery and installation;
* plugin marketplace;
* multiple model providers;
* multiple agent harnesses;
* compaction;
* additional prompt profiles and automatic prompt-mode selection;
* explicit provider prompt-cache objects or host-managed cache IDs;
* Redis, persistent application caches, and cross-process cache invalidation;
* persistent general-purpose event store and arbitrary event replay;
* full audit store;
* durable run scheduler and automatic crash recovery;
* tamper-evident or compliance-grade evidence storage;
* strong sandbox backend;
* dashboard boards and widgets;
* Windows and macOS implementations;
* distributed or background worker execution.

Deferred does not mean architecturally forbidden.

Each capability should be added through the boundaries defined above.

---

## 26. OpenClaw alignment and intentional differences

`my-agent-v2` aligns with the following concepts:

* one long-lived Gateway control plane;
* typed WebSocket requests, responses, and server-push events;
* connect handshake and protocol negotiation;
* Gateway capability discovery and future client roles;
* an Agent Runtime separate from Gateway transport;
* agent harness registry and selection;
* model/provider transport separate from harness selection;
* provider-specific continuation kept inside provider and transcript/context boundaries;
* attempt-loop, context, compaction-hook, and tool boundaries;
* separation of session routing metadata and transcript history;
* registry-based plugin architecture;
* manifest control plane and runtime data plane;
* Control UI as a Gateway client;
* session-attached presentation surfaces;
* per-agent workspace, credentials, policy, resource, session, and memory ownership;
* versioned agent definitions with explicit context resources and bootstrap lifecycle;
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
* provider-hosted Gemini conversation state;
* dashboard widgets;
* compaction;
* automatic multi-tier memory, embeddings, knowledge graphs, and background consolidation;
* broad configuration surfaces.

Alignment means preserving compatible concepts and extension seams, not copying all OpenClaw source code or behavior.

GoClaw is an additional implementation reference for explicit pipeline stages, checkpoint/finalization boundaries, bounded no-progress guards, conservative tool-batch scheduling, treating an agent as a configured combination of model, context resources, tools, and lifecycle state, separating long-term memory from session history, planning prompt sections from typed sources with explicit order and budgets, non-destructive context pruning, rebuildable application caching, and reserve-then-settle usage caps. `my-agent-v2` adopts those principles selectively while replacing GoClaw's automatic three-tier PostgreSQL/pgvector consolidation topology with a smaller explicit SQLite curated-memory boundary in V1.

---

## 27. Architecture governance

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
* changes agent revision, resource-role, precedence, mutability, or bootstrap authority;
* changes policy or approval authority;
* changes memory ownership, provenance, recall, mutation, retention, or automatic-consolidation authority;
* changes prompt-profile selection, protected-section authority, trust classification, or whether providers/Harnesses may assemble prompts.
* changes usage-ledger authority, price/cap semantics, reservation/settlement ordering, uncertainty handling, or whether provider calls may bypass cumulative budget enforcement.

Execution plans may refine implementation details but must not silently redefine these invariants.

Codex CLI and the repository harness should treat violations as plan blockers and request an ADR before implementation.
