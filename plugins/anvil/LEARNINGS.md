# LEARNINGS — what Forge taught us that is portable to bare skills

Durable engineering notes, not marketing. Forge (the TypeScript prototype) ran the
plan -> critique -> adjudicate -> dispatch -> review -> fix pipeline as a real app.
anvil is the experiment that asks whether that value reassembles from bare Claude Code
primitives — skills, the Workflow tool, subagents, and beads. These are the lessons
worth carrying across, each with the reason it bit us.

## 1. The spec is the sole input

The implementing agent sees the spec body and nothing else — not the planning
conversation, not the repo's `CLAUDE.md`, not the critique transcript. Whatever context
lived in your head while planning is gone the moment the loop dispatches.

Consequence: a vague spec produces a confused agent, and you only discover it at the
draft PR. Planning's job is to make the spec self-contained — goal, constraints,
acceptance criteria, file-level pointers, and the test that proves it done — so the
agent never has to guess. In anvil the spec body is the file `~/.anvil/specs/<id>.md`;
treat it as the entire universe the implementer gets to read.

## 2. Trust the sidecar result event, not the pipeline exit code

When you run `claude --print --output-format stream-json --verbose ... | tee sidecar | filter`
under `set -uo pipefail`, the pipeline exit code lies. A downstream filter exiting, a
SIGPIPE, or a stream truncated mid-flight can all mask a real failure as success — or
report failure on a run that actually finished. This was the Forge PR #64 bug; do not
reintroduce it.

The source of truth is the terminal `{"type":"result"}` event in the sidecar file, and
it governs **both directions**:

- **Rescue a non-zero exit** when the sidecar shows a valid terminal result whose
  `stop_reason` is in the allowlist `end_turn | tool_use | stop_sequence` AND the final
  fenced block is well-formed (the expected `anvil-*` tag, parseable body, closed fence).
- **Force-fail a zero exit** when the sidecar shows no valid terminal result, or a
  `stop_reason` outside the allowlist, or a missing/malformed final fence.

Read the sidecar after the pipeline returns. The exit code is a hint; the result event
is the verdict.

## 3. A panel plus a synthesizer beats one critic — and a second model family beats a second instance

One critic gives you a single opinion with no way to weigh it. The value is not more
findings; it is **triage by agreement**. Run independent critics, then a synthesizer
that buckets every finding into:

- **Corroborated** — two or more critics raised it. Highest confidence; act first.
- **Single** — only one critic raised it. Real but unweighted; judge on merits.
- **Conflicting** — the critics disagree. Surface the tension for the human, don't
  silently pick a side.

That corroborated/single/conflicting split is the entire payoff, and two same-family
critics are the floor that produces it. What moved the ceiling was not a third *opinion*
but a third **model family**: `plan-critique-improve.js` now runs a third leg that hands
the same critique prompt to the `codex` CLI
(`codex exec --sandbox read-only`) and relays its findings back in the same contract.
Two instances of one model share blind spots — and share hallucinations — so their
agreement is weaker evidence than it looks. Agreement across families cannot arrive by
that route, which makes it the strongest signal the panel produces.

This is not a hunch. The codex leg caught merge-blocking defects in four consecutive
drover rounds, findings the same-family critics did not raise. That is why it is wired
into the workflow as structure rather than left as tribal knowledge the operator has to
remember to run by hand. It stays strictly optional: when `codex` is absent or the
invocation fails, the leg reports itself unavailable — it never fabricates a third
opinion — and the panel degrades to exactly the two-critic behavior above. Going past
three is still diminishing returns.

## 4. The atom stops at a draft PR

The execution atom is fixed: launch -> quality gate -> draft PR -> review ->
ONE auto-fix round (`autoFixRounds` default 1) -> stop. It never auto-merges.

Sessions are jobs, not shows — "Plan. Run. Review. Ship. Don't watch." The point of
stopping at a draft is that the human adjudicates the merge. The loop does the toil
(write, gate, open, review, fix once) and then hands a reviewable artifact to a person.
A single auto-fix round catches the cheap review misses without letting the agent grind
indefinitely against findings it can't resolve. More rounds invite thrash; merge
authority stays human.

## 5. Structured fenced output is the extraction contract

Agents communicate results to the harness through exactly one tagged fenced block, and
the harness extracts that block by its tag. The tags are a contract — get a character
wrong and extraction silently returns nothing.

The anvil tags (renamed from Forge's `forge-*`):

- critic emits ` ```anvil-spec-critique `
- the synthesizer step emits ` ```anvil-spec-recommendations `
- the reviewer emits ` ```anvil-review `

Severity labels are uniform everywhere: `BLOCKER / HIGH / MEDIUM / LOW`. One block per
agent, exact tag, closed fence. The well-formed-final-fence check in lesson 2 depends on
this contract holding.

## 6. Dedupe GitHub review comments with hidden markers

Publishing review findings to a PR is not idempotent by default — re-running the review
posts the same comment again. Embed a hidden HTML-comment marker carrying a stable
finding id in each published comment:

```
<!-- anvil-finding id=<stable-id> -->
```

Before posting, scan the PR's existing comments for that marker; skip or update instead
of duplicating. The id must derive from the finding's content/location, not from
anything that varies per run, or dedup fails. This keeps a re-reviewed PR clean across
repeated loop passes.

## 7. Worktrees are disposable; durable state lives out-of-repo

Each run happens in a throwaway worktree of the target repo. Anything written inside it
dies with it, and — just as important — anything anvil commits into it pollutes the
target repo. So keep all durable state operator-scoped and out-of-repo:

- beads in `$BEADS_DIR` (default `~/.anvil/beads`)
- spec bodies in `~/.anvil/specs/<id>.md`

anvil never commits a `.beads` file into the target repo, never edits the target's
`CLAUDE.md` or settings, and never requires each worktree to carry its own committed
file. Zero repo imposition is what makes the loop safe to point at someone else's
repository.

## 8. The quality gate must not be hostage to interactive signing

A headless loop dies the moment something blocks on human interaction. The canonical
trap: git commit signing via 1Password, which locks when the screen locks. You walk
away, the screen locks, the next signed commit hangs, and the whole "don't watch" run
stalls on a prompt no one is there to answer.

Headless hygiene rule: the quality gate and every commit in the loop must complete
without interactive auth. Disable signing for loop commits, or use a non-interactive
signing path, or sign out-of-band — but never let a gate depend on a credential that a
locked screen can revoke. If a step can prompt, it is not headless.

## 9. Open-questions lock gate before launch

Planning is allowed to surface open questions — things the spec can't yet answer. Those
questions are a hard gate: the spec does not lock, and the execution loop does not pick
it up, while any open question remains.

Why a gate and not a warning: per lesson 1 the spec is the sole input, so an unresolved
question becomes an agent guessing in the dark and a wasted draft PR. Resolve or
explicitly defer every open question, then lock the spec into a bd issue. Only locked
specs reach `bd ready`; only `bd ready` issues feed the loop. The gate is what keeps
ambiguity from ever reaching an implementing agent.

## 10. Supervising a long job needs a wait LOOP, not a wait

A build takes tens of minutes. A supervising agent's Bash tool caps a single call at
600 seconds. Those two facts are irreconcilable in one command, and pretending
otherwise is a structural bug rather than a tuning problem: the call is moved to the
background, the agent loses sight of the result it was created to report, and the
detached job is reaped along with the process tree. Drover run `wf_e55e6310-302` died
exactly this way — a single foreground `until grep -q IMPLEMENT_OK; do sleep 10; done`,
then a builder killed ~14 minutes in having only run `bun add`, and an agent that
(correctly) refused to invent a verdict it could no longer see.

Three rules follow, and they compose:

- **Spawn detached, and own the PID.** `nohup` (plus `setsid` where it exists) so a
  process-group kill aimed at the supervising shell cannot reap the job; write the PID
  down so it can be killed deliberately later. Detachment without a recorded PID just
  trades a dead job for an orphaned one.
- **Wait in bounded polls across many tool calls.** Each call self-bounds well under
  the cap and returns; the LOOP does the waiting. Print progress on every poll — event
  count, commits, whether the PID is still alive — so the next iteration is a decision
  rather than a blind repeat. Never end the turn while the job runs.
- **Have a deadline, and kill at it.** An orphan burning tokens in a worktree nobody
  is watching is worse than an honest failure. Report the timeout as its own outcome:
  "killed at the deadline" and "ran and failed" call for different fixes.

The general form: an agent supervising anything longer than its own tool timeout needs
a detached job, a durable status file, a poll loop, and a kill path. Any one of those
missing and "don't watch" becomes "can't tell".
