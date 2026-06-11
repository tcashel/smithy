# Phase 1 — Research

The spec is the sole input the implementing agent sees, so research exists to
move facts from the repo into your head, and from there into the spec. Use only
read-only tools: `read`, `grep`, `glob`, and read-only bash (`git status`,
`git log --oneline -20`, `ls`, `cat package.json`, etc.).

## What to establish (in rough order)

1. **The stack and layout.** Language, package manager, build system, where
   source/tests/config live. Read the repo's README and any CLAUDE.md — YOU may
   read them; the implementing agent will not, so anything load-bearing must be
   copied into the spec.
2. **The quality gates.** What commands prove the repo healthy (lint, typecheck,
   test, validate)? Run nothing mutating; just identify them. These become the
   spec's Quality Gates section, and they must run without interactive auth.
3. **The blast radius.** Which files will the change touch? Open every one you
   intend to cite. A path cited but never opened is the #1 source of BLOCKER
   critique findings.
4. **The conventions.** Naming, error-handling, test patterns in the
   neighborhood of the change. The agent will imitate whatever you point at —
   point at the right exemplar file.
5. **Prior art and integration points.** Does something similar already exist
   in-repo? How does existing code reach the new code? An unstated integration
   point becomes an agent guess.

## What to record

Keep working notes in the conversation (NOT in the repo, NOT in the spec yet).
For each fact note where it came from (`path:line`) so the spec can cite it.
Surface wrong assumptions to the operator now — they are cheap here and
expensive after dispatch.

## When to stop

Research is done when you can answer, without re-opening the repo:

- What does "done" look like, observably?
- Which files change, and what do they look like today?
- What commands prove it works?
- What would a literal-minded agent get wrong if the spec stayed silent?

Anything still unanswerable is an **Open Question** — carry it into the draft
honestly rather than papering over it. If the operator already produced a
plan-mode plan, verify its file claims instead of re-deriving them, then move on.
