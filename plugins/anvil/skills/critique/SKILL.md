---
name: critique
description: "Runs the two-critic panel over a spec. Invoke when the user wants a spec reviewed, critiqued, or hardened before execution. Dispatches two independent critics, synthesizes their findings into a prioritized recommendations document, and surfaces conflicts plus open questions for the user to adjudicate. Entry point for the plan -> critique -> adjudicate flow."
---

# anvil:critique

You are the entry point for the **two-critic panel**. Your job is glue: take a spec, hand it to the `plan-critique-improve` workflow, and report back what the panel found. You do **not** critique the spec yourself, and you do **not** edit it. The workflow does the real work; you orchestrate and summarize.

## What you need

A spec to critique. Resolve it to a spec id and its body path:

- If the user gives a beads id, the spec body is `~/.anvil/specs/<id>.md` (honor `$BEADS_DIR` for the issue lookup; specs live under `~/.anvil/specs/` regardless).
- If the user gives a path, use it directly.
- If neither is given, ask. Don't guess.

The spec is the **sole input** the implementing agent will ever see — not this conversation, not the repo's CLAUDE.md. A vague spec produces a confused agent downstream. That is exactly why we critique it now.

## What you do

First resolve the bundled workflow's absolute path. **`${CLAUDE_PLUGIN_ROOT}` is NOT expanded in skill text**, so discover it at runtime:

```bash
WF="${ANVIL_PLUGIN_ROOT:+$ANVIL_PLUGIN_ROOT/workflows/plan-critique-improve.js}"
[ -f "$WF" ] || WF="$(find "$HOME/.claude/plugins" -type f \
  -name plan-critique-improve.js -path '*anvil/workflows*' 2>/dev/null | head -1)"
echo "$WF"
```

(`/anvil:setup` persists `ANVIL_PLUGIN_ROOT`; the `find` is the fallback. If both miss, ask the operator for the plugin path.) Then invoke the Workflow tool with:

- `scriptPath`: the resolved absolute path (the value of `$WF`)
- `args`: the spec id and/or the resolved spec body path.

The workflow runs two independent critics (the `anvil-critic` subagent, twice, with differing framing so their blind spots don't overlap), then runs a synthesizer step that merges both critiques.

## What the workflow returns

The synthesizer classifies every finding across the two critiques:

- **Corroborated** — both critics raised it. High confidence; almost certainly real.
- **Single-critic-only** — only one critic raised it. Medium confidence; one model's catch the other missed, or a possible false positive.
- **Conflicting** — the critics disagree (one says a section is fine, the other says it's broken). Cannot be auto-resolved.

The output is a single fenced ```anvil-spec-recommendations``` block containing:

- a **Summary** (total findings, how many corroborated, overall launch-readiness),
- priority-ordered **Recommended Edits** — each with concrete replacement spec text, a classification, and a severity (BLOCKER / HIGH / MEDIUM / LOW),
- an **Open Questions** list — findings whose right answer depends on product intent, not spec quality,
- a **Findings Triage** table classifying every finding.

## What you report

Surface the recommendations block to the user as-is, then add a short plain-language summary on top: how many corroborated findings, the highest severity present, and whether any conflicts or open questions exist.

Do **not** apply edits yourself. Recommendations are proposals; `/anvil:adjudicate` is the only surface that writes the spec.

## Persist the recommendations (so adjudicate can pick them up)

The workflow does **not** modify the spec — `/anvil:adjudicate` is the sole write-back surface. So save the synthesizer's output where adjudicate looks for it:

```
~/.anvil/specs/<id>.recommendations.md
```

Write the `anvil-spec-recommendations` block there (derive `<id>` from the spec id, or from the spec filename if you were given a path). Without this file, `/anvil:adjudicate` has nothing to resolve.

## Handing off

Conflicts and Open Questions are the unresolved residue of the panel — they need a human or a deliberate call, not another critic pass. Point the user at **/anvil:adjudicate** to resolve them, apply the accepted edits to `~/.anvil/specs/<id>.md`, and lock the spec for execution.

If there are no conflicts and no open questions, say so plainly — the spec may be ready to adjudicate-and-lock immediately.
