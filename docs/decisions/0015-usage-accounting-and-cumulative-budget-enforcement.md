# ADR 0015: Usage Accounting and Cumulative Budget Enforcement

- **Status:** Accepted
- **Date:** 2026-07-24
- **Decision owners:** my-agent-v2 maintainers
- **Related architecture:** `docs/ARCHITECTURE.md`
- **Related decisions:**
  - `docs/decisions/0005-agent-runtime-harness-and-model-provider-boundaries.md`
  - `docs/decisions/0006-run-attempt-lifecycle-and-per-session-serialization.md`
  - `docs/decisions/0009-storage-ownership-sqlite-and-migration-policy.md`
  - `docs/decisions/0010-runtime-events-logs-transcripts-and-audit-separation.md`
  - `docs/decisions/0013-control-ui-and-session-presentation-surfaces.md`

## Context

`my-agent-v2` needs durable answers to four questions that are related but not interchangeable:

```text
Usage accounting       How many provider tokens and how much configured cost were consumed?
Run-local budgets      How many iterations, model calls, tool calls, and elapsed time may this run use?
Cumulative usage caps  How much may all matching runs consume during a day or month?
Capacity limits        How many calls or operations may execute concurrently?
```

The existing runtime already has per-run iteration, model-call, tool-call, elapsed-time, context, and concurrency limits. Those limits cannot prevent two different sessions from concurrently consuming more than an operator-configured daily or monthly token/cost budget.

Provider usage metadata and Run Journal evidence also do not form a reliable accounting ledger by themselves:

- technical logs may rotate or be cleared;
- Run Journal retention is development-oriented and is not an accounting authority;
- transcript content cannot reconstruct cached, thinking, tool-use, partial, or provider-specific usage reliably;
- a preflight token estimate is not the same as provider-reported actual usage;
- concurrent calls can both observe the same remaining headroom unless budget is reserved atomically;
- a transport timeout after dispatch does not prove that the provider did no billable work.

GoClaw separates request quotas from token/cost limits and uses a reserve-then-settle model around LLM calls. That provides useful concurrency and failure semantics, but its multi-tenant, channel/user quota, edition, Redis, PostgreSQL, and commercial billing scope is larger than this local-first V1.

`my-agent-v2` therefore adds a small usage domain focused on durable model-call accounting and operator-configured cumulative safety caps.

## Decision

`src/usage/` owns normalized usage accounting semantics, price resolution, cumulative cap evaluation, reservation lifecycle, settlement, and usage-management application contracts.

V1 implements:

```text
Durable model-call Usage Ledger
+ versioned operator price catalog
+ optional cumulative token and cost caps
+ atomic reserve → dispatch → settle lifecycle
+ UTC daily and monthly windows
+ Run Journal evidence by reference
```

Usage tracking remains active even when no cap policy is configured.

Request-count quotas by user, channel, group, hour, week, or commercial edition are deferred.

## Boundary and ownership

The following concepts remain distinct:

| Boundary | Authority |
|---|---|
| Model Provider adapter | Provider transport, raw usage decoding, normalized provider outcome, and billing certainty |
| Usage Runtime | Price lookup, cumulative-cap matching, reservations, settlement, reconciliation state, and usage queries |
| Agent Runtime | Model-call lifecycle, stage/checkpoint decisions, and terminal run behavior |
| Usage Ledger | Durable accounting and cap-enforcement source of truth |
| Run Journal | Per-run execution evidence referencing usage records and decisions |
| Runtime capacity limiter | Concurrent resource availability, not cumulative expenditure |

The provider adapter does not calculate operator cost, choose cap policy, query cumulative balances, or authorize overspend.

The Usage Runtime does not assemble prompts, select models, retry provider calls, mutate transcripts, or decide whether an attempt continues.

Gateway, Control UI, Harness, Context, Run Journal, and technical logs do not calculate authoritative usage by scanning their own records.

## Core identities

Every model call has a host-generated `modelCallId` before reservation.

Usage records use independent durable identities:

```text
usageReservationId
usageRecordId
usageCapPolicyId
priceRevision
```

They correlate with:

```text
agentId
sessionId
runId
attemptId
modelCallId
providerId
modelId
```

A usage identity is not a substitute for any run, session, provider-request, or provider-interaction identity.

## Normalized provider usage

Provider adapters return normalized usage without guessing missing dimensions or double-counting overlapping fields.

Conceptually:

```ts
interface NormalizedModelUsage {
  readonly providerTotalTokens?: bigint;
  readonly inputTokens?: bigint;
  readonly cachedInputTokens?: bigint;
  readonly outputTokens?: bigint;
  readonly thinkingTokens?: bigint;
  readonly toolUseTokens?: bigint;
  readonly measurement: "provider-exact" | "partial" | "unknown";
}
```

`providerTotalTokens`, when supplied and documented by the provider response, is the preferred token-cap settlement quantity.

Dimension fields are retained for cost calculation and diagnostics only according to a provider-specific, versioned normalization rule. The Usage Runtime must not assume that every dimension is disjoint or compute a total by blindly adding all fields.

The normalized provider outcome also declares billing certainty:

```text
not-dispatched
not-billable
actual-known
billing-ambiguous
```

The provider adapter may classify a request as `not-billable` only when the failure semantics establish that no model execution was accepted. A generic timeout, disconnect, or unknown transport failure after dispatch is `billing-ambiguous`.

Raw provider usage payloads remain inside the provider boundary. Evidence stores normalized values, rule versions, and bounded hashes/references.

## Usage record

A settled or unresolved model call produces a durable record conceptually equivalent to:

```ts
interface UsageRecord {
  readonly usageRecordId: string;
  readonly usageReservationId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly modelCallId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly usage: NormalizedModelUsage;
  readonly providerUsageRuleVersion: string;
  readonly providerUsageRawHash?: string;
  readonly priceRevision?: string;
  readonly costMicros?: bigint;
  readonly costMeasurement: "derived" | "unknown";
  readonly outcome: "settled" | "released" | "uncertain";
  readonly occurredAt: string;
}
```

Currency amounts use integer micros. Floating-point currency is prohibited in authoritative accounting.

A record with exact tokens and no matching price remains valid:

```text
tokens = provider-exact
cost = unknown
```

Unknown cost is never displayed or enforced as zero.

## Price catalog

V1 uses a versioned operator-owned price catalog.

A price record identifies at least:

```text
priceRevision
providerId/provider type
exact modelId
effectiveFrom
effectiveUntil when applicable
currency = USD
pricing dimensions and integer micros per unit
source/configuration fingerprint
```

The catalog may distinguish uncached input, cached input, output, thinking, or tool-use dimensions only when the provider normalization contract can map them without double-counting.

Each usage settlement records the `priceRevision` used. Updating the active catalog does not rewrite historical cost values.

Provider adapters do not download or trust live public pricing during a model call. Price changes are explicit operator/repository configuration changes with validation.

If no cost cap matches, missing pricing yields `costMeasurement: unknown` while token accounting continues.

If a matching enabled cost cap requires cost estimation and no compatible active price revision exists, reservation fails closed with:

```text
USAGE_PRICING_UNKNOWN
```

## Cumulative cap policies

V1 cap policies support these optional scopes:

```text
global
agentId
providerId
modelId
```

Supported windows are:

```text
day in UTC
month in UTC
```

Supported metrics are:

```text
provider total tokens
cost micros
```

A conceptual policy is:

```ts
interface UsageCapPolicy {
  readonly usageCapPolicyId: string;
  readonly revision: number;
  readonly agentId?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly window: "day" | "month";
  readonly windowTimeZone: "UTC";
  readonly maxTokens?: bigint;
  readonly maxCostMicros?: bigint;
  readonly enabled: boolean;
}
```

All enabled policies matching a model call apply. A specific agent or model policy does not replace or bypass a global cap.

Disabled or absent policies do not disable usage accounting.

Policy changes apply to new reservations. Existing reservation and usage records retain the policy IDs and revisions evaluated when they were created.

## Reservation lifecycle

Every provider model call passes through `UsageBudgetGate` after the exact provider/model route and candidate request budget are known and before provider dispatch.

The lifecycle is:

```text
prepare model call and modelCallId
→ calculate bounded reservation estimate
→ atomically match policies, calculate headroom, and persist reservation
→ persist dispatched state before network dispatch
→ dispatch provider request
→ normalize provider outcome and actual usage
→ atomically settle, release, or mark uncertain
→ expose usage outcome to CheckpointStage
```

Reservation states are:

```text
reserved
dispatched
settled
released
uncertain
```

`reserved` means durable budget was acquired but dispatch has not been recorded.

`dispatched` is persisted before the provider network call. This ordering may conservatively retain budget if the process crashes between the durable marker and actual network transmission, but it avoids treating a potentially billable sent request as free.

`settled` replaces the reservation estimate with normalized actual usage and derived cost.

`released` means the call is known not to have produced billable model work.

`uncertain` means the call was marked dispatched but actual provider usage cannot be established safely.

Settled actual usage, active reservations, dispatched reservations, and uncertain reservations all consume matching cap headroom. Released reservations do not.

## Reservation estimate

The estimate is calculated from the prepared request and selected route using versioned policy:

```text
measured or estimated input tokens
+ configured maximum output allowance
+ configured thinking allowance when applicable
+ provider-specific bounded safety margin
```

When ContextStage has obtained an exact provider `countTokens` result, that exact input count is used. Otherwise a versioned local estimate may be used and its measurement mode is recorded.

Cost reservation uses the matching price revision and the same conservative allowances.

The estimate is not reported as actual provider usage. Settlement replaces it when actual usage is known.

Reservation rules and margins are configuration captured by revision/fingerprint, not hidden constants in the provider adapter.

## Atomic cap enforcement

`UsageLedgerStore.reserve` owns one short SQLite transaction that:

1. resolves the UTC window starts for all matching policy revisions;
2. reads settled totals plus active/dispatched/uncertain reservation amounts;
3. verifies token and cost headroom for every matching policy;
4. inserts the reservation and matched policy revisions only when all caps allow it;
5. commits before provider dispatch.

The implementation may use `BEGIN IMMEDIATE` or another storage-owned mode that serializes competing reservations correctly. The application contract does not expose raw SQLite transaction control.

Check and reservation insert must not occur in separate transactions.

No database transaction remains open during provider network I/O.

Settlement, release, and uncertain transition are short idempotent transactions keyed by reservation/model-call identity. A reservation may reach only one terminal accounting state.

## Provider outcomes and failure semantics

Settlement rules are:

| Provider outcome | Accounting result |
|---|---|
| Exact/partial provider usage returned | Settle normalized actual usage and derivable cost |
| Rejected before billable execution with explicit certainty | Release reservation |
| Partial response with reported usage | Settle reported partial actual usage |
| Timeout/disconnect after durable dispatch with unknown billing | Mark reservation uncertain |
| Process restart finds `reserved` but not `dispatched` | Release through explicit recovery |
| Process restart finds `dispatched` without terminal accounting | Mark uncertain through explicit recovery |

An ambiguous call is not automatically released after a timeout or TTL.

Uncertain reservations remain counted until an explicit reconciliation operation resolves them. V1 does not claim automatic reconciliation against provider billing exports.

If settlement persistence fails after a provider response, the model call is not retried. The reservation remains recoverable and the run fails or stops through a typed accounting error such as:

```text
USAGE_SETTLEMENT_REQUIRED
```

Repeating the provider call to repair an accounting write would risk duplicate cost and output.

## Agent Runtime and CheckpointStage

Run-local budgets and cumulative caps are evaluated independently.

Before each `ModelStage` provider dispatch:

```text
run-local model-call budget
runtime capacity permit
context/request preparation
UsageBudgetGate reservation
provider dispatch
usage settlement
CheckpointStage
```

A blocked reservation emits a typed signal and no provider request is sent.

Applicable normalized errors include:

```text
LOCAL_USAGE_CAP_EXCEEDED
USAGE_PRICING_UNKNOWN
USAGE_RESERVATION_FAILED
USAGE_SETTLEMENT_REQUIRED
USAGE_SETTLEMENT_UNCERTAIN
```

Provider-owned limits remain distinct:

```text
PROVIDER_RATE_LIMITED
PROVIDER_QUOTA_EXCEEDED
```

`CheckpointStage` consumes these outcomes. V1 does not automatically switch to a cheaper model, reduce protected Prompt Plan sections, lower thinking configuration, rotate credentials, or wait for a future window. Such fallback requires explicit policy and a new reservation.

Every retry attempt and every additional model call requires its own reservation. A prior released, settled, or uncertain reservation cannot authorize another dispatch.

A run may already be accepted and have its user input committed before a later model call is blocked, because exact route/context estimates are model-call-level information. The blocked run follows normal failure and `FinalizeStage` semantics.

## Storage ownership

`UsageLedgerStore` is a usage-domain contract implemented by the V1 SQLite storage adapter.

It owns durable operations for:

```text
reserve
markDispatched
settle
release
markUncertain
reconcile explicitly
query bounded usage totals
query active/uncertain reservations
```

Storage owns tables, indexes, transaction mechanics, and migration. Usage Runtime owns policy matching, accounting meaning, pricing semantics, and reconciliation authority.

Usage tables share the one V1 SQLite database but remain separate from transcript, Run Journal, memory, and session runtime-summary tables.

Usage state is not deleted by session reset, transcript deletion, log rotation, or ordinary Run Journal clear. Explicit usage retention or purge requires a separately scoped management operation and must not invalidate active cap enforcement.

V1 queries must support bounded views by:

```text
run
session
agent
provider/model
UTC day/month
reservation status
cap policy and utilization
```

Hourly materialized summaries, Redis counters, PostgreSQL, and distributed reservation coordination are deferred.

## Observability and Run Journal

Usage accounting emits typed evidence such as:

```text
usage.reservation.requested
usage.reservation.granted
usage.reservation.blocked
usage.dispatch.marked
usage.settlement.completed
usage.reservation.released
usage.settlement.uncertain
usage.reconciliation.completed
```

Evidence includes bounded metadata:

```text
usageReservationId and usageRecordId
modelCallId, runId, attemptId
providerId and exact modelId
matched cap policy IDs and revisions
window starts
estimated/reserved tokens and cost
measurement mode and estimation-rule version
actual normalized usage
price revision and derived cost
remaining headroom when safely reportable
terminal accounting status and reason code
```

The Run Journal stores references and decision evidence. It is not the Usage Ledger and is never scanned to enforce caps.

Raw provider billing payloads, credentials, and unrestricted prompts/responses are not copied into usage records or journal rows.

Required reservation and settlement evidence follows Agent Runtime ordering, but a Run Journal outage does not turn a denied cap into permission. The authoritative reservation transaction must succeed before dispatch.

## Management and presentation

Usage query and cap-management operations are application capabilities exposed through typed services and future Gateway methods.

The Control UI may eventually display:

```text
usage by run/session/agent/model
UTC day/month totals
configured caps and revisions
remaining headroom
active and uncertain reservations
unknown-price or reconciliation warnings
```

The UI must not read SQLite directly, calculate authoritative totals client-side, or treat provider dashboard values as local ledger state.

V1 does not implement invoices, payments, tenant billing, chargeback, commercial plans, or user/channel request quotas.

## Security and privacy

Usage records are metadata about user activity and model consumption.

Access is restricted through application capabilities. Normal client events and logs should expose only the minimum bounded totals and status needed by the consumer.

Usage records must not include:

- prompt or response bodies;
- API keys or auth headers;
- raw Gemini thought signatures;
- private model reasoning;
- unrestricted tool results or attachments.

Broad purge or reconciliation operations require explicit operator intent, preview where practical, and durable evidence.

## Consequences

### Positive

- Concurrent sessions cannot independently spend the same remaining cap headroom.
- Usage remains queryable even when development journals or logs are cleared.
- Provider actual usage replaces estimates without losing the original reservation evidence.
- Unknown billing after dispatch is handled conservatively instead of silently treated as free.
- Versioned price revisions make historical cost explainable.
- Token and cost caps are independent from per-run loop budgets and process concurrency.
- Future UI, channel, or multi-agent quotas can extend a dedicated usage boundary.

### Negative

- Every model call adds durable reservation and settlement writes.
- Conservative uncertain reservations may temporarily underutilize a configured budget.
- Price catalog maintenance is an operator responsibility.
- Provider usage ambiguity requires explicit reconciliation rather than automatic cleanup.
- Cost calculations require provider-specific normalization tests and exact integer arithmetic.

## Risks and trade-offs

### Provider usage dimensions are misunderstood

A provider may expose overlapping totals and dimensions.

Mitigation:

- versioned provider normalization rules;
- prefer documented provider total for token caps;
- retain measurement status;
- test representative cached/thinking/tool-use responses;
- never sum unknown overlapping dimensions blindly.

### Reservation estimate is too low

Actual usage may exceed the reserved estimate and cross a cap.

Mitigation:

- reserve configured maximum output/thinking allowances;
- use exact input preflight near limits;
- use bounded provider-specific margin;
- settle actual usage even when it exceeds estimate;
- emit cap-overrun evidence and block later calls.

A hard cumulative cap is best-effort within provider-reporting and estimation limits; it is not a guarantee that a single accepted provider call cannot exceed its reservation.

### Reservation estimate is too high

Conservative reservations may block valid work.

Mitigation:

- release unused headroom immediately on settlement;
- version and test estimation rules;
- expose headroom and active reservations;
- keep uncertain state explicit rather than hiding it.

### Crash leaves ambiguous reservations

A process may stop between durable dispatch marking and settlement.

Mitigation:

- persist dispatch before network I/O;
- release only never-dispatched reservations;
- convert orphaned dispatched reservations to uncertain on recovery;
- provide bounded reconciliation queries and explicit operations.

### Price revision is missing or wrong

Cost caps may be unusable or inaccurate.

Mitigation:

- validate configured model/price compatibility at startup where possible;
- fail closed only when a matching cost cap requires price;
- preserve exact price revision per settlement;
- display unknown cost rather than zero.

### Usage ledger becomes a billing platform

Product pressure may expand accounting into invoices, tenants, plans, and chargeback.

Mitigation:

- keep V1 operator safety scope explicit;
- defer request quotas and commercial billing;
- require ADRs for multi-user authorization and externally relied-upon billing semantics.

## Rejected alternatives

### Calculate usage from transcript or prompt text

Rejected because transcript does not contain reliable provider billing dimensions, retries, partial calls, cached tokens, thinking usage, or failed/ambiguous dispatches.

### Use Run Journal as the accounting ledger

Rejected because Run Journal has different retention, payload, failure, and query semantics and is organized per run rather than as a cumulative enforcement authority.

### Check cumulative caps without reservation

Rejected because concurrent sessions could both observe the same remaining headroom and dispatch before either usage result commits.

### Check quota only when a run is accepted

Rejected because one run may contain multiple model calls and exact route/context usage is known only before each call.

### Release every timeout reservation

Rejected because a dispatched provider request may have completed and been billed even when the local connection timed out.

### Treat unknown price as zero

Rejected because it silently bypasses cost caps and misrepresents historical cost.

### Let the provider adapter enforce local budgets

Rejected because provider transport must not own operator policy, cumulative SQLite state, price configuration, or run continuation decisions.

### Automatically choose a cheaper model after a cap block

Rejected because it changes the pinned route and model-visible behavior without explicit policy, validation, and a new reservation.

### Add Redis or PostgreSQL counters in V1

Rejected because V1 has one local writer and SQLite can serialize short reservation transactions without distributed coordination.

### Implement per-user/channel request quota now

Rejected because V1 has one trusted local user and messaging channels are deferred. Request admission quotas require normalized external identities and separate policy semantics.

### Reconcile against provider billing automatically

Rejected because provider billing exports, identity mapping, latency, and authority are not yet defined. V1 exposes explicit uncertain state and manual reconciliation seams.

## Validation

This decision is correctly applied when:

- `src/usage/` owns usage accounting, pricing, cap matching, reservation, settlement, and query semantics;
- every model call has a host `modelCallId` before usage reservation;
- provider adapters normalize usage and billing certainty without enforcing local cap policy or calculating operator cost;
- provider total and dimension fields are not blindly double-counted;
- usage accounting persists even when no cap policy is configured;
- V1 policies support global/agent/provider/model scope and UTC day/month windows;
- all matching enabled policies are enforced together;
- token and cost amounts use integer types and cost uses micros;
- cost caps fail closed when a compatible price revision is unavailable;
- check-plus-reserve is one short atomic SQLite transaction;
- dispatched state is durable before provider network I/O;
- no provider request is sent when reservation is blocked or persistence fails;
- actual provider usage replaces the estimate when known;
- explicit non-billable rejection releases the reservation;
- ambiguous post-dispatch timeout becomes uncertain and remains counted;
- every additional model call or retry obtains a new reservation;
- settlement failure never causes automatic provider replay;
- run-local budgets, runtime concurrency, provider external quota, and local cumulative caps remain distinct;
- `UsageLedgerStore` is the cap/accounting authority and Run Journal keeps only evidence/references;
- session reset, transcript deletion, and journal clear do not silently delete usage state;
- Gateway/UI do not query SQLite or calculate authoritative totals directly;
- migration, concurrency, crash-recovery, over-estimate, under-estimate, unknown-price, partial-usage, timeout, and reconciliation tests exist;
- user/channel request quotas, invoices, payments, and distributed counters are not represented as implemented.

## Revisit conditions

Revisit this decision when:

- multiple processes or remote workers can dispatch model calls concurrently;
- provider billing exports or reconciliation APIs become available;
- externally relied-upon billing, invoices, payments, tenant plans, or chargeback are introduced;
- per-user, channel, group, hourly, or weekly request quotas become requirements;
- non-model tools or browser operations require monetary accounting;
- model fallback or automatic cheaper-route policy is introduced;
- usage windows need operator-local time zones rather than UTC;
- Redis, PostgreSQL, or distributed reservation coordination becomes necessary;
- pricing rules require tiered, volume, regional, or negotiated-rate semantics;
- usage retention, encryption, export, or compliance requirements change;
- uncertain reservations require automatic expiry or provider-backed reconciliation.

## References

- `docs/ARCHITECTURE.md`, section 9, **Agent Runtime architecture**
- `docs/ARCHITECTURE.md`, section 10, **Model runtime and providers**
- `docs/ARCHITECTURE.md`, section 20, **Storage and migrations**
- `docs/ARCHITECTURE.md`, section 21, **Events, logs, Run Journal, and audit**
- `docs/ARCHITECTURE.md`, section 22, **Lifecycle and composition**
- `docs/decisions/0005-agent-runtime-harness-and-model-provider-boundaries.md`
- `docs/decisions/0006-run-attempt-lifecycle-and-per-session-serialization.md`
- `docs/decisions/0009-storage-ownership-sqlite-and-migration-policy.md`
- `docs/decisions/0010-runtime-events-logs-transcripts-and-audit-separation.md`
- `docs/decisions/0013-control-ui-and-session-presentation-surfaces.md`
- GoClaw, **Usage & Quota**: `https://docs.goclaw.sh/usage-quota`
- GoClaw source, **Usage & Quota**: `https://github.com/nextlevelbuilder/goclaw-docs/blob/master/advanced/usage-quota.md`
- Gemini token counting and usage: `https://ai.google.dev/gemini-api/docs/tokens`
