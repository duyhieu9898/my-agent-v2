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
- no automatic episodic extraction, vector recall, knowledge graph, or background memory consolidation;
- no provider-specific durable transcript format;
- no arbitrary transcript-mutating hooks.

## Decision

`src/context/` owns context assembly as a transport-neutral, provider-neutral application boundary.

`TranscriptStore` remains the durable transcript authority. Agent Runtime orchestrates transcript mutation through that contract while holding the applicable session lane. Context assembly, Harnesses, model providers, Gateway handlers, tools, and plugins do not directly mutate the canonical transcript.

The intended flow for each model call is:

```text
load durable transcript snapshot
→ resolve run, agent resources, memory, tools, and attachments
→ build a ContextManifest
→ build the versioned PromptPlan
→ enforce section and total budgets
→ render an immutable provider-neutral PreparedModelContext
→ validate the prepared context
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
  prepare(input: ContextAssemblyInput): Promise<PreparedContextBundle>;
}

interface PreparedContextBundle {
  readonly manifest: ContextManifest;
  readonly promptPlan: PromptPlan;
  readonly context: PreparedModelContext;
}
```

The exact TypeScript shapes may evolve, but the three-artifact boundary and ownership are fixed.

The assembler receives explicit, already-resolved inputs. It must not discover ownership from global mutable state or read Gateway transport objects.

Inputs may include:

```text
agentId and immutable resolved agent snapshot
sessionKey and sessionId
runId and attemptId
current model-call sequence
resolved model route and context limits
transcript snapshot and structural groups
current user input and attachments
workspace and bootstrap resources
skills and knowledge snapshot
frozen MemoryRecallSnapshot
visible tool definitions
policy-derived instructions and notices
runtime metadata
origin and capability metadata
context budget
```

The assembler returns one immutable `PreparedContextBundle` for one model request.

`ContextManifest` describes resolved sources and transformations. `PromptPlan` describes the exact ordered semantic sections and budgets selected for the call. `PreparedModelContext` contains the provider-neutral structured payload:

```text
ordered system/developer sections
conversation turns and structural tool exchanges
available tool schemas
current-turn attachments
provider-continuation references
estimated or exact token usage
budget and truncation metadata
source and section provenance
context preparation diagnostics
```

The prepared bundle must not contain mutable store handles, Gateway connection objects, raw credentials, or authority inferred from prompt text.

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

Context assembly resolves source classes from the immutable `ResolvedAgentSnapshot`, canonical stores, and validated run input. It may combine:

1. host safety, policy, and execution constraints;
2. agent operating rules;
3. resolved agent identity;
4. visible tool definitions and tool guidance;
5. user-profile resources;
6. bounded curated-memory recall selected by the Memory Runtime;
7. bootstrap, skill, and task-specific knowledge resources;
8. durable transcript projection;
9. current user input and attachments;
10. run, origin, platform, sandbox, and capability metadata;
11. model-family or provider prompt contributions allowed by contract.

Exact wording and rendering details are implementation choices until externally relied upon. Resource-role precedence is explicit and versioned below. The following invariants are not implementation details:

- user-authored content remains distinguishable from runtime-authored content;
- resource provenance is retained internally;
- policy instructions cannot be silently replaced by provider or Harness contributions;
- unavailable tools are not advertised to the model;
- attachments are included only when valid for the current turn and model capability;
- context sources are bounded by explicit size and token policies;
- sensitive runtime details are not automatically exposed in history or diagnostics.

## Agent resource model and precedence

Agent resources are typed inputs to context assembly, not an unordered set of filenames.

V1 recognizes these architecture-level roles:

```ts
type AgentResourceRole =
  | "operating-rules"
  | "personality-guidance"
  | "identity"
  | "user-profile"
  | "capability-guidance"
  | "tool-guidance"
  | "bootstrap"
  | "skill"
  | "knowledge";

type ResourceMutability =
  | "host-managed"
  | "user-managed"
  | "agent-writable-with-approval"
  | "generated";
```

A resource definition includes applicable resource ID, role, resolved path or loader identity, required flag, mutability, precedence, context-inclusion policy, size/token limit, and content hash.

Filenames such as `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `CAPABILITIES.md`, `TOOLS.md`, `USER.md`, or `BOOTSTRAP.md` may be V1 conventions, but runtime meaning comes from the resource definition. Repository development instructions such as the root `AGENTS.md` are not automatically agent-runtime resources.

`CAPABILITIES.md`-like content is capability guidance only. `TOOLS.md`-like content is local usage guidance only. Neither registers tools, grants permissions, changes Tool Registry membership, or overrides Policy Engine decisions. `MEMORY.md` is not the V1 memory source of truth; explicit import may create normal Memory Runtime entries.

V1 context precedence is explicit and versioned:

```text
host safety and policy instructions
→ agent operating rules
→ agent identity and personality guidance
→ tool and capability guidance
→ user profile
→ bounded memory recall
→ task skills and knowledge resources
→ transcript projection
→ current user input
```

Provider continuation metadata is merged later by selected provider projection and does not participate as user-editable instruction text.

`ContextManifest` records each included, skipped, rejected, or transformed source with resource ID, role, precedence, mutability, source/included hashes, included bytes/tokens, transformation rule, and reason.

Required safety, operating-rules, and identity resources must not be silently truncated. If they cannot fit their declared budget, context preparation fails. Optional skills or knowledge may be truncated only through a deterministic versioned strategy with manifest and Run Journal evidence.

Bootstrap resources are ordinary typed resources with separate lifecycle state. Completion, failure, archival, or replacement is explicit and versioned; V1 does not silently delete `BOOTSTRAP.md` after use.

## Prompt Plan, profile, authority, and trust

Context files and runtime sources are inputs. `PromptPlan` is the host-owned decision describing exactly what the model receives and how it is represented.

V1 defines one explicit versioned profile:

```text
promptProfileId: main-v1
```

The profile is resolved from the immutable agent snapshot and run policy. It is not inferred from `sessionKey`, origin, provider, Harness, or token pressure. Additional task, delegate, cron, or minimal profiles are deferred.

Conceptually, each semantic section contains:

```ts
interface PromptSectionPlan {
  readonly sectionId: string;
  readonly sourceRefs: readonly string[];
  readonly authority:
    | "host"
    | "agent"
    | "user-profile"
    | "runtime"
    | "retrieved-memory"
    | "conversation";
  readonly trust:
    | "trusted-instruction"
    | "managed-context"
    | "untrusted-data";
  readonly stability:
    | "agent-revision"
    | "run"
    | "model-call";
  readonly budgetClass:
    | "protected"
    | "bounded"
    | "optional";
  readonly required: boolean;
  readonly rendererVersion: string;
  readonly contentHash: string;
}
```

The exact fields may evolve, but these invariants are fixed:

1. `resourceId` and `sectionId` are distinct. One resource may render multiple sections; one section may compose multiple sources.
2. Section order is deterministic for the same profile, agent revision, run snapshot, and model-call inputs.
3. Prompt position does not create runtime authorization. Policy, Tool Registry, validated identities, and stores remain authoritative.
4. Managed or retrieved context cannot override protected host safety, policy guidance, operating rules, or identity.
5. Untrusted data such as labels, filenames, web content, attachment text, browser observations, and tool output is delimited, bounded, control-character normalized, and cannot create section IDs, reorder sections, or become tool schemas.
6. A provider or Harness cannot silently create, remove, or reorder host-owned sections.
7. Persona or identity reinforcement, if used, is derived from the same agent revision, bounded, and evidence-bearing; it cannot introduce new instructions.

Prompt budgets apply by semantic section, not only by source file. The plan records model context limit, reserved output/conversation capacity, tool-definition cost, system-section budget, measurement quality, and per-section allocation.

Protected sections include host safety/policy guidance, operating rules, identity, and required tool-contract guidance. They are never silently truncated. If they cannot fit, context preparation fails with a typed error such as `PROMPT_REQUIRED_SECTION_EXCEEDS_BUDGET`.

Bounded and optional sections such as user profile, memory, skills, and knowledge may be omitted or deterministically truncated using versioned policies. Every transformation records original/included hashes, measured or estimated size, strategy ID, and reason.

The plan classifies sections for future caching without requiring caching in V1:

```text
agent-revision stable
run stable
model-call dynamic
```

Provider-specific cache directives remain in provider projection. The generic Context Assembler exposes only semantic stability metadata.

## Curated memory recall

Cross-session memory is supplied by the independent Memory Runtime defined in ADR 0014. It is not an agent resource file and not transcript history.

The agent snapshot freezes memory enablement, namespace, search-policy version, and recall budget. The Memory Runtime performs one normal bounded retrieval for the admitted run and returns a `MemoryRecallSnapshot` containing selected memory IDs, revisions, hashes, scores, and rendered content. Context assembly consumes that frozen snapshot for each model call in the run.

A memory written during the active run does not silently change the current recall snapshot. It may be observed through the tool result and becomes eligible for later runs.

The memory contribution is rendered as one or more typed `retrieved-memory` / `managed-context` Prompt Plan sections below authoritative host/agent instructions and above task transcript content. It cannot override safety, policy, operating rules, or identity. Empty retrieval produces no fabricated section. The full contents of a `MEMORY.md` file are never injected as a bypass around `MemoryRecallSnapshot`.

The Context Manifest records memory index revision, retrieval-policy version, selected IDs and hashes, result/token budgets, and inclusion or rejection decisions. Unrestricted memory bodies are not duplicated into Run Journal rows.

Agent-owned operating rules, identity, tool policy, sandbox policy, and model route are not writable through ordinary model output. A future approved management operation must create a new agent revision and cannot mutate the active run snapshot.

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

Provider-neutral transcript entries remain the canonical user- and host-facing history. A model exchange may also carry provider continuation sidecar metadata when the selected provider requires opaque data for later stateless replay.

For Gemini V1, that sidecar may preserve typed interaction steps, thought signatures, provider interaction/request IDs, and their exact step associations. It is not user-visible assistant content and must not be flattened into plain text.

Future explicit entry classes or sidecars may include:

```text
compaction summary
redaction marker
repair marker
branch or ancestry reference
provider continuation metadata
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

## Structural exchange groups and history selection

Transcript entries are persisted individually but interpreted through provider-neutral structural groups.

A structural group represents one coherent exchange, for example:

```text
user message
→ assistant tool request
→ tool result
→ optional additional tool cycles
→ final assistant message
```

A group has a stable `groupId`, an ordered entry range, and a structural status such as `complete` or `incomplete`.

Context selection operates on complete groups and declared transcript entry classes. It must not select an arbitrary last-N entry slice that can separate a tool request from its result or detach provider continuation from the model exchange it belongs to.

The context pipeline is:

```text
load bounded transcript range
→ reconstruct structural groups
→ reject invalid durable structure
→ select recent complete groups
→ apply in-memory pruning to eligible content
→ validate provider-neutral structure
→ create provider projection
```

A structurally invalid durable transcript fails with a normalized error such as `TRANSCRIPT_STRUCTURE_INVALID`. Normal context assembly does not invent missing entries, collapse tool cycles into plain text, or silently repair durable history.

Pruning may reduce content inside an eligible group only when the resulting projection remains structurally valid and the transformation is recorded in the Context Manifest and Run Journal.

## Atomic transcript append batches

Agent Runtime writes canonical transcript changes through an atomic batch contract conceptually equivalent to:

```ts
TranscriptStore.appendBatch({
  sessionId,
  expectedTailSequence,
  entries,
});
```

The store either commits every entry in the batch with one contiguous sequence range or commits nothing. A stale `expectedTailSequence` fails explicitly rather than appending against an unexpected transcript head.

V1 commit boundaries are:

```text
RunSetupStage:
  accepted user input

Completed tool cycle:
  assistant tool request
  normalized tool result
  associated provider continuation sidecar

FinalizeStage:
  completed assistant result
  associated final provider continuation sidecar
```

Tool execution lifecycle evidence is written independently to the Run Journal before and after the side effect. The canonical transcript tool request/result pair is committed atomically after a normalized result exists, preventing an orphaned half-pair in normal durable history.

Provider continuation metadata required for replay commits in the same storage operation as the transcript exchange it describes. A successful transcript batch must not reference missing continuation data, and continuation data must not become current without its associated transcript entries.

Retries within one run do not append the accepted user input again. Failed or cancelled attempts do not promote partial assistant output into a completed transcript batch.

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

Tool-call and tool-result entries must maintain valid pairing and ordering. The normalized pair and its required provider continuation are appended as one atomic transcript batch after execution; the Run Journal remains the evidence source for requested, started, uncertain, failed, or completed side effects before that batch commits.

A tool implementation cannot append arbitrary assistant, user, or system messages to the transcript as a side effect of execution.

Future tools that intentionally send or mutate another session must use explicit session application contracts and policy checks rather than access `TranscriptStore` directly.

## Streaming and final assistant output

Gateway streaming events are an observable projection, not the canonical transcript.

Assistant deltas may be forwarded to clients before the final assistant entry is durable. A client must not treat streamed text as authoritative completed history.

V1 persists the normalized completed assistant result before emitting `run.completed`.

If a run fails or is cancelled after streaming partial output, the runtime must not silently store that partial output as a normal completed assistant message. A future product requirement may introduce explicit partial or interrupted entry types.

## Provider request projection

Provider adapters receive the immutable structured `PreparedModelContext` and Prompt Plan identity. They transform it to satisfy provider-specific requirements, including:

- role, message, content-part, or typed-step conversion;
- tool schema conversion;
- tool-call and function-result mapping;
- provider ordering requirements;
- omission of unsupported empty content blocks;
- assistant-prefill handling;
- media encoding or hydration;
- cache-aware stable and dynamic prompt sections;
- inclusion of required provider continuation sidecars.

These transformations are request projections. They do not change canonical transcript meaning and do not grant the adapter authority to rebuild the Prompt Plan. The adapter preserves semantic section ordering, required-section inclusion, trust boundaries, and source-to-section evidence even when the provider uses different native fields.

For V1 Gemini Interactions API, projection combines:

```text
structured PreparedModelContext
+ normalized transcript exchanges
+ opaque Gemini continuation sidecars
→ stateless Interactions API input
```

Projection must preserve complete Gemini typed steps and signatures required by later calls, with exact ordering and association.

Provider adapters must not rewrite canonical transcript entries, collapse missing-signature cycles into user text, fabricate continuation, use remote interaction IDs as local history, expose signatures as reasoning, or silently omit protected Prompt Plan sections.

Malformed durable transcript data fails as `TRANSCRIPT_STRUCTURE_INVALID`. Missing or incompatible continuation fails as `MODEL_HISTORY_INCOMPATIBLE`. Repair requires an explicit serialized transcript-maintenance operation with Run Journal evidence.

## Pruning

V1 implements deterministic, non-destructive context pruning for tool-heavy model-request projections. Pruning changes one `PreparedModelContext`; it never rewrites canonical transcript entries, memory, agent resources, or provider-continuation sidecars.

The V1 reduction pipeline is:

```text
normalize bounded tool result and persist oversized payload as an artifact when required
→ reconstruct complete structural exchange groups
→ estimate request pressure including tools, attachments, and reserved output/thinking budget
→ protect current and recent structural groups
→ soft-trim eligible older tool/media/browser results
→ obtain exact provider token count when the warning threshold requires it
→ optionally apply policy-enabled artifact-backed hard clear
→ validate structural integrity and final budget
```

### Source-level output guard

Tool Runtime and artifact infrastructure must prevent unbounded raw tool payloads from becoming ordinary inline transcript content. When a tool result exceeds its configured inline limit, the canonical normalized result contains a bounded representation plus an immutable artifact reference, content hash, size, and result type. The original payload is not silently discarded.

Source-level guarding and request-time pruning are separate:

```text
source guard = bounded canonical inline representation plus durable artifact
request pruning = smaller representation selected for one later model call
```

### Protected structure

Pruning operates on complete structural exchange groups and must preserve:

- current user input and current-turn attachments;
- the active assistant function-call step, every corresponding function result, and required continuation;
- the configured number of most recent complete exchange groups;
- protected Prompt Plan sections and required tool definitions;
- entry ordering and provider-required typed-step associations.

V1 does not select history by an arbitrary message count and does not prune normal user or assistant conversation text merely to save cost. Malformed structure fails as `TRANSCRIPT_STRUCTURE_INVALID`.

### Soft trim

Soft trim is enabled for eligible older oversized tool results, processed media representations, and browser observations. The default strategy retains a bounded head and tail around an explicit placeholder containing the original type, byte/token measurements, content hash, artifact reference when present, and reduction-rule version.

A soft-trim decision records before/after hashes and measurements. It must not claim that omitted content is absent from durable storage when an artifact exists.

### Hard clear

Hard clear is disabled by default in V1. A later configuration may enable it only for an eligible result that:

- is outside the protected structural window;
- has a durable artifact reference and content hash;
- can be explicitly re-read through an authorized tool or artifact contract;
- is not provider continuation, current-cycle state, or the sole evidence of an uncertain side effect.

The replacement placeholder identifies the artifact and states that a new explicit read is required. Hard clear must not trigger an automatic repeated tool call.

### Token measurement and failure

The Context subsystem uses a versioned fast local estimator for ordinary calls. Near the configured warning threshold, it may use the selected model route's token-count capability to measure the fully projected candidate request. For Gemini this is `countTokens`; a tokenizer for another model family must not be reported as exact Gemini usage.

Measurement is recorded as:

```text
estimated | exact | unknown
```

The execution plan defines bounded preflight behavior; V1 must not enter an unbounded count/prune loop. If the request still exceeds the usable budget after all permitted reductions, `ContextStage` returns `CONTEXT_BUDGET_EXCEEDED_AFTER_PRUNING`. It does not silently compact the transcript or ask the provider to repair history.

Changing the pruning algorithm does not require a transcript migration because pruning is not persisted. A compatibility-sensitive external pruning contract or persisted reduction object requires a later decision.

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
- produce validation evidence and, when appropriate, an audit or structured event;
- preserve the original incompatible record or a verifiable backup before provider-specific repair;
- journal every provider-history transformation, including which tool cycle or continuation field changed.

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

Context assembly operates on the immutable `ResolvedAgentSnapshot` captured for the run. It records enough metadata to reproduce or explain a run without treating the assembled prompt as the canonical transcript.

Within one model call, `PreparedModelContext` is immutable. Across model calls in the same run, transcript and tool-loop state may advance, but the agent revision and resource snapshot remain fixed.

Applicable metadata includes:

```text
agentId and agentRevision
resource-manifest version and aggregate hash
per-resource ID, role, mutability, precedence, and content hash
source transcript range or entry IDs
skill and knowledge versions or hashes
tool registry fingerprint
policy and sandbox fingerprints
model-route snapshot
context-builder and precedence-policy versions
prompt profile ID/version and Prompt Plan hash
section renderer, trust, authority, stability, and budget policy versions
rendered system/conversation/tool/attachment hashes
pruning, truncation, or compaction policy version
provider projection version and provider-request hash
```

The Run Journal records hashes, decisions, and references. Development capture may store redacted `ContextManifest`, Prompt Plan, rendered-section, and provider-request artifacts when enabled.

A file or resource change during an active run does not alter that run's manifest or prompt inputs. The next run resolves a new agent revision. Tests must cover this immutability explicitly.

Context diagnostics must not log raw credentials or unrestricted prompt content.

## Failure behavior

Context assembly failure is a normalized runtime failure, not a reason to bypass policy or omit required context silently.

Examples include:

- unreadable required bootstrap resource;
- invalid attachment;
- token budget exceeded without an allowed reduction strategy;
- malformed transcript structure;
- unavailable required tool definition;
- context-engine failure;
- invalid Prompt Plan or section-order invariant;
- protected prompt section exceeding budget;
- untrusted-data sanitization or delimiter failure;
- provider projection failure.

Optional resources may be skipped only under an explicit policy that records the omission.

Agent Runtime must not call a model with known-incomplete mandatory context merely to keep the run progressing.

A context or provider-projection failure must not mutate durable transcript state beyond entries already committed under the run contract.

## Observability

Context preparation emits structured metadata such as:

```text
agentId and agentRevision
resource-manifest hash and source decisions
bootstrap state and resource hash
sessionKey, sessionId, runId, attemptId, model-call sequence
resolved model route and assembler ID
prompt profile ID and version
Context Manifest hash
Prompt Plan hash
section IDs and source refs
section authority, trust, stability, and budget classes
section include/skip/reject/truncate decisions
renderer, sanitization, delimiter, and transformation rule versions
rendered system, conversation, tool-definition, attachment, and continuation hashes
estimated or exact input tokens and measurement quality
transcript head/range and structural-group validation
memory index, search policy, selected IDs/hashes/scores, and budget
pruning or compaction status
provider continuation count and validation
provider projection or repair decision
```

`context.prepared` means a model-call snapshot was successfully assembled. It does not mean the provider accepted the request or the run completed.

Context diagnostics must not log raw credentials or unrestricted prompt content. Development capture may persist redacted manifests, Prompt Plans, rendered sections, and provider requests as access-controlled debug artifacts; ordinary journal rows retain typed decisions, references, hashes, sizes, and rule versions.

## OpenClaw alignment and intentional differences

This decision aligns with current OpenClaw behavior in the following ways:

- model context is assembled separately from durable session history;
- context assembly occurs as part of each model-run lifecycle;
- runtime-only prompt enrichment is not stored as user-authored transcript content;
- V1 pruning is a deterministic in-memory/request-projection transformation;
- source-level output guarding stores oversized payloads as artifacts rather than silently losing them;
- soft trim is enabled for eligible old tool-heavy content and hard clear is disabled by default;
- compaction is a distinct durable lifecycle operation;
- provider-specific transcript hygiene normally applies to outbound replay rather than delivered history;
- prompt rendering receives explicit resolved inputs rather than relying on one monolithic global builder;
- context-engine selection is distinct from Harness and model-provider selection.

`my-agent-v2` intentionally differs or starts smaller in these ways:

- V1 uses one built-in `ContextAssembler`, not a selectable plugin context engine;
- V1 has explicit curated-memory recall, but no automatic episodic extraction, embeddings, vector/hybrid recall, knowledge graph, background consolidation, or transcript tree;
- transcript mutation authority remains explicitly coordinated by Agent Runtime and session contracts;
- V1 does not persist complete prompt snapshots;
- V1 does not permit hooks or providers to perform arbitrary transcript rewrites;
- provider-neutral prepared context is kept as a first-class internal boundary;
- Gemini-specific continuation is stored as opaque sidecar metadata and is not exposed as normal transcript text;
- V1 fails on incompatible Gemini history rather than silently collapsing tool-call cycles during projection.

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

### Resource precedence or mutation drift

A file may be loaded under the wrong role, silently change precedence, or mutate while an active run is executing.

Mitigation:

- resolve typed resources from one agent snapshot;
- version precedence policy;
- hash every included resource;
- fail required-resource overflow rather than silently truncating it;
- journal all skip, rejection, and truncation decisions;
- apply changes only through a new agent revision.

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

- require visible-content provider projection to be in-memory;
- preserve required opaque continuation through explicit sidecar records rather than content rewrites;
- validate canonical transcript structure and provider continuation independently;
- reserve durable repair for explicit maintenance contracts;
- fail rather than silently collapse incompatible tool history.

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

### Infer resource semantics only from filenames

Rejected because identical filenames can exist in repository, workspace, skill, or generated scopes, while role, precedence, mutability, and authority must remain explicit.

### Reload agent resources independently before every stage

Rejected because one run could observe mixed revisions and become timing-dependent or unreproducible.

### Silently truncate required identity or operating rules

Rejected because the model would receive a materially different authority context without a visible failure or evidence record.

### Treat context files as the final prompt contract

Rejected because source files do not encode resolved precedence, trust, section mapping, runtime contributions, budgets, or provider-neutral turns.

### Pass one monolithic system-prompt string through the runtime

Rejected because semantic sections, conversation turns, tools, attachments, continuation, and untrusted data need distinct contracts and evidence.

### Let prompt position define authorization

Rejected because language-model instructions cannot replace Tool Registry, Policy Engine, validated identities, or store ownership.

### Infer prompt profile from session key or run origin

Rejected because the effective profile would become implicit, hard to reproduce, and easy to influence accidentally.

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

### Select history by a raw entry count

Rejected because arbitrary entry slicing can split structural exchanges and produce invalid tool or provider history.

### Commit tool requests and results as unrelated writes

Rejected because partial failure could leave an orphaned tool call or result in canonical history.

### Let callers assign transcript sequence numbers

Rejected because multiple callers could create collisions, gaps, or stale ordering. Sequence allocation belongs to `TranscriptStore`.

## Validation

This decision is correctly applied when:

- `src/context/` exposes a provider-neutral context assembly contract;
- every model call produces a `ContextManifest`, versioned Prompt Plan, and immutable structured `PreparedModelContext`;
- V1 uses explicit `main-v1` and does not infer prompt mode from session, origin, provider, or Harness;
- section order, source mapping, authority, trust, stability, budget class, renderer version, and hashes are deterministic and observable;
- protected sections fail rather than truncate silently; optional transformations record versioned evidence;
- untrusted data cannot create sections, schemas, policy rules, or capability grants;
- resource IDs and section IDs remain distinct and traceable;
- every model request is tied to one immutable `agentRevision` and resource manifest;
- resource role, precedence, mutability, required status, and hashes are explicit;
- repository development instructions are not implicitly loaded as runtime agent resources;
- required operating-rules and identity resources fail visibly when over budget;
- optional resource truncation is deterministic and journaled with before/after evidence;
- bootstrap resource transitions are explicit and do not silently delete source content;
- active runs do not observe later resource edits;
- context is prepared for every model request that follows transcript or tool-loop changes;
- prepared context is immutable for that model call;
- runtime-only instructions are absent from normal user transcript entries;
- user input is appended once per run;
- Gateway handlers, Harnesses, providers, tools, and context hooks do not write directly to `TranscriptStore`;
- Agent Runtime performs transcript writes through contracts while holding the session lane;
- provider adapters transform request projections without rewriting canonical visible history;
- required Gemini typed steps and continuation sidecars survive durable round trips with exact ordering and association;
- raw thought signatures are not exposed through normal history APIs, logs, or Gateway events;
- missing required Gemini continuation fails before the provider call or as a normalized incompatible-history error;
- ordinary context assembly never silently collapses a tool cycle to repair provider history;
- pruning leaves durable transcript entries unchanged and preserves complete protected structural groups;
- oversized source tool results retain a bounded canonical representation plus artifact/hash evidence;
- near-limit requests use model-route token counting under a bounded policy and record `estimated | exact | unknown`;
- overflow after permitted pruning fails as `CONTEXT_BUDGET_EXCEEDED_AFTER_PRUNING`;
- `run.completed` is emitted only after the final assistant outcome is durable;
- streamed partial output is not represented as a completed assistant message after failure or cancellation;
- tool-call and tool-result ordering and pairing are validated;
- context selection uses complete structural groups rather than arbitrary entry counts;
- structurally invalid history fails explicitly without silent repair;
- transcript appends use atomic batches with expected-tail validation and contiguous store-assigned sequences;
- tool request/result pairs and required provider continuation commit atomically;
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
12. context diagnostics omit configured secrets, raw thought signatures, and full prompt bodies by default;
13. a Gemini tool-loop fixture round-trips opaque continuation through persistence and produces an equivalent next request;
14. missing required continuation returns `MODEL_HISTORY_INCOMPATIBLE` without mutating transcript content;
15. an explicit repair fixture creates journaled maintenance evidence rather than an invisible projection rewrite;
16. selecting recent history never returns an orphaned tool call or tool result;
17. a failed transcript batch commits no entries and does not advance the tail sequence;
18. a stale expected-tail write fails without corrupting a concurrently advanced transcript;
19. tool request, result, and required provider continuation survive or fail as one durable batch;
20. the same resolved inputs produce the same Prompt Plan order and hashes;
21. protected sections fail rather than truncate when over budget;
22. optional sections truncate or skip according to versioned strategy with evidence;
23. untrusted filenames, web content, and tool output cannot create sections or tool schemas;
24. provider projection preserves required section semantics and records a request hash;
25. resource-to-section and section-to-source mappings remain queryable;
26. source-level output guarding retains a bounded canonical result and durable artifact/hash for an oversized tool payload;
27. soft trim preserves configured head/tail content, structural pairing, hashes, and artifact reference without changing stored history;
28. hard clear is disabled by default and rejects a result without a durable re-readable artifact;
29. near-limit Gemini context uses bounded route-aware token counting and never reports a foreign tokenizer estimate as exact;
30. post-pruning overflow fails with `CONTEXT_BUDGET_EXCEEDED_AFTER_PRUNING` and does not invoke compaction implicitly.

## Revisit conditions

Revisit this decision when:

- a plugin-provided context engine becomes an active requirement;
- memory recall needs dynamic per-model-call refresh rather than the V1 frozen per-run snapshot;
- automatic extraction, vector/hybrid search, or background consolidation contributes to normal model context;
- automatic or manual compaction is implemented;
- transcript branching or successor transcripts are introduced;
- a native Harness owns canonical thread history that cannot be represented as a host transcript projection;
- persisted partial assistant output becomes a product requirement;
- prompt snapshots must be retained for compliance or reproducibility;
- additional prompt profiles, automatic profile selection, or delegate/task modes become product requirements;
- explicit provider cache objects, host-managed cache identities, or stronger stable-prefix compatibility guarantees become active;
- section trust or authority rules need a public compatibility contract;
- users need editable or retractable historical messages;
- multiple processes can mutate one transcript;
- provider requirements cannot be satisfied through in-memory projection;
- agent resources become dynamically editable, remotely managed, or self-modifying;
- precedence rules or resource-role contracts must become public and version-compatible;
- bootstrap becomes resumable, interactive, or model-generated;
- context assembly must become independently versioned or exposed through a plugin SDK.

## References

- `docs/decisions/0014-memory-ownership-retrieval-and-evolution.md`
- `docs/ARCHITECTURE.md`, section 9.5, **Context assembly and Prompt Plan**
- `docs/ARCHITECTURE.md`, section 9.6, **Compaction and runtime hooks**
- `docs/ARCHITECTURE.md`, section 9.7, **Runtime events**
- `docs/ARCHITECTURE.md`, section 10, **Model runtime and providers**
- `docs/ARCHITECTURE.md`, section 11, **Sessions and transcripts**
- `docs/ARCHITECTURE.md`, section 13, **Tool Runtime**
- `docs/ARCHITECTURE.md`, section 21, **Events, logs, and audit**
- `docs/ARCHITECTURE.md`, section 22, **Lifecycle and composition**
- `docs/decisions/0003-session-routing-transcript-separation-and-reset-semantics.md`
- `docs/decisions/0005-agent-runtime-harness-and-model-provider-boundaries.md`
- `docs/decisions/0006-run-attempt-lifecycle-and-per-session-serialization.md`
- OpenClaw, **Context engine**: `https://docs.openclaw.ai/concepts/context-engine`
- OpenClaw, **Context**: `https://docs.openclaw.ai/concepts/context`
- OpenClaw, **System prompt**: `https://docs.openclaw.ai/concepts/system-prompt`
- GoClaw, **System Prompt Anatomy**: `https://docs.goclaw.sh/system-prompt-anatomy`
- GoClaw, **Context Files**: `https://docs.goclaw.sh/context-files`
- GoClaw source, **System Prompt Anatomy**: `https://github.com/nextlevelbuilder/goclaw-docs/blob/master/agents/system-prompt-anatomy.md`
- GoClaw source, **Context Files**: `https://github.com/nextlevelbuilder/goclaw-docs/blob/master/agents/context-files.md`
- GoClaw, **Context Pruning**: `https://docs.goclaw.sh/context-pruning`
- GoClaw source, **Context Pruning**: `https://github.com/nextlevelbuilder/goclaw-docs/blob/master/advanced/context-pruning.md`
- OpenClaw, **Session pruning**: `https://docs.openclaw.ai/concepts/session-pruning`
- OpenClaw, **Compaction**: `https://docs.openclaw.ai/concepts/compaction`
- OpenClaw, **Transcript hygiene**: `https://docs.openclaw.ai/reference/transcript-hygiene`
- OpenClaw, **Agent loop**: `https://docs.openclaw.ai/concepts/agent-loop`
- OpenClaw, **Agent runtime architecture**: `https://docs.openclaw.ai/agent-runtime-architecture`
- Gemini Interactions API: `https://ai.google.dev/gemini-api/docs/interactions-overview`
- Gemini token counting and usage: `https://ai.google.dev/gemini-api/docs/tokens`
- Gemini thought signatures: `https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures`
- GoClaw Gemini provider reference: `https://docs.goclaw.sh/provider-gemini`
- GoClaw, **How GoClaw Works**: `https://docs.goclaw.sh/how-goclaw-works`
- GoClaw, **Agents Explained**: `https://docs.goclaw.sh/agents-explained`
- GoClaw, **Sessions and History**: `https://docs.goclaw.sh/sessions-and-history`
