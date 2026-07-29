---
name: agent-report
description: Create or resume and structurally validate a my-agent-v2 CLI execution evidence report when explicitly required by task contract. Use after validation and any requested commit/push. Do not use for small tasks, trivial user-reviewed changes, planning, closure verdicts, or session handoffs.
---

# Agent Report

Create one concise execution-evidence report for the current `my-agent-v2` task.

## Artifact Roles

- **Git**: Source truth (commits, refs, pushed states, diffs).
- **$agent-report**: Concise execution evidence.
- **handoff**: Context transfer (created ONLY at context boundaries, never for routine checkpoints).
- **ChatGPT audit**: Closure verdict and final classification authority.
- **user**: Acceptance authority.

## Required inputs

Obtain these from the task contract:

- task ID;
- outcome type;
- baseline commit.

If any input is missing or ambiguous, stop and report the exact missing input.
Do not infer a baseline from the current `HEAD`.

## Preconditions

Use this skill only when the task explicitly requires an execution report. Do NOT require a report for small tasks or trivial user-reviewed changes.

Run it after:

1. task execution;
2. required validation;
3. any requested commit and push.

Do not modify product source merely to make the report look complete.

## Focused Scope

Reports must avoid recounting the entire work process or writing long source code explanations. Git remains the source of truth. Focus strictly on:

1. task contract;
2. baseline and resulting commit;
3. exact changed scope;
4. validation command/result;
5. commit/push result (concrete Git evidence, pushed commit SHA/ref);
6. deviations or stop conditions;
7. provisional findings;
8. absolute report path.

## Workflow

1. Read `docs/CLI_EXECUTOR_PROTOCOL.md` and the current task contract.
2. Confirm the current repository, branch, resulting `HEAD`, and requested baseline.
3. Resolve the repository root:

   ```bash
   repo_root="$(git rev-parse --show-toplevel)"
   ```

4. Create or resume the report skeleton:

   ```bash
   "$repo_root/.agents/skills/agent-report/scripts/report.sh" \
     create \
     "<TASK-ID>" \
     "<OUTCOME>" \
     "<BASELINE-COMMIT>"
   ```

   The create operation is resumable. If a report already exists with the same
   task ID, outcome, baseline, and resulting `HEAD`, the script returns its path.
   If metadata differs, it stops rather than overwriting the report.

5. Fill every section with exact evidence from the task:

   - Record exact validation commands and results.
   - Record exact `git push` command, pushed commit SHA/ref, and remote output when push was required (replace vague claims like "local tracking synced" with concrete Git evidence).
   - Record provisional blocking findings, P2 observations, or task deviations/stop conditions.
   - Record the next ChatGPT action and non-verdict final statement.

6. Use `None observed.` only after checking the relevant evidence. Never leave a
   default `None` without review.

7. Treat CLI finding classifications as provisional evidence. ChatGPT owns final
   classification and closure verdict.

8. Do not write a milestone `PASS`, promote a milestone, or authorize
   synchronization unless the task itself is an already authorized
   synchronization task.

9. Validate the completed report:

   ```bash
   "$repo_root/.agents/skills/agent-report/scripts/report.sh" \
     check \
     "$repo_root/.agent-reports/<TASK-ID>-report.md"
   ```

10. Print the absolute report path and state that it passed the structural check.

## Classification rules

- Blocking findings must trace to Architecture, ADR, Implementation Plan,
  accepted task gates, or a production regression.
- Missing proof is `MISSING CLOSURE EVIDENCE`, not automatically an
  implementation defect.
- Improvements outside the accepted task contract are `QUALITY IMPROVEMENT / P2`.

These classifications remain provisional until ChatGPT reviews the evidence.

## Final statements

Use a completion statement only when required execution and validation completed,
and any required commit/push succeeded.

For completed implementation or remediation:

```text
Implementation completed; pending ChatGPT closure audit.
```

For completed evidence-only verification:

```text
Evidence collection completed; pending ChatGPT review.
```

For completed synchronization:

```text
Synchronization completed; pending checkpoint review.
```

When required execution, validation, commit, or push is incomplete:

```text
Execution incomplete; findings recorded for ChatGPT review.
```

## Safety and integrity

- Never include secrets, credentials, unrestricted logs, or private payloads.
- Never commit files under `.agent-reports/`.
- Provide explicit Git evidence for pushed commits; do not rely on unverified local sync assumptions.
- The structural check verifies shape and placeholder completion only. It does not verify factual truth.
- If Git state, baseline, push evidence, or execution evidence is inconsistent,
  leave the report incomplete and stop with an explicit explanation.
