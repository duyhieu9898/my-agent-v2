# ADR 0009: Storage Ownership, SQLite, and Migration Policy

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
  - `docs/decisions/0007-context-assembly-and-transcript-mutation-authority.md`
  - `docs/decisions/0008-tool-runtime-policy-approval-and-sandbox-boundaries.md`
  - `docs/decisions/0010-runtime-events-logs-transcripts-and-audit-separation.md`
  - `docs/decisions/0015-usage-accounting-and-cumulative-budget-enforcement.md`

## Context

`my-agent-v2` needs local durable storage for session routing, transcripts, per-run execution evidence, runtime metadata, and later application state without coupling domain modules to SQLite or allowing Gateway handlers to become data-access code.

The current repository foundation already contains:

```text
src/storage/database.ts
src/storage/migrate.ts
src/storage/migrations/
src/sessions/session-store.ts
src/sessions/transcript-store.ts
src/sessions/sqlite-session-store.ts
```

The architecture also requires:

- SQLite as the initial storage engine;
- versioned migrations;
- separate `SessionStore` and `TranscriptStore` contracts;
- no direct SQLite access from Gateway or Agent Runtime;
- storage lifecycle composed in `src/bootstrap/`;
- durable identity and session invariants preserved across restart;
- future multi-agent isolation without treating the V1 `primary` agent as a global singleton;
- a durable, ordered `RunJournalStore` and debug-artifact index for development-first observability under ADR 0010.
- a durable `UsageLedgerStore` for model-call reservations, settlement, uncertain accounting, and cumulative budget queries under ADR 0015.

Without a storage decision, implementation could drift into incompatible patterns such as:

- Gateway handlers issuing SQL directly;
- domain contracts exposing tables, transactions, or SQLite row shapes;
- one generic repository owning unrelated business rules;
- parallel JSON and SQLite sources of truth;
- silently falling back to in-memory storage after database failure;
- editing a migration that has already run on user data;
- performing destructive legacy imports during ordinary startup;
- splitting into multiple database files before ownership and lifecycle require it;
- copying a live SQLite file as a backup while WAL state remains outside the main file;
- writing unbounded debug payloads inline with journal rows;
- silently deleting execution evidence when storage grows;
- clearing a session transcript and unintentionally deleting pinned run evidence.

OpenClaw currently uses SQLite as its canonical runtime state layer and separates shared control-plane state from per-agent state. It also treats legacy files as migration inputs rather than an active fallback and uses verified SQLite snapshots for portable backups.

`my-agent-v2` adopts the same ownership, migration, and no-fallback principles while intentionally starting smaller. V1 has one local process, one configured agent, and no active requirement for separate global and per-agent database files.

## Decision

`my-agent-v2` will use one application-owned SQLite database in V1.

The database is concrete infrastructure composed by `src/bootstrap/`. Domain modules continue to expose and consume narrow store contracts owned by those domains.

The high-level flow is:

```text
bootstrap
→ resolve configured database path
→ open SQLite database
→ validate database compatibility
→ apply pending schema migrations
→ construct domain store implementations
→ construct Agent Runtime and Gateway
→ start accepting work
```

The corresponding shutdown order is:

```text
stop accepting new work
→ close Gateway connections
→ cancel or drain active runs
→ stop services that may write state
→ close stores and SQLite database
```

A database open or migration failure prevents normal Gateway startup. Production behavior must not silently substitute in-memory stores, create an unrelated fresh database, or switch to legacy files.

## V1 database topology

V1 uses one SQLite database for application-owned durable runtime state.

The exact configured path is resolved by the config and storage composition layer. Domain modules must not hard-code the path or derive it from unrelated workspace paths.

A single database is chosen because V1 has:

- one local process;
- one primary agent;
- no independent deployment units;
- no remote workers;
- no database-level per-agent backup or movement requirement;
- active need for simple atomic operations across session metadata and transcripts.

This is an intentional difference from OpenClaw's current two-level global and per-agent database topology.

The single-file decision does not collapse domain or agent ownership. Durable records that are agent-owned must carry or be scoped by explicit `agentId` semantics as required by ADR 0002.

Future extraction into global and per-agent databases must preserve store contracts and be performed through a dedicated ADR and migration plan.

## Storage module ownership

`src/storage/` owns SQLite infrastructure, including:

```text
database opening and closing
database path and file lifecycle integration
connection and transaction primitives
SQLite configuration and capability checks
migration discovery and ordering
schema version tracking
migration execution
storage-level error normalization
integrity and compatibility checks
```

`src/storage/` does not own:

```text
session routing rules
transcript mutation authority
run lifecycle
Gateway protocol methods
agent ownership rules
tool policy
model or Harness selection
browser or platform business behavior
```

Storage infrastructure may expose a narrow database or transaction capability to concrete adapters. It must not become a public SQL service available to arbitrary application modules.

Only bootstrap creates the concrete database and injects it into the concrete stores and services that require it.

No domain module may import bootstrap.

## Domain store ownership

Store contracts belong to the module that owns the corresponding domain behavior.

Examples:

```text
src/sessions/session-store.ts
src/sessions/transcript-store.ts
src/agents/run-journal-store.ts
src/memory/memory-store.ts
```

Concrete SQLite adapters may remain beside the domain contracts when that keeps mapping and invariants clear:

```text
src/sessions/sqlite-session-store.ts
src/sessions/sqlite-transcript-store.ts
src/agents/sqlite-run-journal-store.ts
src/memory/sqlite-memory-store.ts
```

Alternatively, a future infrastructure layout may place adapters under `src/storage/` if ownership remains explicit. File placement alone must not change the dependency direction.

The required direction is:

```text
Gateway / Agent Runtime / application service
→ domain store contract
← concrete SQLite adapter composed by bootstrap
→ storage database infrastructure
```

Store contracts must use domain types and domain-shaped operations. They must not expose:

- SQL strings;
- table names;
- SQLite row objects;
- connection handles;
- SQLite-specific result codes;
- caller-managed transactions as a default application API.

A concrete store persists and loads domain state. It does not become the authority for routing, reset permission, run sequencing, policy, transcript semantics, or memory write/recall policy that belong to higher-level domain services and previous ADRs. `MemoryStore` owns curated-memory persistence and search operations; callers do not issue FTS5 or memory-table queries directly.

`UsageLedgerStore` is owned by the Usage Runtime. Storage implements durable reservation/settlement operations and bounded aggregate queries; it does not decide price semantics, cap-policy matching meaning, model fallback, or checkpoint behavior.

## Transcript sequencing, atomic batches, and cursor indexes

SQLite transcript persistence must support the sequencing and batching contracts in ADR 0003 and ADR 0007.

The logical transcript schema preserves equivalents of:

```text
transcript entries keyed by sessionId and sequence
opaque entryId
structural group or exchange association
atomic batch identity when applicable
provider continuation association
createdAt metadata
```

The database enforces uniqueness of `(sessionId, sequence)` and `entryId`. An index beginning with `(sessionId, sequence)` supports bounded forward history reads and tail lookup.

`TranscriptStore.appendBatch` owns one short transaction that:

1. reads or validates the current tail sequence;
2. compares it with `expectedTailSequence`;
3. allocates one contiguous sequence range;
4. inserts every transcript entry and required provider-continuation association;
5. commits the complete batch or rolls back all of it.

Callers do not allocate sequence numbers and do not keep a database transaction open across model calls, tool execution, browser work, or approval waits.

History cursors remain opaque application tokens. SQLite adapters consume the decoded, validated `(sessionId, sequence)` position but do not expose row IDs or offset pagination as durable API semantics.

A cursor for an old `sessionId` remains valid only for reading that historical transcript when the caller explicitly addresses it. It is never silently reused for the new current `sessionId` after reset.

## Memory persistence and FTS5

ADR 0014 makes curated cross-session memory a V1 durable capability.

The domain contract is `MemoryStore`. The Memory Runtime owns entry semantics, provenance, supersession, retrieval policy, and index-revision meaning; storage owns SQLite persistence and FTS5 projection mechanics.

The initial logical schema preserves equivalents of:

```text
memory entries and revisions/status
memory provenance references
active searchable memory FTS5 projection
monotonic memory index revision
```

Create, supersede, delete, purge, and index updates use short transactions. A mutation is not reported as successful when its required FTS projection did not commit.

The FTS projection indexes only eligible active content. Deleted or superseded entries remain available for historical evidence according to policy but do not appear in normal active recall.

A committed mutation advances the memory index revision. Search returns the revision used so a run can freeze one reproducible `MemoryRecallSnapshot`.

Index rebuild is an explicit maintenance operation with validation and journal evidence. Storage must not silently fall back to an unindexed table scan while claiming equivalent ranking semantics.

Raw credentials, provider continuation, private reasoning, and unrestricted debug payloads are not valid memory rows or FTS content.

## Usage accounting, reservations, and cap transactions

The V1 SQLite database stores usage reservations, dispatch markers, terminal accounting state, normalized actual usage, derived cost, matched cap-policy revisions, price revision, and bounded query indexes under the `UsageLedgerStore` contract.

A model-call reservation uses a short transaction that atomically:

```text
resolves matching UTC day/month policy windows
reads settled totals plus active/dispatched/uncertain reservations
checks every matching token and cost cap
inserts the reservation and policy revisions when allowed
```

Check and insert are one transaction. Storage may use `BEGIN IMMEDIATE` or another owned transaction mode that serializes competing reservations correctly.

Dispatch is marked durably before provider network I/O. No database transaction remains open during the call.

Settlement, release, and uncertain transitions are idempotent and terminal for one reservation. A dispatched reservation without terminal accounting is not deleted or treated as zero during recovery. Never-dispatched reservations may be released by explicit startup/recovery logic; orphaned dispatched reservations become uncertain until reconciled.

Usage records and reservations are independent from transcript, Run Journal, session runtime summary, and technical-log retention. Session reset and ordinary journal clear do not delete usage state.

Indexes support bounded queries by model call, run, session, agent, provider/model, UTC window, cap policy, and reservation status. V1 does not require hourly materialized summaries, Redis counters, or distributed locks.

## Run Journal and debug-artifact persistence

ADR 0010 makes per-run execution evidence a V1 durable capability.

The domain contract is `RunJournalStore`. Agent Runtime owns the meaning and ordering of run evidence; storage owns the concrete SQLite persistence mechanism.

The initial logical schema includes equivalents of:

```text
run_journals
run_journal_entries
debug_artifacts
```

Exact table and column names may be refined by the implementation plan, but the schema must preserve these relationships:

- one run manifest per `runId`;
- journal entries uniquely ordered by `(runId, sequence)`;
- each entry has an explicit schema version;
- artifact metadata references one owning run and, where applicable, one journal entry;
- pinned-evidence state is explicit;
- terminal status is normalized and cannot conflict within one run;
- deletion can select one run without scanning or rewriting unrelated transcripts.

Run Journal rows contain bounded metadata, identifiers, decisions, references, hashes, and normalized errors. Large content and binary payloads are not stored inline.

Debug artifacts may be stored as files under an application-owned artifact directory when they are too large or unsuitable for SQLite. SQLite stores their authoritative metadata, ownership, size, hash, redaction status, and location.

Artifact creation follows a safe sequence that prevents a successful metadata reference from pointing to an incomplete payload. Artifact deletion follows a compensating or transactional workflow so the database and file store do not silently diverge.

The V1 development policy is manual clear, not silent auto-pruning.

Storage operations must support application-level equivalents of:

```text
inspect usage
preview clear selection
clear one run
clear unpinned runs for one session
clear unpinned runs before a date
clear all unpinned runs
```

Broad clear operations require explicit confirmation at the calling surface. The store itself accepts an already-authorized deletion selection and reports affected counts and bytes.

Pinned evidence is excluded from ordinary clear operations. Deleting pinned evidence requires an explicit override and must not happen as a side effect of session reset, transcript deletion, log rotation, or ordinary retention maintenance.

Warning thresholds and hard storage limits are configuration. Reaching a limit must not silently delete old evidence. Required compact journal entries remain fail-closed; optional debug-artifact capture may enter a declared degraded mode according to ADR 0010.

## Session runtime summary projection

`FinalizeStage` may persist a bounded session-level projection for diagnostics and UI lookup without scanning the full transcript or Run Journal.

The logical projection is `SessionRuntimeSummary` and may include:

```text
sessionKey and current sessionId
lastRunId
lastRunStatus
lastModelId
lastInputTokens
lastOutputTokens
lastContextTokens
lastToolCallCount
lastRunDurationMs
lastCheckpointDecision
lastNoProgressSignal when applicable
lastTranscriptEntryCount
lastTranscriptHeadSequence
measurement: exact | unknown
updatedAt
```

This projection is owned by the sessions/application boundary and may be stored as dedicated columns or a separately owned table such as `session_runtime_summaries`. The implementation plan may refine the shape.

Token, count, and duration fields are recorded as exact values when produced by the owning provider or store. When an exact value is unavailable, the field is omitted or marked `unknown`; heuristic estimates are not presented as exact evidence.

The summary is not:

- a replacement for Run Journal evidence;
- a source for reconstructing the run;
- a transcript record;
- an authority for run terminal state;
- a place for raw prompts, model responses, tool payloads, thought signatures, or credentials.

Only terminal finalization updates the projection. A failed summary update is recorded as degraded projection evidence and does not overwrite a newer summary. Because the summary is non-authoritative, its failure does not by itself invalidate an otherwise durable transcript and terminal Run Journal outcome unless a later configuration contract explicitly makes it required.

## Provider continuation persistence

Some model providers require opaque continuation data to reconstruct a valid later stateless request.

For the V1 Gemini integration, `TranscriptStore` persists provider continuation sidecars associated with the relevant transcript entries or model exchanges. The Gemini adapter owns provider encoding and validation; Context and Agent Runtime access the data only through owned contracts. Sidecars may include typed Interactions API steps, thought signatures, provider interaction/request identifiers, and exact step or part associations.

The persistence contract must follow these rules:

- provider continuation is stored under explicit provider and schema versions;
- it is associated with the owning `sessionId`, transcript/model-exchange record, `runId`, and model route where applicable;
- raw opaque signatures are not indexed for search;
- raw signatures are not duplicated into Run Journal rows, logs, Gateway events, or ordinary debug artifacts;
- diagnostics use counts, presence flags, hashes, and validation status;
- provider continuation is returned only to trusted model/context infrastructure;
- normal transcript history APIs omit it unless a privileged diagnostic contract explicitly requests bounded metadata;
- deletion and reset behavior follows transcript-instance ownership, while Run Journal evidence retains only non-secret references or hashes;
- migrations preserve opaque bytes exactly and do not parse or rewrite them unless a dedicated migration is required.

Provider continuation is not a credential, but it is sensitive execution data and receives the same default logging and access restrictions as sensitive model payloads.

The Gemini API key is never stored as ordinary SQLite configuration, transcript metadata, provider continuation, journal metadata, or debug artifact. SQLite may store only a non-secret credential reference when the configuration design requires it.

## Canonical state and file boundaries

SQLite is the canonical store for application-owned durable runtime state implemented under this ADR.

Runtime code must not dual-write the same canonical state to SQLite and JSON, JSONL, YAML, or a second sidecar database.

Runtime code must not use a legacy file as a read-through fallback when a SQLite row is absent or an operation fails.

In-memory stores remain valid for:

- unit tests;
- focused integration tests;
- explicitly configured ephemeral development scenarios.

They are not a production recovery path for SQLite failure.

Not every file belongs in SQLite. The following remain file-backed unless another ADR changes their ownership:

- repository and application configuration;
- user workspaces and Git repositories;
- skills and bootstrap resource files;
- explicit imports and exports;
- user-visible attachments and artifacts when represented as files;
- operator-facing technical logs;
- external provider or CLI files owned by another tool.

A new path under an application state directory requires an explicit classification as one of:

```text
canonical database state
cache or rebuildable state
user-authored workspace content
import or export artifact
attachment or generated artifact
operator log
external owner contract
```

Unclassified application state must not be introduced as an ad hoc file.

Credential persistence and secret-store topology are outside this ADR. A future credential decision must still obey the canonical-source and no-silent-fallback rules defined here.

## Derived-data cache

V1 may use one process-local `InMemoryDerivedDataCache` for values that can be rebuilt completely from authoritative resources, registries, configuration, or canonical stores. It is infrastructure optimization, not a domain store and not a second source of truth.

Eligible values include bounded:

- parsed and validated agent-resource manifests;
- rendered agent-revision-stable Prompt Plan fragments;
- compiled or provider-normalized tool schemas;
- model/provider capability metadata;
- deterministic sanitizer, delimiter, and renderer output.

Cache keys include every correctness-relevant revision or fingerprint, such as:

```text
agentId + agentRevision + resourceAggregateHash + loaderVersion
promptProfileVersion + sectionId + sourceHash + rendererVersion
toolRegistryFingerprint + modelCapabilityFingerprint + providerAdapterVersion
```

TTL or LRU may evict memory, but correctness comes from revisions and hashes. A cache miss, eviction, or cache failure reads the source of truth and rebuilds the value. No durable migration or recovery procedure depends on cache contents.

V1 does not cache or treat as authoritative:

- policy, authorization, approval, or sandbox decisions;
- current transcript snapshots or session queue state;
- memory mutations or current recall results;
- provider continuation sidecars;
- browser tab/session state;
- credentials or secret-bearing values.

A security-decision cache failure must query the authoritative boundary and must never default to allow. Redis, cross-process cache coherence, persistent cache tables, and cache-as-authority behavior are deferred.

## Schema ownership

Each persistent table has one owning module or capability.

The owner defines:

- domain meaning;
- supported reads and mutations;
- retention expectations;
- sensitive fields;
- migration responsibility;
- deletion and archival rules.

Tables may share one SQLite file without sharing business ownership.

The initial schema includes session and migration tables. The first Agent Runtime slice also introduces domain-owned transcript/provider-continuation persistence, Run Journal, debug-artifact metadata, and the bounded session runtime summary projection through new migrations. Future modules must not place unrelated fields into an existing table merely to avoid creating a properly owned schema.

Database constraints should reinforce durable invariants where SQLite can represent them safely, including applicable:

- primary keys;
- uniqueness constraints;
- foreign keys;
- non-null constraints;
- valid discriminator checks;
- monotonic sequence or ordering constraints implemented by store logic and schema together.

Database constraints supplement domain validation; they do not replace it.

External and application input must be validated before storage operations. Rows read from storage are also treated as potentially invalid or incompatible until mapped through the owning adapter.

## Migration registry and version tracking

Every persistent schema change requires a new versioned migration under:

```text
src/storage/migrations/
```

Migrations are registered in a deterministic ordered registry.

Each migration has at least:

```text
unique monotonically increasing version
stable descriptive name
apply operation
```

The database records completed migrations in a `schema_migrations` table or equivalent storage-owned metadata table.

The migration runner must:

1. create or validate migration metadata;
2. read the applied migration versions;
3. reject duplicate or conflicting registered versions;
4. reject a database schema newer than the running application supports;
5. apply pending migrations in order;
6. record each migration only after its successful application;
7. stop on the first failure;
8. prevent Gateway startup until compatibility is restored.

Applied migration files are immutable.

After a migration may have run against persistent user data, changing its SQL or behavior is forbidden. Corrections require a new migration.

Renaming or renumbering an applied migration is also a compatibility change and is forbidden without an explicit recovery decision.

## Schema migrations versus state migration and repair

Automatic startup migrations are limited to application-owned forward schema evolution that is:

- deterministic;
- bounded enough for startup;
- testable from supported prior versions;
- safe to retry according to the migration runner's transaction behavior;
- independent of ambiguous external legacy sources.

A schema migration may transform rows inside the canonical database when the transformation is deterministic and has a clear failure model.

The following do not belong as hidden ordinary-startup behavior:

- importing state from legacy files or another product;
- scanning arbitrary user directories;
- destructive cleanup of ambiguous old data;
- long-running bulk rewrites without bounded startup impact;
- migrations requiring user choices;
- repair after detected corruption;
- credential import with ambiguous ownership;
- deletion of source artifacts before verification;
- downgrade conversion.

Those operations require an explicit maintenance command, execution plan, or future doctor-style workflow that can:

```text
inspect
plan
back up
apply
verify
report
recover or stop safely
```

Runtime must assume one canonical state shape after such a migration. It must not retain permanent dual-read or dual-write compatibility branches.

## Transaction policy

Each store mutation must be atomic from the perspective of its caller.

A store method that updates multiple rows to satisfy one domain invariant owns the required transaction internally.

Operations spanning more than one store contract require an explicitly owned application operation and a shared storage transaction capability.

For example, session creation or reset may need to coordinate:

```text
create transcript identity or root state
update sessionKey → sessionId mapping
preserve prior mapping if any step fails
```

That operation must not be implemented as unrelated independently committed calls that can leave a current session pointing to missing transcript state.

A transcript append batch similarly owns one short transaction for expected-tail validation, contiguous sequence allocation, canonical entries, and required provider continuation. Partial batch commit is forbidden.

The storage layer may provide an internal transaction context accepted by concrete store adapters. The public application contract should remain domain-shaped rather than exposing generic transaction management to Gateway handlers or Agent Runtime code.

Nested transaction assumptions must be avoided unless the storage implementation defines their semantics explicitly.

Long-running model calls, tool execution, browser operations, network calls, or human approval waits must never hold an open SQLite transaction.

Usage reservation checks and inserts are atomic short transactions. The provider call occurs only after commit; settlement is a separate short idempotent transaction.

The per-session run lane from ADR 0006 coordinates runtime ordering. It does not replace database transactions for durable atomicity.

## Concurrency and SQLite behavior

The storage layer owns SQLite-specific concurrency configuration.

Implementation may use appropriate SQLite features such as:

- WAL mode;
- busy timeouts;
- foreign-key enforcement;
- transaction modes;
- checkpoints;
- prepared statements.

Specific pragma values are implementation details unless operational evidence requires an ADR.

Regardless of configuration:

- callers receive normalized storage errors;
- indefinite lock waiting is forbidden;
- write contention must fail or retry through a bounded, explicit policy;
- domain modules must not branch on raw SQLite error strings;
- database lifecycle must not be duplicated across stores;
- shutdown must close the shared database after writers stop.

V1 does not support multiple independent processes writing the database concurrently. Introducing background workers or another writer process requires revisiting database topology, locking, and transaction assumptions.

## Read behavior and bounded access

Stores should expose the smallest reads required by active consumers.

Transcript and history APIs must support bounded access before data grows without limit. Appropriate forms include:

- tail reads;
- opaque cursor reads by `(sessionId, sequence)`;
- bounded sequence ranges;
- targeted lookup by durable identity.

Offset pagination and raw SQLite row IDs are not stable history contracts.

Normal startup must not load every transcript or materialize all durable state into memory.

Full scans require an explicit maintenance, indexing, export, or product use case.

SQLite indexes must be introduced for demonstrated query patterns and validated with tests or query-plan evidence when performance becomes material.

## Failure behavior

The database is required infrastructure in persistent mode.

The system must fail closed when:

- the configured database cannot be opened;
- migrations fail;
- the schema is newer than the application supports;
- required integrity or ownership metadata is invalid;
- a transaction cannot preserve the requested invariant.

Failure must not cause the application to:

- delete the database automatically;
- create a replacement at a different implicit path;
- silently reset user sessions;
- switch to in-memory stores;
- resume from stale JSON or JSONL state;
- partially start a Gateway that advertises unavailable durable capabilities as healthy.

Health and readiness must distinguish process liveness from storage readiness.

Logs may include database role, path classification, migration version, and normalized error metadata, but must not include secrets or full sensitive rows.

## Backup, restore, and downgrade

V1 does not require a complete user-facing backup command before the first storage slice, but the database design must not rely on unsafe raw copying as its long-term recovery strategy.

A portable SQLite backup must eventually use one of:

- SQLite backup API;
- `VACUUM INTO`;
- a verified checkpoint-and-snapshot procedure;
- an offline copy after the application has stopped and all database sidecars are accounted for.

Copying only a live `*.sqlite` file while `-wal`, `-shm`, or journal state may contain committed work is not a valid backup contract.

Before a migration that is destructive, difficult to reverse, or changes large amounts of user data, its execution plan must define:

```text
backup or recovery point
migration validation
failure handling
restore procedure
operator-visible evidence
```

Downgrade is not implemented as reverse migrations by default.

If older code cannot read a newer schema, recovery requires restoring a compatible verified snapshot or using an explicitly designed downgrade tool. The current application must reject unsupported newer schemas rather than attempting best-effort reads.

## Data deletion and retention

Schema migration, session reset, archival, and permanent deletion are separate operations.

A migration must not delete user-visible durable history merely because it is no longer current unless the migration's accepted product contract explicitly requires that deletion and provides recovery safeguards.

Session reset follows ADR 0003 and preserves the prior transcript by default. Memory delete or purge is an independent explicit operation and is not implied by session reset, transcript deletion, journal clear, artifact clear, or agent-resource replacement.

Future cleanup, retention, redaction, and secure-deletion behavior require explicit ownership and product policy. Ordinary storage compaction or SQLite vacuuming must not be described as semantic deletion guarantees.

## Testing and validation strategy

Storage behavior requires executable tests using temporary or in-memory SQLite databases where supported.

The minimum migration and adapter test coverage includes:

- an empty database migrates to the latest schema;
- migrations apply in deterministic order;
- rerunning the migration runner performs no duplicate changes;
- a failed transactional migration is not recorded as applied;
- duplicate migration versions are rejected;
- a database newer than the application is rejected;
- foreign-key and uniqueness constraints protect declared invariants;
- SQLite stores satisfy the same behavioral contract as in-memory test stores where both implementations exist;
- MemoryStore tests cover FTS5 synchronization, agent isolation, provenance, supersession, deletion, bounded deterministic search, and memory index-revision advancement;
- data survives database close and reopen;
- session resolution remains stable across restart;
- create and reset operations do not leave partial mappings;
- bounded transcript reads preserve defined ordering;
- normalized errors do not leak raw sensitive row content;
- shutdown releases the database so the application can restart cleanly.

Migration fixtures should represent each supported historical schema once persistent releases exist.

Tests that seed a legacy layout are allowed only for an explicitly owned migration or repair path. They must not justify keeping runtime fallback readers.

## Consequences

### Positive

- V1 has one simple local persistence lifecycle.
- Domain modules remain independent of SQLite details.
- Gateway and Agent Runtime cannot bypass store contracts.
- Session and transcript invariants can share local transactions without prematurely splitting databases.
- Schema evolution is deterministic and reviewable.
- Failure does not silently discard or fork user state.
- Future per-agent database extraction remains possible because ownership is explicit.
- Test and in-memory implementations can validate contracts without becoming production fallbacks.

### Negative

- All V1 durable state shares one database failure and backup boundary.
- A future per-agent database split will require a deliberate migration.
- Explicit store contracts and adapters add code compared with direct SQL in handlers.
- Startup migrations can increase startup time and must remain bounded.
- Cross-store atomic operations require careful transaction coordination.
- Downgrade may require restoring state rather than only reinstalling older code.

## Risks and trade-offs

### Single database becomes a dumping ground

Unrelated modules may place arbitrary tables or blobs into one file without declaring ownership.

Mitigation:

- every table has one owner;
- new state is classified before implementation;
- stores expose narrow domain operations;
- material ownership changes require an ADR.

### Domain contracts leak SQLite

Convenience may lead callers to depend on raw rows, SQL fragments, or connection handles.

Mitigation:

- domain-shaped interfaces;
- mapping inside concrete adapters;
- dependency review and architecture tests where useful;
- no generic database access from Gateway or runtime orchestration modules.

### Hidden compatibility paths create two sources of truth

A developer may keep JSON fallback or dual-write behavior to make migration appear safer.

Mitigation:

- one canonical store after migration;
- explicit migration owner;
- inspect, apply, and verify workflow for legacy state;
- tests and static checks that prevent new active legacy writers where useful.

### Migration failure blocks startup

Failing closed may make the application unavailable until repaired.

Mitigation:

- migration tests from supported versions;
- transactional application where possible;
- normalized diagnostics;
- backup and recovery requirements for risky changes;
- explicit maintenance tools rather than unsafe automatic recovery.

### Large migrations make startup unpredictable

Data volume may turn a simple schema migration into a long rewrite.

Mitigation:

- keep startup migrations bounded;
- move large rewrites to an explicit maintenance workflow;
- measure migration behavior against realistic fixtures;
- introduce online or staged migration only through a later decision.

### SQLite assumptions block multiple processes

The V1 lifecycle assumes one application process owns writes.

Mitigation:

- keep database construction in bootstrap;
- do not open independent unmanaged connections per module;
- revisit before adding workers, remote nodes, or distributed execution.

### Provider continuation becomes unreadable or detached

Opaque Gemini continuation may be lost, reordered, or separated from the transcript exchange it belongs to.

Mitigation:

- persist explicit ownership and ordinal associations;
- version the sidecar schema;
- verify byte-exact round trips in adapter tests;
- use foreign-key or equivalent integrity checks where practical;
- fail with incompatible-history errors rather than fabricate missing continuation.

### Development evidence consumes disk space

Full development capture can grow faster than session history.

Mitigation:

- keep journal rows bounded and indexed;
- store large payloads as artifacts;
- expose usage by run and session;
- provide dry-run and explicit clear operations;
- protect pinned evidence;
- support production and targeted capture profiles;
- never silently prune development evidence.

### Artifact metadata and files diverge

A crash may leave an orphan file or a missing payload reference.

Mitigation:

- use temporary files and atomic rename where supported;
- write and verify content hashes;
- commit metadata only after payload durability is established;
- provide integrity scanning and orphan cleanup as explicit maintenance operations;
- represent missing artifacts as degraded evidence rather than hiding them.

## Rejected alternatives

### Let each module open its own SQLite database immediately

Rejected because V1 has no independent lifecycle, scale, security, or backup requirement that justifies multiple files. It would complicate transactions, startup, backup, and testing before boundaries need physical separation.

### Copy OpenClaw's global plus per-agent database topology now

Rejected because `my-agent-v2` currently has one local process and one configured agent. The ownership model is adopted, but the physical split would be premature. Future extraction remains possible through explicit `agentId` scoping and store contracts.

### Put all persistence behind one generic repository

Rejected because a generic repository obscures domain ownership, encourages broad queries, and makes session, transcript, policy, and runtime rules easy to bypass.

### Query SQLite directly from Gateway handlers

Rejected because Gateway owns transport and protocol behavior, not storage mapping or session business logic.

### Store session index and transcripts only as JSON or JSONL

Rejected because the project already has a SQLite migration foundation and needs atomic mapping, indexed bounded reads, constraints, and controlled schema evolution.

### Dual-write SQLite and files during normal runtime

Rejected because two sources of truth create divergence, ambiguous recovery, and permanent compatibility code.

### Fall back to in-memory storage when SQLite fails

Rejected because the system could appear healthy while losing durable user state and producing a separate history branch.

### Modify an existing migration after release

Rejected because databases that already recorded the version would not rerun the changed migration, producing the same version number with different schema meanings.

### Automatically delete and recreate an incompatible database

Rejected because availability does not justify silent user-data loss.

### Let transcript callers allocate sequence numbers

Rejected because sequence allocation must be atomic with expected-tail validation and batch commit.

### Use offset pagination or SQLite row IDs as public history cursors

Rejected because storage reorganization, filtering, and reset would make those cursors ambiguous or unstable.

### Commit structurally related transcript entries in separate transactions

Rejected because a crash or storage failure could leave canonical history with orphaned tool or continuation records.

### Store all debug payloads inline in SQLite journal rows

Rejected because large model responses, browser observations, shell output, and screenshots would bloat hot journal tables, weaken bounded queries, and make retention and redaction coarse. SQLite indexes metadata and ownership; large payloads use managed artifacts.

### Store raw thought signatures in Run Journal rows

Rejected because signatures are provider continuation data, not execution-summary metadata. Journal entries retain counts, hashes, and persistence status only.

### Store the Gemini API key in the application database

Rejected because V1 uses a host-owned secret-bearing configuration or credential reference. Ordinary application persistence must not become a credential vault by accident.

### Use Redis or a persistent cache in V1

Rejected because the initial deployment is one local process and all selected cache values are rebuildable. A network or persistent cache would add invalidation, availability, and migration concerns without becoming an authority.

### Use TTL as the cache consistency contract

Rejected because stale values could survive until expiry. Correctness-sensitive keys include source revisions, content hashes, and renderer/provider versions; TTL is eviction only.

### Automatically prune old development journals

Rejected because silent deletion removes evidence required to reproduce and verify bugs. Development uses manual clear and pinned evidence; configured production retention may be added without changing ownership.

### Delete journal evidence during session reset

Rejected because transcript reset and development evidence have different lifecycle and authority. A reset starts a new transcript instance but does not erase why previous runs behaved as they did.

### Hold a transaction for an entire agent run

Rejected because model calls, tools, approvals, and browser operations are long-running and would create lock contention and fragile recovery. Transactions protect bounded durable mutations, while ADR 0006 controls run ordering.

### Implement reverse migration for every schema change

Rejected because reverse migrations can be destructive and are difficult to validate. Verified restore is the default downgrade recovery model until a specific product requirement justifies reversible migration tooling.

### Calculate cumulative usage by scanning Run Journal rows

Rejected because journal retention and schema serve execution evidence, not accounting authority or atomic concurrent reservation.

### Check a cap and insert its reservation in separate transactions

Rejected because concurrent sessions could both pass the check and overspend the same headroom.

### Automatically release every stale dispatched reservation

Rejected because the provider may have completed and billed the call. Dispatched unresolved reservations become explicit uncertain state.

## Validation

This decision is correctly applied when:

- V1 persistent mode opens one configured SQLite database through bootstrap;
- storage opens and migrates before Gateway readiness;
- Gateway, Agent Runtime, Context, Harness, Model, Policy, and Tool modules do not issue SQL directly;
- domain modules expose narrow store contracts using domain types;
- concrete SQLite adapters are the only normal path from those contracts to SQL;
- `SessionStore`, `TranscriptStore`, `RunJournalStore`, `MemoryStore`, and `UsageLedgerStore` remain separate domain contracts even when sharing one database;
- memory mutations and required FTS5 projection changes commit consistently;
- memory recall returns and records the index revision used;
- transcript entries have store-assigned monotonic sequences unique within each `sessionId`;
- `(sessionId, sequence)` is indexed and used for bounded cursor reads;
- `appendBatch` validates the expected tail and commits a contiguous sequence range atomically;
- failed or stale transcript batches do not partially commit entries or provider continuation;
- history cursors do not expose SQLite offsets or row IDs;
- required Gemini continuation data survives SQLite close/reopen and produces an equivalent stateless request projection;
- raw thought signatures are not searchable, logged, journaled, or returned by normal history APIs;
- the Gemini API key is absent from ordinary SQLite tables and artifacts;
- one run manifest exists per journaled run and `(runId, sequence)` is uniquely ordered;
- journal entries remain bounded while large payloads use owned debug artifacts;
- artifact metadata includes ownership, size, hash, and redaction state;
- journal and artifact clear operations are independently scoped from transcript and log deletion;
- ordinary clear excludes pinned evidence and supports an inspect or dry-run path;
- session reset does not delete run evidence;
- storage limits do not silently auto-delete journal evidence;
- session runtime summaries remain bounded projections updated through terminal finalization;
- summary rows reference the last run and checkpoint outcome without duplicating journal payloads;
- a summary cannot overwrite a newer terminal run projection;
- usage cap check-plus-reserve is one short atomic transaction and no provider I/O occurs inside it;
- dispatch state commits before provider network I/O;
- usage settlement/release/uncertain transitions are idempotent and terminal per reservation;
- active, dispatched, and uncertain reservations remain queryable and counted rather than being silently expired;
- session reset, transcript deletion, and journal clear do not delete usage accounting state;
- cross-store invariants use a coordinated transaction or safe compensation rather than partial independent commits;
- every schema change adds a new ordered migration;
- applied migration files are not edited, renamed, or renumbered;
- a newer unsupported schema and migration failure prevent normal startup;
- persistent mode never silently falls back to in-memory or legacy files;
- canonical state is not dual-written to SQLite and JSON/JSONL;
- legacy imports and risky repairs use an explicit owned workflow;
- constraints and adapter tests protect durable identity and session invariants;
- database close and restart preserve state and release file resources;
- backup plans account for SQLite WAL or use a supported snapshot mechanism;
- architecture and implementation do not claim a global/per-agent database split until it is actually introduced;
- derived-data cache values are process-local, revision/hash-keyed, rebuildable, and never used as policy or durable-state authority;
- cache failure falls back to authoritative reads/recomputation rather than an in-memory or security fail-open path;
- tests prove that revision/hash changes miss stale cache entries and that policy/approval behavior is identical with cache disabled.

## Revisit conditions

Revisit this decision when:

- more than one agent has enough data or lifecycle independence to justify per-agent databases;
- multiple processes or remote workers need concurrent database access;
- usage reservations require distributed coordination or provider-backed reconciliation;
- a subsystem requires independent backup, restore, encryption, retention, or failure isolation;
- database size or write contention exceeds acceptable local SQLite behavior;
- user-facing backup and restore become a release requirement;
- credentials or other highly sensitive state require a separate encrypted store;
- provider continuation needs encryption at rest or an independent sensitive-payload store;
- Gemini server-side conversation state replaces local continuation replay;
- plugins need durable schemas or namespaced key-value storage;
- multiple processes require shared derived-data caching or explicit invalidation coordination;
- cache volume or computation cost justifies Redis or another cache backend;
- online migrations or zero-downtime upgrades become necessary;
- session or transcript state must replicate across devices;
- session runtime summary history becomes a product feature rather than a last-run projection;
- a non-SQLite backend is required;
- Run Journal volume requires partitioning, compression, or a dedicated backend;
- evidence requires tamper resistance, signing, or immutable storage;
- production retention requires automatic pruning with stronger guarantees;
- the project introduces a persistent general-purpose event or audit store with materially different retention and integrity requirements.

## References

- `docs/decisions/0015-usage-accounting-and-cumulative-budget-enforcement.md`
- `docs/decisions/0014-memory-ownership-retrieval-and-evolution.md`
- `docs/ARCHITECTURE.md`, section 11, **Sessions and transcripts**
- `docs/ARCHITECTURE.md`, section 20, **Storage and migrations**
- `docs/ARCHITECTURE.md`, section 22, **Lifecycle and composition**
- `docs/ARCHITECTURE.md`, section 23, **Dependency direction**
- `docs/decisions/0002-core-runtime-identities-and-agent-ownership.md`
- `docs/decisions/0003-session-routing-transcript-separation-and-reset-semantics.md`
- `docs/decisions/0006-run-attempt-lifecycle-and-per-session-serialization.md`
- `docs/decisions/0007-context-assembly-and-transcript-mutation-authority.md`
- `docs/decisions/0010-runtime-events-logs-transcripts-and-audit-separation.md`
- OpenClaw database-first state refactor: `https://docs.openclaw.ai/refactor/database-first`
- OpenClaw session management deep dive: `https://docs.openclaw.ai/reference/session-management-compaction`
- OpenClaw backup reference: `https://docs.openclaw.ai/cli/backup`
- OpenClaw updating and rollback guidance: `https://docs.openclaw.ai/install/updating`
- Gemini Interactions API stateless mode: `https://ai.google.dev/gemini-api/docs/interactions-overview`
- Gemini thought signatures: `https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures`
- GoClaw, **Caching**: `https://docs.goclaw.sh/caching`
- GoClaw source, **Caching**: `https://github.com/nextlevelbuilder/goclaw-docs/blob/master/advanced/caching.md`
- GoClaw, **How GoClaw Works**: `https://docs.goclaw.sh/how-goclaw-works`
- GoClaw, **Sessions and History**: `https://docs.goclaw.sh/sessions-and-history`
