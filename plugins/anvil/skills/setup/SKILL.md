---
name: setup
description: "One-time Anvil/Forged setup: establish the operator-scoped Beads and Forged state under ~/.anvil, verify git/gh/provider adapters and optional Herdr supervision, validate the YAML profile/roster config, and prove the installation imposed nothing on a target repository."
---

# /anvil:setup — provider-neutral planning and execution substrate

Setup owns operator-machine configuration, never target-repository state. Ask
before installing a binary or editing a shell profile, and show the exact
command first.

## 1. Verify prerequisites

Check:

```sh
command -v git gh bd br forged herdr claude codex 2>/dev/null
git --version
gh auth status
forged --version
```

Required: `git`, authenticated `gh`, one Beads binary (`bd` preferred, `br`
accepted), and `forged` with `run submit` and `epic submit` in its help. Provider
CLIs are required only when referenced by the selected roster. Herdr is
optional but recommended for pane visibility and live intervention.

Retain the selected Beads command for every later setup check:

```sh
BD_BIN="$(command -v bd || command -v br)"
test -n "$BD_BIN"
```

If `forged` is absent or too old, stop and ask the operator for the Forge
checkout/release they want installed. Do not substitute the removed Workflow
scripts. Any install requires explicit consent.

## 2. Stand up operator-scoped Beads state

Find and run the bundled bootstrap:

```sh
ANVIL_PLUGIN_ROOT="$(find "$HOME/.claude/plugins" "$HOME/repositories" "$HOME/repos" "$HOME/src" \
  -type f -name install-beads.sh -path '*anvil*/bootstrap*' 2>/dev/null | head -1 \
  | xargs -r dirname | xargs -r dirname)"
"$ANVIL_PLUGIN_ROOT/bootstrap/install-beads.sh"
```

It creates `${ANVIL_HOME:-$HOME/.anvil}/{beads,specs}` and initializes Beads
inside `$BEADS_DIR`, not the current repository.

## 3. Initialize and validate Forged

With the same environment:

```sh
export ANVIL_HOME="${ANVIL_HOME:-$HOME/.anvil}"
export BEADS_DIR="${BEADS_DIR:-$ANVIL_HOME/beads}"
forged init
forged doctor
forged definition validate
```

`forged init` writes `$ANVIL_HOME/config.yaml` and the ledger schema. If the
generated `bd_path` does not match the installed Beads binary, update that
operator-scoped YAML field to the absolute `command -v bd`/`br` result, then
rerun doctor. Never solve this by adding config to a target repo.

The YAML owns named assurance profiles (`lean`, `standard`, `high`), ordered
provider/model rosters, gate commands, retry budgets, `host_policy`, and
`herdr_sock`. Validate after every edit:

```sh
forged definition validate --profile standard --roster default
```

Changing the default/named roster affects future runs. A live run changes
roster only through `forged run revise-roster` at a durable boundary.

## 4. Verify Herdr honestly

If Herdr is installed, verify its socket (normally
`$HOME/.config/herdr/herdr.sock`) and confirm `forged doctor` reports it. Keep
`host_policy: preferred` for visible fallback, use `required` only when the
operator wants execution to refuse without Herdr, and `off` only deliberately.
Never report a process fallback as a Herdr session.

## 5. Persist the shared state location

Offer—do not silently perform—to add the chosen values to the shell profile:

```sh
export ANVIL_HOME="<resolved absolute ANVIL_HOME>"
export BEADS_DIR="<resolved absolute BEADS_DIR>"
```

Replace both placeholders with the values resolved during setup; never reset a
custom home to `$HOME/.anvil`. Check for existing exports before appending. The
plugin root no longer needs to be persisted: execution Workflow files were
removed.

## 6. Prove zero repo imposition

In a real target repo selected by the operator:

```sh
git status --porcelain
BEADS_DIR="$BEADS_DIR" "$BD_BIN" ready
test ! -e .beads
git status --porcelain
```

Record whether Beads/Forged created any repository file, changed
`CLAUDE.md`/settings, or required per-worktree state. Expected: no to all.
State belongs under `$ANVIL_HOME`; worktrees/branches/PRs appear only after an
explicit dispatch.

## Report

Report exact binary versions, `gh` auth, selected Beads path, config/ledger
paths, available provider adapters, Herdr status/policy, definition validation,
and the repo-imposition check. The next step is `/anvil:plan`; after the user
accepts and locks the direction, `/anvil:dispatch` or `/anvil:run-epic` hands it
to Forged.
