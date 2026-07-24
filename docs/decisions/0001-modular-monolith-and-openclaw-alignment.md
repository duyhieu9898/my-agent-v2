# ADR 0001: Modular Monolith and OpenClaw Alignment

- **Status:** Accepted
- **Date:** 2026-07-24
- **Decision owners:** my-agent-v2 maintainers
- **Related architecture:** `docs/ARCHITECTURE.md`

## Context

`my-agent-v2` is intended to remain small, local-first, Linux-first, and single-user in its initial versions, while preserving enough architectural structure to adopt additional capabilities later.

OpenClaw provides useful architectural concepts and terminology, including:

- Gateway as the control plane;
- Agent Runtime separated from transport;
- typed request, response, and event protocols;
- session routing separated from transcript history;
- agent harnesses and model-provider boundaries;
- registry-based plugin capabilities;
- Control UI as a Gateway client;
- per-agent workspace, policy, credentials, and session ownership.

Copying or forking the full OpenClaw implementation would import complexity that is not required for the current scope, including messaging channels, remote nodes, device pairing, dynamic plugins, multi-agent routing, and broad configuration surfaces.

At the same time, building `my-agent-v2` as a collection of tightly coupled scripts would make future OpenClaw-inspired features expensive to add.

## Decision

`my-agent-v2` will begin as a **modular monolith**.

The main Node.js implementation lives in:

```text
src/
```

Subsystems are separated through:

- explicit module ownership;
- contracts and interfaces;
- runtime-validated external boundaries;
- one-way dependency rules;
- composition in `src/bootstrap/`;
- tests at module and integration boundaries.

The project will align with OpenClaw at the level of:

- terminology;
- responsibility boundaries;
- lifecycle concepts;
- protocol envelopes;
- extension seams;
- failure-handling concepts.

The project will not attempt to copy:

- the full OpenClaw source layout;
- every OpenClaw subsystem;
- all protocol methods;
- the complete plugin framework;
- the complete channel or node model;
- operational complexity that is not required by active product goals.

## Repository placement rules

### `src/`

Contains the main modular-monolith implementation.

Examples:

```text
src/gateway/
src/agents/
src/models/
src/sessions/
src/context/
src/policy/
src/platform/
src/browser/
src/plugins/
src/storage/
```

### `ui/`

Contains the browser Control UI.

The UI communicates through the Gateway protocol and does not import backend implementation modules.

### `apps/`

Contains independently runnable native or platform applications.

Examples:

```text
apps/linux/
apps/windows/
apps/macos/
```

The Gateway and Agent Runtime do not belong in `apps/`.

### `packages/`

Contains stable reusable contracts and libraries only after extraction is justified.

Potential future examples:

```text
packages/gateway-protocol/
packages/gateway-client/
packages/agent-core/
packages/plugin-sdk/
```

A module must not be moved to `packages/` merely to make the repository look modular.

### `extensions/`

Contains optional integrations and future externally loadable capabilities.

Dynamic extension loading is not required in V1.

## Package extraction criteria

A module may be extracted from `src/` to `packages/` when one or more of the following applies:

1. Multiple independently runnable applications require it.
2. It represents a stable wire protocol or SDK.
3. It requires independent versioning.
4. It isolates a substantial dependency.
5. It must be exposed to plugins or external clients.
6. Its contract is stable enough to support consumers outside the root application.

Extraction requires a dedicated ADR or an execution plan that references this decision.

## OpenClaw alignment policy

When studying an OpenClaw subsystem, implementation work must proceed in this order:

1. Define the active `my-agent-v2` requirement.
2. Identify the equivalent OpenClaw boundary and terminology.
3. Review OpenClaw documentation and relevant source areas.
4. Compare lifecycle, failure modes, and extension points.
5. Define the smallest compatible contract for `my-agent-v2`.
6. Implement only the required behavior.
7. Add tests that protect the chosen boundary.
8. Record material deviations in an ADR.

OpenClaw is a reference architecture, not an upstream framework dependency.

## Dependency rule

The intended top-level dependency direction is:

```text
index
→ bootstrap
→ Gateway and concrete infrastructure
→ application/runtime contracts
→ domain contracts
```

Forbidden dependency examples include:

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

Cross-module imports must follow ownership rather than convenience.

## Consequences

### Positive

- The project remains understandable and small.
- Future OpenClaw-inspired modules have clear insertion points.
- Windows, multi-agent, additional harnesses, channels, and plugins can be added without replacing the core architecture.
- Testing and refactoring remain simpler than in a prematurely distributed system.
- Codex CLI and the harness have explicit architectural guardrails.

### Negative

- Some interfaces may initially have only one implementation.
- Internal module boundaries require discipline because the compiler does not automatically enforce every dependency rule.
- Some code may need later extraction into packages.
- The repository will not mirror OpenClaw file-for-file.

### Risks

- Creating abstractions without active consumers can lead to over-engineering.
- Allowing convenience imports across boundaries can gradually erase modularity.
- Treating OpenClaw as a code template rather than a reference can import unnecessary complexity.

These risks are mitigated by vertical-slice implementation plans, architecture tests or lint rules where useful, and ADR review for material boundary changes.

## Rejected alternatives

### Fork OpenClaw

Rejected because it would inherit a large feature set, configuration surface, dependency graph, and update burden outside the current product scope.

### Clone OpenClaw and remove features

Rejected because deleting features does not remove the architectural assumptions and coupling that supported them.

### Build unrelated scripts first and redesign later

Rejected because session identity, Gateway protocol, policy, tools, and browser ownership would become difficult to untangle.

### Split every module into a workspace package immediately

Rejected because package boundaries would be speculative and would add build and dependency-management overhead before contracts stabilize.

### Start with multiple processes

Rejected because process separation is not currently required for reliability, security, or independent deployment.

## Validation

This decision is considered correctly applied when:

- primary implementation remains under `src/`;
- new modules have documented ownership;
- Gateway, Agent Runtime, providers, tools, storage, platform, and browser boundaries remain distinct;
- no package is introduced without a clear extraction reason;
- execution plans reference `docs/ARCHITECTURE.md`;
- material deviations are recorded in `docs/decisions/`;
- tests cover external and cross-module boundaries.

## Revisit conditions

Revisit this decision when:

- a subsystem must be shared by multiple applications;
- plugin-facing contracts need to be published;
- the Gateway protocol must be consumed outside the monorepo;
- a subsystem needs independent deployment or failure isolation;
- build performance or dependency isolation requires package extraction;
- the project introduces remote or distributed execution.
