# Notes for agents working in the smithy repo

## What this repo is

**smithy** is a personal Claude Code and Codex plugin marketplace. It ships
**anvil**, the operator-scoped planning front end for Forged:

`plan → proportional critique → adjudicate → forged handoff → reviewed draft PR`

The user talks to one lead agent. Anvil helps that session shape and lock the
work; after approval, the dispatch skills call Forged's typed CLI/MCP contracts
and may disconnect. Forged owns long-horizon execution.

## Ownership rules

1. **Zero repo imposition.** Beads, specs, the Forged ledger, run artifacts,
   and controller records live under `$BEADS_DIR` / `$ANVIL_HOME` (normally
   `~/.anvil`). Never commit `.beads`, orchestration config, or agent settings
   to a target repo and never edit its `CLAUDE.md`.
2. **One execution authority.** After spec lock, Beads owns readiness; Forged
   owns topology, dispatch, gates, attempts, review/remediation, and outcomes;
   Herdr owns panes/process transport; Git/GitHub own code and PR truth.
   Smithy is a thin typed client. Do not recreate these state machines in a
   skill, Workflow, monitor, shell loop, or timer.
3. **Human branch authority.** Slice runs stop at draft PRs. Epic runs may
   mechanically merge clean slices only into their integration branch and end
   at one draft PR to the default branch. A human adjudicates that merge.

## Layout

```text
.claude-plugin/marketplace.json
plugins/anvil/
  .claude-plugin/plugin.json
  .codex-plugin/plugin.json
  skills/<name>/SKILL.md
  skills/plan/{checklist,epic,research,schema}.md
  agents/critic.md
  bootstrap/install-beads.sh
  LEARNINGS.md
```

There are intentionally no execution `workflows/*.js`, epic monitors, or
scheduled-watch skill. `forged run submit` and `forged epic submit` are the
durable detachment primitives; `forged overview` and the MCP App are the
reconnect surfaces.

## Public skill names

- `/anvil:setup`
- `/anvil:plan`
- `/anvil:critique`
- `/anvil:adjudicate`
- `/anvil:dispatch`
- `/anvil:run-epic`

The optional Claude subagent is namespaced `anvil:anvil-critic`; critique must
also work through the current harness's native delegation when that registry
is unavailable.

## Planning and execution boundary

- Planning and critique are human-in-the-loop. Critique scales from one pass
  to a cross-family panel based on risk; never pay for a fixed large panel by
  default.
- Dispatch never hard-codes provider or model names. Profiles and ordered
  rosters live in `$ANVIL_HOME/config.yaml`, validate with
  `forged definition validate`, and are frozen into each run.
- A future roster edit affects future runs. A live run changes roster only via
  `forged run revise-roster` at a durable boundary.
- Herdr is visibility/transport, not run truth. A process fallback must remain
  visible in the ledger and status output.

## Validate before completion

```sh
claude plugin validate .
bash scripts/validate.sh
```

CI runs `scripts/validate.sh`: JSON manifests (both marketplaces, both plugin
manifests), frontmatter, bootstrap syntax, a regression check that the removed
Workflow/watch execution files do not return, and the positive handoff contract
— dispatch must still invoke `forged run start`/`submit`, run-epic must still
invoke `forged epic start`/`submit`, and both plugin manifests must advertise
the same version. `claude plugin validate .` is local-only because CI has no
Claude CLI.

**Bump both plugin manifests on every behavior change.** Installed plugins are
version-keyed and otherwise continue serving stale content. The bump is three
edits, not two: both `plugin.json` files and `expected_version` in
`scripts/validate.sh`, which is what keeps the pair from drifting apart.

## Historical evidence

`plugins/anvil/LEARNINGS.md` preserves the bare-parts experiment and its cost/
failure evidence. Treat the old Workflow-specific sections as history. The
current architecture is the decision recorded at the top of that file and in
Forge ADR-0033: Anvil owns lead-agent planning; Forged owns execution.
