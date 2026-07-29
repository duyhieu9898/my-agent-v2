# Active Plan 0002: Milestone 3 — Tool Runtime

**Date:** 2026-07-28
**Status:** ACTIVE — closure remediation in progress
**Scope:** Milestone 3 only
**Target outcome:** Model-requested workspace tools execute through Tool Runtime, policy, approval, execution, transcript, evidence, and checkpoint boundaries, then continue to a final assistant response
**Architecture authority:** `docs/ARCHITECTURE.md`; ADR 0005, 0006, 0007, 0008, 0009, 0010, 0012, and 0015
**Roadmap authority:** `docs/IMPLEMENTATION_PLAN.md`, Milestone 3
**Dependency baseline:** M0–M2 PASS; `docs/plans/active/0001-core-runtime-vertical-slice.md` CLOSED
**Implementation baseline:** `master` at `7263b0c0629d27ba42ad396bb3703d050a3fdf19`
**Baseline provenance:** remote `master` was inspected at this commit; implementation verified against working tree
**Current reviewed checkpoint:** `9c9792c3ebe8153c20427a4992c0c32d10d75796`
**M3 deterministic:** PASS at the recorded current test checkpoint
**M3 controlled side effect:** FAIL — independent closure audit; remediation in progress
**M3 Gemini live:** NOT RUN — optional/nonblocking under the current plan
**Overall M3:** FAIL — not eligible for synchronization

## 1. Outcome

Implement the smallest production-shaped Tool Runtime vertical slice that proves:

```text
Gateway agent.run
→ immutable agent/tool/policy/sandbox snapshot
→ visibility-approved tool definitions in model context
→ normalized model tool request
→ ToolStage
→ registry lookup and schema validation
→ invocation policy
→ bound allow-once approval when required
→ explicit workspace execution boundary
→ bounded scheduling, timeout, cancellation, and normalization
→ ordered Run Journal and RuntimeEvent evidence
→ Agent Runtime atomic transcript mutation
→ CheckpointStage continue decision
→ next model call
→ final assistant result
→ exactly-once FinalizeStage
```

The slice contains:

- two safe read-only workspace tools;
- one approval-gated controlled workspace write;
- deterministic fake-provider integration;
- one real temporary-workspace side-effect verification;
- no shell, browser, memory, dynamic plugin, persistent approval, or strong sandbox work.

Implementation ends with:

```text
Implementation completed; pending independent closure audit.
```

Implementation must not mark M3 PASS.

## 2. Required Preflight And Authority

Before implementation edits, run and record:

```bash
git rev-parse --show-toplevel
git rev-parse HEAD
git branch --show-current
git status --short --branch
git log --oneline -5
git diff --stat
git diff --check
```

Read before editing:

```text
all applicable AGENTS.md
docs/WORKFLOW.md
docs/ARCHITECTURE.md, especially §§9, 11, 13, 14, 20, 21, 22, 23
docs/decisions/README.md
ADR 0005, 0006, 0007, 0008, 0009, 0010, 0012, 0015
docs/IMPLEMENTATION_PLAN.md
docs/plans/active/0001-core-runtime-vertical-slice.md
docs/templates/exec-plan.md
current runtime, model, harness, context, transcript, Gateway, storage,
configuration, bootstrap, usage, and test code touched by M3
```

Authority map:

| Area                                                    | Authority                        |
| ------------------------------------------------------- | -------------------------------- |
| Runtime/Harness/provider ownership                      | Architecture §§9–10; ADR 0005    |
| Stages, checkpoint, finalization, session lane          | Architecture §9.4; ADR 0006      |
| Context and transcript mutation                         | Architecture §§9.5, 11; ADR 0007 |
| Tool Runtime, policy, approval, execution, batching     | Architecture §§13–14; ADR 0008   |
| Storage and migrations                                  | Architecture §20; ADR 0009       |
| RuntimeEvent, Run Journal, transcript, audit separation | Architecture §21; ADR 0010       |
| Static registry direction                               | Architecture §§22–23; ADR 0012   |
| Usage for every model call                              | Architecture §10; ADR 0015       |
| M3 outcome and exit signal                              | `docs/IMPLEMENTATION_PLAN.md`    |

Stop before implementation if tracked changes overlap M3 surfaces, current status contradicts M0–M2 closure, or a locked requirement would need an Architecture/ADR change. Do not reset, stash, clean, discard, or use untracked files as evidence unless explicitly named.

M0–M2 remain PASS/CLOSED. M3 may refactor their production path only to add tools without weakening usage, continuation, persistence, cancellation, terminal ordering, startup reconciliation, or session-lane invariants.

## 3. Baseline Audit

Observed at `7263b0c`:

| Seam              | Existing                                                | M3 gap                                                          |
| ----------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| Agent snapshot    | tool/policy/sandbox fields exist                        | all are literal `none` placeholders                             |
| Bootstrap         | composes registries, runtime, provider, stores, Gateway | no Tool Registry, policy, approval, executor, or Tool Runtime   |
| Harness           | one host-owned model step                               | no tool definitions or normalized tool requests                 |
| Model contract    | text, usage, continuation                               | no function/tool request or result contract                     |
| Gemini adapter    | text and thought-signature projection                   | no function declarations/calls/results                          |
| Context           | minimal `main-v1` context                               | no visible tool definitions or hashes                           |
| Agent Runtime     | one model call then terminalization                     | no active ToolStage or model→tool→model loop                    |
| Checkpoint        | declares `continue`                                     | implementation maps success directly to complete                |
| Transcript        | message and tool-result types                           | no explicit tool-call type or pairing validation                |
| SQLite transcript | generic tool columns, unconstrained entry type          | adapter/domain types must be extended; schema may be sufficient |
| RuntimeEvent      | run/model correlation                                   | no toolCallId, approvalId, or parent operation                  |
| Run Journal       | durable ordered JSON metadata                           | incomplete tool/policy/approval/schedule evidence               |
| Gateway           | typed methods and run-owned events                      | no approval method                                              |
| Config            | run timeout and model capacity                          | no tool limits, capacity, or approval timeout                   |
| Errors            | core M0–M2 codes                                        | no tool/policy/approval/sandbox codes                           |
| Tests             | M0–M2 closure evidence                                  | no M3 lifecycle or controlled side-effect proof                 |

Reusable dependencies:

- bootstrap-only composition;
- immutable agent snapshot;
- Harness Registry pattern;
- per-session lane and runtime capacity;
- transcript atomic append;
- durable Run Journal;
- RuntimeEvent→Gateway projection;
- Gemini Interactions `store=false`;
- provider continuation sidecars;
- per-model-call usage reserve–dispatch–settle;
- cancellation and exactly-once finalization;
- startup fail-closed reconciliation.

## 4. Locked Scope

### 4.1 Tool profile and identities

The active M3 profiles are:

```text
toolProfile: workspace-tools-v1
policyProfile: workspace-policy-v1
sandboxProfile: host-workspace-v1
```

The immutable production registry contains exactly:

| Tool                   | Effect         | Concurrency   | Approval                  | Capability                                         |
| ---------------------- | -------------- | ------------- | ------------------------- | -------------------------------------------------- |
| `workspace.list`       | read-only      | parallel-safe | no, when policy allows    | bounded directory listing under agent workspace    |
| `workspace.read_text`  | read-only      | parallel-safe | no, when policy allows    | bounded UTF-8 range read under workspace           |
| `workspace.write_text` | side-effecting | sequential    | allow-once for every call | atomic create or replace of one bounded UTF-8 file |

M3 does not register shell, process, network, browser, delete, rename, chmod, package, service, credential, arbitrary-filesystem, or memory tools.

Tool names are stable host identities. Duplicate registration fails during bootstrap. Registry publication is immutable for process lifetime; load order never replaces ownership.

### 4.2 Tool descriptor and registry

Each registration includes:

```text
name and descriptorVersion
owningModule and description
argument and normalized-result schemas
side-effect and sensitivity classification
execution target and sandbox requirement
timeout and cancellation support
parallel-safe or sequential trait
idempotency trait
approval summary renderer
redaction rules
input/output limits
progress-fingerprint version
implementation
```

Rules:

- use lowercase dotted tool names;
- compute a deterministic fingerprint from canonical descriptor metadata and schemas;
- never hash implementation objects or secrets;
- freeze tool, policy, and sandbox fingerprints into the run snapshot;
- Context and Agent Runtime consume registry contracts, not concrete tools;
- dynamic loading, hot replacement, aliases, and plugin manifests are deferred.

### 4.3 Schemas and validation

Use TypeBox plus AJV, following existing runtime validation direction.

Required order:

```text
registry lookup
→ raw argument schema validation
→ normalization
→ input-size validation
→ immutable normalized arguments
→ invocation policy
→ approval
→ execution
→ result schema/size validation
```

Rules:

- TypeScript types alone are not validation;
- schemas are closed unless intentionally extensible;
- unknown tool: `TOOL_NOT_FOUND`;
- invalid/extra/oversized arguments: `TOOL_ARGUMENTS_INVALID`;
- validation failure performs no approval and no implementation I/O;
- result validation happens before transcript commit;
- oversized result: `TOOL_RESULT_TOO_LARGE`;
- M3 does not silently truncate or discard tool results.

Arguments:

```text
workspace.list:
  path: normalized relative workspace path
  limit?: positive integer capped by config

workspace.read_text:
  path: normalized relative workspace path
  offsetBytes?: non-negative integer
  maxBytes?: positive integer capped by config

workspace.write_text:
  path: normalized relative workspace path
  content: bounded UTF-8 string
  mode: create | replace
```

Results:

```text
workspace.list:
  path, entries[name + kind], returnedCount, hasMore

workspace.read_text:
  path, offsetBytes, bytesRead, fileSizeBytes, eof, text, chunkHash

workspace.write_text:
  path, mode, bytesWritten, priorState,
  previousHash when replaced, resultingHash
```

No result exposes absolute host paths, environment values, credential data, unrestricted metadata, or implementation objects.

### 4.4 Policy

`workspace-policy-v1` is deterministic and evaluated twice:

1. visibility before each model request;
2. invocation after argument normalization, then revalidated after approval.

Visibility:

- expose tools only when their executor is available;
- omit categorically denied/unavailable tools;
- `workspace.write_text` may remain visible because invocation requires approval;
- visibility never proves invocation authority.

Invocation:

- explicit deny wins;
- read-only tools may run only within the resolved workspace and outside protected paths;
- every write returns `require-approval`;
- missing/invalid policy, workspace ownership, or enforcement fails closed;
- decision evidence includes profile/version, stable reason, constraints, and redaction metadata.

Deny:

```text
absolute paths
empty disallowed paths
.. traversal after normalization
NUL/control-character path injection
resolved escape from workspace
symlink path components or final target
.git/
.ssh/
.env and .env.*
*.pem
*.key
id_rsa
id_ed25519
application data/state directory when overlapping workspace
non-regular-file writes
device, socket, FIFO, shell, process, or network behavior
```

Policy may become stricter when evidence reveals an equivalent escape. It must not become weaker without reviewer approval.

### 4.5 Approval

Implement one in-memory `ApprovalCoordinator`.

Approval request binds:

```text
approvalId
agentId, sessionKey, sessionId
runId, attemptId, modelCallId, toolCallId
tool name
normalized-argument digest
execution target and sandbox profile
bounded action summary
createdAt and expiresAt
policy profile and reason
```

Behavior:

- decisions: `allow-once` or `deny`;
- approval cannot override policy deny;
- changed tool, arguments, workspace, target, sandbox, run, or attempt invalidates approval;
- write summary shows path, mode, byte count/hash — never full content;
- model, Harness, provider, tool, or plugin cannot self-approve;
- pending approval retains the session lane;
- approval is bounded by timeout and run cancellation;
- no client, disconnect, invalid response, expiry, or cancellation prevents `tool.started`;
- approvals are single-use, non-persistent, and do not survive restart.

Add typed Gateway method:

```text
approval.resolve

params:
  approvalId
  runId
  decision: allow-once | deny

result:
  approvalId
  status: allowed | denied | already-resolved | expired | cancelled | not-found
```

Gateway validates/transports only. Approval semantics remain in the application boundary.

`approval.requested` uses the existing run-owner event path. Buffered events before `agent.run` acknowledgement must remain deliverable. Gateway disconnect does not cancel the run; it makes approval unavailable after the bounded wait.

### 4.6 Execution boundary

M3 uses explicit limited host execution `host-workspace-v1`. It is not a strong sandbox.

Execution context includes:

```text
agentId
trusted resolved workspace root
normalized relative target
toolCallId
deadline and AbortSignal
input/output limits
policy constraints
sandbox profile/version
```

Rules:

- no unrestricted context inference;
- no implicit host fallback;
- unavailable executor/containment: `TOOL_SANDBOX_UNAVAILABLE`;
- reject escape, protected paths, and symlinks before I/O;
- `workspace.write_text` uses bounded same-directory temporary write and atomic create/replace;
- `create` fails if target exists;
- `replace` fails if a regular target does not exist;
- no implicit parent-directory creation;
- no permission broadening or executable output;
- cleanup occurs in every terminal path.

If workspace containment and symlink safety cannot be proven with current Node/Linux primitives, stop that task and record `HUMAN JUDGMENT REQUIRED`; do not weaken the boundary or substitute shell execution.

### 4.7 Classification and scheduling

Build the complete batch plan before any tool implementation I/O:

```text
assign/validate toolCallId and ordinal
→ resolve all descriptors
→ validate/normalize all arguments
→ evaluate all invocation policies
→ resolve all approvals
→ revalidate policy
→ resolve all execution targets
→ enforce batch/run budgets
→ select schedule
→ commit required pre-execution evidence
→ execute
→ normalize outcomes
→ return original-order results
```

Rules:

- only registered read-only + parallel-safe calls may execute in bounded parallel;
- any mixed, side-effecting, privileged, unknown, invalid, approval-gated, or sequential call makes the whole batch sequential;
- unknown traits default to sequential;
- policy and approval complete before parallel I/O;
- tool capacity is independent from model-call capacity;
- results preserve model-call order even when completion order differs;
- side effects never overlap in M3;
- one failure cannot start an unapproved later call.

Initial validated defaults:

```text
maxConcurrentToolCalls = 4
maxToolCallsPerBatch = 8
maxToolCallsPerRun = 16
maxToolIterations = 8
toolTimeoutMs = 30000
approvalTimeoutMs = 30000
maxToolArgumentBytes = 65536
maxToolResultBytes = 65536
maxWorkspaceListEntries = 200
```

Tool/approval timeouts must not exceed run timeout. Tests use smaller injected values and event-driven barriers, not timing sleeps.

### 4.8 Model, Harness, and context

Extend provider-neutral model results to support:

```text
assistant text only
tool requests only
assistant text plus tool requests when provider semantics permit
```

Normalized tool request:

```text
host toolCallId
provider call ID when available
modelCallId
ordinal
toolName
rawArguments
```

Rules:

- host toolCallId is unique and distinct from run/attempt/model IDs;
- provider ID is correlation metadata, not identity authority;
- malformed native calls fail normalization and are not repaired into text;
- Harness remains one-step and never invokes tools or continues privately;
- Agent Runtime receives tool requests and enters ToolStage;
- provider SDK types stay inside `src/models/`;
- visible tool definitions come only from registry + visibility policy;
- Gemini adapter owns function declaration/call/result projection;
- `store=false`, continuation sidecars, local transcript authority, and model route remain unchanged;
- every model call in the loop uses usage reserve–dispatch–settle.

Extend `PreparedModelContext` with immutable visible tool definitions. For each model call, record registry/policy/schema/rendered-definition hashes. After a committed tool cycle, rebuild context from canonical transcript state. Prompt text, skills, transcript, filenames, and provider output cannot register tools or grant permissions.

### 4.9 ToolStage and checkpoint

Activate ToolStage:

```text
ModelStage tool requests
→ ToolStage ordered outcomes + progress
→ ObserveStage transcript delta
→ atomic transcript commit
→ CheckpointStage
→ continue | complete | retry-attempt | cancel | fail
```

Checkpoint remains sole continuation authority.

M3 checkpoint rules:

- final assistant output with no pending tools may complete;
- a committed safe tool cycle may continue when budgets permit;
- safe model-visible failures such as invalid arguments, denial, approval denial, or read-only failure may continue when budgets permit;
- cancellation returns cancel;
- required journal/transcript failure returns fail;
- uncertain side effect returns fail with `TOOL_OUTCOME_UNCERTAIN`;
- repeated equivalent no-progress cycles terminate with a stable code;
- Tool Runtime performs no hidden retry;
- `retry-attempt` never replays a side-effecting call;
- every `continue` decision is durable before the next model call.

### 4.10 Transcript mutation

Agent Runtime remains the only canonical transcript mutation authority while holding the session lane.

Add explicit structural entries:

```text
tool-call:
  entryId, parent/model association, modelCallId,
  toolCallId, toolName, normalized arguments, ordinal, createdAt

tool-result:
  entryId, parent tool-call association,
  toolCallId, toolName, normalized outcome, createdAt
```

Commit rules:

- append accepted user input once per run;
- append each completed batch as ordered tool-call/result pairs plus required continuation;
- one atomic contiguous batch or none;
- no tool, Tool Runtime, policy, Harness, provider, or Gateway receives TranscriptStore;
- no orphan call/result in normal operation;
- denied, cancelled, timed-out, failed, and uncertain calls use normalized result entries when checkpoint policy makes them model-visible;
- Run Journal retains pre/post side-effect evidence even if transcript commit fails;
- structural validation proves pairing, order, and continuation association;
- history APIs do not expose approval internals or diagnostic secrets.

### 4.11 Failure semantics

Terminal tool states:

```text
not-started
completed
failed-before-known-side-effect
cancelled-with-no-known-side-effect
outcome-uncertain
```

Required codes:

```text
TOOL_NOT_FOUND
TOOL_ARGUMENTS_INVALID
TOOL_POLICY_DENIED
TOOL_APPROVAL_DENIED
TOOL_APPROVAL_UNAVAILABLE
TOOL_APPROVAL_EXPIRED
TOOL_SANDBOX_UNAVAILABLE
TOOL_EXECUTION_TIMEOUT
TOOL_CANCELLED
TOOL_IMPLEMENTATION_FAILED
TOOL_OUTCOME_UNCERTAIN
TOOL_RESULT_TOO_LARGE
TOOL_BUDGET_EXHAUSTED
TOOL_NO_PROGRESS
```

Rules:

- `tool.started` means implementation I/O began;
- exactly one terminal outcome per call;
- cancellation uses the run AbortSignal;
- timeout differs from explicit user cancellation;
- post-start cancellation/timeout may be uncertain;
- uncertain is never called rolled back;
- no internal Tool Runtime retry;
- no side-effect replay;
- every terminal path cleans up;
- required journal failure before I/O prevents start;
- required journal failure after side effect prevents successful run completion.

### 4.12 Evidence and redaction

Extend RuntimeEvent with optional:

```text
toolCallId
approvalId
parentOperationId
```

Minimum lifecycle:

```text
tool.requested
tool.batch.planned
policy.evaluated
approval.requested
approval.resolved
tool.started
tool.completed | tool.failed | tool.cancelled
tool.batch.completed
checkpoint.signal.detected
checkpoint.decision
```

Required Run Journal metadata:

```text
registry/policy/sandbox fingerprints
modelCallId, toolCallId, ordinal, tool name
schema/descriptor versions and argument digest
declared effect/concurrency/idempotency traits
policy version/result/reason
approval binding/result/expiry/cancellation
execution target and sandbox profile
batch size/order/schedule/concurrency/fallback reason
start/terminal time and bounded duration
completion order when useful
terminal state/error/side-effect certainty
result schema/size/digest
progress/no-progress fingerprint
transcript batch and committed sequence range
checkpoint signals and decision
```

Rules:

- pre-execution evidence commits before a side effect;
- terminal evidence commits before successful continuation;
- journal rows contain IDs, hashes, decisions, bounded sizes, and safe errors — not file content;
- runtime events are not durable state;
- Pino is not the evidence API;
- write/approval content, absolute paths, environment values, secrets, and raw provider payloads are redacted;
- full audit and debug-artifact systems remain deferred.

## 5. Acceptance Matrix

All gates are `OPEN — IMPLEMENTATION REQUIRED` at planning completion.

| Gate   | Acceptance condition                                                         | Authority                         | Evidence                        |
| ------ | ---------------------------------------------------------------------------- | --------------------------------- | ------------------------------- |
| M3-G01 | immutable unique Tool Registry and deterministic fingerprint                 | Arch §§13, 22–23; ADR 0008, 0012  | registry/bootstrap tests        |
| M3-G02 | only the three named workspace tools are active                              | Implementation Plan M3; this plan | snapshot assertion              |
| M3-G03 | closed runtime schemas validate before policy/I/O                            | ADR 0008                          | invalid/unknown/oversized tests |
| M3-G04 | results are validated, bounded, never silently truncated                     | ADR 0007, 0008                    | ranged/oversized tests          |
| M3-G05 | visibility policy controls model schemas                                     | ADR 0007, 0008                    | context definition tests        |
| M3-G06 | invocation policy rechecks normalized arguments and fails closed             | Arch §14; ADR 0008                | allow/deny/path tests           |
| M3-G07 | every write requires exact allow-once approval                               | ADR 0008                          | allow/deny/drift/reuse tests    |
| M3-G08 | expiry, no client, disconnect, and cancel prevent start                      | ADR 0006, 0008                    | approval integration matrix     |
| M3-G09 | `approval.resolve` is typed and transport-only                               | ADR 0004, 0008                    | Gateway schema/handler tests    |
| M3-G10 | explicit workspace execution never escapes or falls back                     | Arch §14; ADR 0008                | traversal/symlink tests         |
| M3-G11 | only all-read parallel-safe batches run bounded-parallel                     | Arch §13; ADR 0008                | barrier concurrency proof       |
| M3-G12 | mixed/write/unknown batches are wholly sequential                            | ADR 0008                          | no-overlap/fallback tests       |
| M3-G13 | normalized results preserve original order                                   | ADR 0008                          | out-of-order completion test    |
| M3-G14 | Harness/provider cannot execute tools or continue privately                  | ADR 0005, 0008                    | contract/import tests           |
| M3-G15 | Gemini projection supports definitions/calls/results and keeps `store=false` | ADR 0005, 0007                    | fake Interactions tests         |
| M3-G16 | ToolStage uses Tool Runtime and returns outcomes/progress only               | ADR 0006, 0008                    | stage integration               |
| M3-G17 | every extra cycle has durable Checkpoint `continue`                          | ADR 0006, 0010                    | journal ordering test           |
| M3-G18 | user input once; tool call/result/continuation atomic and structural         | ADR 0003, 0007, 0009              | store/runtime tests             |
| M3-G19 | tools cannot mutate transcript or query SQLite                               | ADR 0007, 0009                    | dependency tests                |
| M3-G20 | required tool/policy/approval/schedule evidence is durable                   | Arch §21; ADR 0010                | journal timeline                |
| M3-G21 | runtime/Gateway events carry safe tool correlation                           | ADR 0010                          | event integration               |
| M3-G22 | timeout/cancel produce one outcome and cleanup                               | ADR 0006, 0008                    | AbortSignal/fake-clock tests    |
| M3-G23 | uncertain side effects fail and are never replayed                           | ADR 0006, 0008                    | fault injection                 |
| M3-G24 | each model call uses M2 usage accounting                                     | ADR 0015                          | multi-call usage test           |
| M3-G25 | production bootstrap wires non-placeholder fingerprints                      | ADR 0002, 0005, 0012              | composed app test               |
| M3-G26 | migration assessment is proven                                               | ADR 0009; §8                      | schema/migration audit          |
| M3-G27 | deterministic validation and M0–M2 regression pass                           | Workflow; Implementation Plan     | §9 commands                     |
| M3-G28 | controlled Gateway→approval→real temp write→continue→final response passes   | Implementation Plan M3            | controlled verification         |
| M3-G29 | Gemini live is tracked separately                                            | Workflow                          | explicit status                 |
| M3-G30 | independent read-only audit has no blocking contradiction                    | Project workflow                  | accepted audit                  |

## 6. Dependency-Ordered Work

### A. Baseline and contracts

- [ ] rerun preflight and record actual baseline;
- [ ] audit all touched code/tests/migrations;
- [ ] define tool identities, descriptors, requests, outcomes, progress, and errors;
- [ ] add `src/tools/` and `src/policy/` under accepted ownership;
- [ ] add focused dependency-boundary tests;
- [ ] advertise no tool until composition is coherent.

### B. Registry and snapshots

- [ ] implement static registration, duplicate rejection, lookup, enumeration, freeze, and fingerprint;
- [ ] register the three tools through bootstrap-owned built-in registration;
- [ ] replace `none` profile/fingerprint placeholders for the active M3 profile;
- [ ] keep a no-tools test profile without dynamic reload.

### C. Policy and visibility

- [ ] implement deterministic visibility and invocation contracts;
- [ ] implement workspace/protected-path/fail-closed rules;
- [ ] emit stable reason and redaction metadata;
- [ ] integrate visibility with context definitions;
- [ ] prove visibility is not invocation authorization.

### D. Approval and Gateway

- [ ] implement in-memory bound pending approvals;
- [ ] add `approval.resolve` schema, handler, dependency, and method registration;
- [ ] emit redacted approval events through run-owner delivery;
- [ ] cancel/dispose on deny, expiry, run cancel, terminal state, and shutdown;
- [ ] prove no start before allow-once.

### E. Workspace executor and tools

- [ ] implement explicit workspace execution context;
- [ ] implement normalization, containment, protected-path, and symlink checks;
- [ ] implement list, ranged read, and atomic create/replace;
- [ ] implement limits, cleanup, hashes, and certainty classification;
- [ ] stop with a security blocker rather than weaken containment.

### F. Batch planner and Tool Runtime

- [ ] preflight the whole batch before I/O;
- [ ] add independent Tool Runtime capacity;
- [ ] implement all-read parallel and conservative sequential scheduling;
- [ ] preserve result order and schedule evidence;
- [ ] implement timeout, cancellation, result validation, one terminal result, cleanup, and progress;
- [ ] implement no retry and uncertain-side-effect behavior.

### G. Model, Harness, context, and Gemini

- [ ] extend provider-neutral definitions, requests, and results;
- [ ] keep Harness one-step and host-controlled;
- [ ] add visible tool definitions/hashes to prepared context;
- [ ] extend fake provider for deterministic cycles;
- [ ] add Gemini function declaration/call/result projection inside `src/models/`;
- [ ] preserve continuation, usage, SDK import, and `store=false` boundaries.

### H. Runtime loop and transcript

- [ ] refactor the single-step path into bounded model/tool iterations;
- [ ] append user input exactly once;
- [ ] activate ToolStage and tool-aware ObserveStage behavior;
- [ ] add tool-call entries and structural validation;
- [ ] atomically commit call/result/continuation batches;
- [ ] feed outcomes, certainty, limits, and progress into Checkpoint;
- [ ] durably record `continue` before the next model call;
- [ ] preserve exactly-once Finalize and terminal publication ordering.

### I. Evidence, security, and composition

- [ ] extend RuntimeEvent correlation;
- [ ] add required journal metadata and failure semantics;
- [ ] add redaction/security/failure matrices;
- [ ] add validated M3 config and cross-field timeout rules;
- [ ] wire registry, policy, approval, executor, Tool Runtime, capacity, and Gateway only in bootstrap;
- [ ] cancel tool/approval work before storage close.

### J. Closure proof

- [ ] run focused and full deterministic validation;
- [ ] prove no migration or execute the §8 decision point;
- [ ] run controlled real-filesystem verification;
- [ ] update this plan with files, commands, results, evidence, and findings;
- [ ] end implementation pending independent audit;
- [ ] run separate read-only audit;
- [ ] synchronize status only after accepted audit.

## 7. Exact Open Findings And P2

The following are historical planning-completion implementation gaps. They are
not the current independent closure-audit findings.

| ID             | Classification                         | Baseline evidence                                               | Closure                                          |
| -------------- | -------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------ |
| M3-PLAN-GAP-01 | DECISION IMPLEMENTATION GAP — blocking | tool profiles/fingerprints are `none`; no tools/policy boundary | G01–G06                                          |
| M3-PLAN-GAP-02 | DECISION IMPLEMENTATION GAP — blocking | model/Harness/context carry text only                           | G14–G15                                          |
| M3-PLAN-GAP-03 | DECISION IMPLEMENTATION GAP — blocking | runtime has no active ToolStage or loop                         | G16–G17                                          |
| M3-PLAN-GAP-04 | DECISION IMPLEMENTATION GAP — blocking | Checkpoint `continue` is declarative only                       | G17                                              |
| M3-PLAN-GAP-05 | DECISION IMPLEMENTATION GAP — blocking | transcript lacks explicit tool-call pairing                     | G18                                              |
| M3-PLAN-GAP-06 | DECISION IMPLEMENTATION GAP — blocking | no registry, policy, approval, executor, or tool capacity       | G01–G13                                          |
| M3-PLAN-GAP-07 | DECISION IMPLEMENTATION GAP — blocking | no approval Gateway method                                      | G09                                              |
| M3-PLAN-GAP-08 | MISSING CLOSURE EVIDENCE — blocking    | incomplete tool correlation/evidence                            | G20–G21                                          |
| M3-PLAN-GAP-09 | MISSING CLOSURE EVIDENCE — blocking    | no controlled side-effect verifier                              | G28                                              |
| M3-P2-01       | QUALITY IMPROVEMENT / P2               | import-boundary test is regex-based                             | keep non-blocking; add focused M3 assertions     |
| M3-P2-02       | QUALITY IMPROVEMENT / P2               | usage reconciliation audit trail                                | unrelated absent regression                      |
| M3-P2-03       | QUALITY IMPROVEMENT / P2               | mid-batch reconciliation failure coverage                       | keep non-blocking; prove per-model-call M3 usage |

Current accepted independent closure-audit findings:

| Finding  | Classification             | Locked meaning                                                                                                                                                                                              |
| -------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `M3-F01` | `CLOSED — PASS (R2 scope)` | batch is not completely planned before implementation I/O; policy/approval occur during execution; concurrency is unbounded or configured capacity is unused; not every request receives a terminal outcome |
| `M3-F02` | `DECISION VIOLATION`       | workspace containment, symlink handling, atomic create/replace, normalization-to-execution binding, or TOCTOU safety is insufficient                                                                        |
| `M3-F03` | `CLOSED — PASS (R1 scope)` | registry publication, normalized invocation identity, host tool-call identity, or exact approval binding is insufficient                                                                                    |
| `M3-F04` | `DECISION VIOLATION`       | timeout/cancellation races only the returned promise or does not control underlying I/O; post-start certainty is incorrect                                                                                  |
| `M3-F05` | `DECISION VIOLATION`       | durable tool lifecycle journal or Gemini tool-cycle continuation evidence is incomplete                                                                                                                     |
| `M3-F06` | `DECISION VIOLATION`       | shutdown does not cancel and drain active runtime/tool work before storage close                                                                                                                            |
| `M3-F07` | `MISSING CLOSURE EVIDENCE` | controlled verifier does not prove the required denial, expiry, cancellation, uncertainty, replay, transcript, journal, checkpoint, finalization, usage, and cleanup matrix                                 |

Additional P2:

- artifact-backed large tool-result storage belongs with later context robustness;
- richer paged filesystem APIs are not required for this slice;
- persistent approvals, allowlists, and restart recovery require later decisions;
- strong sandbox is required before broad shell or arbitrary mutation;
- a richer event framework is not a substitute for closing observable M3 behavior.

No unresolved Architecture/ADR blocker is known at planning completion. This plan locks a narrow task-local product slice within accepted boundaries. Promote a P2 only for direct decision violation or production regression.

### Checkpoint-contract rule

The acceptance and evidence matrices in this section are frozen before each
checkpoint starts.

After execution begins, independent audit may block only for:

- a listed gate failure;
- a named Architecture/ADR/Implementation Plan violation;
- a reproducible production/security regression within scope.

Additional hardening is recorded as P2 unless explicitly promoted through a
control-plane decision.

### M3-R1C — Final closure remediation checkpoint

**Outcome:** Close the remaining accepted subfindings of M3-F03 only.
**Status:** CLOSED — PASS
**Implementation locators:**

```text
M3-R1C:
b41728112bb2b6184089e7f51cc560f2185e9f78

M3-R1D:
c6018c4b3846869769b3d74da5c27fcec621379a
```

**Accepted closure verdict:** PASS — eligible for synchronization
Accepted by user on 2026-07-29

| Gate ID                                                        | Authority                                      | Production path / concrete risk                                                                                                   | Required behavior                                                                                                                              | Exact required proof                                                                                                                                                | Classification            | Status | Evidence locator                                     |
| -------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------ | ---------------------------------------------------- |
| M3-R1C-G1 — Policy result fails closed                         | Active plan §4.4; ADR 0008                     | Policy-to-executor boundary could allow malformed, missing, unsupported, or initial `allow` policy results to start side effects. | Fail closed before `tool.started`; side effects proceed only through exact `require-approval`, with rechecked constraints passed to execution. | Focused fake-policy tests for malformed, missing, and initial side-effect `allow`; execution-context assertion; no implementation I/O on failure.                   | blocking                  | PASS   | `b41728112bb2b6184089e7f51cc560f2185e9f78`           |
| M3-R1C-G2 — Runtime execution authority is snapshotted         | Active plan §§4.5–4.6; ADR 0008                | Caller mutation after admission could alter workspace, target, sandbox, limits, or policy evidence used by approval/execution.    | Capture one host-owned immutable invocation authority snapshot before approval/execution.                                                      | Deterministic barrier test mutating caller-owned batch context after admission; executor observes only the original snapshot.                                       | blocking                  | PASS   | `b41728112bb2b6184089e7f51cc560f2185e9f78`           |
| M3-R1C-G3 — Registry execution authority remains immutable     | Active plan §§4.1–4.2; ADR 0012                | Public metadata or leaked registration objects could replace the registered implementation or renderer after freeze.              | Expose metadata only; retain registry-owned immutable execution authority after freeze.                                                        | Mutation/replacement attempt after freeze leaves authority unchanged; Tool Runtime invokes the registered implementation through a narrow registry-owned operation. | blocking                  | PASS   | `c6018c4b3846869769b3d74da5c27fcec621379a`           |
| M3-R1C-G4 — Transcript does not fabricate normalized arguments | Active plan §4.10; ADR 0007                    | Unknown or invalid unadmitted calls could create a normal transcript tool call using invented `{}` arguments.                     | Persist normalized arguments only for admitted calls; preserve atomic, structural transcript validity without raw fallback.                    | Unknown/invalid transcript tests; admitted-normalized transcript test; invariant-failure no-partial-commit test.                                                    | blocking                  | PASS   | `c6018c4b3846869769b3d74da5c27fcec621379a`           |
| M3-R1C-G5 — Focused checkpoint evidence                        | Workflow verification contract; active plan §9 | Missing focused proof could leave G1–G4 unverified.                                                                               | Produce the frozen evidence set for G1–G4 without expanding the checkpoint.                                                                    | G1–G4 focused proof; typecheck; changed-file format check; lint; focused tool/policy/agent tests; full suite; `git diff --check`.                                   | blocking closure evidence | PASS   | validation recorded by the M3-R1C and M3-R1D reports |

M3-F03 closure for the accepted R1 scope:

```text
Closure:
M3-R1C + M3-R1D

Result:
PASS at c6018c4b3846869769b3d74da5c27fcec621379a
```

One parameterized approval-drift matrix may prove equivalent binding fields; a
separate test for every equivalent field is not required.

### M3-R1 P2 — QUALITY IMPROVEMENT / P2

The following are nonblocking unless future evidence establishes production
reachability or an authority violation:

- sparse-array strict JSON hardening;
- own `__proto__` JSON-key hardening;
- accessor-property strict JSON hardening;
- one dedicated test for every equivalent approval drift field;
- additional canonical-serialization edge cases outside the model/provider schema
  path.

### M3-R2 — Batch admission and bounded parallelism

**Mapped findings:** M3-F01 only.
**Next execution checkpoint:** M3-R3 — Workspace containment and I/O safety
**Status:** CLOSED — PASS
**Implementation locators:**

```text
M3-R2:
38e6dedf0b0341f14f97e86aa3ead5d5940ecc48

M3-R2R:
9c9792c3ebe8153c20427a4992c0c32d10d75796
```

**Accepted closure verdict:** PASS — eligible for synchronization
Accepted by user on 2026-07-29

| Gate ID | Authority                                      | Production path / concrete risk                                                                                  | Required behavior                                                         | Exact required proof                                                                                           | Classification | Status | Evidence locator                           |
| ------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------- | ------ | ------------------------------------------ |
| M3-R2-1 | M3-F01; active plan §4.7; ADR 0008; M3-G11–G13 | Implementation I/O could begin while the batch is only partly admitted.                                          | Complete the batch admission plan before implementation I/O.              | Deterministic fake tools record that no implementation starts before the complete admission plan is available. | blocking       | PASS   | `9c9792c3ebe8153c20427a4992c0c32d10d75796` |
| M3-R2-2 | M3-F01; active plan §4.7; ADR 0008; M3-G11–G13 | Parallel I/O could begin before descriptor resolution, validation, normalization, policy, or approval completes. | Complete all admission checks before parallel I/O.                        | Deterministic fake tools and barriers prove every admission phase completes before any parallel start.         | blocking       | PASS   | `9c9792c3ebe8153c20427a4992c0c32d10d75796` |
| M3-R2-3 | M3-F01; active plan §4.7; ADR 0008; M3-G11     | Unbounded work could ignore `maxConcurrentToolCalls`.                                                            | Bound parallel starts by `maxConcurrentToolCalls`.                        | Barrier-controlled fake tools assert the observed peak concurrency equals the configured bound.                | blocking       | PASS   | `9c9792c3ebe8153c20427a4992c0c32d10d75796` |
| M3-R2-4 | M3-F01; active plan §4.7; ADR 0008; M3-G11     | Unsafe or non-read batches could receive parallel execution.                                                     | Run parallel only when every call is read and parallel-safe.              | Deterministic all-read fake-tool barrier test proves eligible calls overlap within the bound.                  | blocking       | PASS   | `9c9792c3ebe8153c20427a4992c0c32d10d75796` |
| M3-R2-5 | M3-F01; active plan §4.7; ADR 0008; M3-G12     | Mixed, invalid, unknown, approval-gated, or side-effecting calls could overlap.                                  | Execute those batches wholly sequentially.                                | Barrier fake tools and no-overlap assertions for each fallback class.                                          | blocking       | PASS   | `9c9792c3ebe8153c20427a4992c0c32d10d75796` |
| M3-R2-6 | M3-F01; active plan §4.7; ADR 0008; M3-G13     | Completion races could make scheduling or returned outcomes nondeterministic.                                    | Schedule deterministically and return outcomes in original request order. | Out-of-order deterministic fake completion with original-order outcome assertions.                             | blocking       | PASS   | `9c9792c3ebe8153c20427a4992c0c32d10d75796` |
| M3-R2-7 | M3-F01; active plan §4.7; ADR 0008; M3-G11–G13 | Invalid, cancelled, or skipped calls could lack a terminal result.                                               | Give every requested call exactly one terminal outcome.                   | Mixed success/failure/cancellation fake batch asserts one terminal original-order outcome per request.         | blocking       | PASS   | `9c9792c3ebe8153c20427a4992c0c32d10d75796` |
| M3-R2-8 | M3-F01; active plan §4.7; ADR 0008; M3-G12     | A later unapproved call could start after an earlier failure.                                                    | Do not start later unapproved calls after failure.                        | Sequential fake-tool failure plus start-record assertions proving later unapproved calls never begin.          | blocking       | PASS   | `9c9792c3ebe8153c20427a4992c0c32d10d75796` |
| M3-R2-9 | M3-F01; active plan §4.7; ADR 0008; M3-G11–G13 | Sleep-based tests could hide a broken concurrency contract.                                                      | Prove concurrency event by event, without timing sleeps.                  | Deterministic fake tools, explicit barriers, start/release events, and original-order assertions.              | blocking       | PASS   | `9c9792c3ebe8153c20427a4992c0c32d10d75796` |

M3-F01 closure for the accepted R2 scope:

```text
Closure:
M3-R2 + M3-R2R

Result:
PASS at 9c9792c3ebe8153c20427a4992c0c32d10d75796
```

### M3-R3 — Workspace containment and I/O safety

**Mapped findings:** M3-F02, M3-F04, and M3-F06 only.
**Status:** PLANNED — NOT RUN
**Matrix authority:** active plan §§4.6 and 4.11; ADR 0006; ADR 0008;
relevant Architecture lifecycle/security invariants.

| Gate ID | Authority                                                                             | Production path / concrete risk                                                              | Required behavior                                                   | Exact required proof                                                                                           | Classification | Status            |
| ------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------- | ----------------- |
| M3-R3-1 | M3-F02; active plan §4.6; ADR 0008; Architecture lifecycle/security invariants        | Paths or symlinks could escape the explicit workspace.                                       | Enforce workspace containment and symlink safety.                   | Temporary filesystem containment, traversal, and symlink-escape tests with no escaped access.                  | blocking       | PLANNED — NOT RUN |
| M3-R3-2 | M3-F02; active plan §4.6; ADR 0008; Architecture lifecycle/security invariants        | Create/replace could race path changes or expose partial writes.                             | Use atomic create/replace with TOCTOU-safe handling.                | Temporary filesystem atomic-create/replace and raced-path evidence; no partial or redirected write.            | blocking       | PLANNED — NOT RUN |
| M3-R3-3 | M3-F04; active plan §§4.6, 4.11; ADR 0006; ADR 0008                                   | Timeout or cancellation could race only the returned promise while underlying I/O continues. | Propagate abort to underlying I/O and produce one terminal outcome. | Abort-aware fake I/O proves underlying operation observes cancellation and cannot later complete successfully. | blocking       | PLANNED — NOT RUN |
| M3-R3-4 | M3-F04; active plan §4.11; ADR 0006; ADR 0008                                         | Post-start side effects could be reported as safely rolled back.                             | Classify post-start ambiguous effects as uncertain.                 | Fault-injected side-effect fake proves uncertain terminal evidence and no replay.                              | blocking       | PLANNED — NOT RUN |
| M3-R3-5 | M3-F06; active plan §§4.6, 4.11; ADR 0006; Architecture lifecycle/security invariants | SQLite could close while runtime/tool work remains active.                                   | Cancel and drain active work before storage close.                  | Ordered shutdown fake records cancellation, drain, cleanup, then storage close; asserts close is last.         | blocking       | PLANNED — NOT RUN |
| M3-R3-6 | M3-F02, M3-F04, M3-F06; active plan §4.11; ADR 0006; ADR 0008                         | Success, failure, timeout, or cancellation could leak temporary resources or handles.        | Clean up in every terminal path.                                    | Terminal-path matrix asserts cleanup for success, failure, cancellation, timeout, and uncertain outcomes.      | blocking       | PLANNED — NOT RUN |

### M3-R4 — Lifecycle journal, Gemini continuation, and controlled verification

**Mapped findings:** M3-F05 and M3-F07 only. Gemini live remains separately
tracked as optional/nonblocking under the current plan.
**Matrix authority:** active plan §§4.8–4.12; ADR 0005; ADR 0006; ADR 0007;
ADR 0010; ADR 0015.

| Gate ID | Authority                                                                        | Production path / concrete risk                                                               | Required behavior                                                                   | Exact required proof                                                                                                                          | Classification                    | Status            |
| ------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------- |
| M3-R4-1 | M3-F05; active plan §§4.8–4.12; ADR 0010                                         | Tool lifecycle actions could lack durable pre/post evidence.                                  | Persist durable pre/post tool lifecycle journal entries.                            | Controlled fake-tool cycle asserts ordered pre-start and terminal journal rows with required correlation.                                     | blocking decision-alignment gates | PLANNED — NOT RUN |
| M3-R4-2 | M3-F05; active plan §§4.8–4.12; ADR 0010                                         | Required journal write failure could permit I/O or successful continuation.                   | Fail closed for required journal failures before I/O and before success.            | Journal-failure injections prove no start before pre-write and no successful continuation after terminal-write failure.                       | blocking decision-alignment gates | PLANNED — NOT RUN |
| M3-R4-3 | M3-F05; active plan §§4.8–4.12; ADR 0005; ADR 0007; ADR 0010                     | Gemini tool cycles could lose opaque continuation or fabricate text.                          | Preserve Gemini tool-cycle continuation through host-owned transcript/sidecar flow. | Fake Interactions multi-cycle test asserts unchanged continuation association, `store=false`, and host checkpoint continuation.               | blocking decision-alignment gates | PLANNED — NOT RUN |
| M3-R4-4 | M3-F07; active plan §§4.8–4.12; ADR 0006; ADR 0008; ADR 0010; ADR 0015           | A controlled verifier might not prove the required end-to-end denial through cleanup matrix.  | Execute the full controlled verifier matrix.                                        | Deterministic fake provider/tools, barriers, temporary workspace/database, and explicit matrix assertions; Gemini live is not required.       | blocking closure-evidence gates   | PLANNED — NOT RUN |
| M3-R4-5 | M3-F07; active plan §§4.8–4.12; ADR 0006; ADR 0008; ADR 0010                     | Denial, expiry, cancellation, uncertainty, or replay could be unproven.                       | Prove deny/expiry/cancel/uncertain/no-replay behavior.                              | Controlled cases assert no start on deny/expiry, abort-aware cancellation, uncertain evidence, and no replay.                                 | blocking closure-evidence gates   | PLANNED — NOT RUN |
| M3-R4-6 | M3-F07; active plan §§4.8–4.12; ADR 0005; ADR 0006; ADR 0007; ADR 0010; ADR 0015 | Durable transcript, journal, checkpoint, finalization, or usage evidence could be incomplete. | Prove transcript, journal, checkpoint, finalization, and usage evidence.            | Controlled assertions inspect atomic transcript entries, ordered journal, checkpoint decision, one finalization, and per-call usage evidence. | blocking closure-evidence gates   | PLANNED — NOT RUN |
| M3-R4-7 | M3-F07; active plan §§4.8–4.12; ADR 0006; ADR 0010                               | Verification could leak workspace/database state or rely on shared state.                     | Isolate and clean temporary workspace and database.                                 | Controlled verifier uses fresh temporary workspace/database and asserts cleanup after every terminal path.                                    | blocking closure-evidence gates   | PLANNED — NOT RUN |

## 8. Migration Decision

**NO MIGRATION EXPECTED for the locked slice.**

Evidence:

- registry, policy snapshot, approval, scheduler, and capacity are process-local;
- pending approvals are intentionally non-durable;
- journal JSON can hold bounded additional metadata;
- transcript storage already has unconstrained `entry_type`, parent ID, model/tool call IDs, tool name, JSON content, and contiguous sequencing;
- M3 adds no artifact, audit, idempotency, compensation, or scheduler persistence.

Implementation must still audit the actual schema.

Trigger a migration decision only if existing storage cannot preserve:

- explicit tool-call/result discrimination;
- atomic call/result/continuation association;
- required correlation identity;
- bounded indexed retrieval already required by TranscriptStore.

If triggered:

1. stop before writing a migration;
2. document the missing invariant;
3. confirm ADR 0007/0009 already authorize the durable semantics;
4. add the next immutable versioned migration;
5. test fresh, upgrade, current, failure, and restart paths;
6. update this plan and acceptance matrix.

Persistent approvals, replay/deduplication, compensation, and audit are not valid M3 migration reasons without human judgment.

## 9. Validation

### Planning document

After saving this plan:

```bash
pnpm exec prettier --write docs/plans/active/0002-tool-runtime.md
pnpm exec prettier --check docs/plans/active/0002-tool-runtime.md
git diff --check
```

Check status, checkboxes, gates, evidence, migration, P2, non-goals, M2 closure, and separate deterministic/controlled/live states.

### Implementation

Record exact results:

```bash
pnpm typecheck
pnpm exec prettier --check <all M3 changed files>
pnpm lint
pnpm test
git diff --check
```

Required focused proof:

```text
registry identity, collision, immutability, fingerprint
argument/result validation
visibility and invocation policy
approval allow/deny/expiry/unavailable/cancel/drift/reuse
workspace containment, protected paths, symlinks, bounded I/O
atomic create/replace and cleanup
parallel-read and sequential-mixed scheduling
original-order outcomes
timeout, cancellation, failure, uncertain outcome, no replay
Gemini definitions/calls/results
Harness and ToolStage ownership
durable Checkpoint continue
atomic transcript pairing and user input once
Run Journal and RuntimeEvent ordering/redaction
usage accounting for each model call
bootstrap production wiring and shutdown
migration no-change proof
M0–M2 regression
```

Concurrency tests use barriers, deferred promises, fake clocks, or AbortSignals — not sleeps as ordering proof.

Every touched file must pass focused formatting/lint checks. Pre-existing full-repository failures may be reported separately only with identical baseline evidence; checks must not be weakened.

### Controlled side effect

Required for closure:

```text
fresh temporary database and workspace outside repository
real Gateway connect and agent.run
fake Gemini requests workspace.write_text
observe approval.requested
resolve allow-once through approval.resolve
verify exact atomic file change and no other change
verify transcript/journal/events/checkpoint continue
second fake model call and final assistant result
repeat deny, expiry, cancellation, and uncertain variants
stop app and prove cleanup
```

No repository file or external account may be modified.

Gemini live remains separately:

```text
M3 Gemini live: NOT RUN | PASS | FAIL
```

It is opt-in, uses a fresh temporary workspace, permits no broad/destructive action, and supplements rather than replaces deterministic proof.

## 10. Security, Recovery, And Rollback

Security gates:

- workspace-root containment;
- reject absolute/traversal/control/symlink/protected paths;
- no implicit host fallback;
- no shell/process/network;
- no concrete tools imported by Agent Runtime;
- no TranscriptStore/SQLite access from tools;
- closed schemas and bounded payloads;
- exact approval digest and no reuse;
- redacted events/journal/logs/errors;
- required journal evidence fail-closed.

Recovery:

- no I/O before validation, policy, approval, target, budgets, and required pre-evidence;
- failed transcript batch commits no partial range;
- pending approval is cancelled on terminal/shutdown;
- uncertain write is reported, never replayed or called rolled back;
- loop budgets/no-progress produce stable failure and still Finalize once;
- controlled tests use disposable workspace/database.

Rollback:

- no migration is expected;
- revert the coherent M3 implementation or disable the active tool profile;
- retain the M2 no-tools fixture/path;
- do not downgrade durable data;
- never delete journal/transcript evidence to hide a failed M3 run.

Stop for human judgment before:

- broad shell/arbitrary host execution;
- a claimed strong sandbox;
- persistent/resumable approval or lane release while waiting;
- automatic side-effect replay or durable idempotency;
- dynamic tools/plugins or public SDK;
- remote/distributed execution;
- changed transcript/checkpoint/finalization/evidence authority;
- weakened containment/redaction/fail-closed semantics;
- new durable semantics not already authorized.

## 11. Non-Goals

M3 does not:

- reopen M2;
- implement Browser Runtime;
- implement curated memory;
- implement full context pruning or artifact storage;
- expose shell, process, network, delete, rename, chmod, package, or service tools;
- claim a strong sandbox;
- implement dynamic plugins or a public SDK;
- persist approvals or add allowlists;
- add side-effect replay, compensation, or a deduplication ledger;
- add full audit persistence;
- change Gateway architecture/authentication;
- add agents, delegates, remote nodes, or workers;
- change Gemini route/API/store decisions;
- change transcript, checkpoint, finalization, journal, or usage ownership;
- use Pino, checkboxes, or isolated tests as sole closure evidence;
- self-promote M3 to PASS.

## 12. Progress

### Planning

- [x] authority and dependencies inspected at baseline commit;
- [x] current M3 seams/placeholders audited;
- [x] observable outcome and three-tool slice locked;
- [x] acceptance matrix and traceability defined;
- [x] migration assessment recorded;
- [x] security, recovery, non-goals, findings, and P2 recorded;
- [ ] save as `docs/plans/active/0002-tool-runtime.md`;
- [ ] run local planning-document formatting/consistency validation;
- [ ] update `docs/IMPLEMENTATION_PLAN.md` active-plan pointer after reviewer acceptance.

### Execution

- [ ] baseline/contracts;
- [ ] registry/snapshot;
- [ ] policy/visibility;
- [ ] approval/Gateway;
- [ ] executor/tools;
- [ ] batch/runtime;
- [ ] model/Harness/context/Gemini;
- [ ] ToolStage/transcript/checkpoint;
- [ ] evidence/security/composition;
- [ ] deterministic validation;
- [ ] controlled side-effect verification;
- [ ] implementation report pending audit;
- [ ] independent audit accepted;
- [ ] status synchronized.

## 13. Decisions

- 2026-07-28: M3 uses a separate plan; CLOSED plan 0001 is not extended.
- 2026-07-28: the first slice is `workspace.list`, `workspace.read_text`, and approval-gated `workspace.write_text`.
- 2026-07-28: execution is limited `host-workspace-v1`, not a strong sandbox.
- 2026-07-28: registry is static, bootstrap-owned, immutable, and fingerprinted.
- 2026-07-28: writes require invocation-bound allow-once approval.
- 2026-07-28: mixed batches serialize; only all-read parallel-safe batches may run in bounded parallel.
- 2026-07-28: Tool Runtime does not retry; uncertain side effects fail and are not replayed.
- 2026-07-28: oversized results fail; artifact-backed reduction is deferred.
- 2026-07-28: no migration is expected, subject to implementation schema audit.
- 2026-07-28: deterministic fake-provider plus real temporary-workspace proof is required; Gemini live is separate.

Changing any accepted authority requires a new ADR, not a hidden implementation choice.

## 14. Evidence Locator

```text
Baseline preflight:
  HEAD 7263b0c0629d27ba42ad396bb3703d050a3fdf19 on branch master

Implementation baseline:
  Uncommitted working-tree implementation on top of HEAD 7263b0c0629d27ba42ad396bb3703d050a3fdf19

Registry fingerprint:
  computed deterministic fingerprint over built-in workspace-tools-v1 manifest

Policy fingerprint:
  workspace-policy-v1 deterministic fingerprint

Sandbox fingerprint:
  host-workspace-v1 deterministic fingerprint

Deterministic validation:
  pnpm typecheck (exit 0)
  pnpm lint (exit 0)
  pnpm test (34 test files, 223 tests passed)
  git diff --check (exit 0)
  prettier check on M3 files (exit 0)

Controlled side effect:
  PASS — src/test/controlled-tool-runtime.test.ts

Gemini live:
  NOT RUN — tracked separately

Representative allow/deny/cancel/uncertain runIds:
  verified in src/test/controlled-tool-runtime.test.ts and src/tools/tool-runtime.test.ts

Migration:
  NONE — existing schema is sufficient and tests prove the required invariants

Independent audit:
  M3-R1 closure checkpoint: PASS — eligible for synchronization
  Accepted by user on 2026-07-29
```

## 15. Completion Standard

Promote M3 only when:

1. every blocking gate is CLOSED;
2. production bootstrap wires the path;
3. all three tools use the same Tool Runtime lifecycle;
4. policy, approval, and execution boundaries are enforced;
5. ToolStage and durable checkpoint continuation are active;
6. transcript and evidence contracts are proven;
7. deterministic validation passes;
8. controlled side-effect verification passes;
9. migration assessment is confirmed;
10. no contradiction remains;
11. P2 is separated;
12. independent read-only audit is accepted;
13. status is synchronized after audit.

## 16. Result

Implementation completed; pending independent closure audit.
