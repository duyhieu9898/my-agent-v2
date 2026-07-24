# ADR 0007: Context Assembly and Transcript Mutation Authority

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

## Context

`my-agent-v2` needs to build model input from several sources without turning the stored conversation transcript into a copy of every runtime instruction, provider adaptation, temporary pruning decision, or retry artifact.

The following concepts are related but not equivalent:

```text
Durable transcript
Runtime context
Provider request projection
```

The durable transcript represents ordered session history. Runtime context is the prepared input for one model call. A provider request projection is a provider-compatible representation of that context.

If these concepts are merged, the system could:

- store hidden system rules as if they were user-authored messages;
- persist provider-specific rewrites into canonical history;
- lose full tool results because an in-memory pruning strategy rewrote the transcript;
- append user input once per retry or attempt;
- let a Harness or provider mutate session history outside the session lane;
- make compaction an invisible provider behavior rather than an explicit durable operation;
- produce a transcript that cannot be replayed consistently by another model route;
- expose internal policy instructions, credentials, or runtime scaffolding through history APIs.

ADR 0003 defines `TranscriptStore` as the owner of ordered entries by `sessionId`. ADR 0005 separates Agent Runtime, Harness, and Model Provider. ADR 0006 requires transcript-affecting operations to follow the per-session lane and requires successful state to be durable before `run.completed`.

OpenClaw currently distinguishes stored transcript history from the context assembled for a model call. Its context engine participates in ingest, assemble, compact, and after-turn lifecycle points. Runtime-only context is kept out of visible user transcript turns. Session pruning changes the in-memory prompt without rewriting the durable transcript, while compaction is a durable operation. Provider-specific transcript hygiene is normally applied while constructing outbound model input rather than rewriting delivered assistant history.

`my-agent-v2` adopts those principles while keeping V1 smaller:

- one built-in context assembler;
- no plugin-provided context engine in V1;
- no automatic compaction in the initial slice;
- no cross-session memory or recall engine;
- no provider-specific durable transcript format;
- no arbitrary transcript-mutating hooks.

## Decision

`src/context/` owns context assembly as a transport-neutral, provider-neutral application boundary.

`TranscriptStore` remains the durable transcript authority. Agent Runtime orchestrates transcript mutation through that contract while holding the applicable session lane. Context assembly, Harnesses, model providers, Gateway handlers, tools, and plugins do not directly mutate the canonical transcript.

The intended flow for each model call is:

```text
load durable transcript snapshot
→ resolve run and agent resources
→ assemble provider-neutral model context
→ apply in-memory pruning and context policy
→ apply provider request projection
→ execute model call
→ normalize model and tool-loop results
→ Agent Runtime appends approved durable transcript entries
```

Context is assembled for each model request, not only once per run. A tool loop may append a tool result and then require a new context snapshot before the next model request.

## Context assembly boundary

The V1 implementation uses a built-in context assembler under `src/context/`.

Conceptually:

```ts
interface ContextAssembler {
  assemble(input: ContextAssemblyInput): Promise<PreparedModelContext>;
}
```

The exact TypeScript contract may evolve, but the boundary is fixed.

The assembler receives explicit, already-resolved inputs. It must not discover ownership from global mutable state or read Gateway transport objects.

Inputs may include:

```text
agentId and resolved agent definition
sessionKey and sessionId
runId and attemptId
current model-call sequence
resolved model route and context limits
transcript snapshot
current user input and attachments
workspace and bootstrap resources
skills snapshot
available tool definitions
policy-derived instructions and notices
runtime metadata
origin and capability metadata
context budget
```

The assembler returns an immutable prepared snapshot for one model request. The snapshot may include:

```text
ordered provider-neutral messages
system and developer instructions
available tool schemas
current-turn attachments
estimated token usage
budget and truncation metadata
resource provenance
context preparation diagnostics
```

The prepared snapshot must not contain mutable store handles or Gateway connection objects.

## Explicit input resolution

Context assembly is a renderer and policy boundary, not the composition root.

The Agent Runtime or dedicated resource loaders resolve live inputs before calling it, including:

- the current transcript snapshot;
- the effective agent definition;
- the current workspace and bootstrap resources;
- the skills available for the run;
- the model context budget;
- the tools visible under the current policy and capability set;
- attachment metadata and hydrated content;
- provider or model prompt contributions allowed by the model contract.

`src/context/` may own reusable resource-loading contracts, but it must not import bootstrap or concrete Gateway implementations.

Configuration-backed prompt options must be resolved for the current agent and passed explicitly. A pure prompt renderer must not read process-global configuration directly.

## Context sources

Context assembly may combine the following source classes:

1. host system rules and execution constraints;
2. resolved agent identity and role instructions;
3. workspace bootstrap resources;
4. enabled skills and task-specific resources;
5. policy and approval instructions;
6. visible tool definitions and usage guidance;
7. durable transcript projection;
8. current user input and attachments;
9. run, origin, platform, sandbox, and capability metadata;
10. model-family or provider prompt contributions allowed by contract.

The exact wording and section order are implementation details until they become externally relied upon. The following invariants are not implementation details:

- user-authored content remains distinguishable from runtime-authored content;
- resource provenance is retained internally;
- policy instructions cannot be silently replaced by provider or Harness contributions;
- unavailable tools are not advertised to the model;
- attachments are included only when valid for the current turn and model capability;
- context sources are bounded by explicit size and token policies;
- sensitive runtime details are not automatically exposed in history or diagnostics.

## Runtime context is not user transcript

Runtime instructions added for a model call are not user-authored transcript entries.

Examples of runtime-only context include:

- system and developer instructions;
- agent identity scaffolding;
- workspace bootstrap injection;
- tool schemas and tool-use guidance;
- policy reminders;
- sandbox and platform notices;
- model-family prompt overlays;
- token-budget notices;
- retry or recovery instructions;
- context-pruning placeholders created only for the outbound request.

The visible user transcript body must preserve what the user submitted after normal input validation and attachment normalization. It must not be replaced by a runtime-enriched prompt body.

History APIs must not expose runtime-only context merely because it was sent to a model.

A future diagnostics surface may report context contributors, sizes, hashes, or a privileged preview. Such diagnostics require filtering and capability checks and are not part of the normal transcript contract.

## Durable transcript authority

`TranscriptStore` is the only durable store contract for canonical transcript entries.

Agent Runtime is the application authority that decides when normalized runtime outcomes become durable transcript entries. It performs those writes through `TranscriptStore` while holding the relevant per-session lane defined by ADR 0006.

The following boundaries do not write directly to the canonical transcript:

```text
Gateway handlers
ContextAssembler
Agent Harness
Model Provider
Tool implementation
Browser Runtime
Platform adapter
Control UI
future plugin context engine
```

They return normalized data, events, or mutation proposals to Agent Runtime or another explicitly authorized session service.

Concrete SQLite infrastructure persists entries but does not decide transcript semantics.

## Transcript entry classes

V1 may persist entries such as:

```text
user message
assistant message
tool call
tool result
structured notice
```

Future explicit entry classes may include:

```text
compaction summary
redaction marker
repair marker
branch or ancestry reference
runtime continuation metadata
```

Every durable entry class must define:

- whether it is visible through normal history APIs;
- whether it is eligible for model replay;
- its ordering and pairing rules;
- its session and run correlation fields;
- whether it survives export, reset, compaction, or archival;
- whether it may contain sensitive information;
- which module is authorized to create it.

Internal runtime events are not automatically transcript entries. Logs, events, audit records, and transcripts remain separate concepts.

## Run input and attempt behavior

User input for a run is appended to the durable transcript once, under the run lifecycle defined by ADR 0006.

A retry or later attempt within the same run does not append the same user message again.

Attempt-local instructions, provider errors, retry notices, and recovery prompts are not normal user transcript messages.

When multiple attempts occur:

- they share the run's captured `sessionId`;
- each attempt receives a newly prepared model context;
- completed durable tool calls and tool results remain part of transcript state when the transcript contract says they were committed;
- a failed attempt is not rewritten as successful because a later attempt completes;
- partial assistant output is not automatically promoted to a completed assistant transcript message.

The durable representation of failed attempts or partial output is deferred. Runtime events may describe them without treating them as visible conversation history.

## Tool-call transcript mutation

The Harness may detect or produce a model tool call, but it does not persist that call directly.

The host flow is:

```text
Harness emits normalized tool request
→ Agent Runtime coordinates Tool Runtime
→ policy and approval are evaluated
→ tool execution returns normalized result
→ Agent Runtime appends required tool-call/result entries
→ next model context is assembled from the updated transcript snapshot
```

Tool-call and tool-result entries must maintain valid pairing and ordering.

A tool implementation cannot append arbitrary assistant, user, or system messages to the transcript as a side effect of execution.

Future tools that intentionally send or mutate another session must use explicit session application contracts and policy checks rather than access `TranscriptStore` directly.

## Streaming and final assistant output

Gateway streaming events are an observable projection, not the canonical transcript.

Assistant deltas may be forwarded to clients before the final assistant entry is durable. A client must not treat streamed text as authoritative completed history.

V1 persists the normalized completed assistant result before emitting `run.completed`.

If a run fails or is cancelled after streaming partial output, the runtime must not silently store that partial output as a normal completed assistant message. A future product requirement may introduce explicit partial or interrupted entry types.

## Provider request projection

Provider adapters may transform prepared model context to satisfy provider-specific requirements, including:

- role and message-shape conversion;
- tool schema conversion;
- tool-call identifier sanitization;
- provider ordering requirements;
- removal of unsupported blank blocks;
- assistant-prefill handling;
- media encoding or hydration;
- cache-aware stable and dynamic prompt sections.

These transformations are in-memory request projections by default.

Provider adapters must not rewrite canonical transcript entries to make one provider accept them.

A malformed durable entry that violates the host transcript contract is not merely a provider adaptation problem. Repair of invalid durable records requires an explicit transcript-maintenance operation with validation and failure recovery.

## Pruning

Pruning reduces one outbound context snapshot without rewriting durable transcript history.

V1 may initially implement no pruning. When introduced, pruning must:

- operate on a copy or projection of transcript content;
- retain entry ordering and required tool-call/result structure;
- preserve current-turn input and attachments;
- protect recent context according to a documented policy;
- record metadata showing that the prepared context was pruned;
- leave the canonical transcript unchanged.

Typical pruning candidates include older oversized tool results or already-processed media payloads.

Pruning must not silently remove normal user or assistant conversation text from durable history.

Changing the pruning algorithm does not require a transcript migration because pruning is not persisted, unless the external context contract itself becomes compatibility-sensitive.

## Compaction

Compaction is distinct from pruning.

```text
pruning   = in-memory reduction for one model request
compaction = explicit durable summary or transcript transition
```

Compaction is deferred in V1, but future implementation must follow these rules:

1. compaction is coordinated by Agent Runtime or an authorized session service;
2. compaction that mutates or replaces current transcript state uses the same logical session lane as runs and reset;
3. a context engine or Harness may propose or compute a summary but does not commit it directly;
4. the compaction result uses an explicit durable entry or successor-transcript contract;
5. recent preserved entries and summary provenance are defined by policy;
6. failure leaves the previous valid transcript state authoritative;
7. compaction cannot be hidden inside a provider adapter;
8. compaction recovery creates a new attempt when it retries the model loop;
9. history and diagnostics must be able to distinguish original entries from compaction output.

Whether compaction rewrites one transcript, appends a summary checkpoint, or creates a successor `sessionId` requires a later focused decision before implementation.

## Transcript maintenance and repair

Normal context assembly is read-only with respect to durable transcript state.

A maintenance operation may rewrite or replace durable records only when an explicit contract exists for cases such as:

- malformed persisted entries;
- invalid tool-call/result pairing;
- schema migration;
- redaction or legal deletion;
- compaction;
- future transcript branching or repair.

Maintenance must:

- validate ownership and target `sessionId`;
- execute under the required session serialization boundary;
- preserve or back up the last valid state when replacement is non-trivial;
- use atomic storage behavior where supported;
- report whether a rewrite occurred;
- avoid altering delivered user or assistant content solely for provider preference;
- produce validation evidence and, when appropriate, an audit or structured event.

Context hooks cannot obtain unrestricted transcript write access.

## Hooks and future context engines

The architecture reserves lifecycle seams for:

```text
before context assembly
after context assembly
before model request
after model response
before compaction
after compaction
after turn
```

V1 implements only hooks with active consumers.

Future context engines may control assembly, pruning, compaction strategy, or cross-session recall through a registered contract. They must still respect host authority:

- session and agent identity are host-resolved;
- policy and tool visibility are host-controlled;
- canonical transcript writes use host-provided mutation contracts;
- context-engine state does not silently replace `TranscriptStore` as the visible session-history source of truth;
- engine failure must not corrupt the current transcript;
- plugin engines use public SDK boundaries rather than arbitrary `src/**` imports.

Selecting a context engine is separate from selecting a Harness or model provider.

## Resource snapshots and reproducibility

A run may capture a stable snapshot of agent resources such as skills, workspace bootstrap files, and model/tool capability metadata.

Within one model call, `PreparedModelContext` is immutable.

If resources can change during a run, the owning contract must decide whether later model calls:

- reuse the run snapshot; or
- resolve a new version explicitly.

V1 should prefer a stable per-run resource snapshot for bootstrap files and skills, while including transcript and tool-loop changes on every model call.

Context diagnostics may record resource identifiers, versions, hashes, or modification metadata. They must not log raw credentials or unrestricted prompt content.

## Failure behavior

Context assembly failure is a normalized runtime failure, not a reason to bypass policy or omit required context silently.

Examples include:

- unreadable required bootstrap resource;
- invalid attachment;
- token budget exceeded without an allowed reduction strategy;
- malformed transcript structure;
- unavailable required tool definition;
- context-engine failure;
- provider projection failure.

Optional resources may be skipped only under an explicit policy that records the omission.

Agent Runtime must not call a model with known-incomplete mandatory context merely to keep the run progressing.

A context or provider-projection failure must not mutate durable transcript state beyond entries already committed under the run contract.

## Observability

Context preparation emits structured metadata such as:

```text
agentId
sessionKey
sessionId
runId
attemptId
model-call sequence
resolved model route
context engine or assembler ID
estimated input tokens
transcript contribution size
resource contribution sizes
available tool count
attachment count
pruning or compaction status
```

`context.prepared` indicates that a model-call snapshot was successfully assembled. It does not mean the provider accepted the request or the run completed.

Logs and events should avoid full prompt bodies by default. Debug prompt export, when added, must be explicit, privileged, bounded, and redacted.

## OpenClaw alignment and intentional differences

This decision aligns with current OpenClaw behavior in the following ways:

- model context is assembled separately from durable session history;
- context assembly occurs as part of each model-run lifecycle;
- runtime-only prompt enrichment is not stored as user-authored transcript content;
- pruning is an in-memory prompt transformation;
- compaction is a distinct durable lifecycle operation;
- provider-specific transcript hygiene normally applies to outbound replay rather than delivered history;
- prompt rendering receives explicit resolved inputs rather than relying on one monolithic global builder;
- context-engine selection is distinct from Harness and model-provider selection.

`my-agent-v2` intentionally differs or starts smaller in these ways:

- V1 uses one built-in `ContextAssembler`, not a selectable plugin context engine;
- V1 has no automatic compaction, cross-session recall, memory engine, or transcript tree;
- transcript mutation authority remains explicitly coordinated by Agent Runtime and session contracts;
- V1 does not persist complete prompt snapshots;
- V1 does not permit hooks or providers to perform arbitrary transcript rewrites;
- provider-neutral prepared context is kept as a first-class internal boundary.

## Consequences

### Positive

- Durable conversation history remains independent from one provider's request format.
- User-visible history does not accumulate hidden runtime instructions.
- Pruning and provider adaptation can evolve without transcript migrations.
- Tool loops can rebuild context after each durable tool result.
- Retries do not duplicate user messages.
- Compaction remains observable and recoverable rather than becoming hidden provider behavior.
- Future context engines and memory systems have a clear insertion point.
- Gateway, Harnesses, providers, and tools cannot bypass transcript ordering authority.

### Negative

- Runtime must maintain mappings between transcript entries, provider-neutral messages, and provider request objects.
- Context is rebuilt multiple times during a tool loop.
- Explicit resource snapshots and provenance add metadata and tests.
- Some provider quirks require a dedicated projection layer instead of direct transcript reuse.
- Durable compaction requires more coordination than mutating a prompt array in place.

## Risks and trade-offs

### Prompt and transcript divergence

A model may see runtime context that the user cannot see in normal history.

Mitigation:

- classify every source as transcript-visible or runtime-only;
- expose bounded context diagnostics;
- keep runtime instructions versioned or attributable internally;
- do not describe normal history as a byte-for-byte model request log.

### Context growth

Keeping the full durable transcript may make later requests expensive.

Mitigation:

- add in-memory pruning before durable compaction;
- measure context contributors;
- define compaction only when an active product need exists;
- keep tool results structured so they can be safely reduced in projections.

### Provider-specific repair leaking into durable state

A provider adapter may be tempted to rewrite the transcript to satisfy replay rules.

Mitigation:

- require provider projection to be in-memory;
- validate canonical transcript structure independently;
- reserve durable repair for explicit maintenance contracts.

### Unauthorized transcript writes

A future Harness, plugin, or tool may attempt to append directly.

Mitigation:

- expose only application mutation facades;
- keep `TranscriptStore` out of plugin and tool contracts;
- enforce dependency rules and tests;
- require the session lane for transcript mutation.

### Sensitive context leakage

Prompt diagnostics or transcript APIs may expose secrets, hidden instructions, or credential-like data.

Mitigation:

- do not persist or log full prompts by default;
- separate normal history from privileged diagnostics;
- apply redaction and capability checks;
- keep credential handles out of model context unless explicitly required.

## Rejected alternatives

### Persist the complete model prompt as the transcript

Rejected because runtime instructions, tool schemas, policy notices, and provider adaptations are not user-authored durable conversation history.

### Let the Harness own transcript persistence

Rejected because Harnesses do not own session routing, reset, cross-attempt ordering, or storage policy, and different Harnesses would create incompatible histories.

### Let providers rewrite canonical transcript entries

Rejected because provider quirks must not change the durable source of truth or make one session non-portable to another model route.

### Assemble context only once at run start

Rejected because tool results, approvals, runtime notices, and recovery state may change before later model calls in the same run.

### Persist pruned tool results back into history

Rejected because pruning is a request-cost optimization and users or future models may still need the original durable result.

### Hide compaction inside provider retry logic

Rejected because compaction changes durable context semantics, requires session serialization, and must remain observable and recoverable.

### Allow arbitrary hooks to mutate transcript entries

Rejected because it would bypass ownership, ordering, policy, validation, and storage recovery rules.

### Store every streaming delta as a completed assistant message

Rejected because deltas may be partial, duplicated, revised, cancelled, or followed by a failed run.

### Make ContextAssembler responsible for SQLite reads and writes

Rejected because context assembly is an application boundary, while storage and transcript mutation belong to store contracts and Agent Runtime orchestration.

## Validation

This decision is correctly applied when:

- `src/context/` exposes a provider-neutral context assembly contract;
- context is prepared for every model request that follows transcript or tool-loop changes;
- prepared context is immutable for that model call;
- runtime-only instructions are absent from normal user transcript entries;
- user input is appended once per run;
- Gateway handlers, Harnesses, providers, tools, and context hooks do not write directly to `TranscriptStore`;
- Agent Runtime performs transcript writes through contracts while holding the session lane;
- provider adapters transform request projections without rewriting canonical history;
- pruning leaves durable transcript entries unchanged;
- `run.completed` is emitted only after the final assistant outcome is durable;
- streamed partial output is not represented as a completed assistant message after failure or cancellation;
- tool-call and tool-result ordering and pairing are validated;
- context diagnostics expose metadata without logging full sensitive prompt content by default;
- optional resource omission and mandatory resource failure follow explicit policies;
- any future compaction implementation uses an explicit durable contract and session serialization;
- transcript maintenance is separate from normal context assembly.

Minimum automated validation should include:

1. runtime system instructions are sent to the model but absent from visible transcript history;
2. one run with multiple attempts stores one user message;
3. a tool result is appended before the next model context is assembled;
4. provider projection changes do not mutate the transcript snapshot;
5. pruning an oversized tool result changes prepared context but not stored history;
6. a failed context assembly does not call the provider;
7. a failed provider projection does not rewrite transcript entries;
8. partial streamed output followed by cancellation is not stored as a completed assistant message;
9. final assistant persistence failure prevents `run.completed`;
10. direct transcript mutation is unavailable from Harness and tool contracts;
11. malformed tool-call/result ordering is rejected or routed to explicit repair;
12. context diagnostics omit configured secrets and full prompt bodies by default.

## Revisit conditions

Revisit this decision when:

- a plugin-provided context engine becomes an active requirement;
- cross-session memory or recall contributes to normal model context;
- automatic or manual compaction is implemented;
- transcript branching or successor transcripts are introduced;
- a native Harness owns canonical thread history that cannot be represented as a host transcript projection;
- persisted partial assistant output becomes a product requirement;
- prompt snapshots must be retained for compliance or reproducibility;
- users need editable or retractable historical messages;
- multiple processes can mutate one transcript;
- provider requirements cannot be satisfied through in-memory projection;
- context assembly must become independently versioned or exposed through a plugin SDK.

## References

- `docs/ARCHITECTURE.md`, section 9.5, **Context assembly**
- `docs/ARCHITECTURE.md`, section 9.6, **Compaction and runtime hooks**
- `docs/ARCHITECTURE.md`, section 9.7, **Runtime events**
- `docs/ARCHITECTURE.md`, section 10, **Model runtime and providers**
- `docs/ARCHITECTURE.md`, section 11, **Sessions and transcripts**
- `docs/ARCHITECTURE.md`, section 12, **Tool Runtime**
- `docs/ARCHITECTURE.md`, section 20, **Events, logs, and audit**
- `docs/ARCHITECTURE.md`, section 21, **Lifecycle and composition**
- `docs/decisions/0003-session-routing-transcript-separation-and-reset-semantics.md`
- `docs/decisions/0005-agent-runtime-harness-and-model-provider-boundaries.md`
- `docs/decisions/0006-run-attempt-lifecycle-and-per-session-serialization.md`
- OpenClaw, **Context engine**: `https://docs.openclaw.ai/concepts/context-engine`
- OpenClaw, **Context**: `https://docs.openclaw.ai/concepts/context`
- OpenClaw, **System prompt**: `https://docs.openclaw.ai/concepts/system-prompt`
- OpenClaw, **Session pruning**: `https://docs.openclaw.ai/concepts/session-pruning`
- OpenClaw, **Compaction**: `https://docs.openclaw.ai/concepts/compaction`
- OpenClaw, **Transcript hygiene**: `https://docs.openclaw.ai/reference/transcript-hygiene`
- OpenClaw, **Agent loop**: `https://docs.openclaw.ai/concepts/agent-loop`
- OpenClaw, **Agent runtime architecture**: `https://docs.openclaw.ai/agent-runtime-architecture`
