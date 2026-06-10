#!/usr/bin/env bash
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
check "plugin.json" check_json plugins/anvil/.claude-plugin/plugin.json

# 2. Workflow JS syntax
js_files=(plugins/anvil/workflows/*.js)
if [[ ${#js_files[@]} -eq 0 ]]; then
  echo "FAIL: workflows/*.js (no files found)"
  failures=$((failures + 1))
else
  for f in "${js_files[@]}"; do
    check "node --check $f" node --check "$f"
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

if [[ $failures -gt 0 ]]; then
  exit 1
fi
