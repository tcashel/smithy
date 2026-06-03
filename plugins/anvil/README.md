# anvil

**Plan. Run. Review. Ship. Don't watch.**

anvil is a non-invasive, operator-scoped reassembly of the Forge pipeline — `plan → critique → adjudicate → dispatch → review → fix` — built entirely from bare Claude Code primitives: skills, the Workflow tool, subagents, and the [beads](https://github.com/gastownhall/beads) issue tracker (`bd` / `br`).

You shape a piece of work into a self-contained spec, stress-test it with a two-critic panel, adjudicate the cruxes yourself, then hand the locked spec to a headless loop that launches an implementing agent, gates it on quality, opens a **draft** PR, reviews it, and runs one auto-fix round. The loop is a job, not a show. It stops at the draft PR for you to adjudicate the merge. **It never auto-merges.**

## Zero repo imposition

This is the whole point. anvil keeps **all** of its state operator-scoped and out of the target repo:

- Beads lives in `$BEADS_DIR` (default `~/.anvil/beads`), never a `.beads/` file committed into your repo.
- Spec bodies live in `~/.anvil/specs/<id>.md`.
- anvil never edits the target repo's `CLAUDE.md` and never touches its settings.
- Worktrees of the target repo do **not** each need their own committed file.

Your teammates never see anvil in the repo. Nothing about your planning leaks into the working tree.

anvil shells out only to bare tooling — `claude` (headless), `gh`, `bd`/`br`, and `git`. It **does not** invoke the `forge` binary; that is the entire premise of the experiment (see below).

## Prerequisites

- **`bd` or `br` on your `PATH`** — the beads issue tracker. anvil prefers the Go/Dolt `bd` (richest operator-scope story via `BEADS_DIR`), and falls back to the Rust `br`.
  - `bd` (Go/Dolt): https://github.com/gastownhall/beads
  - `br` (Rust/SQLite): https://github.com/Dicklesworthstone/beads_rust
- **`gh`** — the GitHub CLI, authenticated (`gh auth status`). Used to open draft PRs and publish review findings.
- **`claude`** — the Claude Code CLI, available headless for the Workflow scripts that supervise real work.

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

2. Export `BEADS_DIR` so every anvil skill and workflow sees the same out-of-repo store. Add it to your shell profile:

   ```bash
   export BEADS_DIR="$HOME/.anvil/beads"
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

- **`/anvil:critique`** — Run a two-critic panel (`anvil-critic`) against the draft spec. Each critic emits exactly one ` ```anvil-spec-critique ` fenced block; a synthesizer step folds them into one ` ```anvil-spec-recommendations ` block of cruxes, ranked BLOCKER / HIGH / MEDIUM / LOW. This is invoked via the bundled `plan-critique-improve.js` workflow.

- **`/anvil:adjudicate`** — *You* resolve the cruxes. Accept, reject, or rewrite each recommendation, folding the decisions back into the spec until it is mergeable-quality and locked. When a spec is locked it becomes a `bd` issue whose **body** is `~/.anvil/specs/<id>.md`.

- **`/anvil:dispatch`** — Read `bd ready` (honoring `$BEADS_DIR`) for the work-list and run the execution atom over each ready spec: launch an implementing agent → quality gate → **draft** PR → review (`anvil-reviewer`) → one auto-fix round → stop. This is invoked via the bundled `execute-review-fix.js` workflow. The atom stops at the draft PR. You adjudicate the merge.

## The bundled Workflow scripts

Two headless Workflow scripts do the supervised, long-running work. Skills invoke them through the Claude Code Workflow tool with a `scriptPath` pointing at the bundled file. (`${CLAUDE_PLUGIN_ROOT}` is not usable from skill text, so the skills resolve the absolute path at runtime via `$ANVIL_PLUGIN_ROOT` — set by `/anvil:setup` — with a `find` over `~/.claude/plugins` as a fallback.)

- **`workflows/plan-critique-improve.js`** — fans out the two-critic panel, synthesizes the cruxes, and threads the recommendations back into the spec. Backs `/anvil:critique` (and the planning loop).

- **`workflows/execute-review-fix.js`** — runs the execution atom per ready spec: launch → quality gate → draft PR → review → auto-fix (`autoFixRounds` default `1`) → stop. Backs `/anvil:dispatch`.

Both run headless. They trust the terminal `{"type":"result"}` event from each `claude` run — not the pipeline exit code — as the source of truth in both directions, and they extract each agent's single tagged fenced block as the contract. When the reviewer publishes findings to a PR, each comment carries a hidden `<!-- anvil-finding id=... -->` marker so re-running never duplicates a comment.

## This is an experiment

anvil exists to test a hypothesis from Forge's **ADR-0030**: does Forge's value reassemble from *bare parts* — skills, Workflows, subagents, and beads — **without** building the Forge app? Every constraint above (operator-scoped state, zero repo imposition, never shelling out to `forge`, stopping at a draft PR) is part of that test. If the loop delivers near-mergeable PRs from out-of-repo planning across multiple repos and worktrees, the experiment succeeds on its own terms.
