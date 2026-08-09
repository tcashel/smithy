---
name: plan
description: "Activates when the operator wants to turn an idea — or a plan-mode plan they just produced — into a locked anvil spec. Collaborate in plan mode to draft a self-contained spec in the anvil schema, write the body to ~/.anvil/specs/<id>.md, create a matching beads issue so it joins the ready-frontier, and enforce the open-questions lock gate before it can be marked ready. Use when the operator says they want to run something through anvil, when they've just produced a plan to ship to a coding agent, or when they invoke /anvil:plan."
---

# /anvil:plan

You convert an idea (or a plan the operator just produced in plan mode) into an **anvil spec** — the artifact that drives the whole pipeline. The spec is the sole input the implementing agent ever sees, so this skill's only job is to make it sharp before it's locked.

anvil is **operator-scoped and non-invasive**. Everything you produce lives OUT of the target repo:

- The spec body is a file at `~/.anvil/specs/<id>.md`.
- The spec's place in the work-list is a beads issue in `$BEADS_DIR` (default `~/.anvil/beads`).
- You never commit a spec into the repo, never edit the repo's `CLAUDE.md`, never touch repo settings, and never write a per-worktree file.

There is **no `forge` binary** in this world. You use only `bd`/`br`, `git`, plan mode, and ordinary file tools. If you ever reach for `forge spec save` or any `forge ...` command, stop — the anvil equivalent is "write the file + create a bd issue" below.

## What anvil does with your output

The spec you lock here is picked up downstream:

1. `/anvil:critique` runs the critic panel against the spec body and synthesizes recommendations.
2. `/anvil:adjudicate` resolves the cruxes and produces the improved, locked spec.
3. `/anvil:dispatch` reads `bd ready` (honoring `$BEADS_DIR`), launches a fresh-worktree agent against the spec body, runs the quality gate, opens a **draft** PR, runs the reviewer, and applies one auto-fix round — then stops for the operator to adjudicate the merge.

The launched agent sees **only the spec body**. Not this conversation, not your research notes, not the repo's `CLAUDE.md`. Anything the agent needs must be inside `~/.anvil/specs/<id>.md`. A vague spec produces a confused agent. That single fact is why this skill exists.

## When you're invoked

Two common paths:

- **Plan-mode handoff.** The operator produced a plan in plan mode and exited it. Reshape that plan into the anvil schema, then lock it.
- **Idea handoff.** The operator typed something like "plan X with anvil" or "use anvil to build Y". You don't have a plan yet — research the repo first, draft collaboratively in plan mode, then lock.

In both cases the operator expects, at the end, a spec file on disk and a matching ready bd issue.

## Workflow

You progress through four short phases. Each has a companion file (`research.md`, `schema.md`, `checklist.md`) you `read` only when you reach it — don't pull them all up front. They live in this skill's own directory. **`${CLAUDE_PLUGIN_ROOT}` is NOT expanded in skill text**, so resolve the directory at runtime:

```bash
PLAN_DIR="${ANVIL_PLUGIN_ROOT:+$ANVIL_PLUGIN_ROOT/skills/plan}"
[ -d "$PLAN_DIR" ] || PLAN_DIR="$(find "$HOME/.claude/plugins" -type d -path '*anvil/skills/plan' 2>/dev/null | head -1)"
```

Then `read` e.g. `$PLAN_DIR/schema.md` when you reach the relevant phase.

### Phase 1 — Research (skip if a plan-mode plan already covers it)

Read `research.md` before exploring. Use `read`, `grep`, `find`, and read-only `bash` (`git status`, `git log`, `cat package.json`, etc.) to learn the stack, the surrounding code, the behavioral contracts, the quality gates, and any open questions.

If the operator already produced a concrete plan-mode plan that names files, glance at those files to confirm they exist and the diff target is what the plan assumed — then move on. Report what you found in the conversation and let the operator catch wrong assumptions before they get baked in.

### Phase 2 — Draft (collaborate in plan mode)

Read `schema.md`. It defines the section structure and what good vs. bad content looks like in each. Draft the spec body **collaboratively in plan mode** — propose the spec, let the operator react, refine. Compose the body in your reply; do not add YAML frontmatter and do not wrap the whole thing in a fenced block. Aim for under 200 lines unless the change is genuinely large.

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
#    -> ~/.anvil/specs/$ID.md

# 3) Point the bd issue at the spec body so downstream skills can find it.
"$BD_BIN" update "$ID" --description "spec: $ANVIL_HOME/specs/$ID.md" --json
```

Notes on the bd step:

- Honor `$BEADS_DIR` on every `bd`/`br` call — that's what keeps state out of the repo. If the operator hasn't set up beads yet, point them at **`/anvil:setup`**.
- The exact `bd`/`br` subcommands and flags vary by binary version. If `--json` or a flag isn't supported, fall back to the plain form and parse the human output for the id; the contract is only "an issue exists whose body is the spec file, and it is ready iff there are no open questions."
- If you filed the issue **blocked** because open questions remain, tell the operator exactly which questions block it and that it will not appear in `bd ready` until they're resolved.

After locking, surface to the operator:

- the **issue id**,
- the **spec path** (`~/.anvil/specs/<id>.md`),
- whether it is **ready** or **blocked on open questions** (and which ones).

## Next step

Tell the operator the spec is locked and the next step is **`/anvil:critique`**, which runs the critic panel against the spec body and emits ```` ```anvil-spec-recommendations ````. Do not pre-critique your own draft here — write the cleanest spec you can and let the critique pass refine it.

## Things to avoid

- **Shelling out to `forge`.** There is no `forge` binary in anvil. The whole experiment is invalid if you call it. Use `bd`/`br` + file tools for the lock step.
- **Writing anything into the target repo.** No `.beads/` file committed, no `CLAUDE.md` edits, no repo settings, no per-worktree file. All state lives under `~/.anvil/`.
- **Adding YAML frontmatter or a fenced wrapper.** The spec file starts at `# <title>` and is the spec body verbatim.
- **Locking a spec ready with open `- [ ]` questions.** This violates the lock gate. Resolve them or file the issue blocked.
- **Citing a file you didn't open.** If the spec mentions `src/foo.ts:42`, `read` it first.
- **Asking the agent to decide.** "Decide on the retention strategy" is a bug, not an acceptance criterion. Make the call in the spec, or list it as an open question and let the gate hold the spec back — the launched agent has far less context than you do.
- **Vague acceptance criteria.** "Tests pass" and "code is clean" aren't checkable. The reviewer will reject them.
- **Drafting on turn 1 without research,** unless a plan-mode plan already did it.
