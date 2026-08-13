# The anvil epic: plan map, stubs, and slicing

An **epic** is work too big for one reviewable draft PR. Anvil represents the
plan as a map plus ordinary Beads issues and dependency edges; Forged later
freezes that inventory and composes its slice protocol in waves.

**Lock late.** Only the frontier (wave 1) gets full, locked specs. Everything
downstream stays a blocked STUB until a replan checkpoint proves its assumptions
against merged reality. Detail written early about a late wave is a liability:
it will be wrong, and it will look authoritative.

## Path selection (single spec vs epic)

Choose **single spec** when ALL hold — and on any doubt:

- The change fits one reviewable draft PR.
- The spec stays under ~200 lines.
- No internal ordering — nothing in it must merge before anything else in it.

Choose **epic** when the work splits into two or more slices where one consumes
what another produces, or where seam contracts between parts need adjudicating.

State the call and the reason in one line and let the operator confirm. The
single-spec loop is the default; the epic path must be *earned* by real
structure, never picked for ceremony.

## Slice sizing (the craft)

- **Too big**: the slice's spec would bust ~200 lines; one auto-fix round would
  plausibly not converge; a review would span unrelated subsystems. Split it.
- **Too small**: the spec would be longer than the diff it produces; acceptance
  criteria merely restate the diff; the slice cannot fail in an interesting way;
  it retires no risk or assumption. Merge it into its neighbor.
- Prefer **vertical** slices (a working end-to-end sliver) over horizontal
  layers. Every slice must leave its base branch shippable.
- Order waves **risk-first**: the slice that validates the epic's riskiest
  assumption goes in wave 1, not wave 3.

## The plan map (the epic's spec body)

Lives at `${ANVIL_HOME:-$HOME/.anvil}/specs/<epic-id>.md`, exactly like any spec. Sections:

```markdown
# <epic title — conventional-commit format; becomes the epic→main PR title>

## Goal
<the observable end state of the WHOLE epic, plus explicit non-goals>

## Cut Lines
<the slices, one line each, and WHY each boundary sits where it does>

## Seam Contracts
<interfaces, data shapes, invariants BETWEEN slices — the part planned in full
detail up front, because when contracts hold, re-speccing a late slice after
reality shifts is cheap. Name each contract, its producer slice, its consumers.>

## Waves
<wave 1: <child ids> · wave 2: <child ids> · … — plus one line on why this order
(risk-first). A child's wave = 1 + max(wave of its dependencies).>

## Assumption Ledger
<per downstream slice: the checkable statements about upstream reality it
depends on. These are copied into each stub's Open Questions as ASSUMES items.>

## Open Questions
<cut-level cruxes for the operator; same lock-gate rule as any spec>
```

The epic issue's description carries `kind: epic` on its first line (plus a
label such as `anvil-epic` if the installed bd supports labels).

## Children and dependency edges

Every slice is an ordinary bd issue whose spec lives at
`${ANVIL_HOME:-$HOME/.anvil}/specs/<child-id>.md`. Wire the graph so `bd ready` does the
sequencing (the exact dep verb varies by bd version — the contract is what
matters):

- each downstream child is **blocked by** the upstream slices it consumes;
- the epic issue is **blocked by every child**, so the epic itself goes ready
  only when all children are done — that readiness IS the "open the epic→main
  PR" signal.

## Wave-1 specs vs downstream stubs

**Wave 1** children get full specs in the normal schema (`schema.md`), then the
normal critique → adjudicate → ready path.

**Downstream** children get a STUB — deliberately not implementable, deliberately
blocked by the lock gate:

```markdown
# <child title — conventional-commit format>

## Context

STUB — wave <n> of epic <epic-id>. Not yet promoted; do not implement.

## What We're Building (sketch)
<2-5 sentences of intent — enough to critique the cut, not enough to build from>

## Acceptance Sketch
<the shape of done, not mechanically checkable yet>

## Open Questions

- [ ] ASSUMES: <checkable statement about upstream reality, from the ledger>
- [ ] ASSUMES: <one bullet per assumption — each verifiable against merged diffs>
```

The `- [ ] ASSUMES:` items keep the stub off `bd ready`. When Forged reaches a
no-ready boundary it records `inputRequired`; the lead agent then verifies the
assumptions against the integration branch, expands the stub, and runs the
normal critique → adjudicate path. After promotion it calls `forged epic
resolve` and resubmits. Forged does not invent a cognitive replan. A broken
assumption stays blocked with its evidence—that is the gate working.
