# smithy

A personal Claude Code **plugin marketplace**. The workshop that holds the tools.

Today it ships one plugin:

## `anvil` — shape work without watching it

`anvil` is a **non-invasive, operator-scoped** agent pipeline:

> **Plan. Run. Review. Ship. Don't watch.**

It turns an idea into a near-mergeable draft PR by walking a spec through
**plan → critique → adjudicate → dispatch → review → fix**, with a
[beads](https://github.com/gastownhall/beads) issue graph as the work-item store
and Claude Code Workflows doing the cognitive fan-out.

The defining constraint: **zero repo imposition.** All of anvil's state lives
out-of-repo and operator-scoped (`$BEADS_DIR`, `~/.anvil/specs/`). anvil never
commits a `.beads` file into your target repo, never edits its `CLAUDE.md`, and
never makes a change your teammates have to see. You can plan, critique, and run
work against any repo — including worktree-heavy ones — without touching it.

### Install

```
/plugin marketplace add ~/repositories/smithy      # or: <github-owner>/smithy
/plugin install anvil@smithy
```

Then run **`/anvil:setup`** — it installs beads (if missing), stands up the
operator-scoped store, persists `BEADS_DIR` with your consent, and proves the
install touched no repo. (Manual equivalent:
`plugins/anvil/bootstrap/install-beads.sh` + `export BEADS_DIR="$HOME/.anvil/beads"`.)

Prerequisites: `bd` ([beads](https://github.com/gastownhall/beads)) or `br`
([beads_rust](https://github.com/Dicklesworthstone/beads_rust)) on `PATH`, plus
`gh` and `claude`. See [`plugins/anvil/README.md`](plugins/anvil/README.md) for
the full walkthrough and [`plugins/anvil/LEARNINGS.md`](plugins/anvil/LEARNINGS.md)
for the portable engineering lessons this plugin encodes.

---

## Why this exists (the experiment)

anvil is the bare-parts arm of a deliberate experiment. The sibling project
**Forge** is a TypeScript app that implements this same loop as a bespoke CLI.
Forge's [ADR-0030](https://github.com/tcashel/forge) asks an uncomfortable
question: now that Claude Code ships Workflows, Routines, and subagents — and
beads ships the dependency graph — **does Forge's value reassemble from bare
parts, or does building the app still earn its keep?**

`anvil` is how we find out. It reassembles Forge's loop using *only* skills,
Workflows, subagents, `beads`, `gh`, and headless `claude` — and **never** shells
out to the `forge` binary (doing so would invalidate the test). Two surfaces are
expected to be where the answer lives:

- **operator-scope / worktree-safety / zero-imposition** — can bare beads
  (`$BEADS_DIR`, contributor mode) actually deliver repo-untouched, multi-repo,
  worktree-safe planning? Or does assembling it reinvent Forge?
- **adjudication write-back** — beads viewers are read-only; resolving spec
  cruxes is a genuine write surface (`/anvil:adjudicate`).

If the bare stack reassembles into Forge, Forge is the product. If a plugin like
this gets you ~90% there, the plugin *is* the product. Either answer is a win;
the point is to find it honestly.

---

## License

[MIT](LICENSE) © 2026 Tripp Cashel
