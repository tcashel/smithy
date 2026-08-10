---
name: critique
description: "Runs the multi-critic panel over a spec. Invoke when the user wants a spec reviewed, critiqued, or hardened before execution. Dispatches two independent critics plus the codex CLI as a third when it is installed, synthesizes their findings into a prioritized recommendations document, and surfaces conflicts plus open questions for the user to adjudicate. Entry point for the plan -> critique -> adjudicate flow."
---

# anvil:critique

You are the entry point for the **critic panel**. Your job is glue: take a spec, hand it to the `plan-critique-improve` workflow, and report back what the panel found. You do **not** critique the spec yourself, and you do **not** edit it. The workflow does the real work; you orchestrate and summarize.

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
- `args`: either shape — the workflow accepts both:
  - **a locator string** — the spec id (`anvil-0042`) or the absolute path to the spec body (`/Users/you/.anvil/specs/anvil-0042.md`).
  - **an object** — `{"specId": "anvil-0042", "specPath": "/Users/you/.anvil/specs/anvil-0042.md", "targetRepo": "/Users/you/repositories/drover"}`, plus an optional `"note"` for your own bookkeeping (the workflow ignores it). `specPath` wins over `specId` when both are given. **Prefer this shape when you know the target repo:** `targetRepo` is the directory the codex leg runs `codex exec` from, and without it that leg has to infer the repo from the spec body.
  - **epic plan maps**: add `"mode": "decomposition"` to the object when the spec under critique is an epic PLAN MAP (`kind: epic` issues — see the plan skill's `epic.md`). The same panel runs, but findings target the CUT: slice boundaries, seam contracts, wave order (risk-first?), slice sizing, and whether every ASSUMES ledger entry is checkable against merged reality. Omit the flag for ordinary specs — never guess it.

The workflow runs the panel in parallel:

- **Critics A and B** — the `anvil-critic` subagent twice, on different models and different angles (A: correctness and contracts; B: completeness and self-containment) so their blind spots don't overlap.
- **Critic C, the codex leg** — an agent that hands the same critique prompt to the `codex` CLI and relays what it found. Different model *family*, so it fails differently than A and B do. It is **optional**: no `codex` on `PATH`, or a failed invocation, and the leg reports itself unavailable and the panel is the two critics above. It never fabricates a third opinion to fill the slot.

Then a synthesizer step merges the critiques it got.

## What the workflow returns

The synthesizer classifies every finding across the critiques:

- **Corroborated** — two or more critics raised it. High confidence; almost certainly real. Corroboration **across model families** (codex agreeing with A or B) is the strongest signal the panel produces — two instances of one family can share a blind spot, and can share a hallucination.
- **Single-critic-only** — one critic raised it. Medium confidence; a catch the others missed, or a possible false positive. A codex-only finding sits here too, and is worth reading closely: catching what the other family cannot see is the reason the leg exists.
- **Conflicting** — the critics disagree (one says a section is fine, another says it's broken). Cannot be auto-resolved.

The Workflow tool returns a **structured `recommendations` object** (the synthesizer's schema-validated output) with:

- `summary` — total findings, how many corroborated, overall launch-readiness,
- `edits` — priority-ordered concrete spec edits, each with `classification`, `severity` (BLOCKER / HIGH / MEDIUM / LOW), `currentText`, `replacementText`, `rationale`, `applicable`,
- `openQuestions` — findings whose right answer depends on product intent, not spec quality,
- `conflicts` — findings the critics disagree on (`criticCPosition` is present only when the codex leg took a side),
- `triage` — the full classification table (`criticC` filled only when the codex leg ran), plus a `confidenceNote`.

Alongside `recommendations`, the workflow returns `codexLeg`: `"ran"` or `"unavailable"`.

(The synthesizer also emits an ```` ```anvil-spec-recommendations ```` fenced block in its own transcript, but what YOU receive from the Workflow tool is the structured object — render from that.)

## What you report

Render the object as a single ```` ```anvil-spec-recommendations ```` fenced block with these sections, in order: **Summary**, **Recommended Edits**, **Open Questions**, **Conflicts**, **Findings Triage** (table), **Confidence Note**. Show it to the user, then add a short plain-language summary on top: how many corroborated findings, the highest severity present, whether any conflicts or open questions exist, and **whether the codex leg ran** — say so plainly when it didn't, because the panel was two same-family critics and the corroboration is weaker than it looks.

Do **not** apply edits yourself. Recommendations are proposals; `/anvil:adjudicate` is the only surface that writes the spec.

## Persist the recommendations (so adjudicate can pick them up)

The workflow does **not** modify the spec — `/anvil:adjudicate` is the sole write-back surface. So save the rendered block where adjudicate looks for it:

```
~/.anvil/specs/<id>.recommendations.md
```

Write the same `anvil-spec-recommendations` block you showed the user (derive `<id>` from the spec id, or from the spec filename if you were given a path). Without this file, `/anvil:adjudicate` has nothing to resolve.

## Handing off

Conflicts and Open Questions are the unresolved residue of the panel — they need a human or a deliberate call, not another critic pass. Point the user at **/anvil:adjudicate** to resolve them, apply the accepted edits to `~/.anvil/specs/<id>.md`, and lock the spec for execution.

If there are no conflicts and no open questions, say so plainly — the spec may be ready to adjudicate-and-lock immediately.
