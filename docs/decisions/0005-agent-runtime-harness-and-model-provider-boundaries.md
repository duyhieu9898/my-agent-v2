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
- the Agent Harness executes one prepared model-driven attempt;
- the Model Provider resolves and transports model requests.

If these boundaries are merged, adding another provider may require replacing the agent loop, adding another harness may change model identity or credentials, and Gateway handlers may become coupled to provider-specific behavior.

OpenClaw currently makes the same distinction. Its runtime facade and built-in loop live under agent-owned modules, harness registration and selection are separate, and model/provider transport is owned by the LLM layer. A harness is the low-level executor of a prepared turn; it is not a provider, channel, or tool registry. Runtime selection occurs after the effective provider/model route is known, and a provider or model prefix alone does not identify the harness.

`my-agent-v2` adopts these responsibility boundaries while keeping the initial implementation smaller:

- one built-in harness;
- one initial model provider;
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
→ resolve agent and session
→ assemble prepared run state
→ resolve provider and model route
→ select compatible harness
→ execute prepared attempt
→ persist transcript and runtime state
→ emit structured runtime events
→ return terminal run result
```

The Agent Runtime owns application orchestration. The Harness owns execution of one prepared model-driven attempt. The model layer owns provider/model resolution and transport contracts.

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
- resolving the logical session and transcript instance;
- creating `runId` and `attemptId` at their defined lifecycle boundaries;
- acquiring the per-session run lane;
- loading transcript and agent resources;
- requesting context assembly from `src/context/`;
- resolving the effective provider and model route through model contracts;
- selecting a compatible harness through the Harness Registry;
- preparing attempt input;
- coordinating tool execution through the Tool Runtime;
- appending transcript and runtime-owned state through store contracts;
- enforcing run cancellation and timeout policy;
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

## Agent Harness

An Agent Harness is the low-level executor for one prepared model-driven attempt.

Conceptually:

```ts
interface AgentHarness {
  readonly id: string;

  supports(input: HarnessSelectionInput): HarnessSupportResult;

  runAttempt(
    input: PreparedAgentAttempt,
  ): AsyncIterable<AgentRuntimeEvent>;
}
```

The exact TypeScript shape may evolve, but the ownership boundary is fixed.

A harness receives prepared input and may:

- drive model output;
- continue a model/tool-call loop;
- handle native tool-call messages through host-provided tool execution contracts;
- stream normalized partial output and runtime events;
- maintain an attempt-local native thread or continuation ID when supported;
- produce a normalized terminal attempt result.

A harness must not:

- choose a different agent;
- choose a different session;
- silently replace the resolved provider or model;
- bypass Tool Runtime policy or approval;
- directly mutate session routing metadata;
- directly access Gateway connections;
- deliver channel or UI messages;
- query SQLite directly;
- treat native thread state as a replacement for the host transcript without an explicit future decision.

The host prepares the attempt before dispatch. At minimum, prepared input may include:

```text
agent identity and workspace
sessionId and transcript snapshot
runId and attemptId
assembled context or prompt input
resolved provider and model route
auth or credential handle when host-owned
validated tool definitions
tool execution facade
policy and sandbox metadata
streaming and event callbacks
cancellation and timeout signals
```

V1 implements one built-in harness. That implementation may use the Model Runtime contract to call the initial provider.

A future native harness may own more of the low-level loop, native thread state, compaction, or authentication bootstrap. Such ownership must be declared explicitly, remain scoped to the prepared attempt, and preserve host-owned session, policy, event, and transcript contracts.

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
- token and usage metadata;
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

A new harness is justified when the execution backend owns a materially different native agent loop, thread lifecycle, compaction model, tool protocol, or continuation semantics that the generic provider transport cannot represent cleanly.

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

V1 uses host-owned credential resolution unless the initial provider integration has a separately accepted requirement.

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

## Context and Tool Runtime interaction

Context assembly belongs to `src/context/`, not to the provider adapter.

The Agent Runtime requests assembled context and passes prepared prompt or message input to the selected harness.

Tool definitions are supplied by the Tool Runtime. Tool execution returns through host-owned execution contracts so that policy, approval, timeout, cancellation, hooks, normalization, and audit behavior cannot be bypassed.

A native harness may translate between its tool protocol and the host tool contract, but host policy remains authoritative for side-effecting actions.

Detailed context, compaction, hook, and tool policy decisions are defined by later ADRs.

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
- harnesses execute prepared turns or attempts;
- a harness is not a provider, channel, or tool registry;
- provider/model resolution and harness selection are separate decisions;
- runtime selection occurs after the effective provider/model route is known;
- an explicit incompatible harness fails closed;
- provider prefixes do not by themselves define harness selection;
- normal model APIs belong in provider adapters rather than harness plugins;
- a prepared per-agent model runtime can be published atomically;
- native runtimes may own additional low-level state but must declare their compatibility surface.

Intentional differences for `my-agent-v2` are:

- V1 has one built-in harness and one provider;
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
- Tool policy and transcript ownership cannot be silently bypassed by a harness.
- Runtime selection is testable and observable.
- Development tooling remains separate from production architecture.

### Negative

- V1 introduces interfaces and registries with only one implementation.
- Prepared attempt objects carry more explicit metadata.
- Native harness integrations require adapters for tools, events, context, and transcript mirroring.
- The distinction among Agent Runtime, harness, provider, and model requires consistent terminology.

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

## Rejected alternatives

### Put the agent loop in Gateway handlers

Rejected because transport and connection lifecycle would become coupled to context, tools, providers, retries, and transcript persistence.

### Let providers own the complete agent loop

Rejected because adding an HTTP model API should not redefine session, context, tool, event, and run semantics.

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

### Publish a stable plugin harness SDK in V1

Rejected because there is no second harness consumer yet and the contract would be speculative.

### Allow harnesses to execute side effects outside Tool Runtime

Rejected because policy, approval, timeout, hooks, normalization, and future audit requirements would be bypassed.

## Validation

This decision is correctly applied when:

- Gateway handlers call a transport-neutral Agent Runtime facade;
- Gateway code does not implement the model or tool loop;
- `src/agents/` does not depend directly on concrete provider SDKs;
- `src/models/` owns provider registry, model resolution, credentials, transport, streaming, usage, and normalized errors;
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
- external plugins require a stable harness SDK;
- an ACP, CLI, daemon, or remote harness becomes a production requirement;
- the model runtime must reload providers or credentials without process restart;
- a provider requires transport behavior that cannot be represented by current model contracts;
- distributed execution moves attempts to another process or host.

## References

- `docs/ARCHITECTURE.md`, section 8, **Agent definition and ownership**
- `docs/ARCHITECTURE.md`, section 9, **Agent Runtime architecture**
- `docs/ARCHITECTURE.md`, section 10, **Model runtime and providers**
- `docs/ARCHITECTURE.md`, section 12, **Tool Runtime**
- `docs/ARCHITECTURE.md`, section 16, **Plugin and extension architecture**
- `docs/ARCHITECTURE.md`, section 21, **Lifecycle and composition**
- `docs/ARCHITECTURE.md`, section 22, **Dependency direction**
- `docs/decisions/0001-modular-monolith-and-openclaw-alignment.md`
- `docs/decisions/0002-core-runtime-identities-and-agent-ownership.md`
- `docs/decisions/0003-session-routing-transcript-separation-and-reset-semantics.md`
- `docs/decisions/0004-gateway-control-plane-and-protocol-contract.md`
- OpenClaw Agent runtime architecture: `https://docs.openclaw.ai/agent-runtime-architecture/`
- OpenClaw Agent runtimes: `https://docs.openclaw.ai/concepts/agent-runtimes`
- OpenClaw Agent harness plugins: `https://docs.openclaw.ai/plugins/sdk-agent-harness`
- OpenClaw Agent loop: `https://docs.openclaw.ai/concepts/agent-loop`
- OpenClaw Model providers: `https://docs.openclaw.ai/concepts/model-providers`
