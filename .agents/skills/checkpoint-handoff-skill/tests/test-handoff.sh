#!/usr/bin/env bash
set -euo pipefail

skill_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$skill_root/scripts/handoff.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$*"; }

setup_repo() {
  local name="$1"
  local bare="$work/${name}.git"
  local repo="$work/$name/my-agent-v2"
  mkdir -p "$(dirname "$repo")"
  git init --bare "$bare" >/dev/null
  git clone "$bare" "$repo" >/dev/null 2>&1
  git -C "$repo" config user.email test@example.com
  git -C "$repo" config user.name Test
  mkdir -p "$repo/docs/plans/active" "$repo/docs/plans/completed" "$repo/docs/decisions"
  cat >"$repo/docs/IMPLEMENTATION_PLAN.md" <<'DOC'
# Plan
**Active execution plan:** `docs/plans/active/0002-tool-runtime.md`
DOC
  cat >"$repo/docs/plans/active/0002-tool-runtime.md" <<'DOC'
# Active Plan 0002: Milestone 3 — Tool Runtime
**Status:** ACTIVE — implementation completed; pending independent closure audit
**M3 deterministic:** PASS
**M3 controlled side effect:** PASS
**M3 Gemini live:** NOT RUN
**Architecture authority:** `docs/ARCHITECTURE.md`; ADR 0005, 0008, 0010
DOC
  cat >"$repo/docs/plans/completed/0001-core-runtime.md" <<'DOC'
# Completed Plan 0001
**Status:** CLOSED — M2 PASS
DOC
  : >"$repo/docs/ARCHITECTURE.md"
  : >"$repo/docs/decisions/README.md"
  git -C "$repo" add .
  git -C "$repo" commit -m initial >/dev/null
  git -C "$repo" push -u origin HEAD:master >/dev/null 2>&1
  git -C "$repo" branch -M master
  git -C "$repo" branch --set-upstream-to=origin/master master >/dev/null
  printf '%s\n' "$repo"
}

repo="$(setup_repo main)"

path="$(cd "$repo" && "$script" create)"
[[ -f "$path" ]] || fail 'zero-argument creation did not produce a file'
grep -Fq 'Deterministic: `PASS`' "$path" || fail 'deterministic status missing'
grep -Fq 'Next outcome' "$path" || fail 'next outcome section missing'
grep -Fq 'Not yet selected by project control.' "$path" || fail 'next-outcome fallback missing'
git -C "$repo" check-ignore -q '.agent-handoffs/.probe' || fail 'handoff directory not ignored'
pass 'successful zero-argument creation'

path2="$(cd "$repo" && "$script" create)"
[[ "$path2" == "$path" ]] || fail 'same-checkpoint creation did not resume'
pass 'same-checkpoint resumability'

cp "$path" "$work/valid-handoff.md"
printf '\nchange\n' >>"$repo/docs/ARCHITECTURE.md"
if (cd "$repo" && "$script" create >/dev/null 2>&1); then fail 'dirty tree was accepted'; fi
git -C "$repo" restore docs/ARCHITECTURE.md
pass 'dirty working-tree rejection'

printf 'ahead\n' >"$repo/ahead.txt"
git -C "$repo" add ahead.txt
git -C "$repo" commit -m ahead >/dev/null
if (cd "$repo" && "$script" create >/dev/null 2>&1); then fail 'unpushed commit was accepted'; fi
git -C "$repo" reset --hard origin/master >/dev/null
pass 'unpushed/ahead rejection'

other="$work/other"
git clone "$(git -C "$repo" remote get-url origin)" "$other" >/dev/null 2>&1
git -C "$other" config user.email other@example.com
git -C "$other" config user.name Other
printf 'remote\n' >"$other/remote.txt"
git -C "$other" add remote.txt
git -C "$other" commit -m remote >/dev/null
git -C "$other" push origin HEAD:master >/dev/null 2>&1
if (cd "$repo" && "$script" create >/dev/null 2>&1); then fail 'behind checkpoint was accepted'; fi
git -C "$repo" pull --ff-only >/dev/null 2>&1
pass 'behind checkpoint rejection'

new_path="$(cd "$repo" && "$script" create)"
sed -i 's/- Commit: `[^`]*`/- Commit: `0000000000000000000000000000000000000000`/' "$new_path"
if (cd "$repo" && "$script" create >/dev/null 2>&1); then fail 'mismatched existing handoff was accepted'; fi
rm -f "$new_path"
pass 'mismatched metadata rejection'

repo2="$(setup_repo missing)"
cat >"$repo2/docs/plans/active/0002-tool-runtime.md" <<'DOC'
# Active Plan Without Status Metadata
DOC
git -C "$repo2" add docs/plans/active/0002-tool-runtime.md
git -C "$repo2" commit -m metadata-missing >/dev/null
git -C "$repo2" push >/dev/null 2>&1
missing_path="$(cd "$repo2" && "$script" create)"
grep -Fq 'Deterministic: `NOT RECORDED`' "$missing_path" || fail 'missing status was guessed'
grep -Fq 'Not yet selected by project control.' "$missing_path" || fail 'missing next outcome fallback absent'
pass 'missing status and next-outcome fallbacks'

bad="$work/bad.md"
cp "$missing_path" "$bad"
sed -i '/## 7. Next outcome/d' "$bad"
if (cd "$repo2" && "$script" check "$bad" >/dev/null 2>&1); then fail 'missing heading was accepted'; fi
cp "$missing_path" "$bad"
printf '\nTODO\n' >>"$bad"
if (cd "$repo2" && "$script" check "$bad" >/dev/null 2>&1); then fail 'placeholder was accepted'; fi
pass 'structural validation failures'

printf 'All checkpoint-handoff tests passed.\n'
