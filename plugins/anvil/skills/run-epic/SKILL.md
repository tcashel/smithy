---
name: run-epic
description: "Run an anvil epic in waves: for each wave, dispatch the epic's ready children through the execution atom against an integration branch, auto-merge clean slices (quality gate passed, no BLOCKER/HIGH from either reviewer) into that branch, replan the next wave's stubs against merged reality, and stop fail-closed. Ends with ONE draft PR from the integration branch to the default branch — the operator adjudicates that merge. Use after /anvil:plan has locked an epic (kind: epic) and its wave-1 children are ready."
---

# /anvil:run-epic — waves over an epic, one adjudication at the end

This is the long-horizon Run surface. `/anvil:dispatch` runs individual ready
issues and stops at per-slice draft PRs; this skill runs a whole **epic** —
waves of slices against an **integration branch** — and batches your
adjudication at the epic boundary instead of every slice.

The authority boundary (LEARNINGS §4 as amended): a **clean** slice — quality
gate passed, review ran, no BLOCKER/HIGH from either reviewer — auto-merges
into the integration branch `anvil/epic-<id>`. Anything less stalls as an open
draft PR (bd: blocked-on-human) and the wave continues around it. The
integration branch → default branch merge is **always the operator's**, via the
single draft PR the run ends with. anvil never merges to the default branch.

## Preconditions

- `$BEADS_DIR` set (default `~/.anvil/beads`); the target repo clean and
  pushable; `gh auth status` good.
- The epic exists: a bd issue whose description starts `kind: epic`, whose spec
  is a plan map at `~/.anvil/specs/<epic-id>.md`, whose children carry dep
  edges, and whose wave-1 children are `ready` (all from `/anvil:plan`; the cut
  ideally hardened by `/anvil:critique` in decomposition mode and adjudicated).
- Downstream children are STUBS blocked by `- [ ] ASSUMES:` items — that is
  their correct state; the run's replan checkpoint promotes them with evidence.

## Invoke

Resolve BOTH bundled workflow paths (**`${CLAUDE_PLUGIN_ROOT}` is NOT expanded
in skill text**):

```bash
WFDIR="${ANVIL_PLUGIN_ROOT:+$ANVIL_PLUGIN_ROOT/workflows}"
[ -d "$WFDIR" ] || WFDIR="$(find "$HOME/.claude/plugins" -type d -path '*anvil/workflows' 2>/dev/null | head -1)"
ls "$WFDIR/run-epic.js" "$WFDIR/execute-review-fix.js" "$WFDIR/plan-critique-improve.js"
```

Then invoke the Workflow tool with **scriptPath** `$WFDIR/run-epic.js` and
**args** (an object — the runner has no filesystem access, so the script paths
ride along):

```json
{
  "epicId": "<epic bd id>",
  "atomScriptPath": "<$WFDIR>/execute-review-fix.js",
  "pciScriptPath": "<$WFDIR>/plan-critique-improve.js",
  "maxWaves": 3,
  "implementModel": ""
}
```

`maxWaves` (default 3, clamp 1–10) bounds the run. `implementModel` optionally
overrides the atoms' pinned implementer (e.g. `"fable"` for a hard epic).

Then **don't watch**. The runner is a job: frontier → atoms → merge → replan,
per wave, then one epic PR.

## What the runner does with your authority

- **Merges into `anvil/epic-<id>` only**, via `gh pr ready` + `gh pr merge
  --squash`, and only for clean slices. It refuses to merge a PR whose base is
  anything else, and it never retries a failed merge with different flags.
- **Promotes stubs only on evidence**: every `ASSUMES` item verified against
  the integration branch's actual diffs, the promoted spec run through the
  critique panel, panel edits applied, and the issue flipped ready ONLY at
  zero cruxes. Cruxes queue into the epic map's Open Questions for you; the
  stub stays blocked. Every self-made call lands in the spec's
  `## Promotion journal`.
- **Stops fail-closed** and reports `stoppedBecause`:
  - `epic-complete` — all children merged; the draft epic PR is open.
  - `max-waves-reached` — ran out of budget; state is consistent, re-run to continue.
  - `wave-merged-zero-slices` — nothing clean landed; the frontier can't advance.
  - `no-ready-children` — epic not done but nothing ready (stalled slices and/or
    held stubs need you).
  - `cut-falsified` — most stubs' assumptions broke: the epic's cut is wrong.
    Recut with `/anvil:plan` + `/anvil:critique` (decomposition mode); don't re-run as-is.

## Report

When the workflow returns, give the operator: waves run, slices merged into the
integration branch, stalled slices (draft PR urls + why), stubs promoted vs
held (and any cruxes queued to the epic map), `stoppedBecause`, and — when the
epic completed — the **draft epic PR url. The merge is theirs.** Reflect
reality into beads under `BEADS_DIR="$BEADS_DIR"`; never edit a `.beads` file
in the target repo.

Re-running after adjudicating stalled slices or resolving queued cruxes is the
normal rhythm: the runner is idempotent against external state (existing
integration branch, existing PRs, bd statuses) — it picks up where reality is.

## Hard rules

- **Never merge to the default branch.** The epic ends at ONE draft PR; the
  human adjudicates it. No exception, including "it's obviously fine".
- **Never force a stub ready.** Promotion runs on verified evidence + a clean
  panel; cruxes go to the operator, not to a coin flip.
- **Never shell out to `forge`.** Only `gh`, `bd`/`br`, `git`, `codex` (inside
  the atoms/panel), and the Workflow tool.
- **Zero repo imposition.** The integration branch and PRs are the work
  product; no committed state lands in the target repo beyond the work itself.
- **Don't watch.** Kick it off, read the report, adjudicate at the boundary.
