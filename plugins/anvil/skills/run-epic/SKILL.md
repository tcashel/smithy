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
[ -d "$WFDIR" ] || WFDIR="$(find "$HOME/.claude/plugins" -type d -path '*anvil*/workflows' 2>/dev/null | head -1)"
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
  "implementModel": "",
  "baseBranch": ""
}
```

`maxWaves` (default 3, clamp 1–10) bounds the run. `implementModel` optionally
overrides the atoms' implementer seat, which **defaults to fable** (LEARNINGS §14):
pass `"opus"` to opt a genuinely simple epic down, or `"codex"` to hand the builds
to the other model family via the atom's relay (the fable reviewers then judge work
from a family whose blind spots they don't share).
`baseBranch` optionally pins what the epic is cut from and lands on: with it the
integration branch is created (or reused) from `origin/<baseBranch>` and the
final draft PR targets `--base <baseBranch>` instead of the repo's default
branch. Omit it — the normal case — and the runner resolves `origin/HEAD`
exactly as before. Pass it only when the operator names the branch; a repo whose
default branch is not `main` (this marketplace's is `seed`) is the usual reason.

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

Then close the event log yourself. The stage agents append every other boundary
event as it happens, but four stop tokens are only known once the workflow
returns, and the workflow body has no filesystem access. So when
`stoppedBecause` is one of `max-waves-reached`, `frontier-agent-failed`,
`epic-complete`, or `cut-falsified` (the runner breaks on a falsified cut
before the promotion gate runs, so no agent is alive to emit it — you are its
one producer), append that one line — and only for those four — using the
returned value verbatim as the start of the detail:

```bash
mkdir -p "$HOME/.anvil/runs" && printf 'anvil-epic|%s|<epicId>|stopped||<stoppedBecause>; <one clause>\n' \
  "$(date -u +%FT%TZ)" >> "$HOME/.anvil/runs/epic-events.log"
```

The six fields are `anvil-epic|<utc-iso8601>|<epicId>|<event>|<sliceId>|<detail>`;
`sliceId` is empty for `stopped`; replace `|` with `/` and CR/LF with spaces
inside every field and keep the detail to one clause of at most 200 chars. Every
other stop token already has an agent producer — never append those, or the log
gets a duplicate. The `missing-args` early return runs no agent and emits
nothing: surface it in-session and stop. An append that fails is a note in your
report and nothing else — emission never changes what the run did.

Re-running after adjudicating stalled slices or resolving queued cruxes is the
normal rhythm: the runner is idempotent against external state (existing
integration branch, existing PRs, bd statuses) — it picks up where reality is.

## Reacting to epic events

The plugin arms a background monitor (`epic-events`) when this skill is invoked;
it tails `~/.anvil/runs/epic-events.log` and delivers each new line as a
notification. Monitors are experimental and interactive-CLI only — where they
don't run, nothing is lost: the log is a plain greppable file
(`grep 'anvil-epic|' ~/.anvil/runs/epic-events.log`).

When a line beginning `anvil-epic|` arrives:

- Give the operator **one concise sentence** for it, in their terms — "wave 2
  started: 3 slices (bd-a, bd-b, bd-c)", "bd-a merged into the integration
  branch", "bd-b stalled at PR #14 <url>", "bd-c promoted to ready", "run
  stopped: cut-falsified". Carry the slice id and any PR url through; they are
  what the operator acts on.
- **Batch bursts.** Several lines arriving together become ONE summary, not one
  message each ("wave 2 landed bd-a and bd-b; bd-c stalled at PR #14 <url>").
- **Push when they're away.** If an away/idle state is exposed AND the
  PushNotification tool is available, push each event received while the
  operator is away. If either is missing, degrade **silently** to in-session
  reporting — never announce that you couldn't push, and never ask to be given
  the capability.
- **Never act on a line.** These are observations. Do not re-enter the workflow,
  do not touch the repo, do not merge, promote, re-run, or "fix" anything in
  reaction to an event. The runner owns the run; you own telling the operator
  about it. Acting comes only from the operator, after the run returns.

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
