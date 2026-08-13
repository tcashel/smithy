---
name: plan
description: "Activates when the operator wants to turn an idea — or a plan-mode plan they just produced — into a locked operator-scoped Anvil spec, or into an epic (plan map + wave-1 specs + blocked stubs) when the work is too big for one reviewable PR. Collaborate in plan mode, create matching Beads issues and dependency edges, and enforce the open-questions lock gate. Use when the operator wants to run something through Anvil or invokes /anvil:plan."
---

# /anvil:plan

You convert an idea (or a plan the operator just produced in plan mode) into an **anvil spec** — the artifact that drives the whole pipeline. The spec is the sole input the implementing agent ever sees, so this skill's only job is to make it sharp before it's locked.

anvil is **operator-scoped and non-invasive**. Everything you produce lives OUT of the target repo:

- The spec body is a file at `${ANVIL_HOME:-$HOME/.anvil}/specs/<id>.md`.
- The spec's place in the work-list is a beads issue in `$BEADS_DIR` (default `~/.anvil/beads`).
- You never commit a spec into the repo, never edit the repo's `CLAUDE.md`, never touch repo settings, and never write a per-worktree file.

Planning writes the spec and Beads graph directly. Do not start Forged here:
the user has not approved the direction yet, and `/anvil:dispatch` or
`/anvil:run-epic` owns that explicit handoff.

## What anvil does with your output

The spec you lock here is picked up downstream:

1. `/anvil:critique` applies a proportional independent review and synthesizes recommendations.
2. `/anvil:adjudicate` resolves the cruxes and produces the improved, locked spec.
3. `/anvil:dispatch` reads `bd ready`, freezes a proportional profile and
   provider roster, and submits the work to Forged. Forged implements, gates,
   reviews, remediates as the stored profile requires, and stops at a draft PR.

The launched agent sees **only the spec body**. Not this conversation, not your research notes, not the repo's `CLAUDE.md`. Anything the agent needs must be inside `${ANVIL_HOME:-$HOME/.anvil}/specs/<id>.md`. A vague spec produces a confused agent. That single fact is why this skill exists.

## When you're invoked

Two common paths:

- **Plan-mode handoff.** The operator produced a plan in plan mode and exited it. Reshape that plan into the anvil schema, then lock it.
- **Idea handoff.** The operator typed something like "plan X with anvil" or "use anvil to build Y". You don't have a plan yet — research the repo first, draft collaboratively in plan mode, then lock.

In both cases the operator expects, at the end, a spec file on disk and a matching ready bd issue.

## Workflow

You progress through four short phases. Each has a companion file
(`research.md`, `schema.md`, `epic.md`, `checklist.md`) next to this SKILL.md.
Read each through the host's skill-relative resource mechanism only when you
reach it; do not pull them all up front or search provider-specific plugin
caches.

### Phase 1 — Research (skip if a plan-mode plan already covers it)

Read `research.md` before exploring. Use `read`, `grep`, `find`, and read-only `bash` (`git status`, `git log`, `cat package.json`, etc.) to learn the stack, the surrounding code, the behavioral contracts, the quality gates, and any open questions.

If the operator already produced a concrete plan-mode plan that names files, glance at those files to confirm they exist and the diff target is what the plan assumed — then move on. Report what you found in the conversation and let the operator catch wrong assumptions before they get baked in.

### Phase 2 — Choose the altitude, then draft (collaborate in plan mode)

First decide the **path**: single spec or epic. Read `epic.md` for the heuristics,
state your call in one line with the reason, and let the operator confirm.
**Single spec on any doubt** — the current loop produces great work, and the epic
path must be earned by real structure (multiple dependent slices, seam contracts
worth adjudicating), never picked for ceremony.

**Epic path:** draft the PLAN MAP instead of a spec — goal, cut lines, seam
contracts, waves, assumption ledger, per `epic.md`'s schema. The load-bearing
planning is the cut and the contracts: adjudicating those once beats adjudicating
ten micro-specs later. Only wave-1 slices get full specs now; everything
downstream becomes a stub. Then continue with Phase 3/4 below (the epic variant
of the lock is in `epic.md` + Phase 4's note).

**Single-spec path:** read `schema.md`. It defines the section structure and what good vs. bad content looks like in each. Draft the spec body **collaboratively in plan mode** — propose the spec, let the operator react, refine. Compose the body in your reply; do not add YAML frontmatter and do not wrap the whole thing in a fenced block. Aim for under 200 lines unless the change is genuinely large.

The schema (mirrors the Forge spec contract exactly):

```markdown
# <title>

## Context

## What We're Building

## Acceptance Criteria

## Implementation Notes

## Quality Gates

## Agent Instructions
```

**Title format matters.** The H1 becomes the PR title verbatim, so it must be conventional-commit format: `<type>(<scope>): <imperative>`, all lowercase, ≤ 70 chars. See `schema.md` for the rule and examples.

Track unresolved items honestly in an **Open Questions** block (unchecked bullets, `- [ ] ...`). These are the lock gate — see Phase 4.

### Phase 3 — Self-check

Run the checks in `checklist.md` mentally before you write the file. The most important one: imagine an agent who has never seen this conversation, with only the spec body and a fresh worktree. Can they execute it without asking a single question? If not, fix the spec.

### Phase 4 — Lock (write file + create bd issue)

This is where anvil diverges most from Forge — there is no `forge spec save`. You do it with bare primitives, and a lock gate guards it.

**OPEN-QUESTIONS LOCK GATE (hard rule).** A spec **cannot be marked ready** while it has any unresolved open question (`- [ ]`). If open questions remain:

- Resolve them with the operator now (make the call, write the answer into the relevant section, remove the `- [ ]`), OR
- Create the bd issue in a **blocked/open** state (not ready) so it stays off the ready-frontier until the questions are closed.

Never lock a spec ready with open `- [ ]` items. `/anvil:critique` and `/anvil:dispatch` trust that a ready spec has no unresolved cruxes; honoring the gate here is what makes that trust safe.

When the spec is clean (no open `- [ ]` items, or you're deliberately filing it blocked):

```bash
# Operator-scoped paths. Honor an overridden BEADS_DIR if the operator set one.
export ANVIL_HOME="${ANVIL_HOME:-$HOME/.anvil}"
export BEADS_DIR="${BEADS_DIR:-$ANVIL_HOME/beads}"
mkdir -p "$ANVIL_HOME/specs"

# 1) Create the beads issue first so its id names the spec file.
#    Use 'bd' if present, else 'br' (same surface). The H1 title is the bd title.
BD_BIN="$(command -v bd || command -v br)"
ISSUE_JSON="$("$BD_BIN" create "<title from the H1>" --json)"
ID="$(printf '%s' "$ISSUE_JSON" | jq -r '.id')"

# 2) Write the spec body to the operator-scoped specs dir, named by the issue id.
#    Use the 'write' file tool (shown here as the target path) — start at '# <title>',
#    no YAML frontmatter, no fenced wrapper.
#    -> $ANVIL_HOME/specs/$ID.md

# 3) Point the bd issue at the spec body so downstream skills can find it.
"$BD_BIN" update "$ID" --description "spec: $ANVIL_HOME/specs/$ID.md" --json
```

Notes on the bd step:

- Honor `$BEADS_DIR` on every `bd`/`br` call — that's what keeps state out of the repo. If the operator hasn't set up beads yet, point them at **`/anvil:setup`**.
- The exact `bd`/`br` subcommands and flags vary by binary version. If `--json` or a flag isn't supported, fall back to the plain form and parse the human output for the id; the contract is only "an issue exists whose body is the spec file, and it is ready iff there are no open questions."
- If you filed the issue **blocked** because open questions remain, tell the operator exactly which questions block it and that it will not appear in `bd ready` until they're resolved.

**Epic variant of the lock.** Same primitives, more issues:

1. Create the EPIC issue first (title from the plan map's H1; description's first
   line is `kind: epic`, plus an `anvil-epic` label if bd supports labels). Write
   the plan map to `$ANVIL_HOME/specs/<epic-id>.md`.
2. Create each child issue; write wave-1 children FULL specs (normal schema) and
   downstream children STUBS with `- [ ] ASSUMES:` ledgers (per `epic.md`).
3. Wire the graph: each downstream child **blocked by** the upstream slices it
   consumes; the epic **blocked by every child**. The exact dep verb varies by bd
   version — the contract is that `bd ready` surfaces children in wave order and
   the epic goes ready only when all children are done.
4. The gate applies per issue: wave-1 children go ready iff their specs have no
   open `- [ ]`; stubs stay blocked by their ASSUMES items BY DESIGN — never
   "resolve" an ASSUMES item to force a stub ready; the replan checkpoint does
   that against merged reality.

After locking, surface to the operator:

- the **issue id** (and for an epic: child ids grouped by wave),
- the **spec path** (`$ANVIL_HOME/specs/<id>.md`),
- whether it is **ready** or **blocked on open questions** (and which ones; for
  an epic, stubs blocked on ASSUMES are the expected steady state, not a problem).

## Next step

Tell the operator the spec is locked and the next step is
**`/anvil:critique`**, which chooses a risk-proportional topology and emits an
```` ```anvil-spec-recommendations ```` block. Do not pre-critique your own
draft here.

## Things to avoid

- **Starting Forged before approval.** Planning uses `bd`/`br` plus file tools;
  the dispatch skills own the later typed handoff.
- **Writing anything into the target repo.** No `.beads/` file committed, no `CLAUDE.md` edits, no repo settings, no per-worktree file. All state lives under `$ANVIL_HOME` (default `~/.anvil`).
- **Adding YAML frontmatter or a fenced wrapper.** The spec file starts at `# <title>` and is the spec body verbatim.
- **Locking a spec ready with open `- [ ]` questions.** This violates the lock gate. Resolve them or file the issue blocked.
- **Citing a file you didn't open.** If the spec mentions `src/foo.ts:42`, `read` it first.
- **Asking the agent to decide.** "Decide on the retention strategy" is a bug, not an acceptance criterion. Make the call in the spec, or list it as an open question and let the gate hold the spec back — the launched agent has far less context than you do.
- **Vague acceptance criteria.** "Tests pass" and "code is clean" are not checkable. Forged's review seats need explicit contracts.
- **Drafting on turn 1 without research,** unless a plan-mode plan already did it.
