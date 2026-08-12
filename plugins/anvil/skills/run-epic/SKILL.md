---
name: run-epic
description: "Hand a locked Anvil epic to Forged for durable wave execution. Freezes the Beads inventory and profile/roster, submits a detached Herdr-backed controller, auto-merges only mechanically clean child slices into the integration branch, and ends at one draft PR to the default branch or an explicit input-required stop."
---

# /anvil:run-epic — hand a long-horizon epic to Forged

Use this after the user accepts the epic direction and `/anvil:adjudicate` has
locked the plan map. The lead agent still owns the conversation and spec; from
this point **Forged** owns execution. It reads Beads readiness, runs child
slices in waves, and records every transition so the initiating session can
disconnect.

## Preconditions

- `$BEADS_DIR` is set and the epic plus its children exist there.
- The epic plan map exists at
  `${ANVIL_HOME:-$HOME/.anvil}/specs/<epic-id>.md`.
- Every child description has the absolute `spec:` pointer produced by
  `/anvil:plan`; ready children have locked specs, while downstream work may
  remain blocked.
- `forged doctor`, `gh auth status`, and repository cleanliness checks pass.

## 1. Choose profile and roster

Use `standard` unless the operator selected another profile. Choose `lean` for
a small, low-risk epic with strong mechanical gates; choose `high` only for
security, migration, concurrency, public-contract risk, or prior conflicting
evidence. Forged can escalate a stored profile on named evidence, so a large
fixed panel is not the price of admission.

The roster is a named entry in `$ANVIL_HOME/config.yaml`. Do not encode Claude,
Codex, Fable, Opus, or any model id in this skill. A provider outage should be
handled by selecting/editing a roster, not by rewriting the epic workflow.

## 2. Freeze the epic and submit its controller

Resolve the checkout and submit:

```sh
ANVIL_HOME="${ANVIL_HOME:-$HOME/.anvil}"
REPO="$(git rev-parse --show-toplevel)"
EPIC=<epic-id>

forged epic start --epic "$EPIC" --repo "$REPO" \
  --spec "$ANVIL_HOME/specs/$EPIC.md" --profile <profile>
forged epic submit --epic "$EPIC"
```

Add `--roster <name>` only for an operator-selected non-default roster and
`--base-ref <branch>` only when the operator explicitly named the target. The
start freezes inventory and execution defaults. Submit returns the durable
controller identity; repeating it while live adopts the same controller.

Do not invoke a Workflow tool, shell-detach a process, create a timer, or arm
`watch-epic`. Detached execution plus the ledger replaces all of those.

## 3. Understand Forged's authority

- Beads is the readiness and dependency authority.
- Child slices execute through the same adaptive slice protocol as
  `/anvil:dispatch`.
- Only a mechanically clean child—gate passed, approving terminal verdict,
  and no BLOCKER/HIGH finding—is made ready and squash-merged into
  `forged/epic-<epic-id>`.
- Forged never auto-merges the integration branch to the default branch. A
  completed epic ends at one **draft PR** for human adjudication.
- Ambiguity, no-ready state, a non-clean child, or a failed effect becomes a
  durable `inputRequired` stop. No cognitive replan or hidden five-agent panel
  is injected by the scheduler.

## 4. Reconnect, intervene, and resume

Any later agent session can use:

```sh
forged overview --epic <epic-id>
forged epic status --epic <epic-id>
forged events --run <epic-id> --limit 200
```

The overview includes waves, children, active provider sessions, Herdr attach
state, gates, findings, artifacts, interventions, usage, pause/input state, and
the final PR. The MCP `overview` tool exposes the same projection to the MCP
App.

Useful controls:

```sh
forged epic pause --epic <epic-id> --reason '<reason>'
forged epic resume --epic <epic-id> --reason '<reason>'
forged epic resolve --epic <epic-id> --child <child-id> --note '<resolution>'
forged epic submit --epic <epic-id>
```

Resolve means the lead agent or user has updated/adjudicated the held spec or
input. For a child-specific stop, resolve clears the old terminal binding so
the next wave starts a fresh child run generation from the adjudicated spec;
it never silently accepts the unclean run. Submit again after resolve; it
starts the next controller generation only when the previous one is no longer
live.

For a child run, use the run/session commands documented by
`/anvil:dispatch`, including boundary-safe roster revision and Herdr messages.

## Report

After initial submission report only what is already durable: epic id,
integration branch, frozen profile/roster, controller host/attach hint, and the
overview command. On reconnect report merged vs held children, the explicit
stop reason, and the draft epic PR when present. Never count an unfinished
human adjudication as success.
