# Workspace Model

The orchestration workflow runs against a **workspace**. A workspace is whatever
the orchestrator is pointed at when a ticket comes in — it is *not* assumed to be
a single git repository. This file defines the topologies the plugin supports,
how to detect them, and the **workspace profile** that records the answers so every
later run is fast and deterministic.

Read this file during **Phase 0** of `ORCHESTRATION.md`. The `orchestration-settings-manager`
agent does the deterministic detection + derivation described here; the
`/orchestrate-config` command dispatches it, asks the user only the crucial
decisions it returns, and writes the profile; `/orchestrate` reads the profile (or
triggers `/orchestrate-config init` if it is missing).

## Personal, not shared

The workspace profile is a **personal** artifact — it captures how *you* drive this
workspace, and it must never be committed to a shared repo. Setup therefore writes
it to a gitignored location and adds the necessary `.gitignore` entries:

- **single-repo / monorepo:** `<repo>/.claude/orchestration/workspace.local.json`
  (source of truth) plus a generated `workspace.local.md` view. The `.local.*` suffix
  marks them personal; setup adds `.claude/orchestration/*.local.*` + `.claude/reports/`
  to the repo's `.gitignore`.
- **multi-repo:** `<workspace-root>/.claude/orchestration/workspace.json` (source of
  truth) plus a generated `workspace.md` view. The parent folder is not a repo, so it
  is inherently un-shared (no `.local` suffix needed); setup still adds `.claude/reports/`
  to each **member** repo's `.gitignore`, since engineer/review reports land there.

The location pattern is **uniform**: the profile always lives at
`<workspace-root>/.claude/orchestration/`, and workspace-level work products always at
`<workspace-root>/.claude/reports/` — the only difference across topologies is the
`.local` filename suffix (used inside a repo, where it must be gitignored).

The **`.json` is the machine source of truth** that every later step reads; the `.md`
is a human-readable view rendered from it by `lib/profile.mjs`. Never parse the `.md`.

Plugin **enablement** is likewise best kept personal: enable orchestration in your
user-level `~/.claude/settings.json` rather than committing it to a project's
`.claude/settings.json`.

## Why this exists

The specialists bind to a project via its `CLAUDE.md`. But "the project" is
ambiguous: it might be one repo, one repo with many packages, or a folder of
many independent repos opened together. Each shape changes three concrete things:

- **Where `CLAUDE.md` lives** (one root vs. one per member).
- **Where work products go** (`.claude/reports/...` of *which* repo?).
- **What "the diff" is** (one `git diff` vs. one per member, with per-member baselines).

Guessing these per run is where the generic workflow used to drift. The workspace
profile pins them down once, with the user's confirmation.

## Topologies

### `single-repo`
The current working directory is inside one git repository, and that repository
is a single project (one `CLAUDE.md`, one package/module tree).

- **Members:** one — the repo itself.
- **Profile location:** `<repo>/.claude/orchestration/workspace.local.json` (+ rendered `.md`; gitignored)
- **Reports:** `<repo>/.claude/reports/...` (gitignored)
- **Diff baseline:** one, in that repo.

### `monorepo`
The working directory is inside one git repository that contains **multiple
sub-projects** (packages / apps / services), e.g. detected via a `workspaces`
field, multiple `package.json`/`pyproject.toml`, or multiple nested `CLAUDE.md`.

- **Members:** each detected sub-project (all are included; scope is chosen per run).
- **Profile location:** `<repo>/.claude/orchestration/workspace.local.json` (+ rendered `.md`; gitignored)
- **Reports:** `<repo>/.claude/reports/...` (gitignored; single reports tree; tag entries by member).
- **Diff baseline:** one repo, but per-member diffs are scoped by member path
  (`git diff <baseline> -- <member-path>`).

### `multi-repo` (parent / workspace folder)
The working directory is **not** a git repository; its immediate children include
two or more independent git repositories opened together (the "parent folder"
workflow). Each member repo is autonomous — its own history, branch, `CLAUDE.md`,
and `.claude/`.

- **Members:** each detected child repo (all are included; scope is chosen per run).
- **Profile location:** `<workspace-root>/.claude/orchestration/workspace.json` (+ rendered `.md`)
  (the parent is not a repo, so it is inherently un-shared — no `.local` suffix).
- **Reports:** workspace-level products (bundles, plan/integration reviews, run
  manifests) → `<workspace-root>/.claude/reports/...`; each member's engineer/code-review
  reports → its **own** `<member>/.claude/reports/...` (setup gitignores that path in
  each member).
- **Diff baseline:** one **per member**, in that member's repo.

## Tooling (`lib/`)

The mechanical work is **code**, not prose-the-LLM-interprets. These zero-dependency
node scripts under `${CLAUDE_PLUGIN_ROOT}/lib/` are the deterministic substrate:

- **`detect.mjs`** — runs the detection algorithm; emits a `workspace@3` JSON object
  (facts incl. per-member `knowledge` links + `decisions_needed`) on stdout. `node detect.mjs [root]`.
- **`overrides.mjs`** — the durable overrides layer + derivation engine:
  `apply <detected> <overrides>` (profile = detected ⊕ overrides), `set`/`unset` (the
  deterministic structured writer the command calls), `validate`, `show`.
- **`profile.mjs`** — `validate <json>` (schema check) and `render <json>` (emit the
  human `.md` view). It no longer merges — derivation lives in `overrides.mjs`.
- **`config.mjs`** — plugin settings (the readiness check): cascade
  defaults < global < per-workspace; `show`/`get`/`set`.
- **`paths.mjs`** — resolves the profile / overrides / draft locations for a root +
  topology, so nothing re-derives the file convention in prose.
- **`schema.mjs`** — the validators (the single definition of every data shape).
- **`manifest.mjs` / `gates.mjs`** — run-time substrate (see `ORCHESTRATION.md`).

The LLM's job shrinks to judgment: ask the crucial decisions, record them as
overrides, and let the scripts derive and validate the profile.

## Provenance: detected facts vs. durable overrides

The profile is split by **provenance**, and this is what makes `update` safe:

- **Detected facts** are always re-derivable from disk (`detect.mjs`) and are **never
  the durable truth** — they are recomputed whenever we want them.
- **Overrides** (`overrides.local.json`) are the **only durable, human-authored
  artifact**: stack/gate/knowledge decisions the user made that must outlive
  re-detection. This is what `/orchestrate-config set` writes (via `overrides.mjs`).
- **The profile is derived** = `detected ⊕ overrides` (`overrides.mjs apply`),
  regenerated by `init`/`update`. Never hand-edited — mirrors how the `.md` is derived
  from the `.json`.

So `update` is correct by construction: re-detect, re-apply the same overrides. New
members / gates / knowledge flow in automatically; user overrides are preserved; the
only true conflict is a **stale override** (one pointing at a member no longer
detected), which is surfaced rather than silently dropped.

### Knowledge links (per member)

Each member records `knowledge`: fixed slots (`claude_md`, `skills`, `rubrics`) — each
a resolved path or `null` (null = no link *or* the file is absent; consumers treat both
the same) — plus `extra`, a free-form object for user-defined links (e.g. a runbook, an
ADR dir). Detection fills `claude_md`/`skills`; `rubrics` and `extra` are user-supplied
via overrides. Agents read these instead of re-hunting for a repo's knowledge each run.

**`skills` is the single `.claude/skills` FOLDER path — never a list and never one entry
per skill.** Claude Code discovers the individual skills inside that folder on its own
(and auto-discovers new ones), so enumerating them is both wrong for the schema
(`skills` is one string) and pointless. Likewise, `extra` is for a *handful* of named
docs — do **not** bulk-populate it with one entry per skill. One folder link scales to
any number of skills with zero maintenance.

### Settings

Beyond Claude Code's built-in `enabledPlugins` (plugin on/off everywhere, not reinvented
here), the plugin owns **two boolean switches** in `config.mjs`, both default ON, cascading
global (`~/.claude/orchestration/config.json`) < per-workspace
(`.claude/orchestration/config.local.json`). All hooks share one deterministic decision
(`lib/readiness.mjs`) and read the settings at each invocation.

- **`readiness_check`** — the **UNconfigured**-workspace onboarding flow. Gates the
  `SessionStart` notice (`lib/onboarding.mjs`) and the `UserPromptSubmit` question
  (`lib/prompt-nudge.mjs`, "configure now / skip this session / disable here", once per
  session via a marker under `~/.claude/orchestration/session-nudges/`). "Disable here"
  writes `readiness_check false` at the per-workspace layer.
- **`proactive_orchestration`** — the **CONFIGURED**-workspace behavior. When on, the
  `SessionStart` hook primes the main session (model-facing context, no user banner) to
  route non-trivial code work through `/orchestrate` per `ORCHESTRATION.md`. Turn it off
  when you'd rather invoke `/orchestrate` on purpose and not be steered toward it by
  default; the workspace stays configured, the hook just stays quiet.

**Auto-saving reports.** A plugin can't grant itself permissions, so report writes
(engineer/reviewer/architect output under `.claude/reports/`) prompt by default. During
`init` the command offers to add one scoped rule — `Edit(**/.claude/reports/**)` — to the
personal, gitignored `.claude/settings.local.json` via `lib/settings.mjs`, so those writes
stop prompting. `Edit(...)` covers Write+Edit and the `**/…` pattern matches every
per-member reports tree. It's opt-in, idempotent, and takes effect in a new session.

## Setup flow

Phase 0 is deterministic-first, human-light:

1. **`/orchestrate-config init` dispatches `orchestration-settings-manager`** — a
   read-only agent that RUNS `lib/detect.mjs`, sanity-checks the JSON, writes it to a
   `workspace.json.draft`, and returns the draft path, the members table, the
   `decisions_needed` list (crucial items only), and proposed `.gitignore` actions.
2. **The command asks the user only the crucial decisions** (via `AskUserQuestion`),
   each pre-filled with the script's recommended default.
3. **The command records answers as overrides and derives the profile** — seeds
   `overrides.local.json` via `lib/overrides.mjs set`, runs `lib/overrides.mjs apply`
   (detected ⊕ overrides, validated) then `lib/profile.mjs render`, applies the
   `.gitignore` actions, promotes the draft to `workspace.json` (+ `.md`), and reports.

Later `/orchestrate-config` actions: **`update`** re-detects and re-applies the same
overrides (surfacing drift + stale-override conflicts); **`set`** changes settings or
profile fields through guided menus; **`show`** renders the current config.

## Detection algorithm (deterministic)

**This algorithm is implemented as code in `lib/detect.mjs` and executed — it is no
longer interpreted prose.** `orchestration-settings-manager` RUNS the script
(`node ${CLAUDE_PLUGIN_ROOT}/lib/detect.mjs <root>`) and consumes its JSON output;
the steps below are that script's **specification** (and the fallback if node is
unavailable). The script emits a `workspace@3` object with `decisions_needed`
populated; it never guesses — insufficient evidence becomes a decision, not a value.

Every conclusion must come from a command output or a file read — never a guess. If
evidence is insufficient for a field, it becomes a `decisions_needed` item, not an
invented value.

1. **Topology.** `git rev-parse --is-inside-work-tree` in the cwd.
   - **true** → `single-repo` or `monorepo`. From `git rev-parse --show-toplevel`,
     count distinct sub-project markers (a `workspaces` field in root `package.json`;
     `pnpm-workspace.yaml`; `nx.json`/`turbo.json`/`lerna.json`; or >1
     `package.json`/`pyproject.toml`/`go.mod`/`Cargo.toml`/`pom.xml`/`build.gradle(.kts)`
     in distinct subdirs, excluding `node_modules`/`vendor`/`dist`/`build`/`.git`).
     >1 → `monorepo`; else `single-repo`.
   - **false/error** → scan immediate children (`for d in */; do [ -d "$d/.git" ] && echo "$d"; done`).
     ≥1 child repo → `multi-repo`; 0 → nothing to orchestrate (block; ask where code lives).

2. **Per-member facts** (commands, not guesses):
   - `path` (relative to workspace root; `.` for single-repo)
   - `git` + `default_branch` (`git -C <path> symbolic-ref --short HEAD`)
   - `stack` (read `package.json` deps, `pyproject.toml`/`requirements.txt`/notebooks,
     `go.mod`, `Cargo.toml`, `pom.xml`, `build.gradle`(.kts), `docker-compose*.yml`;
     a lone Dockerfile is deliberately NOT a stack signal)
   - `claude_md` present? (absent is allowed but flagged — gates will be weaker)
   - `gates` from `package.json` scripts (`lint`/`test`/`test:e2e`/`build`/`typecheck`,
     exact command strings) or the stack equivalent. No script → `none` (never fabricate).
   - `knowledge` links — resolved paths to the member's `CLAUDE.md` and `.claude/skills`
     (each a path or `null`; `rubrics` and custom `extra` links are filled via overrides).

3. **No role classification.** Members record **stack facts only** (the `stack` label
   from step 2). There is deliberately **no per-member owning agent**: every workspace
   has all specialists available (architect, the single `chuck-engineer`, both
   reviewers). There is one generic implementer — `chuck-engineer` handles all code
   work — so there is no frontend/backend assignment to make; `chuck-architect` just
   sets each task's `ASSIGNED_REPO` and grounds it in that member's `CLAUDE.md`.
   Nothing is ever excluded by classification — a member with an unusual stack
   (research/ML, infra, an unsupported language) is still a valid, fully-usable member;
   it simply gets no gate/`CLAUDE.md` prompts when there is nothing standard to ask.

4. Draft the profile and surface decisions per the rules below.

## Crucial decisions only

The analyst raises a decision **only** when evidence is genuinely insufficient or the
choice is consequential and not inferable. Everything detection settles is recorded in
the draft as a default the user can simply accept — it is *not* asked.

Raise a decision for:
- **Ambiguous topology** (e.g. a repo that is both an app and a set of packages).
- **Missing `CLAUDE.md`** — generate a minimal one / proceed with reduced context.
- **Unresolved gate** for a code member (e.g. no detectable test command).

Do NOT ask about: detected stack, detected branch, gate commands that were found,
profile/report locations, or the standard defaults below (record them, let the user
override later if they care).

Recorded defaults (not asked): architect default-on; parallelism opt-in;
human-gate cadence per-task.

Per-run, in addition: **which members does *this ticket* touch?** The profile is
the persistent registry; scope is chosen per execution (one, some, or all members).

## Workspace profile format

The profile is **`workspace.json`** — schema `orchestration/workspace@3`, the exact
shape `lib/schema.mjs` validates and `lib/detect.mjs` emits. It is a **derived**
artifact (detected facts ⊕ the durable `overrides.local.json`, produced by
`lib/overrides.mjs apply`), regenerated by `init`/`update` — never hand-edited. It is
the single source of truth every later step reads. A human-readable `workspace.md` is
**rendered from it** by `lib/profile.mjs render`; do not hand-edit the `.md`, and do
not parse it programmatically.

```jsonc
{
  "schema": "orchestration/workspace@3",
  "plugin_version": "<plugin semver that generated this profile>",  // stamped by detect.mjs; drives upgrade severity
  "generated": "<ISO-8601>",
  "topology": "single-repo | monorepo | multi-repo",
  "workspace_root": "<absolute path>",
  "members": [{
    "id": "<slug>",
    "path": "<relative to workspace_root; '.' for single-repo>",
    "git": true,
    "default_branch": "<branch | null>",
    "stack": "<e.g. NestJS/TS | Express/TS | Python | Rust | Java (Maven) | infra (docker-compose)>",
    "claude_md": "present | absent",
    "gates": { "convention": "<cmd|null>", "lint": "<cmd|null>",
               "test": "<cmd|null>", "build": "<cmd|null>" },   // null = no gate (never fabricated)
    "knowledge": { "claude_md": "<path|null>", "skills": "<path|null>",
                   "rubrics": "<path|null>", "extra": { } },     // resolved links; extra = free-form user links
    "reports_dir": "<path where this member's reports go>",
    "notes": ["<detected per-member gotcha>", "..."]
  }],
  "decisions_needed": [{ "member": "<id>", "question": "<...>", "recommended": "<default>", "options": ["..."] }],
  "defaults": { "architect": "default-on", "parallelism": "opt-in", "human_gate": "per-task" }
}
```

`decisions_needed` is populated by detection and emptied once the user's answers are
recorded as overrides and the profile is derived (`lib/overrides.mjs apply`). The
rendered `.md` derives the `Specialists` section, `Per-case handling` (from member
`notes`), and `How to run` automatically — they are not stored.

## Per-run scope resolution

Once the profile exists, each `/orchestrate` invocation:

1. Loads the profile.
2. Determines the **active member set** for this ticket — by explicit user
   statement ("work on predictions-api"), by inference from the ticket, or by
   asking. The set may be one member, several, or all members.
3. Passes each task an `ASSIGNED_REPO` = the member `id` it belongs to. For
   `single-repo` this is always the one member and can be omitted.

## How `ASSIGNED_REPO` flows

- **chuck-architect** sets `ASSIGNED_REPO` on every task contract (the member the
  task lives in) and may produce a plan whose tasks span multiple members.
- **engineers** operate **inside** their task's `ASSIGNED_REPO` member: they read
  *that member's* `CLAUDE.md`, edit only within that member's path, and run *that
  member's* gate commands from the profile. Write the report to that member's
  `reports_dir`.
- **reviewers** scope the diff to the task's member with that member's baseline
  (`git -C <member-path> diff <baseline>..HEAD -- <files>`), and for cross-member
  bundles check interface consistency *across* members during global synthesis.

## Members with an unusual stack

A member whose stack has no obvious engineer (Python ML/data research, pure
infra/compose, an unsupported language) is **still a fully-usable member** — it is
never excluded by classification. It appears in per-run scope resolution like any
other and any specialist can be dispatched against it. When a run's scope includes
such a member, `chuck-architect` assigns the best-fit engineer from the task's nature
and notes reduced confidence (and any missing gates) so `/orchestrate` can surface
that to the user; it may also have `none` gates, in which case there is nothing to
verify automatically. This is a per-task judgement the architect makes at planning
time, not a durable exclusion baked into the profile.

## Profile freshness

A profile is a cache of a moving target (branches change, scripts change, repos get
added). On each `/orchestrate`, if the member set or branches visibly drifted from
the profile, note it and offer to re-run `/orchestrate-config update`. Treat a recalled
profile as "true when written" — re-verify a gate command before relying on it if
anything looks stale.

Two version signals sit above per-run drift, both resolved by `/orchestrate-config update`
(which re-derives from the durable overrides):

- **Schema validity (hard).** If the on-disk profile fails the validator (e.g. an older
  `workspace@N`), the readiness check marks the workspace **stale** and routes to `update`
  — it is a configured workspace that must be re-derived, not an unconfigured one.
- **`plugin_version` gap (soft).** Every profile records the plugin version that
  produced it. `lib/version.mjs` grades the gap to the installed plugin as
  `current` / `patch` (optional) / `minor` (refresh recommended) / `major` (reconfigure —
  review carefully) / `ahead` (plugin older than the profile) / `unknown` (predates
  tracking). `show` reports this; use the severity to decide how strongly to suggest an
  `update`.
