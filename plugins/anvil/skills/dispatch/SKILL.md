---
name: dispatch
description: "Hand locked, ready Anvil specs to Forged for detached provider-neutral execution. Selects ready beads, chooses a proportional assurance profile, starts immutable runs, submits their durable controllers, and returns immediately with status/Herdr inspection commands. Stops at reviewed draft PRs for human adjudication; never merges the default branch."
---

# /anvil:dispatch — hand ready slices to Forged

Planning is over at this boundary. This skill reads the Beads frontier and
submits locked specs to **Forged**, which owns topology, provider dispatch,
gates, review, remediation, durable state, and results. The lead session may
disconnect as soon as `forged run submit` returns.

## Preconditions

- `$BEADS_DIR` points at the operator-scoped store. If it is unset, stop and
  ask the operator to run `/anvil:setup`.
- `forged doctor` succeeds. Do not reproduce its execution logic in this
  skill and do not fall back to a bundled Workflow.
- The target is a clean, pushable Git repository and `gh auth status` works.
- Every selected issue is ready and has a locked spec at
  `${ANVIL_HOME:-$HOME/.anvil}/specs/<id>.md`.

## 1. Select only ready work

Run `BEADS_DIR="$BEADS_DIR" bd ready` (or `br ready` when that is the
configured binary). If the operator named ids, each must appear in that
frontier. Otherwise choose a small reviewable batch; do not silently drain the
whole store. An empty frontier is a durable stop, not permission to invent ids.

Resolve the target checkout once:

```sh
git rev-parse --show-toplevel
```

## 2. Choose proportional assurance

The operator's explicit profile wins. Otherwise choose the smallest profile
that honestly covers the risk:

- `lean` — localized, reversible, mechanically gated work.
- `standard` — normal non-trivial product work; the default.
- `high` — security, data migration, concurrency, public contracts, or a cut
  already shown to produce conflicting reviews.

Profiles may escalate on recorded evidence. Do not select `high` merely
because multiple agents are available. Provider/model choice is a named roster
in `${ANVIL_HOME:-$HOME/.anvil}/config.yaml`; never hard-code a model here.

## 3. Freeze and submit each run

For each selected `<id>`:

```sh
ANVIL_HOME="${ANVIL_HOME:-$HOME/.anvil}"
REPO="$(git rev-parse --show-toplevel)"
SPEC="$ANVIL_HOME/specs/<id>.md"

forged run start --bead <id> --repo "$REPO" --spec "$SPEC" --profile <profile>
forged run submit --run <id>
```

Add `--roster <name>` to `run start` only when the operator selected a
non-default roster. The start response freezes the resolved protocol, profile,
roster, and hashes in the ledger. The submit response must contain a controller
identity and host (`herdr` or visible `process` fallback).

`submit` is the detachment primitive. Never append `&`, use `nohup`, create a
PID file, or keep the lead agent polling to preserve the job. Repeating submit
while the controller is live adopts the same controller instead of duplicating
work.

## 4. Hand back durable inspection and control

Report the run id, chosen profile/roster, controller host and attach hint, then
return control to the user. A later Claude, Codex, or other agent can inspect
the same run with:

```sh
forged overview --run <id>
forged run status --run <id>
forged session list --run <id>
forged events --run <id> --limit 100
```

When a Herdr attempt is live, use the attempt id from `session list`:

```sh
forged session read --attempt <attempt-id> --lines 120
forged session message --run <id> --attempt <attempt-id> \
  --message '<operator guidance>' --requested-by '<human-or-agent>'
```

Without live-intervention capability, the message is ledgered and delivered at
the next provider boundary. To switch provider families for a live run, wait
for a durable stage boundary and use:

```sh
forged run revise-roster --run <id> --roster <name> --reason '<why>'
```

Never mutate a live attempt's provider assignment.

## Stop conditions and authority

- A clean slice ends at one reviewed **draft PR**. The human decides whether
  to merge it.
- Gate failures, conflicting reviews, exhausted retries, and unavailable
  providers remain visible durable outcomes. Do not hide them by starting a
  second run.
- Forged may use Beads, Git, GitHub, and Herdr through its typed contracts.
  This skill must not duplicate their state machines.
- All Anvil/Forged state stays under `$BEADS_DIR` and `$ANVIL_HOME`; never add
  `.beads`, settings, or orchestration files to the target repository.
