# smithy

A personal Claude Code and Codex plugin marketplace. It ships one plugin:

## Anvil — plan with one agent, hand execution to Forged

The user works with a single lead agent to shape an idea into a locked spec or
epic. Anvil supplies the planning, proportional critique, and adjudication
skills. Once the user accepts the direction, the lead agent submits it to
**Forged** and can disconnect:

```text
conversation → plan → critique as needed → adjudicate → forged submit
                                                        ↓
                                  implement → gate → review → fix → draft PR
```

Execution is provider-neutral. Assurance profiles (`lean`, `standard`,
`high`) control topology; YAML rosters control ordered provider/model
candidates. Switching from Fable to Opus, or from Anthropic to Codex, is a
roster change rather than a workflow rewrite. Herdr provides observable panes
and interventions while Forged's ledger remains durable truth.

All state is operator-scoped under `$BEADS_DIR` and `$ANVIL_HOME` (normally
`~/.anvil`). Anvil never commits `.beads` or agent configuration to a target
repo and never edits its `CLAUDE.md`.

### Install

```text
/plugin marketplace add ~/repositories/smithy
/plugin install anvil@smithy
/anvil:setup
```

`/anvil:setup` verifies Beads, Forged, GitHub auth, provider adapters, the
profile/roster config, and optional Herdr supervision.

### Use

```text
/anvil:plan          idea → locked slice or epic map
/anvil:critique      proportional pre-execution review
/anvil:adjudicate    resolve cruxes and lock the spec
/anvil:dispatch      submit ready slices to Forged
/anvil:run-epic      submit a durable wave scheduler to Forged
```

`forged run submit` and `forged epic submit` return durable controller
identities immediately. A later agent can ask `forged overview` for status, use
Herdr-backed session controls, or render the same projection in the MCP App.
Slice runs stop at reviewed draft PRs; epic runs end at one draft PR from the
integration branch to the default branch. The human owns that merge.

See [the plugin guide](plugins/anvil/README.md) and
[the experiment evidence](plugins/anvil/LEARNINGS.md).

## License

[MIT License with the OpenAI/Anthropic rider](LICENSE) © 2026 Tripp Cashel —
see [NOTICE](NOTICE). The rider is a condition of the license, so read
`LICENSE` before redistributing.
