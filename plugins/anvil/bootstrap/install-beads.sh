#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# install-beads.sh — stand up an OPERATOR-SCOPED, non-invasive beads store.
#
# The whole point of anvil is zero repo imposition: no committed `.beads/` file
# in your repo, no edits to the repo's CLAUDE.md, nothing your teammates see.
# We point beads at an out-of-repo, operator-scoped directory via BEADS_DIR and
# keep ALL anvil state there. This is the literal test the experiment cares about
# (ADR-0030, question #1): does bd's BEADS_DIR mode give worktree-safe,
# repo-untouched, multi-repo planning — or does something force a per-repo file?
#
# Usage:
#   ./install-beads.sh            # uses default ~/.anvil/beads
#   ANVIL_HOME=~/work/anvil ./install-beads.sh
#
# Records exactly what it took (any repo/CLAUDE.md/teammate-visible change) to
# stdout so the operator-scope log writes itself.

set -uo pipefail

ANVIL_HOME="${ANVIL_HOME:-$HOME/.anvil}"
export BEADS_DIR="${BEADS_DIR:-$ANVIL_HOME/beads}"

echo "anvil: operator-scoped home   = $ANVIL_HOME"
echo "anvil: BEADS_DIR (out-of-repo) = $BEADS_DIR"

mkdir -p "$BEADS_DIR" "$ANVIL_HOME/specs"

# Prefer the Go/Dolt `bd` (richest operator-scope story: BEADS_DIR git-free mode
# + contributor-mode out-of-repo planning). Fall back to the Rust `br`.
BD_BIN=""
if command -v bd >/dev/null 2>&1; then
  BD_BIN="bd"
elif command -v br >/dev/null 2>&1; then
  BD_BIN="br"
else
  echo "anvil: ERROR — neither 'bd' nor 'br' on PATH." >&2
  echo "  Install bd (Go/Dolt): https://github.com/gastownhall/beads" >&2
  echo "  or br (Rust/SQLite):  https://github.com/Dicklesworthstone/beads_rust" >&2
  exit 1
fi
echo "anvil: using beads binary      = $BD_BIN"

# Initialize the store IN the out-of-repo BEADS_DIR. If this binary insists on
# writing a per-repo file or editing CLAUDE.md, that is a RESULT for the
# experiment — note it in the operator-scope log, do not "fix" it by committing.
( cd "$BEADS_DIR" && "$BD_BIN" init 2>&1 ) || {
  echo "anvil: '$BD_BIN init' failed in BEADS_DIR — log what it tried to touch." >&2
  exit 1
}

cat <<EOF

anvil: beads store ready (operator-scoped, repo-untouched).
  Add this to your shell profile so every anvil skill/workflow sees it:

    export BEADS_DIR="$BEADS_DIR"

  Sanity check (should list nothing yet, and create NOTHING in your repo):
    BEADS_DIR="$BEADS_DIR" $BD_BIN ready

  Operator-scope log — record honestly:
    [ ] Did init touch the current repo at all?            (expected: no)
    [ ] Did it create/modify a CLAUDE.md or repo settings?  (expected: no)
    [ ] Will worktrees of a repo each need their own file?  (expected: no)
EOF
