# ADR 0005: Agent Runtime, Harness, and Model Provider Boundaries

- **Status:** Accepted
- **Date:** 2026-07-24
- **Decision owners:** my-agent-v2 maintainers
- **Related architecture:** `docs/ARCHITECTURE.md`
- **Related decisions:**
  - `docs/decisions/0001-modular-monolith-and-openclaw-alignment.md`
  - `docs/decisions/0002-core-runtime-identities-and-agent-ownership.md`
  - `docs/decisions/0003-session-routing-transcript-separation-and-reset-semantics.md`
  - `docs/decisions/0004-gateway-control-plane-and-protocol-contract.md`
  - `docs/decisions/0015-usage-accounting-and-cumulative-budget-enforcement.md`

## Context

`my-agent-v2` needs to execute model-driven agent turns without coupling Gateway transport, model-provider SDKs, tool implementations, or one specific agent framework into a single runtime module.

Three related concepts must remain distinct:

```text
Agent Runtime facade
Agent Harness
Model Provider
```

They are easy to conflate because all three participate in one agent turn:

- the Agent Runtime coordinates application-owned state and lifecycle;
- the Agent Harness executes prepared model-driven steps within one host-owned attempt;
- the Model Provider resolves and transports model requests.

If these boundaries are merged, adding another provider may require replacing the agent loop, adding another harness may change model identity or credentials, and Gateway handlers may become coupled to provider-specific behavior.

OpenClaw currently makes the same distinction. Its runtime facade and built-in loop live under agent-owned modules, harness registration and selection are separate, and model/provider transport is owned by the LLM layer. A harness is the low-level executor of a prepared turn; it is not a provider, channel, or tool registry. Runtime selection occurs after the effective provider/model route is known, and a provider or model prefix alone does not identify the harness.

`my-agent-v2` adopts these responsibility boundaries while keeping the initial implementation smaller:

- one built-in harness;
- Gemini Developer API as the initial model provider;
- API-key authentication resolved by the host;
- the pinned default model ID `gemini-3.5-flash`;
- no dynamic harness plugins;
- no provider failover;
- no external CLI or daemon harness in V1.

The Codex CLI and `harness-experimental` repository used to develop `my-agent-v2` are development tooling. They are not automatically the production Agent Harness.

## Decision

`my-agent-v2` will implement the Agent Runtime, Agent Harness, and Model Provider as separate runtime boundaries.

The intended flow is:

```text
Gateway or another application entry point
→ Agent Runtime facade
→ resolve agent definition and freeze one ResolvedAgentSnapshot
→ resolve session
→ resolve provider and model route
→ select compatible harness
→ resolve context sources and build a ContextManifest
→ build a versioned PromptPlan
→ render one immutable PreparedModelContext
→ execute prepared model/tool steps under CheckpointStage authority
→ persist transcript and runtime state
→ emit structured runtime events
→ return terminal run result
```

The Agent Runtime owns application orchestration, stage sequencing, checkpoint decisions, and finalization. The Harness owns execution of prepared model-driven steps within one attempt. The model layer owns provider/model resolution and transport contracts.

## Agent Runtime facade

`src/agents/` owns the transport-neutral Agent Runtime facade.

The facade accepts validated application input rather than Gateway frames, raw WebSocket objects, provider SDK objects, or SQLite handles.

Conceptually, a run request includes:

```text
agentId
session routing input or resolved session identity
user input and attachments
optional supported model override
optional supported harness-selection policy
origin metadata
cancellation signal
```

The facade owns or coordinates:

- resolving the configured agent definition;
- validating agent availability and bootstrap policy;
- freezing one immutable `ResolvedAgentSnapshot` and `agentRevision` for the run;
- resolving the logical session and transcript instance;
- resolving one frozen `MemoryRecallSnapshot` through the Memory Runtime when memory is enabled;
- creating `runId` and `attemptId` at their defined lifecycle boundaries;
- acquiring the per-session run lane;
- loading transcript and agent resources;
- resolving the effective provider and model route through model contracts;
- selecting a compatible harness through the Harness Registry;
- requesting `ContextManifest`, `PromptPlan`, and immutable `PreparedModelContext` construction from `src/context/`;
- preparing attempt input;
- coordinating tool execution through the Tool Runtime;
- appending transcript and runtime-owned state through store contracts;
- enforcing run cancellation and timeout policy;
- executing the fixed host-owned stage pipeline;
- evaluating all loop continuation through the first-class `CheckpointStage`;
- running the terminal `FinalizeStage` on completion, failure, and cancellation;
- emitting structured runtime events;
- classifying terminal run results;
- releasing run resources and the session lane.

Detailed run transitions, retry behavior, and per-session serialization are defined by a later run-lifecycle ADR.

The Agent Runtime does not own:

```text
Gateway connection lifecycle
protocol frame validation
provider-specific HTTP or SDK transport
tool implementation details
browser implementation
platform implementation
SQLite queries
Control UI delivery
```

Gateway handlers call the facade through an application-facing contract. Other future entry points must use the same facade rather than duplicating the loop.

## Resolved Agent Snapshot

`AgentDefinition` is authoritative configuration. `ResolvedAgentSnapshot` is the immutable effective configuration used by one admitted run.

Conceptually it contains:

```ts
interface ResolvedAgentSnapshot {
  readonly agentId: string;
  readonly agentRevision: string;
  readonly availability: "ready";
  readonly bootstrapState: "pending" | "running" | "completed" | "failed";
  readonly workspace: string;
  readonly stateDirectory: string;
  readonly modelRoute: ResolvedModelRoute;
  readonly harnessSelection: ResolvedHarnessSelection;
  readonly promptProfile: ResolvedPromptProfile;
  readonly resources: readonly ResolvedAgentResource[];
  readonly resourceManifestHash: string;
  readonly toolRegistryFingerprint: string;
  readonly toolPolicyFingerprint: string;
  readonly sandboxPolicyFingerprint: string;
  readonly memoryConfiguration: ResolvedMemoryConfiguration;
  readonly memoryPolicyFingerprint: string;
}
```

The exact TypeScript shape may evolve, but these invariants are fixed:

1. Snapshot resolution occurs once per run before model-driven execution.
2. The snapshot is immutable for that run and contains no mutable store handles, Gateway objects, or raw credentials.
3. Agent configuration or resource changes publish a new revision for later runs; they do not mutate active snapshots.
4. An explicit model, harness, or prompt-profile override, when supported, becomes part of the effective snapshot and manifest.
5. V1 resolves prompt profile `main-v1` in the snapshot; providers and Harnesses cannot replace it privately.
6. A snapshot records resource identities, roles, hashes, mutability, and precedence inputs rather than only filenames.
7. Memory enablement, namespace, recall budget, and search-policy version are frozen in the snapshot; selected memory content is captured separately in the run's `MemoryRecallSnapshot`.
8. The Run Journal records the revision and fingerprints needed to explain the run without duplicating sensitive resource or memory bodies.
9. An unknown, disabled, or unavailable agent fails before session-lane admission and model execution.

Bootstrap composes the definition registry and snapshot resolver. Agent Runtime consumes the resolver through a contract and must not rebuild definitions from arbitrary files during an attempt.

The prepared Harness step receives the snapshot or a least-privilege projection of it. Harnesses and providers cannot refresh, replace, or mutate the snapshot privately.

## Agent Harness

An Agent Harness is the low-level executor for prepared model-driven steps within one host-owned attempt.

Conceptually, the V1 built-in harness is step-oriented:

```ts
interface AgentHarness {
  readonly id: string;

  supports(input: HarnessSelectionInput): HarnessSupportResult;

  executeStep(
    input: PreparedHarnessStep,
  ): Promise<HarnessStepOutcome>;
}
```

The exact TypeScript shape may evolve, but the ownership boundary is fixed.

A harness receives prepared input and may:

- drive one normalized model step;
- translate native tool-call messages into host-owned tool requests;
- stream normalized partial output and runtime observations;
- maintain attempt-local native thread or continuation metadata when supported;
- return a normalized step outcome and progress signals.

The V1 built-in harness does not autonomously begin the next model/tool cycle. After every observable cycle, Agent Runtime invokes `CheckpointStage`, and only its decision may authorize another cycle or another attempt.

A harness must not:

- choose a different agent;
- choose a different session;
- silently replace the resolved provider or model;
- hide loop continuation, retry, fallback, or terminal decisions inside the harness;
- start another model step without a host `CheckpointStage` decision;
- bypass Tool Runtime policy or approval;
- directly mutate session routing metadata;
- directly access Gateway connections;
- deliver channel or UI messages;
- query SQLite directly;
- treat native thread state as a replacement for the host transcript without an explicit future decision.

The host prepares the attempt before dispatch. At minimum, prepared input may include:

```text
resolved agent snapshot or least-privilege projection
agent identity, revision, workspace, and resource manifest
sessionId and transcript snapshot
runId and attemptId
structured `PreparedModelContext` plus prompt-plan identity and hashes
resolved provider and model route
auth or credential handle when host-owned
validated tool definitions
tool execution facade
policy and sandbox metadata
streaming and event callbacks
cancellation and timeout signals
```

V1 implements one built-in harness. That implementation may use the Model Runtime contract to call the initial provider.

A future native harness may own more of the low-level loop, native thread state, compaction, or authentication bootstrap. Such ownership must be declared explicitly, remain scoped to the prepared attempt, and preserve host-owned session, policy, event, transcript, checkpoint, and finalization contracts. A native loop must expose every cycle boundary and obtain a host checkpoint decision before continuing; an opaque self-continuing loop requires a later ADR.

Harness contracts exposed to external plugins are not considered stable until a dedicated plugin SDK decision is accepted.

## Harness Registry

The Harness Registry owns:

- registering available harness implementations;
- enforcing unique harness IDs;
- listing harness capabilities;
- checking compatibility with a resolved provider/model route;
- resolving explicit harness selection;
- applying `auto` selection policy;
- managing harness startup and shutdown when required.

Built-in harnesses use the same registration direction expected for future plugin-provided harnesses:

```text
built-in module or future plugin
→ registers harness
→ Harness Registry
→ Agent Runtime consumes registry
```

The Agent Runtime must not special-case a future harness by importing its concrete implementation.

## Harness selection

Harness selection occurs after the effective provider and model route has been resolved.

Selection inputs may include:

```text
resolved provider ID
resolved model ID
provider-declared compatibility metadata
request transport requirements
required tool capabilities
required streaming capabilities
agent or model selection policy
explicit run override when supported
```

The following rules apply:

1. Harness ID and provider ID are separate identifiers.
2. Model ID and harness ID are separate identifiers.
3. A provider or model-name prefix must not implicitly define a harness.
4. A harness must positively declare support for the effective route.
5. An explicitly requested harness that is missing or incompatible fails closed.
6. `auto` may choose a compatible registered harness according to deterministic priority rules.
7. V1 `auto` resolves to the sole built-in harness when that harness supports the selected route.
8. Harness selection must be observable in runtime metadata and events.
9. A harness must not silently switch provider or model after selection.

An agent definition may provide model defaults and a harness-selection default or policy. It does not make one harness permanently own every model route for that agent. Effective selection must still validate the resolved route.

Persisting a harness override in session state is deferred. It must not be introduced without defining compatibility, invalidation, and migration semantics.

## Model Runtime and provider boundary

`src/models/` owns provider and model concerns.

It owns:

- Provider Registry;
- model catalog and canonical model references;
- model alias and override resolution;
- credential and auth-profile lookup through scoped contracts;
- provider capability metadata;
- request normalization;
- provider-specific parameters;
- provider-specific HTTP, WebSocket, SDK, or local transport;
- streaming normalization;
- normalized provider token/usage metadata and billing certainty;
- provider timeout behavior;
- normalized provider errors;
- future fallback and health information.

A canonical model route identifies provider and model separately, conceptually:

```text
provider/model
```

The model layer does not own:

```text
session routing
transcript business rules
context assembly
agent-loop decisions
tool policy
tool execution
Gateway delivery
harness selection policy
```

The Agent Runtime and built-in harness depend on model contracts rather than a concrete provider SDK.

Adding a normal model API that fits the generic model transport requires a provider implementation, not a new harness.

## Initial V1 provider and model

V1 uses the Gemini Developer API as its production model-provider integration.

The initial effective route is:

```text
provider service: Gemini Developer API
authentication: API key
JavaScript SDK: @google/genai
API surface: Interactions API
default model ID: gemini-3.5-flash
conversation mode: stateless (store=false)
```

The provider adapter sends requests only from trusted backend runtime code. The API key is resolved through the host-owned credential boundary and must not be exposed to the Control UI, browser-delivered code, transcript, runtime events, logs, Run Journal payloads, debug artifacts, or provider-independent request objects.

The default model is pinned as:

```text
gemini-3.5-flash
```

V1 must not substitute the moving alias `gemini-flash-latest` for the persisted or configured default. Model upgrades require an explicit repository change and validation.

V1 does not use Vertex AI for model transport or authentication. Adding Vertex AI later is a separate provider route or provider implementation choice and must not be hidden behind the initial Gemini Developer API configuration.

### Native Gemini transport

The V1 adapter uses the official JavaScript SDK:

```text
@google/genai
```

and the Gemini Interactions API rather than the OpenAI-compatible endpoint.

The adapter calls Gemini in stateless mode with:

```text
store=false
```

and sends the locally assembled history required for each model call. It does not use `previous_interaction_id` as conversation authority in V1.

This preserves the existing ownership model:

```text
sessionKey and sessionId
→ local SessionStore and TranscriptStore
→ ContextAssembler
→ Gemini request projection
```

A provider-returned interaction ID or request ID is correlation metadata only. It is not a replacement for `sessionKey`, `sessionId`, `runId`, or `attemptId`.

Background Gemini execution and provider-hosted conversation continuation are deferred. They must not be enabled implicitly by SDK defaults.

### Gemini implicit prompt caching

V1 relies only on provider-managed implicit prompt caching exposed by the Gemini Interactions API. It does not create, persist, or address explicit provider cache objects.

Prompt caching is an optimization, not a state or correctness boundary:

- local `SessionStore`, `TranscriptStore`, `PromptPlan`, and provider-continuation sidecars remain authoritative;
- `store=false` and the prohibition on `previous_interaction_id` remain unchanged;
- `PromptPlan` supplies stable/run/dynamic section metadata and deterministic ordering;
- the Gemini adapter may project the stable prefix in that order but must not reorder, omit, or rewrite host sections solely to improve cache hits;
- a cache hit or miss must not change model-visible semantics;
- provider-reported cached-token usage is normalized when available and recorded as bounded evidence;
- cache availability, eviction, or provider policy changes must not fail an otherwise valid request.

Explicit cache objects, host-managed provider cache IDs, and correctness dependencies on provider cache residency are deferred.

### Gemini continuation and typed-step preservation

Gemini responses may contain typed execution steps and opaque provider continuation data, including thought signatures needed to preserve reasoning continuity across stateless multi-step tool use.

The Gemini adapter owns preservation and passback of these fields. It must:

- retain the complete provider step structure required for the next model request;
- preserve signatures and opaque continuation fields exactly as returned;
- preserve their association with the original step or content part;
- avoid synthesizing empty assistant text when the provider response contains only typed tool or thought steps;
- normalize user-visible text, function calls, function results, status, finish information, and usage without discarding required provider metadata;
- keep raw provider SDK objects and opaque continuation data inside model and transcript-sidecar boundaries;
- never expose private model reasoning as a host chain-of-thought record.

The official SDK may preserve continuation correctly when complete response steps are passed back unchanged. Because `my-agent-v2` owns transcript normalization and persistence, it must test this behavior explicitly rather than assume that text-only or tool-only projections are sufficient.

Provider continuation data is durable when it is required to construct a later stateless request. The normalized transcript remains the user- and host-facing conversation record; opaque Gemini continuation is associated sidecar metadata, not visible assistant content.

If required continuation metadata is missing or cannot be validated, V1 fails the attempt with a normalized error such as:

```text
MODEL_HISTORY_INCOMPATIBLE
```

V1 must not silently collapse a prior tool cycle, rewrite tool calls as plain text, fabricate a signature, or drop provider steps merely to make the request succeed. A future repair operation must be explicit, session-serialized, journaled, and independently validated.

### Gemini request and result normalization

The provider adapter owns Gemini-specific behavior, including:

- Interactions API input and step mapping;
- streaming step and delta mapping;
- custom function declaration and function-call/result mapping;
- thinking-level mapping;
- provider request and interaction correlation IDs;
- provider status and finish normalization;
- usage normalization, including provider-reported input, output, cached, tool-use, and thinking usage when available;
- timeout, cancellation, rate-limit, quota, authentication, safety, malformed-history, and transport error normalization;
- preservation of continuation metadata required for the next stateless request.

Agent Runtime, Harness, Tool Runtime, Gateway, and Control UI must not depend on Gemini SDK types or field names.

Additional providers, additional Gemini models, model fallback, per-session model selection, server-side Gemini conversation state, and alternate Gemini API surfaces are deferred. Their future addition must extend provider and model-resolution contracts rather than add provider branches to Gateway or Agent Runtime.

A new harness is justified when the execution backend owns a materially different native model-step or thread lifecycle, compaction model, tool protocol, or continuation semantics that the generic provider transport cannot represent cleanly. Harness diversity does not transfer authority for run continuation away from `CheckpointStage` without a later explicit decision.

## Provider usage normalization

The provider adapter returns usage and billing certainty through provider-neutral contracts. It does not calculate operator-configured cost or enforce cumulative budgets.

Normalized usage preserves provider-reported total tokens when available plus documented dimensions such as input, cached input, output, thinking, and tool-use tokens. The adapter must not silently sum overlapping dimensions or present partial usage as exact.

Each provider outcome classifies billing certainty as applicable:

```text
not-dispatched
not-billable
actual-known
billing-ambiguous
```

A timeout or disconnect after dispatch is billing-ambiguous unless the provider contract proves otherwise.

`src/usage/` consumes this normalized result under ADR 0015. It owns versioned price lookup, cumulative-cap matching, reservation, settlement, and durable accounting. Provider rate limits and provider account quota errors remain normalized provider failures and are not aliases for local usage-cap decisions.

## Provider route and harness compatibility

Provider implementations may expose secret-free compatibility metadata for a resolved route.

This metadata may describe:

- supported harness IDs;
- streaming behavior;
- tool-call support;
- structured-output support;
- image or attachment support;
- whether authored request transport overrides are present;
- whether the route requires provider-owned or harness-owned authentication bootstrap.

The Harness Registry consumes this prepared metadata. Harness implementations must not reread arbitrary global configuration to reinterpret the route after selection.

When one attempt may retry across multiple provider routes, the selected harness must support every route included in that prepared retry set, or selection must occur again at a new attempt boundary. The harness must not perform an unreported provider fallback internally.

## Authentication ownership

Provider credentials are resolved by the model layer by default.

Credentials must be scoped to the configured agent and the current attempt. Raw secrets must not be copied into transcript entries, events, logs, or Gateway responses.

A future trusted native harness may declare that it owns authentication bootstrap because its native runtime uses its own credential store. In that case:

- the capability must be explicit and apply consistently to every attempt claimed by the harness;
- the host still provides compatible selected credential references when available;
- the harness keeps secrets scoped to the attempt;
- authentication failures are normalized and actionable;
- per-agent credential isolation from ADR 0002 remains mandatory.

V1 uses host-owned API-key resolution for the Gemini Developer API. The key must be supplied through a secret-bearing configuration or credential reference owned by the backend runtime. It must not be accepted from ordinary Gateway run parameters or retained in session state.

## Prepared model runtime snapshot

Bootstrap may build one prepared model-runtime snapshot per configured agent.

A snapshot may contain:

```text
provider registry
projected model catalog
credential references or auth template
provider capability metadata
harness compatibility metadata
```

Publication is atomic:

- a run sees one complete snapshot generation;
- partial configuration reloads are not exposed;
- a failed replacement does not corrupt the currently published snapshot;
- mutable attempt-local provider state is forked or created from the selected snapshot.

V1 may publish one snapshot at startup and replace it only after restart. Live reload is deferred.

## Structured prompt boundary

Context assembly belongs to `src/context/`, not to the provider adapter or Harness.

For every model call, the host prepares three distinct artifacts:

```text
ContextManifest
→ PromptPlan
→ PreparedModelContext
```

`ContextManifest` records resolved sources and transformations. `PromptPlan` records the versioned profile, ordered section identities, source mappings, authority, trust class, stability class, budget class, renderer versions, and hashes. `PreparedModelContext` contains immutable provider-neutral system sections, conversation turns, tool definitions, attachments, and provider-continuation references.

V1 uses one explicit prompt profile:

```text
main-v1
```

The Agent Runtime freezes the effective profile and passes prepared context to the Harness. The Harness and provider do not rediscover agent files, choose another profile, reorder host sections, silently omit required sections, or assemble a replacement system prompt.

Provider adapters may project `PreparedModelContext` into native request objects. Projection may encode roles, typed parts, tools, attachments, caching hints, and opaque continuation, but must preserve semantic ordering and required-section decisions. Provider request construction is evidence-bearing projection, not context authority.

## Context and Tool Runtime interaction

Tool definitions are supplied by Tool Runtime as typed registry output. Prompt resources such as `TOOLS.md`, capability guidance, skills, or memory may explain tool use, but cannot register a tool, grant permission, override policy, or manufacture a model-visible schema.

Tool execution returns through host-owned contracts so policy, approval, timeout, cancellation, hooks, normalization, and audit behavior cannot be bypassed.

A native harness may translate between its tool protocol and the host tool contract, but host policy remains authoritative for side-effecting actions.

Detailed prompt planning, context, compaction, hook, and tool policy decisions are defined by related ADRs.

## Runtime events and results

Harness and provider-specific output must be normalized before crossing the Agent Runtime boundary.

Normalized output may include:

```text
assistant deltas
reasoning or plan events when permitted
tool requests
tool results or acknowledgements
usage metadata
provider and model metadata
native continuation metadata
attempt completion
attempt failure
```

Provider SDK objects and harness-native event payloads must not become Gateway protocol contracts directly.

The Agent Runtime emits the application runtime events defined by architecture and later event ADRs.

## Development harness distinction

The repository development workflow uses Codex CLI and `harness-experimental` to inspect, plan, edit, and validate the codebase.

That tooling is external to the production runtime architecture.

It does not imply that:

- production turns spawn Codex CLI;
- the production harness is named `codex`;
- repository planning state becomes agent session state;
- development credentials become runtime provider credentials;
- Codex-specific tool or transcript formats become core contracts.

Introducing Codex CLI, Codex app-server, ACP, or another external coding-agent runtime as a production harness requires a dedicated implementation plan and compatibility validation against this ADR.

## OpenClaw alignment and intentional differences

This decision aligns with current OpenClaw behavior in the following ways:

- the agent-facing runtime facade is separate from Gateway transport;
- harnesses execute prepared model-driven work inside host-owned turns or attempts;
- a harness is not a provider, channel, or tool registry;
- provider/model resolution and harness selection are separate decisions;
- runtime selection occurs after the effective provider/model route is known;
- an explicit incompatible harness fails closed;
- provider prefixes do not by themselves define harness selection;
- normal model APIs belong in provider adapters rather than harness plugins;
- a prepared per-agent model runtime can be published atomically;
- each run freezes one agent definition/resource snapshot and later configuration changes apply only to later runs;
- native runtimes may own additional low-level state but must declare their compatibility surface.

Intentional differences for `my-agent-v2` are:

- V1 has one step-oriented built-in harness and one provider integration: the Gemini Developer API;
- V1 pins `gemini-3.5-flash`, authenticates with a host-resolved API key, and uses the official `@google/genai` SDK;
- V1 uses the native Interactions API in stateless `store=false` mode and does not use `previous_interaction_id` as session authority;
- V1 preserves Gemini typed steps and opaque continuation metadata instead of routing through a generic OpenAI-compatible adapter;
- V1 does not use Vertex AI or a moving `latest` model alias;
- V1 does not implement OpenClaw's current built-in, Codex, Copilot, CLI-backend, or ACP runtime catalog;
- V1 does not copy OpenClaw's exact runtime IDs or configuration schema;
- V1 keeps the public Harness contract internal until plugin requirements exist;
- V1 does not implement dynamic runtime selection plugins or live model-runtime generation reload;
- Agent Runtime remains the owner of `runId`, `attemptId`, session integration, and application lifecycle even when a future native harness owns a low-level thread.

## Consequences

### Positive

- Gateway transport remains independent from model and agent-loop implementations.
- New model providers can be added without inventing new harnesses.
- Native agent backends can be introduced without changing canonical provider/model identity.
- Provider credentials, model catalogs, and transport behavior have one owner.
- The first production route is explicit and reproducible because the Gemini model ID is pinned.
- Tool policy and transcript ownership cannot be silently bypassed by a harness.
- Runtime selection is testable and observable.
- Development tooling remains separate from production architecture.

### Negative

- V1 introduces interfaces and registries with only one implementation.
- Prepared attempt objects carry more explicit metadata.
- Native harness integrations require adapters for tools, events, context, and transcript mirroring.
- The distinction among Agent Runtime, harness, provider, and model requires consistent terminology.
- Pinning the initial Gemini model requires an explicit repository change and validation when upgrading models.

## Risks and trade-offs

### Over-generalizing the first harness contract

A speculative plugin-quality contract could encode assumptions that do not fit future native runtimes.

Mitigation:

- keep the initial contract internal;
- implement only fields required by the first vertical slice;
- add plugin-facing compatibility through a later ADR;
- test behavior rather than mirroring OpenClaw types.

### Harness bypasses host authority

A native backend may attempt to execute tools, mutate transcripts, switch models, or deliver replies directly.

Mitigation:

- provide explicit host callbacks and facades;
- reject integrations that cannot preserve policy and transcript invariants;
- require compatibility documentation for every non-default harness;
- normalize all terminal results through Agent Runtime.

### Provider and harness become coupled by naming

Using values such as `openai`, `codex`, or a model prefix for both concepts can make selection implicit.

Mitigation:

- use separate typed IDs;
- resolve provider/model first;
- record selected harness separately in events and diagnostics;
- test explicit incompatibility and `auto` fallback paths.

### Agent configuration changes during an active run

Reloading identity, resources, policy, tools, or model defaults mid-run could produce a mixed execution that cannot be reproduced.

Mitigation:

- freeze one `ResolvedAgentSnapshot` at admission;
- make snapshot data immutable;
- use atomic revision publication for later runs;
- record revision and component fingerprints in the Run Manifest;
- prohibit Harness/provider-side refresh of agent configuration.

### Native thread diverges from host transcript

A future harness may own a native thread that cannot be rewritten like the host transcript.

Mitigation:

- keep the host transcript authoritative for product history unless a later ADR changes it;
- store native continuation identifiers as adapter metadata;
- define mirroring, recovery, reset, and compaction semantics before enabling such a harness.

### Snapshot reload produces mixed state

Reloading providers, credentials, or capabilities independently could expose incompatible partial state.

Mitigation:

- publish complete model-runtime generations atomically;
- keep the prior valid generation active when replacement fails;
- bind each attempt to one generation.

### Gemini API or model lifecycle changes

The Gemini Developer API, SDKs, quotas, supported features, or model lifecycle may change after V1 ships.

Mitigation:

- pin the canonical model ID instead of a moving alias;
- isolate Gemini-specific behavior inside the provider adapter;
- normalize capabilities and errors rather than exposing provider payloads;
- validate tool calling, streaming, usage reporting, and cancellation against the pinned model;
- treat model replacement, Vertex AI adoption, or fallback policy as an explicit configuration and planning change.

### Gemini continuation metadata is lost

A text-only or generic tool-call projection may discard thought signatures or typed-step data required by Gemini for a later stateless tool-loop request.

Mitigation:

- preserve complete provider continuation structures through explicit sidecar contracts;
- round-trip provider fixtures through persistence and context assembly tests;
- record signature counts and hashes rather than raw signatures in diagnostics;
- fail with `MODEL_HISTORY_INCOMPATIBLE` when required metadata is absent;
- prohibit silent tool-cycle collapse or fabricated continuation values.

### Provider-hosted state becomes a second session authority

Using `previous_interaction_id` could make remote Gemini state diverge from the local transcript and session-reset semantics.

Mitigation:

- use `store=false` in V1;
- send the locally assembled history for every call;
- treat interaction IDs as correlation metadata only;
- require a later ADR before enabling provider-hosted conversation state.

### Native SDK changes affect normalized behavior

The official SDK or Interactions API may change typed steps, streaming behavior, or continuation requirements.

Mitigation:

- pin and record the SDK version;
- keep SDK types inside the Gemini adapter;
- maintain provider contract fixtures and live smoke tests;
- treat material API-surface changes as explicit model-integration work.

## Rejected alternatives

### Resolve agent files independently inside each stage

Rejected because per-stage file reads can observe different revisions, bypass resource-role and mutability rules, and make one run depend on timing-sensitive filesystem state.

### Put the agent loop in Gateway handlers

Rejected because transport and connection lifecycle would become coupled to context, tools, providers, retries, and transcript persistence.

### Let providers own the complete agent loop

Rejected because adding an HTTP model API should not redefine session, context, tool, event, and run semantics.

### Let a Harness hide loop continuation and retry

Rejected because an opaque self-continuing loop would bypass the host checkpoint authority, make budgets and no-progress guards inconsistent across harnesses, and remove the step-by-step evidence required for debugging and verification.

### Treat every provider as a harness

Rejected because provider transport and agent-loop execution are different extension axes.

### Select a harness from the provider or model-name prefix

Rejected because naming conventions do not prove route compatibility and make canonical model identity depend on execution backend.

### Allow explicit incompatible harness selection to fall back silently

Rejected because the executed runtime would differ from operator intent and could change credentials, tools, cost, thread ownership, or behavior.

### Make Codex CLI the production harness by default

Rejected because its current role is repository development and orchestration tooling, not an accepted production runtime contract.

### Expose provider SDK types throughout Agent Runtime

Rejected because SDK upgrades and provider-specific concepts would leak across module boundaries and prevent normalized testing.

### Use `gemini-flash-latest` as the V1 default

Rejected because it is a moving alias. The selected model could change without an explicit repository decision, configuration update, or validation run.

### Use Vertex AI for the initial Gemini integration

Rejected for V1 because the selected deployment uses the Gemini Developer API with an API key. Vertex AI introduces a different authentication, project, endpoint, and operational model that is not required by the initial local-first scope.

### Use Gemini through the OpenAI-compatible endpoint in V1

Rejected because `my-agent-v2` has no existing OpenAI SDK compatibility requirement and needs native typed steps, continuation metadata, and observability without translating them through another provider schema.

### Use explicit Gemini cache objects in V1

Rejected because Interactions already provides implicit caching, while explicit cache identities would add provider-owned lifecycle and persistence state without changing local transcript authority. V1 records cached-token usage but does not manage cache objects.

### Use Gemini server-side conversation state in V1

Rejected because `previous_interaction_id` would create a remote state authority beside the local session and transcript stores. V1 uses stateless requests with `store=false`.

### Silently collapse tool history when continuation metadata is missing

Rejected because hidden history rewriting damages reproducibility and debug evidence. V1 fails explicitly and reserves repair for a deliberate, journaled maintenance operation.

### Publish a stable plugin harness SDK in V1

Rejected because there is no second harness consumer yet and the contract would be speculative.

### Let the provider or Harness assemble a replacement system prompt

Rejected because resource provenance, prompt authority, section ordering, budget enforcement, and reproducibility would become provider-specific and invisible to host evidence.

### Pass one unstructured prompt string as the model-runtime contract

Rejected because prompt sections, conversation turns, tool schemas, attachments, trust classes, and Gemini continuation are different semantic objects requiring typed projection and independent evidence.

### Allow harnesses to execute side effects outside Tool Runtime

Rejected because policy, approval, timeout, hooks, normalization, and future audit requirements would be bypassed.

### Let the provider adapter calculate cost or enforce local cumulative caps

Rejected because provider transport must not own operator price configuration, cumulative SQLite state, cap-policy matching, or Agent Runtime continuation decisions. The adapter supplies normalized usage and billing certainty to the Usage Runtime.

## Validation

This decision is correctly applied when:

- Gateway handlers call a transport-neutral Agent Runtime facade;
- every admitted run has exactly one immutable `ResolvedAgentSnapshot` and `agentRevision`;
- snapshot resolution fails before execution for unknown, disabled, or unavailable agents;
- agent/resource changes are observed only by later runs through a new revision;
- prepared Harness input contains the snapshot or a least-privilege immutable projection;
- Run Manifest evidence includes agent revision and resource/tool/policy fingerprints;
- Gateway code does not implement the model or tool loop;
- the V1 built-in Harness returns one normalized step outcome at a time;
- every additional model/tool cycle is authorized by Agent Runtime `CheckpointStage`;
- Harnesses and providers do not perform unreported internal retry, fallback, or continuation;
- `src/agents/` does not depend directly on concrete provider SDKs;
- each model call receives one versioned Prompt Plan and immutable structured `PreparedModelContext` from `src/context/`;
- providers and Harnesses cannot select a different prompt profile, reorder required host sections, or assemble context from arbitrary files;
- provider projection preserves semantic section ordering and records prompt/request hashes without rewriting canonical sources;
- `src/models/` owns provider registry, model resolution, credentials, transport, streaming, usage, and normalized errors;
- the V1 model catalog resolves the configured default to the Gemini Developer API and exact model ID `gemini-3.5-flash`;
- the V1 default does not persist or substitute `gemini-flash-latest`;
- the Gemini API key is resolved only in trusted backend model infrastructure and is absent from Gateway run input, UI payloads, transcripts, events, and logs;
- the Gemini provider adapter uses `@google/genai` and the Interactions API with `store=false`;
- V1 does not use `previous_interaction_id` as session or transcript authority;
- the Gemini provider adapter normalizes typed steps, streaming, tool calls, input/output/cached/tool-use/thinking usage metadata, cancellation, and provider failures through model contracts;
- provider usage normalization retains measurement/billing certainty and does not blindly double-count overlapping dimensions;
- provider adapters do not calculate operator cost, query cumulative balances, or authorize local cap exceptions;
- provider rate-limit/quota errors remain distinct from local cumulative-cap errors;
- Gemini prompt caching is implicit only; V1 creates no explicit provider cache object and persists no cache ID;
- cache hits or misses do not change Prompt Plan ordering, request semantics, transcript authority, or continuation behavior;
- required Gemini continuation metadata survives provider response → persistence → context assembly → next request round trips without mutation;
- raw thought signatures are absent from ordinary logs, Run Journal metadata, Gateway payloads, and user-visible transcript projections;
- missing required continuation fails explicitly as incompatible history rather than silently rewriting the tool cycle;
- provider IDs, model IDs, and harness IDs use separate types or validated fields;
- provider/model resolution occurs before harness selection;
- an explicit missing or incompatible harness fails deterministically;
- `auto` selection is deterministic and records the selected harness;
- the sole V1 harness is registered through the Harness Registry rather than hard-coded in Gateway code;
- the built-in harness uses host-provided model and tool contracts;
- harnesses cannot query SQLite or mutate session routing directly;
- side-effecting tool calls pass through the Tool Runtime and Policy Engine;
- provider-native and harness-native events are normalized before Gateway delivery;
- credentials remain scoped to agent and attempt and are absent from logs, transcripts, and events;
- one run binds to one complete prepared model-runtime snapshot generation;
- tests cover compatible selection, incompatible explicit selection, provider failure normalization, streaming normalization, cancellation, and tool-call delegation;
- no production code assumes that Codex CLI or `harness-experimental` is the production harness.

## Revisit conditions

Revisit this decision when:

- a second production harness is introduced;
- a harness must own canonical thread history;
- a native runtime requires harness-owned authentication bootstrap;
- model fallback spans routes with different harness compatibility;
- session-persisted or run-specific harness overrides are introduced;
- agent snapshot revisions require rollback, migration, signing, or public compatibility guarantees;
- approved runtime self-modification or dynamic resource reload becomes a product requirement;
- external plugins require a stable harness SDK;
- an ACP, CLI, daemon, or remote harness becomes a production requirement;
- the model runtime must reload providers or credentials without process restart;
- a provider requires transport behavior that cannot be represented by current model contracts;
- Gemini server-side state through `previous_interaction_id` becomes desirable;
- the project changes from the Interactions API to another Gemini API surface;
- provider continuation metadata requires a new durable identity or lifecycle contract;
- the default model changes from `gemini-3.5-flash`;
- Vertex AI replaces or supplements the Gemini Developer API;
- authentication changes from a host-resolved API key to OAuth, service-account, workload-identity, or provider-managed authentication;
- multiple providers, model fallback, or per-session model selection become active product requirements;
- distributed execution moves attempts to another process or host;
- explicit Gemini cache objects, provider cache IDs, or cache-residency guarantees become an active requirement;
- provider billing semantics cannot be normalized without leaking SDK types or giving provider transport local cap authority.

## References

- `docs/decisions/0015-usage-accounting-and-cumulative-budget-enforcement.md`
- `docs/decisions/0014-memory-ownership-retrieval-and-evolution.md`
- `docs/ARCHITECTURE.md`, section 8, **Agent definition and ownership**
- `docs/ARCHITECTURE.md`, section 9, **Agent Runtime architecture**
- `docs/ARCHITECTURE.md`, section 10, **Model runtime and providers**
- `docs/ARCHITECTURE.md`, section 13, **Tool Runtime**
- `docs/ARCHITECTURE.md`, section 17, **Plugin and extension architecture**
- `docs/ARCHITECTURE.md`, section 22, **Lifecycle and composition**
- `docs/ARCHITECTURE.md`, section 23, **Dependency direction**
- `docs/decisions/0001-modular-monolith-and-openclaw-alignment.md`
- `docs/decisions/0002-core-runtime-identities-and-agent-ownership.md`
- `docs/decisions/0003-session-routing-transcript-separation-and-reset-semantics.md`
- `docs/decisions/0004-gateway-control-plane-and-protocol-contract.md`
- OpenClaw Agent runtime architecture: `https://docs.openclaw.ai/agent-runtime-architecture/`
- OpenClaw Agent runtimes: `https://docs.openclaw.ai/concepts/agent-runtimes`
- OpenClaw Agent harness plugins: `https://docs.openclaw.ai/plugins/sdk-agent-harness`
- OpenClaw Agent loop: `https://docs.openclaw.ai/concepts/agent-loop`
- OpenClaw Model providers: `https://docs.openclaw.ai/concepts/model-providers`
- GoClaw System Prompt Anatomy: `https://docs.goclaw.sh/system-prompt-anatomy`
- GoClaw Context Files: `https://docs.goclaw.sh/context-files`
- GoClaw source, System Prompt Anatomy: `https://github.com/nextlevelbuilder/goclaw-docs/blob/master/agents/system-prompt-anatomy.md`
- GoClaw source, Context Files: `https://github.com/nextlevelbuilder/goclaw-docs/blob/master/agents/context-files.md`
- Gemini 3.5 Flash model: `https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash`
- Gemini API keys: `https://ai.google.dev/gemini-api/docs/api-key`
- Gemini API release notes: `https://ai.google.dev/gemini-api/docs/changelog`
- Gemini Interactions API: `https://ai.google.dev/gemini-api/docs/interactions-overview`
- Gemini Interactions migration guide: `https://ai.google.dev/gemini-api/docs/migrate-to-interactions`
- Gemini API getting started and `@google/genai`: `https://ai.google.dev/gemini-api/docs/get-started`
- Gemini context caching: `https://ai.google.dev/gemini-api/docs/caching`
- Gemini token counting: `https://ai.google.dev/gemini-api/docs/tokens`
- Gemini thought signatures: `https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures`
- GoClaw Gemini provider reference: `https://docs.goclaw.sh/provider-gemini`
- GoClaw Gemini provider source document: `https://github.com/nextlevelbuilder/goclaw-docs/blob/master/providers/gemini.md`
- GoClaw, **How GoClaw Works**: `https://docs.goclaw.sh/how-goclaw-works`
- GoClaw, **Agents Explained**: `https://docs.goclaw.sh/agents-explained`
- GoClaw Usage & Quota: `https://docs.goclaw.sh/usage-quota`
