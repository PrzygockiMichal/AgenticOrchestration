// Tests for the unknown-with-sources decision path (orchestration/lib/detect.mjs):
// hasSourceFiles on both branches (git ls-files vs bounded fs walk — same filters:
// SOURCE_EXTENSIONS allowlist, IGNORE_DIRS + dot-directory segment exclusion, per
// the user ruling that e.g. `.github/` CI scripts alone do not make a member
// "code"), and end-to-end detect() decision emission: unknown-with-sources raises
// the stack-unrecognized + CLAUDE.md decisions (stack first, never gate decisions);
// infra-only and source-less members stay silent. Zero deps, node:test; run with
// `node --test "tests/*.test.mjs"`.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detect, hasSourceFiles } from "../orchestration/lib/detect.mjs";
import { validateWorkspace } from "../orchestration/lib/schema.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "orch-decisions-test-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
// Fresh fixture dir seeded with the given files ("a/b.sh" nesting allowed).
// `files` may be an array of empty files or a { path: content } map.
function fixture(name, files = []) {
  const dir = path.join(TMP, `${seq++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const entries = Array.isArray(files) ? files.map((f) => [f, ""]) : Object.entries(files);
  for (const [f, content] of entries) {
    const p = path.join(dir, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}
// git is a hard prerequisite of this repo's tooling — if init fails, the throw
// fails the test loudly (escalate, never skip silently).
function gitInit(dir) {
  execFileSync("git", ["init", "-q", dir], { encoding: "utf8" });
  return dir;
}

// --- hasSourceFiles: git branch (ls-files --cached --others --exclude-standard) --

test("hasSourceFiles(git): UNTRACKED tool.sh counts (proves --others)", () => {
  assert.equal(hasSourceFiles(gitInit(fixture("untracked-sh", ["tool.sh"]))), true);
});

test("hasSourceFiles(git): README.md + LICENSE only → false", () => {
  assert.equal(hasSourceFiles(gitInit(fixture("docs-only", ["README.md", "LICENSE"]))), false);
});

test("hasSourceFiles(git): gitignored src/x.py does not count (proves --exclude-standard)", () => {
  const dir = gitInit(fixture("ignored-src", { ".gitignore": "src/\n", "src/x.py": "print(1)\n" }));
  assert.equal(hasSourceFiles(dir), false);
});

test("hasSourceFiles(git): un-gitignored node_modules/a.js does not count (IGNORE_DIRS filter)", () => {
  assert.equal(hasSourceFiles(gitInit(fixture("nm-only", ["node_modules/a.js"]))), false);
});

test("hasSourceFiles(git): sources under a dot-directory do not count (user ruling)", () => {
  assert.equal(hasSourceFiles(gitInit(fixture("ci-only", [".github/scripts/ci.sh"]))), false);
});

// --- hasSourceFiles: walk branch (plain non-git dirs) ---------------------------

test("hasSourceFiles(walk): scripts/run.sh → true", () => {
  assert.equal(hasSourceFiles(fixture("walk-sh", ["scripts/run.sh"])), true);
});

test("hasSourceFiles(walk): data.csv + README.md only → false", () => {
  assert.equal(hasSourceFiles(fixture("walk-data", ["data.csv", "README.md"])), false);
});

test("hasSourceFiles(walk): node_modules/x.js only → false (walk pruning)", () => {
  assert.equal(hasSourceFiles(fixture("walk-nm", ["node_modules/x.js"])), false);
});

test("hasSourceFiles(walk): dot-directory pruned — .github/scripts/ci.sh → false (matches git branch)", () => {
  assert.equal(hasSourceFiles(fixture("walk-ci", [".github/scripts/ci.sh"])), false);
});

// --- detect() end-to-end --------------------------------------------------------

test("detect: unknown-with-sources → stack-unrecognized + CLAUDE.md decisions, no gate decisions", () => {
  const dir = gitInit(fixture("unknown-repo", ["tool.sh"]));
  const result = detect(dir);
  assert.equal(result.blocked, undefined, result.message);
  assert.equal(result.members.length, 1);
  const m = result.members[0];
  assert.equal(m.stack, "unknown");

  const questions = result.decisions_needed.map((d) => d.question);
  const stackIdx = questions.findIndex((q) => q.includes("source files but no recognized manifest"));
  const claudeIdx = questions.findIndex((q) => q.includes("no CLAUDE.md"));
  assert.notEqual(stackIdx, -1, `missing stack-unrecognized decision:\n${questions.join("\n")}`);
  assert.notEqual(claudeIdx, -1, `missing CLAUDE.md decision:\n${questions.join("\n")}`);
  assert.ok(questions[stackIdx].includes(m.id), "stack question must name the member id");
  assert.ok(result.decisions_needed[stackIdx].recommended.includes("stack"),
    "recommended must mention a stack label");
  assert.ok(stackIdx < claudeIdx, "stack decision must be ordered before the CLAUDE.md one");
  assert.ok(!questions.some((q) => q.includes("no detectable")),
    `gate decisions must NOT be raised for unknown members:\n${questions.join("\n")}`);

  // Mirror the CLI's self-validation (decisions_needed allowed pre-finalize).
  const { valid, errors } = validateWorkspace({ ...result, decisions_needed: undefined });
  assert.equal(valid, true, (errors || []).join("; "));
});

test("detect: source-less unknown repo (README.md only) → zero decisions", () => {
  const result = detect(gitInit(fixture("readme-repo", ["README.md"])));
  assert.equal(result.blocked, undefined, result.message);
  assert.deepEqual(result.decisions_needed, []);
});

test("detect: infra-only repo (docker-compose.yml) → kind infra, zero decisions", () => {
  const result = detect(gitInit(fixture("infra-repo", ["docker-compose.yml"])));
  assert.equal(result.blocked, undefined, result.message);
  assert.equal(result.members[0].stack, "infra (docker-compose)");
  assert.deepEqual(result.decisions_needed, []);
});

test("detect: regression — node member decisions unchanged (CLAUDE.md + gates, no stack decision)", () => {
  const dir = gitInit(fixture("node-repo", { "package.json": JSON.stringify({ name: "x" }) }));
  const result = detect(dir);
  assert.equal(result.blocked, undefined, result.message);

  const questions = result.decisions_needed.map((d) => d.question);
  assert.ok(questions.some((q) => q.includes("no CLAUDE.md")), `missing CLAUDE.md decision:\n${questions.join("\n")}`);
  assert.ok(questions.some((q) => q.includes("no detectable test gate")), `missing test-gate decision:\n${questions.join("\n")}`);
  assert.ok(questions.some((q) => q.includes("no detectable build gate")), `missing build-gate decision:\n${questions.join("\n")}`);
  assert.ok(!questions.some((q) => q.includes("no recognized manifest")),
    "isCode members must not get the stack-unrecognized decision");
});
