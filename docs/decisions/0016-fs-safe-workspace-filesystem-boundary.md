# ADR 0016: fs-safe Workspace Filesystem Boundary

- **Status:** Accepted
- **Date:** 2026-07-30
- **Decision owners:** my-agent-v2 maintainers
- **Related architecture:** `docs/ARCHITECTURE.md`
- **Related decisions:**
  - `docs/decisions/0008-tool-runtime-policy-approval-and-sandbox-boundaries.md`
  - `docs/decisions/0011-platform-and-browser-runtime-boundaries.md`

## Context

The M3 workspace tools accept model-controlled relative paths and need bounded
filesystem operations without copying package-level publication or containment
algorithms into the Tool Runtime. The M3-R3B planning decision at `d82dcfd`
incorrectly treated `@openclaw/fs-safe` native mode as universal containment
proof and required the package to be the sole filesystem safety mechanism.
The package's public Root API is a root-bounded filesystem capability, but
application policy may intentionally be stricter than its operation semantics.

## Decision

M3 pins `@openclaw/fs-safe@0.5.0` as the base workspace filesystem capability.
`src/platform/` owns a narrow application facade, its defaults, and approved
advanced helpers; Tool Runtime contracts do not expose package types.

The project retains its own policy responsibilities:

- lexical workspace-target normalization;
- protected-path rules; and
- rejection of every symlink path component, including links resolving inside
  the workspace, before policy approval and again before execution.

Those wrappers do not recreate fs-safe internals or native bindings. fs-safe
performs root-bounded operations, atomic publication, its error primitives, and
hardlink checks. Project tests prove dependency wiring and project-specific
rules; they do not copy the package's adversarial or native test suites.

`workspace.write_text` exposes two verbs:

```text
create  atomic no-clobber; existing target fails
write   atomically publishes complete content; target may be created or overwritten
```

Neither verb creates missing parent directories. Native helper availability is
not treated as universal containment proof. This library guardrail remains
separate from future OS sandboxing.

## Consequences

Workspace policy and the executor both revalidate the strict path policy, then
call the shared project adapter backed by an fs-safe Root. The application no
longer implements temporary filenames, direct write sequencing, rename
publication, or temporary-file cleanup for workspace writes.

This ADR supersedes only ADR 0008 filesystem-operation details: its Tool
Runtime, policy, approval, sandbox, scheduling, and ownership decisions remain
unchanged. It does not alter ADR 0009 storage ownership.

The d82dcfd M3-R3BP statements that fs-safe is the sole safety engine and that
`native=require` proves every workspace operation are superseded.
