#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  handoff.sh create
  handoff.sh check <handoff-path>
USAGE
}

die() {
  printf 'checkpoint-handoff: %s\n' "$*" >&2
  exit 1
}

absolute_path() {
  local path="$1"
  printf '%s/%s\n' "$(cd "$(dirname "$path")" && pwd)" "$(basename "$path")"
}

trim() {
  sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

strip_markdown_value() {
  sed -E \
    -e 's/^[[:space:]]*[-*]?[[:space:]]*//' \
    -e 's/^\*\*[^*]+:\*\*[[:space:]]*//' \
    -e 's/^[^:]+:[[:space:]]*//' \
    -e 's/[[:space:]]+$//' \
    -e 's/^`//' \
    -e 's/`$//'
}

first_metadata_value() {
  local file="$1"
  local pattern="$2"
  [[ -f "$file" ]] || return 1
  sed -n '1,80p' "$file" | grep -Ei -m1 "$pattern" | strip_markdown_value
}

first_explicit_state() {
  local file="$1"
  local pattern="$2"
  local line
  [[ -f "$file" ]] || return 1
  line="$(sed -n '1,100p' "$file" | grep -Ei -m1 "$pattern" || true)"
  [[ -n "$line" ]] || return 1
  if grep -Eq '\bPASS\b' <<<"$line"; then printf 'PASS\n'; return 0; fi
  if grep -Eq '\bFAIL\b' <<<"$line"; then printf 'FAIL\n'; return 0; fi
  if grep -Eq '\bNOT RUN\b' <<<"$line"; then printf 'NOT RUN\n'; return 0; fi
  if grep -Eq '\bPENDING\b' <<<"$line"; then printf 'PENDING\n'; return 0; fi
  return 1
}

markdown_escape() {
  sed 's/`/\\`/g'
}

ensure_local_ignore() {
  local repo_root="$1"
  if git -C "$repo_root" check-ignore -q '.agent-handoffs/.probe' 2>/dev/null; then
    return 0
  fi

  local exclude_file
  exclude_file="$(git -C "$repo_root" rev-parse --git-path info/exclude)"
  mkdir -p "$(dirname "$exclude_file")"
  touch "$exclude_file"

  if ! grep -Fxq '.agent-handoffs/' "$exclude_file"; then
    {
      printf '\n# checkpoint-handoff local artifacts\n'
      printf '.agent-handoffs/\n'
    } >>"$exclude_file"
  fi

  git -C "$repo_root" check-ignore -q '.agent-handoffs/.probe' 2>/dev/null ||
    die 'unable to keep .agent-handoffs/ ignored'
}

require_heading() {
  local file="$1"
  local heading="$2"
  grep -Fxq "$heading" "$file" || die "missing required heading '$heading' in $file"
}

checkpoint_value() {
  local file="$1"
  local label="$2"
  local line
  line="$(grep -F -m1 -- "- ${label}: \`" "$file" || true)"
  [[ -n "$line" ]] || return 1
  line="${line#*: \`}"
  line="${line%\`}" 
  printf '%s\n' "$line"
}

check_handoff() {
  local handoff_path="$1"
  [[ -s "$handoff_path" ]] || die "handoff is missing or empty: $handoff_path"

  require_heading "$handoff_path" '# my-agent-v2 — Session Handoff'
  require_heading "$handoff_path" '## 1. Authority'
  require_heading "$handoff_path" '## 2. Checkpoint'
  require_heading "$handoff_path" '## 3. Canonical repository locators'
  require_heading "$handoff_path" '## 4. Accepted control-plane state'
  require_heading "$handoff_path" '## 5. External or local-only evidence'
  require_heading "$handoff_path" '## 6. Open state'
  require_heading "$handoff_path" '### Blocking'
  require_heading "$handoff_path" '### P2'
  require_heading "$handoff_path" '## 7. Next outcome'
  require_heading "$handoff_path" '## 8. Do not reopen'
  require_heading "$handoff_path" '## 9. Replacement status'

  local fence_count
  fence_count="$(grep -c '^```' "$handoff_path" || true)"
  (( fence_count % 2 == 0 )) || die "Markdown code fences are unbalanced: $handoff_path"

  if grep -Eqi '<<[^>]+>>|<FULL-COMMIT|<branch>|<path>|TODO|REPLACE BEFORE UPLOAD|NOT ASSESSED|<!--' "$handoff_path"; then
    die "handoff contains unfinished placeholders: $handoff_path"
  fi

  local line_count
  line_count="$(wc -l <"$handoff_path")"
  (( line_count <= 140 )) || die "handoff is too long (${line_count} lines; maximum 140): $handoff_path"

  if grep -Eq 'AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[0-9A-Za-z]{20,}|sk-[0-9A-Za-z_-]{20,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|Authorization:[[:space:]]*Bearer[[:space:]]+[0-9A-Za-z._-]+' "$handoff_path"; then
    die "handoff may contain a credential or private key: $handoff_path"
  fi

  local repo_root current_head recorded_head
  repo_root="$(git -C "$(dirname "$handoff_path")" rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "$repo_root" ]]; then
    current_head="$(git -C "$repo_root" rev-parse HEAD)"
    recorded_head="$(checkpoint_value "$handoff_path" 'Commit' || true)"
    [[ "$recorded_head" == "$current_head" ]] ||
      die "handoff checkpoint does not match current HEAD: recorded=${recorded_head:-missing}, HEAD=$current_head"

    git -C "$repo_root" check-ignore -q -- "${handoff_path#"$repo_root"/}" 2>/dev/null ||
      die "generated handoff is not ignored: $handoff_path"
  fi

  absolute_path "$handoff_path"
}

resolve_active_plan() {
  local repo_root="$1"
  local implementation_plan="$repo_root/docs/IMPLEMENTATION_PLAN.md"
  local value=""

  if [[ -f "$implementation_plan" ]]; then
    value="$(grep -E -m1 '^\*\*Active execution plan:\*\*' "$implementation_plan" | strip_markdown_value || true)"
    value="${value//\`/}"
  fi

  if [[ -n "$value" && -f "$repo_root/$value" ]]; then
    printf '%s\n' "$value"
    return 0
  fi

  local candidate
  candidate="$(find "$repo_root/docs/plans/active" -maxdepth 1 -type f -name '*.md' 2>/dev/null | sort | head -n1 || true)"
  if [[ -n "$candidate" ]]; then
    printf '%s\n' "${candidate#"$repo_root"/}"
    return 0
  fi

  printf 'NONE\n'
}

resolve_completed_plan() {
  local repo_root="$1"
  local candidate
  candidate="$(find "$repo_root/docs/plans/completed" -maxdepth 1 -type f -name '*.md' 2>/dev/null | sort | tail -n1 || true)"
  if [[ -n "$candidate" ]]; then
    printf '%s\n' "${candidate#"$repo_root"/}"
  else
    printf 'NONE\n'
  fi
}

resolve_relevant_adrs() {
  local plan_file="$1"
  local line=""
  if [[ -f "$plan_file" ]]; then
    line="$(sed -n '1,30p' "$plan_file" | grep -Ei -m1 'Architecture authority|ADR' || true)"
  fi
  if [[ -n "$line" ]]; then
    printf '%s\n' "$line" | strip_markdown_value
  else
    printf 'See docs/decisions/README.md\n'
  fi
}

create_handoff() {
  local repo_root repo_name branch upstream upstream_remote head full_subject short_head
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || die 'not inside a Git repository'
  repo_name="$(basename "$repo_root")"
  [[ "$repo_name" == 'my-agent-v2' ]] || die "expected repository root named my-agent-v2, found: $repo_name"

  branch="$(git -C "$repo_root" branch --show-current)"
  [[ -n "$branch" ]] || die 'detached HEAD is not supported'

  upstream="$(git -C "$repo_root" for-each-ref --format='%(upstream:short)' "refs/heads/$branch")"
  upstream_remote="$(git -C "$repo_root" for-each-ref --format='%(upstream:remotename)' "refs/heads/$branch")"
  [[ -n "$upstream" && -n "$upstream_remote" ]] || die "branch '$branch' has no configured upstream"

  git -C "$repo_root" fetch "$upstream_remote" --prune || die "failed to fetch upstream remote '$upstream_remote'"

  local dirty
  dirty="$(
    {
      git -C "$repo_root" diff --cached --name-status
      git -C "$repo_root" diff --name-status
      git -C "$repo_root" ls-files --others --exclude-standard | sed 's/^/?? /'
    } | sed '/^$/d' || true
  )"
  [[ -z "$dirty" ]] || die $'working tree is not clean:\n'"$dirty"

  local behind ahead
  read -r behind ahead < <(git -C "$repo_root" rev-list --left-right --count "${upstream}...HEAD")
  [[ "$behind" == '0' && "$ahead" == '0' ]] ||
    die "checkpoint is not synchronized with $upstream (ahead=$ahead, behind=$behind)"

  head="$(git -C "$repo_root" rev-parse HEAD)"
  [[ "$head" == "$(git -C "$repo_root" rev-parse "$upstream")" ]] ||
    die "HEAD does not equal upstream '$upstream'"

  full_subject="$(git -C "$repo_root" log -1 --pretty=%s | markdown_escape)"
  short_head="$(git -C "$repo_root" rev-parse --short=7 HEAD)"

  ensure_local_ignore "$repo_root"

  local handoff_dir handoff_path
  handoff_dir="$repo_root/.agent-handoffs"
  handoff_path="$handoff_dir/my-agent-v2-session-handoff-${short_head}.md"
  mkdir -p "$handoff_dir"

  if [[ -e "$handoff_path" ]]; then
    local recorded_head
    recorded_head="$(checkpoint_value "$handoff_path" 'Commit' || true)"
    [[ "$recorded_head" == "$head" ]] ||
      die "existing handoff metadata does not match current checkpoint: $handoff_path"
    check_handoff "$handoff_path" >/dev/null
    absolute_path "$handoff_path"
    return 0
  fi

  local active_plan completed_plan active_plan_file plan_title plan_status
  local deterministic controlled live audit_verdict user_acceptance next_outcome relevant_adrs
  active_plan="$(resolve_active_plan "$repo_root")"
  completed_plan="$(resolve_completed_plan "$repo_root")"
  active_plan_file="$repo_root/$active_plan"

  if [[ "$active_plan" != 'NONE' && -f "$active_plan_file" ]]; then
    plan_title="$(sed -n '1s/^# *//p' "$active_plan_file" | markdown_escape)"
    plan_status="$(first_metadata_value "$active_plan_file" '^\*\*Status:\*\*' || true)"
    deterministic="$(first_explicit_state "$active_plan_file" 'deterministic' || true)"
    controlled="$(first_explicit_state "$active_plan_file" 'controlled' || true)"
    live="$(first_explicit_state "$active_plan_file" '(^|[^[:alpha:]])live([^[:alpha:]]|$)|Gemini live' || true)"
    audit_verdict="$(first_metadata_value "$active_plan_file" 'closure verdict|independent audit' || true)"
    user_acceptance="$(first_metadata_value "$active_plan_file" 'user acceptance' || true)"
    next_outcome="$(first_metadata_value "$active_plan_file" 'next outcome' || true)"
    relevant_adrs="$(resolve_relevant_adrs "$active_plan_file" | markdown_escape)"
  else
    plan_title='NOT RECORDED'
    plan_status='NOT RECORDED'
    deterministic='NOT RECORDED'
    controlled='NOT RECORDED'
    live='NOT RECORDED'
    audit_verdict='NOT RECORDED'
    user_acceptance='NOT RECORDED'
    next_outcome=''
    relevant_adrs='See docs/decisions/README.md'
  fi

  plan_title="${plan_title:-NOT RECORDED}"
  plan_status="${plan_status:-NOT RECORDED}"
  deterministic="${deterministic:-NOT RECORDED}"
  controlled="${controlled:-NOT RECORDED}"
  live="${live:-NOT RECORDED}"
  audit_verdict="${audit_verdict:-NOT RECORDED}"
  user_acceptance="${user_acceptance:-NOT RECORDED}"
  next_outcome="${next_outcome:-Not yet selected by project control.}"

  local do_not_reopen_1 do_not_reopen_2
  if [[ "$completed_plan" != 'NONE' ]]; then
    do_not_reopen_1="- Do not reopen completed plan \`$completed_plan\` unless repository evidence shows a production regression or decision violation."
  else
    do_not_reopen_1='- No completed-plan boundary is recorded.'
  fi

  if grep -Eqi 'pending independent closure audit|audit.*pending' <<<"$plan_status $audit_verdict"; then
    do_not_reopen_2='- Do not promote or synchronize the active milestone before an accepted independent closure audit.'
  else
    do_not_reopen_2='- Do not change accepted milestone state without repository evidence and project-control approval.'
  fi

  cat >"$handoff_path" <<EOF_HANDOFF
# my-agent-v2 — Session Handoff

## 1. Authority

Repository at the pushed checkpoint is the source of truth. This handoff is only
a checkpoint index and recovery aid. Repository wins when it conflicts with this
file. Local-only state is known only through the Git checks performed during
generation or through explicitly identified external evidence.

## 2. Checkpoint

- Repository: \`my-agent-v2\`
- Branch: \`$branch\`
- Commit: \`$head\`
- Subject: \`$full_subject\`
- Upstream: \`$upstream\`
- Remote synchronization: \`CONFIRMED — ahead 0 / behind 0 after fetch\`
- Local working tree: \`clean\`
- Local-state evidence: \`checkpoint-handoff Git checks during generation\`

## 3. Canonical repository locators

- Implementation Plan: \`docs/IMPLEMENTATION_PLAN.md\`
- Active plan: \`$active_plan\`
- Relevant completed plan: \`$completed_plan\`
- Architecture: \`docs/ARCHITECTURE.md\`
- Relevant ADRs: $relevant_adrs

## 4. Accepted control-plane state

- Workstream/milestone: \`$plan_title\`
- Repository status: \`$plan_status\`
- Deterministic: \`$deterministic\`
- Controlled: \`$controlled\`
- Live: \`$live\`
- Independent audit verdict: \`$audit_verdict\`
- User acceptance: \`$user_acceptance\`

## 5. External or local-only evidence

None recorded outside repository. Add only separately verified evidence in the
receiving project or chat; do not treat this statement as proof that no such
evidence exists.

## 6. Open state

### Blocking

See active plan: \`$active_plan\`. No additional blocker is asserted by this
handoff.

### P2

See active plan: \`$active_plan\`. This handoff does not duplicate the P2 list.

## 7. Next outcome

$next_outcome

## 8. Do not reopen

$do_not_reopen_1
$do_not_reopen_2
- Do not use this handoff to override Architecture, ADRs, plans, source, tests, or
  accepted repository evidence.

## 9. Replacement status

- Supersedes: \`previous Project Source handoff, if any\`
- Keep in Project Sources: \`this handoff only\`
EOF_HANDOFF

  check_handoff "$handoff_path" >/dev/null
  absolute_path "$handoff_path"
}

case "${1:-}" in
  create)
    shift
    [[ $# -eq 0 ]] || { usage; exit 2; }
    create_handoff
    ;;
  check)
    shift
    [[ $# -eq 1 ]] || { usage; exit 2; }
    check_handoff "$1"
    ;;
  *)
    usage
    exit 2
    ;;
esac
