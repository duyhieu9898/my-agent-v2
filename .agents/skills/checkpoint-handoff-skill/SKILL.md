---
name: checkpoint-handoff
description: Create a concise my-agent-v2 checkpoint handoff from the current clean, pushed, synchronized repository state. Invoke only when the user explicitly asks for a handoff.
---

# Checkpoint Handoff

Create one concise recovery/index handoff for the current `my-agent-v2` checkpoint.

## Normal invocation

The user should only need to say:

```text
Use $checkpoint-handoff to create a handoff.
```

Do not ask for checkpoint, milestone status, verdict, or next outcome when they can
be derived from the repository. Never invent missing state.

## Allowed

- Inspect Git state and repository authority.
- Fetch the configured upstream and verify that the current checkpoint is pushed.
- Read `AGENTS.md`, `docs/WORKFLOW.md`, `docs/IMPLEMENTATION_PLAN.md`, relevant
  Architecture/ADR locators, and active/completed plans only as needed.
- Create one concise handoff under `.agent-handoffs/`.
- Distinguish repository evidence from local Git evidence.
- Structurally validate the generated handoff.
- Print the absolute handoff path for upload to ChatGPT Project Sources.

## Not allowed

- Do not decide when a handoff is needed.
- Do not create a handoff automatically after each commit.
- Do not self-promote milestones or invent an accepted verdict.
- Do not choose the next task.
- Do not edit Architecture, ADRs, plans, code, tests, migrations, dependencies, or
  milestone status.
- Do not copy long Architecture, ADR, plan, source, diff, test-log, or validation
  content into the handoff.
- Do not commit generated handoffs.
- Do not manage ChatGPT Project Sources.

## Preconditions

Run from inside the `my-agent-v2` repository. The helper must verify:

1. the repository root is named `my-agent-v2`;
2. the branch is not detached and has an upstream;
3. the configured upstream can be fetched;
4. the working tree is clean, including untracked files;
5. `HEAD` equals the fetched upstream commit;
6. ahead/behind divergence is `0 0`.

Stop with the exact failed condition. Never reset, stash, clean, restore, discard,
or push on the user's behalf.

## Workflow

1. Read only the repository material needed to understand canonical locators.
2. Run:

   ```bash
   repo_root="$(git rev-parse --show-toplevel)"
   "$repo_root/.agents/skills/checkpoint-handoff/scripts/handoff.sh" create
   ```

3. The script creates or safely resumes:

   ```text
   .agent-handoffs/my-agent-v2-session-handoff-<short-sha>.md
   ```

4. If a handoff for the same checkpoint already exists, reuse it only when its
   checkpoint metadata and structure still match. Otherwise stop rather than
   overwrite it.
5. The script may add `.agent-handoffs/` to `.git/info/exclude` when no repository
   ignore rule exists. This is local Git metadata, not a tracked repository edit.
6. Print the absolute path returned by the helper and state that structural
   validation passed.

## Missing information

Use these exact fallbacks instead of guessing:

```text
NOT RECORDED
Not yet selected by project control.
None recorded outside repository.
```

## Handoff contents

Keep the handoff short. It contains:

- authority statement;
- checkpoint, branch, upstream, sync, and working-tree evidence;
- canonical repository locators;
- current workstream and milestone axes when explicitly recorded;
- accepted audit/user verdict only when explicitly recorded;
- external or local-only evidence, otherwise the fallback above;
- blockers/P2 as repository locators rather than copied lists;
- exact next outcome only when explicitly recorded;
- do-not-reopen rules supported by synchronized repository status;
- replacement status for Project Sources.

## Validation scope

Structural validation checks shape, checkpoint identity, ignored output, unfinished
placeholders, fence balance, concise size, and obvious credential patterns. It does
not prove that repository status documents or human-entered evidence are factually
correct.
