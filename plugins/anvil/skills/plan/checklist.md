# Phase 3 — Self-check (run before writing the file)

The one test that matters: **imagine an agent with a fresh worktree and ONLY
this spec body** — no conversation, no CLAUDE.md, no memory of your research.
Can it finish without asking a single question? Walk these checks; fix the spec
where any fails. Do not lock with a known failure.

## Self-containment

- [ ] Every concept, convention, and constraint the agent needs is IN the body
      (not "as discussed", not "per the repo's usual pattern").
- [ ] Every file path cited was opened during research and exists. Line numbers
      (if any) were verified.
- [ ] The exemplar file to imitate (if conventions matter) is named.
- [ ] No decision is deferred to the agent — no "choose an appropriate X",
      "use best practices", "handle errors sensibly".

## Acceptance criteria

- [ ] Each criterion is mechanically checkable (read the diff or run a command).
- [ ] No criterion could be satisfied by broken code read literally.
- [ ] Every criterion traces back to What We're Building (no scope creep).
- [ ] Failure modes are specified wherever the change involves I/O, user input,
      or external commands — what happens on error is written down.

## Quality gates

- [ ] The commands are exact, runnable from the repo root, and listed one per line.
- [ ] None can block on interactive auth (signing, login prompts — LEARNINGS §8).

## Form

- [ ] H1 is conventional-commit format, lowercase, ≤ 70 chars (it becomes the
      PR title verbatim).
- [ ] All six schema sections present, in order; no YAML frontmatter; no outer
      fence.
- [ ] Under ~200 lines unless the change is genuinely large.
- [ ] No contradiction between sections (criteria vs notes is the usual spot).

## Honesty

- [ ] Everything unresolved is an explicit `- [ ]` in Open Questions — and you
      accept that any remaining one keeps the spec OFF the ready frontier.
- [ ] Nothing in the body reads as a question, a TODO, or a "TBD".
