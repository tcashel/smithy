#!/usr/bin/env bash
# Repo health checks, CI-runnable (no Claude Code CLI on runners — the deeper
# `claude plugin validate .` stays a local-only check; see CLAUDE.md).
set -euo pipefail
shopt -s nullglob

cd "$(dirname "$0")/.."

failures=0

check() {
  local label=$1; shift
  if "$@"; then
    echo "PASS: $label"
  else
    echo "FAIL: $label"
    failures=$((failures + 1))
  fi
}

check_json() {
  node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$1"
}

check_frontmatter() {
  awk '
    NR==1 { if ($0 != "---") { exit 1 } next }
    /^---$/        { found_close=1; exit }
    /^name:/       { has_name=1 }
    /^description:/ { has_desc=1 }
    END { exit !(found_close && has_name && has_desc) }
  ' "$1"
}

# 1. JSON manifests
check "Claude marketplace.json" check_json .claude-plugin/marketplace.json
check "Codex marketplace.json" check_json .agents/plugins/marketplace.json
check "Claude plugin.json" check_json plugins/anvil/.claude-plugin/plugin.json
check "Codex plugin.json" check_json plugins/anvil/.codex-plugin/plugin.json

# 2. Skill frontmatter
skill_files=(plugins/anvil/skills/*/SKILL.md)
if [[ ${#skill_files[@]} -eq 0 ]]; then
  echo "FAIL: skills/*/SKILL.md (no files found)"
  failures=$((failures + 1))
else
  for f in "${skill_files[@]}"; do
    check "frontmatter $f" check_frontmatter "$f"
  done
fi

# 3. Agent frontmatter
agent_files=(plugins/anvil/agents/*.md)
if [[ ${#agent_files[@]} -eq 0 ]]; then
  echo "FAIL: agents/*.md (no files found)"
  failures=$((failures + 1))
else
  for f in "${agent_files[@]}"; do
    check "frontmatter $f" check_frontmatter "$f"
  done
fi

# 4. Bootstrap syntax
check "bootstrap/install-beads.sh (bash -n)" bash -n plugins/anvil/bootstrap/install-beads.sh

# 5. The superseded Claude-Workflow execution path must stay deleted.
legacy_paths=(
  plugins/anvil/workflows/execute-review-fix.js
  plugins/anvil/workflows/run-epic.js
  plugins/anvil/workflows/plan-critique-improve.js
  plugins/anvil/skills/watch-epic/SKILL.md
  plugins/anvil/monitors/monitors.json
  plugins/anvil/agents/reviewer.md
)
for f in "${legacy_paths[@]}"; do
  if [[ -e "$f" ]]; then
    echo "FAIL: legacy path returned: $f"
    failures=$((failures + 1))
  else
    echo "PASS: legacy path absent: $f"
  fi
done

# 6. The positive handoff contract. Absence checks alone would still pass on a
#    skill that quietly stopped calling Forged, so assert the CLI verbs too.
#    A bare substring search gets this wrong two ways, both of which are live in
#    these files: prose names the verb ("disconnect as soon as `forged run
#    submit` returns"), and a later controls cheatsheet repeats it at the start
#    of a line. Either would keep passing after the real call was deleted. So
#    require one FENCED BLOCK containing an executable `start` line followed by
#    an executable `submit` line — the freeze-then-detach handoff itself, in
#    order. Prose fails it, and a cheatsheet block with no `start` fails it.
check_handoff_block() {
  awk -v start="$2" -v submit="$3" '
    function invokes(line, verb,   tail) {
      if (index(line, verb) != 1) { return 0 }
      tail = substr(line, length(verb) + 1, 1)
      return (tail == "" || tail == " ")
    }
    /^```/                       { fenced = !fenced; froze = 0; next }
    !fenced                      { next }
    invokes($0, start)           { froze = 1; next }
    froze && invokes($0, submit) { ok = 1 }
    END                          { exit !ok }
  ' "$1"
}

dispatch_skill=plugins/anvil/skills/dispatch/SKILL.md
epic_skill=plugins/anvil/skills/run-epic/SKILL.md
check "dispatch hands off: forged run start then submit" \
  check_handoff_block "$dispatch_skill" "forged run start" "forged run submit"
check "run-epic hands off: forged epic start then submit" \
  check_handoff_block "$epic_skill" "forged epic start" "forged epic submit"

# 7. Both plugin manifests ship the same advertised version. Installed plugins
#    are version-keyed, so a half-bumped pair serves stale content forever.
#    Bumping Anvil means editing this constant alongside both plugin.json files.
expected_version=0.3.0

check_version() {
  local actual
  actual=$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version))" "$1") || return 1
  [[ $actual == "$2" ]]
}

check "Claude plugin.json version == $expected_version" \
  check_version plugins/anvil/.claude-plugin/plugin.json "$expected_version"
check "Codex plugin.json version == $expected_version" \
  check_version plugins/anvil/.codex-plugin/plugin.json "$expected_version"

if [[ $failures -gt 0 ]]; then
  exit 1
fi
