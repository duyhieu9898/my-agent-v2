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
| [0002](./0002-core-runtime-identities-and-agent-ownership.md) | Accepted | Keep core identities distinct; version agent definitions, separate availability from bootstrap state, and freeze one immutable agent revision per run. |
| [0003](./0003-session-routing-transcript-separation-and-reset-semantics.md) | Accepted | Separate logical session routing from transcript instances; reset preserves `sessionKey` and advances to a new `sessionId`. |
| [0004](./0004-gateway-control-plane-and-protocol-contract.md) | Accepted | Use one long-lived HTTP/WebSocket Gateway with typed `req`, `res`, and `event` frames, mandatory `connect`, version negotiation, validation, and refreshable client state. |
| [0005](./0005-agent-runtime-harness-and-model-provider-boundaries.md) | Accepted | Separate Agent Runtime, step-oriented Harness, and providers; freeze a `ResolvedAgentSnapshot` per run and use native Gemini in V1. |
| [0006](./0006-run-attempt-lifecycle-and-per-session-serialization.md) | Accepted | Define the fixed stage pipeline, first-class `CheckpointStage`, cancellation-safe `FinalizeStage`, per-session FIFO lane, runtime budgets, and terminal ordering. |
| [0007](./0007-context-assembly-and-transcript-mutation-authority.md) | Accepted | Build a versioned host-owned Prompt Plan from typed sources, preserve structural history/provider continuation, and keep `TranscriptStore` as durable transcript authority. |
| [0008](./0008-tool-runtime-policy-approval-and-sandbox-boundaries.md) | Accepted | Route model capabilities through Tool Runtime; keep policy, approval, and sandbox separate; use conservative typed batch scheduling and progress signals. |
| [0009](./0009-storage-ownership-sqlite-and-migration-policy.md) | Accepted | Use one V1 SQLite database behind domain stores, versioned migrations, durable run evidence, and a bounded session runtime summary projection. |
| [0010](./0010-runtime-events-logs-transcripts-and-audit-separation.md) | Accepted | Keep events, logs, prompt/stage/checkpoint evidence, durable journals, artifacts, transcripts, diagnostics, and audit records distinct. |
| [0011](./0011-platform-and-browser-runtime-boundaries.md) | Accepted | Isolate platform capabilities and use an independent Browser Runtime whose V1 provider is the in-process Playwright library controlling Chromium. |
| [0012](./0012-plugin-registration-and-public-extension-boundary.md) | Accepted | Register built-in and future optional capabilities through typed registries; separate manifest metadata from trusted runtime modules and expose only public extension contracts. |
| [0013](./0013-control-ui-and-session-presentation-surfaces.md) | Accepted | Treat the Control UI as a Gateway client and future boards/widgets as sandboxed presentation state owned by `agentId + sessionKey`, independent of transcript reset. |
| [0014](./0014-memory-ownership-retrieval-and-evolution.md) | Accepted | Add explicit per-agent curated memory with provenance, SQLite FTS5 retrieval, frozen per-run recall snapshots, Tool Runtime writes, and Run Journal evidence. |
| [0015](./0015-usage-accounting-and-cumulative-budget-enforcement.md) | Accepted | Persist model-call usage and enforce optional cumulative token/cost caps through atomic reserve–dispatch–settle accounting with versioned pricing and explicit uncertain state. |
| [0016](./0016-fs-safe-workspace-filesystem-boundary.md) | Accepted | Use fs-safe as the root-bounded workspace filesystem capability while retaining stricter project path policy and create/write tool semantics. |

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
                 │    └─ 0016  fs-safe workspace filesystem boundary
                 └─ 0010  Events, logs, Run Journal, transcripts, audit
                      ├─ 0011  Platform and Browser Runtime
                      ├─ 0012  Plugins and extension contracts
                      ├─ 0013  Control UI and presentation surfaces
                      ├─ 0014  Memory ownership, retrieval, and evolution
                      └─ 0015  Usage accounting and cumulative budgets

0016 also depends on 0011 for platform-boundary ownership.
```

This graph communicates the recommended reading and implementation order. The
`Related decisions` section inside each ADR remains authoritative for its exact
local dependencies.

## Cross-decision invariants

Implementation and execution plans must preserve these accepted invariants:

- `src/bootstrap/` is the composition root and the only place that wires concrete implementations.
- Gateway transport does not own agent execution, session business rules, transcripts, providers, tools, browser behavior, platform behavior, or SQLite access.
- Durable agent, session, run, and transcript identity is never inferred from a transient Gateway connection.
- Every run freezes one immutable `ResolvedAgentSnapshot` with `agentRevision`, resource manifest, model/harness route, and tool/policy/sandbox fingerprints.
- Agent availability and bootstrap state are explicit; an explicitly invalid agent never silently falls back to `primary`.
- Agent resource roles, precedence, mutability, truncation, and hashes are typed and observable; required identity/rule resources are never silently truncated.
- Every model call uses host-owned `ContextManifest → PromptPlan → PreparedModelContext` with explicit `main-v1`, deterministic section order, authority/trust/stability/budget classes, and provider projection evidence.
- Prompt files, skills, memory, provider output, and untrusted data cannot register tools, grant capability, replace policy, or create authorization through prompt position.
- `sessionKey` is a stable logical route; `sessionId` identifies one transcript instance.
- transcript order uses store-assigned per-session sequence, bounded opaque cursors, and atomic structural append batches;
- accepted prompts are never merged, evicted, or silently dropped; a full session queue rejects new work before acceptance;
- A run keeps the resolved `sessionId` captured at admission and cannot silently move after reset.
- Transcript-affecting work is serialized per logical session and durable state is committed before terminal success is announced.
- Model context is assembled from canonical state; V1 source-guards oversized tool output and deterministically soft-prunes eligible old tool-heavy request projections without rewriting canonical visible transcript history. Hard clear is disabled by default, and post-pruning overflow fails explicitly. Required Gemini typed steps and opaque continuation survive through owned sidecar records.
- Application caching is process-local, rebuildable, and keyed by source revisions/content hashes; it never grants policy or durable-state authority. Gemini prompt caching is implicit provider optimization only, with no explicit cache object or cache ID.
- Curated memory is separate from transcript, agent resources, Run Journal, and audit; it is per-agent, provenance-bearing, explicitly mutated, and recalled through a frozen per-run snapshot.
- Every provider model call passes through durable usage reservation and settlement; Usage Ledger authority, run-local budgets, runtime capacity, and provider external quota remain distinct.
- Every model-requested side effect passes through Tool Runtime and applicable policy, approval, and sandbox controls.
- Domain modules depend on store contracts, not SQLite or Gateway handlers.
- Runtime events, technical logs, Run Journal evidence, debug artifacts, transcripts, and audit records cannot substitute for one another.
- Each accepted run is traceable through a durable per-run journal ordered by `runId + sequence`; Pino text is not the verification API.
- Agent Runtime uses a fixed V1 stage pipeline; only `CheckpointStage` may authorize another cycle or attempt.
- `FinalizeStage` runs exactly once on completion, failure, timeout, and cancellation before session-lane release.
- Tool Runtime may execute only explicitly read-only, parallel-safe batches concurrently and returns progress signals rather than continuation decisions.
- Development evidence is cleared explicitly, pinned evidence is protected, and session reset does not delete run evidence.
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
- changes durable identity, agent revision, resource-role, precedence, bootstrap, routing, reset, or ownership semantics;
- changes Gateway framing, handshake, versioning, or externally visible compatibility;
- changes transcript mutation authority, run serialization, terminal ordering, required Run Journal evidence, or evidence retention semantics;
- changes memory ownership, provenance, write authority, retrieval mode, recall snapshot, retention, or consolidation semantics;
- changes prompt-profile selection, section authority/trust classes, protected budgets, source-to-section semantics, provider/Harness prompt ownership, durable compaction, or whether pruning may remove normal conversation;
- makes a cache authoritative, introduces shared/persistent cache consistency, or adopts explicit provider cache identities;
- changes usage-ledger authority, cumulative cap scope/windows, pricing semantics, reservation/settlement ordering, or ambiguous-dispatch handling;
- changes policy, approval, sandbox, or plugin trust authority;
- changes storage topology or migration ownership;
- exposes a new public plugin, UI, protocol, or SDK contract;
- introduces a second process, remote execution, multi-user authorization, or distributed coordination.

Use the next sequential filename:

```text
0016-<decision-title>.md
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

The accepted ADR set `0001` through `0015` was cross-reviewed on
**2026-07-24** against `docs/ARCHITECTURE.md`, the other accepted ADRs, and the
current official OpenClaw architecture references used by each record.

The set was subsequently amended on **2026-07-24** to make development-first observability and a durable per-run Run Journal an explicit V1 requirement across ADR 0006, ADR 0009, ADR 0010, and `docs/ARCHITECTURE.md`. It was also amended to pin the native Gemini V1 integration across ADR 0005, ADR 0007, ADR 0009, ADR 0010, and `docs/ARCHITECTURE.md`: `@google/genai`, Interactions API, API-key authentication, `gemini-3.5-flash`, stateless `store=false`, and durable opaque continuation sidecars.

The set was further amended on **2026-07-24** to make the fixed Agent Runtime stage pipeline, first-class `CheckpointStage`, cancellation-safe `FinalizeStage`, conservative tool-batch scheduling, stage/normalization evidence, runtime budgets, and bounded session runtime summary explicit V1 requirements, informed by GoClaw's pipeline design.

It was then amended on **2026-07-24** to make agent definitions versioned and reproducible: one immutable `ResolvedAgentSnapshot` per run, explicit resource roles and precedence, separate availability/bootstrap state, deterministic resource truncation evidence, and no silent self-evolution or invalid-agent fallback. This refinement was informed by GoClaw's agent-resource model while retaining the smaller local-first V1 scope.

The set was further extended on **2026-07-24** with ADR 0014 to make a small, explicit memory boundary part of V1: per-agent curated memory, provenance and supersession, SQLite FTS5 search, one frozen recall snapshot per run, Tool Runtime and policy-controlled mutation, and Run Journal evidence. Automatic episodic extraction, embeddings, semantic graphs, passive memory, and background consolidation remain deferred. This refinement was informed by GoClaw's separation of memory from sessions while intentionally avoiding its larger PostgreSQL/pgvector three-tier worker topology.

The accepted set was then refined on **2026-07-24** to make prompt construction observable and host-owned: typed context sources produce `ContextManifest`, versioned `PromptPlan`, and structured immutable `PreparedModelContext`; V1 uses explicit `main-v1`; sections carry authority, trust, stability, and budget classes; protected sections fail rather than truncate silently; untrusted data cannot create capability; and provider projection records hashes without becoming prompt authority. This was informed by GoClaw System Prompt Anatomy and Context Files while avoiding fixed section counts, implicit modes, monolithic prompt assembly, and file-based runtime authority.

The set was further refined on **2026-07-24** after reviewing GoClaw Context Pruning and Caching. V1 now requires deterministic non-destructive pruning for eligible tool-heavy request projections, source-level artifact-backed output guards, structural-group protection, bounded Gemini-aware token measurement, and explicit overflow after pruning; durable compaction remains deferred. Application caching is limited to revision/hash-keyed in-memory rebuildable data with no security authority or Redis, while Gemini Interactions uses provider implicit prompt caching only and records cached-token evidence without explicit cache objects.

The set was extended on **2026-07-24** with ADR 0015 to make provider usage accounting and cumulative budget enforcement durable V1 foundations: normalized provider usage/billing certainty, versioned operator pricing, global/agent/provider/model token and cost caps over UTC day/month windows, and atomic reserve–dispatch–settle transactions with conservative uncertain state after ambiguous dispatch. Run-local budgets, capacity permits, provider external quota, and future request quotas remain distinct. This refinement was informed by GoClaw Usage & Quota while intentionally avoiding multi-tenant billing, channel/user quotas, Redis/PostgreSQL counters, and automatic provider-billing reconciliation.

Future implementation work should proceed through an execution plan rather than adding speculative architecture abstractions.
