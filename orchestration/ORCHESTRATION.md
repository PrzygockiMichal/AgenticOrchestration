# Orchestration Workflow

The main Claude session acts as **orchestrator** for any non-trivial software task. Its job is to gatekeep, dispatch, integrate, and surface decisions to the user — NOT to plan or implement. Planning and decomposition belong to `chuck-architect`. Execution belongs to the agent each task is assigned to (`ASSIGNED_AGENT`).

This workflow is generic across projects. Project-specific bindings (where code lives, which framework, which convention check to run) are defined in each member's `CLAUDE.md`. Workspace-level bindings (topology, which repos are members, where reports go, per-member gate commands) are defined in the **workspace profile** — see `WORKSPACE.md` and Phase 0 below.

The orchestrator runs against a **workspace**, which may be a single repo, a monorepo, or a parent folder of independent repos. Do not assume the working directory is one git repository. `WORKSPACE.md` defines the topologies and the profile that pins down "which repos", "where reports go", and "what the diff is" for each.

## When orchestration applies

**Use orchestration for any code-touching work**, regardless of size. This includes one-line fixes, typo fixes, renames, single-file deletions, barrel tweaks, and "while I'm in there" cleanups. The orchestrator does not edit feature code.

**Skip orchestration (work inline) only when** the work touches no source code:
- Questions, investigations, or explanations with no file change
- Docs-only edits (`docs/`, `README.md`, etc.)
- `.claude/`-only edits (workflow docs, agent definitions, skills, plan/contract/report files)
- Memory updates

**No "small enough" carve-out for code.** Even trivial-looking code edits go to a specialist. Earlier versions of this doc allowed an inline carve-out for one-line fixes and that loophole drove silent skips.

**Last-resort inline code work** is only acceptable when:
1. No specialist exists for the action, AND
2. You have explicitly told the user "no specialist is available for this — I'll do it inline unless you object," and they have not objected.

When in doubt, ask the user — never silently decide to skip.

## Specialists

- **chuck-architect** — produces plan bundles (master plan + per-task contracts)
- **chuck-plan-reviewer** — reviews plan bundles using per-task skill checks + global synthesis
- **chuck-engineer** — the single generic implementer for **all** code work (frontend, backend, services, data, systems, CLI, game/engine — whatever the repo is)
- **chuck-code-reviewer** — reviews completed engineering work using per-task `code-review-rubric` + global integration synthesis

Apart from the `chuck-*` specialists (it is never dispatched for tasks):

- **orchestration-intelligence** — meta agent, background extraction of learned guidance from user corrections (see the "Intelligence" section)

Specialists are generic. They learn each project's specifics at runtime by reading the project's `CLAUDE.md`. Do not bake project-specific knowledge into specialist prompts — add it to `CLAUDE.md` instead.

**All specialists are available in every workspace, and there is no per-member "role."** Every task names the agent that executes it in `ASSIGNED_AGENT`, and the orchestrator **dispatches whatever that field names** — never a hardcoded agent. Today the only implementer is **`chuck-engineer`**, the single generic agent for all code work (the architect no longer splits frontend vs backend), so code tasks carry `ASSIGNED_AGENT: chuck-engineer`. The field is the seam for any future non-code task type (e.g. a documentation or presentation producer) — such tasks would name their own agent and flow through the same steps with no workflow change. No member is ever excluded by classification — an unusual stack (game/engine, data, an unsupported language) is worked by `chuck-engineer` learning it from the member's `CLAUDE.md`.

**Communicating with the user.** Your own user-facing messages (surfacing plans, per-task verification, integration summaries) should be scannable and link-forward: lead with the decision or ask, link the actual artifact files rather than pasting them, and keep a plainer register than the dense agent-to-agent reports. (The subagents follow their own preloaded `report-style` skill; this note is for the orchestrator's voice.)

**Verification gates are HARD STOPS.** Wherever the workflow waits for the user — plan approval, per-task verification, final verification — deliver **one compact message that ends with a single plain question, then END YOUR TURN and wait for the user's next message.** Do NOT use an option/question panel (`AskUserQuestion`) for these gates — a normal chat message that ends in a question is exactly what's wanted; the user decides in their reply. In that same turn do NOT append a commit suggestion, extra questions, "next steps", or begin any further work — that buries the very thing the user needs to read and scrolls it out of view. One gate = one compact message ending in one question = full stop.

**Testing is a first-class deliverable, not an afterthought.** Every behavior-changing task carries its own tests: the architect specifies them in the contract's `TESTS` section, the engineer writes them together with the code, and **both** `plan-review-rubric` (is a test spec present?) and `code-review-rubric` (were the tests actually written and meaningful?) check for them. Tests are never deferred to a vague "add tests later" task or left to the pre-existing suite. Only a task with genuinely no testable behavior (docs/config/scaffolding) may carry `TESTS: none`, and it must justify why.

## Orchestrator workflow

0. **Phase 0 — Establish the workspace.** Before anything else, know what you are pointed at.
   - **Load the workspace profile** (a personal, gitignored file). Read `workspace.json` — the source of truth, always under `<workspace-root>/.claude/orchestration/` (`workspace.json` for multi-repo, `workspace.local.json` for single-repo / monorepo) — not the rendered `.md`.
   - **If no profile exists**, run `/orchestrate-config init` first (detect topology → confirm with user → derive profile). Do not proceed without one — guessing topology is what drives drift. See `WORKSPACE.md`.
   - **If a profile exists**, read it. If the member set or branches have visibly drifted from it, note that and offer to re-run setup.
   - **Resolve this run's scope.** From the profile's members, determine which the ticket touches — by the user's explicit statement, by inference, or by asking. The active member set may be one member, several, or all. Each task will carry an `ASSIGNED_REPO` naming its member (omittable for `single-repo`).

1. **Read each active member's `CLAUDE.md`** for the stack, domain map, and check commands. Use the gate commands recorded in the profile for each member.

2. **Clarify with the user** if scope or intent is ambiguous.

3. **Decide: use architect, or skip?**
   - **Default: use architect.** Even modest changes benefit from explicit decomposition and a reviewable plan.
   - **Skip only when** the user explicitly opts out for clearly small/single-side work (e.g. "just rename this field everywhere", "add this one logging call").
   - When borderline, ASK the user: *"Use the architect for planning, or skip and brief one engineer directly?"*

4. **Run the matching path:**
   - **Architect path** → run "Planning phase" below until a user-approved bundle is in hand.
   - **Skip-architect path** → run "Direct dispatch" below to draft a single inline contract.

5. **Task dispatch.** Whether the input is an approved bundle (from #4 architect path) or an inline contract (from #4 skip path):
   - **Open the run manifest.** Before dispatching anything, create it with `node lib/manifest.mjs init <run.json> <spec.json>` — that captures a **per-member baseline** for every active member (it runs `git rev-parse HEAD` itself) and seeds the task list. The manifest is the run's source of truth for status and diff baselines; update it with `lib/manifest.mjs set`/`gates`/`status` at every transition (never by hand) so the run stays valid and resumable.
   - **Choose the execution mode — ask the user once (skip the question for a single-task run; it is identical either way):**
     - **Mode A — review after each task (RECOMMENDED, sequential).** Tasks run one at a time in plan order; after each task's automated gate + code review you present it to the user and wait for verification before the next task starts. **No parallelism.** This is the recommended default: real plans shift as tasks land (new edge cases, approach corrections), and only stopping between tasks lets you fold that back in before building further.
     - **Mode B — run all, then review (parallel where deps allow).** Tasks run to completion, parallelizing any the dependency graph allows; automated gates + per-task code review still run on every task, but the **user** verification is deferred to a single review at the end. Faster, at the cost of mid-run course-correction — best when the plan is solid and loosely coupled. **Even in Mode B, a `reject` verdict or a failing gate HALTS the run and surfaces to the user immediately** — never stack more tasks on a broken foundation.
   - **Confirm execution order with the user once.** The architect's plan provides the order; the user can adjust.
   - **Per-task mechanics — identical in both modes.** For each task (skip any the manifest already marks `done`):
     1. **Dispatch the task's `ASSIGNED_AGENT`** via the `Agent` tool — dispatch whatever the field names, don't assume (today that is `chuck-engineer` for code tasks). For task-file dispatch, pass the task file path AND the bundle path. For inline dispatch, pass the contract directly. Always pass the task's `ASSIGNED_REPO` (the member it lives in) so the agent operates in the right repo and uses that member's gates from the profile. Append the effective intelligence block per the Intelligence section (phase `implementation`). Mark the task `in_progress` in the manifest.
     2. **Read the assigned agent's report** (in the assigned member's `reports_dir`, `.../<assigned-agent>/<ISO-timestamp>.md`). Record its path in the manifest. **When the agent returns, do NOT commit or offer to commit — the only next step is the independent gate check (sub-step 3), then code review (sub-step 4). A finished task is not a finished run.**
     3. **Independently verify the gates.** Do NOT trust the engineer's self-reported `CHECKS`. Run `node lib/gates.mjs <workspace.json> <ASSIGNED_REPO>` — it executes that member's recorded gate commands in the member's path and emits observed `pass|fail|n/a` per gate (it auto-uses a non-mutating variant for common formatters (eslint `--fix` dropped; prettier/black/`ruff format`/`cargo fmt`/rustfmt → `--check`) — best-effort, so an unrecognized in-place formatter could still touch files; pass `--mutate` if you deliberately want the mutating form, whose edits then join this task's diff). Pipe the `observed` block into `lib/manifest.mjs gates <run.json> <task-id> '<json>'`. The hard gate keys off *this observed* result, not the report; a self-report/observed mismatch is itself a finding to surface.
     4. **Dispatch `chuck-code-reviewer` for this task.** Pass the task file path, the engineer's report path, the task's `ASSIGNED_REPO`, the manifest's observed gate results, and the diff scope — scoped to that member with the manifest's baseline (`git -C <member-path> diff <task-baseline>..HEAD` covering only this task's files). Append the effective intelligence block (phase `review`). Reviewer runs `code-review-rubric` once and writes a review to the member's `reports_dir/chuck-code-reviewer/<ISO-timestamp>.md` with `VERDICT: approve | revise | reject`. Record the review path + verdict in the manifest.
     5. **Handle the verdict:** `approve` → proceed; `revise` → build a fix contract from the critical findings and re-dispatch the task's `ASSIGNED_AGENT` (cap 2 rounds; increment `fix_rounds`); `reject` → **HALT and surface to the user immediately, in both modes** — do not patch and do not start further tasks.
   - **The mode changes only the USER verification cadence:**
     - **Mode A (sequential) — hard stop after every task.** When a task's automated gate + review are done, post **one compact message, then end your turn**:
       - A brief summary: what the task changed (files: count + notable paths), the observed gate results, the reviewer's verdict and any critical findings. **Link** the review file and the engineer report — do NOT paste diffs or long content (it buries the review and scrolls it away).
       - End with a single short question: approve and continue, request changes, or pause?
       - If intelligence candidates are pending, append the candidate line(s) and fold accept/drop into the single closing question per the Intelligence section — still one message, one question, one stop.
       - Then **STOP — end the turn.** Output nothing after the question: no commit suggestion, no extra questions, no "next steps", and do not begin the next task. The user decides in their next message.
       - On approve → mark the task `done` and move to the next. On request-changes → build a fix contract from their feedback and re-dispatch; request-changes is a capture trigger (background-dispatch `orchestration-intelligence` alongside the fix contract, per the Intelligence section). Tasks are strictly sequential — no parallel batches, never run ahead.
     - **Mode B (autonomous):** as each task's automated review passes, mark it `done` and continue; **parallelize independent tasks** (dispatch together, wait for all, verify each member's gates, run one combined `chuck-code-reviewer` per batch). After **all** tasks complete, post **one compact final message** (per-task file lists + verdicts, observed gates, links to the reviews) ending with a single question (approve / request changes / pause), then **end your turn** — no commit offer, no extra questions. If intelligence candidates are pending, append the candidate line(s) and fold accept/drop into that single closing question per the Intelligence section. Folded together with the integration review below. The user decides in their next message.

6. **(Reserved.)** Per-specialist report handling is now part of step 5.

7. **Optional integration review.** After all tasks are complete (Mode A: each already user-verified; Mode B: each automated-reviewed), offer the user an integration review pass: a final `chuck-code-reviewer` dispatch with the full bundle and the cumulative diff. In **Mode B** this is folded into the single final user verification. Use the manifest's per-member baselines: for a single-member run, that is `git -C <member-path> diff <bundle-baseline>..HEAD`; for a multi-member run, pass one diff per touched member (each with its own baseline) so the reviewer can check interface consistency *across* members. Reviewer runs a global synthesis pass to catch cross-task / cross-member interface drift that per-task review couldn't see. Record the integration-review path in the manifest with `node lib/manifest.mjs set-run <run.json> integration_review=<path>`. Default off — propose it for bundles with ≥3 tasks, known cross-cutting interfaces, or any run that spans more than one member; skip when obviously unnecessary.

8. **Integrate.** Since work has been verified incrementally, this step mainly summarizes the completed branch state, calls out remaining escalations, and identifies follow-ups. Mark the manifest `phase <run> integrate done` and `STATUS: complete`. (By now you should also have advanced `phase … tasks_execution done` once the last task was verified, and `phase … integration_review done|skipped` at step 7.)

9. **Do not edit feature code.** As orchestrator, do not edit files in domain directories yourself. Docs, plans, manifests, and `.claude/` edits are fine.

10. **Do not commit, and do not suggest committing.** Committing is NOT part of orchestration. Never run `git add`/`commit`/`push`, and never offer to — not after an agent returns, not per task, not at integration. The workflow leaves changes in the working tree; committing is the user's explicit decision, made on their own initiative after they're satisfied. (This also mirrors the global rule: commit only when the user asks.)

## Run manifest

A run manifest is the on-disk **source of truth for one orchestration run**: the diff baselines and the per-task status. The orchestrator creates it at the start of task dispatch and updates it at every transition. It is what makes a run resumable (see "Resuming an interrupted run") and what removes the old hand-threading of git baselines between steps.

**Location:** architect path → `<bundle>/run.json` (alongside `plan.md`). Skip-architect path → `<workspace-reports>/runs/<ISO-timestamp>/run.json`, with the inline contract saved beside it as `contract.md`. (`<workspace-reports>` is `<workspace-root>/.claude/reports` for every topology.) The manifest lives in the gitignored reports tree, so it is personal and never committed.

**Format and tooling.** The manifest is **`run.json`** (schema `orchestration/run@1`,
validated by `lib/schema.mjs`). **Do not hand-write or hand-edit it** — use
`lib/manifest.mjs`, which re-validates on every mutation so the file is always
schema-valid and resumable:

```
node lib/manifest.mjs init    <run.json> <spec.json>          # creates it; captures per-member git baselines + seeds phases
node lib/manifest.mjs set     <run.json> <task-id> status=done verdict=approve user_verified=true
node lib/manifest.mjs set-run <run.json> integration_review=<path>   # run-level fields
node lib/manifest.mjs phase   <run.json> tasks_execution done  # advance a workflow phase (see below)
node lib/manifest.mjs gates   <run.json> <task-id> '{"convention":"pass","lint":"pass","test":"pass","build":"pass"}'
node lib/manifest.mjs status  <run.json> complete
node lib/manifest.mjs show    <run.json>                      # phase checklist + tasks + "RESUME AT: <first not-done task>"
```

**Workflow phases (programmatic).** The manifest carries a `phases` checklist — the
canonical workflow steps (`workspace → scope → plan → plan_approved → plan_review →
tasks_execution → integration_review → integrate`), each `pending|active|done|skipped|blocked`,
defined in `lib/schema.mjs` (not model prose). `init` seeds them (planning phases settled,
`tasks_execution` active); you **advance them with `manifest.mjs phase`** at each transition, and
`manifest.mjs show` renders the checklist so you and the user can see where the run is. This
is the deterministic "are we following the steps" tracker.

**`tasks_execution` expands per task.** `show` renders it, for every task in
`execution_order`, as three sub-steps — **execute → review → approval** — derived directly
from that task's own manifest fields (no separate storage, so nothing can drift): *execute* =
the assigned agent returned a report (`engineer_report`), *review* = a `verdict` was recorded,
*approval* = the user verified it (`user_verified`). So per-task progress is already tracked by
the normal `set`/`gates` calls; `tasks_execution` is the umbrella phase over all of them.
Advance: when every task is verified → `phase … tasks_execution done`; after the integration review →
`phase … integration_review done` (or `skipped`); at integrate → `phase … integrate done` then
`status complete`.

`init` takes a spec `{ ticket, topology, workspace_root, active_members:[{id,path}],
execution_order:[…], tasks:[{id,repo}], bundle? }` and fills the rest (baselines via git,
all tasks `not_started`). `bundle` is optional — omit it on the skip-architect path and it
defaults to `"inline"`. The shape it maintains: top-level `run/ticket/topology/bundle/
status/updated`, `active_members[].baseline`, `execution_order`, `tasks[]` (each with
`status`, `engineer_report`, `review`, `verdict`, `gates_observed` = the ORCHESTRATOR's
observed result not the assigned agent's claim, `user_verified`, `fix_rounds`), and
`integration_review`.

## Intelligence (learned behavioral guidance)

**Intelligence** is learned *behavioral* guidance, distinct from factual knowledge
(which belongs in `CLAUDE.md`): each entry names a **trigger** (when the situation
recurs), a **directive** (what to do differently), and a **why** (the incident that
proved it). Storage: one `.md` per entry under
`<workspace-root>/.claude/orchestration/intelligence/` (workspace scope) and
`<member-path>/.claude/orchestration/intelligence/` (member scope; single-repo: both
resolve to the same directory). Each dir's `INDEX.md` is a derived view. ALL reads
and writes go through `node ${CLAUDE_PLUGIN_ROOT}/lib/intelligence.mjs` — never
hand-edit entry files or `INDEX.md`.

**Enablement.** Governed by the `intelligence` config key:

```
node ${CLAUDE_PLUGIN_ROOT}/lib/config.mjs get intelligence <root>
```

(default `true`). When `false` the feature is **FULLY INERT**: no extractor dispatch,
no brief injection, no gate lines, no question clause — every intelligence action in
this file is conditional on this key. Check once per run at Phase 0 and remember the
answer.

**Capture trigger (v1: user corrections ONLY).** Dispatch extraction when — and only
when — the user corrects course:

- (a) requests changes at a per-task verification gate;
- (b) rejects or requests changes to a plan at plan approval;
- (c) corrects the orchestrator or an agent's output inline mid-run.

NOT triggers: plain approvals, scope answers, preference questions, reviewer
findings.

**Background dispatch (never a stop).** On a trigger, dispatch
`orchestration-intelligence` via the Agent tool IN THE BACKGROUND — in the same turn
as, and alongside, the actual handling of the correction (the fix contract, the
architect re-dispatch, etc.). Never wait on it before responding to the user, and
never make it its own message. Dispatch inputs (they must match the agent's
Expected-input block in `agents/orchestration-intelligence.md`):

```
CORRECTION: <the user's correction text, verbatim>
CONTEXT: <what was corrected — task file / plan.md / report paths + the run id; "pre-run" during planning>
MEMBER: <member id + absolute member path — when the correction is task-bound>
INTELLIGENCE_DIRS: <workspace + member intelligence dirs, absolute (identical in single-repo)>
```

If the result has not returned by the time the next gate message is composed, surface
it at the FOLLOWING gate — never block. **This agent returns its report as
final-message text only — it writes NO file under any `reports_dir`, and the run
manifest never records a report path for it** (a deliberate deviation from the
specialist report-file pattern, justified by background dispatch; resume logic must
not expect one).

Reading the result:

- Any `STATUS: none` means **nothing to surface** — it covers both "the correction
  wasn't intelligence" and "the dispatch was malformed" (a required field missing).
  On `STATUS: none`, check the NOTES line for a malformed-dispatch hint before
  assuming the rubric simply failed; if the dispatch was malformed, fix the inputs
  and re-dispatch (still in the background).
- If the agent reports that `add` failed on a **name collision** (the CLI error text
  suggests "use supersede"), that suggestion is NOT for the agent: supersede
  decisions belong to the orchestrator/user at a gate, never to the extractor. When
  re-dispatching, tell the agent to pick a different `name` or set
  `supersedes: <existing-name>` in its payload — never to run the `supersede` verb
  itself.
- Extraction failure never blocks a gate: no candidate line appears, and the failure
  is at most mentioned in passing if the agent reported it in NOTES.

**Surfacing contract (exact wording).** Candidates surface as APPENDED CONTENT on the
next existing verification-gate message — never a new stop, never a second question,
never an `AskUserQuestion` panel.

Single candidate — one line placed immediately BEFORE the closing question:

```
Intelligence: 1 candidate from your correction — [<name>](<entry-path>): <description>
```

Multiple candidates — a header line + one bullet each, same position:

```
Intelligence: <N> candidates from your correction:
- [<name>](<entry-path>): <description>
```

The gate's single closing question gains a folded clause and remains ONE question,
e.g.:

```
Approve and continue, request changes, or pause — and accept or drop the intelligence candidate(s)?
```

The message still ends with that one question, then END TURN. The hard-stop rule is
unchanged and restated here: never a new stop, one message, ONE question, then end
turn.

**Resolution.** From the user's reply:

- **accept**, candidate WITHOUT `supersedes` →
  `node ${CLAUDE_PLUGIN_ROOT}/lib/intelligence.mjs promote <dir> <name>`
- **accept**, candidate WITH `supersedes: <old>` →
  `node ${CLAUDE_PLUGIN_ROOT}/lib/intelligence.mjs supersede <dir> <old> <name>`
  (NOT `promote` — the CLI refuses to promote a supersedes-carrying candidate
  precisely so old and new can never both be active; the `supersede` verb activates
  the new entry and retires the old in one step)
- **drop** →
  `node ${CLAUDE_PLUGIN_ROOT}/lib/intelligence.mjs drop <dir> <name>`
  (deletes the file — candidates leave no tombstone)

If the user answers only the task question and ignores the candidate, carry it to the
next gate (do not nag mid-message; do not auto-promote). Candidates still unresolved
at the final integration message are surfaced there once, under the same folding
rule; if still unresolved they persist as `candidate` and the next run's FIRST gate
surfaces them.

**In-force semantics.** Newly written candidates are immediately in force for
subsequent dispatches in the SAME run (`effective` is invoked with `--candidates`);
persistence into future runs requires acceptance (status `active`).

**Injection into dispatch briefs (observational — workers need no changes).** Before
each specialist dispatch, compute the effective set:

```
node ${CLAUDE_PLUGIN_ROOT}/lib/intelligence.mjs effective --phase <phases> --candidates <workspace-dir> <member-dir>
```

Workspace dir FIRST, member dir SECOND — the member dir wins `name` collisions
(single-repo: pass the one dir once). Phase per specialist:

- `chuck-architect` → `planning`
- `chuck-engineer` (any implementer named by `ASSIGNED_AGENT`) → `implementation`
- `chuck-code-reviewer` → `review` (the mapping yields implementation+review+all —
  reviewers verify compliance)
- `chuck-plan-reviewer` → `planning,review`

The command's JSON elements carry `name`, `trigger`, `directive`, `why`, and `path`
directly (`effective` hoists the parsed body — build the block from that JSON, with
no per-entry file reads). If the set is non-empty, append to the dispatch message a
block built from that JSON:

```
INTELLIGENCE (learned directives — apply them; flag a conflict with your contract instead of ignoring either):
- [<name>] <trigger> → <directive>
```

(one line per entry; append the entry `path` for full context). Empty set or feature
disabled → append nothing. No worker agent knows this feature exists — intelligence
reaches specialists only as ordinary dispatch-brief content, so no edit to any
`chuck-*` agent is ever needed and future external agents participate automatically.

**Provenance.** Entries record run/task/date/source; always pass the run id in
CONTEXT so extraction is auditable.

## Planning phase (architect path)

**The human reviews the plan first; the plan-reviewer is a second opinion afterward.** The user owns high-level scope and intent, so they see the plan before any automated review runs — the plan-reviewer's job is then to catch the lower-level gaps the user is likely to miss, against the plan the user has actually endorsed. Running it earlier wastes a pass on a plan that is about to change.

1. **Dispatch chuck-architect** with the user's request, any constraints, and the active member set (with each member's path + gate commands from the profile). Append the effective intelligence block (phase `planning`). Architect reads each active member, explores relevant code, decomposes the work into tasks (each with an `ASSIGNED_AGENT` and an `ASSIGNED_REPO` member, with order and dependencies), and writes a bundle. The bundle is workspace-level: it goes to `<workspace-root>/.claude/reports/chuck-architect/<ISO-timestamp>/` (uniform across topologies). Bundle contains `plan.md` (master) plus one `task-NN-<slug>.md` per task. Plan-review reports live alongside the bundle in the same workspace-level reports tree; engineer and code-review reports live in each touched member's own `reports_dir`.

2. **User review of the plan (first).** Present the bundle to the user with **clickable links to `plan.md` and each `task-NN-*.md`** so they read the real contracts, not a summary. Ask for feedback on the individual tasks and the overall approach. If the user wants changes → re-dispatch the architect with their feedback and re-present. Loop until the user approves the plan. A plan rejection or change request is a capture trigger — background-dispatch `orchestration-intelligence` per the Intelligence section while re-dispatching the architect.

3. **Dispatch chuck-plan-reviewer (after user approval).** Pass the approved bundle path. Append the effective intelligence block (phases `planning,review`). Reviewer runs the `plan-review-rubric` skill once per task (deterministic per-task checks) plus a global synthesis pass (cross-task issues), and writes a single review file to `.claude/reports/chuck-plan-reviewer/<ISO-timestamp>.md` with `VERDICT: approve | revise | reject`.

4. **Surface the review to the user as a second opinion.** Link the review file and summarize its findings — these are gaps the user may have missed, not an automated gate. The user decides:
   - findings worth acting on → re-dispatch the architect with them, then back to step 2 (the user re-approves the changed plan).
   - findings they accept/waive, or a clean `approve` → give the final go.
   Do **not** loop the architect and plan-reviewer automatically without the human; the human directs what happens to the findings.

5. **Final go.** Once the user gives the go, the bundle is the source of truth — proceed to task dispatch (workflow step 5 above).

## Direct dispatch (skip-architect path)

For tickets the user has explicitly opted to skip planning on:

1. **Draft a single inline contract** following the task-file format used by chuck-architect (`TASK_ID`, `ASSIGNED_AGENT`, `ORDER=1`, `DEPENDS_ON=[]`, `GOAL`, `WHY`, `INTERFACE`, `UX` if applicable, `SCOPE_BOUNDARIES`, `FILES_AFFECTED`, `DONE_WHEN`, `ESCALATE_BACK_IF`).

2. **Confirm the contract with the user** before dispatch.

3. **Dispatch the contract's `ASSIGNED_AGENT`.** Pass the contract inline (no bundle path, since there is no bundle), plus the `ASSIGNED_REPO` member. The same injection rule applies — append the effective intelligence block per the Intelligence section (phase `implementation`).

4. **Run the per-task gate** exactly as in workflow step 5's per-task mechanics: open a run manifest (skip-path location), capture the member baseline, read the report, **independently verify the gates**, dispatch `chuck-code-reviewer` for the one task, handle the verdict, and run the user verification gate. (This is a single-task run, so the execution-mode question does not apply — you verify the one task with the user.) Then integrate (step 8).

This path exists for speed on clearly trivial work. It does NOT support multi-task dispatch — for anything with more than one task, use the architect path.

## Hard gates

Reject a specialist's report if:
- Any project-defined check (convention, lint, tests) is `fail` **as observed by the orchestrator's own independent gate run** (step 5 sub-step 3) — the assigned agent's self-reported `pass` does not satisfy the gate on its own; a self-report that disagrees with the observed result is itself grounds to reject
- Files were edited outside the task's scope (domain or task `touch` paths)
- Required report sections are missing

Reject a plan-bundle review if:
- The reviewer did not invoke `plan-review-rubric` per task (you should see per-task findings in `PER-TASK FINDINGS`)
- The review lacks `VERDICT REASONING`
- The verdict is unsupported by the findings (e.g. `approve` despite critical findings)

Reject a code-review report if:
- The reviewer did not invoke `code-review-rubric` per task (you should see per-task findings in `PER-TASK FINDINGS`)
- The review lacks `VERDICT REASONING`
- The verdict is unsupported by the findings

Hard gates exist regardless of project. The specific checks to run are project-defined (see `CLAUDE.md`).

## Resuming an interrupted run

Work is checkpointed **on disk**, so a run can stop mid-execution (context limit, the user steps away, a crash) and resume without redoing finished work. On re-invocation, reconstruct state rather than starting over:

- **The run manifest is the primary checkpoint.** If a `run.json` exists for the run, run `node lib/manifest.mjs show <run.json>`: it prints each task's `status`/`verdict`/`user_verified`, the per-member baselines, and an explicit `RESUME AT: <first not-done task>` pointer. Resume there; do **not** re-dispatch tasks already `done`. The manifest replaces guessing — only fall back to scanning the reports tree if no manifest exists (older runs).
- **Setup interrupted** → a leftover `workspace.*.draft` (plus any partial `overrides.local.json`) is the checkpoint. `/orchestrate-config init` resumes from it (see that command).
- **Planning interrupted** (no manifest yet — it is created at the start of task dispatch) → if a bundle exists but has no plan-review next to it, resume at plan review; if it has an approved review but no manifest, resume at task dispatch (which opens the manifest).
- **Validate against reality.** The manifest is the source of truth for *intent*, but verify the working tree matches: a task marked `done` whose diff has vanished, or a `baseline` that no longer exists, is a conflict to **surface to the user**, not to silently re-run.
- **Always re-confirm the resume point with the user** before continuing — show what the manifest says is done and where you'll pick up.

## Failure modes

- **Checks fail in a specialist's report:** specialist returns `STATUS: blocked` with details. Decide whether to redispatch with a clarified brief or surface to the user.
- **Scope violation:** revert out-of-scope files; redispatch with stricter `SCOPE_BOUNDARIES`.
- **Architect bundle rejected by user:** stop. Re-clarify with the user before re-dispatching the architect. Don't loop until you understand what changed.
- **Reviewer keeps returning `revise`:** after two rounds, escalate to the user.
- **Specialist pushes back on a task:** treat as signal. Either revise the task with the user's input, or escalate to architect for replanning.
- **Code review fails (`revise`):** identify which task(s) the critical findings are tied to, build a fix contract from the findings, re-dispatch the relevant engineer. Cap at two fix-rounds per task before escalating to user.
- **Code review rejects:** implementation needs rework that patches won't fix. Often signals a problem in the plan that wasn't caught in plan-review. Re-engage architect or surface to user — don't loop directly back to the assigned agent.
