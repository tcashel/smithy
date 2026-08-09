---
name: setup
description: "One-time setup for anvil: install and configure beads (bd or br) operator-scoped, verify the table-stakes tooling (git, gh + auth, claude), stand up the out-of-repo state under ~/.anvil, and PROVE the install imposed nothing on any target repo. Use when the operator first installs the anvil plugin, when bd/br is missing, or when /anvil:plan or /anvil:dispatch complains that beads isn't set up."
---

# anvil setup

You are standing up the **operator-scoped, non-invasive** substrate that the rest
of anvil depends on. When you are done, `bd ready` works, all state lives under
`~/.anvil/` and `$BEADS_DIR`, and **nothing has been written into any target
repository** — no `.beads/` file, no `CLAUDE.md` edit, no repo setting.

This is also a measurement. anvil exists to test (Forge ADR-0030) whether a
bare-parts stack can deliver repo-untouched, worktree-safe planning. So as you go,
**record exactly what setup imposed** — that log is the experiment's primary
result, not a side note.

## Consent rules (read first)

Setup mutates the operator's *machine* (installs binaries) and possibly their
shell profile. It must NEVER mutate a target repo. Therefore:

- **Ask before any system-level install** (`brew install`, `cargo install`,
  `go install`, downloading a release binary). Show the exact command first.
- **Ask before editing the shell profile** (`~/.zshrc` etc.). Offer to do it;
  don't do it silently.
- **Never** write into a target repo, and **never** invoke the `forge` binary.
  anvil uses only `bd`/`br`, `git`, `gh`, and `claude`.

## Step 1 — Detect the environment

```bash
uname -s                       # Darwin / Linux
command -v brew cargo go gh git claude 2>/dev/null   # what's available
```

Note the platform and which package managers exist — you'll pick the beads
install method from this.

## Step 2 — Verify the table-stakes tooling

These are not anvil's job to install, only to verify and guide:

- **claude** — present by definition (you are running inside it). Confirm `claude --version`.
- **git** — required. If missing, stop and tell the operator to install it.
- **gh** — required for the dispatch/review loop. Check `gh --version` and
  `gh auth status`. If `gh` is missing, offer (with consent) `brew install gh`
  (macOS) or point to <https://cli.github.com>. If it's installed but not
  authenticated, tell the operator to run `gh auth login` themselves (it's
  interactive — suggest they type `! gh auth login` in the session).

## Step 3 — Install beads (the one thing anvil specifically needs)

Check first — it may already be present:

```bash
command -v bd && bd --version
command -v br && br --version
```

If neither is present, install one. **Prefer `bd`** (Go/Dolt) — it has the
richest operator-scope story (`BEADS_DIR` git-free mode + contributor-mode
out-of-repo planning), which is exactly what anvil leans on. Fall back to `br`
(Rust/SQLite). Pick the method by what Step 1 found, and **ask before running it**:

- `bd` via Go:        `go install github.com/gastownhall/beads/cmd/bd@latest`
- `bd` via release:    download the matching binary from
  <https://github.com/gastownhall/beads/releases> into a dir on `PATH`.
- `br` via Cargo:      `cargo install --git https://github.com/Dicklesworthstone/beads_rust`
- `br` via release:    <https://github.com/Dicklesworthstone/beads_rust/releases>

Tell the operator which binary you installed and why. If both `bd` and `br` are
already present, prefer `bd` and say so.

> Honest note for the operator: when `bd` set up *agent integration* in the past
> it edited `CLAUDE.md`/hooks — exactly the imposition anvil avoids. Do **NOT**
> run any `bd setup`/`bd init --with-claude` style command that writes into a
> repo or a `CLAUDE.md`. We initialize beads ONLY in the out-of-repo `$BEADS_DIR`
> (next step). If a beads subcommand insists on touching a repo, that's a finding
> for the operator-scope log — record it, don't work around it by committing.

## Step 4 — Stand up the operator-scoped store

Run the bundled bootstrap. It creates `$BEADS_DIR` (default `~/.anvil/beads`)
and `~/.anvil/specs/`, and runs `bd init` (or `br init`) **inside `$BEADS_DIR`**,
never in a repo:

`${CLAUDE_PLUGIN_ROOT}` is NOT expanded in skill text, so discover the plugin root
first, then run the bundled bootstrap:

```bash
ANVIL_PLUGIN_ROOT="$(find "$HOME/.claude/plugins" "$HOME/repositories" "$HOME/repos" "$HOME/src" \
  -type f -name install-beads.sh -path '*anvil/bootstrap*' 2>/dev/null | head -1 \
  | xargs -r dirname | xargs -r dirname)"
echo "anvil plugin root: $ANVIL_PLUGIN_ROOT"

"$ANVIL_PLUGIN_ROOT/bootstrap/install-beads.sh"     # ANVIL_HOME=~/work/anvil to relocate
```

The script prints the operator-scope checklist — keep its output. You'll persist
`ANVIL_PLUGIN_ROOT` in the next step so the other skills can locate the workflows.

## Step 5 — Persist `BEADS_DIR` and `ANVIL_PLUGIN_ROOT`

Every anvil skill and workflow honors `$BEADS_DIR`, and the workflow-invoking skills
(`/anvil:critique`, `/anvil:dispatch`) resolve their bundled scripts via
`$ANVIL_PLUGIN_ROOT` (because `${CLAUDE_PLUGIN_ROOT}` is unusable from skill text —
see Step 4). Persist both:

Persist them **together** — they are one block, not two errands. Every skill that
re-derives `BEADS_DIR` from a default is a skill that can disagree with the operator's
actual store, so write it down once:

```bash
export BEADS_DIR="$HOME/.anvil/beads"           # or the ANVIL_HOME the operator chose
export ANVIL_PLUGIN_ROOT="$ANVIL_PLUGIN_ROOT"   # the value discovered in Step 4
```

Offer to append that block to their shell profile (`~/.zshrc` on this platform) — and
**ask before editing it**. Show the exact lines first, and check whether either export
is already there before appending, so a re-run doesn't stack duplicates. If they
decline, tell them to export both themselves; skills do fall back to `~/.anvil/beads`
for `BEADS_DIR` and to a `find` over `~/.claude/plugins` for the plugin root, but a
fallback is a guess and an export is a fact.

## Step 6 — Prove zero repo imposition (the decisive check)

This is the experiment's question #1. From inside a REAL target repo the operator
names (ideally a worktree-heavy one), confirm the stack reads/writes its
frontier **without touching the repo**:

```bash
cd <some target repo>
git status --porcelain > /tmp/anvil-before
BEADS_DIR="$HOME/.anvil/beads" bd ready          # should work, list nothing yet
ls -a .beads 2>/dev/null && echo "IMPOSITION: .beads dir present in repo!"
git status --porcelain > /tmp/anvil-after
diff /tmp/anvil-before /tmp/anvil-after && echo "CLEAN: repo untouched ✓"
```

Record honestly:

```
operator-scope log
  [ ] Installing beads touched NO target repo                 (expected: pass)
  [ ] `bd ready` from inside a repo created nothing in it     (expected: pass)
  [ ] No .beads/ file appeared in the repo or any worktree    (expected: pass)
  [ ] No CLAUDE.md / repo setting was modified                (expected: pass)
  [ ] Worktrees do NOT each need their own committed file     (expected: pass)
```

Any box that fails is not a bug to patch around — it's the answer to whether the
operator-scoped differentiator is real or just config. Surface it to the operator.

## Step 7 — Report

Tell the operator, concisely:

- Which beads binary is installed (`bd`/`br`) and its version.
- Where state lives (`$BEADS_DIR`, `~/.anvil/specs/`).
- `gh` auth status and any remaining manual step (e.g. `gh auth login`).
- The operator-scope log result.
- Next step: **`/anvil:plan`** to draft and lock the first spec.

## What you must never do

- Install anything, or edit the shell profile, without showing the command and
  getting consent first.
- Write a `.beads/` file, a `CLAUDE.md`, or any file into a target repo or worktree.
- Run a `bd`/`br` subcommand that edits a repo's `CLAUDE.md` or settings.
- Invoke the `forge` binary. anvil is the bare-parts stack — it has no Forge.
- Silently "fix" an imposition by committing it. Log it instead.
