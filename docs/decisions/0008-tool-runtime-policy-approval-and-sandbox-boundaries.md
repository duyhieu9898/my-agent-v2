# ADR 0008: Tool Runtime, Policy, Approval, and Sandbox Boundaries

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

## Context

`my-agent-v2` must let a model request useful actions without allowing the Agent Harness, model provider, Gateway, or concrete tool implementations to bypass authorization and execution controls.

The architecture distinguishes four related concepts:

```text
Tool Runtime
Policy
Approval
Sandbox
```

They solve different problems:

- Tool Runtime defines and executes capabilities.
- Policy decides whether a capability may be exposed or invoked for the current agent, session, run, origin, and arguments.
- Approval obtains an explicit human decision when policy requires it.
- Sandbox constrains where and how an approved action executes.

Merging these concepts would create unsafe assumptions such as:

- a tool being safe merely because it runs in a container;
- a human approval overriding an explicit policy denial;
- hiding a `write` tool while leaving unrestricted shell execution available;
- a Harness directly executing native tools outside host policy;
- advertising tools to the model that will always be rejected at call time;
- treating approval as authentication or a complete security boundary;
- silently falling back to host execution when a requested sandbox is unavailable;
- replaying a side-effecting call after retry without idempotency or deduplication.

OpenClaw currently treats tool policy, execution approval, and sandbox placement as separate gates. Tool policy filters which tool schemas are available to the model. Its sandbox controls where selected tools execute. Host execution approvals add allowlist and optional human-review gates, and the effective result remains the stricter combination of applicable controls. OpenClaw also supports per-agent restrictions and warns that sandboxing reduces blast radius but is not a perfect security boundary.

`my-agent-v2` adopts those principles while keeping V1 smaller:

- statically registered built-in tools;
- one built-in policy engine;
- one approval flow through the local Gateway and Control UI or CLI;
- no elevated or break-glass mode;
- no persistent approval allowlist in the first slice;
- no remote execution nodes;
- no dynamic plugin tools;
- no claim that host execution is strongly sandboxed;
- no provider or Harness permission system that can bypass host policy.

## Decision

`src/tools/` will own the Tool Runtime boundary.

If the initial repository does not yet contain `src/tools/`, it must be introduced when the first executable tool slice is implemented. Tool implementations may remain in their owning modules, but registration, lookup, policy evaluation, approval coordination, execution lifecycle, and result normalization belong to the Tool Runtime.

`src/policy/` owns policy contracts and the initial policy implementation.

Sandbox implementations belong to execution infrastructure or the owning runtime boundary, such as `src/platform/`, `src/browser/`, or a future sandbox module. They do not own authorization decisions.

The mandatory model-initiated tool flow is:

```text
register tool descriptor and implementation
→ resolve effective tool visibility for the model call
→ filter unavailable or denied tool schemas
→ model or Harness requests a tool call
→ validate and normalize arguments
→ re-evaluate invocation policy with concrete arguments
→ deny, allow, or request approval
→ if required, obtain a bound approval decision
→ resolve execution target and sandbox
→ execute with timeout and cancellation
→ normalize result or error
→ emit runtime events
→ return result to the Harness
→ Agent Runtime decides durable transcript mutation
```

No model-initiated tool call may skip this path.

## Tool Runtime ownership

The Tool Runtime owns:

```text
tool contracts and descriptors
parameter and result schemas
Tool Registry
tool discovery and lookup
effective visibility filtering
policy evaluation
approval coordination
execution dispatch
timeout and cancellation
result and error normalization
runtime event production
before and after execution hooks with explicit authority
```

It does not own:

```text
Gateway transport
Agent Runtime run lifecycle
model-provider transport
context assembly
session routing
canonical transcript persistence
platform-specific implementation details
browser-provider implementation details
human identity authentication
```

Agent Runtime orchestrates the run and supplies explicit runtime context. The Harness may request tool execution only through a host-provided Tool Runtime interface.

A Harness must not import concrete tools, invoke shell or browser implementations directly, or treat provider-native tool execution as automatically trusted.

If a provider or Harness offers native capabilities, they must either:

1. be represented as registered tools and routed through the Tool Runtime; or
2. be disabled for that run.

Adding a trusted native capability path outside the Tool Runtime requires a separate ADR.

## Tool contracts and descriptors

Every registered tool has a stable host-level identity and descriptor.

A descriptor includes at least:

```text
tool name
owning module or capability
human-readable description
argument schema
normalized result contract
side-effect classification
sensitivity or capability classification
execution target requirements
sandbox compatibility or requirements
timeout and cancellation support
concurrency trait: parallel-safe or sequential
```

A tool may also declare:

```text
idempotency behavior
no-progress fingerprint hints
approval summary renderer
redaction rules
resource limits
provider compatibility
required platform or browser capability
```

Tool names are unique within the effective registry snapshot.

Conflicting registrations fail during composition or registry publication. Later registrations must not silently replace existing tools.

External tool arguments are untrusted data. They must pass runtime schema validation before policy evaluation or implementation execution.

TypeScript types alone are not a validation boundary.

### Side-effect classification

Tools are classified by their observable effect, not only by their name.

The initial classification should distinguish at least:

```text
read-only
side-effecting
privileged or high-risk
```

Read-only does not mean unrestricted. Reading credentials, private files, browser state, or external account data may still be denied by policy.

All side-effecting and privileged calls require an explicit policy decision. Memory create, supersede, delete, and purge operations are side effects even when they modify only local SQLite state.

A generic execution tool such as shell `exec` is classified by its full capability, not by whether a particular command appears harmless. Denying dedicated file-write tools does not make unrestricted shell execution read-only.

## Tool Registry

The Tool Registry contains immutable tool registrations for one published runtime snapshot.

V1 uses static registration from bootstrap:

```text
built-in or owning module
→ registers tool descriptor and implementation
→ Tool Registry snapshot
→ ContextAssembler and Tool Runtime consume the snapshot
```

Context assembly receives only the effective schemas visible for the current model call.

Memory tools are registered Tool Runtime capabilities. They validate proposals, invoke policy and approval, then call the Memory Runtime through its application contract. Context assembly, Harnesses, providers, and CheckpointStage cannot bypass this path to mutate memory.

Concrete tool implementations may come from:

- built-in filesystem or workspace tools;
- Linux platform adapters;
- Browser Runtime;
- future MCP clients;
- future plugin registrations.

Core modules must consume registered contracts rather than special-case each implementation.

Dynamic registry replacement, plugin unloading, and in-flight snapshot migration are deferred. When added, a run or attempt must retain a coherent registry snapshot rather than observing partial changes.

## Prompt guidance does not grant capability

Agent resources, Prompt Plan sections, memory, skills, transcript content, and provider-generated text may describe tool usage. They do not create runtime capability.

Guidance-only sources include `CAPABILITIES.md`-like resources, `TOOLS.md`-like notes, skill instructions, memory entries, user/web content, and provider-generated tool suggestions.

Model-visible capability is derived only from:

```text
published Tool Registry snapshot
→ visibility policy evaluation
→ validated Prompt Plan tool-definition section
```

Invocation authority comes only from validated tool identity/arguments, invocation-time policy, approval state, and sandbox/execution contracts.

Prompt content cannot register or replace tools, manufacture schemas, enable omitted tools, grant filesystem/shell/browser/network/memory-write permission, weaken approval or sandbox requirements, redefine side-effect/concurrency traits, or convert untrusted data into host instructions.

Prompt Plan records tool-definition hashes and registry fingerprints, but prompt text is never authorization.

## Policy boundary

Policy is runtime enforcement, not prompt guidance.

The Policy Engine receives an explicit input such as:

```text
agentId
sessionKey
sessionId
runId
attemptId
tool name
validated and normalized arguments
side-effect and sensitivity metadata
workspace and execution target
originating client or channel metadata
platform and sandbox capabilities
effective agent policy
```

It returns one decision:

```text
allow
deny
require-approval
```

The decision may include:

```text
stable reason code
human-readable explanation
approval summary
execution constraints
redaction metadata
policy version or source metadata
```

Policy decisions must be deterministic for the supplied policy snapshot and input, except where an explicitly modeled external authority is consulted.

A prompt instruction saying that a tool should not be used is not sufficient enforcement.

### Two-stage policy evaluation

Policy is evaluated at two points.

#### Visibility evaluation

Before each model request, the runtime resolves which tools are eligible to be exposed.

Tools denied at this stage are omitted from the model-visible schema set.

This reduces invalid calls and prevents the model from being encouraged to invoke unavailable capabilities.

A tool that might require approval may remain visible if policy allows the model to request it.

#### Invocation evaluation

After a tool call is requested and its arguments are validated, policy is evaluated again with the concrete arguments and current runtime context.

Invocation evaluation is authoritative.

A tool being visible to the model is not proof that every argument set is allowed.

This second check protects argument-sensitive rules and runtime changes between context assembly and execution.

If policy state materially changes while approval is pending, the call must be revalidated before execution.

### Precedence and fail-closed behavior

The effective policy is the intersection of applicable restrictions.

The following rules apply:

1. An explicit denial wins.
2. A narrower agent policy may restrict a broader global policy.
3. Provider or Harness capability limits may remove tools but cannot grant host authority.
4. Sandbox tool compatibility may further restrict execution but cannot grant a denied tool.
5. Missing policy, invalid policy, unresolved ownership, or unavailable enforcement infrastructure fails closed for side-effecting and privileged tools.
6. No session directive or model output can override an explicit denial.

V1 does not implement elevated, unrestricted, or break-glass execution.

## Approval boundary

Approval resolves only a `require-approval` decision.

It does not:

- override `deny`;
- authenticate an untrusted caller;
- make an unsafe sandbox safe;
- change the tool's declared capability;
- guarantee that a command is harmless;
- authorize a different argument set;
- replace audit or runtime events.

A model, Harness, tool implementation, or plugin may not approve its own request.

### Approval request binding

Every approval request has an `approvalId` and is bound to an immutable normalized invocation snapshot containing at least:

```text
agentId
sessionKey
sessionId
runId
attemptId
tool name
normalized arguments or a stable digest
execution target
sandbox mode or requirement
human-readable action summary
creation and expiry time
policy decision metadata
```

An approval applies only to that bound invocation.

Changing the tool name, normalized arguments, target, workspace, sandbox, or owning run invalidates the approval and requires a new decision.

Sensitive values may be redacted from the UI, but the runtime must retain enough binding information to prevent approval drift.

### Approval decisions

V1 supports:

```text
allow once
deny
```

Persistent allowlists, approve-always rules, auto-reviewers, channel reaction shortcuts, and organization policy are deferred.

An approval response must come through an explicit trusted local client action handled by the Gateway or CLI boundary.

The Gateway transports the decision but does not redefine policy semantics.

Approval requests expire, are cancelled when their run terminates, and cannot be reused.

If no approval-capable client is available, approval times out, or the response is invalid, the result is denial or a normalized approval failure. The tool must not execute.

### Approval and session lane

In V1, a run waiting for tool approval remains the active run and retains its per-session lane.

This preserves transcript and tool-loop ordering.

Approval waits must have a bounded timeout and respond to run cancellation.

Persistent suspended runs, lane release while awaiting approval, process-restart recovery, and resumable approval workflows are deferred. Adding them requires a lifecycle decision because they change session ordering and recovery semantics.

## Sandbox boundary

Sandboxing constrains execution after policy and approval permit the action.

Policy answers:

```text
May this action run?
```

Sandboxing answers:

```text
Where and with which filesystem, process, network, credential, and resource limits may it run?
```

Sandboxing does not decide tool visibility and does not override policy.

The Gateway process and Agent Runtime are not automatically sandboxed merely because a tool executes in a sandbox.

### Sandbox selection

Execution target and sandbox selection are resolved from:

```text
tool requirements
agent sandbox policy
workspace access policy
platform capability
run origin and sensitivity
available sandbox backend
```

A tool invocation receives an explicit execution context. Concrete implementations must not infer unrestricted host execution from missing sandbox data.

If policy or the tool descriptor requires a sandbox and no compatible backend is available, execution fails closed.

The runtime must not silently fall back from sandbox execution to host execution.

If sandboxing is optional and policy explicitly permits host execution, the action may run on the host through the normal Tool Runtime lifecycle.

### V1 posture

V1 may begin with limited host execution for a small built-in tool set under strict policy and approval.

This is not described as a strong sandbox.

Before exposing broad shell, arbitrary filesystem writes, untrusted code execution, or agent-authored programs, the project must implement or adopt a sandbox backend with explicit controls for:

```text
filesystem access
working directory
process isolation
network access
environment and secrets
resource limits
execution timeout
artifact transfer
cleanup
```

A sandbox reduces blast radius but is not assumed to be a perfect security boundary.

## Tool batch planning and concurrency

When one model step requests multiple tools, Tool Runtime creates one explicit batch execution plan before any tool I/O begins.

The planning order is:

```text
validate and normalize every call
→ resolve every descriptor and execution trait
→ evaluate invocation policy for every call
→ resolve every required approval
→ resolve sandbox and execution targets
→ enforce batch and run tool-call budgets
→ choose bounded-parallel or sequential scheduling
→ execute
→ return results in original model-call order
```

V1 scheduling rules are:

- only registered `read-only` tools that explicitly declare `parallel-safe` are eligible for bounded parallel execution;
- side-effecting, privileged, shell, browser-mutating, unknown, unregistered, or explicitly sequential tools run sequentially;
- a mixed batch containing any ineligible call runs entirely sequentially in V1;
- unknown traits fail to sequential rather than parallel;
- policy and approval complete before parallel I/O begins;
- parallelism is bounded by runtime-wide Tool Runtime permits;
- result processing and transcript observation preserve the original model-call order even when raw I/O completes out of order.

Tool Runtime returns normalized execution outcomes and progress signals to Agent Runtime. It does not decide whether the model/tool loop continues. `CheckpointStage` is the sole continuation authority under ADR 0006.

The execution plan and actual schedule are observable through Run Journal metadata, including the batch size, eligibility decision, concurrency limit, call order, completion order when useful, and stable reason for sequential fallback.

## Execution lifecycle

After all gates pass, Tool Runtime executes the call through a normalized lifecycle:

```text
tool.requested
→ policy evaluated
→ approval.requested and approval.resolved when required
→ tool.started
→ tool.completed | tool.failed | tool.cancelled
```

`tool.started` means execution has actually begun. It must not be emitted while approval is still pending.

Each call receives a unique tool-call correlation identifier distinct from `runId` and `attemptId`.

The runtime enforces:

- bounded timeout;
- cancellation propagation;
- one terminal result per tool call;
- output-size limits;
- secret-aware logging and redaction;
- normalized error categories;
- cleanup in a `finally`-equivalent path.

Tool implementations return normalized data to Tool Runtime. They do not append directly to the canonical transcript.

Agent Runtime decides which normalized tool request and result entries become durable through `TranscriptStore`, consistent with ADR 0007. Tool outcomes may carry typed progress evidence, such as changed resource version, created artifact reference, external operation status, or no observable state delta, for use by `CheckpointStage`.

## Timeout, cancellation, and uncertain outcomes

Cancellation is cooperative where the underlying implementation permits it.

A cancelled or timed-out tool call may have produced partial external effects before termination.

The runtime must distinguish:

```text
not started
completed
failed before known side effect
cancelled with no known side effect
outcome uncertain
```

When the true external outcome cannot be established, the call must not be reported as safely rolled back.

Retries of side-effecting calls are disabled by default.

Replay is permitted only when the tool has an explicit idempotency or deduplication contract and the retry policy proves it safe.

## Errors and results

Tool Runtime exposes normalized results and errors rather than leaking concrete platform, browser, MCP, or provider objects into Agent Runtime or the Gateway protocol.

Normalized error categories should include at least:

```text
tool not found
invalid arguments
policy denied
approval denied
approval unavailable or expired
sandbox unavailable
execution timeout
cancelled
implementation failure
outcome uncertain
result too large
```

Errors include safe structured metadata and stable codes.

Raw commands, environment values, credentials, file contents, browser cookies, and provider payloads must not be logged or returned unless the contract explicitly permits them.

## Events, logs, and future audit

Tool lifecycle events are application events, not a replacement for durable transcript or audit records.

Technical logs should correlate, where available:

```text
agentId
sessionKey
sessionId
runId
attemptId
toolCallId
approvalId
policy decision code
sandbox or execution target
```

Side-effecting actions should later produce durable audit records containing the actor or agent, normalized action summary, policy result, approval result, execution target, and completion status.

Audit persistence is deferred, but event and contract shapes must not prevent it.

## Per-agent isolation

Effective tool policy, approval behavior, and sandbox posture are resolved for the owning `agentId`.

Future agents and delegates may receive narrower capabilities than `primary`.

They must not inherit another agent's writable workspace, credentials, approval state, or unrestricted execution path merely because they share one process or Tool Registry.

A shared registry describes available implementations. It does not grant every registered capability to every agent.

## Consequences

### Positive

- Model-driven side effects pass through one enforceable lifecycle.
- Policy, approval, and sandbox responsibilities remain independently testable.
- Tools denied for a model call are not advertised in its context.
- Argument-sensitive policy can reject a call even when the tool itself is visible.
- Human approval cannot silently bypass explicit denial or execution constraints.
- Harnesses, providers, MCP integrations, browser tools, and future plugins share the same host authority model.
- Stronger sandbox backends can be introduced without moving policy into the sandbox implementation.
- Per-agent least-privilege configurations remain possible.
- Tool batching remains deterministic and inspectable while allowing safe bounded parallel reads.
- CheckpointStage receives explicit tool progress evidence instead of inferring loop state from log text.

### Negative

- Tool calls require more metadata, validation, events, and state transitions.
- Approval can keep a session lane occupied while waiting for the user.
- V1 host execution remains less isolated until a strong sandbox backend exists.
- Two-stage policy evaluation adds implementation and testing cost.
- Provider-native or Harness-native execution features may need to be disabled or adapted.
- Conservative mixed-batch serialization may leave some safe parallelism unused in V1.
- Tool descriptors require accurate concurrency and progress metadata.

## Risks and trade-offs

### Policy and implementation drift

A tool implementation may gain new side effects without updating its descriptor or policy classification.

Mitigation:

- descriptors live with tool contracts;
- security-relevant changes require review and tests;
- high-risk generic tools use conservative classification;
- registration tests assert declared capabilities.

### Confusing visibility with authorization

Developers may assume a model-visible tool is already authorized for every call.

Mitigation:

- invocation policy is always authoritative;
- tests cover argument-dependent denial;
- Tool Runtime exposes no direct implementation handle to the Harness.

### Sandbox overconfidence

A sandbox may be treated as complete protection despite mounts, network access, kernel exposure, credentials, or backend defects.

Mitigation:

- sandbox and policy remain separate;
- least privilege applies inside the sandbox;
- dangerous host fallback is forbidden;
- documentation avoids claiming perfect isolation.

### Approval fatigue

Too many prompts may train the user to approve without review.

Mitigation:

- deny unnecessary tools before model exposure;
- use precise action summaries;
- keep the V1 tool set small;
- later add narrowly scoped allowlists only through an explicit decision.

### Long approval waits

Holding the session lane can block later prompts.

Mitigation:

- bounded approval timeout;
- explicit cancellation;
- clear pending state;
- revisit resumable approval when real workflows require it.

### Incorrect parallel-safety metadata

A tool may be marked read-only or parallel-safe even though it mutates shared state or depends on execution order.

Mitigation:

- default unknown tools to sequential;
- require registration tests for concurrency traits;
- classify generic shell, browser mutation, MCP bridge, and privileged tools conservatively;
- journal the execution plan and concurrency reason.

### Indirect side effects through generic tools

Allowing `exec`, scripting runtimes, browser automation, or plugin tools may bypass narrower tool-name policy expectations.

Mitigation:

- classify generic execution conservatively;
- use sandbox and workspace restrictions;
- inspect concrete arguments where feasible;
- do not claim that denying dedicated tools constrains an unrestricted generic executor.

## Rejected alternatives

### Put tool execution inside the Agent Harness

Rejected because each Harness would create its own authority, policy, approval, cancellation, and audit behavior. Harness selection must not change host security guarantees.

### Let model providers execute native tools directly

Rejected because provider-native execution could bypass local policy, approval, sandboxing, transcript normalization, and event production.

### Let `CAPABILITIES.md`, `TOOLS.md`, skills, or memory grant tools

Rejected because guidance is model context, not trusted runtime registration or authorization. Allowing it to create capability would bypass registry, policy, approval, and audit boundaries.

### Treat prompt instructions as policy

Rejected because model compliance is probabilistic and cannot enforce side-effect authorization.

### Treat sandboxing as authorization

Rejected because a sandbox limits execution but does not decide whether the action should occur.

### Let approval override denial

Rejected because approval is a response to `require-approval`, not a break-glass authority. V1 has no elevated mode.

### Evaluate policy only before the model call

Rejected because tool visibility evaluation lacks the concrete arguments and current execution context needed for invocation authorization.

### Evaluate policy only after the model requests a tool

Rejected because the model would receive and be encouraged to use tools that are categorically unavailable.

### Silently run on the host when sandboxing fails

Rejected because fallback would expand authority precisely when an enforcement control is unavailable.

### Automatically retry failed side-effecting tools

Rejected because the external action may already have completed even when the local result is missing or timed out.

### Parallelize every read-only-looking batch

Rejected because names are not reliable capability metadata, mixed batches may contain ordering dependencies, and policy or approval must finish before any parallel I/O starts.

### Let Tool Runtime decide whether the agent loop continues

Rejected because Tool Runtime owns execution outcomes, not run orchestration. Continuation and retry belong to Agent Runtime `CheckpointStage`.

### Build a dynamic plugin tool system in V1

Rejected because static registration is sufficient for the initial vertical slices and keeps the trust boundary reviewable.

## Validation

This decision is correctly applied when:

- model-initiated capabilities execute only through Tool Runtime;
- tool inputs use runtime schemas and are validated before execution;
- denied tools are absent from the effective model-visible schema set;
- model-visible tool definitions derive from one published registry snapshot plus visibility policy and are hashed in Prompt Plan;
- context resources, skills, memory, provider output, and untrusted data cannot register tools, manufacture schemas, or grant permissions;
- every invocation is re-evaluated with normalized arguments;
- every side-effecting call receives `allow`, `deny`, or `require-approval`;
- `deny` cannot be overridden by approval, Harness behavior, provider behavior, session directives, or sandbox configuration;
- approval is bound to one immutable invocation and expires or cancels safely;
- `tool.started` is not emitted before required approval resolves;
- unavailable required sandbox infrastructure fails closed;
- host fallback is explicit policy, never implicit recovery;
- Harnesses receive a Tool Runtime callback or contract rather than concrete tool implementations;
- tool implementations do not write directly to `TranscriptStore`;
- timeout and cancellation produce exactly one normalized terminal result;
- uncertain external outcomes are represented explicitly;
- side-effecting calls are not automatically replayed;
- per-agent tests prove that registry availability does not equal agent authorization;
- logs and events correlate tool calls without exposing secrets;
- integration tests cover allow, deny, approval allow, approval deny, approval timeout, cancellation, sandbox unavailable, and implementation failure paths;
- tool descriptors declare side-effect and concurrency traits, with unknown traits defaulting to sequential;
- a batch is fully validated, policy-checked, approved, and budget-checked before any parallel I/O begins;
- only read-only, parallel-safe calls execute in bounded parallel;
- mixed or ineligible batches execute sequentially in V1;
- normalized results are returned in original model-call order;
- Tool Runtime emits progress signals but cannot start another model cycle;
- Run Journal records the batch execution plan and sequential-fallback reason.

## Revisit conditions

Revisit this decision when:

- a strong sandbox backend is selected;
- persistent approval allowlists or approve-always behavior are required;
- approval waits must survive process restart;
- session lanes must be released while runs await approval;
- remote nodes or distributed tool execution are introduced;
- a Harness requires native execution that cannot be represented through Tool Runtime;
- plugin or MCP tools can be installed dynamically;
- organization-level policy or multiple human principals are introduced;
- elevated or break-glass execution becomes a product requirement;
- side-effecting tools require transactions, compensation, or durable idempotency records;
- policy must be evaluated by an external service;
- untrusted agent-authored code or widgets receive executable capabilities;
- real workloads require dependency-aware partial parallelism within mixed batches;
- tool progress requires a stable cross-tool semantic contract beyond bounded signals.

## References

- `docs/decisions/0014-memory-ownership-retrieval-and-evolution.md`
- `docs/ARCHITECTURE.md`, section 13, **Tool Runtime**
- `docs/ARCHITECTURE.md`, section 14, **Policy, approval, and sandbox**
- `docs/ARCHITECTURE.md`, section 15, **Platform boundary**
- `docs/ARCHITECTURE.md`, section 16, **Browser Runtime**
- `docs/ARCHITECTURE.md`, section 19, **Multi-agent routing and delegates**
- `docs/ARCHITECTURE.md`, section 21, **Events, logs, and audit**
- `docs/ARCHITECTURE.md`, section 23, **Dependency direction**
- `docs/decisions/0005-agent-runtime-harness-and-model-provider-boundaries.md`
- `docs/decisions/0006-run-attempt-lifecycle-and-per-session-serialization.md`
- `docs/decisions/0007-context-assembly-and-transcript-mutation-authority.md`
- OpenClaw Tools overview: `https://docs.openclaw.ai/tools`
- OpenClaw Sandbox vs tool policy vs elevated: `https://docs.openclaw.ai/gateway/sandbox-vs-tool-policy-vs-elevated`
- OpenClaw Sandboxing: `https://docs.openclaw.ai/gateway/sandboxing`
- OpenClaw Exec approvals: `https://docs.openclaw.ai/tools/exec-approvals`
- OpenClaw Permission modes: `https://docs.openclaw.ai/tools/permission-modes`
- OpenClaw Multi-agent sandbox and tools: `https://docs.openclaw.ai/tools/multi-agent-sandbox-tools`
- GoClaw, **How GoClaw Works**: `https://docs.goclaw.sh/how-goclaw-works`
- GoClaw, **System Prompt Anatomy**: `https://docs.goclaw.sh/system-prompt-anatomy`
- GoClaw, **Context Files**: `https://docs.goclaw.sh/context-files`
