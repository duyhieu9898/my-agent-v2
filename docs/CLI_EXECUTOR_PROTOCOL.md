# CLI Executor Protocol

## Purpose

CLI executes one scoped task for `my-agent-v2`.

ChatGPT owns decisions, planning, task decomposition, source review, closure audit,
and selection of the next outcome. The user is final decision authority.

Repository authority remains higher than this protocol:

1. `AGENTS.md`
2. `docs/WORKFLOW.md`
3. `docs/ARCHITECTURE.md`
4. current ADRs
5. `docs/IMPLEMENTATION_PLAN.md`
6. active plan

## Before execution

Read the authority and files named by the task.

Verify baseline repository state using the standardized checkpoint evidence block:

```bash
git rev-parse --show-toplevel
git rev-parse HEAD
git branch --show-current
git status --short --branch
git rev-parse --abbrev-ref '@{upstream}'
git rev-list --left-right --count '@{upstream}...HEAD'
git log --oneline -5
git diff --stat
git diff --check
```

Stop and report when:

- the baseline materially differs;
- authority conflicts with the task;
- existing local changes overlap the requested scope;
- a missing decision blocks execution.

Do not reset, clean, stash, restore, or discard existing work unless explicitly
requested.

## Execution

- Perform only the requested outcome.
- Do not create or materially change an active plan unless the task explicitly
  authorizes planning work.
- Do not change Architecture or ADR decisions.
- Do not expand scope or fix unrelated P2 items.
- Do not combine implementation, audit, and synchronization.
- Do not self-promote a milestone to `PASS`.
- Do not choose the next task.

For implementation, prove observable behavior rather than only creating files,
classes, or interfaces.

## Validation

Run the validation required by the task or active plan.

Use the smallest proof appropriate to the affected behavior. Do not run unrelated
full-suite validation merely because more validation is possible.

Record commands, results, and useful counts for any required report.

## Commit and push

Commit and push only when requested.

Keep the commit limited to task scope. Do not commit reports, secrets, temporary
evidence, or unrelated changes.

Source-changing checkpoints must be pushed before ChatGPT source review.
Evidence-only tasks may finish without a new commit when no durable source changed.

A commit does not imply milestone closure.

## Checkpoint Evidence Standard

Standardize checkpoint evidence checking using this fixed block:

```bash
git rev-parse HEAD
git branch --show-current
git status --short --branch
git rev-parse --abbrev-ref '@{upstream}'
git rev-list --left-right --count '@{upstream}...HEAD'
```

A checkpoint is valid when:
- **HEAD**: `<commit>`
- **branch**: `<expected branch>`
- **working tree**: `clean`
- **upstream**: `<expected remote branch>`
- **divergence**: `0 0` (0 commits behind, 0 commits ahead)

## Report & Handoff Rules

### Artifact Roles

- **Git**: Source truth (commits, refs, pushed states, diffs).
- **$agent-report**: Concise execution evidence.
- **handoff**: Context transfer (created ONLY at context boundaries, never for routine checkpoints).
- **ChatGPT audit**: Closure verdict and final classification authority.
- **user**: Acceptance authority.

### When Report Is Required vs. Optional

Do NOT require a report for every task. Follow this single rule:

**Report required:**
- implementation checkpoint needing ChatGPT source review;
- remediation;
- evidence-only verification;
- live verification;
- important synchronization;
- task with commit/push or complex validation.

**Report optional:**
- docs typo;
- formatting;
- small changes directly verifiable from commit;
- pure Git operations without changing source.

Tasks requiring a report must state clearly in the prompt:

```text
Use $agent-report after validation and any requested commit/push.
Task ID: <task-id>
Outcome: <outcome-type>
Baseline: <baseline-commit>
```

### Report Execution

When a report is required:

After validation and any requested commit/push, invoke:

```text
$agent-report
```

Provide or preserve these inputs from the task contract:

- task ID;
- outcome type;
- baseline commit.

The skill must:

- collect baseline and resulting commit metadata from the current repository;
- require the baseline to be an ancestor of the resulting `HEAD`;
- create or resume the matching report under `.agent-reports/`;
- fill semantic execution evidence from the current task;
- validate structural completeness with its internal script;
- print the absolute report path.

The report must focus strictly on concise execution evidence without process narrative storytelling or lengthy source code explanations:

- task contract (task ID, outcome type);
- baseline and resulting commit;
- exact changed scope;
- validation commands and results;
- commit/push result (concrete Git evidence: push command, pushed commit SHA/ref, remote output);
- deviations or stop conditions;
- provisional blocking findings and P2 items;
- next ChatGPT action;
- non-verdict final statement.

CLI classifications are provisional execution evidence. ChatGPT owns final finding classification and closure verdict.

The skill's structural check verifies report shape and completeness only. It does not verify that commands ran, evidence is true, or classifications are correct.

Do not include secrets or unrestricted sensitive logs.

Use a completion statement only when required execution and validation completed, and any required commit/push succeeded.

For completed implementation or remediation:

```text
Implementation completed; pending ChatGPT closure audit.
```

For completed evidence-only work:

```text
Evidence collection completed; pending ChatGPT review.
```

When required work, validation, commit, or push is incomplete:

```text
Execution incomplete; findings recorded for ChatGPT review.
```

Print the absolute report path when finished.

### Strict Handoff Conditions

Handoff documents are created ONLY at context boundaries, not after every task or routine checkpoint.

**Create handoff when:**
- switching chat/session;
- changing milestone;
- finishing a long workstream;
- stopping work to continue another day;
- current context window is getting too long.

**Do NOT create handoff when:**
- just committed a small task;
- report is sufficient and continuing work in the same session;
- just moving from a minor remediation to audit.

**Handoff content structure (locators and status only; do NOT copy full reports or narrative history):**
- checkpoint (HEAD SHA)
- branch/upstream state
- accepted verdict
- active-plan path
- report locator
- blocking/P2 items
- next outcome
