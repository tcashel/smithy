# The anvil spec schema

The spec body is a markdown file with NO YAML frontmatter and NO outer fenced
wrapper. It starts at the H1 and contains exactly these sections, in this order.
It mirrors the Forge spec contract.

```markdown
# <title>

## Context

## What We're Building

## Acceptance Criteria

## Implementation Notes

## Quality Gates

## Agent Instructions
```

## The title (H1)

The H1 becomes the PR title **verbatim**, so it must be conventional-commit
format: `<type>(<scope>): <imperative summary>` — all lowercase, ≤ 70 chars.

- Good: `feat(dispatch): label anvil draft prs with quality-gate status`
- Good: `ci: validate plugin manifests and workflow scripts on push`
- Bad: `Improve the CI` (no type, not imperative, capitalized)
- Bad: `feat: add the thing we discussed` (means nothing without the conversation)

## Section by section

### Context

Why this work exists and what the implementing agent must know about the
surrounding system. The agent has NEVER seen this repo before. Name the stack,
the relevant directories/files (only ones you verified exist), and any
constraint that shapes the solution.

- Good: "This repo is a Claude Code plugin marketplace. CI does not exist yet.
  The two checks that matter are `claude plugin validate .` and
  `node --check plugins/anvil/workflows/*.js` (see CLAUDE.md 'Validate before
  you call it done')."
- Bad: "We want better CI." (no system context, agent must guess everything)

### What We're Building

The goal, stated as the observable end state — what exists after the change
that doesn't exist now. One or two paragraphs. Scope boundaries belong here:
say what is explicitly OUT of scope.

- Good: "A GitHub Actions workflow at `.github/workflows/validate.yml` that
  runs on push and PR to main and fails if either check fails. Out of scope:
  running the plugin, testing skills, publishing."
- Bad: "CI that makes sure everything works." (untestable, unbounded)

### Acceptance Criteria

A checklist the reviewer can verify mechanically. Each criterion must be
checkable by reading the diff or running a command — never a vibe.

- Good: "- `.github/workflows/validate.yml` exists and triggers on `push` to
  `main` and on `pull_request`."
- Good: "- The job fails when `node --check` fails (verified by the workflow
  using the command's exit code, not `|| true`)."
- Bad: "- CI works correctly." / "- Tests pass." (correct according to what?)

### Implementation Notes

File-level pointers and decisions you've already made, so the agent doesn't
re-make them. Cite only paths you opened. If order matters, say so. If a
decision was contentious, state the decision — not the debate.

### Quality Gates

The exact commands the quality-gate step will run, one per line. These must be
runnable in the repo with no interactive auth (LEARNINGS §8). If the repo has
no test suite, say which commands stand in.

### Agent Instructions

Direct orders to the implementing agent: commit conventions, what NOT to touch,
how to know it's done. Standard lines worth including:

- Commit only intentionally-changed files (`git add <path>`, never `git add -A`).
- Conventional commits.
- Do not push or open a PR — anvil does that.

## Open Questions block

While drafting, track unresolved items honestly:

```markdown
## Open Questions

- [ ] should the workflow also run on a schedule?
```

This block is the LOCK GATE: the spec cannot be marked ready while any `- [ ]`
remains. Resolve each (write the answer into the proper section, delete the
bullet) or file the bd issue blocked. A resolved question leaves NO trace in
the body — the implementing agent never sees "open question" language.
