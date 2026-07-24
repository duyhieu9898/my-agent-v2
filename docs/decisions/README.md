# Architecture Decisions

Decision records preserve lasting product, architecture, data ownership,
security, compatibility, and validation choices that future work must inherit.

Use `docs/templates/decision.md`. Task-local implementation choices remain in
an active execution plan and do not require a separate ADR.

The repository is the system of record. Chat history, implementation plans, and
OpenClaw documentation may provide context, but they do not override an
accepted local decision unless that decision is superseded by another ADR.

## Decision index

| ADR | Status | Decision |
|---|---|---|
| [0001](./0001-modular-monolith-and-openclaw-alignment.md) | Accepted | Begin as a modular monolith under `src/`; use OpenClaw as a reference architecture rather than an implementation dependency. |
| [0002](./0002-core-runtime-identities-and-agent-ownership.md) | Accepted | Keep `agentId`, `sessionKey`, `sessionId`, `runId`, `attemptId`, and `connectionId` distinct, with explicit creation and ownership authority. |
| [0003](./0003-session-routing-transcript-separation-and-reset-semantics.md) | Accepted | Separate logical session routing from transcript instances; reset preserves `sessionKey` and advances to a new `sessionId`. |
| [0004](./0004-gateway-control-plane-and-protocol-contract.md) | Accepted | Use one long-lived HTTP/WebSocket Gateway with typed `req`, `res`, and `event` frames, mandatory `connect`, version negotiation, validation, and refreshable client state. |
| [0005](./0005-agent-runtime-harness-and-model-provider-boundaries.md) | Accepted | Keep Agent Runtime orchestration, Agent Harness execution, and model-provider transport as separate boundaries and selections. |
| [0006](./0006-run-attempt-lifecycle-and-per-session-serialization.md) | Accepted | Define run and attempt lifecycles and serialize transcript-affecting work through a FIFO lane per logical session. |
| [0007](./0007-context-assembly-and-transcript-mutation-authority.md) | Accepted | Treat model context as a per-call projection; keep `TranscriptStore` as durable transcript authority and restrict durable mutation to application-owned lifecycle paths. |
| [0008](./0008-tool-runtime-policy-approval-and-sandbox-boundaries.md) | Accepted | Route model-requested capabilities through Tool Runtime; keep policy, approval, and sandbox as separate fail-closed enforcement boundaries. |
| [0009](./0009-storage-ownership-sqlite-and-migration-policy.md) | Accepted | Use one V1 SQLite database behind domain store contracts and evolve persistent state through versioned, tested migrations. |
| [0010](./0010-runtime-events-logs-transcripts-and-audit-separation.md) | Accepted | Keep runtime events, Gateway projections, technical logs, transcripts, diagnostics, and audit records as distinct data products. |
| [0011](./0011-platform-and-browser-runtime-boundaries.md) | Accepted | Isolate host operating-system capabilities behind Platform adapters and browser automation behind an independent stateful Browser Runtime. |
| [0012](./0012-plugin-registration-and-public-extension-boundary.md) | Accepted | Register built-in and future optional capabilities through typed registries; separate manifest metadata from trusted runtime modules and expose only public extension contracts. |
| [0013](./0013-control-ui-and-session-presentation-surfaces.md) | Accepted | Treat the Control UI as a Gateway client and future boards/widgets as sandboxed presentation state owned by `agentId + sessionKey`, independent of transcript reset. |

## Dependency order

The foundational decisions should normally be read in this order:

```text
0001  Repository and architectural style
  └─ 0002  Identities and agent ownership
       ├─ 0003  Session routing and transcript identity
       │    ├─ 0004  Gateway protocol
       │    └─ 0009  Storage and migrations
       └─ 0005  Agent Runtime, Harness, and providers
            └─ 0006  Run and attempt lifecycle
                 ├─ 0007  Context and transcript mutation
                 ├─ 0008  Tools, policy, approval, sandbox
                 └─ 0010  Events, logs, transcripts, audit
                      ├─ 0011  Platform and Browser Runtime
                      ├─ 0012  Plugins and extension contracts
                      └─ 0013  Control UI and presentation surfaces
```

This graph communicates the recommended reading and implementation order. The
`Related decisions` section inside each ADR remains authoritative for its exact
local dependencies.

## Cross-decision invariants

Implementation and execution plans must preserve these accepted invariants:

- `src/bootstrap/` is the composition root and the only place that wires concrete implementations.
- Gateway transport does not own agent execution, session business rules, transcripts, providers, tools, browser behavior, platform behavior, or SQLite access.
- Durable agent, session, run, and transcript identity is never inferred from a transient Gateway connection.
- `sessionKey` is a stable logical route; `sessionId` identifies one transcript instance.
- A run keeps the resolved `sessionId` captured at admission and cannot silently move after reset.
- Transcript-affecting work is serialized per logical session and durable state is committed before terminal success is announced.
- Model context is assembled from canonical state; pruning and provider adaptation do not rewrite canonical transcript history.
- Every model-requested side effect passes through Tool Runtime and applicable policy, approval, and sandbox controls.
- Domain modules depend on store contracts, not SQLite or Gateway handlers.
- Events, logs, transcripts, and audit records cannot substitute for one another.
- Platform-specific and browser-provider-specific behavior remains behind normalized contracts.
- Optional implementations register capabilities through registries; core does not special-case individual plugins.
- UI and future widgets access backend capabilities only through published Gateway and capability contracts.

## OpenClaw reference policy

OpenClaw is a reference architecture, not an upstream framework dependency.

When an implementation plan touches an OpenClaw-inspired boundary:

1. Start from the accepted local ADR and the active `my-agent-v2` requirement.
2. Check current official OpenClaw documentation or source for lifecycle and failure-mode changes.
3. Preserve the smaller local scope unless a new requirement justifies expansion.
4. Record any material change to an accepted invariant in a new ADR.
5. Do not silently edit an accepted ADR to hide a changed decision; supersede it when the decision itself changes.

Documentation drift in OpenClaw does not automatically invalidate a local ADR.
It only triggers a new decision when the local architecture should change.

## Adding or changing decisions

Create a new ADR when a change:

- reverses a dependency direction;
- merges boundaries currently declared separate;
- changes durable identity, routing, reset, or ownership semantics;
- changes Gateway framing, handshake, versioning, or externally visible compatibility;
- changes transcript mutation authority, run serialization, or terminal ordering;
- changes policy, approval, sandbox, or plugin trust authority;
- changes storage topology or migration ownership;
- exposes a new public plugin, UI, protocol, or SDK contract;
- introduces a second process, remote execution, multi-user authorization, or distributed coordination.

Use the next sequential filename:

```text
0014-<decision-title>.md
```

An ADR must include at least:

- title;
- status;
- date;
- context;
- decision;
- consequences;
- risks or trade-offs;
- rejected alternatives;
- validation;
- revisit conditions;
- references to related architecture and decisions.

## Review status

The accepted ADR set `0001` through `0013` was cross-reviewed on
**2026-07-24** against `docs/ARCHITECTURE.md`, the other accepted ADRs, and the
current official OpenClaw architecture references used by each record.

No accepted local invariant requires revision from that review. Future
implementation work should now proceed through an execution plan rather than
adding speculative architecture abstractions.
