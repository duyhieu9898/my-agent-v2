# ADR 0013: Control UI and Session Presentation Surfaces

- **Status:** Accepted
- **Date:** 2026-07-24
- **Decision owners:** my-agent-v2 maintainers
- **Related architecture:** `docs/ARCHITECTURE.md`
- **Related decisions:**
  - `docs/decisions/0001-modular-monolith-and-openclaw-alignment.md`
  - `docs/decisions/0002-core-runtime-identities-and-agent-ownership.md`
  - `docs/decisions/0003-session-routing-transcript-separation-and-reset-semantics.md`
  - `docs/decisions/0004-gateway-control-plane-and-protocol-contract.md`
  - `docs/decisions/0006-run-attempt-lifecycle-and-per-session-serialization.md`
  - `docs/decisions/0007-context-assembly-and-transcript-mutation-authority.md`
  - `docs/decisions/0008-tool-runtime-policy-approval-and-sandbox-boundaries.md`
  - `docs/decisions/0009-storage-ownership-sqlite-and-migration-policy.md`
  - `docs/decisions/0010-runtime-events-logs-transcripts-and-audit-separation.md`
  - `docs/decisions/0012-plugin-registration-and-public-extension-boundary.md`
  - `docs/decisions/0015-usage-accounting-and-cumulative-budget-enforcement.md`

## Context

`my-agent-v2` needs a browser Control UI for conversation, runtime status, approvals, configuration, and future session-attached work surfaces.

V1 only requires a transcript/chat surface. Future versions may add a dashboard or board containing persistent, interactive widgets authored by the agent, the user, or an extension.

These surfaces introduce several architectural questions:

- whether the UI is part of the backend runtime or an independent Gateway client;
- whether a dashboard is a new conversation, agent, application, or access-control object;
- whether presentation state belongs to `sessionKey` or `sessionId`;
- what survives session reset;
- whether UI history can read raw transcript rows directly;
- how live events relate to durable state after reconnect;
- whether agent-authored HTML or JavaScript runs with the privileges of the Control UI shell;
- how widgets read data, submit prompts, call actions, or access the network;
- how future plugins contribute UI behavior without importing backend internals;
- which mutations must use the run lane and which require a separate presentation-state concurrency contract.

Without a decision, implementation could drift into unsafe or tightly coupled patterns such as:

- the browser UI importing backend implementation modules;
- direct SQLite or filesystem access from UI code;
- file watching used as a replacement for Gateway APIs;
- optimistic client state becoming the durable source of truth;
- live Gateway events being treated as replayable state;
- a dashboard receiving a separate agent, session, transcript, or ACL model;
- resetting a transcript accidentally deleting persistent session presentation state;
- storing layout and widget bytes as transcript entries;
- rendering agent-authored code in the trusted Control UI origin;
- granting widgets the operator's Gateway token or unrestricted network access;
- allowing a widget to start hidden agent runs or call arbitrary tools;
- plugin UI code importing arbitrary `src/**` internals;
- requiring the Agent Runtime to understand browser layout concepts.

OpenClaw currently provides useful reference principles:

- the Control UI and native chat clients communicate through Gateway APIs rather than reading session files directly;
- history is fetched from the Gateway as a bounded, display-normalized projection of durable transcript state;
- live reply events are a delivery projection, not the canonical session log;
- a board is a face of a session rather than a separate domain object;
- board state is attached to the stable session route and survives transcript reset;
- deleting the owning session deletes its board;
- the trusted Control UI shell renders native application components;
- only agent-authored or third-party widget content is sandboxed;
- widgets receive reach through explicit, operator-granted capabilities for data, actions, prompt submission, and network origins;
- widget identity and updates use stable names within the owning session;
- widgets do not create hidden sessions merely to handle interactions.

`my-agent-v2` adopts these boundaries while intentionally keeping V1 smaller:

- one browser Control UI;
- one transcript/chat surface;
- no dashboard or board implementation yet;
- no agent-authored widget runtime yet;
- no UI plugin marketplace;
- no remote Control UI exposure requirement;
- no cross-session widget movement;
- no dedicated presentation automation system;
- no claim that every OpenClaw dashboard behavior is implemented.

## Decision

The Control UI is a Gateway client.

A logical session may expose multiple presentation surfaces over time, but every surface remains a face of the same `sessionKey` and owning `agentId` unless a later ADR explicitly introduces a different product concept.

V1 implements only the transcript/chat surface.

Future dashboard, board, tab, panel, or widget state is session presentation state. It is not a new agent, session, transcript, run, plugin, or authorization principal.

The high-level relationship is:

```text
agentId
  └── sessionKey
        ├── current sessionId
        │     └── durable transcript
        └── presentation state
              ├── selected surface
              ├── future board and tabs
              ├── layout
              ├── widgets
              └── capability grants
```

## Control UI boundary

The browser application under `ui/` communicates with the backend only through published Gateway HTTP and WebSocket contracts.

The Control UI may use Gateway HTTP for:

```text
application assets
health or bootstrap metadata
future capability-specific content routes
sandboxed widget content hosting
```

The Control UI uses the Gateway protocol for:

```text
connect and capability discovery
session listing and selection
history reads
message submission
run status and cancellation
approval flows
configuration and diagnostics permitted to the client
live runtime and state-change events
future presentation-surface commands
```

The Control UI must not:

- import backend runtime or storage modules;
- query SQLite directly;
- read or watch transcript files;
- construct `SessionEntry` persistence records;
- invoke model providers, Harnesses, tools, Browser Runtime, or Platform adapters directly;
- depend on concrete plugin implementation modules;
- treat browser storage as the canonical store for session or presentation state.

Shared wire schemas may later be extracted into a stable package under the criteria defined by ADR 0001. Until then, UI/backend sharing must still preserve the protocol boundary rather than creating implementation imports.

## Gateway as the UI authority boundary

The Gateway validates UI input, applies connection and future authorization rules, and adapts requests to application-facing contracts.

The Gateway is not the owner of transcript, run, policy, or presentation business rules.

Presentation behavior should be exposed through an application-facing service or store contract consumed by Gateway handlers.

Conceptually:

```ts
interface SessionPresentationService {
  get(sessionKey: string): Promise<SessionPresentationSnapshot>;
  apply(command: SessionPresentationCommand): Promise<SessionPresentationSnapshot>;
  deleteForSession(sessionKey: string): Promise<void>;
}
```

The Control UI may expose authorized usage/cap summaries, active or uncertain reservations, and configuration warnings through typed Gateway application methods. It must not read usage tables directly, derive authoritative cumulative totals in the browser, or treat provider-console billing as the local Usage Ledger.

The exact interface and module placement may be defined when the first dashboard slice is planned. The architectural requirements are:

- the contract is transport-neutral;
- Gateway handlers do not query presentation tables directly;
- the UI cannot bypass validation through an alternate local path;
- presentation state is resolved under explicit `agentId` and `sessionKey` ownership;
- changes produce typed state-change events after authoritative mutation succeeds.

## Transcript/chat surface

The transcript/chat surface is a display projection of the active transcript identified by the current `sessionId` for the selected `sessionKey`.

The UI does not receive arbitrary raw store rows by default.

History APIs may:

- paginate results;
- bound text and metadata size;
- normalize channel or provider-specific structures;
- omit runtime-only context;
- hide internal control markers;
- remove credential-like or unsafe internal fields;
- expose a targeted detail API for a visible entry when bounded history omits large content;
- return an honest unavailable result when full content no longer exists.

Display normalization does not rewrite the durable transcript. It is a Gateway/application projection over transcript state.

The browser may keep temporary optimistic delivery state, but after reconnect, refresh, detected event gap, conflict, or page reload, authoritative state comes from Gateway RPC.

A visible live reply event is not proof that the corresponding durable transcript write succeeded. UI reconciliation must follow the event, transcript, and terminal ordering guarantees defined by ADRs 0004, 0006, 0007, and 0010.

## Session presentation identity

Presentation state is keyed by the owning `agentId` and stable `sessionKey`.

It is not keyed only by `sessionId` because transcript reset may replace the active transcript while preserving the logical working surface.

A future presentation record may contain:

```text
agentId
sessionKey
surface type
selected surface
board metadata
ordered tabs
per-tab layout
chat dock state
widget descriptors
widget revisions
capability manifests and grants
presentation revision
createdAt
updatedAt
```

A separate durable `presentationId` is not required unless a future feature introduces independently addressable multiple boards under one session. Internal row identifiers do not automatically become public domain identities.

A board or dashboard exists only as session presentation state. Creating the first persistent widget may materialize that state, but it does not create a new session or agent.

## Reset and deletion semantics

Transcript reset and presentation deletion are separate operations.

Resetting a logical session:

```text
keeps agentId
keeps sessionKey
creates or selects a new sessionId according to ADR 0003
preserves session presentation state
```

The UI should make this consequence explicit when presentation state exists:

```text
conversation context resets; session presentation stays
```

Deleting the logical session removes or schedules removal of presentation state owned exclusively by that session.

Deleting only the current transcript instance must not independently delete session presentation state unless the logical session itself is deleted.

Cross-session transfer, cloning, export, or sharing of presentation state is deferred and requires explicit ownership and capability rules.

## Future dashboard and board model

A future dashboard is one presentation face of a session.

The default surface remains chat when no persistent dashboard content exists.

When dashboard content exists, the UI may expose a surface selector such as:

```text
Chat | Dashboard
```

A future board may contain multiple tabs. Tabs are presentation pages within the same session, not sessions themselves.

A future tab may own:

```text
ordered widget placements
layout sizes and anchors
chat dock position
chat dock visibility
selected or focused widget state
```

Layout contracts should use semantic sizes, spans, anchors, and deterministic ordering rather than exposing raw pixel coordinates as the agent-facing API.

The trusted Control UI shell owns application chrome, navigation, layout engine, focus handling, accessibility integration, and session switching.

Agent Runtime, Harnesses, model providers, and tools must not import or manipulate browser component instances directly.

## Widget identity and ownership

A future persistent widget is owned by exactly one `agentId` and `sessionKey`.

Within a session, a widget should be addressed by a stable, validated name.

Conceptually:

```text
agentId + sessionKey + widgetName
```

Re-emitting or updating the same name replaces or revises the widget in place rather than creating an unbounded duplicate by default.

Widget records may include:

```text
name
content kind
content or resource descriptor
revision
layout hints
capability manifest
capability grant state
content hash
createdAt
updatedAt
```

The host must validate names, sizes, content limits, and duplicate behavior.

Widget identity is not a run identity or tool-call identity. A widget may survive the run that created it.

V1 does not implement widgets; these rules constrain the future boundary.

## Trusted shell and untrusted content

The Control UI shell is trusted application code.

Agent-authored HTML, JavaScript, SVG, third-party app content, or plugin-provided untrusted documents must not execute in the trusted shell origin with direct access to:

- Gateway credentials;
- browser storage used by the shell;
- DOM outside the widget host;
- arbitrary Gateway RPC;
- filesystem or OS APIs;
- unrestricted network origins;
- another session's presentation state;
- another widget's grants or bridge identity.

Such content must run inside a hardened sandboxed content boundary.

The initial future implementation should use browser isolation equivalent to a sandboxed iframe without same-origin privilege, a restrictive content-security policy, explicit message validation, and a host-controlled bridge.

Exact sandbox headers, origins, CSP directives, and browser hardening require implementation-level security review when widgets are introduced.

Sandboxing widget content does not make native plugins or the Control UI shell untrusted or separately process-isolated. ADR 0012 continues to govern native executable plugin trust.

## Widget capability model

Widget reach is denied by default.

A widget that only renders local content has no implicit access to Gateway data, actions, prompt submission, or the network.

Future widget capabilities are divided into explicit categories:

```text
data
  read-only named data bindings resolved by the host

actions
  allowlisted named commands with validated arguments

prompt
  submit a visible prompt to the owning session

net
  connect only to declared and granted network origins
```

A capability manifest declares requested reach. It does not grant itself permission.

The operator or an authorized policy boundary grants capabilities explicitly.

Capability grants must be scoped at least to:

```text
agentId
sessionKey
widgetName
widget revision or content hash
capability kind
specific allowed binding, action, or origin
```

When widget content changes materially or requests broader capabilities, the host must invalidate or re-evaluate grants. A revision that narrows capabilities may retain compatible grants only when the host can prove the new request is a subset of the existing grant.

Capability checks are enforced by the host bridge and relevant runtime boundaries, not by trusting widget code.

## Widget data access

The `data` capability exposes named, read-only projections.

A widget never receives unrestricted access to:

- the Gateway method registry;
- the database;
- raw transcript storage;
- credentials;
- arbitrary files;
- arbitrary plugin state.

Each data binding defines:

```text
identifier
input schema
output schema
ownership and authorization rule
size and refresh limits
sensitivity classification
provider or plugin owner
```

Plugin-provided data bindings register through the public extension boundary in ADR 0012.

Disabling or removing the owning capability source removes the binding rather than leaving an undocumented privileged path.

## Widget actions

The `actions` capability invokes a named, allowlisted application action.

Widget actions must not become an arbitrary tool-call escape hatch.

A side-effecting action must pass the applicable:

- schema validation;
- capability-grant check;
- policy decision;
- approval rule;
- execution boundary;
- audit and runtime-event projection.

Where an action maps to a Tool Runtime capability, ADR 0008 applies in full.

Where an action is a dedicated application command, it must provide equivalent validation, authorization, observability, timeout, and cancellation behavior appropriate to its effects.

A widget may not invoke a hidden unrestricted shell, browser, filesystem, Gateway, or plugin command.

## Prompt submission

The `prompt` capability may submit a visible user-intent message to the same logical session.

Prompt submission must:

- target the widget's owning `sessionKey`;
- use the ordinary validated session-send application boundary;
- follow idempotency and per-session serialization rules;
- produce a visible transcript entry or equivalent explicit user-visible operation;
- never impersonate the agent or create an invisible conversation;
- never silently target another agent or session.

Without an active grant, the host may require direct user activation and confirmation for each prompt send.

A granted prompt capability does not grant arbitrary action or data capabilities.

## State notifications and hidden work

A future widget may emit bounded presentation-state notifications that the agent can observe on a later run without immediately starting a new run.

Such notifications must be:

- schema-validated;
- size-limited;
- rate-limited or coalesced;
- attached to the owning session;
- distinct from a user-authored transcript message;
- assembled into context through an explicit context resource or notice boundary.

The mechanism must not create hidden sessions or hidden model calls.

Automation initiated from a widget must be an explicit named action with its own visible or auditable execution identity. It must not masquerade as a passive state notification.

## Network access

The `net` capability grants only declared network origins and supported protocols.

Network access should be enforced through sandbox CSP and host controls where possible.

Widgets must not receive the Control UI's Gateway token, user credentials, or arbitrary proxy capability.

The host must fail closed when a requested origin, redirect, protocol, or content policy is not allowed.

Whether network access is direct from the sandbox or proxied by the Gateway is an implementation choice requiring a later security review. Either design must preserve explicit origin grants and prevent credential leakage.

## User and agent parity

For a future board, user and agent operations should converge on the same application command model where practical.

Examples include:

```text
add or update widget
remove widget
move or resize widget
create, rename, reorder, or remove tab
select visible tab
change chat dock position
hide or show chat dock
```

The browser may provide direct manipulation UI while the agent uses registered tools. Both paths must validate against the same ownership and presentation invariants.

User interaction does not need to pretend to be an agent tool call. Agent interaction must still pass Tool Runtime, policy, approval, and capability rules.

## Concurrency and revisions

Presentation mutations are not transcript mutations and do not automatically acquire the active run lane.

They require their own atomic concurrency contract, such as a presentation revision, widget revision, or compare-and-swap precondition.

A mutation based on stale presentation state must fail with a conflict or return an authoritative replacement snapshot rather than silently overwriting newer changes.

Operations that also mutate transcript or start a run must cross the appropriate session application boundary and follow ADR 0006.

Session reset and logical-session deletion must coordinate with presentation state through one application-level operation so that partial ownership changes do not occur.

The specific locking or revision mechanism is deferred until the first persistent presentation implementation.

## Events and refresh

After an authoritative presentation mutation commits, the owning service may emit typed events such as:

```text
session.presentation.changed
session.surface.selected
board.changed
widget.changed
widget.removed
widget.grant.changed
```

Event names are illustrative until protocol schemas are approved.

Gateway events notify connected clients but do not replace durable presentation state.

Clients must be able to:

- detect an event sequence gap;
- fetch an authoritative presentation snapshot;
- reconcile optimistic state;
- handle a deleted or inaccessible session;
- handle capability removal or plugin disablement.

A persistent general-purpose event store is not required.

## Storage ownership

When persistent presentation state is introduced, it will be stored through a domain-specific contract backed initially by SQLite under ADR 0009.

Presentation tables are not owned by Gateway handlers or the UI.

Presentation data must not be stored as transcript messages merely to obtain persistence.

Transcript entries may reference a rendered inline artifact or widget creation event, but persistent board layout, content bytes or descriptors, grants, and tab state remain presentation state.

Migrations for presentation persistence follow the versioned migration policy in ADR 0009.

Binary or large content limits, retention, artifact storage, and cleanup rules must be explicit in the implementation plan.

## Plugin and extension contributions

Future plugins may contribute narrowly defined presentation capabilities through ADR 0012, such as:

```text
widget content kinds
read-only data bindings
allowlisted actions
rendering descriptors
host-side resource resolvers
trusted shell components only when explicitly supported by the SDK
```

Plugins must not receive unrestricted access to the Control UI shell or private backend modules.

Untrusted plugin or third-party content uses the same sandbox and capability model as agent-authored content.

A native trusted plugin that contributes shell code remains trusted in-process code and requires an explicitly published SDK surface. It is not made safe merely by being called a widget.

V1 exposes no public Control UI plugin API.

## Security and exposure

The Control UI is an operator-control surface.

V1 assumes local access through the local Gateway. Public exposure is not a V1 requirement.

Future remote exposure must add authentication, secure transport, origin policy, CSRF or equivalent browser protections, and authorization scopes before being supported.

Browser convenience must not weaken Gateway security or widget capability isolation.

Session keys, widget names, and presentation routes are selectors, not bearer credentials.

## Consequences

### Positive

- UI and backend can evolve independently behind the Gateway protocol.
- Reconnect and refresh behavior is based on authoritative RPC state rather than browser-local assumptions.
- Transcript reset does not destroy persistent session work surfaces.
- A dashboard can be added without inventing a second conversation or agent model.
- Agent Runtime remains independent of browser layout and component implementation.
- Agent-authored content cannot inherit the privileges of the Control UI shell by default.
- Widget data, actions, prompts, and networking receive explicit security contracts.
- Future plugins have a narrow contribution direction instead of arbitrary UI/backend imports.
- Presentation concurrency can evolve independently from the run lane.

### Negative

- The system needs separate transcript and presentation stores and APIs.
- UI display projections add mapping and testing work beyond returning raw transcript rows.
- Reset and delete flows must coordinate multiple durable state categories.
- Sandboxed widgets require CSP, bridge, grant, revision, and content-hosting infrastructure.
- User and agent parity requires shared application commands rather than duplicated UI-only behavior.
- Presentation revision conflicts require explicit UX and retry behavior.

## Risks and trade-offs

### Presentation state becomes a second hidden session model

A board could accumulate routing, lifecycle, or ownership rules that diverge from the session.

Mitigation:

- key it by explicit `agentId` and `sessionKey`;
- do not assign a separate agent or transcript;
- make reset and deletion behavior inherit session lifecycle;
- require an ADR before introducing independently owned boards.

### UI/backend contract drift

Rapid UI development may encourage direct imports or undocumented response assumptions.

Mitigation:

- validate every external frame;
- maintain protocol integration tests;
- expose capability discovery;
- extract shared protocol packages only after contracts stabilize;
- prohibit UI imports from backend implementation roots.

### Optimistic UI loses durable truth

Live text or widget changes may appear before a failed durable write.

Mitigation:

- order terminal events after required durable commits;
- refresh authoritative state after gaps or conflicts;
- visually distinguish pending state where necessary;
- test reconnect and failed-write reconciliation.

### Widget sandbox escape or confused deputy

Agent-authored code may try to access shell credentials or invoke unauthorized host operations.

Mitigation:

- hard sandbox without same-origin privilege;
- strict CSP;
- typed host bridge;
- explicit revision-bound grants;
- deny by default;
- capability checks at the host and execution boundaries;
- no raw Gateway token in widget content.

### Capability fatigue

Frequent grant prompts may make operators approve requests without review.

Mitigation:

- grant narrow named capabilities;
- keep render-only widgets capless;
- show clear scope and origin summaries;
- retain compatible grants only for proven subsets;
- require reapproval for broadened reach.

### Layout API overfits one browser implementation

Pixel-level agent commands could couple stored state and tools to one UI library.

Mitigation:

- expose semantic sizes, order, spans, anchors, and tabs;
- keep pixel measurement inside the shell;
- version public presentation contracts when introduced.

### Presentation mutations race with users or runs

Agent and user changes could overwrite each other.

Mitigation:

- use explicit revisions or compare-and-swap;
- fail on stale mutations;
- return authoritative snapshots;
- route run-starting commands through the session lane.

## Rejected alternatives

### Let the UI import backend modules directly

Rejected because it would erase the Gateway boundary, prevent independent clients, and couple browser builds to runtime and storage implementation.

### Let the UI read SQLite or transcript files

Rejected because it bypasses validation, display normalization, authorization, migrations, and reconnect semantics.

### Make a dashboard a separate session

Rejected because chat and dashboard are two presentation faces of the same logical work context. Separate sessions would split ownership, transcript, reset, and routing behavior.

### Attach all presentation state to `sessionId`

Rejected because resetting a transcript should not destroy persistent session-level surfaces.

### Store dashboard layout and widgets inside the transcript

Rejected because presentation state has different mutation, retention, reset, size, and security semantics from conversation history.

### Render agent-authored code directly in the Control UI shell

Rejected because it would grant untrusted content access to trusted DOM, credentials, storage, and Gateway APIs.

### Give widgets unrestricted Gateway RPC access

Rejected because method discovery is not authorization and unrestricted RPC would bypass data minimization, policy, approval, and per-capability grants.

### Route every widget interaction through a new agent run

Rejected because local presentation interactions should remain responsive and many state changes do not require model output. Explicit prompts and actions use their own visible boundaries.

### Allow hidden widget sessions

Rejected because hidden conversations complicate ownership, cost, observability, and user expectations. Automation requires explicit execution identity and routing.

### Force presentation writes through the active run lane

Rejected because layout and user interactions are independent state and should not block behind model execution. They use dedicated revisions while run-starting and transcript-affecting commands retain session-lane rules.

### Build a general UI plugin framework in V1

Rejected because V1 needs only the built-in transcript/chat surface and no active consumer justifies a broad public UI SDK.

## Validation

This decision is correctly applied when:

- `ui/` communicates with the backend through Gateway contracts only;
- UI code does not import backend implementation or concrete store modules;
- history comes from a bounded, display-oriented application or Gateway projection;
- reconnect and event-gap recovery refresh authoritative state through RPC;
- browser-local state is not the canonical session or presentation store;
- V1 exposes only the transcript/chat surface unless a later implementation plan adds another surface;
- future presentation state is owned by explicit `agentId` and `sessionKey`;
- reset preserves presentation state while replacing transcript identity according to ADR 0003;
- logical-session deletion removes its exclusively owned presentation state;
- presentation data is not persisted as transcript entries;
- Gateway handlers use a presentation service or store contract rather than direct SQLite queries;
- presentation mutations use an explicit revision or atomic conflict rule;
- agent-authored or third-party content is isolated from the trusted shell;
- widgets have no data, action, prompt, or network access by default;
- every widget capability is declared, validated, narrowly granted, and enforced by the host;
- side-effecting widget actions pass policy, approval, execution, and audit boundaries;
- widget prompt submission is visible, same-session, idempotent, and serialized like ordinary session input;
- plugins contribute presentation capability only through published contracts;
- tests cover reset survival, session deletion cleanup, stale revision conflicts, reconnect refresh, sandbox isolation, and capability denial before a dashboard feature is declared complete.
- any usage/cap surface reads typed Gateway/application projections and never SQLite or Run Journal aggregates directly.

## Revisit conditions

Revisit this decision when:

- a session needs multiple independently owned or shareable boards;
- presentation state must be moved or shared across sessions or agents;
- collaborative multi-user editing is introduced;
- remote Control UI access and granular authorization are implemented;
- dashboard state requires a separate process or storage engine;
- untrusted widgets need capabilities that cannot be safely expressed through the current grant model;
- native plugin UI contributions require a public shell-component SDK;
- presentation automation introduces background execution not represented by existing run identities;
- offline-first client mutation and synchronization are required;
- one `sessionKey` may expose multiple simultaneous transcript branches with distinct presentation faces.

## References

- `docs/decisions/0015-usage-accounting-and-cumulative-budget-enforcement.md`
- `docs/ARCHITECTURE.md`, section 6, **Core identities**
- `docs/ARCHITECTURE.md`, section 7, **Gateway architecture**
- `docs/ARCHITECTURE.md`, section 11, **Sessions and transcripts**
- `docs/ARCHITECTURE.md`, section 13, **Policy, approval, and sandbox**
- `docs/ARCHITECTURE.md`, section 16, **Plugin and extension architecture**
- `docs/ARCHITECTURE.md`, section 17, **Control UI and session surfaces**
- `docs/ARCHITECTURE.md`, section 22, **Dependency direction**
- `docs/decisions/0003-session-routing-transcript-separation-and-reset-semantics.md`
- `docs/decisions/0004-gateway-control-plane-and-protocol-contract.md`
- `docs/decisions/0006-run-attempt-lifecycle-and-per-session-serialization.md`
- `docs/decisions/0007-context-assembly-and-transcript-mutation-authority.md`
- `docs/decisions/0008-tool-runtime-policy-approval-and-sandbox-boundaries.md`
- `docs/decisions/0010-runtime-events-logs-transcripts-and-audit-separation.md`
- `docs/decisions/0012-plugin-registration-and-public-extension-boundary.md`
- OpenClaw Control UI: `https://docs.openclaw.ai/web/control-ui`
- OpenClaw WebChat: `https://docs.openclaw.ai/web/webchat`
- OpenClaw Session Dashboards: `https://docs.openclaw.ai/web/dashboards`
- OpenClaw Dashboard Architecture: `https://docs.openclaw.ai/web/dashboard-architecture`
