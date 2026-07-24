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

## Context

`my-agent-v2` needs local durable storage for session routing, transcripts, runtime metadata, and later application state without coupling domain modules to SQLite or allowing Gateway handlers to become data-access code.

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
- future multi-agent isolation without treating the V1 `primary` agent as a global singleton.

Without a storage decision, implementation could drift into incompatible patterns such as:

- Gateway handlers issuing SQL directly;
- domain contracts exposing tables, transactions, or SQLite row shapes;
- one generic repository owning unrelated business rules;
- parallel JSON and SQLite sources of truth;
- silently falling back to in-memory storage after database failure;
- editing a migration that has already run on user data;
- performing destructive legacy imports during ordinary startup;
- splitting into multiple database files before ownership and lifecycle require it;
- copying a live SQLite file as a backup while WAL state remains outside the main file.

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
```

Concrete SQLite adapters may remain beside the domain contracts when that keeps mapping and invariants clear:

```text
src/sessions/sqlite-session-store.ts
src/sessions/sqlite-transcript-store.ts
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

A concrete store persists and loads domain state. It does not become the authority for routing, reset permission, run sequencing, policy, or transcript semantics that belong to higher-level domain services and previous ADRs.

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

The initial schema may include session and migration tables. Future modules must not place unrelated fields into an existing table merely to avoid creating a properly owned schema.

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

The storage layer may provide an internal transaction context accepted by concrete store adapters. The public application contract should remain domain-shaped rather than exposing generic transaction management to Gateway handlers or Agent Runtime code.

Nested transaction assumptions must be avoided unless the storage implementation defines their semantics explicitly.

Long-running model calls, tool execution, browser operations, network calls, or human approval waits must never hold an open SQLite transaction.

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
- pagination;
- cursors;
- bounded ranges;
- targeted lookup by durable identity.

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

Session reset follows ADR 0003 and preserves the prior transcript by default.

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

### Hold a transaction for an entire agent run

Rejected because model calls, tools, approvals, and browser operations are long-running and would create lock contention and fragile recovery. Transactions protect bounded durable mutations, while ADR 0006 controls run ordering.

### Implement reverse migration for every schema change

Rejected because reverse migrations can be destructive and are difficult to validate. Verified restore is the default downgrade recovery model until a specific product requirement justifies reversible migration tooling.

## Validation

This decision is correctly applied when:

- V1 persistent mode opens one configured SQLite database through bootstrap;
- storage opens and migrates before Gateway readiness;
- Gateway, Agent Runtime, Context, Harness, Model, Policy, and Tool modules do not issue SQL directly;
- domain modules expose narrow store contracts using domain types;
- concrete SQLite adapters are the only normal path from those contracts to SQL;
- `SessionStore` and `TranscriptStore` remain separate contracts even when sharing one database;
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
- architecture and implementation do not claim a global/per-agent database split until it is actually introduced.

## Revisit conditions

Revisit this decision when:

- more than one agent has enough data or lifecycle independence to justify per-agent databases;
- multiple processes or remote workers need concurrent database access;
- a subsystem requires independent backup, restore, encryption, retention, or failure isolation;
- database size or write contention exceeds acceptable local SQLite behavior;
- user-facing backup and restore become a release requirement;
- credentials or other highly sensitive state require a separate encrypted store;
- plugins need durable schemas or namespaced key-value storage;
- online migrations or zero-downtime upgrades become necessary;
- session or transcript state must replicate across devices;
- a non-SQLite backend is required;
- the project introduces a persistent event or audit store with materially different retention and integrity requirements.

## References

- `docs/ARCHITECTURE.md`, section 11, **Sessions and transcripts**
- `docs/ARCHITECTURE.md`, section 19, **Storage and migrations**
- `docs/ARCHITECTURE.md`, section 21, **Lifecycle and composition**
- `docs/ARCHITECTURE.md`, section 22, **Dependency direction**
- `docs/decisions/0002-core-runtime-identities-and-agent-ownership.md`
- `docs/decisions/0003-session-routing-transcript-separation-and-reset-semantics.md`
- `docs/decisions/0006-run-attempt-lifecycle-and-per-session-serialization.md`
- `docs/decisions/0007-context-assembly-and-transcript-mutation-authority.md`
- OpenClaw database-first state refactor: `https://docs.openclaw.ai/refactor/database-first`
- OpenClaw session management deep dive: `https://docs.openclaw.ai/reference/session-management-compaction`
- OpenClaw backup reference: `https://docs.openclaw.ai/cli/backup`
- OpenClaw updating and rollback guidance: `https://docs.openclaw.ai/install/updating`
