# AgenticOrchestration

This repo is the **source of the `orchestration` Claude Code plugin** — the plugin that
turns a main Claude session into an orchestrator dispatching specialist agents. It is a
meta-repo: the plugin developed here is also installed and running in this very workspace.

## Layout

- `orchestration/` — the plugin itself (`.claude-plugin/plugin.json` is the manifest)
  - `agents/` — agent definitions (markdown + frontmatter)
  - `commands/` — slash-command definitions (`orchestrate.md`, `orchestrate-config.md`)
  - `skills/` — skills (one folder per skill, `SKILL.md` inside)
  - `hooks/hooks.json` — session/prompt hooks (readiness check, onboarding nudge)
  - `lib/` — **zero-dependency** node `.mjs` scripts: the deterministic substrate
    (detect, overrides, profile, config, manifest, gates, schema, paths, intelligence, …)
  - `ORCHESTRATION.md` — the orchestrator workflow (the core spec)
  - `WORKSPACE.md` — workspace topologies, profile schema, tooling contract
- `tests/` — zero-dep `node:test` suite for `lib/` (see Checks)
- `.claude-plugin/marketplace.json` — marketplace listing for local installs

## Stack & conventions

- **No package.json, no dependencies, no build.** `lib/` scripts run on bare
  `node` (ESM `.mjs`). Keep them zero-dep — never add npm packages.
- **Determinism-first.** Every step that can be code instead of LLM judgment is code.
  JSON is the source of truth; markdown views are *derived* (`profile.mjs render`).
  Durable state is written only through deterministic writers (`overrides.mjs set`,
  `manifest.mjs set`, `config.mjs set`) — never hand-edit derived or managed files.
- **Provenance split.** Detected facts are re-derivable and never durable; the only
  durable human artifact is the overrides layer. Profile = detected ⊕ overrides.
- **Agent naming.** `chuck-*` = code-working specialists (architect, engineer,
  reviewers). `orchestration-*` = meta agents about the plugin/workspace itself
  (settings-manager). Keep new agents on this convention.
- **Specialists stay generic.** Project-specific knowledge belongs in each project's
  CLAUDE.md / knowledge links, never baked into agent prompts.
- Versioning: bump `orchestration/.claude-plugin/plugin.json` and lead the commit
  subject with `vX.Y.Z:` (see git log for the style).

## Checks

The repo has a zero-dep `node:test` suite under `tests/`. Minimum bar for `lib/`
changes: `node --check <file>` passes, the full suite is green via
`node --test "tests/*.test.mjs"` (the bare-directory form `node --test tests/` is
broken on Windows/node 22 — always use the glob), and the script's own CLI
smoke-runs (e.g. `node orchestration/lib/detect.mjs .`). Behavior changes come with
tests. Schema changes must keep `schema.mjs` validation and every writer that feeds
it in sync.

## Docs to read before working here

- `orchestration/ORCHESTRATION.md` — the workflow contract all agents follow
- `orchestration/WORKSPACE.md` — profile schema (`workspace@4`), lib tooling contract
