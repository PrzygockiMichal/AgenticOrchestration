// Tests for the writer plumbing behind the workspace@4 `intelligence` knowledge
// slot: detect.mjs knowledgeLinks, overrides.mjs applyOverrides/parseField,
// paths.mjs intelligence helpers, and the config.mjs CLI round-trip for the new
// `intelligence` key. House style of tests/overrides.test.mjs: node:test +
// node:assert/strict, zero deps, spawnSync for CLI paths, shared TMP + tmpFile().
// Run with `node --test "tests/*.test.mjs"`.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { knowledgeLinks } from "../orchestration/lib/detect.mjs";
import { parseField, applyOverrides } from "../orchestration/lib/overrides.mjs";
import { intelligenceDir, memberIntelligenceDir, profilePaths } from "../orchestration/lib/paths.mjs";
import {
  WORKSPACE_SCHEMA, KNOWLEDGE_SLOTS, OVERRIDES_SCHEMA, validateWorkspace,
} from "../orchestration/lib/schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_CLI = path.join(HERE, "..", "orchestration", "lib", "config.mjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
const tmpFile = (name) => path.join(TMP, `${seq++}-${name}`);
const tmpDir = (name) => {
  const d = tmpFile(name);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

function configCli(...args) {
  return spawnSync(process.execPath, [CONFIG_CLI, ...args], { encoding: "utf8" });
}

// Minimal valid workspace detection fixture built from the imported constants
// (same shape as tests/overrides.test.mjs's).
function detectedFixture() {
  return {
    schema: WORKSPACE_SCHEMA,
    generated: "2026-08-11T00:00:00Z",
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
      knowledge: { ...Object.fromEntries(KNOWLEDGE_SLOTS.map((s) => [s, null])), extra: {} },
    }],
    defaults: { architect: "chuck-architect", parallelism: "serial", human_gate: "plan-and-integrate" },
  };
}

// --- detect.knowledgeLinks ------------------------------------------------------

test("knowledgeLinks: intelligence dir present → POSIX relative path", () => {
  const abs = tmpDir("member");
  fs.mkdirSync(path.join(abs, ".claude", "orchestration", "intelligence"), { recursive: true });
  const k = knowledgeLinks(abs, ".");
  assert.equal(k.intelligence, ".claude/orchestration/intelligence");
});

test("knowledgeLinks: intelligence dir absent → null", () => {
  const abs = tmpDir("member");
  const k = knowledgeLinks(abs, ".");
  assert.equal(k.intelligence, null);
});

test("knowledgeLinks: slot is prefixed with the member path for non-root members", () => {
  const abs = tmpDir("member");
  fs.mkdirSync(path.join(abs, ".claude", "orchestration", "intelligence"), { recursive: true });
  const k = knowledgeLinks(abs, "packages/api");
  assert.equal(k.intelligence, "packages/api/.claude/orchestration/intelligence");
});

test("knowledgeLinks: claude_md/skills behavior unchanged; rubrics stays null", () => {
  const abs = tmpDir("member");
  fs.writeFileSync(path.join(abs, "CLAUDE.md"), "# m\n");
  fs.mkdirSync(path.join(abs, ".claude", "skills"), { recursive: true });
  const k = knowledgeLinks(abs, ".");
  assert.equal(k.claude_md, "CLAUDE.md");
  assert.equal(k.skills, ".claude/skills");
  assert.equal(k.rubrics, null);
  assert.deepEqual(k.extra, {});
});

// --- overrides: parseField + applyOverrides ---------------------------------------

test("parseField: knowledge.intelligence is a known slot", () => {
  assert.deepEqual(parseField("knowledge.intelligence"), { kind: "slot", slot: "intelligence" });
});

test("apply: intelligence slot override lands and the profile self-validates", () => {
  const { profile, conflicts } = applyOverrides(detectedFixture(), {
    schema: OVERRIDES_SCHEMA,
    members: { m1: { knowledge: { intelligence: ".claude/orchestration/intelligence" } } },
  });
  assert.deepEqual(conflicts, []);
  assert.equal(profile.members[0].knowledge.intelligence, ".claude/orchestration/intelligence");
  const { valid, errors } = validateWorkspace(profile);
  assert.equal(valid, true, errors.join("; "));
});

test("apply: stack override and intelligence slot coexist on the same member (v1.3.1 regression guard)", () => {
  const { profile, conflicts } = applyOverrides(detectedFixture(), {
    schema: OVERRIDES_SCHEMA,
    members: {
      m1: {
        stack: "Rust",
        knowledge: { intelligence: ".claude/orchestration/intelligence" },
      },
    },
  });
  assert.deepEqual(conflicts, []);
  const m = profile.members[0];
  assert.equal(m.stack, "Rust");
  assert.equal(m.knowledge.intelligence, ".claude/orchestration/intelligence");
  const { valid, errors } = validateWorkspace(profile);
  assert.equal(valid, true, errors.join("; "));
});

// --- paths ------------------------------------------------------------------------

test("paths: profilePaths includes the intelligence dir", () => {
  const root = tmpDir("root");
  const p = profilePaths(root, "single-repo");
  const suffix = path.join(".claude", "orchestration", "intelligence");
  assert.ok(p.intelligence.endsWith(suffix), `${p.intelligence} should end with ${suffix}`);
  assert.equal(p.intelligence, intelligenceDir(root));
});

test("paths: memberIntelligenceDir collapses to intelligenceDir for member path '.'", () => {
  const root = tmpDir("root");
  assert.equal(memberIntelligenceDir(root, "."), intelligenceDir(root));
});

test("paths: memberIntelligenceDir resolves under the member for a subpath", () => {
  const root = tmpDir("root");
  assert.equal(
    memberIntelligenceDir(root, "packages/api"),
    path.join(root, "packages", "api", ".claude", "orchestration", "intelligence"),
  );
});

// --- config CLI round-trip ----------------------------------------------------------

test("config CLI: workspace-layer intelligence round-trips (set false → get false, set true → get true)", () => {
  const root = tmpDir("cfgroot");
  // Workspace layer wins over any global config on this machine → deterministic.
  const s1 = configCli("set", "workspace", "intelligence", "false", root);
  assert.equal(s1.status, 0, s1.stderr);
  const g1 = configCli("get", "intelligence", root);
  assert.equal(g1.status, 0, g1.stderr);
  assert.equal(g1.stdout.trim(), "false");

  const s2 = configCli("set", "workspace", "intelligence", "true", root);
  assert.equal(s2.status, 0, s2.stderr);
  const g2 = configCli("get", "intelligence", root);
  assert.equal(g2.status, 0, g2.stderr);
  assert.equal(g2.stdout.trim(), "true");
});
