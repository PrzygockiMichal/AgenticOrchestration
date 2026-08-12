# Agentic Orchestration

A portable [Claude Code](https://code.claude.com) plugin that turns the main session into an **orchestrator**: it gatekeeps, decomposes, dispatches work to specialist subagents, and integrates the results — instead of editing code inline.

The specialists are **project-agnostic**. They learn each project's stack, layout, conventions, and check commands at runtime by reading that project's `CLAUDE.md`. Nothing about any specific framework is baked into this plugin.

A **Phase 0 discovery step** (`/orchestrate-config init`) first figures out *what* it is pointed at — a single repo, a monorepo, or a parent folder of independent repos. A read-only meta agent (`orchestration-settings-manager`) does this **deterministically** from evidence on disk; the **workspace profile** is then *derived* from those detected facts plus your durable overrides, surfacing only the crucial calls for you to confirm. Every later run reads that profile, so "which repos are in scope", "where reports go", "what the diff is", and "where each repo's `CLAUDE.md`/skills live" are pinned down rather than guessed. A single run can target one member or several. The profile is **personal and gitignored** — it captures how *you* drive the workspace and never gets committed. A `SessionStart` readiness check nudges you to run `init` the first time you open an unconfigured folder; once configured, it instead primes the session to route code work through `/orchestrate`. Both behaviors are independently toggleable (`readiness_check`, `proactive_orchestration`).

## What's inside

This repo is a **Claude Code marketplace** (`agentic-orchestration`) hosting one **plugin** (`orchestration`):

| Component | What it is |
|-----------|-----------|
| `orchestration-settings-manager` | Read-only meta agent (Phase 0 + config lifecycle): deterministically detects topology, profiles members incl. knowledge links, derives the profile from detected facts ⊕ your overrides, returns only the crucial decisions. |
| `chuck-architect` | Plans and decomposes a ticket into a reviewable bundle (master plan + per-task contracts). |
| `chuck-engineer` | The single generic implementer — implements any code task (frontend, backend, services, data, systems, CLI, game/engine) from a contract, learning the stack from the member's CLAUDE.md. |
| `chuck-plan-reviewer` | Reviews plan bundles (per-task rubric + global synthesis). |
| `chuck-code-reviewer` | Reviews completed work (per-task rubric + integration synthesis). |
| `orchestration-intelligence` | Background meta agent: distills your in-run corrections into accept/drop intelligence candidates (learned trigger → directive → why entries), written only through `lib/intelligence.mjs`. |
| `/orchestrate-config` | Manage your personal config: `init` (detect + derive), `show`, `set` (guided menus — no hand-typed paths), `update` (re-detect + reconcile). |
| `/orchestrate` | Slash command to run a ticket through the full workflow. |
| `hooks/` + `lib/onboarding.mjs` + `lib/prompt-nudge.mjs` | Readiness check: on an *unconfigured* folder, `SessionStart` shows a visible notice and `UserPromptSubmit` asks how to proceed on your first prompt (configure now / skip this session / disable here — once per session); on a *configured* one, it primes the session to route code work through `/orchestrate`. Two independent toggles: `readiness_check` (the nudge) and `proactive_orchestration` (the priming). |
| `ORCHESTRATION.md` | The generic workflow, contract template, hard gates, run manifest, and resume rules. |
| `WORKSPACE.md` | Topology definitions, the detection algorithm (spec for `lib/detect.mjs`), and the workspace-profile JSON schema. |
| `lib/` | Zero-dependency node scripts that make the mechanical parts deterministic: `detect.mjs` (topology + member profiling incl. knowledge links), `overrides.mjs` (durable overrides + derive profile = detected ⊕ overrides), `profile.mjs` (validate/render), `config.mjs` (settings cascade), `settings.mjs` (opt-in report auto-save), `version.mjs` (plugin version stamp + upgrade severity), `paths.mjs` (file locations), `intelligence.mjs` (deterministic writer/reader for learned-guidance entries), `readiness.mjs`/`onboarding.mjs`/`prompt-nudge.mjs` (readiness check + onboarding notice/question), `manifest.mjs`/`gates.mjs` (run state + gates), `schema.mjs` (validators). |
| `plan-review-rubric`, `code-review-rubric`, `intelligence-rubric` | Deterministic checklists: per-task plan/code review, and the identification bar for what counts as an intelligence candidate. |

## Install

```text
# 1. Add this marketplace (one time, per machine)
/plugin marketplace add ShiruAvine/AgenticOrchestration

# 2. Install the plugin
/plugin install orchestration@agentic-orchestration
```

## Activate / deactivate (personal)

This is a **personal** workflow tool, so enable it for *yourself* rather than committing it to a shared repo. Put this in your user-level `~/.claude/settings.json` to turn it on everywhere:

```json
{
  "enabledPlugins": {
    "orchestration@agentic-orchestration": true
  }
}
```

Set it to `false` (or omit it) to deactivate. If you *do* want a whole team to share the same on/off state, the same key works in a project's committed `.claude/settings.json` — but the workspace profile itself always stays personal and gitignored.

## Workspaces & topologies

The orchestrator runs against a **workspace**, which is *not* assumed to be one git repo. Three topologies are supported (see `orchestration/WORKSPACE.md`):

| Topology | What it is | Profile location (personal, gitignored) |
|----------|-----------|------------------|
| `single-repo` | one repo, one project | `<repo>/.claude/orchestration/workspace.local.json` (+ rendered `.md`) |
| `monorepo` | one repo, many sub-projects | `<repo>/.claude/orchestration/workspace.local.json` (+ rendered `.md`) |
| `multi-repo` | a non-repo parent folder of independent repos opened together | `<workspace-root>/.claude/orchestration/workspace.json` (+ rendered `.md`) |

Run `/orchestrate-config init` once per workspace (or whenever it changes). It dispatches `orchestration-settings-manager` to detect the topology and profile every member deterministically, asks you **only the crucial decisions** (ambiguous topology, missing `CLAUDE.md`, unresolved gates), records your answers as durable overrides, and derives the profile — recording each member's stack, gate commands, knowledge links, and any per-case handling (e.g. "this member has no lint script — skip that gate"). There is no per-member role: every workspace has all specialists available. Code implementation goes to a single generic engineer (`chuck-engineer`); the architect assigns each task an `ASSIGNED_REPO` and the engineer learns that member's stack from its `CLAUDE.md`. It also adds the `.gitignore` entries that keep the profile and reports personal. After that, `/orchestrate` reads the profile and tags each task with an `ASSIGNED_REPO`, so one run can span multiple repos when a feature crosses them. Re-run `/orchestrate-config update` to re-detect and reconcile without losing your overrides.

## Wire it into a project

The plugin supplies the *generic* machinery. Each member supplies its own **domain map** — which directories hold what, which framework, which convention checks and lint/test commands to run. Put that in the member's `CLAUDE.md` (or a file it imports). The specialists read it before doing any work. (`/orchestrate-config init` can scaffold a minimal one for members that lack it.)

A minimal project `CLAUDE.md` section looks like:

```markdown
# Project Domain Map

## Frontend
- Codebase: `<dir>/`
- Framework: <framework + conventions>
- Convention check: <how to validate changed files>
- Lint / tests: <commands>

## Backend
- Codebase: `<dir>/`
- Framework: <framework + conventions>
- Convention check: <how to validate changed files>
- Lint / tests: <commands>
```

Work products are written outside the plugin: plan bundles and plan/integration reviews go to the workspace-level reports tree (`<workspace-root>/.claude/reports/...` for every topology), while engineer reports and per-task code reviews go to each touched member's own `.claude/reports/...`.

## How runs are tracked & gated

Each run keeps a **run manifest** (`run.json`, in the gitignored reports tree) recording the **workflow phases** (a programmatic checklist — `workspace → scope → plan → … → tasks_execution → integrate`, where `tasks_execution` expands per task into execute → review → approval), the per-member git baselines, and every task's status, observed gate results, review verdict, and user verification. It is the run's source of truth: diff baselines come from it rather than being re-threaded between steps, and an interrupted run **resumes from it** — picking up at the first task not marked `done` instead of starting over.

Gates are **independently verified, not self-reported**. After an engineer returns, the orchestrator runs that member's gate commands itself and records the observed result in the manifest; the hard gate keys off the observed result, and the code reviewer cross-checks the engineer's self-report against it. An engineer claiming `pass` when the gate actually fails is caught.

**The orchestrator learns from your corrections.** When you request changes or correct course mid-run, a background meta agent (`orchestration-intelligence`) distills the correction into a candidate entry (trigger → directive → why); the candidate surfaces for **accept or drop** at the verification gates you already see — never a new stop — and accepted entries steer future dispatches by phase (planning / implementation / review). Entries are personal and gitignored (`.claude/orchestration/intelligence/`), written only through the deterministic `lib/intelligence.mjs`, and the whole feature is toggleable via the `intelligence` setting (default on; off = fully inert).

**You stay in the loop.** The architect's plan is yours to approve before any code is written. During execution you choose the cadence: **Mode A** (default) stops after every task with a compact summary + links to the review, waits for your go-ahead, then continues; **Mode B** runs the plan to completion and gathers one review at the end. Either way a `reject` verdict or a failing gate halts immediately, and the orchestrator never commits — that stays your call.

## License

MIT — see [LICENSE](./LICENSE).

Published read-only. Contributions are not accepted; fork freely under the MIT terms.
