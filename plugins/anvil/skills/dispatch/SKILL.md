---
name: dispatch
description: Pull the beads ready-frontier (bd ready, honoring $BEADS_DIR) and run the headless execute -> quality gate -> draft PR -> review -> one auto-fix round loop over the chosen issue(s). Glue around the execute-review-fix workflow. Use after /anvil:adjudicate has locked specs into bd issues and you want them built. Stops at draft PRs for human adjudication; never merges.
---

# /anvil:dispatch — run the ready frontier as jobs

This is the **Run** surface. Adjudication is done, specs are locked into beads issues,
and now you want them **built without watching**. dispatch reads the ready frontier
from beads, picks the work, and hands it to the execution workflow. That workflow runs
**headless** and is a job, not a show: it implements, gates, opens a **draft PR**, reviews,
applies **one** auto-fix round, and **stops**. The human adjudicates the merge — anvil
**never merges**.

dispatch is deliberately thin. All the real machinery (the launch/result-event
discipline, the quality gate, the reviewer, the single fix round) lives in
`workflows/execute-review-fix.js`. This skill is glue: pick ready issues, invoke the
workflow with their ids, report where the draft PRs landed.

## Preconditions

- `$BEADS_DIR` is set and points at the operator-scoped, out-of-repo store
  (default `~/.anvil/beads`). Every `bd`/`br` call below MUST honor it — never
  let beads fall back to a per-repo `.beads/` file. If `$BEADS_DIR` is unset,
  stop and tell the operator to run `bootstrap/install-beads.sh` and export it.
- The target repo is clean and pushable, and `gh auth status` succeeds (the
  workflow opens and labels draft PRs via `gh`).
- `/anvil:adjudicate` has already turned locked specs into bd issues whose
  **body is the spec file** `~/.anvil/specs/<id>.md`. dispatch does not author
  specs; it only schedules issues that already have them.

## What you do in this skill

### 1. Read the ready frontier

Pull the issues beads considers actionable right now (dependencies satisfied,
not blocked, not already done). Always pass the operator-scoped store explicitly:

```sh
BEADS_DIR="$BEADS_DIR" bd ready
```

(Use `br ready` if that is the installed binary — match whatever
`bootstrap/install-beads.sh` selected.) This is the **work-list**. Do not invent
issue ids; only dispatch what `bd ready` returns. An empty frontier means there is
nothing to build — either everything is in flight, blocked, or done — say so and stop.

### 2. Choose the work

- If the operator named specific issue id(s), confirm each one actually appears
  in `bd ready` before scheduling it. A blocked or unknown id is a hard stop, not
  a guess.
- If the operator pointed at a **small epic**, take its **ready children** from
  the frontier — the leaf issues whose dependencies are already satisfied. beads'
  dependency ordering is doing the sequencing for you; dispatch just runs what is
  ready now. Re-running dispatch after a round picks up children that became ready.
- Default to a small batch. This loop opens real draft PRs against a real repo;
  keep the blast radius reviewable. Prefer a handful of ready leaves over draining
  an entire epic in one shot.

For each chosen issue, confirm its spec body exists at `~/.anvil/specs/<id>.md`.
Remember the portable Forge lesson: **the spec is the sole input** the implementing
agent sees — not this conversation, not the repo's CLAUDE.md. If the spec is thin,
the build will be confused; that is an adjudication problem, not something to paper
over here.

### 3. Run the execution loop (headless, via the Workflow tool)

First resolve the bundled workflow's absolute path (**`${CLAUDE_PLUGIN_ROOT}` is NOT expanded in skill text**):

```bash
WF="${ANVIL_PLUGIN_ROOT:+$ANVIL_PLUGIN_ROOT/workflows/execute-review-fix.js}"
[ -f "$WF" ] || WF="$(find "$HOME/.claude/plugins" -type f \
  -name execute-review-fix.js -path '*anvil/workflows*' 2>/dev/null | head -1)"
echo "$WF"
```

(`/anvil:setup` persists `ANVIL_PLUGIN_ROOT`; the `find` is the fallback.) Then invoke the Workflow tool with:

- **scriptPath:** the resolved absolute path (the value of `$WF`)
- **args:** the chosen ready issue id(s), space-separated (the workflow resolves
  each id's spec body from `~/.anvil/specs/<id>.md` and reads the frontier itself
  via `bd ready` under `$BEADS_DIR`).

For each issue the workflow runs the **atom**, and you do not babysit it:

1. **implement** — an agent builds the change in a worktree of the target repo,
   seeing only the spec body.
2. **quality gate** — build/lint/test must pass. Trust the workflow's terminal
   **result event**, not the raw exit code: a non-zero exit is rescued when the
   sidecar shows a valid terminal result, and a zero exit is force-failed when it
   does not. (This is the Forge PR #64 bug; the workflow handles it — don't
   second-guess it here.)
3. **DRAFT PR** — open a draft PR and **label it via `gh`** (e.g. an `anvil`
   label so these jobs are filterable). Draft, always — the human adjudicates the
   merge.
4. **anvil-reviewer** — the reviewer subagent reviews the diff and emits one
   ```anvil-review``` block (BLOCKER / HIGH / MEDIUM / LOW). Findings are
   published to the PR with hidden `<!-- anvil-finding id=... -->` markers so a
   re-run never duplicates a comment.
5. **one auto-fix round** — `autoFixRounds` defaults to **1**: the loop addresses
   review findings once, then **stops**. It does not grind.

Then it stops at the draft PR. No auto-merge, ever.

### 4. Report and update beads

When the workflow returns, for each issue report: the draft PR url, the gate
result, the reviewer's top findings by severity, and whether the fix round ran.
Move the beads issue to reflect reality (e.g. in-review / blocked-on-human) under
`BEADS_DIR="$BEADS_DIR"` — never edit a `.beads` file in the target repo.

Then hand back to the operator: **adjudicate the draft PR.** Merging is theirs.

## Hard rules

- **Never shell out to `forge`.** Use only `claude` (headless, via the workflow),
  `gh`, `bd`/`br`, `git`, and the Workflow tool.
- **Zero repo imposition.** All beads/spec state stays under `$BEADS_DIR` and
  `~/.anvil/specs`. Never commit a `.beads` file into the target repo, never edit
  the repo's CLAUDE.md or settings, never require a per-worktree committed file.
- **Don't watch.** The loop is headless. Kick it off, let it run, read the result.
- **Never merge.** The atom ends at a reviewed draft PR awaiting human adjudication.
