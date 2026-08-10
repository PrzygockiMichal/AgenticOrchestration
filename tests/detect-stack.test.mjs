// Tests for Rust/Java stack classification (orchestration/lib/detect.mjs):
// classifyStack precedence, all-null gates by the fabrication ruling (gates come
// only from manifest-declared command strings — `cargo test`/`mvn test` are
// toolchain conventions, not manifest facts), monorepo sub-project enumeration,
// and end-to-end detect() decisions for a rust member. Zero deps, node:test;
// run with `node --test "tests/*.test.mjs"`.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detect, detectTopology, classifyStack, extractGates } from "../orchestration/lib/detect.mjs";
import { validateWorkspace } from "../orchestration/lib/schema.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "orch-detect-test-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
// Fresh fixture dir seeded with the given files ("a/b.toml" nesting allowed).
function fixture(name, files = []) {
  const dir = path.join(TMP, `${seq++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const p = path.join(dir, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "");
  }
  return dir;
}
// git is a hard prerequisite of this repo's tooling — if init fails, the throw
// fails the test loudly (escalate, never skip silently).
function gitInit(dir) {
  execFileSync("git", ["init", "-q", dir], { encoding: "utf8" });
  return dir;
}

// --- classifyStack (direct, plain temp dirs — no git needed) -------------------

test("classifyStack: Cargo.toml → rust/Rust", () => {
  const s = classifyStack(fixture("rust", ["Cargo.toml"]));
  assert.equal(s.kind, "rust");
  assert.equal(s.label, "Rust");
  assert.equal(s.pkg, undefined, "rust stack must carry no pkg (gates derive to null)");
});

test("classifyStack: pom.xml → java/Java (Maven)", () => {
  const s = classifyStack(fixture("maven", ["pom.xml"]));
  assert.equal(s.kind, "java");
  assert.equal(s.label, "Java (Maven)");
  assert.equal(s.pkg, undefined);
});

test("classifyStack: build.gradle or build.gradle.kts → java/Java (Gradle)", () => {
  for (const f of ["build.gradle", "build.gradle.kts"]) {
    const s = classifyStack(fixture("gradle", [f]));
    assert.equal(s.kind, "java", f);
    assert.equal(s.label, "Java (Gradle)", f);
  }
});

test("classifyStack: pom.xml wins over build.gradle when both exist", () => {
  const s = classifyStack(fixture("maven-and-gradle", ["pom.xml", "build.gradle"]));
  assert.equal(s.label, "Java (Maven)");
});

test("classifyStack: package.json still wins over Cargo.toml", () => {
  // Note: fixture files are empty; an empty package.json is invalid JSON and
  // readJSON would fall through, so write a real manifest to hit the early return.
  const dir = fixture("node-beats-rust", ["Cargo.toml"]);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
  assert.equal(classifyStack(dir).kind, "node");
});

test("classifyStack: Cargo.toml beats docker-compose.yml (code beats infra)", () => {
  const s = classifyStack(fixture("rust-with-compose", ["Cargo.toml", "docker-compose.yml"]));
  assert.equal(s.kind, "rust");
});

test("classifyStack: regressions — infra-only and empty dirs unchanged", () => {
  assert.equal(classifyStack(fixture("infra", ["docker-compose.yml"])).kind, "infra");
  assert.equal(classifyStack(fixture("empty")).kind, "unknown");
});

// --- extractGates (proves rust/java members get all-null gates, no special case) --

test("extractGates(undefined) → all four gates null", () => {
  assert.deepEqual(extractGates(undefined, []), { convention: null, lint: null, test: null, build: null });
});

// --- detectTopology (git-init'd fixtures) --------------------------------------

test("detectTopology: two Cargo.toml crates → monorepo with real member paths", () => {
  const dir = gitInit(fixture("crates", ["crates/a/Cargo.toml", "crates/b/Cargo.toml"]));
  const topo = detectTopology(dir);
  assert.equal(topo.topology, "monorepo");
  assert.deepEqual(topo.subProjects, ["crates/a", "crates/b"]);
});

test("detectTopology: single svc/pom.xml is enumerated as a sub-project", () => {
  const dir = gitInit(fixture("svc", ["svc/pom.xml"]));
  const topo = detectTopology(dir);
  // One sub-project and no workspace config → not a monorepo; assert enumeration only.
  assert.deepEqual(topo.subProjects, ["svc"]);
});

// --- detect() end-to-end (rust member: isCode decisions + self-validation) -----

test("detect: root Cargo.toml → Rust member, null gates, CLAUDE.md + gate decisions", () => {
  const dir = gitInit(fixture("rust-repo", ["Cargo.toml"]));
  const result = detect(dir);
  assert.equal(result.blocked, undefined, result.message);
  assert.equal(result.members.length, 1);
  const m = result.members[0];
  assert.equal(m.stack, "Rust");
  assert.deepEqual(m.gates, { convention: null, lint: null, test: null, build: null });

  const questions = result.decisions_needed.map((d) => d.question);
  assert.ok(questions.some((q) => q.includes("no CLAUDE.md")), `missing CLAUDE.md decision:\n${questions.join("\n")}`);
  assert.ok(questions.some((q) => q.includes("no detectable test gate")), `missing test-gate decision:\n${questions.join("\n")}`);
  assert.ok(questions.some((q) => q.includes("no detectable build gate")), `missing build-gate decision:\n${questions.join("\n")}`);

  // Mirror the CLI's self-validation (decisions_needed allowed pre-finalize).
  const { valid, errors } = validateWorkspace({ ...result, decisions_needed: undefined });
  assert.equal(valid, true, (errors || []).join("; "));
});
