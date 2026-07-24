# ADR 0011: Platform and Browser Runtime Boundaries

- **Status:** Accepted
- **Date:** 2026-07-24
- **Decision owners:** my-agent-v2 maintainers
- **Related architecture:** `docs/ARCHITECTURE.md`
- **Related decisions:**
  - `docs/decisions/0001-modular-monolith-and-openclaw-alignment.md`
  - `docs/decisions/0002-core-runtime-identities-and-agent-ownership.md`
  - `docs/decisions/0004-gateway-control-plane-and-protocol-contract.md`
  - `docs/decisions/0005-agent-runtime-harness-and-model-provider-boundaries.md`
  - `docs/decisions/0006-run-attempt-lifecycle-and-per-session-serialization.md`
  - `docs/decisions/0008-tool-runtime-policy-approval-and-sandbox-boundaries.md`
  - `docs/decisions/0009-storage-ownership-sqlite-and-migration-policy.md`
  - `docs/decisions/0010-runtime-events-logs-transcripts-and-audit-separation.md`

## Context

`my-agent-v2` needs to perform two classes of environment-dependent work:

```text
host operating-system operations
stateful browser automation
```

Both are eventually exposed to the agent through tools, but they have different state, lifecycle, security, and portability requirements.

Without explicit boundaries, implementation may drift into patterns such as:

- Agent Runtime calling `systemctl`, `apt`, `/proc`, PowerShell, or platform paths directly;
- browser automation being implemented as special cases inside the Harness;
- Gateway handlers owning browser sessions or invoking Playwright directly;
- Linux-specific code spreading through core modules;
- treating a native companion application as the Agent Runtime or Gateway;
- treating a future remote node as a second Gateway;
- exposing Playwright locators, CDP target IDs, or MCP handles as permanent core contracts;
- reusing an element reference after navigation without detecting that it is stale;
- closing a user-owned browser, profile, or tab that the runtime did not create;
- silently changing execution from host to remote node when the requested target is unavailable;
- assuming sandboxing, browser isolation, and tool policy are the same control;
- storing screenshots, downloads, or PDFs directly inside transcript rows without artifact ownership.

OpenClaw currently demonstrates several useful principles:

- its core runtime supports multiple operating systems while platform-specific service management and companion applications remain OS-specific;
- companion nodes expose declared command surfaces through the Gateway and remain peripherals rather than additional Gateways;
- its browser capability presents one stable tool surface over local managed browsers, attached user sessions, remote CDP endpoints, and node-hosted browsers;
- browser profiles have explicit lifecycle modes, and stopping an attached or remote profile must not imply killing a process the system did not launch;
- browser actions use snapshots and references whose validity is scoped to a target and observation, with explicit stale-reference recovery;
- tabs and browser resources are cleaned up only when ownership is attributable;
- navigation and remote browser endpoints are subject to security policy rather than being implicitly trusted.

`my-agent-v2` adopts these boundary and lifecycle principles while keeping V1 smaller:

- Linux is the only implemented host platform;
- browser execution is local to the Gateway host in V1;
- V1 uses the Playwright library directly in the TypeScript/Node.js process to control Chromium;
- remote nodes, remote browser routing, native Windows/macOS implementations, profile marketplaces, and distributed browser execution are deferred;
- browser and platform capabilities remain subject to ADR 0008 Tool Runtime, policy, approval, and sandbox controls.

## Decision

`src/platform/` and `src/browser/` are separate runtime boundaries.

```text
Agent Runtime
    │
    ▼
Tool Runtime
    │
    ├── registered platform tools ──► Platform contracts ──► LinuxPlatform
    │
    └── registered browser tools ───► Browser Runtime ─────► Browser Provider
```

The Agent Runtime, Harness, Gateway, context assembly, and model-provider modules must not import concrete operating-system or browser-automation implementations.

Concrete implementations are created and connected only by `src/bootstrap/`.

## Platform boundary

`src/platform/` owns contracts and adapters for host-specific operating-system behavior.

The platform boundary may provide structured capabilities such as:

```text
process inspection
service status and lifecycle operations
package-manager information
filesystem metadata
host path resolution
shell process creation and signalling
platform capability discovery
```

It does not own:

```text
Agent Runtime run lifecycle
Gateway transport
Tool Registry or policy decisions
browser lifecycle
session or transcript persistence
native companion application UI
remote-node protocol
```

### V1 platform selection

V1 implements one concrete adapter:

```text
LinuxPlatform
```

Bootstrap selects and constructs the concrete platform implementation.

Core modules must not branch on `process.platform` to perform domain behavior. Platform detection may occur in bootstrap, configuration validation, platform-module factories, and platform-specific tests.

Adding `WindowsPlatform` or `MacOSPlatform` must not require changes to Gateway request dispatch, the agent loop, Harness contracts, model-provider contracts, session semantics, or Tool Runtime policy semantics.

### Structured operations instead of leaked commands

Platform contracts expose intent-oriented operations rather than leaking command strings as the primary API.

Preferred examples:

```text
getProcessInfo(processId)
getServiceStatus(serviceId)
restartService(serviceId)
getPackageInfo(packageId)
spawnProcess(request)
terminateProcess(processId, signal)
```

Forbidden core dependencies include:

```text
systemctl
apt or dpkg
/proc parsing
Linux service-unit paths
PowerShell
Windows Service Manager
launchctl
hard-coded platform home or config paths
```

A concrete adapter may use these mechanisms internally.

A generic shell-execution capability remains a high-risk Tool Runtime capability and is not a substitute for platform contracts where the product needs normalized, portable behavior.

### Platform capability discovery

A platform adapter reports a typed capability snapshot.

The snapshot may include:

```text
platform family and version
available structured operations
required external binaries
service-manager availability
supported process controls
sandbox or isolation support
```

Unavailable capabilities fail explicitly. Core modules must not guess availability from the operating-system name alone.

Capability discovery is descriptive, not authorization. ADR 0008 policy still decides whether a capability may be exposed or invoked.

### Platform tools

Model-initiated platform operations are exposed as registered tools.

The required path is:

```text
model or Harness requests platform tool
→ Tool Runtime validates arguments
→ policy and approval are resolved
→ execution target and platform capability are resolved
→ platform adapter executes
→ result or error is normalized
→ runtime event is emitted
→ result returns through Tool Runtime
```

Agent Runtime and Harness code must not call `LinuxPlatform` directly to bypass Tool Runtime for model-requested actions.

Bootstrap and application lifecycle code may use platform contracts directly for host startup, shutdown, or service integration when the operation is not model-initiated. Such calls remain explicit and testable.

### Companion applications and remote nodes

`apps/linux/`, future `apps/windows/`, and future `apps/macos/` contain independently runnable native companion applications.

A companion application may:

- install or control the local Gateway service;
- display native UI;
- connect to the Gateway as a client;
- expose native capabilities through a future node contract;
- manage platform permissions owned by the operating system.

A companion application is not the Platform adapter, Agent Runtime, or Gateway implementation.

Future remote nodes are execution targets that expose declared capabilities through the Gateway. They are not additional Gateways and do not silently replace the local Platform adapter.

Introducing node routing, pairing, node capability policy, or remote execution requires a dedicated ADR. V1 fails when a requested local capability is unavailable rather than silently rerouting it elsewhere.

## Browser Runtime boundary

`src/browser/` owns a stateful Browser Runtime independent from Agent Runtime and Platform.

It owns:

```text
Browser Provider contracts and selection
provider lifecycle
browser profiles
browser control sessions
tabs or pages
observations and element references
navigation and document state
screenshots, PDFs, downloads, and related artifacts
browser-specific error normalization
browser capability discovery
```

It does not own:

```text
model or Harness loop
Tool Registry policy or approval authority
Gateway transport
session transcript authority
host operating-system services
provider-specific credentials outside configured references
```

The Browser Runtime may depend on narrow platform facilities required to launch or inspect a browser process. The Platform module must not depend on Browser Runtime.

### Browser Provider contract

A Browser Provider supplies one implementation of browser control behind normalized host contracts.

Conceptually:

```ts
interface BrowserProvider {
  readonly id: string;

  getCapabilities(): Promise<BrowserCapabilities>;
  openSession(request: OpenBrowserSessionRequest): Promise<BrowserSession>;
  close(): Promise<void>;
}
```

A browser session conceptually supports normalized operations such as:

```text
list, open, focus, and close tabs
navigate
observe the active document
act on a current reference
capture screenshot or PDF
read normalized browser state
close the control session
```

The exact TypeScript interfaces are implementation details until the first browser slice is planned.

V1 has one statically registered provider implemented with the Playwright library directly inside the TypeScript/Node.js process. It controls Chromium and remains behind the normalized Browser Provider contract.

The V1 implementation is named conceptually:

```text
PlaywrightBrowserProvider
```

V1 does not use Playwright MCP, Rod, a Go browser sidecar, or a raw-CDP-first provider. Playwright's `CDPSession` may be used only as a narrowly scoped implementation escape hatch when a required Chromium capability is unavailable through the normal Playwright API. CDP-specific values and sessions remain private implementation details.

Provider selection is separate from model-provider and Agent Harness selection.

### Stable host contract over provider-specific mechanisms

The Browser Runtime normalizes provider-specific concepts.

Core and tool contracts must not require consumers to understand:

```text
Playwright Locator objects
Playwright Page or BrowserContext instances
raw CDP sessions
MCP subprocess handles
provider-private numeric page IDs
provider-specific selector syntax
```

Provider-native IDs may be retained internally for diagnostics and routing, but public tool and runtime contracts use host-owned opaque IDs and normalized commands.

An implementation may expose a narrowly scoped diagnostic field containing a backend name or raw identifier. Consumers must not use it as durable identity or behavior authority.

### Browser identity and lifecycle concepts

The following concepts remain distinct:

#### Browser profile

A profile describes configured browser identity and lifecycle mode, including where relevant:

```text
profileId
providerId
managed or attach-only ownership mode
browser executable or endpoint reference
user-data or credential isolation policy
default headless or launch behavior
navigation policy
```

A profile is configuration, not an active browser session.

#### Browser control session

A browser control session is a runtime attachment to one browser profile and execution target.

It owns the active provider handles used for actions. Closing the control session does not necessarily terminate the underlying browser.

#### Tab or page

A tab/page is a provider-normalized document target inside a browser session.

Its `tabId` is opaque and valid only within the Browser Runtime contract that issued it. A matching URL does not prove that a replacement tab has the same identity.

#### Observation

An observation is a point-in-time normalized representation of a tab/page, such as an accessibility or agent-oriented UI tree.

#### Element reference

An element reference identifies an actionable item within one observation.

A reference is scoped to at least:

```text
browser control session
tabId
observation version or observationId
provider generation
```

It is not a durable selector and must not be stored as long-lived conversation state.

### Reference validity and stale state

Navigation, reload, document replacement, tab replacement, provider restart, browser-context replacement, or a relevant state-changing action may invalidate prior observations and references.

When a reference is stale or its target cannot be proven, the Browser Runtime must:

1. reject the action with a normalized stale-reference or target-invalidated error;
2. avoid silently retargeting the action to a different element or tab;
3. require a fresh observation before another reference-based action.

The runtime may retry observation acquisition, but it must not guess which new element corresponds to an old reference.

Provider contracts should make reference generation explicit so a provider restart cannot accidentally reuse process-local handles as valid current references.

### Browser ownership and cleanup

Browser resource ownership must be explicit.

At minimum, lifecycle mode distinguishes:

```text
managed
attach-only or externally managed
```

For managed resources, Browser Runtime may start and stop processes, profiles, sessions, and tabs that it created according to configured cleanup policy.

For attach-only or externally managed resources, closing control must release the runtime's attachment and transient emulation state without claiming ownership of or terminating the external browser process.

The runtime must not automatically close a tab unless it can attribute ownership to the current runtime, session, or explicit user request.

Unknown, user-created, or unattributable tabs are not adopted for automatic cleanup merely because their URL matches a known tab.

Cleanup is best effort and emits normalized events and logs. Cleanup failure must not corrupt session transcript state.

### Browser execution target

Browser Provider and execution target are separate concepts.

A future target may be:

```text
Gateway host
sandbox
remote node
remote CDP service
```

V1 supports only the explicitly configured local host target.

No component may silently fall back from one target to another. An unavailable requested target produces a normalized capability or routing error.

Remote browser routing, node proxying, and remote endpoint trust policy require a later ADR before implementation.

### Browser tools

Agent Runtime accesses browser behavior through registered browser tools or a narrow application-facing Browser Runtime contract.

Model-initiated actions always pass through Tool Runtime:

```text
browser tool request
→ argument validation
→ policy and approval
→ profile, provider, and execution-target resolution
→ browser capability validation
→ browser action
→ normalized result, artifact, or error
→ runtime event
→ result returned to Harness
```

The Harness must not invoke Playwright APIs, Playwright `CDPSession`, Chromium control methods, MCP browser methods, or Browser Provider implementations directly.

The Gateway may expose browser status or operator-control methods in the future, but those methods call Browser Runtime contracts and do not become the owner of browser state.

### Policy, sandbox, and browser isolation

Browser isolation, Tool Runtime policy, and sandbox placement remain separate controls.

- policy decides whether the browser tool, profile, target, navigation, or action may be used;
- approval provides a bound human decision when required;
- browser profile isolation separates browser state;
- sandbox constrains the process or execution environment;
- navigation policy restricts reachable origins and network ranges.

A managed browser profile is not automatically safe merely because it is separate from the user's daily browser.

An attached signed-in browser is higher risk and must be represented in policy input so it can receive stricter visibility and approval rules.

Navigation and remote endpoint resolution must fail closed against disallowed schemes, origins, private-network targets, or credential-bearing endpoints according to configured policy.

Secrets embedded in browser endpoints or profile configuration must not be logged or emitted to model context.

### Browser artifacts

Screenshots, PDFs, downloads, and other binary outputs are artifacts, not transcript bodies.

Browser Runtime creates normalized artifact metadata and delegates durable file placement to an artifact or storage boundary selected during implementation.

Transcript entries may reference an artifact using safe metadata, but must not duplicate unbounded binary content.

Artifact metadata should include where applicable:

```text
artifactId
kind
media type
size
createdAt
originating browser session and tab
safe display name
storage reference
```

Filesystem paths, download URLs, authentication data, and provider-private metadata are exposed only to authorized consumers.

A dedicated artifact-lifecycle ADR is required if artifacts become durable user data with independent retention or sharing semantics.

### Normalized errors and events

Browser and platform implementations return normalized errors rather than leaking raw library exceptions as contracts.

Examples include:

```text
capability-unavailable
platform-operation-failed
browser-disabled
profile-not-found
provider-unavailable
browser-launch-failed
browser-attach-failed
tab-not-found
target-invalidated
stale-reference
navigation-denied
action-timeout
manual-intervention-required
artifact-failed
```

Raw causes may be attached for internal logs after redaction.

Browser and platform lifecycle events follow ADR 0010. Potential event names include:

```text
platform.operation.started
platform.operation.completed
platform.operation.failed
browser.session.opened
browser.session.closed
browser.tab.opened
browser.tab.closed
browser.navigation.completed
browser.observation.created
browser.action.completed
browser.action.failed
browser.artifact.created
```

Events are observations, not the canonical browser state store.

## Dependency direction

Allowed direction:

```text
bootstrap
→ LinuxPlatform
→ Browser Provider implementation
→ Tool Runtime registrations

Agent Runtime
→ Tool Runtime contracts

Tool Runtime
→ Platform contracts
→ Browser Runtime contracts

Browser Runtime
→ narrow Platform contracts when host launch support is required
```

Forbidden dependencies include:

```text
Gateway handlers → Playwright, Playwright CDPSession, Chromium, or MCP implementation
Agent Runtime → LinuxPlatform
Agent Runtime → Browser Provider implementation
Harness → shell, platform, or browser implementation
Platform → Agent Runtime
Platform → Browser Runtime
Browser Runtime → Gateway transport
Browser Runtime → TranscriptStore mutation
UI → platform or browser backend implementation
```

## OpenClaw alignment and intentional differences

This decision aligns with OpenClaw by preserving:

- cross-platform core contracts with OS-specific companion and service behavior;
- companion nodes as capability-bearing peripherals rather than Gateways;
- one stable browser interface over multiple local, attached, remote, or node-hosted backends;
- explicit managed versus attached lifecycle ownership;
- snapshot/reference-based actions and stale-reference recovery;
- explicit browser target and profile selection;
- attributable tab ownership before automated cleanup;
- policy enforcement for browser exposure, navigation, and remote endpoints.

Intentional V1 differences are:

- only `LinuxPlatform` is implemented;
- no remote nodes or node command surface;
- no browser proxy or automatic remote-target routing;
- no dynamic browser plugin replacement;
- no multiple Browser Providers unless an active requirement appears;
- no promise of OpenClaw-compatible browser tool schemas;
- the initial provider uses the Playwright library directly with Chromium rather than Playwright MCP, Rod, or a separate browser-control service;
- durable browser state and artifact retention are limited to the needs of implemented vertical slices.

OpenClaw is used as a reference for lifecycle and boundary design, not as a required implementation dependency.

## Consequences

### Positive

- Linux-specific behavior remains isolated and replaceable.
- Windows and macOS adapters can be added without rewriting the agent loop or Gateway.
- Browser backend changes do not leak provider-specific semantics through core contracts.
- Stale or misrouted browser actions fail safely instead of acting on an unintended element.
- Managed and user-owned browser resources have clear lifecycle ownership.
- Remote nodes and browser targets can be added later through explicit routing contracts.
- Tool policy, approval, sandbox, profile isolation, and navigation policy remain independently enforceable.
- Browser artifacts have a clear path toward bounded storage and authorized presentation.

### Negative

- V1 requires contracts around platform and browser behavior even with one implementation each.
- Normalizing browser capabilities may expose only the portable subset of a provider.
- Reference-generation and ownership tracking add runtime state and testing complexity.
- Some provider-specific advanced functionality may require later contract extensions.
- Explicit target and capability failures are less convenient than implicit fallback.

## Risks and trade-offs

### Lowest-common-denominator browser API

A provider-neutral contract may hide useful backend capabilities.

Mitigation:

- design from active vertical slices rather than speculative completeness;
- allow versioned optional capabilities;
- add capability-specific contracts only when there is an approved consumer;
- require an ADR before exposing provider-native types as public contracts.

### Platform abstraction becoming a generic utility bucket

`src/platform/` may accumulate unrelated code merely because it touches the host.

Mitigation:

- expose structured OS-dependent capabilities only;
- keep browser, storage, policy, and application services in their owning modules;
- require ownership review for new platform contracts.

### Unsafe browser attachment

Attaching to a signed-in user browser can expose sensitive accounts and state.

Mitigation:

- represent profile ownership and sensitivity explicitly;
- default to isolated managed profiles where practical;
- apply stricter policy and approval to attached sessions;
- never copy credentials or browser secrets into model-visible context or logs.

### Stale-reference mistakes

Provider handles may remain syntactically valid after the underlying document changes.

Mitigation:

- bind references to session, tab, observation, and provider generation;
- fail rather than silently retarget;
- require re-observation after invalidation.

### Resource leaks

Browser processes, sessions, tabs, downloads, or temporary artifacts may remain after failures.

Mitigation:

- explicit ownership metadata;
- idempotent close operations;
- bounded cleanup policies;
- shutdown hooks in bootstrap;
- tests covering partial startup and cleanup failure.

### Premature remote-node assumptions

Designing local adapters around an imagined distributed protocol could overcomplicate V1.

Mitigation:

- keep V1 local;
- use transport-neutral capability contracts only where already needed;
- require a dedicated ADR before node identity, pairing, routing, or remote execution is introduced.

## Rejected alternatives

### Put operating-system branches directly in each module

Rejected because platform assumptions would spread through Gateway, runtime, storage, and tools, making Windows or macOS support invasive.

### Treat `apps/linux/` as the Linux Platform implementation

Rejected because a native companion application is independently runnable UI and lifecycle software, while the Platform adapter is an in-process runtime contract.

### Let Agent Runtime or Harness call shell and browser libraries directly

Rejected because it bypasses Tool Runtime policy, approval, normalized lifecycle, and provider isolation.

### Put Browser Runtime inside `src/platform/`

Rejected because browser lifecycle, pages, observations, references, and artifacts are stateful cross-platform concepts rather than Linux-specific host services.

### Expose Playwright or MCP types as core browser contracts

Rejected because it would make the initial provider the permanent architecture and prevent backend replacement without changing callers.

### Use Playwright MCP as the V1 Browser Provider

Rejected because it adds a separate process and protocol boundary while weakening direct lifecycle ownership, cancellation propagation, typed browser identity, and per-operation Run Journal evidence. Playwright is used as an in-process library instead.

### Use Rod or a Go browser sidecar in V1

Rejected because the primary codebase is TypeScript/Node.js and a Go sidecar would add a second toolchain, RPC contract, process lifecycle, and cross-process debugging burden without an active isolation requirement.

### Use CSS selectors as the canonical element identity

Rejected because selectors are provider- and document-dependent, can match unintended elements, and do not express observation generation or stale state.

### Reuse references across navigation when the URL is unchanged

Rejected because URL equality does not prove document, tab, browser context, or element identity.

### Automatically fall back between host, sandbox, node, or remote CDP targets

Rejected because execution placement affects security, credentials, capability, and lifecycle ownership. Fallback must be explicit policy, not hidden behavior.

### Kill any browser process or close any matching tab during cleanup

Rejected because the runtime may be attached to user-owned resources and URL matching does not establish ownership.

### Treat a future node as a second Gateway

Rejected because clients, session routing, model execution, and control-plane authority remain at the Gateway. A node exposes a bounded execution surface.

## Validation

This decision is correctly applied when:

- Linux-specific system calls and paths exist only inside platform-owned implementation code;
- bootstrap selects `LinuxPlatform` without making it a domain singleton;
- core modules use Platform contracts rather than `systemctl`, `/proc`, `apt`, or platform branches;
- model-initiated platform operations pass through Tool Runtime policy and approval;
- browser tools call Browser Runtime contracts rather than Playwright, Playwright `CDPSession`, Chromium, or MCP directly;
- the initial Browser Provider can be replaced in tests without changing Agent Runtime or Gateway handlers;
- browser profile, control session, tab, observation, and element-reference concepts remain distinct;
- stale references and provider restarts produce normalized failures and require re-observation;
- attached or external browsers are not terminated by managed-browser cleanup;
- automatic tab cleanup only affects resources with attributable ownership;
- unavailable execution targets fail explicitly rather than silently rerouting;
- browser endpoint credentials and sensitive profile data are redacted from logs, events, and model context;
- screenshots, PDFs, and downloads are represented as bounded artifacts rather than unbounded transcript content;
- startup and shutdown tests prove cleanup of platform and browser resources;
- platform and browser errors are normalized at their module boundaries;
- no code claims remote-node, Windows, macOS, or multi-provider support before implementation and tests exist.

## Revisit conditions

Revisit this decision when:

- Windows or macOS host adapters are implemented;
- a native companion begins exposing executable node capabilities;
- remote nodes, node pairing, or remote execution targets are introduced;
- more than one Browser Provider is active;
- browser execution moves to a separate process for isolation or reliability;
- durable browser sessions must survive Gateway restart;
- browser profiles require per-agent credentials or stronger isolation;
- artifacts gain independent retention, sharing, or synchronization requirements;
- provider-specific capabilities cannot be represented safely through optional normalized contracts;
- browser operations require transactional coordination with transcript or audit persistence;
- a strong sandbox backend changes ownership of browser or platform processes.

## References

- `docs/ARCHITECTURE.md`, section 12, **Tool Runtime**
- `docs/ARCHITECTURE.md`, section 13, **Policy, approval, and sandbox**
- `docs/ARCHITECTURE.md`, section 14, **Platform boundary**
- `docs/ARCHITECTURE.md`, section 15, **Browser Runtime**
- `docs/ARCHITECTURE.md`, section 18, **Multi-agent routing and delegates**
- `docs/ARCHITECTURE.md`, section 21, **Lifecycle and composition**
- `docs/ARCHITECTURE.md`, section 22, **Dependency direction**
- `docs/decisions/0008-tool-runtime-policy-approval-and-sandbox-boundaries.md`
- `docs/decisions/0010-runtime-events-logs-transcripts-and-audit-separation.md`
- OpenClaw Browser: `https://docs.openclaw.ai/tools/browser`
- OpenClaw Browser Control API: `https://docs.openclaw.ai/tools/browser-control`
- OpenClaw Platforms: `https://docs.openclaw.ai/platforms`
- OpenClaw Nodes: `https://docs.openclaw.ai/nodes`
