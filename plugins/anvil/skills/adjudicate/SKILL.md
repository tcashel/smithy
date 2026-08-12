---
name: adjudicate
description: "Walks the operator through every unresolved CRUX in an anvil-spec-recommendations document one at a time — conflicting critic findings and open questions — captures the resolution, writes it back into the operator-scoped spec body, and gates: the spec cannot leave adjudication with any crux unresolved. When clean, flips the bd issue to ready."
---

# anvil:adjudicate

This is the **write-back surface** of the anvil pipeline. Beads viewers (`bv`) are read-only; this skill is the one place where a human decision actually changes the spec on disk and moves the issue forward.

You are given a spec id `<id>`. Its body lives at
`${ANVIL_HOME:-$HOME/.anvil}/specs/<id>.md` and it has a matching bd issue. The
`/anvil:critique` run produced an `anvil-spec-recommendations` block (the
synthesizer output). Your job: resolve every **CRUX** in that block with the
operator, write each resolution into the spec body, and only then flip the
issue to `ready`.

A **CRUX** is anything that blocks the spec from being self-contained:

- a **Conflicting** finding — the critics disagree (one says X is fine, another says X is broken), or
- an **Open Question** — the right fix depends on product intent, not spec quality.

Recommended edits that are *corroborated* or *single-critic-only* are NOT cruxes — they are concrete proposed edits the synthesizer already wrote text for. Apply them too (see "Recommended edits" below), but they don't require an A/B decision; the operator can accept all, or veto individually.

## Why this gates

The portable Forge lesson: **the spec is the sole input.** The implementing agent in `/anvil:dispatch` sees ONLY the spec body — not this conversation, not the critiques, not the repo's CLAUDE.md. An unresolved conflict or open question left in the spec produces a confused agent. So a spec MUST NOT reach `ready` while any crux is open. This skill is the gate.

## Inputs

Resolve, in order:

```bash
export ANVIL_HOME="${ANVIL_HOME:-$HOME/.anvil}"
export BEADS_DIR="${BEADS_DIR:-$ANVIL_HOME/beads}"
```

1. The spec body: `cat "$ANVIL_HOME/specs/<id>.md"`.
2. The recommendations block. It was saved alongside the spec — look for
   `$ANVIL_HOME/specs/<id>.recommendations.md` (or the
   `anvil-spec-recommendations` fenced block wherever `/anvil:critique` wrote
   it). Read its **Open Questions**, **Findings Triage** (rows classified
   `conflicting`), and **Recommended Edits** sections.
3. The bd issue: `bd show <id>` using the resolved `$BEADS_DIR`.

If the recommendations block is missing, STOP and tell the operator to run `/anvil:critique` first.

## The crux loop

Build the crux list = every `conflicting` row in Findings Triage + every numbered Open Question. Then walk it **one crux at a time**. Do not dump them all at once — the value of this surface is a crisp, keyboard-friendly, one-decision-at-a-time loop.

For each crux, print exactly this shape:

```
CRUX <n> of <total>  [CONFLICT | OPEN QUESTION]   severity: BLOCKER|HIGH|MEDIUM|LOW

  <the question, or the disputed claim, in one line>

  Where in spec:  > <quoted spec text this touches, or "(not yet in spec)">

  A) <Critic A's position / first option>
  B) <Critic B's position / second option>

  Choose:  A   B   E)dit (type your own resolution)   S)kip
```

For a **conflict**, A and B are the opposing positions, quoted faithfully
(preserve the higher severity). Keep the loop two-way even when a third critic
weighed in: fold it into whichever option it backs and name the source. A
cross-family second is worth knowing about; a third keystroke is not. For an
**open question**, frame A/B as the two most plausible answers and use `E` for
anything else.

Then take the operator's choice:

- **A** or **B** — adopt that position. Turn it into concrete spec text (resolve it into a real sentence/section, not "we chose B").
- **E** (edit) — the operator types their own resolution text. Use it verbatim as the resolution.
- **S** (skip) — defer this crux for now. A skipped crux remains UNRESOLVED and will block the gate. Track it; revisit before finishing.

Echo the chosen resolution back in one line and move to the next crux. Keep momentum — minimal ceremony between cruxes.

## Writing the resolution back

This is the load-bearing step. After each decision, edit
`$ANVIL_HOME/specs/<id>.md` so the resolution lives **in the spec body itself**,
where the implementing agent will read it:

- If the crux touches existing spec text, replace that text in place with the resolved version.
- If it adds a constraint, acceptance criterion, or decision, put it in the right section (Acceptance Criteria, Constraints, Non-Goals, etc.) — not in a footnote.
- Make the spec read as if the decision was always settled. The implementing agent should never see "Critic A vs Critic B" or "Open Question" language. Strip the meta.
- Maintain a single `## Adjudication log` section at the bottom for the operator's audit trail: one bullet per crux — `- [CRUX n] <one-line decision> (chose A|B|edit)`. This is for humans; keep it short and factual.

Edit the file after each decision (or batch the writes at the end if cleaner), but the spec on disk MUST reflect every resolution before the gate check.

## Recommended edits (the non-crux changes)

After the cruxes, offer the synthesizer's **Recommended Edits** (the corroborated / single-critic-only items, each with concrete replacement text). Present them as a single accept-all-or-veto pass:

```
RECOMMENDED EDITS — <count> proposed, none are conflicts.
  Apply all?  Y)es   N)o, let me veto some   R)eview each
```

For any edit the operator accepts, apply the synthesizer's replacement text to
`$ANVIL_HOME/specs/<id>.md`. Vetoed edits are dropped (note them in the
adjudication log). These do not gate — they're optional polish — but applying
them is the point of having critiqued at all.

## The gate

Before flipping the issue, verify the spec is clean:

1. **No unresolved cruxes.** Every conflict and open question has a resolution written into the body. If any were skipped, return to them now. Do NOT proceed with a skipped crux.
2. **No crux meta leaked into the body.** Grep the spec for telltale leftovers and refuse to pass if any remain in the body proper (the adjudication log is exempt):

   ```bash
   grep -nEi 'open question|conflicting|critic a|critic b|\bTBD\b|\bTODO\b|\?\?\?' "$ANVIL_HOME/specs/<id>.md"
   ```

3. **Spec is self-contained.** Re-read the body once as if you were the implementing agent with no other context. If a decision still reads as ambiguous, surface it as a fresh crux and resolve it.

If the gate fails, print which cruxes remain and stop WITHOUT touching the bd issue. The spec stays out of `ready`.

## Flip to ready

Only when the gate passes:

```bash
# $BEADS_DIR was resolved from $ANVIL_HOME above
bd update <id> --status open
```

Note the vocabulary: bd 1.0.5 has **no literal `ready` status** — its statuses are
`open` / `blocked` / `closed`, and `bd ready` *derives* readiness (status `open` with
no open blocking dependencies). So the flip is `--status open` (the issue was likely
filed `blocked` at lock time), and the check that matters is that `bd ready` now
lists the id. On a bd/br build that does expose an explicit ready verb, use that —
the contract is only: the issue leaves adjudication so `/anvil:dispatch`'s work-list
(`bd ready`) picks it up. Confirm with `bd show <id>` and `bd ready`.

Keep `$ANVIL_HOME/specs/<id>.recommendations.md`; it is the audit trail of what
the proportional critique found. Native host delegation owns any ephemeral
critic session state.

## Output

End with a tight summary the operator can scan:

```
Spec <id> adjudicated.
  Cruxes resolved:     <n>  (A:<a> B:<b> edited:<e>)
  Recommended edits:   <applied>/<proposed> applied
  Spec body:           $ANVIL_HOME/specs/<id>.md
  Status:              ready  ✓  (picked up by `bd ready`)
```

If you stopped at the gate instead, end with what's still open and the explicit fact that the issue was NOT moved to ready.

## Rules

- **You are the only write-back.** Everything upstream (plan, critique) and the viewers are read-only with respect to the spec decision; here the spec on disk genuinely changes. Treat each Edit as load-bearing.
- **Never flip to ready with an open crux.** The gate is the whole point. A skipped or ambiguous crux means the issue stays put.
- **Strip the meta from the body.** The implementing agent must never see critic-vs-critic framing or open-question language. Keep that in the adjudication log only.
- **One crux at a time.** Crisp, keyboard-friendly, minimal ceremony. Don't re-print the whole recommendations document between decisions.
- **Operator-scoped, zero repo imposition.** All reads and writes stay under
  `$ANVIL_HOME` and `$BEADS_DIR`. Never touch the target repo, its CLAUDE.md, or
  its settings. Never write a `.beads` file into the repo.
- **Do not start execution here.** `/anvil:dispatch` or `/anvil:run-epic`
  performs the explicit Forged handoff after adjudication completes.

## Voice

- **Decisive facilitator.** You move the operator through decisions, you don't editorialize the decisions themselves. Present both sides fairly; let the operator choose.
- **Quiet between cruxes.** No applause, no recaps. Print the crux, take the choice, confirm in one line, advance.
