# ADR 0014: Memory Ownership, Retrieval, and Evolution

- **Status:** Accepted
- **Date:** 2026-07-24
- **Decision owners:** my-agent-v2 maintainers
- **Related architecture:** `docs/ARCHITECTURE.md`
- **Related decisions:**
  - `docs/decisions/0002-core-runtime-identities-and-agent-ownership.md`
  - `docs/decisions/0005-agent-runtime-harness-and-model-provider-boundaries.md`
  - `docs/decisions/0006-run-attempt-lifecycle-and-per-session-serialization.md`
  - `docs/decisions/0007-context-assembly-and-transcript-mutation-authority.md`
  - `docs/decisions/0008-tool-runtime-policy-approval-and-sandbox-boundaries.md`
  - `docs/decisions/0009-storage-ownership-sqlite-and-migration-policy.md`
  - `docs/decisions/0010-runtime-events-logs-transcripts-and-audit-separation.md`

## Context

`my-agent-v2` needs to remember selected facts, preferences, decisions, project context, and procedures across sessions without confusing that knowledge with transcript history, versioned agent resources, or execution evidence.

The existing architecture already distinguishes:

```text
Transcript        durable ordered history for one sessionId
Agent resources   versioned identity, rules, user profile, skills, and managed inputs
Run Journal       durable evidence of how one run executed
```

Cross-session memory has a different lifecycle and authority:

- it may be derived from or refer to transcript evidence;
- it is selected for reuse across later runs or sessions;
- it may become stale or be superseded;
- it changes future model context and therefore is an externally observable side effect;
- its retrieval and mutation must be explainable in the development-first observability model.

GoClaw demonstrates a larger three-tier memory architecture using working documents, episodic summaries, semantic knowledge graph storage, hybrid full-text/vector search, and background consolidation workers. It also separates memory from session history, applies bounded automatic injection, records retrieval observability, and uses candidate review for passive extraction.

That design provides useful failure modes and boundaries, but its PostgreSQL, pgvector, background worker, automatic consolidation, knowledge graph, multi-tenant, and passive-channel scope is larger than V1 requires.

`my-agent-v2` therefore adopts the separation, provenance, bounded recall, and observability principles while starting with one explicit, curated, SQLite-backed memory tier.

## Decision

`src/memory/` owns durable cross-session memory contracts, retrieval, mutation semantics, validation, and memory-specific application services.

V1 implements:

```text
Curated Memory Store
+ explicit memory tools
+ SQLite FTS5 text search
+ bounded per-run recall
+ provenance and version history
+ Run Journal evidence
```

Memory remains optional per agent, but when enabled it follows the contracts in this decision.

## Boundary and ownership

Memory is not an alias for any existing record class.

| Record class | Authority |
|---|---|
| Transcript | What happened in one conversation transcript, in authoritative sequence |
| Agent resource | Host/user-managed identity, rules, profile, skills, and versioned configuration inputs |
| Run Journal | How one run executed and which decisions or versions it used |
| Curated memory | Selected knowledge intended for reuse in later runs or sessions |

Memory belongs to exactly one `agentId` in V1.

The configured agent definition selects:

```text
memory enabled or disabled
memory namespace
recall result limit
recall token budget
search-policy version
write-policy defaults
```

These settings are frozen in the run's `ResolvedAgentSnapshot`. The current memory contents are not copied into that snapshot.

Future multi-agent memory sharing, leader fallback, user-specific subnamespaces, or delegate access requires an explicit decision. V1 has one trusted local user and does not infer memory sharing from workspace or session access.

## V1 memory entry model

A committed memory entry includes at least:

```ts
interface MemoryEntry {
  readonly memoryId: string;
  readonly agentId: string;
  readonly revision: number;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly status: "active" | "superseded" | "deleted";
  readonly confidence: "explicit" | "inferred";
  readonly source: MemoryProvenance;
  readonly contentHash: string;
  readonly validFrom: string;
  readonly validUntil?: string;
  readonly supersedesMemoryId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

V1 memory kinds are:

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

The exact TypeScript representation may evolve, but these semantic fields remain explicit.

### Provenance

Every committed memory records its source classification and applicable references:

```text
user-explicit
agent-proposed
manual-import
```

Provenance may include:

```text
sessionId
runId
transcriptEntryIds
origin metadata
approvedBy or approvalId
```

`explicit` confidence means the user directly stated or requested the memory. `inferred` means the agent proposed a reusable conclusion from evidence.

The runtime must not relabel inferred content as explicit merely because the model expressed it confidently.

### Evolution and supersession

Meaningful updates do not overwrite earlier memory invisibly.

A replacement creates a new active entry and marks the previous entry as superseded. Earlier entries remain addressable for evidence and historical explanation unless explicitly purged.

Normal delete marks an entry deleted. Explicit purge physically removes selected records and search projections where policy allows.

The following are prohibited as memory content:

- API keys, passwords, tokens, private keys, or authentication material;
- raw provider continuation data or Gemini thought signatures;
- private model chain-of-thought;
- unrestricted debug artifacts or binary payloads;
- content whose storage violates configured policy.

Validation and policy are fail-closed when a requested write is known to contain prohibited material.

## Memory contracts

Conceptual application contracts include:

```ts
interface MemoryStore {
  create(input: NewMemoryEntry): Promise<MemoryEntry>;
  get(memoryId: string): Promise<MemoryEntry | null>;
  list(query: MemoryListQuery): Promise<MemoryPage>;
  search(query: MemorySearchQuery): Promise<MemorySearchResult[]>;
  supersede(memoryId: string, replacement: NewMemoryEntry): Promise<MemoryEntry>;
  delete(memoryId: string): Promise<MemoryEntry>;
  purge(query: MemoryPurgeQuery): Promise<MemoryPurgeResult>;
}
```

Callers depend on memory contracts, not SQLite, FTS5 syntax, or table layouts.

The store returns typed status and revision information. Search results include memory identity, revision, kind, content or a bounded projection, content hash, score/rank, and provenance summary.

## Write authority and Tool Runtime

Memory mutation changes future agent behavior and is therefore a side effect.

Model-requested operations use registered tools such as:

```text
memory_search
memory_get
memory_write
memory_supersede
memory_delete
```

The execution path is:

```text
model proposes validated operation
→ Tool Runtime resolves descriptor
→ policy evaluates visibility and invocation
→ approval resolves when required
→ Memory Runtime validates domain semantics
→ MemoryStore commits transaction and index update
→ Run Journal records evidence
→ normalized tool result returns to the Harness
```

A user-explicit request to remember or forget may be allowed automatically by V1 policy. An agent-inferred memory write requires approval by default.

`MemoryCandidate` is a validated in-run proposal object, not committed memory. A persistent review queue and background candidate extraction are deferred.

These modules cannot write memory directly:

```text
Gateway
Context Assembler
Agent Harness
Model Provider
CheckpointStage
TranscriptStore
RunJournalStore
```

`CheckpointStage` may observe memory write or retrieval outcomes and decide whether the loop continues, completes, retries, fails, or cancels. It does not extract or commit memory.

A memory committed during a run is visible through its tool result but does not mutate the run's already frozen recall snapshot. It becomes eligible for retrieval by later runs.

## Retrieval and search

V1 implements text search using SQLite FTS5 plus exact filters.

Supported filters include applicable:

```text
agentId
active status
kind
tag or namespace when introduced
result limit
```

Ranking is deterministic for a given database/index revision, query, filter set, and search-policy version. The exact BM25 weighting and tie-breaking are implementation details until externally depended upon, but the policy has an explicit version recorded in evidence.

The application-facing contract reserves search modes:

```text
text
vector
hybrid
```

V1 implements only `text`. Requests for unsupported modes fail explicitly rather than silently changing semantics.

### Memory index revision

Committed create, supersede, delete, purge, or rebuild operations advance a monotonic memory index revision.

Retrieval returns the revision used. The revision is evidence and cache invalidation metadata, not a substitute for memory entry IDs or revisions.

An FTS rebuild is an explicit maintenance operation. The system does not silently drop to an unindexed full-table scan and claim equivalent ranking.

## Per-run recall snapshot

Normal memory recall occurs once during admitted run setup after the current input is validated and before the first model request.

The Memory Runtime returns:

```ts
interface MemoryRecallSnapshot {
  readonly agentId: string;
  readonly indexRevision: number;
  readonly searchPolicyVersion: string;
  readonly queryHash: string;
  readonly resultLimit: number;
  readonly tokenBudget: number;
  readonly selected: readonly SelectedMemory[];
  readonly snapshotHash: string;
}
```

Selected entries include IDs, revisions, kinds, content hashes, ranking evidence, and bounded rendered content.

The recall snapshot is frozen for the run and reused by later model calls and attempts in that run. This preserves reproducibility when memory changes concurrently.

Dynamic recall after each tool cycle, query rewriting by the model, or refresh between attempts is deferred. Adding it requires an explicit lifecycle decision because it changes run determinism and evidence semantics.

## Context assembly

The Context Assembler consumes the frozen recall snapshot through a typed input and renders it only through the host-owned Prompt Plan.

Memory recall becomes one or more sections with:

```text
authority: retrieved-memory
trust: managed-context
stability: run
budgetClass: bounded
```

Memory is inserted below authoritative host safety, policy, operating rules, and identity. It may inform the task but cannot override those authorities. A `MEMORY.md` file is not injected as alternate memory authority; importing one is an explicit Memory Runtime operation creating normal provenance-bearing entries.

Memory remains distinguishable from current user input, transcript, user-profile resources, skills/task knowledge, and provider continuation.

Recall is bounded by result and token budgets. If nothing relevant passes policy, no fabricated memory section is created.

The Context Manifest and Prompt Plan record:

```text
memory section IDs and source references
memory section authority, trust, stability, and budget class
memory enabled state
index revision
search-policy version
query hash
candidate count
selected IDs and revisions
selected content hashes
scores or ranking positions
result and token budgets
included token estimate
skip, rejection, or truncation reasons
recall snapshot hash
```

## Storage and indexing

SQLite is the V1 memory engine.

Persistent storage includes domain tables for entries, revisions/status, and provenance plus an FTS5 projection for active searchable content.

Domain state and corresponding index changes commit transactionally. A failed index update does not report a successful memory mutation.

Memory tables are migrated through the existing versioned migration system. Migrations and store behavior are tested with temporary or in-memory SQLite databases.

The Memory Runtime does not store API keys or embedding credentials because V1 has no embedding provider.

## Observability and Run Journal

Memory retrieval emits structured lifecycle evidence such as:

```text
memory.retrieval.started
memory.retrieval.completed
memory.selection.completed
```

Memory mutation emits applicable:

```text
memory.write.requested
memory.write.completed
memory.write.failed
memory.superseded
memory.deleted
memory.purged
memory.index.rebuilt
```

Retrieval evidence contains:

```text
runId
agentId
index revision
search-policy version
query hash
candidate count
selected memory IDs and revisions
selected content hashes
scores or ranking positions
result/token budgets
included token estimate
skip or rejection reasons
```

Mutation evidence contains:

```text
operation ID
runId when applicable
memory ID and revision
source/provenance references
policy and approval outcome
before and after status
content hash
index revision before and after
transaction result
```

Run Journal rows do not contain unrestricted memory bodies. Authorized development artifacts may include bounded redacted memory projections when necessary to reproduce context.

Pino logs summarize failures and correlation IDs but are not the memory evidence API.

## Clear, delete, and retention

Memory lifecycle operations are independent from:

```text
session reset
transcript deletion
Run Journal clear
technical log rotation
agent-resource updates
```

Manual clear or purge supports:

- scoping by agent, memory ID, kind, status, or date;
- dry-run or preview;
- affected-count and storage-size reporting;
- confirmation for broad operations;
- policy checks;
- Run Journal or maintenance evidence.

V1 does not silently expire or auto-delete memory. `validUntil` can mark temporal validity, but physical cleanup remains explicit.

## Security and privacy

Memory is persistent personal data and is handled as sensitive application state.

Access is restricted by agent ownership and application capability. Memory content is not exposed through ordinary Gateway history APIs, technical logs, or client events unless a dedicated memory capability authorizes it.

Write and retrieval errors must not echo secret-like rejected content into logs or journal rows.

Future remote clients, multi-user access, memory sharing, or external export require capability and authorization decisions beyond this ADR.

## Consequences

### Positive

- Cross-session knowledge has a clear owner instead of leaking into transcript, files, or logs.
- Explicit writes and provenance reduce silent accumulation of incorrect facts.
- Per-run recall snapshots make model context reproducible and debuggable.
- SQLite FTS5 avoids an embedding provider, vector extension, and background infrastructure in V1.
- Supersession preserves historical explanation when facts or decisions change.
- Run Journal evidence supports regression, retrieval-quality, and memory-policy tests.
- Future vector, episodic, or semantic systems can extend a stable boundary.

### Negative

- Explicit memory writes require more user or policy interaction than automatic extraction.
- Text search will miss some semantic matches that embeddings might retrieve.
- Provenance, revisions, and index synchronization add schema and testing work.
- A frozen per-run snapshot will not automatically observe a memory written later in the same run.
- Manual retention requires the user or operator to manage accumulated memory.

## Risks and trade-offs

### Incorrect inferred memories

A model may propose a plausible but false fact.

Mitigation:

- distinguish `explicit` from `inferred`;
- require approval for inferred writes by default;
- preserve evidence references;
- support supersession and deletion;
- record policy and approval outcomes.

### Stale memories influence future runs

A once-correct preference or project fact may become outdated.

Mitigation:

- explicit status and temporal validity;
- no in-place semantic overwrite;
- memory management APIs;
- show IDs/provenance in memory review surfaces;
- preserve selected revisions in run evidence.

### Memory and user profile drift apart

Dynamic memory may conflict with a managed `user-profile` resource.

Mitigation:

- keep them visibly separate in context manifests;
- give authoritative resource precedence over recalled memory;
- do not silently promote memory into agent resources;
- add a future explicit promotion workflow if needed.

### FTS ranking is insufficient

Exact text search may not surface paraphrased knowledge.

Mitigation:

- expose ranking evidence;
- maintain a versioned search policy;
- test representative recall cases;
- reserve vector/hybrid modes without implementing them prematurely.

### Search index and domain state diverge

FTS rows may become stale after a failed mutation or migration.

Mitigation:

- transactional updates;
- integrity checks;
- explicit index-rebuild operation;
- monotonic index revision;
- migration and failure-path tests.

### Memory becomes an unbounded data sink

Persistent entries may consume storage and reduce retrieval quality.

Mitigation:

- bounded recall;
- storage diagnostics;
- manual scoped clear and purge;
- no automatic deletion that hides evidence;
- add explicit retention policy only when operational needs are known.

### Sensitive data is stored accidentally

A user or model may attempt to remember a secret.

Mitigation:

- prohibit credential classes;
- validate and evaluate policy before commit;
- redact rejected payloads from evidence;
- separate memory access capabilities from transcript/history APIs.

## Rejected alternatives

### Use transcript history as long-term memory

Rejected because transcript is sequential conversation history scoped to one `sessionId`, while memory is selected cross-session knowledge with provenance, supersession, and retrieval semantics.

### Store all memory in `USER.md` or `MEMORY.md`

Rejected for V1 because ordinary file mutation would blur resource revision authority, indexing, provenance, approval, and evidence. File import/export may be added later through explicit management operations.

### Let the model silently update memory after every turn

Rejected because unreviewed inference can accumulate false or sensitive facts and makes behavior difficult to reproduce.

### Copy GoClaw's full three-tier architecture

Rejected because PostgreSQL, pgvector, episodic workers, semantic extraction, dreaming consolidation, and background event processing exceed the local-first V1 requirement.

### Add embeddings and hybrid search immediately

Rejected because they add another provider, credentials, cost, nondeterminism, caching, and vector-index operations before text retrieval quality is measured.

### Automatically flush memory before compaction

Rejected because compaction is deferred and automatic extraction would create hidden durable writes. A future design must define candidate review, authority, and evidence.

### Refresh memory after every model or tool call

Rejected because changing recall within an active run weakens reproducibility and may cause loops to observe inconsistent world state.

### Let ContextAssembler or CheckpointStage write memory

Rejected because context preparation and loop decisions are not mutation authorities. Memory writes belong behind Tool Runtime, policy, approval, and Memory Runtime contracts.

### Put memory bodies into Run Journal rows

Rejected because journal evidence should use IDs, hashes, scores, and bounded references. Full content belongs to the MemoryStore or authorized redacted artifacts.

### Auto-expire memory in V1

Rejected because silent deletion can make earlier behavior hard to explain and retention requirements are not yet established.

## Validation

This decision is correctly applied when:

- `src/memory/` owns memory contracts and application semantics;
- memory remains distinct from transcript, agent resources, Run Journal, and audit;
- every entry has `agentId`, kind, status, confidence, provenance, content hash, and revision/history semantics;
- agent-inferred writes require approval by default;
- model-requested mutations pass through Tool Runtime and Policy;
- ContextAssembler, Harness, provider, CheckpointStage, and Gateway do not write memory directly;
- V1 search uses SQLite FTS5 through `MemoryStore` contracts;
- unsupported vector or hybrid modes fail explicitly;
- mutations and FTS projection changes are transactional;
- the memory index revision advances on committed changes;
- one frozen `MemoryRecallSnapshot` is used throughout a run;
- a same-run write does not silently alter that snapshot;
- context precedence keeps memory below authoritative host and agent instructions;
- recalled memory enters the model only through bounded typed Prompt Plan sections, never through unrestricted `MEMORY.md`;
- recall and mutation produce typed Run Journal evidence;
- unrestricted memory bodies, credentials, continuation data, and private reasoning do not appear in journal or logs;
- clear/purge is explicit and independent from session, transcript, log, and journal lifecycle;
- migration, agent-isolation, supersession, ranking, budget, and failure-path tests exist;
- automatic extraction, vector search, semantic graph, and background consolidation are not represented as implemented.

## Revisit conditions

Revisit this decision when:

- FTS5 recall quality is insufficient for measured use cases;
- an embedding provider or vector index is introduced;
- episodic summaries or semantic entities become product requirements;
- compaction should extract durable memory;
- memory retrieval must refresh within an active run;
- multiple users or agents need shared or delegated memory access;
- automatic candidate extraction or review queues are introduced;
- retention, TTL, encryption-at-rest, export, or compliance requirements change;
- a file-compatible memory representation becomes a supported public contract;
- memory storage must move outside the main SQLite database or into another process.

## References

- `docs/ARCHITECTURE.md`, section 8, **Agent definition and ownership**
- `docs/ARCHITECTURE.md`, section 9, **Agent Runtime architecture**
- `docs/ARCHITECTURE.md`, section 11, **Sessions and transcripts**
- `docs/ARCHITECTURE.md`, section 12, **Memory Runtime**
- `docs/ARCHITECTURE.md`, section 13, **Tool Runtime**
- `docs/ARCHITECTURE.md`, section 14, **Policy, approval, and sandbox**
- `docs/ARCHITECTURE.md`, section 20, **Storage and migrations**
- `docs/ARCHITECTURE.md`, section 21, **Events, logs, Run Journal, and audit**
- `docs/decisions/0002-core-runtime-identities-and-agent-ownership.md`
- `docs/decisions/0005-agent-runtime-harness-and-model-provider-boundaries.md`
- `docs/decisions/0007-context-assembly-and-transcript-mutation-authority.md`
- `docs/decisions/0008-tool-runtime-policy-approval-and-sandbox-boundaries.md`
- `docs/decisions/0009-storage-ownership-sqlite-and-migration-policy.md`
- `docs/decisions/0010-runtime-events-logs-transcripts-and-audit-separation.md`
- GoClaw Memory System: `https://docs.goclaw.sh/core-concepts/memory-system`
- GoClaw source documentation: `https://github.com/nextlevelbuilder/goclaw-docs/blob/master/core-concepts/memory-system.md`
- GoClaw System Prompt Anatomy: `https://docs.goclaw.sh/system-prompt-anatomy`
- GoClaw Context Files: `https://docs.goclaw.sh/context-files`
