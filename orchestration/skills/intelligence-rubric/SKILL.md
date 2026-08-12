---
name: intelligence-rubric
description: Deterministic checklist for evaluating ONE candidate insight distilled from a user correction during an orchestration run — decides whether it is genuine intelligence (behavior-changing, recurring, not derivable) and, if so, its scope and type. Invoked by orchestration-intelligence once per candidate. Failing any identification check means it is NOT intelligence (drop, or leave as a run note).
---

# Intelligence Rubric

This skill provides a deterministic walkthrough for evaluating **one candidate insight** distilled from a user correction. Walk every step in order. Do not skip. The three identification checks (steps 1-3) are **conjunctive**: FAIL ANY → not intelligence. Produce the output block at the end.

## Inputs

- The user's correction text (verbatim)
- The task contract / plan context the correction happened against (paths)
- The member's `CLAUDE.md` path + the existing intelligence dirs (workspace + member)
- The distilled draft: trigger / directive / why

## Steps

The three identification checks are conjunctive — **FAIL ANY → not intelligence**. Walk all of them regardless, so the output block is complete.

### 1. Behavior-changing

Would knowing this BEFORE the correction have altered a concrete artifact — a plan decision, a code edit, a review verdict? Name the artifact and what would have differed. Cannot name one → **FAIL**. (A preference with no behavioral consequence — e.g. tone/wording taste with no artifact impact — fails here.)

### 2. Recurring

Will the trigger plausibly fire again in future runs, or was this one-off circumstance (a specific bug, a since-deleted file, a one-time migration)? The trigger must describe a **SITUATION CLASS**, not an incident. One-off → **FAIL**.

### 3. Not derivable

Is the directive already obtainable from what agents ALREADY read? Check, with actual Read/Grep, against:

- The member's `CLAUDE.md` (and docs it points to)
- The workspace and member intelligence dirs: `node ${CLAUDE_PLUGIN_ROOT}/lib/intelligence.mjs list <dir>` — any status counts; a `candidate` duplicate counts
- Obvious code conventions visible at the correction site

Already present or trivially inferable → **FAIL**. If an existing ACTIVE entry covers it PARTIALLY but this correction refines it → do not fail; note `supersedes: <name>` for the output instead.

(The `list` verb surface is defined by the plugin's `lib/intelligence.mjs`; this skill quotes it per the plan bundle that introduced both — if the CLI changes, update this line with it.)

### 4. Scope decision (only if 1-3 pass)

Default **member**. Choose **workspace** ONLY when the directive is about the orchestration process itself or provably holds for every member — cite why (e.g. it concerns gate handling, report style, cross-member interfaces — not one repo's stack). When in doubt: member. (Single-repo workspaces: the dir is the same either way; still record the honest scope.)

### 5. Type decision

- `planning` — changes how work is decomposed, contracted, estimated, or sequenced (consumed by the architect + plan review).
- `implementation` — changes how code is written: patterns, APIs to prefer/avoid, testing habits (consumed by engineers + reviewers).
- `review` — changes what reviewers check or how verdicts are weighed.
- `all` — genuinely phase-independent (rare; e.g. "this workspace's X is authoritative over Y"). If you hesitate between one phase and `all`, pick the one phase.

### 6. Distillation quality bar

- **trigger**: ONE line, a recognizable situation ("When adding a knowledge slot to schema.mjs…"), no incident details.
- **directive**: imperative, self-contained, actionable without reading `why`.
- **why**: 1-3 sentences citing the actual incident (run/task/date) — the evidence, not extra instructions.

Fix the draft to meet the bar; if it cannot be stated in this shape, that is itself a **FAIL** (not distillable → not intelligence).

## Output

Return, per insight, exactly this block (the caller consumes it verbatim):

```
INSIGHT: <one-line summary of the raw correction>
CHECKS:
  behavior_changing: pass | fail (<artifact that would have differed, or why none>)
  recurring: pass | fail (<situation class, or why one-off>)
  not_derivable: pass | fail (<where it was checked: claude_md / intelligence / code>)
VERDICT: intelligence | not-intelligence
# only when VERDICT: intelligence —
SCOPE: member | workspace (<one-line justification if workspace>)
TYPE: planning | implementation | review | all
SUPERSEDES: <name | none>
ENTRY:
  name: <kebab-slug>
  description: <the trigger, one line>
  trigger: <...>
  directive: <...>
  why: <...>
```

Do NOT write any file from this skill — the caller (`orchestration-intelligence`) is the only writer, and it writes exclusively via `lib/intelligence.mjs add`. A `not-intelligence` verdict produces no entry anywhere; at most a one-line note in the caller's report.
