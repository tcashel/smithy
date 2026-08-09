---
name: dispatch
description: Pull the beads ready-frontier (bd ready, honoring $BEADS_DIR) and run the unattended implement -> quality gate -> draft PR -> review -> one auto-fix round loop over the chosen issue(s). Glue around the execute-review-fix workflow. Use after /anvil:adjudicate has locked specs into bd issues and you want them built. Stops at draft PRs for human adjudication; never merges.
---

# /anvil:dispatch — run the ready frontier as jobs

This is the **Run** surface. Adjudication is done, specs are locked into beads issues,
and now you want them **built without watching**. dispatch reads the ready frontier
from beads, picks the work, and hands it to the execution workflow. That workflow is a
job, not a show: it implements, gates, opens a **draft PR**, reviews, applies **one**
auto-fix round, and **stops**. The human adjudicates the merge — anvil **never merges**.

dispatch is deliberately thin. All the real machinery (the implementing subagent, the
quality gate, the two reviewers, the single fix round) lives in
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

### 3. Run the execution loop (via the Workflow tool)

The **implement** stage is a workflow subagent, not a spawned CLI. It is sanctioned by
this session and inherits the operator's permission mode, so there is nothing to
authorize and no flag to pass: if the session's mode calls for a permission prompt,
the operator sees one, and that is intended rather than something to work around. (It
also means a resumed run replays a finished build instead of redoing it.)

First resolve the bundled workflow's absolute path (**`${CLAUDE_PLUGIN_ROOT}` is NOT expanded in skill text**):

```bash
WF="${ANVIL_PLUGIN_ROOT:+$ANVIL_PLUGIN_ROOT/workflows/execute-review-fix.js}"
[ -f "$WF" ] || WF="$(find "$HOME/.claude/plugins" -type f \
  -name execute-review-fix.js -path '*anvil/workflows*' 2>/dev/null | head -1)"
echo "$WF"
```

(`/anvil:setup` persists `ANVIL_PLUGIN_ROOT`; the `find` is the fallback.) Then invoke the Workflow tool with:

- **scriptPath:** the resolved absolute path (the value of `$WF`)
- **args:** the chosen ready issue id(s), space- or comma-separated — `bd-a1b2 bd-c3d4`.
  (An array, or `{"ids": [...]}`, works too; there is nothing else to pass.)

  The workflow resolves each id's spec body from `~/.anvil/specs/<id>.md`; it does
  NOT read the frontier itself — reading `bd ready` and passing only ready ids is
  THIS skill's job (step 1).

For each issue the workflow runs the **atom**, and you do not babysit it:

1. **implement** — a subagent builds the change in a worktree of the target repo,
   working from the spec body. This is the long stage; a build running for tens of
   minutes is normal and not a sign of trouble.
2. **quality gate** — build/lint/test are run again over the finished worktree. A
   failure does not abort the atom: the draft PR still opens so CI and the human can
   see it.
3. **DRAFT PR** — open a draft PR and **label it via `gh`** (e.g. an `anvil`
   label so these jobs are filterable). Draft, always — the human adjudicates the
   merge.
4. **review, by two independent reviewers** — the `anvil-reviewer` subagent reads the
   diff against the spec, and a second agent relays the same review to the `codex`
   CLI when it is installed (a different model family; absent codex, the leg reports
   itself unavailable rather than inventing findings). Both emit BLOCKER / HIGH /
   MEDIUM / LOW findings, tagged by source and merged into one verdict — the more
   severe of the two wins. Findings are published to the PR with hidden
   `<!-- anvil-finding id=... -->` markers so a re-run never duplicates a comment.
5. **one auto-fix round** — `autoFixRounds` defaults to **1**: the loop addresses the
   merged BLOCKER/HIGH findings once, then **stops**. It does not grind.

Then it stops at the draft PR. No auto-merge, ever.

### 4. Report and update beads

When the workflow returns, for each issue report: the draft PR url, the gate
result, the top findings by severity **and by reviewer** (say plainly when the codex
leg did not run — the review was one model family, and weaker for it), and whether
the fix round ran.
Move the beads issue to reflect reality (e.g. in-review / blocked-on-human) under
`BEADS_DIR="$BEADS_DIR"` — never edit a `.beads` file in the target repo.

Then hand back to the operator: **adjudicate the draft PR.** Merging is theirs.

### 5. Clean up the run dir — but only after the PR merges

Each atom leaves a run dir at `~/.anvil/runs/<id>/`, holding the disposable worktree
and whatever scratch files the stages wrote. Once the operator has merged (or closed)
the draft PR, that state has no reader left — retire it:

```sh
git worktree remove "$HOME/.anvil/runs/<id>/worktree"   # --force if it has junk in it
git -C <repoRoot> worktree prune                        # drop the stale registration
rm -rf "$HOME/.anvil/runs/<id>"                         # prompt + sidecar + dir
```

Order matters: removing the directory without `git worktree remove` leaves the
target repo carrying a dangling worktree registration, and `prune` is what clears
it. That registration is the one trace anvil can leave in a repo it promised not
to touch, so closing the loop here is part of zero repo imposition.

**Do not clean up a failed implement.** Its worktree is deliberately kept: it holds
whatever the builder did manage to commit, and a resumed run picks it back up.
Delete it and a resumable run becomes a rerun. Sweep only ids whose PR is merged or
closed, and leave anything still in flight alone.

## Hard rules

- **Never shell out to `forge`.** Use only `gh`, `bd`/`br`, `git`, `codex` (the second
  reviewer), and the Workflow tool.
- **No spawned builders.** Every agent in the atom is a workflow subagent that the
  session sanctions. If you find yourself reaching for `claude --print`, stop: that
  is the design this replaced.
- **Zero repo imposition.** All beads/spec state stays under `$BEADS_DIR` and
  `~/.anvil/specs`. Never commit a `.beads` file into the target repo, never edit
  the repo's CLAUDE.md or settings, never require a per-worktree committed file.
- **Don't watch.** The loop is unattended. Kick it off, let it run, read the result.
- **Never merge.** The atom ends at a reviewed draft PR awaiting human adjudication.
