# anvil

**Plan. Run. Review. Ship. Don't watch.**

anvil is a non-invasive, operator-scoped reassembly of the Forge pipeline — `plan → critique → adjudicate → dispatch → review → fix` — built entirely from bare Claude Code primitives: skills, the Workflow tool, subagents, and the [beads](https://github.com/gastownhall/beads) issue tracker (`bd` / `br`).

You shape a piece of work into a self-contained spec, stress-test it with a multi-critic panel, adjudicate the cruxes yourself, then hand the locked spec to an unattended loop: a subagent builds it in a disposable worktree, the loop gates it on quality, opens a **draft** PR, reviews it twice over, and runs one auto-fix round. The loop is a job, not a show. It stops at the draft PR for you to adjudicate the merge. **It never auto-merges.**

## Zero repo imposition

This is the whole point. anvil keeps **all** of its state operator-scoped and out of the target repo:

- Beads lives in `$BEADS_DIR` (default `~/.anvil/beads`), never a `.beads/` file committed into your repo.
- Spec bodies live in `~/.anvil/specs/<id>.md`.
- anvil never edits the target repo's `CLAUDE.md` and never touches its settings.
- Worktrees of the target repo do **not** each need their own committed file.

Your teammates never see anvil in the repo. Nothing about your planning leaks into the working tree.

anvil shells out only to bare tooling — `gh`, `bd`/`br`, `git`, and `codex` for its second critic and second reviewer. Everything else is a workflow subagent inside your session, not a spawned CLI. It **does not** invoke the `forge` binary; that is the entire premise of the experiment (see below).

## Prerequisites

- **`bd` or `br` on your `PATH`** — the beads issue tracker. anvil prefers the Go/Dolt `bd` (richest operator-scope story via `BEADS_DIR`), and falls back to the Rust `br`.
  - `bd` (Go/Dolt): https://github.com/gastownhall/beads
  - `br` (Rust/SQLite): https://github.com/Dicklesworthstone/beads_rust
- **`gh`** — the GitHub CLI, authenticated (`gh auth status`). Used to open draft PRs and publish review findings.
- **`codex`** *(optional)* — the codex CLI. When present it is the panel's third critic and the atom's second reviewer, giving cross-model-family corroboration. Absent, both legs report themselves unavailable and the rest of the pipeline is unaffected.

## Setup

**The easy path:** after installing the plugin (see [Install](#install) below), run
**`/anvil:setup`**. It drives an agent to install beads if missing, verify `gh`/`git`
auth, stand up the out-of-repo store, persist `BEADS_DIR` (with your consent), and
*prove* the install imposed nothing on any target repo — recording the operator-scope
log as it goes. Everything below is what that skill automates, for when you'd rather do
it by hand.

1. Stand up the operator-scoped beads store. This creates `~/.anvil/{beads,specs}` and initializes beads **inside** `$BEADS_DIR` — it touches neither your repo nor its `CLAUDE.md`:

   ```bash
   # `${CLAUDE_PLUGIN_ROOT}` is NOT usable here — find the installed plugin first:
   ANVIL_ROOT="$(find "$HOME/.claude/plugins" -type f -name install-beads.sh \
     -path '*anvil/bootstrap*' 2>/dev/null | head -1 | xargs -r dirname | xargs -r dirname)"
   "$ANVIL_ROOT"/bootstrap/install-beads.sh        # ANVIL_HOME=~/work/anvil to relocate
   ```

2. Export both variables so every anvil skill and workflow sees the same out-of-repo store *and* can find the bundled workflow scripts. The bootstrap prints this block with your paths filled in; add it to your shell profile:

   ```bash
   export BEADS_DIR="$HOME/.anvil/beads"
   export ANVIL_PLUGIN_ROOT="$ANVIL_ROOT"     # the plugin dir found in step 1
   ```

3. Sanity check — this should list nothing yet and create **nothing** in your repo:

   ```bash
   BEADS_DIR="$HOME/.anvil/beads" bd ready
   ```

The bootstrap script also prints an operator-scope log so you can record honestly whether anything forced a per-repo file. The expected answer to every line is *no*.

## Install

From inside Claude Code:

```
/plugin marketplace add <path-or-repo>
/plugin install anvil@smithy
```

Use the local checkout path (e.g. the path to this `smithy` repo) or the marketplace repo URL for the first step, then install the `anvil` plugin from the `smithy` marketplace.

## The skills

One skill sets anvil up; four drive the pipeline from idea to a locked, dispatchable spec, then turn it loose.

- **`/anvil:setup`** — *One-time.* Install and configure beads operator-scoped, verify the table-stakes tooling, and prove zero repo imposition. Run this first (see [Setup](#setup)).

- **`/anvil:plan`** — Turn an idea into a **self-contained** spec. The implementing agent later sees *only* the spec body — not your planning conversation, not the repo's `CLAUDE.md`, nothing else — so planning's job is to make the spec stand entirely on its own. A vague spec produces a confused agent.

- **`/anvil:critique`** — Run the critic panel against the draft spec: two `anvil-critic` passes on different models and angles, plus a third leg relaying the `codex` CLI when it's installed (a different model family — cross-family agreement is the strongest corroboration available, and the leg reports itself unavailable rather than inventing findings when codex is absent). Each critic emits exactly one ` ```anvil-spec-critique ` fenced block; a synthesizer step folds them into one ` ```anvil-spec-recommendations ` block of cruxes, ranked BLOCKER / HIGH / MEDIUM / LOW. This is invoked via the bundled `plan-critique-improve.js` workflow.

- **`/anvil:adjudicate`** — *You* resolve the cruxes. Accept, reject, or rewrite each recommendation, folding the decisions back into the spec until it is mergeable-quality and locked. When a spec is locked it becomes a `bd` issue whose **body** is `~/.anvil/specs/<id>.md`.

- **`/anvil:dispatch`** — Read `bd ready` (honoring `$BEADS_DIR`) for the work-list and run the execution atom over each ready spec: an implementing subagent builds it in a disposable worktree → quality gate → **draft** PR → review by two reviewers (`anvil-reviewer`, plus a `codex` relay when it's installed; findings are tagged by source and the severer verdict wins) → one auto-fix round → stop. This is invoked via the bundled `execute-review-fix.js` workflow. The atom stops at the draft PR. You adjudicate the merge.

## The bundled Workflow scripts

Two unattended Workflow scripts do the supervised, long-running work. Skills invoke them through the Claude Code Workflow tool with a `scriptPath` pointing at the bundled file. (`${CLAUDE_PLUGIN_ROOT}` is not usable from skill text, so the skills resolve the absolute path at runtime via `$ANVIL_PLUGIN_ROOT` — set by `/anvil:setup` — with a `find` over `~/.claude/plugins` as a fallback.)

- **`workflows/plan-critique-improve.js`** — fans out the critic panel (two critics, plus the codex leg when available) and synthesizes the cruxes. It leaves the spec file **unchanged** and returns the recommendations; `/anvil:adjudicate` is the only surface that writes a spec. Backs `/anvil:critique` (and the planning loop).

- **`workflows/execute-review-fix.js`** — runs the execution atom per ready spec: implement → quality gate → draft PR → review (both reviewers) → auto-fix (`autoFixRounds` default `1`) → stop. Backs `/anvil:dispatch`.

Every stage in both scripts is a workflow **subagent** — sanctioned by your session, inheriting your permission mode, returning a schema-validated object. Neither script spawns a `claude` CLI. Each agent also emits its single tagged fenced block as the human-readable contract. When a reviewer publishes findings to a PR, each comment carries a hidden `<!-- anvil-finding id=... -->` marker so re-running never duplicates a comment.

The one thing they do shell out to is `codex`, for the panel's third critic and the atom's second reviewer. Both run it in the background and poll for it in bounded steps, because a single blocking wait would outlive the tool's per-call limit; and both report an honest unavailability when the binary is missing rather than inventing a second opinion.

## This is an experiment

anvil exists to test a hypothesis from Forge's **ADR-0030**: does Forge's value reassemble from *bare parts* — skills, Workflows, subagents, and beads — **without** building the Forge app? Every constraint above (operator-scoped state, zero repo imposition, never shelling out to `forge`, stopping at a draft PR) is part of that test. If the loop delivers near-mergeable PRs from out-of-repo planning across multiple repos and worktrees, the experiment succeeds on its own terms.
