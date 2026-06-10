// anvil execute-review-fix — the EXECUTION ATOM.
//
// "Plan. Run. Review. Ship. Don't watch." This is the Run/Review half. For
// each bd-ready issue id passed as an arg it runs ONE headless atom:
//
//   resolve spec -> worktree -> implement (headless) -> quality gate
//     -> DRAFT PR -> review -> ONE auto-fix round -> STOP.
//
// It NEVER auto-merges. The atom stops at a draft PR for human adjudication
// (LEARNINGS §4). Items flow independently through `pipeline` so one bad
// spec doesn't sink the batch.
//
// NON-INVASIVE / OPERATOR-SCOPED. This workflow never shells out to the
// `forge` binary — only `claude` (headless), `gh`, `bd`/`br`, and `git`. All
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
    "anvil execution atom: for each bd-ready issue, implement its spec in a disposable worktree headlessly, gate quality, open a DRAFT PR, review it, run one auto-fix round, then stop. Never merges.",
  phases: [
    { title: "resolve" }, { title: "implement" }, { title: "quality" },
    { title: "pr" }, { title: "review" }, { title: "fix" },
  ],
};

// One auto-fix round, then STOP — regardless of the re-review verdict.
// Never a second round, never a merge (LEARNINGS §4).
const AUTO_FIX_ROUNDS = 1;

// ── Bash recipe shared across atoms ───────────────────────────────────────────
// These string constants are embedded verbatim into the implementing agent's
// prompt so the agent runs the EXACT real stream-json invocation Forge uses
// (mirrors claudeJobCommand + claudeJobStreamFilter in
// src/core/agents/index.ts), and judges success by the terminal result event
// in the sidecar — NOT the pipeline exit code (LEARNINGS §2 / PR #64).

// Projects ONLY the final {"type":"result"} event's text to stdout, exactly
// like Forge's claudeJobStreamFilter. Kept on one line so it drops cleanly
// into a single-quoted heredoc in the agent's shell.
const CLAUDE_STREAM_FILTER =
  `node -e "const rl=require('readline').createInterface({input:process.stdin});` +
  `rl.on('line',l=>{try{const e=JSON.parse(l);` +
  `if(e.type==='result'&&typeof e.result==='string')process.stdout.write(e.result+String.fromCharCode(10))}catch{}})"`;

// The headless implementing-agent recipe. {{...}} placeholders are filled per
// item. The agent is INSTRUCTED to run this and then parse the sidecar.
//
// The pipeline, under `set -uo pipefail`:
//   claude --print --output-format stream-json --verbose
//          --dangerously-skip-permissions --model <m> < promptFile
//     | tee sidecar | <filter>
//
// CRUCIAL (PR #64): pipefail makes the pipeline exit code unreliable — a
// downstream filter or SIGPIPE can mask a real success, and a truncated stream
// can masquerade as success. So success is decided ENTIRELY by the LAST
// {"type":"result"} line in the sidecar:
//   * RESCUE a non-zero exit when that line exists, is_error is not true, the
//     stop_reason is on the allowlist (end_turn|tool_use|stop_sequence), and
//     the agent left a well-formed final fenced block / clean tree.
//   * FORCE-FAIL a zero exit when no valid terminal result line is present.
const IMPLEMENT_RECIPE = `set -uo pipefail
export PYTHONUTF8=1
export LANG="\${LANG:-en_US.UTF-8}"

# Force-fresh sidecar so a stale prior result can never be mistaken for this run.
: > "{{SIDECAR}}"

claude --print --output-format stream-json --verbose --dangerously-skip-permissions \\
  --model "{{MODEL}}" < "{{PROMPT_FILE}}" \\
  | tee "{{SIDECAR}}" \\
  | ${CLAUDE_STREAM_FILTER}
PIPE_EXIT=$?   # UNRELIABLE under pipefail — do NOT trust this alone.

# ── Trust the terminal result event, not the exit code (PR #64) ──────────────
# Evaluate ONLY the last "type":"result" line. A mid-stream tool_result with
# is_error:true (e.g. a read-only grep that matched nothing) must not count.
RESULT_LINE=$(grep '"type":"result"' "{{SIDECAR}}" | tail -1)
RESULT_OK=1
if [ -z "$RESULT_LINE" ]; then
  RESULT_OK=0
elif printf '%s' "$RESULT_LINE" | grep -q '"is_error":true'; then
  RESULT_OK=0
else
  # stop_reason allowlist, fail closed. Absent/null stop_reason is allowed;
  # max_tokens / error / unknown future stops (refusal, pause_turn, ...) fail.
  STOP=$(printf '%s' "$RESULT_LINE" | grep -o '"stop_reason":"[^"]*"' | head -1 | sed 's/.*:"//; s/"$//')
  if [ -n "$STOP" ]; then
    case "$STOP" in
      end_turn|tool_use|stop_sequence) ;;
      *) RESULT_OK=0 ;;
    esac
  fi
fi

# The agent must also have COMMITTED work: a draft PR with zero commits is a
# silent failure. Mirror Forge's "commits ahead of base" gate.
COMMITS_AHEAD=$(git -C "{{WORKTREE}}" rev-list --count "{{BASE_REF}}..HEAD" 2>/dev/null || echo 0)

if [ "$RESULT_OK" -eq 1 ] && [ "$COMMITS_AHEAD" -gt 0 ]; then
  # RESCUE path: valid terminal result wins even if PIPE_EXIT != 0.
  echo "IMPLEMENT_OK pipe_exit=$PIPE_EXIT commits=$COMMITS_AHEAD"
  exit 0
fi
# FORCE-FAIL path: invalid/absent terminal result, or nothing committed, even
# if PIPE_EXIT == 0.
echo "IMPLEMENT_FAIL pipe_exit=$PIPE_EXIT result_ok=$RESULT_OK commits=$COMMITS_AHEAD"
exit 1`;

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
    stopReason: { type: "string" },
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

    // ── Stage 2: implement headlessly (the PR #64 result-trust recipe) ───────
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

    // ── Stage 5: review the draft PR (anvil-reviewer subagent) ───────────────
    stage("review", async (item) => {
      if (!item.prNumber) return item;
      const review = await runReview(item, `review:${item.id}`);
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
        const reReview = await runReview(cur, `re-review:${item.id}:r${round + 1}`);
        cur = { ...cur, review: reReview ?? cur.review };
      }
      return finalize({ ...cur, fixRounds: AUTO_FIX_ROUNDS });
    }),
  );

  // Summary only — the durable record lives in bd (issue status) and GitHub
  // (the labeled draft PR), NOT here. See the run-state caveat at the top.
  for (const a of (atoms || []).filter(Boolean)) {
    log(`  ${a.id}: status=${a.status ?? "unknown"} pr=${a.prUrl ?? "—"} verdict=${a.review?.verdict ?? "—"}`);
  }
  return { atoms };
}

// ── Review helper: prefer the anvil-reviewer subagent, degrade gracefully ─────
// (function declaration — hoists above the body)
async function runReview(item, label) {
  const opts = { schema: reviewSchema, phase: "review", label };
  try {
    return await agent(reviewPrompt(item), { ...opts, agentType: "anvil-reviewer" });
  } catch (e) {
    log(`${label}: anvil-reviewer agent type unavailable — falling back to the default subagent with an inline rubric (install the anvil plugin and restart the session to use the dedicated reviewer).`);
    return agent(`${REVIEWER_RUBRIC}\n\n${reviewPrompt(item)}`, { ...opts, model: "opus" });
  }
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

// ── Stage 2: implement (headless, result-event-trusted) ───────────────────────
function implementPrompt(item) {
  // The spec snapshot doubles as the agent's prompt file. We build the exact
  // headless recipe with this item's paths substituted, then have the agent run
  // it and report the sidecar verdict — NOT the pipe exit.
  const recipe = IMPLEMENT_RECIPE.replaceAll("{{SIDECAR}}", `$HOME/.anvil/runs/${item.id}/agent.stream.jsonl`)
    .replaceAll("{{PROMPT_FILE}}", `$HOME/.anvil/runs/${item.id}/agent-prompt.txt`)
    .replaceAll("{{MODEL}}", "${ANVIL_IMPLEMENT_MODEL:-claude-sonnet-4-6}")
    .replaceAll("{{WORKTREE}}", item.worktree || `$HOME/.anvil/runs/${item.id}/worktree`)
    .replaceAll("{{BASE_REF}}", item.baseRef || "origin/main");

  return `You are the anvil implement step for bd issue ${item.id}. Use Bash.
You SUPERVISE a headless claude run — you do not implement the code yourself.

NON-NEGOTIABLE: never invoke the \`forge\` binary. Only claude/gh/bd/git.

WORKTREE: ${item.worktree}
SPEC FILE (the SOLE input the implementing agent may see): ${item.specPath}

1. Build the implementing agent's prompt file. The implementing agent must see
   ONLY the spec body — not this conversation, not the repo's CLAUDE.md, nothing
   else (LEARNINGS §1). Write to $HOME/.anvil/runs/${item.id}/agent-prompt.txt:
     - A one-line role header: working dir is the worktree, branch is ${item.branch}.
     - The VERBATIM contents of ${item.specPath}.
     - Instructions: implement the spec; the agent OWNS its commits — use
       \`git add <path>\` on intentionally-changed files only (never \`git add -A\`);
       use conventional commits; do NOT push or open a PR (anvil does that);
       exit 0 only when complete and committed.
2. cd into the worktree: ${item.worktree}
3. Run this EXACT recipe (it mirrors Forge's stream-json command and decides
   success from the terminal result event in the sidecar, NOT the pipe exit —
   this is the PR #64 fix; do not "simplify" it to \`if claude ...; then\`):

\`\`\`bash
${recipe}
\`\`\`

4. Report implemented=true ONLY if the recipe printed IMPLEMENT_OK (exit 0).
   If it printed IMPLEMENT_FAIL, report implemented=false with the reason
   (no valid terminal result, disallowed stop_reason, or no commits). Include
   commitsAhead from the recipe output.`;
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

function fixPrompt(item, round) {
  return `You are the anvil auto-fix step (round ${round} of ${AUTO_FIX_ROUNDS}) for
draft PR #${item.prNumber}, bd issue ${item.id}. Use Bash. Working dir: ${item.worktree}
Never invoke the \`forge\` binary. This is the ONLY fix round — there is no second.

The reviewer requested changes. Address BLOCKER and HIGH severity findings ONLY;
leave MEDIUM and LOW for the human adjudicator. Findings:
${(item.review?.findings || [])
  .filter((f) => f.severity === "BLOCKER" || f.severity === "HIGH")
  .map((f) => `  - [${f.severity}] ${f.file ?? "?"}:${f.line ?? "?"} — ${f.message ?? ""}`)
  .join("\n") || "  (see the anvil-review block / PR comments)"}

1. cd ${item.worktree}; make the fixes; re-run the quality commands.
2. Commit ONLY intentionally-changed files (\`git add <path>\`, conventional
   commit \`fix(review): address reviewer feedback (round ${round})\`) and
   \`git push\`. If there is nothing to change, report applied=false.
3. Do NOT mark the PR ready, do NOT merge — the atom STOPS after this round and
   the human adjudicates. Report what you changed.`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
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
