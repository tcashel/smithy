# anvil

**Plan with one agent. Hand the job off. Come back to evidence.**

Anvil is Smithy's operator-scoped planning layer for Forged. The lead agent
helps the user turn an idea into a self-contained spec, applies only as much
independent critique as the risk justifies, and adjudicates every unresolved
crux. Once the user accepts the direction, Anvil submits the locked work to
Forged for provider-neutral, durable execution.

## Ownership

- **Anvil/lead session:** conversation, specs, critique, adjudication.
- **Beads:** issues, dependencies, readiness, leases.
- **Forged:** profiles/topology, provider dispatch, attempts, gates, review,
  remediation, results, waves, and final execution state.
- **Herdr:** panes, processes, output, and message transport.
- **Git/GitHub:** commits, branches, PRs, and merge truth.

No layer duplicates another's durable state.

## Zero repo imposition

Beads, specs, ledger state, run artifacts, and controller records live under
`$BEADS_DIR` / `$ANVIL_HOME` (normally `~/.anvil`). Anvil never commits a
`.beads` directory or workflow config into a target repo, edits its
`CLAUDE.md`, or requires each worktree to carry orchestration state.

## Prerequisites and setup

Required: Git, authenticated `gh`, `bd` or `br`, and a current `forged` binary
with `run submit` and `epic submit`. Provider CLIs are required only when a
selected roster names them. Herdr is optional but recommended.

After plugin installation, run `/anvil:setup`. It initializes the
operator-scoped Beads/Forged state, creates and validates
`$ANVIL_HOME/config.yaml`, checks provider adapters and Herdr, and proves a
chosen target repository stayed untouched.

## Skills

- **`/anvil:plan`** drafts a self-contained slice or an epic plan map with
  Beads dependencies and checkable downstream assumptions.
- **`/anvil:critique`** uses the current harness's native delegation. Lean work
  gets one adversarial pass, standard work gets two independent angles, and
  high-risk work may add a cross-family critic.
- **`/anvil:adjudicate`** resolves every conflict/open question, applies
  accepted edits, and locks the spec.
- **`/anvil:dispatch`** starts immutable slice runs and calls
  `forged run submit`, then returns the controller identity.
- **`/anvil:run-epic`** freezes an epic inventory and calls
  `forged epic submit`; the scheduler drives waves until a final draft PR or
  an explicit input-required stop.

There are no bundled execution Workflow scripts and no scheduled watch. The
lead session does not stay alive to preserve the job.

## Profiles and rosters

`$ANVIL_HOME/config.yaml` separates cognitive topology from provider choice.
The two are picked independently: any profile can run under any roster.

- `lean`, `standard`, and `high` profiles define proportional seats and
  escalation edges.
- Named rosters map semantic roles to ordered provider/model candidates.
  `mixed` is the practical default — it splits seats across families so review
  does not share the implementer's blind spots. `all-codex` and
  `all-anthropic` keep every seat in one family, for a provider outage or a
  deliberate single-family comparison.
- `host_policy` chooses preferred/required/off Herdr behavior.

Those roster names are operator configuration, not plugin source. The YAML that
defines them lives only under `$ANVIL_HOME`; this repository ships no rosters,
credentials, or machine-specific paths.

Forged validates and hashes the selected package at run start. Editing YAML
later changes future runs only. An in-flight run switches roster explicitly at
a durable boundary with `forged run revise-roster`.

## Reconnect and control

```sh
forged overview --run <slice-id>
forged overview --epic <epic-id>
forged session list --run <slice-id>
```

The overview contains status, topology, sessions, gates, review findings,
artifacts, interventions, roster revisions, usage, and events. The same data is
available through the Forged MCP tool and view-only MCP App. Herdr-backed
attempts can be read or messaged through `forged session` commands.

Slice runs stop at reviewed draft PRs. Epic runs may merge mechanically clean
children only into `forged/epic-<id>` and end at one draft PR to the default
branch. The human adjudicates the merge.

## Why the old Workflow stack disappeared

The bare-parts experiment was valuable: it demonstrated the lead-agent
planning UX and showed when independent review pays. It also showed that fixed
large panels, shell detachment, scheduled re-invocation, and provider-specific
Workflow state were the wrong execution boundary. That evidence is preserved
in [LEARNINGS.md](LEARNINGS.md); execution now belongs to Forged.
