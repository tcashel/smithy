// SPDX-License-Identifier: Apache-2.0
// anvil run-epic — the WAVE RUNNER.
//
// Composes execution atoms over an epic's dependency graph. Each wave: take the
// epic's ready children from beads, run the execute-review-fix atom on them
// against an INTEGRATION BRANCH, auto-merge the clean slices into that branch,
// replan the next wave's stubs against the merged reality, and go again. Stops
// fail-closed, and NEVER merges to the default branch — the epic ends as ONE
// draft PR (integration branch → default branch) for the human to adjudicate.
//
// Authority boundaries (LEARNINGS §4 as amended):
//   - a CLEAN slice (quality gate passed, review ran, no BLOCKER/HIGH from
//     either reviewer) may auto-merge into the INTEGRATION branch only;
//   - anything less stays an open draft PR, bd moves to blocked-on-human, and
//     the wave continues around it;
//   - the integration→default merge is ALWAYS the operator's.
//
// Write-back surfaces, kept honest: /anvil:adjudicate remains the sole write
// surface for operator-adjudicated specs. The replan checkpoint here is the
// write surface for PROMOTED STUBS ONLY — specs no operator has adjudicated
// yet — and every self-made call is journaled into the promoted spec. Cruxes
// (conflicts, product-intent questions) are never self-resolved: they are
// queued into the epic map's Open Questions and the stub stays blocked.
//
// Args (object, assembled by /anvil:run-epic — the skill resolves the script
// paths because this runtime has no filesystem access of its own):
//   {
//     epicId:          "bd-…"        the epic issue (kind: epic)
//     atomScriptPath:  "/abs/path/to/execute-review-fix.js"   (required)
//     pciScriptPath:   "/abs/path/to/plan-critique-improve.js" (required for
//                       promotion critiques; without it promotion is skipped
//                       and stubs stay blocked)
//     maxWaves:        3             optional, clamped 1..10
//     implementModel:  "fable"       optional per-run override for the atoms
//   }

export const meta = {
  name: "run-epic",
  description:
    "Wave runner for an anvil epic: per wave, run the execution atom over the epic's ready children against an integration branch, auto-merge clean slices (gate passed, no BLOCKER/HIGH) into that branch, replan the next wave's stubs against merged reality (promote the ones whose ASSUMES held, via the critique panel), and stop fail-closed. Ends by opening ONE draft PR from the integration branch to the default branch. Never merges to the default branch.",
  phases: [
    { title: "setup", detail: "Resolve the epic + create/reuse the integration branch" },
    { title: "frontier", detail: "The epic's ready children this wave (bd does the sequencing)" },
    { title: "atoms", detail: "execute-review-fix over the frontier, based on the integration branch" },
    { title: "merge", detail: "Auto-merge clean slices into the integration branch; stall the rest" },
    { title: "replan", detail: "Verify next stubs' ASSUMES against merged reality; promote or hold" },
    { title: "epic-pr", detail: "All children done: open the ONE draft PR to the default branch" },
  ],
};

// ── Schemas (before the body — consts do not hoist, LEARNINGS/TDZ) ───────────

const SETUP_SCHEMA = {
  type: "object",
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    repoRoot: { type: "string" },
    defaultBranch: { type: "string" },
    integrationBranch: { type: "string" },
    epicSpecPath: { type: "string" },
    epicTitle: { type: "string" },
    note: { type: "string" },
  },
};

const FRONTIER_SCHEMA = {
  type: "object",
  required: ["epicReady", "readyChildIds"],
  properties: {
    epicReady: { type: "boolean", description: "True when every child is done/closed — the signal to open the epic PR." },
    readyChildIds: { type: "array", items: { type: "string" } },
    blockedChildIds: { type: "array", items: { type: "string" }, description: "Children held by unresolved open questions / ASSUMES (stubs) or blocked-on-human." },
    doneChildIds: { type: "array", items: { type: "string" } },
    note: { type: "string" },
  },
};

const MERGE_SCHEMA = {
  type: "object",
  required: ["mergedIds", "stalledIds"],
  properties: {
    mergedIds: { type: "array", items: { type: "string" } },
    stalledIds: { type: "array", items: { type: "string" } },
    note: { type: "string" },
  },
};

const REPLAN_SCHEMA = {
  type: "object",
  required: ["promotable", "falsified", "majorityFalsified"],
  properties: {
    promotable: {
      type: "array",
      description: "Stubs whose EVERY ASSUMES item held against the integration branch's merged reality.",
      items: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          evidence: { type: "string", description: "Per assumption: the merged file/diff that proves it held." },
        },
      },
    },
    falsified: {
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          broken: { type: "string", description: "Which ASSUMES broke, and what reality is instead." },
        },
      },
    },
    majorityFalsified: { type: "boolean", description: "True when most examined stubs had a broken assumption — the CUT is wrong; stop and hand back." },
    note: { type: "string" },
  },
};

const PROMOTE_SCHEMA = {
  type: "object",
  required: ["id", "specWritten"],
  properties: {
    id: { type: "string" },
    specWritten: { type: "boolean" },
    note: { type: "string" },
  },
};

const APPLY_SCHEMA = {
  type: "object",
  required: ["id", "flippedReady", "cruxCount"],
  properties: {
    id: { type: "string" },
    editsApplied: { type: "integer" },
    cruxCount: { type: "integer", description: "Conflicts + open questions from the panel. Zero is the promotion bar." },
    flippedReady: { type: "boolean" },
    note: { type: "string" },
  },
};

const EPIC_PR_SCHEMA = {
  type: "object",
  required: ["prNumber"],
  properties: {
    prNumber: { type: ["integer", "null"] },
    prUrl: { type: ["string", "null"] },
    note: { type: "string" },
  },
};

// ── Body ─────────────────────────────────────────────────────────────────────

{
  const cfg = parseEpicArgs(args);
  if (!cfg.epicId || !cfg.atomScriptPath) {
    log("run-epic needs { epicId, atomScriptPath, pciScriptPath } — /anvil:run-epic assembles these.");
    return { error: "missing-args" };
  }

  phase("setup");
  const setup = await agent(setupPrompt(cfg.epicId), { schema: SETUP_SCHEMA, phase: "setup", label: `setup:${cfg.epicId}` });
  if (!setup || !setup.ok) {
    return { error: "setup-failed", note: setup?.note ?? "setup agent failed" };
  }
  log(`epic ${cfg.epicId} ("${setup.epicTitle}") → integration branch ${setup.integrationBranch} in ${setup.repoRoot}`);

  const journal = [];
  let wave = 0;
  let stop = "";
  let epicDone = false;

  while (wave < cfg.maxWaves) {
    wave++;

    // ── The frontier: bd sequences, we obey ───────────────────────────────────
    const frontier = await agent(frontierPrompt(cfg.epicId, wave), {
      schema: FRONTIER_SCHEMA, phase: "frontier", label: `frontier:w${wave}`,
    });
    if (!frontier) { stop = "frontier-agent-failed"; break; }
    if (frontier.epicReady) { epicDone = true; break; }
    if (!frontier.readyChildIds.length) {
      stop = "no-ready-children";
      journal.push(`wave ${wave}: frontier empty but epic not done — blocked: ${(frontier.blockedChildIds || []).join(", ") || "(none listed)"}`);
      break;
    }
    log(`wave ${wave}: ${frontier.readyChildIds.length} ready slice(s): ${frontier.readyChildIds.join(", ")}`);

    // ── Atoms, based on the integration branch ────────────────────────────────
    const atomArgs = { ids: frontier.readyChildIds, baseRef: setup.integrationBranch };
    if (cfg.implementModel) atomArgs.implementModel = cfg.implementModel;
    const atomRun = await workflow({ scriptPath: cfg.atomScriptPath }, atomArgs);
    const atoms = (atomRun?.atoms || []).filter(Boolean);

    // ── Merge policy: clean in, everything else stalls ────────────────────────
    // Clean = the atom reached its terminal happy state (which implies the
    // review RAN — a review-failed atom finalizes differently), the quality
    // gate passed, and the merged severer-verdict review carries no BLOCKER or
    // HIGH finding from either reviewer.
    const isClean = (a) => {
      if (a.status !== "draft-pr-ready-for-adjudication" || !a.prNumber) return false;
      if (a.qualityPassed === false) return false;
      const sev = (a.review?.findings || []).map((f) => f.severity);
      return !sev.includes("BLOCKER") && !sev.includes("HIGH");
    };
    const clean = atoms.filter(isClean);
    const dirty = atoms.filter((a) => !isClean(a));

    let mergedCount = 0;
    if (clean.length || dirty.length) {
      const m = await agent(mergePrompt(clean, dirty, setup), {
        schema: MERGE_SCHEMA, phase: "merge", label: `merge:w${wave}`,
      });
      mergedCount = m?.mergedIds?.length ?? 0;
      journal.push(
        `wave ${wave}: merged [${(m?.mergedIds || []).join(", ") || "none"}] into ${setup.integrationBranch}; ` +
        `stalled [${(m?.stalledIds || []).join(", ") || "none"}] at open draft PRs.`,
      );
    }
    if (mergedCount === 0) {
      // A wave that lands nothing cannot unblock the next one. Fail closed.
      stop = "wave-merged-zero-slices";
      break;
    }

    // ── Replan checkpoint: next stubs vs merged reality ───────────────────────
    const replan = await agent(replanPrompt(cfg.epicId, setup), {
      schema: REPLAN_SCHEMA, phase: "replan", label: `replan:w${wave}`, model: "fable",
    });
    if (replan) {
      for (const f of replan.falsified || []) {
        journal.push(`replan w${wave}: ${f.id} held back — ${f.broken || "assumption broke"}`);
      }
      if (replan.majorityFalsified) {
        stop = "cut-falsified";
        journal.push(`replan w${wave}: majority of examined stubs falsified — the cut is wrong; handing back to the operator.`);
        break;
      }
      const promotable = (replan.promotable || []).filter((p) => p && p.id);
      if (promotable.length && cfg.pciScriptPath) {
        const promoted = await pipeline(
          promotable,
          (p) => agent(promotePrompt(p, cfg.epicId, setup), {
            schema: PROMOTE_SCHEMA, phase: "replan", label: `promote:${p.id}`, model: "fable",
          }),
          async (pr, p) => {
            if (!pr || !pr.specWritten) return { id: p.id, flippedReady: false, cruxCount: -1, note: pr?.note || "promotion draft failed" };
            const rec = await workflow(
              { scriptPath: cfg.pciScriptPath },
              { specId: p.id, targetRepo: setup.repoRoot, note: `promotion critique, epic ${cfg.epicId}` },
            );
            return { promoteNote: pr.note, rec, id: p.id };
          },
          (r, p) => {
            if (r && r.flippedReady === false && r.cruxCount === -1) return r; // draft failed upstream
            return agent(applyPrompt(p.id, cfg.epicId, setup, r?.rec), {
              schema: APPLY_SCHEMA, phase: "replan", label: `gate:${p.id}`, model: "fable",
            });
          },
        );
        for (const r of (promoted || []).filter(Boolean)) {
          journal.push(
            r.flippedReady
              ? `replan w${wave}: ${r.id} promoted to ready (${r.editsApplied ?? 0} panel edit(s) applied, zero cruxes).`
              : `replan w${wave}: ${r.id} stays blocked — ${r.cruxCount > 0 ? `${r.cruxCount} crux(es) queued to the epic map` : (r.note || "promotion failed")}.`,
          );
        }
      } else if (promotable.length) {
        journal.push(`replan w${wave}: ${promotable.length} stub(s) promotable but no pciScriptPath — left blocked (promotion requires the critique panel).`);
      }
    }
  }

  if (!stop && !epicDone && wave >= cfg.maxWaves) stop = "max-waves-reached";

  // ── Epic completion: ONE draft PR, operator adjudicates ──────────────────────
  let epicPr = null;
  if (epicDone) {
    const pr = await agent(epicPrPrompt(cfg.epicId, setup, journal), {
      schema: EPIC_PR_SCHEMA, phase: "epic-pr", label: `epic-pr:${cfg.epicId}`,
    });
    epicPr = pr;
    journal.push(pr?.prUrl ? `epic PR opened: ${pr.prUrl} (draft — the merge is the operator's)` : `epic ready but the PR step failed: ${pr?.note || "no detail"}`);
  }

  for (const line of journal) log(line);
  return {
    epicId: cfg.epicId,
    integrationBranch: setup.integrationBranch,
    wavesRun: wave,
    stoppedBecause: stop || (epicDone ? "epic-complete" : "unknown"),
    epicPr,
    journal,
  };
}

// ── Args (function declaration — hoists above the body) ──────────────────────

function parseEpicArgs(args) {
  const v = args && typeof args === "object" ? args : {};
  const waves = Number(v.maxWaves);
  return {
    epicId: v.epicId ? String(v.epicId).trim() : "",
    atomScriptPath: v.atomScriptPath ? String(v.atomScriptPath).trim() : "",
    pciScriptPath: v.pciScriptPath ? String(v.pciScriptPath).trim() : "",
    maxWaves: Number.isFinite(waves) ? Math.min(10, Math.max(1, Math.trunc(waves))) : 3,
    implementModel: v.implementModel ? String(v.implementModel).trim() : "",
  };
}

// ── Prompt builders ──────────────────────────────────────────────────────────

function setupPrompt(epicId) {
  return `You are the anvil run-epic setup step for epic ${epicId}. Use Bash.
Honor the operator-scoped layout: BEADS_DIR="\${BEADS_DIR:-$HOME/.anvil/beads}" on every
bd/br call. Never invoke the \`forge\` binary, never write into the target repo.

1. Read the epic: \`BEADS_DIR="$BEADS_DIR" bd show ${epicId}\` (fall back to br). Confirm its
   description marks it \`kind: epic\`; if not, STOP with ok=false — this runner only takes epics.
2. The plan map is ~/.anvil/specs/${epicId}.md. Read it; resolve the target repo it names
   (repoRoot) and the repo's default branch (\`git -C <repoRoot> symbolic-ref --short
   refs/remotes/origin/HEAD\` stripped of "origin/", else "main").
3. Integration branch: "anvil/epic-${epicId}". If it does not exist on origin, create it from
   origin/<defaultBranch> and push it:
     git -C <repoRoot> fetch origin --quiet
     git -C <repoRoot> branch anvil/epic-${epicId} origin/<defaultBranch> 2>/dev/null || true
     git -C <repoRoot> push -u origin anvil/epic-${epicId}
   If it already exists (a resumed epic), leave it exactly as it is — reuse is the point.
4. Report ok=true with repoRoot, defaultBranch, integrationBranch, epicSpecPath, and the
   epic's title (the plan map's H1).`;
}

function frontierPrompt(epicId, wave) {
  return `You are the anvil run-epic frontier step (wave ${wave}) for epic ${epicId}. Use Bash.
BEADS_DIR="\${BEADS_DIR:-$HOME/.anvil/beads}" on every bd/br call. Never invoke \`forge\`.

1. List the epic's CHILDREN: the issues the epic depends on (\`bd show ${epicId}\` names its
   dependencies; use your bd version's dep-listing form). The epic is blocked by every child,
   so its dependency list IS the child list.
2. Classify each child: done/closed; ready (appears in \`BEADS_DIR="$BEADS_DIR" bd ready\`);
   otherwise blocked (stub held by its ASSUMES gate, or blocked-on-human).
3. epicReady=true iff EVERY child is done/closed. readyChildIds = the intersection of the
   children with \`bd ready\` output — only ids bd itself reports ready; never invent ids and
   never promote a blocked child here (that is the replan step's job, with evidence).
Report the classification. In note, one line per blocked child with why, if bd shows it.`;
}

function mergePrompt(clean, dirty, setup) {
  const list = (xs) => xs.map((a) => `  - ${a.id}: PR #${a.prNumber} (${a.prUrl || "url unknown"})`).join("\n") || "  (none)";
  return `You are the anvil run-epic merge step. Use Bash (gh, git, bd). Repo: ${setup.repoRoot}
Never invoke \`forge\`. NEVER touch ${setup.defaultBranch} — every merge below targets the
integration branch ${setup.integrationBranch} ONLY, and only via gh's server-side merge.

CLEAN slices — quality gate passed, both-reviewer verdict carries no BLOCKER/HIGH. Merge each
into the integration branch:
${list(clean)}

For each clean slice, in order:
1. Verify the PR's base is ${setup.integrationBranch} (\`gh pr view <num> --json baseRefName\`).
   A PR whose base is anything else does NOT get merged — move it to the stalled list instead.
2. \`gh pr ready <num>\` (draft PRs cannot merge), then
   \`gh pr merge <num> --squash --delete-branch\`.
3. Mark the bd issue done: BEADS_DIR="\${BEADS_DIR:-$HOME/.anvil/beads}" bd close <id> (or your
   bd version's done-transition).
4. Retire the run dir: \`git -C ${setup.repoRoot} worktree remove "$HOME/.anvil/runs/<id>/worktree"\`
   (--force if dirty), \`git -C ${setup.repoRoot} worktree prune\`, \`rm -rf "$HOME/.anvil/runs/<id>"\`.

STALLED slices — gate failed, a BLOCKER/HIGH finding, or no verdict. Do NOT merge; leave each
draft PR open for the human and mark the bd issue blocked-on-human with a one-line reason
(bd update <id> — use your version's status/note form):
${list(dirty)}

Report mergedIds and stalledIds exactly as executed. If a merge FAILS (conflict, CI rule),
that slice moves to stalledIds with the error in note — never force, never retry with
different flags, never merge anything into ${setup.defaultBranch}.`;
}

function replanPrompt(epicId, setup) {
  return `You are the anvil replan checkpoint for epic ${epicId} — the step that keeps late
slices honest. Use Bash, read-only against the repo. BEADS_DIR="\${BEADS_DIR:-$HOME/.anvil/beads}".
Never invoke \`forge\`. You WRITE NOTHING in this step: you examine and classify; promotion
happens downstream with the critique panel.

1. The epic's plan map is ~/.anvil/specs/${epicId}.md; its blocked STUB children each have a
   spec at ~/.anvil/specs/<child-id>.md whose Open Questions hold \`- [ ] ASSUMES:\` items.
   Find the blocked stubs (bd show / dep listing; skip children marked blocked-on-human — those
   are stalled slices awaiting the operator, not stubs).
2. Merged reality is the integration branch: \`git -C ${setup.repoRoot} fetch origin --quiet\`,
   then read diffs/files at origin/${setup.integrationBranch}
   (\`git -C ${setup.repoRoot} diff origin/${setup.defaultBranch}...origin/${setup.integrationBranch}\`,
   \`git -C ${setup.repoRoot} show origin/${setup.integrationBranch}:<path>\`).
3. For each stub, check EVERY ASSUMES item mechanically against that reality. An assumption
   HELD only if you can cite the merged file/diff that satisfies it; "probably fine" is not
   evidence. ALL items held → the stub goes in promotable, with the per-item evidence. ANY item
   broken → falsified, with what reality is instead. An item you cannot check either way counts
   as broken — promotion runs on proof, not optimism.
4. majorityFalsified=true when more than half of the stubs you examined had a broken
   assumption: that pattern means the CUT is wrong, and recutting the epic is the operator's
   call, not yours.`;
}

function promotePrompt(p, epicId, setup) {
  return `You are the anvil stub-promotion drafter for ${p.id} (epic ${epicId}). Its every
ASSUMES item just held against merged reality:
${p.evidence || "(evidence recorded by the replan step)"}

Rewrite ~/.anvil/specs/${p.id}.md from a STUB into a FULL anvil spec. Use file tools and
read-only git against ${setup.repoRoot} (base your file citations on
origin/${setup.integrationBranch} — that is what this slice will build on). Never invoke \`forge\`.

1. Keep the H1 (it is the PR title). Replace the stub sections with the full schema:
   Context / What We're Building / Acceptance Criteria / Implementation Notes / Quality Gates /
   Agent Instructions — self-contained per LEARNINGS §1: the implementing agent sees ONLY this
   file. Cite only paths you opened AT the integration branch.
2. Resolve each \`- [ ] ASSUMES:\` item: fold what it guaranteed into the proper section as
   settled fact, and delete the bullet. The finished body has NO open \`- [ ]\` items and no
   "stub"/"ASSUMES" language.
3. Append a \`## Promotion journal\` section: one bullet per assumption — the evidence it held —
   plus one bullet per decision you made that the stub had left open. This is the audit trail;
   keep it factual.
4. Report specWritten=true only after the file on disk is the full spec. Do NOT touch the bd
   issue — the promotion gate downstream flips it only after the critique panel comes back clean.`;
}

function applyPrompt(id, epicId, setup, rec) {
  return `You are the anvil promotion gate for ${id} (epic ${epicId}). The critique panel just
reviewed the promoted spec at ~/.anvil/specs/${id}.md. Use file tools and bash;
BEADS_DIR="\${BEADS_DIR:-$HOME/.anvil/beads}". Never invoke \`forge\`.

The panel's recommendations object:
${rec ? JSON.stringify(rec, null, 2).slice(0, 20000) : "(the critique workflow returned nothing — treat as cruxes present and hold the stub)"}

1. Apply every edit with applicable=true (exact currentText → replacementText; skip any whose
   currentText no longer matches, and count it as a crux instead). Log each applied edit as a
   bullet under the spec's \`## Promotion journal\`.
2. cruxCount = conflicts + openQuestions + any edit skipped above. If cruxCount is ZERO:
   flip the issue ready (bd update ${id} --status ready, or your version's form) and report
   flippedReady=true.
3. If cruxCount > 0: the stub does NOT go ready. Append each crux VERBATIM to the epic plan
   map's Open Questions section (~/.anvil/specs/${epicId}.md) as \`- [ ] [${id}] <crux>\`, add a
   note on the bd issue that promotion queued cruxes, and report flippedReady=false. The
   operator adjudicates cruxes — this gate never does.`;
}

function epicPrPrompt(epicId, setup, journal) {
  return `You are the anvil epic-PR step for ${epicId}. Every child is done and merged into
${setup.integrationBranch}. Use Bash (gh, git). Repo: ${setup.repoRoot}. Never invoke \`forge\`.
You NEVER merge — you open ONE draft PR and stop; the merge belongs to the operator.

1. IDEMPOTENT: if a PR already exists with head ${setup.integrationBranch}
   (\`gh pr view ${setup.integrationBranch} --json number,url\`), reuse it — update its body
   instead of opening a second.
2. Otherwise:
     gh pr create --draft \\
       --title '${(setup.epicTitle || epicId).replace(/'/g, "'\\''").slice(0, 70)}' \\
       --base ${setup.defaultBranch} \\
       --head ${setup.integrationBranch} \\
       --body-file <a file you write>
3. The body: the epic's Goal (from ~/.anvil/specs/${epicId}.md), the slice inventory (one line
   per child: id, its squash-merge subject on the integration branch, final verdict), and a
   "## Wave journal" section containing these lines verbatim:
${(journal || []).map((l) => `     ${l}`).join("\n") || "     (empty journal)"}
4. Label it (\`gh label create anvil --force\`; add the anvil label, plus anvil-epic if quick).
5. Report the PR number and url. Do NOT mark it ready, do NOT merge.`;
}
