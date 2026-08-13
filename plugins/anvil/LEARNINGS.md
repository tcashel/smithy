# LEARNINGS — evidence from the Anvil bare-parts experiment

Durable engineering notes, not marketing. These sections preserve the evidence
from Anvil's Claude Workflow implementation, including approaches that are no
longer active.

## 0. Outcome: keep the lead-agent UX; move execution into Forged

The experiment answered its question. A single lead-agent conversation plus
Anvil planning/adjudication skills is the right front door. The execution stack
was not: provider-specific Workflow state, fixed large panels, shell detachment,
and scheduled re-invocation duplicated orchestration and made continuation
depend on one harness.

As of Anvil 0.3, Smithy owns planning through spec lock. Forged owns cognitive
stage contracts, proportional topology, provider/model roster resolution,
dispatch, gates, review/remediation, epic waves, durable handoff, and results.
Herdr owns process/pane transport. The old execution workflows and watch layer
were deleted, while the evidence below remains to explain why the replacement
has the contracts it does.

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

**Where this went.** The Workflow-era execution atom had already stopped spawning a
CLI — its implementing agent was a workflow subagent returning a validated object, so
there was no exit code to mistrust and no stream to parse (see §11). That whole atom
is gone; Forged owns the process boundary now, and its ledger, not an exit code, is
the verdict. The lesson survives the move: the moment you *do* shell out to a
long-running process, trust the durable record over the pipeline status — and ask
first whether you need to spawn one at all.

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
but a third **model family**: `plan-critique-improve.js` ran a third leg that handed
the same critique prompt to the `codex` CLI
(`codex exec --sandbox read-only`) and relayed its findings back in the same contract.
Two instances of one model share blind spots — and share hallucinations — so their
agreement is weaker evidence than it looks. Agreement across families cannot arrive by
that route, which makes it the strongest signal the panel produces.

This is not a hunch. The codex leg caught merge-blocking defects in four consecutive
drover rounds, findings the same-family critics did not raise. That is why it was wired
in as structure rather than left as tribal knowledge the operator had to remember to run
by hand. It stayed strictly optional: when `codex` was absent or the invocation failed,
the leg reported itself unavailable — it never fabricated a third opinion — and the
panel degraded to exactly the two-critic behavior above. Going past three is still
diminishing returns.

**The same argument applied after the code was written.** The execution atom reviewed
every draft PR twice: `anvil-reviewer` and a codex relay, findings tagged by source and
merged, with the severer of the two verdicts winning — a reviewer that found a blocker
is not outvoted by one that did not look in the same place. Reviewing is where
corroboration is cheapest to act on, because the fix round is already there. That atom's
post-fix re-review deliberately skipped codex: that verdict was informational (the atom
stopped either way), and a second full pass is real money for a number nothing branches
on.

**Where this went.** Every artifact named above is deleted, and
`scripts/validate.sh` keeps them deleted: `plan-critique-improve.js` and
`agents/reviewer.md` are both on its legacy-paths list. Anvil no longer owns a review
stage at all. What survived is the finding, not the wiring — `/anvil:critique` still
buckets corroborated/single/conflicting and still prefers a second model family over a
second instance, but it scales topology to risk and uses the host harness's native
delegation instead of a bundled workflow shelling a CLI. Post-lock review belongs to
Forged, against the operator's roster. Read this section as why those contracts exist,
not as a description of code in this repository.

## 4. The atom stops at a draft PR

The execution atom is fixed: launch -> quality gate -> draft PR -> review ->
ONE auto-fix round (a constant in the workflow, deliberately not a knob) -> stop.
It never auto-merges.

Sessions are jobs, not shows — "Plan. Run. Review. Ship. Don't watch." The point of
stopping at a draft is that the human adjudicates the merge. The loop does the toil
(write, gate, open, review, fix once) and then hands a reviewable artifact to a person.
A single auto-fix round catches the cheap review misses without letting the agent grind
indefinitely against findings it can't resolve. More rounds invite thrash; merge
authority stays human.

**Amended for the epic path (2026-08): "never merges" means never merges to the
DEFAULT branch.** Inside an epic, a CLEAN slice — quality gate passed, review ran, no
BLOCKER/HIGH from either reviewer — may auto-merge into the epic's INTEGRATION branch
(`anvil/epic-<id>`), because without that the wave loop deadlocks on a human at every
slice and "kick it off and come back" is fiction. The integration branch is the
autonomy boundary: wrongness lands on a branch you can delete, never on the branch
teammates pull. The epic ends as ONE draft PR (integration → default), so the human
adjudication the atom used to demand per slice is batched at the epic boundary — moved,
not removed. Anything short of clean still stalls for a person, and nothing anvil runs
ever merges to the default branch.

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

**Where this went.** Nothing in this repository spawns, polls, or reaps a job any
more. The implementing agent stopped being a spawned process first (§11), and the last
two callers of this pattern — the `codex` legs in the critique panel and the review
stage — went with the Workflow execution path. `/anvil:dispatch` now forbids the whole
shape by name: no `&`, no `nohup`, no PID file, no lead-agent poll loop. `forged run
submit` is the detachment primitive and the ledger is the durable status file, which is
these three rules relocated into a service that outlives the session. Treat the section
as the reason Forged's handoff has a durable record and a deadline — and as a live
warning for any future code that *does* shell a long job — not as guidance for a skill
here.

## 11. Prefer a sanctioned subagent to a spawned CLI

The implement stage originally shelled out to `claude --print
--dangerously-skip-permissions`, and everything painful about it followed from that one
choice. A spawned CLI is outside the session, so it needed its own permission story
(a dangerous flag, and a safety classifier that — rightly — refused the spawn unless it
could see a human had asked for it), its own lifetime management (detach, poll, deadline,
kill), and its own result channel (a stream sidecar, a verdict grepped out of a log).
Three separate live failures on drover came out of that one decision, and each fix made
the machinery larger.

A workflow `agent()` is inside the session. It is a sanctioned subagent: it inherits the
operator's permission mode, returns a schema-validated object, and is bounded by the
workflow runtime. Switching the implement stage to one deleted the permission flag, the
consent relay, the detached spawn, the poll loop, the PID file, and the log-grep verdict
— a few hundred lines of hard-won machinery replaced by an ordinary `agent()` call. It
also made the stage resumable for free, because `agent()` results cache by (prompt, opts)
and a log file never could.

The lesson is not "wait loops are wrong" — §10 is still correct where it applies. It is
that a whole class of hardening exists only to compensate for working outside the
sanctioned boundary, and the cheapest fix is usually to step back inside it. When a
workaround keeps growing, check whether the thing being worked around is load-bearing.

The honest cost: isolation is now prompt-scoped rather than process-scoped. A subagent
can pick up ambient project context (the target repo's `CLAUDE.md`) that a bare
`claude --print` would not have seen, so §1 gets a little weaker — the spec is still the
sole instruction, but it is no longer the only thing in the room. That is a real trade,
and it is worth it.

## 12. Lock late — the rolling wave

For a multi-slice epic, a spec locked at time zero for wave 3 is fiction with
authority: it passes every gate a true spec passes, the critics faithfully critique
the fiction, and the implementing agent builds against assumptions wave 1 already
falsified. The failure mode is not vagueness (the open-questions gate catches that) —
it is confident staleness, which the gate launders.

So the epic path locks only the frontier. What IS knowable up front gets planned in
full: the goal, the cut lines, and above all the SEAM CONTRACTS between slices —
when contracts hold, re-speccing a late slice after reality shifts is cheap. Every
downstream slice is a STUB whose `- [ ] ASSUMES:` ledger items state, checkably, what
it needs from upstream; the existing lock gate holds stubs off `bd ready` with zero
new mechanism. Between waves, a replan checkpoint verifies each ledger against the
integration branch's actual merged diffs — evidence, not optimism; an unverifiable
assumption counts as broken — and promotes a proven stub through the normal critique
panel, flipping it ready only at zero cruxes. Cruxes queue for the operator; a
majority of broken assumptions means the CUT is wrong, and recutting is a human call.

The principle: **only lock what is about to be built — the lock is precious because
it is late.** Detail written early about a late wave is a liability, not diligence:
it will be wrong, and it will look authoritative.

## 13. Sandbox asymmetry: the read-only legs get the harder cage

The codex legs — critics and reviewer, the roles that must never write — ran under an
OS-enforced sandbox (`codex exec --sandbox read-only`, Seatbelt on macOS). The
implementing agent — the role that must write — had no such cage: its containment was
structural (a disposable worktree outside the repo, commits that only ever reach a
draft PR or an integration branch, never the default branch). Mechanical enforcement
where a guarantee is cheap, structural containment where capability is the point.
That is the right way round: a critic that cannot write cannot drift into "fixing",
and an implementer's blast radius is bounded by what its outputs are allowed to reach,
not by pretending it doesn't need write access. When adding a new leg, pick its cage
deliberately: read-only role → mechanical sandbox; read-write role → structural
boundary plus human adjudication at the exit.

## 14. Price the loop, not the seat: the strongest model belongs where defects originate

The first dogfooded epic priced every seat from its transcripts. The implement stage
was ~10% of the epic's API-equivalent cost; the review + re-review + fix loop was
~43% — and on the hard slice (a portable-sh state machine) that loop ran ~5× the
implement stage's cost, cleaning up 10 BLOCKER/HIGH escapes from an opus build that
the fable fix agent then cleared in one round. Judging the implementer seat by its
own line item ("opus is half price") optimizes the cheap column and inflates the
expensive one: every escaped defect is paid for again downstream, at review prices,
by the stronger model anyway.

So the roster inverts: **fable implements by default**, and `implementModel:"opus"`
is the opt-in for genuinely simple slices — not the other way round. (`"codex"` hands
the build to the other model family via a relay, which flips the review asymmetry:
the fable reviewers then judge work from a family whose blind spots they don't
share.) The same audit found the opposite mismatch at the bottom: setup, frontier,
resolve, quality-gate, and PR seats — pure instruction-following, 700–7k output
tokens each — were burning flagship rates for ~16% of the epic. Those pin to sonnet.
The merge seat stays on fable deliberately: it is the one plumbing agent doing
security-load-bearing verification (PR base check before an auto-merge), and it
costs pennies.

The principle: cost-tune a pipeline by tracing where defects are *created* and where
they are *paid for*, then put capability at the origin and thrift in the plumbing —
never the reverse.

**Where this landed.** The seat-by-seat model pins above are history: they described
Anvil's own Workflow roster, which no longer exists. The same economics now live in an
operator-configured Forged roster — `mixed`, `all-codex`, `all-anthropic` in
`$ANVIL_HOME/config.yaml` — chosen independently of the `lean`/`standard`/`high`
assurance profile, and never committed to this repository. The principle survived the
rewrite; the hard-coded pins did not.
