---
name: agent-report
description: Create or resume and structurally validate a my-agent-v2 CLI checkpoint report when the task explicitly requires one. Use after validation and any requested commit/push. Do not use for planning, closure verdicts, or trivial user-reviewed changes.
---

# Agent Report

Create one execution-evidence report for the current `my-agent-v2` task.

## Required inputs

Obtain these from the task contract:

- task ID;
- outcome type;
- baseline commit.

If any input is missing or ambiguous, stop and report the exact missing input.
Do not infer a baseline from the current `HEAD`.

## Preconditions

Use this skill only when the task explicitly requires a report.

Run it after:

1. task execution;
2. required validation;
3. any requested commit and push.

Do not modify product source merely to make the report look complete.

## Workflow

1. Read `docs/CLI_EXECUTOR_PROTOCOL.md` and the current task contract.
2. Confirm the current repository, branch, resulting `HEAD`, working tree, and
   requested baseline.
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

5. Fill every semantic section using evidence from the task just executed.

   Record:

   - the observable outcome;
   - validation commands and results;
   - the exact `git push` command/result when push was required;
   - strongest source, test, migration, runtime, or transcript locators;
   - provisional blocking findings;
   - provisional P2 observations;
   - task deviations;
   - the next ChatGPT action;
   - a non-verdict final statement.

6. Use `None observed.` only after checking the relevant evidence. Never leave a
   default `None` without review.

7. Treat CLI finding classifications as provisional evidence. ChatGPT owns final
   classification and closure verdict.

8. Do not write a milestone `PASS`, promote a milestone, or authorize
   synchronization unless the task itself is an already authorized
   synchronization task.

9. Add a task-specific section only when needed for migration, controlled/live
   verification, runtime IDs, transcript ranges, or environment evidence.

10. Validate the completed report:

   ```bash
   "$repo_root/.agents/skills/agent-report/scripts/report.sh" \
     check \
     "$repo_root/.agent-reports/<TASK-ID>-report.md"
   ```

11. Print the absolute report path and state that it passed the structural check.

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
- The internal script reports local upstream-tracking state; it does not fetch or
  independently prove the remote received a push.
- The structural check verifies shape and placeholder completion only. It does
  not verify factual truth.
- If Git state, baseline, push evidence, or execution evidence is inconsistent,
  leave the report incomplete and stop with an explicit explanation.
