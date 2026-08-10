// Zero-dependency validators for the orchestration data shapes.
//
// These are the single source of truth for what a workspace profile and a run
// manifest must contain. detect.mjs / profile.mjs / manifest.mjs all validate
// through here, so a malformed or hand-edited file fails LOUDLY against a known
// shape instead of being silently misread by an LLM downstream.
//
// Each validator returns { valid: boolean, errors: string[] } — errors are
// path-qualified (e.g. "members[2].gates.test: expected string|null").

export const WORKSPACE_SCHEMA = "orchestration/workspace@3";
export const RUN_SCHEMA = "orchestration/run@1";
export const CONFIG_SCHEMA = "orchestration/config@1";
export const OVERRIDES_SCHEMA = "orchestration/overrides@1";

export const TOPOLOGIES = ["single-repo", "monorepo", "multi-repo"];
// There is deliberately no per-member "role". Every workspace has ALL specialists
// available (architect, both engineers, both reviewers); the architect chooses each
// task's engineer from the task's nature + the member's stack. Members record facts
// only — never an owning agent — so nothing is ever excluded by classification.
export const GATE_KEYS = ["convention", "lint", "test", "build"];
// Fixed per-member knowledge-link slots. Each is a resolved path or null
// (null = no link OR the file is absent — consumers treat both the same).
// Anything outside these slots lives in the free-form `extra` object.
export const KNOWLEDGE_SLOTS = ["claude_md", "skills", "rubrics"];
// Plugin settings. Setting 1 (plugin on/off everywhere) is delegated to Claude
// Code's built-in `enabledPlugins` and deliberately not modelled here.
//   readiness_check          — the onboarding nudge when a workspace is UNconfigured
//   proactive_orchestration  — when a workspace IS configured, prime the main session
//                              to route code work through /orchestrate (off = only on demand)
// Both are booleans, default ON.
export const CONFIG_KEYS = ["readiness_check", "proactive_orchestration"];
export const CONFIG_DEFAULTS = { schema: CONFIG_SCHEMA, readiness_check: true, proactive_orchestration: true };
export const RUN_STATUSES = ["planning", "executing", "complete", "blocked"];
// Canonical workflow phases, in order. The run manifest records one {id,status} per
// phase so progress through the workflow is tracked programmatically (in code + JSON),
// not as model prose. Finer-grained than RUN_STATUSES; the orchestrator advances them
// with `manifest.mjs phase`.
export const RUN_PHASES = [
  { id: "workspace", label: "Workspace established (profile + active members)" },
  { id: "scope", label: "Scope clarified with user" },
  { id: "plan", label: "Plan bundle produced (architect)" },
  { id: "plan_approved", label: "Plan approved by user" },
  { id: "plan_review", label: "Plan-review (advisory) surfaced" },
  { id: "tasks_execution", label: "Tasks execution — per task: execute → review → approval" },
  { id: "integration_review", label: "Integration review" },
  { id: "integrate", label: "Integrated & summarized" },
];
export const PHASE_IDS = RUN_PHASES.map((p) => p.id);
export const PHASE_STATUSES = ["pending", "active", "done", "skipped", "blocked"];
export const TASK_STATUSES = [
  "not_started", "in_progress", "gates_verified",
  "awaiting_review", "awaiting_verification", "done", "blocked",
];
export const VERDICTS = ["approve", "revise", "reject", null];
export const GATE_RESULTS = ["pass", "fail", "n/a", null];

// --- tiny check helpers -----------------------------------------------------

function isString(v) { return typeof v === "string"; }
function isBool(v) { return typeof v === "boolean"; }
function isInt(v) { return Number.isInteger(v); }
function isStringOrNull(v) { return v === null || typeof v === "string"; }

function checkEnum(errs, path, v, allowed) {
  if (!allowed.includes(v)) {
    const show = allowed.map((a) => (a === null ? "null" : `"${a}"`)).join(" | ");
    errs.push(`${path}: expected one of ${show}, got ${JSON.stringify(v)}`);
  }
}
function checkType(errs, path, v, pred, label) {
  if (!pred(v)) errs.push(`${path}: expected ${label}, got ${JSON.stringify(v)}`);
}
function checkArray(errs, path, v) {
  if (!Array.isArray(v)) { errs.push(`${path}: expected array`); return false; }
  return true;
}

// --- workspace --------------------------------------------------------------

export function validateWorkspace(obj) {
  const errs = [];
  if (obj == null || typeof obj !== "object") {
    return { valid: false, errors: ["root: expected an object"] };
  }
  if (obj.schema !== WORKSPACE_SCHEMA) {
    errs.push(`schema: expected "${WORKSPACE_SCHEMA}", got ${JSON.stringify(obj.schema)}`);
  }
  checkType(errs, "generated", obj.generated, isString, "ISO string");
  // Optional: the plugin version that produced this profile (stamped by detect.mjs).
  // Optional so profiles written before version tracking stay valid; new/re-derived
  // profiles always carry it. See lib/version.mjs.
  if (obj.plugin_version !== undefined) {
    checkType(errs, "plugin_version", obj.plugin_version, isStringOrNull, "string|null");
  }
  checkEnum(errs, "topology", obj.topology, TOPOLOGIES);
  checkType(errs, "workspace_root", obj.workspace_root, isString, "absolute path string");

  if (checkArray(errs, "members", obj.members)) {
    if (obj.members.length === 0) errs.push("members: must have at least one member");
    obj.members.forEach((m, i) => validateMember(errs, `members[${i}]`, m));
    const ids = obj.members.map((m) => m && m.id);
    const dupes = ids.filter((id, i) => id && ids.indexOf(id) !== i);
    if (dupes.length) errs.push(`members: duplicate id(s) ${[...new Set(dupes)].join(", ")}`);
  }

  // decisions_needed is optional (empty/absent once finalized)
  if (obj.decisions_needed !== undefined && checkArray(errs, "decisions_needed", obj.decisions_needed)) {
    obj.decisions_needed.forEach((d, i) => {
      const p = `decisions_needed[${i}]`;
      checkType(errs, `${p}.member`, d && d.member, isString, "member id string");
      checkType(errs, `${p}.question`, d && d.question, isString, "string");
      checkType(errs, `${p}.recommended`, d && d.recommended, isString, "string");
    });
  }

  if (obj.defaults == null || typeof obj.defaults !== "object") {
    errs.push("defaults: expected an object");
  } else {
    checkType(errs, "defaults.architect", obj.defaults.architect, isString, "string");
    checkType(errs, "defaults.parallelism", obj.defaults.parallelism, isString, "string");
    checkType(errs, "defaults.human_gate", obj.defaults.human_gate, isString, "string");
  }

  return { valid: errs.length === 0, errors: errs };
}

function validateMember(errs, p, m) {
  if (m == null || typeof m !== "object") { errs.push(`${p}: expected an object`); return; }
  checkType(errs, `${p}.id`, m.id, isString, "string");
  checkType(errs, `${p}.path`, m.path, isString, "string");
  checkType(errs, `${p}.git`, m.git, isBool, "boolean");
  checkType(errs, `${p}.default_branch`, m.default_branch, isStringOrNull, "string|null");
  checkType(errs, `${p}.stack`, m.stack, isString, "string");
  checkEnum(errs, `${p}.claude_md`, m.claude_md, ["present", "absent"]);
  checkType(errs, `${p}.reports_dir`, m.reports_dir, isString, "string");
  if (m.gates == null || typeof m.gates !== "object") {
    errs.push(`${p}.gates: expected an object`);
  } else {
    for (const k of GATE_KEYS) {
      checkType(errs, `${p}.gates.${k}`, m.gates[k], isStringOrNull, "string|null (null = no gate)");
    }
  }
  if (m.notes !== undefined && checkArray(errs, `${p}.notes`, m.notes)) {
    m.notes.forEach((n, i) => checkType(errs, `${p}.notes[${i}]`, n, isString, "string"));
  }
  validateKnowledge(errs, `${p}.knowledge`, m.knowledge);
}

// knowledge: the fixed slots (string|null) plus a free-form `extra` object.
function validateKnowledge(errs, p, k) {
  if (k == null || typeof k !== "object" || Array.isArray(k)) {
    errs.push(`${p}: expected an object`);
    return;
  }
  for (const slot of KNOWLEDGE_SLOTS) {
    checkType(errs, `${p}.${slot}`, k[slot], isStringOrNull, "string|null (null = missing link/file)");
  }
  if (k.extra == null || typeof k.extra !== "object" || Array.isArray(k.extra)) {
    errs.push(`${p}.extra: expected an object (free-form user links)`);
  }
  // Any key that is neither a known slot nor `extra` is a typo — fail loudly.
  for (const key of Object.keys(k)) {
    if (key !== "extra" && !KNOWLEDGE_SLOTS.includes(key)) {
      errs.push(`${p}: unknown knowledge key "${key}" (put custom links under extra)`);
    }
  }
}

// --- config -----------------------------------------------------------------

// Validate a plugin config object. On-disk files may be `partial` (a workspace
// override that sets only some keys); the merged effective config is validated
// in full. Unknown keys fail loudly so a typo can't silently disable a setting.
export function validateConfig(obj, { partial = false } = {}) {
  const errs = [];
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    return { valid: false, errors: ["root: expected an object"] };
  }
  if (obj.schema !== CONFIG_SCHEMA) {
    errs.push(`schema: expected "${CONFIG_SCHEMA}", got ${JSON.stringify(obj.schema)}`);
  }
  for (const k of Object.keys(obj)) {
    if (k !== "schema" && !CONFIG_KEYS.includes(k)) errs.push(`unknown config key "${k}"`);
  }
  // All config keys are booleans. In a full config every key is required; in a
  // partial (an on-disk override layer) only present keys are checked.
  for (const k of CONFIG_KEYS) {
    if (!partial || obj[k] !== undefined) checkType(errs, k, obj[k], isBool, "boolean");
  }
  return { valid: errs.length === 0, errors: errs };
}

// --- overrides --------------------------------------------------------------

// The durable, human-authored layer. The profile is derived = detected ⊕ this.
// Every field is optional (a sparse override), but present fields are strict:
// fixed slots / gate keys are allowlisted so a typo fails loudly. Only
// `knowledge.extra` is free-form (arbitrary link names → string paths).
// `stack` is a strict scalar: a plain string label replacing the detected
// stack (never null — the member field is required-string; removal is `unset`).
const OVERRIDE_MEMBER_KEYS = new Set(["stack", "gates", "knowledge", "notes"]);

export function validateOverrides(obj) {
  const errs = [];
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    return { valid: false, errors: ["root: expected an object"] };
  }
  if (obj.schema !== OVERRIDES_SCHEMA) {
    errs.push(`schema: expected "${OVERRIDES_SCHEMA}", got ${JSON.stringify(obj.schema)}`);
  }
  if (obj.members == null || typeof obj.members !== "object" || Array.isArray(obj.members)) {
    errs.push("members: expected an object (map of member id → override)");
    return { valid: errs.length === 0, errors: errs };
  }
  for (const [id, mo] of Object.entries(obj.members)) {
    const p = `members.${id}`;
    if (mo == null || typeof mo !== "object" || Array.isArray(mo)) { errs.push(`${p}: expected an object`); continue; }
    for (const k of Object.keys(mo)) {
      if (!OVERRIDE_MEMBER_KEYS.has(k)) errs.push(`${p}: unknown override key "${k}"`);
    }
    if (mo.stack !== undefined) checkType(errs, `${p}.stack`, mo.stack, isString, "string (a stack label)");
    if (mo.gates !== undefined) {
      if (mo.gates == null || typeof mo.gates !== "object" || Array.isArray(mo.gates)) {
        errs.push(`${p}.gates: expected an object`);
      } else {
        for (const [gk, gv] of Object.entries(mo.gates)) {
          if (!GATE_KEYS.includes(gk)) { errs.push(`${p}.gates: unknown gate "${gk}"`); continue; }
          checkType(errs, `${p}.gates.${gk}`, gv, isStringOrNull, "string|null");
        }
      }
    }
    if (mo.knowledge !== undefined) validateKnowledgeOverride(errs, `${p}.knowledge`, mo.knowledge);
    if (mo.notes !== undefined && checkArray(errs, `${p}.notes`, mo.notes)) {
      mo.notes.forEach((n, i) => checkType(errs, `${p}.notes[${i}]`, n, isString, "string"));
    }
  }
  return { valid: errs.length === 0, errors: errs };
}

function validateKnowledgeOverride(errs, p, k) {
  if (k == null || typeof k !== "object" || Array.isArray(k)) { errs.push(`${p}: expected an object`); return; }
  for (const key of Object.keys(k)) {
    if (key === "extra") {
      if (k.extra == null || typeof k.extra !== "object" || Array.isArray(k.extra)) {
        errs.push(`${p}.extra: expected an object`); continue;
      }
      for (const [name, val] of Object.entries(k.extra)) {
        checkType(errs, `${p}.extra.${name}`, val, isString, "string (a link path)");
      }
    } else if (KNOWLEDGE_SLOTS.includes(key)) {
      checkType(errs, `${p}.${key}`, k[key], isStringOrNull, "string|null");
    } else {
      errs.push(`${p}: unknown knowledge key "${key}" (custom links go under extra)`);
    }
  }
}

// --- run manifest -----------------------------------------------------------

export function validateRun(obj) {
  const errs = [];
  if (obj == null || typeof obj !== "object") {
    return { valid: false, errors: ["root: expected an object"] };
  }
  if (obj.schema !== RUN_SCHEMA) {
    errs.push(`schema: expected "${RUN_SCHEMA}", got ${JSON.stringify(obj.schema)}`);
  }
  checkType(errs, "run", obj.run, isString, "ISO string");
  checkType(errs, "ticket", obj.ticket, isString, "string");
  checkEnum(errs, "topology", obj.topology, TOPOLOGIES);
  checkType(errs, "bundle", obj.bundle, isString, 'string ("inline" or a path)');
  checkEnum(errs, "status", obj.status, RUN_STATUSES);
  checkType(errs, "updated", obj.updated, isString, "ISO string");

  if (checkArray(errs, "active_members", obj.active_members)) {
    obj.active_members.forEach((am, i) => {
      const p = `active_members[${i}]`;
      checkType(errs, `${p}.id`, am && am.id, isString, "string");
      checkType(errs, `${p}.path`, am && am.path, isString, "string");
      checkType(errs, `${p}.baseline`, am && am.baseline, isString, "git sha string");
    });
  }
  checkArray(errs, "execution_order", obj.execution_order);

  if (checkArray(errs, "tasks", obj.tasks)) {
    obj.tasks.forEach((t, i) => validateTask(errs, `tasks[${i}]`, t));
  }

  if (!(obj.integration_review === null || isString(obj.integration_review))) {
    errs.push("integration_review: expected string|null");
  }

  // phases is optional (older manifests predate it); when present, each entry must
  // name a known phase and a valid status.
  if (obj.phases !== undefined && checkArray(errs, "phases", obj.phases)) {
    obj.phases.forEach((ph, i) => {
      const p = `phases[${i}]`;
      checkEnum(errs, `${p}.id`, ph && ph.id, PHASE_IDS);
      checkEnum(errs, `${p}.status`, ph && ph.status, PHASE_STATUSES);
    });
  }
  return { valid: errs.length === 0, errors: errs };
}

function validateTask(errs, p, t) {
  if (t == null || typeof t !== "object") { errs.push(`${p}: expected an object`); return; }
  checkType(errs, `${p}.id`, t.id, isString, "string");
  checkType(errs, `${p}.repo`, t.repo, isString, "member id string");
  checkEnum(errs, `${p}.status`, t.status, TASK_STATUSES);
  checkType(errs, `${p}.engineer_report`, t.engineer_report, isStringOrNull, "string|null");
  checkType(errs, `${p}.review`, t.review, isStringOrNull, "string|null");
  checkEnum(errs, `${p}.verdict`, t.verdict, VERDICTS);
  checkType(errs, `${p}.user_verified`, t.user_verified, isBool, "boolean");
  checkType(errs, `${p}.fix_rounds`, t.fix_rounds, isInt, "integer");
  if (t.gates_observed == null || typeof t.gates_observed !== "object") {
    errs.push(`${p}.gates_observed: expected an object`);
  } else {
    for (const k of GATE_KEYS) {
      checkEnum(errs, `${p}.gates_observed.${k}`, t.gates_observed[k], GATE_RESULTS);
    }
  }
}
