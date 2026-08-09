// SPDX-License-Identifier: Apache-2.0
// anvil execute-review-fix — the EXECUTION ATOM.
//
// "Plan. Run. Review. Ship. Don't watch." This is the Run/Review half. For
// each bd-ready issue id passed as an arg it runs ONE unattended atom:
//
//   resolve spec -> worktree -> implement (subagent) -> quality gate
//     -> DRAFT PR -> review (anvil-reviewer + codex) -> ONE auto-fix round -> STOP.
//
// It NEVER auto-merges. The atom stops at a draft PR for human adjudication
// (LEARNINGS §4). Items flow independently through `pipeline` so one bad
// spec doesn't sink the batch.
//
// NON-INVASIVE / OPERATOR-SCOPED. This workflow never shells out to the
// `forge` binary — only `gh`, `bd`/`br`, `git`, and (for the second reviewer)
// `codex`. Every agent here is a workflow subagent, not a spawned CLI. All
// state stays out of the target repo: beads in $BEADS_DIR (~/.anvil/beads),
// specs in ~/.anvil/specs/<id>.md, run artifacts in ~/.anvil/runs/<id>/.
// Worktrees are disposable and need NO committed-in file of their own.
//
// The actual shelling-out is delegated to subagents that carry Bash. This
// supervisor only orchestrates: it composes prompts, decides ordering, and
// trusts the structured result each agent reports back.
//
// ── DURABLE RUN-STATE CAVEAT (where this may "land back at Forge", ADR-0030) ──
// A Workflow run is a single in-memory pass. There is NO durable, queryable
// cross-session run-state here: if the host dies mid-atom, nothing records
// "issue X reached draft-PR but not review" so a re-run can resume. Forge
// solved this with ~/.forge/runs/<id>/meta.json + a SQLite jobs table that
// `bd`/`gh` reconciliation reads back. anvil deliberately leans on EXTERNAL
// durable state instead — the bd issue's status and the PR's existence/labels
// on GitHub ARE the run-state — and each atom below is written to be
// idempotent against THAT (re-resolving the spec, reusing an existing PR via
// `gh pr view`, deduping review comments by hidden marker). The moment we need
// richer per-step resumption (partial fix rounds, token ledgers, retry
// budgets) is exactly the moment the experiment argues for the Forge app.

export const meta = {
  name: "execute-review-fix",
  description:
    "anvil execution atom: for each bd-ready issue, a subagent implements its spec in a disposable worktree, then the atom gates quality, opens a DRAFT PR, reviews it (anvil-reviewer plus codex when installed), runs one auto-fix round, and stops. Never merges.",
  phases: [
    { title: "resolve" }, { title: "implement" }, { title: "quality" },
    { title: "pr" }, { title: "review" }, { title: "fix" },
  ],
};

// One auto-fix round, then STOP — regardless of the re-review verdict.
// Never a second round, never a merge (LEARNINGS §4).
const AUTO_FIX_ROUNDS = 1;

// ── The implementing agent is a SUBAGENT, not a spawned CLI ───────────────────
// This stage used to shell out to `claude --print --dangerously-skip-permissions`
// and then supervise it: a stream sidecar, a verdict grepped out of a log, a
// detached process, a wait loop, a PID to kill. Every piece of that existed to
// work around one fact — a spawned CLI is OUTSIDE the session, so it needed its
// own permissions, its own lifetime, and its own result channel.
//
// A workflow `agent()` is inside the session. It is a sanctioned subagent: it
// inherits the operator's permission mode, returns a validated object, and is
// bounded by the workflow runtime rather than by a shell. So the apparatus is
// deleted rather than hardened — no permission flag, no consent relay, no spawn,
// no poll, no orphan to reap. If the session's mode calls for a permission prompt,
// the operator gets one; that is the intended behavior, not something to route
// around.
//
// It also makes implement RESUMABLE for free: `agent()` results cache by
// (prompt, opts), so a run resumed with resumeFromRunId replays a finished build
// instead of rebuilding it. The spawned-CLI version never could — its result
// lived in a log file the runtime knew nothing about.
//
// One honest caveat against LEARNINGS §1: isolation is now PROMPT-scoped, not
// PROCESS-scoped. A subagent can pick up ambient project context (the target
// repo's CLAUDE.md) that a bare `claude --print` would not have seen. The spec is
// still the sole INSTRUCTION and must still stand on its own — a vague spec is no
// safer here than it was before.

// ── Structured-return schemas ─────────────────────────────────────────────────
// DECLARED BEFORE the workflow body on purpose: the body executes at top level,
// and a `const` declared after it is still in the temporal dead zone when the
// body's stage callbacks run. Function declarations hoist; consts do NOT.

const resolveSchema = {
  type: "object",
  required: ["ready"],
  properties: {
    ready: { type: "boolean" },
    repoRoot: { type: "string" },
    repoName: { type: "string" },
    worktree: { type: "string" },
    branch: { type: "string" },
    defaultBranch: { type: "string" },
    baseRef: { type: "string" },
    specPath: { type: "string" },
    title: { type: "string" },
    qualityCommands: { type: "array", items: { type: "string" } },
    note: { type: "string" },
  },
};

const implementSchema = {
  type: "object",
  required: ["implemented"],
  properties: {
    implemented: { type: "boolean" },
    commitsAhead: { type: "integer" },
    summary: { type: "string", description: "2-4 sentences on what actually changed." },
    gateOutput: { type: "string", description: "The quality gate's final state as the builder saw it, pass or fail." },
    note: { type: "string" },
  },
};

const qualitySchema = {
  type: "object",
  required: ["qualityPassed"],
  properties: {
    qualityPassed: { type: "boolean" },
    failedCommands: { type: "array", items: { type: "string" } },
  },
};

const prSchema = {
  type: "object",
  required: ["prNumber"],
  properties: {
    prNumber: { type: ["integer", "null"] },
    prUrl: { type: ["string", "null"] },
    reused: { type: "boolean" },
    note: { type: "string" },
  },
};

const reviewSchema = {
  type: "object",
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: ["approve", "request-changes", "block"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity"],
        properties: {
          severity: { type: "string", enum: ["BLOCKER", "HIGH", "MEDIUM", "LOW"] },
          file: { type: "string" },
          line: { type: ["integer", "null"] },
          message: { type: "string" },
        },
      },
    },
  },
};

// The codex reviewer returns the same shape plus `available`. False means the
// codex CLI was missing or the invocation failed, and findings MUST then be
// empty — an honest "no second opinion" beats an invented one, exactly as in the
// critique panel's third critic (LEARNINGS §3).
const codexReviewSchema = {
  type: "object",
  required: ["verdict", "available"],
  properties: {
    ...reviewSchema.properties,
    available: {
      type: "boolean",
      description: "True only if codex actually ran and produced a review. False when the CLI is absent or the invocation failed — findings must then be empty.",
    },
  },
};

const fixSchema = {
  type: "object",
  required: ["applied"],
  properties: {
    applied: { type: "boolean" },
    summary: { type: "string" },
  },
};

// Condensed anvil-reviewer rubric, used ONLY when the anvil-reviewer agent type
// isn't registered (running from the plugin-source repo, or a fresh plugin
// install before the session restart). The full rubric lives in
// agents/reviewer.md; this fallback preserves the contract, not the polish.
const REVIEWER_RUBRIC = `You are the anvil PR reviewer (fallback mode — the anvil-reviewer
agent type is not registered in this session).

READ-ONLY: you may not edit files, commit, label, change PR state, or merge. Your ONLY
permitted write is publishing PR comments via gh when the instructions below say to.

Severity — every finding gets exactly one label (when between two, pick the higher):
- BLOCKER: spec acceptance criterion not met or behavioral contract broken; data loss;
  security vulnerability; crash on normal input; backward-compat break; CI failing
  because of this PR.
- HIGH: correctness issue outside the spec; missing input validation; race; resource
  leak; silently swallowed error; test gap on a critical non-trivial path.
- MEDIUM: code smell, misleading naming, missing edge-case test, doc drift. Doesn't block.
- LOW: style nits, typos. Never load-bearing on the verdict.

Verdict (decide AFTER classifying all findings):
- any BLOCKERs spread across the diff -> block
- localized BLOCKERs or any HIGH or unmet spec criteria -> request-changes
- otherwise, all spec criteria met and you read every changed file -> approve

Output exactly ONE fenced block tagged anvil-review containing: ## Verdict, ## Summary
(2-4 sentences), ## Findings (severity-ordered, each with Where: file:line, Evidence,
Why, Fix), ## Spec Adherence (walk each acceptance criterion: Met/Partial/Missing/NA
with citations), ## What I Verified, ## What I Skipped. Emit nothing after the block.`;

// Runs at top level: agent/pipeline/log/args are runtime globals.
// `stage` keeps the readable per-stage title labels; the REAL progress grouping
// is done by the per-agent `phase:` opts passed inside each stage.
const stage = (title, fn) => fn;

{
  const ids = parseIds(args);
  if (ids.length === 0) {
    log("no bd issue ids supplied — usage: execute-review-fix <id> [<id> ...]");
    return { atoms: [] };
  }
  log(`execute-review-fix: ${ids.length} issue(s): ${ids.join(", ")}`);

  // Each item is one atom. `pipeline` runs items independently so a confused
  // agent on one spec (LEARNINGS §1) doesn't abort the rest of the batch.
  const atoms = await pipeline(
    ids.map((id, i) => ({ id, index: i })),

    // ── Stage 1: resolve spec + prepare a disposable worktree ────────────────
    stage("resolve", async (item) => {
      const r = await agent(resolvePrompt(item), {
        schema: resolveSchema,
        phase: "resolve",
        label: `resolve:${item.id}`,
      });
      if (!r) return { ...item, ready: false, status: "skipped", note: "resolve agent failed" };
      return { ...item, ...r };
    }),

    // ── Stage 2: implement — a subagent builds it in the worktree ────────────
    stage("implement", async (item) => {
      if (item.ready === false) {
        return { ...item, status: "skipped", note: item.note ?? "spec not resolvable" };
      }
      const r = await agent(implementPrompt(item), {
        schema: implementSchema,
        phase: "implement",
        label: `implement:${item.id}`,
      });
      if (!r) return { ...item, implemented: false, note: "implement agent failed" };
      return { ...item, ...r };
    }),

    // ── Stage 3: quality gate ────────────────────────────────────────────────
    stage("quality", async (item) => {
      if (item.status === "skipped" || item.implemented === false) {
        return { ...item, status: item.status ?? "implement-failed" };
      }
      const r = await agent(qualityPrompt(item), {
        schema: qualitySchema,
        phase: "quality",
        label: `quality:${item.id}`,
      });
      // Quality failure does NOT abort the atom: Forge still opens the draft PR
      // so CI and the human can see the failure. We carry the result forward.
      if (!r) return { ...item, qualityPassed: false, failedCommands: ["(quality agent failed)"] };
      return { ...item, ...r };
    }),

    // ── Stage 4: open the DRAFT PR (idempotent — reuse if one exists) ────────
    stage("pr", async (item) => {
      if (item.status === "skipped" || item.implemented === false) {
        return item;
      }
      const r = await agent(prPrompt(item), {
        schema: prSchema,
        phase: "pr",
        label: `pr:${item.id}`,
      });
      if (!r) return { ...item, prNumber: null, note: "pr agent failed" };
      return { ...item, ...r };
    }),

    // ── Stage 5: review the draft PR — two reviewers, two model families ─────
    stage("review", async (item) => {
      if (!item.prNumber) return item;
      const review = await runBothReviews(item, `review:${item.id}`);
      return { ...item, review };
    }),

    // ── Stage 6: ONE auto-fix round, then STOP. Never merge. ─────────────────
    stage("fix", async (item) => {
      if (!item.prNumber || !item.review) return finalize(item);
      const verdict = (item.review.verdict || "").toLowerCase();
      if (verdict !== "request-changes") {
        // approve / block both stop here for human adjudication; never merge.
        return finalize({ ...item, fixRounds: 0 });
      }

      // Exactly AUTO_FIX_ROUNDS (=1) round. The loop is bounded by index, not
      // by wall-clock, and re-review after the fix is informational only — we
      // STOP regardless of the second verdict.
      let cur = item;
      for (let round = 0; round < AUTO_FIX_ROUNDS; round++) {
        const fixed = await agent(fixPrompt(cur, round + 1), {
          schema: fixSchema,
          phase: "fix",
          label: `fix:${item.id}:r${round + 1}`,
        });
        cur = { ...cur, lastFix: fixed };
        if (!fixed || fixed.applied === false) break; // nothing to fix / fixer gave up

        // Re-review once so the draft PR carries an up-to-date verdict for the
        // human. We do NOT branch on it — no second fix round, ever.
        const reReview = await runBothReviews(cur, `re-review:${item.id}:r${round + 1}`, { withCodex: false });
        cur = { ...cur, review: reReview ?? cur.review };
      }
      return finalize({ ...cur, fixRounds: AUTO_FIX_ROUNDS });
    }),
  );

  // Summary only — the durable record lives in bd (issue status) and GitHub
  // (the labeled draft PR), NOT here. See the run-state caveat at the top.
  for (const a of (atoms || []).filter(Boolean)) {
    log(
      `  ${a.id}: status=${a.status ?? "unknown"} pr=${a.prUrl ?? "—"} verdict=${a.review?.verdict ?? "—"}` +
        ` codex=${a.review ? (a.review.codexLeg ?? "unavailable") : "—"}`,
    );
  }
  return { atoms };
}

// ── Review helper: prefer the anvil-reviewer subagent, degrade gracefully ─────
// Installed plugin agents register NAMESPACED ("anvil:anvil-reviewer"); the
// bare name covers any unprefixed registration. (function declaration — hoists
// above the body)
async function runReview(item, label) {
  const opts = { schema: reviewSchema, phase: "review", label };
  for (const agentType of ["anvil:anvil-reviewer", "anvil-reviewer"]) {
    try {
      return await agent(reviewPrompt(item), { ...opts, agentType });
    } catch (e) { /* try the next name */ }
  }
  log(`${label}: anvil-reviewer agent type unavailable — falling back to the default subagent with an inline rubric (install the anvil plugin and run /reload-plugins to use the dedicated reviewer).`);
  return agent(`${REVIEWER_RUBRIC}\n\n${reviewPrompt(item)}`, { ...opts, model: "opus" });
}

// ── Two reviewers, two model families, run concurrently ──────────────────────
// The panel taught us this (LEARNINGS §3) and four consecutive drover rounds paid
// for it: the codex leg caught merge-blocking defects the same-family reviewer
// did not. So the atom reviews with both — anvil-reviewer and a relay of the
// `codex` CLI — and merges what they found.
//
// They run under `parallel()` inside the stage callback, which is the runtime's
// canonical shape for fanning out within a pipeline stage. The two are genuinely
// independent (both read-only against the same PR), and the codex leg is the slow
// one — sequencing them would have made every review wait out a full xhigh pass
// before the fast reviewer even started.
//
// codex is OPTIONAL throughout. No binary, a failed invocation, or a failed relay
// agent all mean "no second opinion" — never a fabricated one. `parallel()`
// resolves a failed leg to null, so each leg keeps its own null-collapse.
async function runBothReviews(item, label, opts) {
  // The post-fix re-review skips codex on purpose: that verdict is informational
  // (the atom stops either way), and a second full xhigh pass is real money for a
  // number nothing branches on. Say "not-rerun" rather than "unavailable" — the
  // leg did run, on the review that mattered.
  if (opts && opts.withCodex === false) {
    const merged = mergeReviews(await runReview(item, label), null);
    return merged ? { ...merged, codexLeg: "not-rerun" } : merged;
  }

  const [primary, codexRaw] = await parallel([
    () => runReview(item, label),
    () =>
      agent(codexReviewPrompt(item), {
        schema: codexReviewSchema,
        phase: "review",
        label: `${label}:codex`,
        model: "sonnet",
      }),
  ]);
  const codex = codexRaw && codexRaw.available !== false ? codexRaw : null;
  log(
    codex
      ? `${label}: codex reviewer RAN (${codex.findings?.length ?? 0} findings) — cross-family review.`
      : `${label}: codex reviewer unavailable (${codexRaw?.summary || "CLI missing, or the relay agent failed"}) — single-family review.`,
  );
  return mergeReviews(primary, codex);
}

// Merge two reviews into the one object the fix stage consumes. Findings keep
// their source so the fixer — and the human reading the summary — can see which
// reviewer raised what, and so a finding both raised reads as corroboration
// across model families rather than as duplication.
function mergeReviews(primary, codex) {
  const tag = (review, source) =>
    (review?.findings || []).map((f) => ({ ...f, source }));
  if (!primary && !codex) return null;
  const findings = [...tag(primary, "anvil-reviewer"), ...tag(codex, "codex")];
  const summary = [
    primary?.summary ? `anvil-reviewer: ${primary.summary}` : null,
    codex?.summary ? `codex: ${codex.summary}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    // The SEVERER verdict wins: a reviewer that found a blocker is not outvoted
    // by one that did not look in the same place.
    verdict: severerVerdict(primary?.verdict, codex?.verdict),
    summary,
    findings,
    codexLeg: codex ? "ran" : "unavailable",
  };
}

// The rank table lives INSIDE the function on purpose: a `const` declared after
// the workflow body is still in the temporal dead zone when a stage callback
// runs (the bug fixed in 1e7a61c). Function declarations hoist; consts do not.
function severerVerdict(a, b) {
  const order = { approve: 0, "request-changes": 1, block: 2 };
  const norm = (v) => (typeof v === "string" ? v.toLowerCase() : "");
  const rank = (v) => (order[norm(v)] ?? -1);
  if (rank(a) < 0 && rank(b) < 0) return "request-changes"; // neither reviewer spoke — do not approve by default
  return rank(a) >= rank(b) ? norm(a) : norm(b);
}

// ── Stage 1: resolve ──────────────────────────────────────────────────────────
// The spec is the SOLE input to the implementing agent (LEARNINGS §1), so we
// resolve it from the operator-scoped store and verify it's non-empty here,
// before spending an implement turn on a vague or missing spec.
function resolvePrompt(item) {
  return `You are the anvil resolve step for bd issue ${item.id}. Use Bash.

Honor the operator-scoped, out-of-repo layout. Do NOT touch the target repo's
CLAUDE.md, settings, or commit any .beads file into it.

1. BEADS_DIR="\${BEADS_DIR:-$HOME/.anvil/beads}". With it exported, read the
   issue: \`BEADS_DIR="$BEADS_DIR" bd show ${item.id}\` (fall back to \`br show\`).
   Capture its title and the target repo path it names (the spec body records
   the repo). Do NOT shell out to the \`forge\` binary anywhere.
2. The spec BODY is the file ~/.anvil/specs/${item.id}.md. Read it. This file —
   and ONLY this file — becomes the implementing agent's input, so confirm it
   exists and is self-contained (a vague spec produces a confused agent).
3. Resolve:
     - repoRoot: absolute path to the target git repo this issue targets.
     - defaultBranch: \`git -C <repoRoot> symbolic-ref --short refs/remotes/origin/HEAD\`
       stripped of its "origin/" prefix, else "main".
     - branch: a conventional-commit branch name derived from the issue,
       e.g. "feat/${item.id}-short-slug" (pick the type from the spec).
4. Create a DISPOSABLE worktree OUTSIDE the repo so nothing is imposed on it:
     WT="$HOME/.anvil/runs/${item.id}/worktree"
     mkdir -p "$HOME/.anvil/runs/${item.id}"
     git -C <repoRoot> fetch origin --quiet || true
     git -C <repoRoot> worktree add -B <branch> "$WT" \\
       "origin/<defaultBranch>" 2>/dev/null \\
       || git -C <repoRoot> worktree add -B <branch> "$WT" <defaultBranch>
   If "$WT" already exists from a prior run, reuse it (idempotent re-run).
5. Compute baseRef: prefer "origin/<defaultBranch>" if it resolves
   (\`git -C "$WT" rev-parse --verify origin/<defaultBranch>\`), else <defaultBranch>.
6. qualityCommands: the exact commands listed in the spec's "Quality Gates"
   section, one array entry per line, verbatim.

Report the resolved values. Set ready=false with a note if the spec file is
missing, empty, or the repo path can't be resolved.`;
}


// ── Stage 2: implement — a sanctioned subagent working in the worktree ───────
function implementPrompt(item) {
  const gate = item.qualityCommands && item.qualityCommands.length
    ? item.qualityCommands.map((c) => `     - \`${c}\``).join("\n")
    : "     - (the spec lists none — find the repo's own lint/typecheck/test and run those)";

  return `You are the anvil implementing agent for bd issue ${item.id}. You do the work
yourself — there is no other builder behind you.

WORKING DIRECTORY (everything happens here, and nowhere else):
  ${item.worktree}
BRANCH: ${item.branch}
SPEC:   ${item.specPath}

1. Read ${item.specPath} in full, first. It is your SOLE source of requirements:
   build what it says rather than what you would have designed. Where the spec is
   silent, take the smallest choice consistent with the surrounding code — silence is
   not an invitation to widen the scope.
2. Implement it inside the worktree above. That worktree is disposable and sits
   outside the operator's own checkout; never edit the main checkout, and never invoke
   the \`forge\` binary (git, gh and bd are the only tools anvil uses).
3. Run the quality gate BEFORE your first commit, so you know what was already broken,
   and again after your last one:
${gate}
   Fix whatever YOUR change broke. A failure that was already there is a line in your
   report, not a licence to go fixing unrelated code.
4. Own your commits: \`git add <path>\` on files you changed on purpose (never
   \`git add -A\`), conventional-commit messages, committed as you go. Do NOT push, do
   NOT open a PR, do NOT merge — anvil does all three after you return.
5. Report honestly. implemented=true only if the spec is actually built AND committed —
   check \`git -C ${item.worktree} rev-list --count ${item.baseRef || "origin/main"}..HEAD\`
   and put that number in commitsAhead. If you could not finish, say so with
   implemented=false and the reason in note: a half-built worktree reported as done
   costs the reviewer far more than an honest failure does. Put the gate's final state
   in gateOutput, and 2-4 sentences on what you changed in summary.`;
}

// ── Stage 3: quality gate ─────────────────────────────────────────────────────
function qualityPrompt(item) {
  const cmds = item.qualityCommands && item.qualityCommands.length
    ? item.qualityCommands
    : ["(auto-detect from the repo: lint, typecheck, test as configured)"];
  return `You are the anvil quality gate for bd issue ${item.id}. Use Bash.
Working directory: ${item.worktree}

Run each quality command and record pass/fail. Do NOT auto-fix here.
Commands: ${cmds.map((c) => `\`${c}\``).join(", ")}

cd ${item.worktree}; run each command; capture its exit code. A failure does
NOT abort the atom — Forge still opens the draft PR so CI and the human see the
failure. Report qualityPassed=false if any command failed, with the list of
failed commands. Never invoke the \`forge\` binary.`;
}

// ── Stage 4: open the DRAFT PR ────────────────────────────────────────────────
function prPrompt(item) {
  return `You are the anvil draft-PR step for bd issue ${item.id}. Use Bash (gh, git).
Working directory: ${item.worktree}
Never invoke the \`forge\` binary.

1. Push the branch: \`git -C ${item.worktree} push -u origin ${item.branch}\`.
2. IDEMPOTENT: if a PR already exists for this head branch
   (\`gh pr view ${item.branch} --json number,url\` succeeds), REUSE it — do not
   open a second. This is the durable run-state we rely on across re-runs.
3. Otherwise open a DRAFT PR (NEVER a ready one — the human adjudicates the
   merge; anvil never auto-merges):
     gh pr create --draft \\
       --title '${(item.title || item.id).replace(/'/g, "'\\''").slice(0, 70)}' \\
       --base ${item.defaultBranch || "main"} \\
       --head ${item.branch} \\
       --body "<short summary + a 'Generated by anvil for ${item.id}' line>"
4. Apply a label so this PR is identifiable as an anvil draft. Ensure the label
   exists first (\`gh label create anvil --force\` is fine), then:
     gh pr edit <number> --add-label anvil${item.qualityPassed === false ? " --add-label quality-failed" : ""}
5. Report the PR number and url.`;
}

// ── Stage 5/6: review (anvil-reviewer subagent) ───────────────────────────────
// The reviewer emits exactly one ```anvil-review fenced block; the subagent's
// system prompt owns that contract. Findings are published to the PR with a
// HIDDEN MARKER so re-runs never duplicate a comment (LEARNINGS §6).
function reviewPrompt(item) {
  return `Review draft PR #${item.prNumber} for bd issue ${item.id}.
Working directory / worktree: ${item.worktree}
PR url: ${item.prUrl}

Gather context with gh (never the \`forge\` binary):
  - \`gh pr view ${item.prNumber} --json number,title,body,headRefName,baseRefName,additions,deletions,changedFiles,url\`
  - \`gh pr diff ${item.prNumber}\`  (cap at ~60k chars)
  - The linked spec body at ${item.specPath} — the diff must satisfy THIS spec.

Produce your review as a single \`\`\`anvil-review fenced block with a verdict of
approve | request-changes | block and findings labeled BLOCKER / HIGH / MEDIUM /
LOW per your reviewer instructions.

Publish BLOCKER and HIGH findings as inline PR comments. DEDUPE: prefix every
published comment body with a hidden marker
\`<!-- anvil-finding id=${item.id}:<stable-hash-of-file:line:rule> -->\` and skip
any finding whose marker already appears on the PR, so re-running never
duplicates a comment.`;
}

// ── Stage 5/6: the codex reviewer ────────────────────────────────────────────
// A relay, not a reviewer: it hands the diff to another model family's CLI and
// transcribes what comes back. It runs codex in the BACKGROUND and polls, for
// the reason in LEARNINGS §10 — at xhigh reasoning over a real diff, codex
// routinely outlives a single Bash call, and a foreground wait would be pushed
// to the background taking the result with it.
function codexReviewPrompt(item) {
  const dir = `$HOME/.anvil/runs/${item.id}/codex-review`;
  return `You are the RELAY for anvil's SECOND reviewer of draft PR #${item.prNumber}
(bd issue ${item.id}). You do not review the diff yourself: you hand it to the \`codex\`
CLI — a different model family, which is the whole point — and report what it found.
Use Bash. Working directory: ${item.worktree}

## 1. Is codex here?
\`command -v codex\`. If it is not on PATH, STOP: return available=false, findings=[],
verdict="approve", and a summary saying the codex CLI is not installed. Do NOT review
the diff yourself and do NOT invent findings — an honest "no second opinion" is the
correct result, and a fabricated one poisons exactly the cross-family signal this
reviewer exists to provide.

## 2. Build the review prompt
\`mkdir -p ${dir}\`, then write a prompt file at ${dir}/prompt.txt containing:
  - the instruction: adversarially review this diff against the spec it claims to
    implement; report only defects you can point at in the diff; label each
    BLOCKER / HIGH / MEDIUM / LOW; give file:line, evidence, why it matters, and a fix;
    finish with a verdict of approve | request-changes | block.
  - the spec body, verbatim, from ${item.specPath}
  - the diff, from \`gh pr diff ${item.prNumber}\` (cap at ~60k chars; say so if you cut it)

## 3. Run it in the BACKGROUND, then poll
Never wait for codex in one foreground call — it thinks for a long time at this
reasoning effort, and a single blocking wait would exceed your tool's per-call limit,
get moved to the background, and take the result with it.

\`\`\`bash
cd ${item.worktree}
nohup codex exec --sandbox read-only -m gpt-5.6-sol -c model_reasoning_effort='"xhigh"' \\
  "$(cat ${dir}/prompt.txt)" > ${dir}/out.log 2>&1 < /dev/null &
echo $! > ${dir}/pid
\`\`\`

Then run this poll REPEATEDLY, as separate calls, until it prints CODEX_DONE — up to
about 5 times (~20 minutes). Each call self-bounds well inside the limit; the loop is
what waits, never a single call.

\`\`\`bash
PID="$(cat ${dir}/pid 2>/dev/null || echo)"; W=0
while [ "$W" -lt 240 ]; do
  if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then echo CODEX_DONE; break; fi
  sleep 10; W=$((W + 10))
done
if [ -f ${dir}/out.log ]; then wc -c < ${dir}/out.log | tr -d ' '; fi
tail -5 ${dir}/out.log 2>/dev/null
exit 0
\`\`\`

If it is still running after your last poll, \`kill "$PID"\` and return available=false
with what you have — an orphan left grinding is worse than an honest gap.

## 4. Recover the FULL message before you relay it
codex's terminal output can be clipped mid-message, and a clipped review silently
loses findings. The complete text is in the session transcript under
~/.codex/sessions/YYYY/MM/DD/*.jsonl — the assistant messages carry the final answer.
Find the transcript for the session you just ran by matching its CONTENT to this PR
(other, unrelated codex sessions write into the same tree — never pick one by
position), and read its last assistant message in full. Where the terminal output and
the transcript disagree, the transcript wins.

## 5. Relay, and publish
Return codex's verdict and findings as codex stated them — severities included. You
are a wire, not an editor; drop a finding only when codex left a required field empty,
and say so in the summary. Then publish its BLOCKER and HIGH findings as PR comments,
each prefixed with a hidden dedupe marker
\`<!-- anvil-finding id=${item.id}:codex:<stable-hash-of-file:line:rule> -->\`, skipping
any whose marker is already on the PR (LEARNINGS §6). Attribute them to codex in the
comment body so the human knows which reviewer spoke.`;
}

function fixPrompt(item, round) {
  return `You are the anvil auto-fix step (round ${round} of ${AUTO_FIX_ROUNDS}) for
draft PR #${item.prNumber}, bd issue ${item.id}. Use Bash. Working dir: ${item.worktree}
Never invoke the \`forge\` binary. This is the ONLY fix round — there is no second.

The reviewers requested changes. Address BLOCKER and HIGH severity findings ONLY;
leave MEDIUM and LOW for the human adjudicator. Each finding is tagged with the
reviewer that raised it — where both raised the same thing, that is corroboration
across model families, so treat it as the most credible item on the list. Findings:
${(item.review?.findings || [])
  .filter((f) => f.severity === "BLOCKER" || f.severity === "HIGH")
  .map((f) => `  - [${f.severity}] (${f.source ?? "reviewer"}) ${f.file ?? "?"}:${f.line ?? "?"} — ${f.message ?? ""}`)
  .join("\n") || "  (see the anvil-review block / PR comments)"}

1. cd ${item.worktree}; make the fixes; re-run the quality commands.
2. Commit ONLY intentionally-changed files (\`git add <path>\`, conventional
   commit \`fix(review): address reviewer feedback (round ${round})\`) and
   \`git push\`. If there is nothing to change, report applied=false.
3. Do NOT mark the PR ready, do NOT merge — the atom STOPS after this round and
   the human adjudicates. Report what you changed.`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// args: a space/comma-separated id string ("bd-a1b2 bd-c3d4"), an array of ids,
// or { ids: [...] }. There is nothing else to configure — the builder is a
// subagent now, so there is no permission mode, no consent flag, and no build
// deadline to pass through.
function parseIds(args) {
  if (Array.isArray(args)) return args.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof args === "string") return args.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (args && typeof args === "object" && Array.isArray(args.ids)) {
    return args.ids.map(String).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

// Collapse an item into its terminal status. The atom always STOPS at a
// (possibly fixed) draft PR — never a merge. The durable outcome is the labeled
// draft PR on GitHub plus the bd issue's status, not anything held in memory.
function finalize(item) {
  let status = item.status;
  if (!status) {
    if (item.implemented === false) status = "implement-failed";
    else if (!item.prNumber) status = "no-pr";
    else status = "draft-pr-ready-for-adjudication";
  }
  return { ...item, status };
}
