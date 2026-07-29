#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Internal helper for the agent-report skill.

Usage:
  report.sh create <task-id> <outcome-type> <baseline-commit> [output-path]
  report.sh check <report-path>
EOF
}

die() {
  printf 'agent-report: %s\n' "$*" >&2
  exit 1
}

absolute_path() {
  local path="$1"
  printf '%s\n' "$(cd "$(dirname "$path")" && pwd)/$(basename "$path")"
}

require_heading() {
  local report_path="$1"
  local heading="$2"
  grep -Fxq "$heading" "$report_path" ||
    die "missing required heading '$heading' in $report_path"
}

checkpoint_value() {
  local report_path="$1"
  local label="$2"
  local line

  line="$(grep -F -m1 -- "- ${label}: \`" "$report_path" || true)"
  [[ -n "$line" ]] || return 1

  line="${line#*: \`}"
  line="${line%\`}"
  printf '%s\n' "$line"
}

resume_existing_report() {
  local report_path="$1"
  local task_id="$2"
  local outcome_type="$3"
  local initial_head="$4"
  local resulting_head="$5"

  [[ -s "$report_path" ]] ||
    die "existing report is empty: $report_path"

  local existing_task existing_outcome existing_baseline existing_result
  existing_task="$(checkpoint_value "$report_path" "Task ID" || true)"
  existing_outcome="$(checkpoint_value "$report_path" "Outcome type" || true)"
  existing_baseline="$(checkpoint_value "$report_path" "Baseline commit" || true)"
  existing_result="$(checkpoint_value "$report_path" "Resulting commit" || true)"

  if [[ "$existing_task" == "$task_id" &&
        "$existing_outcome" == "$outcome_type" &&
        "$existing_baseline" == "$initial_head" &&
        "$existing_result" == "$resulting_head" ]]; then
    absolute_path "$report_path"
    return 0
  fi

  die "existing report metadata does not match the current task/checkpoint: $report_path"
}

check_report() {
  local report_path="$1"

  [[ -s "$report_path" ]] || die "report is missing or empty: $report_path"

  local fence_count
  fence_count="$(grep -c '^```' "$report_path" || true)"
  (( fence_count % 2 == 0 )) ||
    die "Markdown code fences are unbalanced: $report_path"

  if grep -Eq '<<FILL:|NOT ASSESSED|REPLACE BEFORE UPLOAD|<!--' "$report_path"; then
    die "report still contains unfinished placeholders: $report_path"
  fi

  require_heading "$report_path" "# CLI Report"
  require_heading "$report_path" "## Task contract"
  require_heading "$report_path" "## Commit metadata"
  require_heading "$report_path" "## Changed scope"
  require_heading "$report_path" "## Validation"
  require_heading "$report_path" "## Commit and push result"
  require_heading "$report_path" "## Deviations and stop conditions"
  require_heading "$report_path" "## Provisional findings"
  require_heading "$report_path" "### Blocking"
  require_heading "$report_path" "### P2"
  require_heading "$report_path" "## Next ChatGPT action"
  require_heading "$report_path" "## Final statement"

  absolute_path "$report_path"
}

create_report() {
  [[ $# -ge 3 && $# -le 4 ]] || {
    usage
    exit 2
  }

  local task_id="$1"
  local outcome_type="$2"
  local initial_head="$3"
  local output_override="${4:-}"

  [[ "$task_id" =~ ^[A-Za-z0-9._-]+$ ]] ||
    die "task ID may contain only letters, numbers, dot, underscore, and hyphen"

  local repo_root report_dir output_path branch resulting_head head_message
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
    die "not inside a Git repository"

  git -C "$repo_root" cat-file -e "${initial_head}^{commit}" 2>/dev/null ||
    die "baseline commit is not available locally: ${initial_head}"

  resulting_head="$(git -C "$repo_root" rev-parse HEAD)"

  git -C "$repo_root" merge-base --is-ancestor "$initial_head" "$resulting_head" ||
    die "baseline is not an ancestor of resulting HEAD"

  report_dir="${repo_root}/.agent-reports"
  output_path="${output_override:-${report_dir}/${task_id}-report.md}"

  if ! git -C "$repo_root" check-ignore -q ".agent-reports/.probe" 2>/dev/null; then
    die ".agent-reports/ is not ignored; add it to .gitignore before creating reports"
  fi

  if [[ -e "$output_path" ]]; then
    resume_existing_report \
      "$output_path" \
      "$task_id" \
      "$outcome_type" \
      "$initial_head" \
      "$resulting_head"
    return 0
  fi

  branch="$(git -C "$repo_root" branch --show-current)"
  branch="${branch:-DETACHED}"
  head_message="$(git -C "$repo_root" log -1 --pretty=%s)"

  local changed_files change_stat
  changed_files="$(
    git -C "$repo_root" diff --name-status "${initial_head}..${resulting_head}" ||
      true
  )"
  change_stat="$(
    git -C "$repo_root" diff --stat "${initial_head}..${resulting_head}" ||
      true
  )"

  changed_files="${changed_files:-none}"
  change_stat="${change_stat:-none}"

  mkdir -p "$(dirname "$output_path")"

  cat >"$output_path" <<EOF
# CLI Report

## Task contract

- Task ID: \`${task_id}\`
- Outcome type: \`${outcome_type}\`

## Commit metadata

- Branch: \`${branch}\`
- Baseline commit: \`${initial_head}\`
- Resulting commit: \`${resulting_head}\`
- Commit message: \`${head_message}\`

## Changed scope

\`\`\`text
${changed_files}
\`\`\`

\`\`\`text
${change_stat}
\`\`\`

## Validation

| Command | Result |
| --- | --- |
| <<FILL: exact command>> | <<FILL: PASS/FAIL and useful counts>> |

## Commit and push result

<<FILL: Record exact push command, pushed commit SHA/ref, and push output, or "Push not required.">>

## Deviations and stop conditions

<<FILL: Task deviations or stop conditions encountered, or "None observed.">>

## Provisional findings

CLI classifications below are provisional execution evidence. ChatGPT owns final classification and closure verdict.

### Blocking

<<FILL: Exact blocking findings or "None observed.">>

### P2

<<FILL: Exact P2 items or "None observed.">>

## Next ChatGPT action

<<FILL: State the required ChatGPT review, audit, remediation, or synchronization action.>>

## Final statement

<<FILL: Use a condition-appropriate non-verdict final statement from SKILL.md.>>
EOF

  [[ -s "$output_path" ]] || die "report was not created or is empty"

  local fence_count
  fence_count="$(grep -c '^```' "$output_path" || true)"
  (( fence_count % 2 == 0 )) ||
    die "generated Markdown code fences are unbalanced"

  absolute_path "$output_path"
}

case "${1:-}" in
  create)
    shift
    create_report "$@"
    ;;
  check)
    shift
    [[ $# -eq 1 ]] || {
      usage
      exit 2
    }
    check_report "$1"
    ;;
  -h|--help|help|"")
    usage
    ;;
  *)
    usage
    exit 2
    ;;
esac
