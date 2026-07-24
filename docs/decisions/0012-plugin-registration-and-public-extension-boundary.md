# ADR 0012: Plugin Registration and Public Extension Boundary

- **Status:** Accepted
- **Date:** 2026-07-24
- **Decision owners:** my-agent-v2 maintainers
- **Related architecture:** `docs/ARCHITECTURE.md`
- **Related decisions:**
  - `docs/decisions/0001-modular-monolith-and-openclaw-alignment.md`
  - `docs/decisions/0002-core-runtime-identities-and-agent-ownership.md`
  - `docs/decisions/0004-gateway-control-plane-and-protocol-contract.md`
  - `docs/decisions/0005-agent-runtime-harness-and-model-provider-boundaries.md`
  - `docs/decisions/0007-context-assembly-and-transcript-mutation-authority.md`
  - `docs/decisions/0008-tool-runtime-policy-approval-and-sandbox-boundaries.md`
  - `docs/decisions/0009-storage-ownership-sqlite-and-migration-policy.md`
  - `docs/decisions/0010-runtime-events-logs-transcripts-and-audit-separation.md`
  - `docs/decisions/0011-platform-and-browser-runtime-boundaries.md`

## Context

`my-agent-v2` needs to add optional capabilities without making core modules import and special-case every integration.

Potential capabilities include:

```text
tools
runtime hooks
model providers
agent harnesses
browser providers
channels
Gateway methods
HTTP routes
background services
skills and resource loaders
future Control UI surfaces
```

V1 does not need dynamic plugin installation or third-party code loading. It does, however, need an extension direction that prevents built-in implementations from becoming hard-coded dependencies throughout the Agent Runtime, Gateway, Tool Runtime, and other core modules.

Without an explicit extension boundary, the repository may drift into patterns such as:

- core modules importing optional integrations directly;
- `switch` statements keyed by plugin or provider name;
- extensions importing arbitrary `src/**` implementation files;
- configuration validation requiring execution of plugin code;
- plugin code mutating registries after consumers have begun work;
- runtime registration disagreeing with declared metadata;
- duplicate tool, provider, method, route, or harness ownership being resolved by load order;
- plugin tools bypassing policy, approval, sandbox, or runtime-event contracts;
- plugin Gateway methods bypassing protocol schemas and method registries;
- plugin HTTP routes receiving unrestricted access to internal server state;
- treating a data-only skill as trusted executable code;
- assuming native plugins are sandboxed merely because their tools may execute in a sandbox;
- loading a candidate before validating its path, ownership, configuration, and compatibility;
- exposing unstable internal helper modules as a de facto plugin SDK.

OpenClaw currently provides useful reference principles:

- plugin discovery and configuration are manifest-first;
- manifest metadata can be inspected and validated without executing plugin runtime code;
- the runtime module registers executable behavior into central registries;
- the rest of the system consumes registry records instead of special-casing each plugin;
- plugin SDK imports use narrow public subpaths rather than arbitrary core internals;
- declared capability ownership and runtime registration are checked for alignment;
- candidate path and ownership safety gates run before native runtime execution;
- native plugins execute in-process and therefore share the host process trust boundary;
- cold manifest inspection and live runtime inspection are different operations;
- compatible content bundles are distinct from native executable plugins.

`my-agent-v2` adopts these boundary and trust principles while intentionally deferring OpenClaw's broader plugin inventory, package installation, dynamic discovery, compatibility catalog, setup system, and hot-reload behavior.

## Decision

`my-agent-v2` uses a one-way, registry-based capability model.

```text
built-in module or future plugin runtime
→ declares and registers capability
→ capability-specific registry
→ core runtime consumes registered contract
```

Core modules must depend on capability contracts and registries, not on individual optional implementations.

V1 uses static registration of trusted built-in modules during bootstrap. Future native plugins must follow the same registration direction through a public extension contract.

## Extension layers

The extension architecture has four conceptual layers:

```text
manifest or static descriptor
→ enablement and validation
→ runtime registration
→ capability consumption
```

### Manifest or static descriptor

Metadata describes identity, configuration, declared capability ownership, compatibility, and activation intent without executing runtime behavior.

### Enablement and validation

The host decides whether a capability source is configured, compatible, allowed, selected, or blocked before exposing it to runtime consumers.

### Runtime registration

A trusted runtime module registers concrete behavior through typed registration APIs.

### Capability consumption

Gateway, Agent Runtime, Tool Runtime, model runtime, Browser Runtime, and other consumers resolve contracts from registries.

These layers must not collapse into one unrestricted import-and-execute step.

## V1 static registration

V1 does not implement dynamic plugin discovery or loading.

Bootstrap explicitly imports trusted built-in registration modules and invokes them while constructing the application:

```text
load and validate config
→ construct empty registries
→ register built-in capabilities
→ validate registry invariants
→ freeze or publish registry snapshots
→ construct runtime consumers
→ start Gateway
```

A built-in integration should register through the same capability-specific APIs expected for future plugins where practical.

Example direction:

```ts
registerBuiltInCapabilities({
  tools,
  modelProviders,
  harnesses,
  browserProviders,
  hooks,
});
```

This does not require a generic plugin loader, package manifest, install database, or external SDK in V1.

Static registration must not become permission for consumers to import concrete built-in implementations directly.

## Manifest as control-plane metadata

A future executable plugin must provide a data-only manifest or equivalent descriptor that can be read without importing or executing its runtime module.

The manifest may declare:

```text
plugin identity
version
host compatibility
configuration schema
configuration UI hints
capability ownership
activation metadata
setup or onboarding metadata
runtime entrypoint references
catalog metadata
future UI contribution metadata
```

The manifest is authoritative for cold inspection and configuration validation.

It must not contain executable behavior or replace runtime registration.

The host must be able to:

- identify a plugin;
- validate plugin-specific configuration;
- report missing, disabled, incompatible, or blocked plugins;
- discover declared capability ownership;
- show setup or catalog metadata;
- plan activation;

without executing plugin code.

V1 built-ins may use typed static descriptors instead of filesystem manifests. When dynamic plugins are introduced, the external manifest format requires a dedicated contract and versioning decision.

## Runtime module as data-plane behavior

A future plugin runtime module registers executable behavior through a host-provided API.

Conceptually:

```ts
interface PluginModule {
  register(api: PluginRegistrationApi): void | Promise<void>;
}
```

The registration API exposes only intentional host contracts.

A plugin runtime may register supported capability types such as:

```text
tools
hooks
model providers
agent harnesses
browser providers
channels
Gateway methods
HTTP routes
services
skills or resource loaders
```

Registration does not grant unrestricted access to all host internals.

The plugin runtime must not mutate bootstrap state, application configuration, storage, Gateway internals, or another plugin's registry records except through explicit APIs.

## Capability-specific registries

The host uses capability-specific registries rather than one untyped object bag.

Expected registry boundaries include:

```text
Tool Registry
Model Provider Registry
Harness Registry
Browser Provider Registry
Hook Registry
future Channel Registry
Gateway Method Registry
HTTP Route Registry
Service Registry
Resource or Skill Registry
```

Each registry owns:

- capability identifier validation;
- duplicate detection;
- typed registration records;
- compatibility checks relevant to that capability;
- lookup and enumeration;
- optional snapshot publication;
- deterministic diagnostics.

A top-level Plugin Registry may retain plugin identity, metadata, source, status, and the capability records contributed by each plugin. It does not replace capability-specific registries.

## Ownership and collision rules

Capability identifiers must have deterministic ownership.

The default rule is fail-closed:

- duplicate tool names are rejected;
- duplicate provider IDs are rejected;
- duplicate harness IDs are rejected;
- duplicate browser-provider IDs are rejected;
- duplicate Gateway method names are rejected;
- conflicting HTTP route ownership is rejected;
- duplicate service IDs are rejected;
- exclusive slots must select exactly one valid implementation.

Load order must not silently decide ownership.

Intentional replacement, preference, aliases, or compatibility shims require an explicit contract rather than accidental last-registration-wins behavior.

Plugin and capability identifiers are stable compatibility surfaces once exposed in persistent configuration or the Gateway protocol.

## Registration and runtime snapshots

Registries are mutable only during a controlled registration phase.

Before runtime consumers start, bootstrap validates registry invariants and publishes stable registry instances or immutable snapshots.

Consumers must not observe partially registered capability sets.

V1 requires restart or full application reconstruction to change registered capabilities.

Hot registration, unloading, and plugin-only reload are deferred. They require lifecycle contracts for:

- active runs;
- open provider sessions;
- background services;
- hooks;
- Gateway methods and routes;
- configuration snapshots;
- cleanup and rollback.

## Plugin lifecycle

A future executable plugin lifecycle is conceptually:

```text
discover metadata
→ validate candidate and configuration
→ decide enablement
→ load trusted runtime module
→ register capabilities
→ validate registry alignment
→ start plugin-owned services
→ consume capabilities
→ stop services
→ dispose plugin resources
```

Registration and service startup are separate phases.

A plugin must not start background work merely because its module was imported for inspection or registry construction.

Plugin-owned services must expose explicit start and stop lifecycle methods and participate in application shutdown.

Failure to register or start one enabled plugin must produce a structured startup error. Silent partial activation is not allowed unless the capability is explicitly optional and diagnostics identify the degraded state.

## Public extension contract

Future external extensions must import only published contracts or SDK entrypoints.

They must not import:

```text
src/** internal implementation
bootstrap composition
concrete SQLite stores
Gateway connection internals
private provider adapters
another plugin's internal files
build output paths not declared public
```

The public extension surface should use narrow, capability-oriented entrypoints instead of one broad barrel exporting the whole host.

Potential future package layout:

```text
packages/plugin-sdk/core
packages/plugin-sdk/tools
packages/plugin-sdk/models
packages/plugin-sdk/harnesses
packages/plugin-sdk/hooks
packages/plugin-sdk/gateway
packages/plugin-sdk/browser
packages/plugin-sdk/testing
```

Actual package extraction occurs only when ADR 0001 criteria are met.

A contract becomes public only when it is deliberately exported, documented, versioned, and tested for external consumers.

Internal TypeScript exportability does not make a symbol part of the plugin SDK.

## Dependency direction

The allowed direction is:

```text
plugin or built-in registration module
→ public capability contracts
→ capability registry
→ core consumer
```

Forbidden directions include:

```text
core consumer → individual plugin implementation
plugin → arbitrary src/** implementation
plugin A → plugin B internal module
plugin → bootstrap
plugin → direct Gateway connection state
plugin → concrete SQLite database
plugin → bypassed Tool Runtime or Policy Engine
```

When two extensions need the same behavior, the shared contract must be promoted to a neutral host capability or public SDK surface. One plugin must not become another plugin's undocumented library.

## Gateway contributions

Plugin-provided Gateway methods must register through the Gateway method schema and handler registries established by ADR 0004.

They require:

- a stable namespaced method identifier;
- TypeBox request and response schemas;
- normal protocol validation;
- capability discovery metadata;
- structured errors;
- policy or authorization integration when needed;
- lifecycle-safe handler ownership.

A plugin must not intercept raw WebSocket frames or mutate connection state directly.

Plugin-provided HTTP routes must register through an explicit route API with:

- namespaced paths;
- declared methods;
- collision detection;
- request size and content constraints;
- authentication and origin policy when introduced;
- clear ownership and disposal.

A plugin must not receive the raw internal HTTP server object unless a later ADR explicitly widens that trust surface.

## Tool and runtime contributions

Plugin-provided tools remain governed by ADR 0008.

Registration of a tool does not bypass:

```text
schema validation
visibility filtering
policy evaluation
approval
sandbox or execution-target constraints
timeout and cancellation
runtime events
result normalization
```

Plugin-provided model providers and harnesses remain governed by ADR 0005.

Plugin-provided browser providers remain governed by ADR 0011.

Plugin hooks may observe or modify only the lifecycle stages and data explicitly exposed by the hook contract. Hook ordering, mutation semantics, failure behavior, and timeout rules must be deterministic.

## Skills, bundles, and executable plugins

A skill is a data or instruction resource consumed during context assembly. It is not executable host code by default.

Compatible content bundles may contribute data-only resources such as:

```text
skills
prompt templates
configuration defaults
hook descriptions
MCP descriptors
```

A native executable plugin runs code in the host process and has a much broader trust impact.

The host must not treat these categories as equivalent merely because both are installed under `extensions/` or another shared directory.

Promoting a data-only bundle to executable code requires explicit trust, validation, and enablement.

## Trust and safety boundary

Future native plugins execute in-process unless a later ADR introduces process or sandbox isolation.

Therefore, an enabled native plugin is trusted at approximately the same process boundary as core code. It may be capable of reading process memory, environment variables, filesystem data, or network resources available to the host process.

Tool sandboxing does not sandbox the plugin's registration code, hooks, services, HTTP handlers, or provider implementation.

Before runtime code is loaded, dynamic discovery must validate at least:

```text
resolved entry remains inside the allowed plugin root
path ownership and permissions
manifest identity and schema
configured allow or deny policy
host and SDK compatibility
entrypoint existence and type
capability declarations
configuration validity
```

Unsafe or incompatible candidates are blocked before execution and produce diagnostics tied to the plugin identity and source path when known.

Dynamic loading of untrusted code is explicitly out of scope for V1.

## Configuration ownership

Each plugin owns the schema and interpretation of its plugin-specific configuration.

The host owns:

- top-level enablement and allow or deny policy;
- configuration parsing and schema validation;
- secret-reference resolution boundaries;
- diagnostics;
- immutable runtime configuration snapshots;
- reload policy.

Plugin configuration must not be accepted as unvalidated `unknown` data by runtime code.

Secrets should be passed as references or resolved through a narrow credential API rather than copied into manifests, logs, registry diagnostics, or Control UI metadata.

## Observability and diagnostics

The host records enough metadata to answer:

```text
which plugins are known
which are enabled or blocked
which source and version supplied them
which capabilities each declared
which capabilities each registered
why a candidate failed
whether runtime services started
```

Cold inspection reports metadata and configuration state without claiming that runtime behavior is active.

Live inspection may verify registered runtime surfaces and service state after the application has loaded the plugin.

Plugin logs use a scoped logger and remain subject to ADR 0010 secret-redaction and correlation rules.

## Deferred capabilities

This ADR does not authorize or require implementation of:

```text
dynamic plugin discovery
package installation or update
plugin marketplace
external plugin manifests
public plugin SDK packages
runtime unloading
hot reload
plugin process isolation
remote plugin execution
plugin signing
automatic dependency installation
third-party UI embedding
plugin-authored database migrations
```

Each capability must be introduced through a focused ADR or execution plan after its product requirement exists.

## Consequences

### Positive

- Built-in and future optional capabilities follow one dependency direction.
- Core runtimes remain independent from individual integrations.
- Manifest metadata can support validation and diagnostics without executing plugin code.
- Public contracts can evolve deliberately instead of exposing all internal modules.
- Duplicate capability ownership is detected deterministically.
- Tools, providers, harnesses, browsers, Gateway methods, and routes retain their owning runtime safeguards.
- V1 avoids the complexity and trust risk of dynamic third-party loading.
- Future plugin extraction does not require redesigning existing registries.

### Negative

- Some V1 built-ins use registration abstractions before external plugins exist.
- Capability registries and descriptors add boilerplate compared with direct imports.
- Public extension contracts will require compatibility discipline and dedicated testing.
- Dynamic plugin support later will need substantial discovery, lifecycle, security, and packaging work.
- Native in-process plugins cannot be presented as safely isolated from the host.

## Risks and trade-offs

### Premature generic plugin framework

A broad plugin API may be designed without real external consumers.

Mitigation:

- implement capability-specific registries only as active slices need them;
- keep V1 registration static;
- extract a public SDK only after contracts stabilize;
- avoid generic dependency injection containers or arbitrary service locators.

### Built-in bypasses

Developers may directly import a built-in implementation because it is available in the monorepo.

Mitigation:

- enforce dependency direction in review, lint rules, or architecture tests;
- place consumer-facing contracts in owning modules;
- compose concrete implementations only in bootstrap;
- test resolution using alternate fake implementations.

### Manifest and runtime drift

Declared capability ownership may not match runtime registration.

Mitigation:

- validate enabled plugin registrations against declarations;
- report undeclared, missing, or duplicate capability records;
- keep cold inspection and live inspection semantically distinct.

### Excessive plugin trust

Users may assume a plugin is constrained by tool policy or sandboxing.

Mitigation:

- state that native plugins are host-trusted in-process code;
- run discovery safety gates before execution;
- require explicit enablement;
- defer untrusted code loading until isolation is designed.

### Public SDK ossification

Publishing broad internal helpers may prevent core refactoring.

Mitigation:

- expose narrow capability-oriented entrypoints;
- classify private and experimental contracts explicitly;
- test exported surface inventories;
- require an ADR for material public-contract expansion.

### Registry as hidden global state

A mutable singleton registry could reintroduce global coupling.

Mitigation:

- construct registries in bootstrap;
- inject them into consumers;
- publish immutable snapshots before serving work;
- avoid module-level mutable registration state.

## Rejected alternatives

### Hard-code every optional integration in core modules

Rejected because it creates reverse dependencies, name-based branching, and invasive changes for every new capability.

### Implement dynamic plugin loading immediately

Rejected because V1 has no active requirement that justifies discovery, installation, compatibility, lifecycle, recovery, and security complexity.

### Let plugins import arbitrary `src/**` modules

Rejected because internal refactoring would become an accidental public compatibility promise and plugins could bypass policy, storage, and lifecycle boundaries.

### Use one untyped global plugin registry

Rejected because capability-specific validation, ownership, lookup, and lifecycle semantics would be lost.

### Resolve duplicate capability IDs by registration order

Rejected because behavior would depend on filesystem or import order and could change silently between environments.

### Treat manifest declarations as executable registration

Rejected because metadata cannot implement runtime behavior and should remain safe to inspect without code execution.

### Treat runtime registration as sufficient manifest metadata

Rejected because configuration validation, diagnostics, setup, compatibility, and capability ownership would require executing plugin code.

### Sandbox only plugin tools and call the entire plugin sandboxed

Rejected because registration code, hooks, services, providers, and HTTP handlers still execute outside tool-call sandbox boundaries.

### Make skills executable plugins by default

Rejected because instruction resources and native code have fundamentally different trust and lifecycle requirements.

### Expose a broad `plugin-sdk` barrel containing core internals

Rejected because it increases startup and circular-dependency risk and turns unstable implementation details into public API.

## Validation

This decision is correctly applied when:

- optional implementations register through capability-specific registries;
- core consumers resolve contracts from registries rather than importing individual integrations;
- bootstrap owns registry creation, registration, validation, and publication;
- registries are stable before the Gateway accepts work;
- duplicate capability IDs fail deterministically;
- built-in tool registration still passes through ADR 0008 Tool Runtime controls;
- built-in provider and harness registration still follows ADR 0005;
- browser-provider registration still follows ADR 0011;
- Gateway methods use TypeBox schemas and the normal method registry;
- HTTP routes use a namespaced, collision-checked registration contract;
- extension code does not import arbitrary `src/**` implementation paths;
- plugin-specific configuration is schema-validated before runtime registration;
- cold metadata inspection does not execute plugin runtime code;
- native plugin trust is documented as in-process host trust;
- data-only skills and bundles are not loaded as executable plugins;
- tests prove alternate implementations can be registered without changing consumers;
- tests reject duplicate or incompatible registration;
- no V1 feature depends on dynamic discovery, hot reload, or installation state.

## Revisit conditions

Revisit this decision when:

- the first third-party executable plugin is required;
- external extension contracts must be published from `packages/`;
- dynamic plugin discovery or installation is introduced;
- plugin code must run with less trust than the Gateway process;
- plugin signing or provenance verification is required;
- hot reload or runtime unloading becomes a product requirement;
- plugins need durable storage schemas or migrations;
- plugin-authored Control UI surfaces are introduced;
- multiple plugins need intentional ownership precedence or replacement rules;
- the host must support OpenClaw-compatible plugin or bundle formats;
- registry snapshots must change while active runs are executing;
- a plugin capability needs a new exclusive-slot or composition model.

## References

- `docs/ARCHITECTURE.md`, section 3, **Architectural style**
- `docs/ARCHITECTURE.md`, section 4, **Repository organization**
- `docs/ARCHITECTURE.md`, section 9, **Agent Runtime architecture**
- `docs/ARCHITECTURE.md`, section 10, **Model runtime and providers**
- `docs/ARCHITECTURE.md`, section 12, **Tool Runtime**
- `docs/ARCHITECTURE.md`, section 15, **Browser Runtime**
- `docs/ARCHITECTURE.md`, section 16, **Plugin and extension architecture**
- `docs/ARCHITECTURE.md`, section 21, **Lifecycle and composition**
- `docs/ARCHITECTURE.md`, section 22, **Dependency direction**
- `docs/ARCHITECTURE.md`, section 24, **Deferred capabilities**
- `docs/decisions/0001-modular-monolith-and-openclaw-alignment.md`
- `docs/decisions/0004-gateway-control-plane-and-protocol-contract.md`
- `docs/decisions/0005-agent-runtime-harness-and-model-provider-boundaries.md`
- `docs/decisions/0008-tool-runtime-policy-approval-and-sandbox-boundaries.md`
- `docs/decisions/0011-platform-and-browser-runtime-boundaries.md`
- OpenClaw, **Plugin architecture**: `https://docs.openclaw.ai/plugins/architecture`
- OpenClaw, **Plugin architecture internals**: `https://docs.openclaw.ai/plugins/architecture-internals/`
- OpenClaw, **Plugin manifest**: `https://docs.openclaw.ai/plugins/manifest`
- OpenClaw, **Plugin SDK overview**: `https://docs.openclaw.ai/plugins/sdk-overview`
- OpenClaw, **Building plugins**: `https://docs.openclaw.ai/plugins/building-plugins`
