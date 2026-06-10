// SPDX-License-Identifier: Apache-2.0
/**
 * anvil — plan-critique-improve
 *
 * Adversarial spec hardening from bare Claude Code primitives. Takes ONE
 * locked spec (the file ~/.anvil/specs/<id>.md), runs TWO independent
 * critics in parallel from deliberately different angles/models so their
 * blind spots differ, then a synthesizer merges them into corroborated /
 * single-critic-only / conflicting findings with CONCRETE replacement spec
 * text plus an Open Questions list. Non-conflicting, non-open-question
 * edits may be applied back to the spec file; conflicts and open questions
 * are LEFT for /anvil:adjudicate.
 *
 * Mirrors Forge's two-critic + synthesizer model (forge-synthesizer skill,
 * src/core/critique.ts) but reassembled from bare parts — never shells out
 * to the `forge` binary. The critics run as the `anvil-critic` subagent.
 *
 * Why two critics? Different models have different blind spots. A finding
 * raised by BOTH is almost certainly real (corroborated). A finding raised
 * by only ONE might be a genuine catch the other missed, or a false
 * positive — the synthesizer triages. A finding the two DISAGREE on is
 * flagged conflicting and deferred to human adjudication.
 *
 * THE SPEC IS THE SOLE INPUT. The implementing agent that later runs this
 * spec will see ONLY the spec body — not this conversation, not the repo
 * CLAUDE.md. So every recommended edit must make the spec MORE
 * self-contained, with concrete replacement text ("write the new sentence"),
 * never "be more specific".
 *
 * Args: a spec id (e.g. "anvil-0042") or an absolute path to a spec .md
 * file. If an id, the spec is resolved to $ANVIL_SPECS_DIR/<id>.md
 * (default ~/.anvil/specs/<id>.md). State is operator-scoped and
 * out-of-repo — this workflow never writes into the target repository.
 *
 * Runtime note: the workflow runtime FORBIDS wall-clock and randomness
 * builtins. We never call Date.now()/new Date()/Math.random(). Where the
 * two critics must differ, we vary by INDEX, not by a random seed.
 */

export const meta = {
  name: "plan-critique-improve",
  description:
    "Two independent critics (different angles/models) review a locked anvil spec in parallel; a synthesizer merges their findings into corroborated / single-critic-only / conflicting buckets with concrete replacement spec text and an Open Questions list, then optionally applies the safe non-conflicting edits back to the spec file.",
  phases: [
    { title: "load", detail: "Resolve and read the spec body (sole input)" },
    { title: "critique", detail: "Run two independent critics in parallel from differing angles" },
    { title: "synthesize", detail: "Merge the two critiques into prioritized, classified recommendations" },
    { title: "apply", detail: "Apply safe non-conflicting edits; leave conflicts/open questions for adjudication" },
  ],
};

// ─── Structured-return schemas ──────────────────────────────────────────────

/**
 * The spec-load step returns where the spec lives and its full body. The
 * body is the SOLE INPUT contract — everything downstream reasons only
 * about this text.
 */
const SPEC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["specId", "specPath", "title", "body", "found"],
  properties: {
    specId: { type: "string", description: "The spec id, e.g. anvil-0042" },
    specPath: { type: "string", description: "Absolute path to the resolved spec .md file" },
    title: { type: "string", description: "Spec title (first H1, or the id if none)" },
    body: { type: "string", description: "The COMPLETE verbatim spec body — the sole input to the implementing agent" },
    found: { type: "boolean", description: "True if the spec file existed and was read" },
  },
};

/**
 * A single critic's findings. Mirrors the forge-spec-critique fenced
 * contract: severity-labelled findings, each with where / issue / impact /
 * suggestion, plus a what-verified list and a one-paragraph summary. The
 * critic ALSO emits its ```anvil-spec-critique fenced block in its visible
 * output; this schema is the machine-readable projection the synthesizer
 * consumes.
 */
const CRITIQUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["critic", "angle", "findings", "verified", "summary"],
  properties: {
    critic: { type: "string", description: "Which critic produced this: 'A' or 'B'" },
    angle: { type: "string", description: "The review angle this critic was assigned (so the synthesizer knows the lens)" },
    findings: {
      type: "array",
      description: "One entry per distinct weakness found in the spec.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "where", "issue", "impact", "suggestion"],
        properties: {
          severity: { type: "string", enum: ["BLOCKER", "HIGH", "MEDIUM", "LOW"] },
          title: { type: "string", description: "Short finding title" },
          where: { type: "string", description: "Section of the spec or file reference the finding applies to" },
          issue: { type: "string", description: "What is wrong" },
          impact: { type: "string", description: "What goes wrong if the implementing agent hits this" },
          suggestion: { type: "string", description: "Concrete fix — the actual replacement text, not 'be more specific'" },
          dependsOnProductIntent: {
            type: "boolean",
            description: "True if the correct fix depends on product intent, not spec quality (likely an Open Question, not an auto-applicable edit)",
          },
        },
      },
    },
    verified: {
      type: "array",
      description: "Checklist of what the critic verified against the spec/codebase (file paths read, criteria walked, etc.)",
      items: { type: "string" },
    },
    summary: { type: "string", description: "2–3 sentence overall assessment of spec quality" },
  },
};

/**
 * The synthesizer's merged recommendations. Classifies every finding as
 * corroborated / single-critic-only / conflicting, proposes concrete spec
 * edits with EXACT current text + replacement text, and lifts product-intent
 * questions into openQuestions. The `applicable` flag on each edit gates
 * the apply phase: only corroborated/single-critic edits that are NOT
 * conflicting and NOT open questions may be written back automatically.
 */
const RECOMMENDATIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "edits", "openQuestions", "conflicts", "triage", "confidenceNote"],
  properties: {
    summary: {
      type: "string",
      description: "3–5 sentences: total findings, how many corroborated, any conflicts, and whether the spec is close to launch-ready.",
    },
    edits: {
      type: "array",
      description: "Priority-ordered, most impactful first. Each is a concrete spec edit.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "classification", "severity", "source", "currentText", "replacementText", "rationale", "applicable"],
        properties: {
          title: { type: "string" },
          classification: { type: "string", enum: ["corroborated", "single-critic-only", "synthesizer-addition"] },
          severity: { type: "string", enum: ["BLOCKER", "HIGH", "MEDIUM", "LOW"] },
          source: { type: "string", description: "e.g. 'Critic A \"x\" + Critic B \"y\"' or just one critic" },
          currentText: {
            type: "string",
            description: "The EXACT current spec text to replace, quoted verbatim from the body. Empty string ONLY for a pure insertion (replacementText is added text).",
          },
          replacementText: {
            type: "string",
            description: "The exact new text to substitute (or insert). Must be concrete prose/criteria — never an instruction like 'make this clearer'.",
          },
          rationale: { type: "string", description: "One sentence on why this edit matters" },
          applicable: {
            type: "boolean",
            description: "True if this edit is safe to auto-apply: corroborated or single-critic-only, NOT conflicting, NOT dependent on product intent, and currentText matches the spec exactly.",
          },
        },
      },
    },
    openQuestions: {
      type: "array",
      description: "Findings whose correct fix depends on product intent, not spec quality. LEFT for /anvil:adjudicate — never auto-applied.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "raisedBy", "context"],
        properties: {
          question: { type: "string" },
          raisedBy: { type: "string", enum: ["Critic A", "Critic B", "both"] },
          context: { type: "string", description: "Why this matters / what hinges on the answer" },
        },
      },
    },
    conflicts: {
      type: "array",
      description: "Findings where the two critics DISAGREE (one says fine, one says broken). LEFT for /anvil:adjudicate — never auto-applied.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "criticAPosition", "criticBPosition", "context"],
        properties: {
          title: { type: "string" },
          criticAPosition: { type: "string" },
          criticBPosition: { type: "string" },
          context: { type: "string", description: "What the human must decide to resolve it" },
        },
      },
    },
    triage: {
      type: "array",
      description: "Full classification of every finding from both critics, for transparency.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["finding", "criticA", "criticB", "classification", "action"],
        properties: {
          finding: { type: "string" },
          criticA: { type: "string", description: "e.g. '✓ BLOCKER', '—', or '✗ (disagrees)'" },
          criticB: { type: "string" },
          classification: { type: "string", enum: ["corroborated", "single-critic-only", "conflicting"] },
          action: { type: "string", description: "e.g. 'Edit #1', 'Open Question #2', 'Conflict #1'" },
        },
      },
    },
    confidenceNote: {
      type: "string",
      description: "1–2 sentences: were the two critiques largely aligned (high confidence) or did they diverge (lower confidence, more open questions)?",
    },
  },
};

// ─── The two critic angles ──────────────────────────────────────────────────
//
// Deliberately different lenses AND different models so the critics' blind
// spots differ on both axes. We index into this list (no randomness) and pass
// each entry's `model` explicitly via opts.model (the anvil-critic agent
// definition pins no model); the synthesizer is told each critic's angle so it
// can reason about WHY a finding might be single-critic-only. Spec quality is
// the highest-leverage phase, so the strongest model takes the correctness
// lens and a different model family takes the completeness lens.

const CRITIC_ANGLES = [
  {
    label: "A",
    model: "opus",
    angle: "Correctness & contracts",
    focus:
      "Hunt for vague/untestable acceptance criteria, undefined error & empty-input behavior, contradictions between sections, and file paths the spec cites but that may not exist. Verify every path against the repo with read-only tools. Assume a literal-minded agent that interprets any ambiguity in the worst way.",
  },
  {
    label: "B",
    model: "sonnet",
    angle: "Completeness & self-containment",
    focus:
      "Hunt for missing context the implementing agent would need (it sees ONLY this spec — no CLAUDE.md, no conversation), decisions silently deferred to the agent ('choose an appropriate X'), scope creep, missing integration points (how existing code calls the new code), and unstated assumptions about config/dependencies/conventions.",
  },
];

// ─── Workflow body ──────────────────────────────────────────────────────────
// Runs at top level: agent/parallel/phase/log/args are runtime globals.

{
  const specArg = (args || "").trim();
  if (!specArg) {
    log("No spec id or path provided. Usage: /anvil:critique <spec-id|path-to-spec.md>");
    return { error: "missing-spec-arg" };
  }

  // ── Phase 1: load the spec (the sole input) ───────────────────────────────
  phase("load");
  log(`Resolving spec: ${specArg}`);

  const spec = await agent(
    [
      "You are resolving and reading an anvil spec. anvil keeps all state OUT of the target repo, operator-scoped.",
      "",
      `The caller passed this argument: ${specArg}`,
      "",
      "Resolve it to a spec file:",
      "- If it is an absolute path to a .md file, use it directly.",
      "- Otherwise treat it as a spec id and resolve to: ${ANVIL_SPECS_DIR:-$HOME/.anvil/specs}/<id>.md",
      "  Use bash to expand the path: dir=\"${ANVIL_SPECS_DIR:-$HOME/.anvil/specs}\"; file=\"$dir/<id>.md\".",
      "",
      "Then read the ENTIRE file and return it verbatim. Do NOT summarize, truncate, or reformat the body — downstream agents treat it as the SOLE INPUT and must see exactly what an implementing agent would see.",
      "Set found=false (and body to an empty string) if the file does not exist.",
      "The title is the first markdown H1 in the body, or the spec id if there is no H1.",
    ].join("\n"),
    { schema: SPEC_SCHEMA, phase: "load", label: "load-spec" },
  );

  if (!spec || !spec.found || !spec.body) {
    if (!spec) return { error: "spec-load-failed", specPath: specArg };
    log(`Spec not found or empty at ${spec.specPath || specArg}. Nothing to critique.`);
    return { error: "spec-not-found", specPath: spec.specPath || specArg };
  }
  log(`Loaded spec "${spec.title}" (${spec.body.length} chars) from ${spec.specPath}`);

  // ── Phase 2: two independent critics in parallel ──────────────────────────
  phase("critique");
  log("Running two independent critics in parallel (differing angles/models)…");

  // Prefer the anvil-critic plugin subagent. Installed plugin agents register
  // NAMESPACED ("anvil:anvil-critic"); the bare name covers any unprefixed
  // registration. If neither resolves (plugin not installed / not reloaded),
  // fall back to the default workflow subagent — the critic prompt carries the
  // severity rubric, read-only rules, and output contract inline, so the
  // fallback loses polish, not the contract.
  const runCritic = async (ac) => {
    const prompt = buildCriticPrompt(spec, ac);
    const opts = { model: ac.model, schema: CRITIQUE_SCHEMA, phase: "critique", label: `critic-${ac.label}` };
    for (const agentType of ["anvil:anvil-critic", "anvil-critic"]) {
      try {
        return await agent(prompt, { ...opts, agentType });
      } catch (e) { /* try the next name */ }
    }
    log(`critic-${ac.label}: anvil-critic agent type unavailable — falling back to the default subagent (install the anvil plugin and run /reload-plugins to use the dedicated critic).`);
    return agent(prompt, opts);
  };

  const critiques = await parallel(CRITIC_ANGLES.map((ac) => () => runCritic(ac)));

  // parallel() resolves a failed/skipped agent to null — degrade, don't throw.
  const [critiqueA, critiqueB] = critiques;
  if (!critiqueA && !critiqueB) {
    log("Both critics failed — nothing to synthesize.");
    return { error: "critics-failed", specId: spec.specId, specPath: spec.specPath };
  }
  if (!critiqueA || !critiqueB) {
    log(
      `Critic ${!critiqueA ? "A" : "B"} failed — proceeding single-critic. ` +
        "Corroboration is unavailable; the synthesizer is told so.",
    );
  }
  const totalFindings = (critiqueA?.findings?.length || 0) + (critiqueB?.findings?.length || 0);
  log(
    `Critic A (${CRITIC_ANGLES[0].angle}): ${critiqueA?.findings?.length ?? "FAILED"} findings. ` +
      `Critic B (${CRITIC_ANGLES[1].angle}): ${critiqueB?.findings?.length ?? "FAILED"} findings. ` +
      `${totalFindings} raw total.`,
  );

  // ── Phase 3: synthesize ───────────────────────────────────────────────────
  phase("synthesize");
  log("Synthesizing critiques → corroborated / single-critic / conflicting + open questions…");

  // Synthesis is a planning-phase judgment call — run it on the strongest model.
  const recommendations = await agent(buildSynthPrompt(spec, critiqueA, critiqueB), {
    schema: RECOMMENDATIONS_SCHEMA,
    model: "opus",
    phase: "synthesize",
    label: "synthesizer",
  });

  if (!recommendations) {
    log("Synthesizer failed — returning the raw critiques for manual triage.");
    return {
      error: "synthesizer-failed",
      specId: spec.specId,
      specPath: spec.specPath,
      critiques: { A: critiqueA, B: critiqueB },
    };
  }

  log(
    `Recommendations: ${recommendations.edits?.length || 0} proposed edit(s), ` +
      `${recommendations.conflicts?.length || 0} conflict(s), ` +
      `${recommendations.openQuestions?.length || 0} open question(s).`,
  );

  // ── Phase 4: hand off to /anvil:adjudicate (the SOLE write-back surface) ────
  // We deliberately do NOT modify the spec here. Auto-applying edits in BOTH the
  // workflow and /anvil:adjudicate would double-apply, and the "one write-back
  // surface" invariant must hold (adjudicate owns every spec change). The calling
  // /anvil:critique skill persists this recommendations object to
  // ~/.anvil/specs/<id>.recommendations.md so adjudicate can apply edits and
  // resolve cruxes against the spec.
  phase("apply");
  log(
    "Spec left unchanged by design — /anvil:adjudicate applies the edits and resolves " +
      `${recommendations.conflicts?.length || 0} conflict(s) + ` +
      `${recommendations.openQuestions?.length || 0} open question(s).`,
  );

  return {
    specId: spec.specId,
    specPath: spec.specPath,
    title: spec.title,
    recommendations,
  };
}

// ─── Prompt builders ────────────────────────────────────────────────────────

function buildCriticPrompt(spec, angleConfig) {
  return [
    `You are Critic ${angleConfig.label} in an adversarial review of an anvil spec.`,
    "",
    "## Why you exist",
    "This spec will be handed VERBATIM to a coding agent. That agent sees ONLY this spec body —",
    "not this review, not the repo's CLAUDE.md, not any conversation. Anything not in the spec does",
    "not exist as far as the implementing agent is concerned. Find the weaknesses now, while fixing",
    "them is cheap. Assume the implementing agent interprets every ambiguity in the worst possible way.",
    "",
    `## Your assigned angle: ${angleConfig.angle}`,
    angleConfig.focus,
    "",
    "(There is a second critic working a different angle. Do NOT try to cover their lens —",
    "stay sharp on yours so our blind spots differ. The synthesizer will merge us.)",
    "",
    "## Tools",
    "Read-only against the target repo: read files, and bash limited to ls/cat/head/tail/grep/rg/find/wc",
    "and read-only git (log/show/diff/branch). For every file path the spec cites, verify it actually",
    "exists and contains what the spec claims. Do NOT edit, write, or run mutating commands.",
    "",
    "## Severity (pick exactly one per finding; when between two, pick the higher)",
    "- BLOCKER — the agent will almost certainly fail or produce wrong output (untestable criterion,",
    "  wrong critical file path, contradictory requirements, missing error-handling spec, key decision",
    "  deferred to the agent).",
    "- HIGH — significant gap likely (vague-but-testable criterion, unaddressed edge case, implicit",
    "  assumption, scope mismatch, missing integration point).",
    "- MEDIUM — ambiguity the agent will probably resolve but shouldn't have to.",
    "- LOW — clarity nit (typo, redundancy, could-be-more-specific-but-fine).",
    "",
    "## Spec under review",
    `Title: ${spec.title}`,
    "",
    spec.body,
    "",
    "## Output",
    "First emit your critique as a single fenced block tagged exactly `anvil-spec-critique` containing",
    "your findings (each: [SEVERITY] title, Where, Issue, Impact, Suggestion), a 'What I Verified'",
    "checklist, and a 2–3 sentence Summary. Every Suggestion must be CONCRETE replacement text — the",
    "actual sentence/criterion to use, never 'be more specific'.",
    "Then return the structured object matching the schema, with critic set to",
    `"${angleConfig.label}" and angle set to "${angleConfig.angle}". For any finding whose correct fix`,
    "depends on product intent rather than spec quality, set dependsOnProductIntent=true.",
  ].join("\n");
}

function buildSynthPrompt(spec, critiqueA, critiqueB) {
  const singleCritic = !critiqueA || !critiqueB;
  return [
    "You are the anvil Critique Synthesizer. You are a NEUTRAL mediator, not a third critic — do not",
    "add your own opinions to severity; defer to the critics.",
    "",
    singleCritic
      ? "NOTE: one critic FAILED to return. You have only ONE critique below. Corroboration is\n" +
        "impossible: classify every finding 'single-critic-only', leave `conflicts` empty, and say in\n" +
        "the confidenceNote that this was a single-critic pass."
      : "You are given the original spec and two INDEPENDENT critiques produced from different angles\n" +
        "by different models (Critic A: opus, correctness lens; Critic B: sonnet, completeness lens).\n" +
        "Different models and lenses have different blind spots:",
    "- A finding raised by BOTH critics is almost certainly real → classification 'corroborated'.",
    "- A finding raised by only ONE critic is medium confidence → 'single-critic-only' (use judgment).",
    "- A finding the two critics DISAGREE on (one says fine, one says broken) → a CONFLICT; do NOT",
    "  resolve it — put it in `conflicts` for the human to adjudicate.",
    "",
    "## Hard rules",
    "- De-duplicate: the same weakness flagged by both critics is ONE corroborated finding, not two.",
    "- For corroborated findings, keep the HIGHER severity of the two critics.",
    "- BE CONCRETE. Every edit carries the EXACT current spec text (`currentText`, quoted verbatim from",
    "  the spec body so a downstream tool can find-and-replace it) and the exact `replacementText`.",
    "  'Make this clearer' is NOT a recommendation. For a pure insertion, leave currentText empty and",
    "  put the new text in replacementText.",
    "- Findings whose right fix depends on PRODUCT INTENT (not spec quality) go in `openQuestions`,",
    "  NOT in edits. These are left for /anvil:adjudicate.",
    "- Set `applicable: true` on an edit ONLY when it is corroborated or single-critic-only, is NOT a",
    "  conflict, does NOT depend on product intent, and its currentText appears verbatim in the spec.",
    "  Everything else is applicable:false (it will be deferred to adjudication).",
    "- Do NOT invent findings. You may add at most a few clearly-labelled 'synthesizer-addition' edits",
    "  if you spot something neither critic caught, but prioritize them below corroborated findings.",
    "- `triage` must classify EVERY finding from both critics, for transparency.",
    "",
    "## Original spec",
    `Title: ${spec.title}`,
    "",
    spec.body,
    "",
    `## Critique A — angle: ${critiqueA?.angle || "(A)"}`,
    critiqueA ? JSON.stringify(critiqueA, null, 2) : "(critic A failed — no critique)",
    "",
    `## Critique B — angle: ${critiqueB?.angle || "(B)"}`,
    critiqueB ? JSON.stringify(critiqueB, null, 2) : "(critic B failed — no critique)",
    "",
    "## Output",
    "First emit a single fenced block tagged exactly `anvil-spec-recommendations` with: Summary,",
    "Recommended Edits (priority-ordered, each with classification, severity, source, current text,",
    "recommended replacement, rationale), Open Questions, Conflicts, a Findings Triage table, and a",
    "Confidence Note. Then return the structured object matching the schema.",
  ].join("\n");
}
