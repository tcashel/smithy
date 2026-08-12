---
name: critique
description: "Harden an Anvil spec in the lead session with proportional, provider-neutral critique. Uses the current harness's native delegation when available, scales from one critic to a cross-family panel only when risk warrants it, synthesizes corroborated/conflicting findings, and persists recommendations for /anvil:adjudicate."
---

# /anvil:critique — proportional spec review before handoff

Critique is still part of the user-facing planning conversation. It runs
**before** Forged takes ownership, because the user may change the direction in
response. This skill is harness-neutral: use the current host's native agent
delegation, not a bundled TypeScript Workflow and not a hard-coded model id.

## Resolve the spec

Accept a Beads id or an absolute path. Beads specs normally live at
`${ANVIL_HOME:-$HOME/.anvil}/specs/<id>.md`. Read the whole document and identify
the target repository so critics can verify cited files. Do not edit the spec;
`/anvil:adjudicate` is the sole write-back surface.

## Choose the smallest useful topology

The user's explicit assurance request wins. Otherwise:

- **Lean:** one adversarial pass for localized, reversible work with strong
  mechanical gates.
- **Standard:** two independent critics—correctness/contracts and
  completeness/self-containment—for normal non-trivial work.
- **High:** add a third, preferably cross-provider-family critic for security,
  migrations, concurrency, public contracts, or an epic cut with uncertain
  seams.

Do not turn every spec into a fixed panel. Add a critic only when its
independence can change a decision. If another provider family is unavailable,
say so; never fabricate a corroborating opinion.

## Run independent read-only critiques

When the harness supports native subagents, give each critic only the spec,
target repo, its angle, and read-only authority. Claude Code may use the bundled
`anvil-critic` agent; Codex or another harness should use its equivalent native
delegation. If native delegation is unavailable, perform the lean pass in the
lead session and disclose that independence was unavailable.

Every critic checks:

1. Every cited file/symbol against repository reality.
2. Each acceptance criterion for a literal but broken implementation.
3. Undefined failures, boundaries, ordering, and concurrency.
4. Contradictions, deferred product decisions, and scope creep.
5. For epic plan maps: slice seams, dependency direction, wave order, and
   whether each `ASSUMES` item is verifiable after upstream merges.

Use BLOCKER / HIGH / MEDIUM / LOW consistently. Findings must cite the spec
section or repository path and propose a concrete correction.

## Synthesize, don't vote

The lead session groups findings as:

- **Corroborated:** independently raised by at least two critics.
- **Single:** raised by one critic only.
- **Conflicting:** critics disagree about the same contract.

Agreement across provider families is stronger evidence, but severity and
evidence still matter more than vote count. Preserve conflicts and product
questions for the user; do not silently resolve them. Produce one fenced
`anvil-spec-recommendations` block with:

1. Summary and topology actually used.
2. Priority-ordered recommended edits.
3. Open questions.
4. Conflicts.
5. Findings triage with source/corroboration.
6. Confidence note, including unavailable independence/families.

Persist that exact block at:

```text
${ANVIL_HOME:-$HOME/.anvil}/specs/<id>.recommendations.md
```

Then hand the user to `/anvil:adjudicate`. Forged execution starts only after
the user is happy with the direction and adjudication locks the spec.
