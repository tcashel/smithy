# Notes for agents working in the smithy repo

## What this repo is

**smithy** is a personal Claude Code **plugin marketplace**. It ships one plugin,
**anvil**: a non-invasive, operator-scoped pipeline —
`plan → critique → adjudicate → dispatch → review → fix` — reassembled from bare
Claude Code primitives (skills, the Workflow tool, subagents) plus the **beads**
issue tracker (`bd`/`br`) as the work-item store.

You are almost always here to **author or maintain the anvil plugin**, not to run
it. (Running it happens in some *other* repo, via the installed skills.)

## Why anvil exists (don't lose the thread)

anvil is the bare-parts arm of a deliberate experiment owned by the sibling
**Forge** repo, ADR-0030: now that Claude Code ships Workflows/Routines/subagents
and beads ships the dependency graph, *does Forge's value reassemble from bare
parts, or does the bespoke app still earn its keep?* anvil reassembles the loop
from bare parts so we can find out. Two cardinal rules follow from that and
**must never be violated** — breaking either invalidates the experiment:

1. **anvil MUST NEVER shell out to the `forge` binary.** Use only `claude`
   (headless), `gh`, `bd`/`br`, `git`, and the Workflow tool. If you reach for
   `forge ...`, stop and use the bare equivalent.
2. **Zero repo imposition.** All anvil state is operator-scoped and out-of-repo:
   beads in `$BEADS_DIR` (default `~/.anvil/beads`), spec bodies in
   `~/.anvil/specs/<id>.md`, run artifacts in `~/.anvil/runs/`. anvil never
   commits a `.beads` file into a target repo, never edits a target repo's
   `CLAUDE.md`, and never makes a teammate-visible change. Worktrees must not
   each need their own committed file.

## Layout

```
.claude-plugin/marketplace.json     marketplace manifest (lists anvil)
plugins/anvil/
  .claude-plugin/plugin.json        plugin manifest
  skills/<name>/SKILL.md            setup · plan · critique · adjudicate · dispatch
  agents/<name>.md                  anvil-critic · anvil-reviewer (subagents)
  workflows/*.js                    Claude Code Workflow scripts (see gotchas below)
  bootstrap/install-beads.sh        operator-scoped $BEADS_DIR bootstrap
  LEARNINGS.md                      portable Forge lessons encoded in this plugin
```

## Naming contract (keep these EXACT — files reference each other by them)

- Skills install namespaced: `/anvil:setup`, `/anvil:plan`, `/anvil:critique`,
  `/anvil:adjudicate`, `/anvil:dispatch`.
- Subagents: `anvil-critic` (`agents/critic.md`), `anvil-reviewer` (`agents/reviewer.md`).
- Workflow scripts invoke subagents via `agent(..., {agentType: 'anvil-critic'})`.
- Structured fenced-block tags (the extraction contract): critic →
  ` ```anvil-spec-critique `, synthesizer → ` ```anvil-spec-recommendations `,
  reviewer → ` ```anvil-review `. Severity labels everywhere: BLOCKER/HIGH/MEDIUM/LOW.

## Authoring Workflow scripts — gotchas that already bit us

The `.js` files in `workflows/` run under the Claude Code **Workflow tool**, NOT
Node and NOT a default-export module. `node --check` passing does **not** mean it
runs. The runtime executes the script **body** at top level with hooks as
globals. Get these right:

- Start with `export const meta = { name, description, phases }` (pure literal).
  `phases` is an array of `{ title, detail }` objects — NOT strings, NOT
  `{ name, description }`.
- **No `export default function run(...)` wrapper.** The body runs directly. Use
  the globals `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`.
  Top-level `await` and top-level `return` are allowed.
- `phase(title)` is **void** — it starts a progress group. It is NOT a
  stage-wrapper; `pipeline(items, stage1, stage2, ...)` takes the stage callbacks
  directly, each `(prevResult, originalItem, index) => ...`. Inside pipeline
  stages, set grouping via the per-agent `phase:` opt, not the global `phase()`.
- `agent(prompt, { schema })` returns a validated object; without a schema it
  returns text. `agent(prompt, { agentType: 'anvil-reviewer' })` uses a plugin
  subagent.
- The runtime **forbids** `Date.now()`, `new Date()`, and `Math.random()` (they
  break resume). Vary by index, not by randomness. (Note: even these tokens
  appearing in a *string literal* trip the static check — paraphrase in prompts.)

## Skills can't use `${CLAUDE_PLUGIN_ROOT}`

`${CLAUDE_PLUGIN_ROOT}` is expanded in JSON configs (`hooks.json`, `.mcp.json`,
`monitors.json`) but **NOT** in SKILL.md text, and **NOT** as a Bash env var during
skill execution (Claude Code issue #9354). A skill therefore cannot reference a
bundled file by that variable — the model just sees the literal string. anvil's
pattern: `/anvil:setup` discovers the plugin root and persists
`export ANVIL_PLUGIN_ROOT=...`; the workflow-invoking skills resolve bundled scripts
as `$ANVIL_PLUGIN_ROOT/workflows/<file>.js` with a `find "$HOME/.claude/plugins" …`
fallback. When you add a skill that needs a bundled file, follow that pattern — do
**not** write `${CLAUDE_PLUGIN_ROOT}` in SKILL.md.

## Validate before you call it done

```bash
claude plugin validate .                 # marketplace + plugin manifests
node --check plugins/anvil/workflows/*.js # JS syntax (necessary, not sufficient)
```

Frontmatter conventions: skills need `name` + `description`; subagents need
`name` + `description`, plus `tools:` to restrict (reviewers/critics are
**read-only** — no Write/Edit) and optional `model:`.

## Don't commit operator state

`.gitignore` excludes `~/.anvil`-style state, `.beads/`, and logs. The repo holds
the *plugin source* only — never a beads DB, spec, or run artifact.
