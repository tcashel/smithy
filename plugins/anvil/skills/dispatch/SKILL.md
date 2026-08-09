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

### 3. Confirm consent for the permissionless headless builder

The workflow's **implement** stage spawns a builder of its own:

```
claude --print --dangerously-skip-permissions --model … < prompt
```

That flag is what lets an unattended builder edit files, run the gate, and commit —
nobody is watching to answer a prompt. It is also exactly the spawn a safety
classifier refuses when it cannot see that a human asked for it, and **a bare
"dispatch" from the operator is not that approval.** Get it explicitly, before you
invoke the workflow:

- **Ask plainly.** "The builder runs headless with `--dangerously-skip-permissions`
  in a disposable worktree outside the repo — approve?" Do not launch until the
  operator has answered in this session, or you can cite a standing approval.
- **A recorded standing approval counts**, and once per operator is enough — cite
  where it came from rather than re-asking every run (e.g. *"Tripp approved
  permissionless headless builders on 2026-08-08"*). Citing a real approval is
  honest; inventing one is not.
- **If the operator declines**, do not quietly reach for another builder. Offer
  `builderPermissions: "inherit"` (step 4) and be straight about the tradeoff: a
  headless run under default permissions cannot answer a prompt, so it fails on the
  first gated action unless the environment already authorizes it.

**The failure mode, and the only correct recovery.** Launch without that consent and
the classifier blocks the spawn: the implement stage fails after `resolve` has
already cut a worktree and spent a turn. When that happens:

1. Get the explicit approval you skipped.
2. **Resume the SAME run.** Invoke the Workflow tool again with `resumeFromRunId`
   set to the blocked run's id. Stages that already completed replay from cache;
   only the blocked implement stage actually re-runs.
3. Do **not** start a fresh run — it redoes `resolve` and can strand a second
   worktree. Do **not** substitute a different builder mechanism: the recipe in the
   workflow is load-bearing (it trusts the terminal result event, not the exit
   code — LEARNINGS §2), and swapping it out to dodge a consent prompt trades a
   one-question fix for a silent-failure class.

### 4. Run the execution loop (headless, via the Workflow tool)

First resolve the bundled workflow's absolute path (**`${CLAUDE_PLUGIN_ROOT}` is NOT expanded in skill text**):

```bash
WF="${ANVIL_PLUGIN_ROOT:+$ANVIL_PLUGIN_ROOT/workflows/execute-review-fix.js}"
[ -f "$WF" ] || WF="$(find "$HOME/.claude/plugins" -type f \
  -name execute-review-fix.js -path '*anvil/workflows*' 2>/dev/null | head -1)"
echo "$WF"
```

(`/anvil:setup` persists `ANVIL_PLUGIN_ROOT`; the `find` is the fallback.) Then invoke the Workflow tool with:

- **scriptPath:** the resolved absolute path (the value of `$WF`)
- **args:** either shape — the workflow accepts both:
  - **id string** (the default, and what you want almost always): the chosen ready
    issue id(s), space- or comma-separated — `bd-a1b2 bd-c3d4`.
  - **object form**, when you need to set the builder's permission mode:
    `{"ids": ["bd-a1b2", "bd-c3d4"], "builderPermissions": "skip"}`.
    `ids` is the same list; `builderPermissions` is `"skip"` (default — the
    `--dangerously-skip-permissions` builder of step 3) or `"inherit"`, which omits
    the flag so the builder runs under the environment's own permissions. Use
    `"inherit"` only where the environment is what grants permission — a sandbox, a
    container, pre-authorized settings — because a headless builder cannot answer a
    prompt and will simply fail on anything gated. Anything other than `"inherit"`
    is treated as `"skip"`.

  The workflow resolves each id's spec body from `~/.anvil/specs/<id>.md`; it does
  NOT read the frontier itself — reading `bd ready` and passing only ready ids is
  THIS skill's job (step 1).

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

### 5. Report and update beads

When the workflow returns, for each issue report: the draft PR url, the gate
result, the reviewer's top findings by severity, and whether the fix round ran.
Move the beads issue to reflect reality (e.g. in-review / blocked-on-human) under
`BEADS_DIR="$BEADS_DIR"` — never edit a `.beads` file in the target repo.

Then hand back to the operator: **adjudicate the draft PR.** Merging is theirs.

### 6. Clean up the run dir — but only after the PR merges

Each atom leaves a run dir at `~/.anvil/runs/<id>/`: the disposable worktree, the
implementing agent's prompt file, and its stream sidecar. Once the operator has
merged (or closed) the draft PR, that state has no reader left — retire it:

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
whatever the builder did manage to commit, and the resume path (step 3) reuses it.
Delete it and a resumable run becomes a rerun. Sweep only ids whose PR is merged or
closed, and leave anything still in flight alone.

## Hard rules

- **Never shell out to `forge`.** Use only `claude` (headless, via the workflow),
  `gh`, `bd`/`br`, `git`, and the Workflow tool.
- **Never launch the permissionless builder without explicit consent** (step 3).
  If a run is blocked for want of it, get the approval and resume that same run —
  never work around the classifier.
- **Zero repo imposition.** All beads/spec state stays under `$BEADS_DIR` and
  `~/.anvil/specs`. Never commit a `.beads` file into the target repo, never edit
  the repo's CLAUDE.md or settings, never require a per-worktree committed file.
- **Don't watch.** The loop is headless. Kick it off, let it run, read the result.
- **Never merge.** The atom ends at a reviewed draft PR awaiting human adjudication.
