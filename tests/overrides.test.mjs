// Tests for the overrides engine (orchestration/lib/overrides.mjs), with a
// focus on the `stack` override field. First test suite in the repo: plain
// node:test + node:assert/strict, zero deps, run with `node --test tests/`.
//
// Error paths (die() → process.exit) are asserted by running the CLI in a
// subprocess (spawnSync) and checking exit status + stderr — die() would kill
// the in-process test runner.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseField, applyOverrides } from "../orchestration/lib/overrides.mjs";
import { validateWorkspace, OVERRIDES_SCHEMA } from "../orchestration/lib/schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OVERRIDES_CLI = path.join(HERE, "..", "orchestration", "lib", "overrides.mjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
const tmpFile = (name) => path.join(TMP, `${seq++}-${name}`);

function cli(...args) {
  return spawnSync(process.execPath, [OVERRIDES_CLI, ...args], { encoding: "utf8" });
}
function readJSON(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }

// Minimal valid workspace@3 detection fixture: one member, unknown stack.
function detectedFixture() {
  return {
    schema: "orchestration/workspace@3",
    generated: "2026-08-10T00:00:00Z",
    topology: "single-repo",
    workspace_root: "/ws",
    members: [{
      id: "m1",
      path: "/ws",
      git: true,
      default_branch: "main",
      stack: "unknown",
      claude_md: "present",
      reports_dir: "/ws/.claude/reports",
      gates: { convention: null, lint: null, test: null, build: null },
      knowledge: { claude_md: null, skills: null, rubrics: null, extra: {} },
    }],
    defaults: { architect: "chuck-architect", parallelism: "serial", human_gate: "plan-and-integrate" },
  };
}

// --- parseField (direct import) ----------------------------------------------

test("parseField: stack is a first-class field", () => {
  assert.deepEqual(parseField("stack"), { kind: "stack" });
});

test("parseField: existing grammar still parses (regression)", () => {
  assert.deepEqual(parseField("gates.test"), { kind: "gate", key: "test" });
  assert.deepEqual(parseField("knowledge.rubrics"), { kind: "slot", slot: "rubrics" });
  assert.deepEqual(parseField("note"), { kind: "note" });
});

// --- CLI set ------------------------------------------------------------------

test("set stack: records the label, writes schema, last write wins", () => {
  const ov = tmpFile("ov.json");
  const r1 = cli("set", ov, "m1", "stack", "Rust");
  assert.equal(r1.status, 0, r1.stderr);
  const parsed = readJSON(ov);
  assert.equal(parsed.schema, OVERRIDES_SCHEMA);
  assert.equal(parsed.members.m1.stack, "Rust");

  const r2 = cli("set", ov, "m1", "stack", "Go");
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readJSON(ov).members.m1.stack, "Go");
});

test("set stack: null/none die and route the user to unset", () => {
  const ov = tmpFile("ov.json");
  for (const raw of ["null", "none"]) {
    const r = cli("set", ov, "m1", "stack", raw);
    assert.notEqual(r.status, 0, `expected non-zero exit for stack=${raw}`);
    assert.match(r.stderr, /unset/, `stderr should route to unset for stack=${raw}`);
    assert.equal(fs.existsSync(ov), false, "no overrides file should be written on a rejected set");
  }
});

test("set: unknown fields still die (role stays deliberately excluded)", () => {
  const ov = tmpFile("ov.json");
  for (const field of ["role", "stak"]) {
    const r = cli("set", ov, "m1", field, "x");
    assert.notEqual(r.status, 0, `expected non-zero exit for field=${field}`);
    assert.match(r.stderr, /unknown field/);
  }
});

// --- CLI unset ----------------------------------------------------------------

test("unset stack: stack-only member entry is pruned entirely", () => {
  const ov = tmpFile("ov.json");
  assert.equal(cli("set", ov, "m1", "stack", "Rust").status, 0);
  const r = cli("unset", ov, "m1", "stack");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readJSON(ov).members, {});
});

test("unset stack: other overrides on the member survive", () => {
  const ov = tmpFile("ov.json");
  assert.equal(cli("set", ov, "m1", "stack", "Rust").status, 0);
  assert.equal(cli("set", ov, "m1", "note", "keep me").status, 0);
  const r = cli("unset", ov, "m1", "stack");
  assert.equal(r.status, 0, r.stderr);
  const m = readJSON(ov).members.m1;
  assert.equal(m.stack, undefined);
  assert.deepEqual(m.notes, ["keep me"]);
});

// --- CLI show -----------------------------------------------------------------

test("show: stack prints first, before gates", () => {
  const ov = tmpFile("ov.json");
  assert.equal(cli("set", ov, "m1", "stack", "Rust").status, 0);
  assert.equal(cli("set", ov, "m1", "gates.test", "cargo test").status, 0);
  assert.equal(cli("set", ov, "m1", "note", "a note").status, 0);
  const r = cli("show", ov);
  assert.equal(r.status, 0, r.stderr);
  const stackAt = r.stdout.indexOf("stack: Rust");
  const gateAt = r.stdout.indexOf("gates.test:");
  assert.ok(stackAt >= 0, `show output missing stack line:\n${r.stdout}`);
  assert.ok(gateAt >= 0, `show output missing gate line:\n${r.stdout}`);
  assert.ok(stackAt < gateAt, "stack must print before gates");
  assert.match(r.stdout, /note: a note/);
});

// --- CLI validate -------------------------------------------------------------

test("validate: string stack accepted, non-string and null rejected", () => {
  const ok = tmpFile("ok.json");
  fs.writeFileSync(ok, JSON.stringify({ schema: OVERRIDES_SCHEMA, members: { m1: { stack: "Rust" } } }));
  const rOk = cli("validate", ok);
  assert.equal(rOk.status, 0, rOk.stderr);
  assert.match(rOk.stdout, /OK/);

  const bad = tmpFile("bad.json");
  fs.writeFileSync(bad, JSON.stringify({ schema: OVERRIDES_SCHEMA, members: { m1: { stack: 123 } } }));
  const rBad = cli("validate", bad);
  assert.notEqual(rBad.status, 0);
  assert.match(rBad.stderr, /members\.m1\.stack/);

  const nul = tmpFile("null.json");
  fs.writeFileSync(nul, JSON.stringify({ schema: OVERRIDES_SCHEMA, members: { m1: { stack: null } } }));
  const rNul = cli("validate", nul);
  assert.notEqual(rNul.status, 0);
  assert.match(rNul.stderr, /members\.m1\.stack/);
});

// --- applyOverrides (direct import) -------------------------------------------

test("apply: stack override replaces the detected stack; profile self-validates", () => {
  const { profile, conflicts } = applyOverrides(detectedFixture(), {
    schema: OVERRIDES_SCHEMA, members: { m1: { stack: "Rust" } },
  });
  assert.deepEqual(conflicts, []);
  assert.equal(profile.members[0].stack, "Rust");
  const { valid, errors } = validateWorkspace(profile);
  assert.equal(valid, true, errors.join("; "));
});

test("apply: override for a missing member still yields the stale-member conflict (regression)", () => {
  const { conflicts } = applyOverrides(detectedFixture(), {
    schema: OVERRIDES_SCHEMA, members: { ghost: { stack: "Rust" } },
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].member, "ghost");
});

test("apply: gates/knowledge/notes merge unchanged alongside a stack override", () => {
  const { profile, conflicts } = applyOverrides(detectedFixture(), {
    schema: OVERRIDES_SCHEMA,
    members: {
      m1: {
        stack: "Rust",
        gates: { test: "cargo test" },
        knowledge: { rubrics: "/ws/rubrics.md", extra: { style: "/ws/style.md" } },
        notes: ["hand-checked"],
      },
    },
  });
  assert.deepEqual(conflicts, []);
  const m = profile.members[0];
  assert.equal(m.stack, "Rust");
  assert.deepEqual(m.gates, { convention: null, lint: null, test: "cargo test", build: null });
  assert.equal(m.knowledge.rubrics, "/ws/rubrics.md");
  assert.equal(m.knowledge.claude_md, null);
  assert.deepEqual(m.knowledge.extra, { style: "/ws/style.md" });
  assert.deepEqual(m.notes, ["hand-checked"]);
  const { valid, errors } = validateWorkspace(profile);
  assert.equal(valid, true, errors.join("; "));
});
