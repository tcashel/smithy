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

# The Workflow runtime forbids these calls (they break resume). Comment lines
# (// or *) may mention them; code must not contain them.
check_no_forbidden_tokens() {
  local hits
  hits=$(grep -nE 'Date\.now\(|new Date\(|Math\.random\(' "$1" \
    | grep -vE '^[0-9]+:[[:space:]]*(//|\*)' || true)
  if [[ -n "$hits" ]]; then
    echo "$hits"
    return 1
  fi
}

# The watch-epic tick template is load-bearing generated shell; extract it by
# its documented markers and syntax-check it so drift fails here, not at 3am.
check_tick_template() {
  local skill=$1 tmp
  tmp=$(mktemp)
  sed -n '/^<!-- ANVIL-TICK-TEMPLATE-BEGIN -->$/,/^<!-- ANVIL-TICK-TEMPLATE-END -->$/p' "$skill" \
    | sed '1,2d' | sed '$d' | sed '$d' > "$tmp"
  local ok=0
  if [[ ! -s "$tmp" ]]; then
    echo "  (template markers missing or empty extraction)"
    ok=1
  elif ! sh -n "$tmp"; then
    ok=1
  fi
  rm -f "$tmp"
  return "$ok"
}

# 1. JSON manifests
check "marketplace.json" check_json .claude-plugin/marketplace.json
check "plugin.json" check_json plugins/anvil/.claude-plugin/plugin.json
check "monitors.json" check_json plugins/anvil/monitors/monitors.json

# 2. Workflow JS: syntax, and no runtime-forbidden calls
js_files=(plugins/anvil/workflows/*.js)
if [[ ${#js_files[@]} -eq 0 ]]; then
  echo "FAIL: workflows/*.js (no files found)"
  failures=$((failures + 1))
else
  for f in "${js_files[@]}"; do
    check "node --check $f" node --check "$f"
    check "no forbidden runtime tokens in $f" check_no_forbidden_tokens "$f"
  done
fi

# 3. Skill frontmatter
skill_files=(plugins/anvil/skills/*/SKILL.md)
if [[ ${#skill_files[@]} -eq 0 ]]; then
  echo "FAIL: skills/*/SKILL.md (no files found)"
  failures=$((failures + 1))
else
  for f in "${skill_files[@]}"; do
    check "frontmatter $f" check_frontmatter "$f"
  done
fi

# 4. Agent frontmatter
agent_files=(plugins/anvil/agents/*.md)
if [[ ${#agent_files[@]} -eq 0 ]]; then
  echo "FAIL: agents/*.md (no files found)"
  failures=$((failures + 1))
else
  for f in "${agent_files[@]}"; do
    check "frontmatter $f" check_frontmatter "$f"
  done
fi

# 5. The watch-epic tick template parses as sh
check "watch-epic tick template (sh -n)" check_tick_template plugins/anvil/skills/watch-epic/SKILL.md

if [[ $failures -gt 0 ]]; then
  exit 1
fi
