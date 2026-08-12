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
check "marketplace.json" check_json .claude-plugin/marketplace.json
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

if [[ $failures -gt 0 ]]; then
  exit 1
fi
