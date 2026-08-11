// Tests for the workspace@4 bump, the `intelligence` config key, and the new
// intelligence-entry@1 validator (orchestration/lib/schema.mjs). Pure in-process
// validation — no CLI subprocesses needed here. Zero deps, node:test +
// node:assert/strict, run with `node --test "tests/*.test.mjs"`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WORKSPACE_SCHEMA, KNOWLEDGE_SLOTS, CONFIG_SCHEMA, CONFIG_DEFAULTS,
  INTELLIGENCE_ENTRY_SCHEMA,
  validateWorkspace, validateConfig, validateIntelligenceEntry,
} from "../orchestration/lib/schema.mjs";

// Minimal valid workspace profile built from the imported constants (all four
// knowledge slots present), so future bumps can't silently break this fixture.
function profileFixture() {
  return {
    schema: WORKSPACE_SCHEMA,
    generated: "2026-08-11T00:00:00Z",
    topology: "single-repo",
    workspace_root: "/ws",
    members: [{
      id: "m1",
      path: ".",
      git: true,
      default_branch: "main",
      stack: "Node/JS",
      claude_md: "present",
      reports_dir: ".claude/reports/",
      gates: { convention: null, lint: null, test: null, build: null },
      knowledge: { ...Object.fromEntries(KNOWLEDGE_SLOTS.map((s) => [s, null])), extra: {} },
    }],
    defaults: { architect: "default-on", parallelism: "opt-in", human_gate: "per-task" },
  };
}

// A fully valid intelligence entry, per-test mutated.
function entryFixture() {
  return {
    schema: INTELLIGENCE_ENTRY_SCHEMA,
    name: "prefer-glob-test-form",
    description: "Always run the suite via the glob form on Windows",
    type: "implementation",
    status: "candidate",
    scope: "workspace",
    provenance_run: "2026-08-11T00-00-00",
    provenance_task: "task-01",
    provenance_date: "2026-08-11",
    provenance_source: "user-correction",
    body: {
      trigger: "About to run the node:test suite",
      directive: "Use `node --test \"tests/*.test.mjs\"`, never the bare-dir form",
      why: "The bare-directory form is broken on Windows/node 22",
    },
  };
}

// --- validateWorkspace (workspace@4) -------------------------------------------

test("workspace@4: minimal valid profile with all four knowledge slots passes", () => {
  assert.equal(WORKSPACE_SCHEMA, "orchestration/workspace@4");
  assert.deepEqual(KNOWLEDGE_SLOTS, ["claude_md", "skills", "rubrics", "intelligence"]);
  const { valid, errors } = validateWorkspace(profileFixture());
  assert.equal(valid, true, errors.join("; "));
});

test("workspace@4: an old @3 schema string fails", () => {
  const p = profileFixture();
  // Derived (not a literal) so a stale-schema-string grep over lib+tests stays clean.
  p.schema = WORKSPACE_SCHEMA.replace("@4", "@3");
  assert.equal(p.schema, "orchestration/workspace" + "@3");
  const { valid, errors } = validateWorkspace(p);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.startsWith("schema:")), errors.join("; "));
});

test("workspace@4: knowledge missing the intelligence slot fails with a path-qualified error", () => {
  const p = profileFixture();
  delete p.members[0].knowledge.intelligence;
  const { valid, errors } = validateWorkspace(p);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("members[0].knowledge.intelligence")), errors.join("; "));
});

test("workspace@4: unknown knowledge key still fails loudly", () => {
  const p = profileFixture();
  p.members[0].knowledge.inteligence = "typo";
  const { valid, errors } = validateWorkspace(p);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('unknown knowledge key "inteligence"')), errors.join("; "));
});

// --- validateConfig (intelligence key) -------------------------------------------

test("config: full merged config with intelligence passes", () => {
  const { valid, errors } = validateConfig({
    schema: CONFIG_SCHEMA, readiness_check: true, proactive_orchestration: false, intelligence: true,
  });
  assert.equal(valid, true, errors.join("; "));
});

test("config: partial layer without the intelligence key passes", () => {
  const { valid, errors } = validateConfig(
    { schema: CONFIG_SCHEMA, readiness_check: false },
    { partial: true },
  );
  assert.equal(valid, true, errors.join("; "));
});

test("config: non-boolean intelligence fails", () => {
  const { valid, errors } = validateConfig({
    schema: CONFIG_SCHEMA, readiness_check: true, proactive_orchestration: true, intelligence: "yes",
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.startsWith("intelligence:")), errors.join("; "));
});

test("config: intelligence defaults ON", () => {
  assert.equal(CONFIG_DEFAULTS.intelligence, true);
});

// --- validateIntelligenceEntry ----------------------------------------------------

test("intelligence-entry: fully valid entry passes", () => {
  const { valid, errors } = validateIntelligenceEntry(entryFixture());
  assert.equal(valid, true, errors.join("; "));
});

test("intelligence-entry: each invalid field fails with a path-qualified error", () => {
  const cases = [
    ["name", (e) => { e.name = "Bad_Name"; }, /name/],
    ["name >64", (e) => { e.name = "a".repeat(65); }, /name/],
    ["multi-line description", (e) => { e.description = "line one\nline two"; }, /description/],
    ["type", (e) => { e.type = "deploy"; }, /type/],
    ["status", (e) => { e.status = "rejected"; }, /status/],
    ["scope", (e) => { e.scope = "global"; }, /scope/],
    ["provenance_source", (e) => { e.provenance_source = "reviewer-finding"; }, /provenance_source/],
    ["missing body.why", (e) => { delete e.body.why; }, /body\.why/],
    ["empty body.trigger", (e) => { e.body.trigger = ""; }, /body\.trigger/],
    ["unknown key", (e) => { e.foo = "bar"; }, /unknown intelligence-entry key "foo"/],
  ];
  for (const [label, mutate, re] of cases) {
    const e = entryFixture();
    mutate(e);
    const { valid, errors } = validateIntelligenceEntry(e);
    assert.equal(valid, false, `${label}: expected invalid`);
    assert.ok(errors.some((msg) => re.test(msg)), `${label}: no error matching ${re} in: ${errors.join("; ")}`);
  }
});

test("intelligence-entry: empty provenance strings fail", () => {
  for (const k of ["provenance_run", "provenance_task", "provenance_date"]) {
    const e = entryFixture();
    e[k] = "";
    const { valid, errors } = validateIntelligenceEntry(e);
    assert.equal(valid, false, `${k}: expected invalid`);
    assert.ok(errors.some((msg) => msg.startsWith(`${k}:`)), errors.join("; "));
  }
});

test("intelligence-entry: supersedes is optional; kebab when present", () => {
  const absent = validateIntelligenceEntry(entryFixture());
  assert.equal(absent.valid, true, absent.errors.join("; "));

  const good = entryFixture();
  good.supersedes = "old-entry";
  const rGood = validateIntelligenceEntry(good);
  assert.equal(rGood.valid, true, rGood.errors.join("; "));

  const bad = entryFixture();
  bad.supersedes = "Bad Name";
  const rBad = validateIntelligenceEntry(bad);
  assert.equal(rBad.valid, false);
  assert.ok(rBad.errors.some((msg) => msg.startsWith("supersedes:")), rBad.errors.join("; "));
});
