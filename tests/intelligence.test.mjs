// Tests for the intelligence writer/reader (orchestration/lib/intelligence.mjs).
// Same harness style as tests/overrides.test.mjs: plain node:test +
// node:assert/strict, zero deps, run with `node --test "tests/*.test.mjs"`.
//
// Error paths (die() → process.exit) are asserted by running the CLI in a
// subprocess (spawnSync) and checking exit status + stderr — die() would kill
// the in-process test runner. parse/serialize/PHASE_TYPES are unit-imported.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseEntry, serializeEntry, PHASE_TYPES } from "../orchestration/lib/intelligence.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INTELLIGENCE_CLI = path.join(HERE, "..", "orchestration", "lib", "intelligence.mjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "orch-intel-test-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
const tmpFile = (name) => path.join(TMP, `${seq++}-${name}`);

function cli(...args) {
  return spawnSync(process.execPath, [INTELLIGENCE_CLI, ...args], { encoding: "utf8" });
}
function cliStdin(input, ...args) {
  return spawnSync(process.execPath, [INTELLIGENCE_CLI, ...args], { encoding: "utf8", input });
}

// Valid `add` input JSON; override fields per test.
function inputJSON(over = {}) {
  return {
    name: "prefer-glob-tests",
    description: "when running the node test suite on Windows",
    type: "implementation",
    scope: "member",
    provenance: { run: "2026-08-10T14-30-14", task: "task-02", date: "2026-08-11T00:00:00Z", source: "user-correction" },
    trigger: "Running the repo test suite",
    directive: 'Use the glob form node --test "tests/*.test.mjs"',
    why: "The bare-directory form is broken on Windows/node 22",
    ...over,
  };
}
// add via a temp JSON file; returns the spawnSync result.
function addEntry(dir, over = {}) {
  const f = tmpFile("input.json");
  fs.writeFileSync(f, JSON.stringify(inputJSON(over)));
  return cli("add", dir, "--json", f);
}
function entryFile(dir, name) { return path.resolve(dir, `${name}.md`); }
function indexText(dir) { return fs.readFileSync(path.resolve(dir, "INDEX.md"), "utf8"); }
// INDEX.md slice for one status section (up to the next `## ` or EOF).
function indexSection(dir, status) {
  const text = indexText(dir);
  const start = text.indexOf(`## ${status}`);
  assert.ok(start >= 0, `INDEX.md missing section ## ${status}:\n${text}`);
  const rest = text.slice(start + `## ${status}`.length);
  const next = rest.indexOf("\n## ");
  return next >= 0 ? rest.slice(0, next) : rest;
}

// --- add ------------------------------------------------------------------------

test("add: creates the entry + INDEX.md; last stdout line is the absolute path", () => {
  const dir = tmpFile("dir");
  const r = addEntry(dir);
  assert.equal(r.status, 0, r.stderr);
  const file = entryFile(dir, "prefer-glob-tests");
  assert.equal(r.stdout.trim().split("\n").pop(), file);
  assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(path.resolve(dir, "INDEX.md")));

  const entry = parseEntry(fs.readFileSync(file, "utf8"));
  assert.equal(entry.status, "candidate"); // forced, never from input
  assert.equal(entry.name, "prefer-glob-tests");
  assert.equal(entry.type, "implementation");
  assert.equal(entry.scope, "member");
  // provenance flattened to provenance_* keys
  assert.equal(entry.provenance_run, "2026-08-10T14-30-14");
  assert.equal(entry.provenance_task, "task-02");
  assert.equal(entry.provenance_date, "2026-08-11T00:00:00Z");
  assert.equal(entry.provenance_source, "user-correction");
  assert.equal(entry.body.trigger, "Running the repo test suite");
  assert.equal(entry.body.why, "The bare-directory form is broken on Windows/node 22");
});

test("add: invalid type dies and writes nothing", () => {
  const dir = tmpFile("dir");
  const r = addEntry(dir, { type: "bogus" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /type/);
  assert.equal(fs.existsSync(entryFile(dir, "prefer-glob-tests")), false);
  assert.equal(fs.existsSync(path.resolve(dir, "INDEX.md")), false);
});

test("add: input carrying status is rejected", () => {
  const dir = tmpFile("dir");
  const r = addEntry(dir, { status: "active" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /status/);
  assert.equal(fs.existsSync(entryFile(dir, "prefer-glob-tests")), false);
});

test("add: duplicate name dies with a supersede hint", () => {
  const dir = tmpFile("dir");
  assert.equal(addEntry(dir).status, 0);
  const r = addEntry(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /already exists/);
  assert.match(r.stderr, /supersede/);
});

test("add: --json - reads the input from stdin", () => {
  const dir = tmpFile("dir");
  const r = cliStdin(JSON.stringify(inputJSON({ name: "stdin-entry" })), "add", dir, "--json", "-");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(entryFile(dir, "stdin-entry")));
});

// --- parse / serialize round-trip -------------------------------------------------

test("round-trip: serializeEntry(parseEntry(text)) is byte-identical for written entries", () => {
  const dir = tmpFile("dir");
  assert.equal(addEntry(dir).status, 0);
  assert.equal(addEntry(dir, { name: "with-supersedes", supersedes: "prefer-glob-tests" }).status, 0);
  for (const name of ["prefer-glob-tests", "with-supersedes"]) {
    const text = fs.readFileSync(entryFile(dir, name), "utf8");
    assert.equal(serializeEntry(parseEntry(text)), text, `round-trip drift for ${name}`);
  }
  const withSup = parseEntry(fs.readFileSync(entryFile(dir, "with-supersedes"), "utf8"));
  assert.equal(withSup.supersedes, "prefer-glob-tests");
});

test("round-trip: a value containing a colon survives (split on first ': ' only)", () => {
  const dir = tmpFile("dir");
  assert.equal(addEntry(dir, { description: "watch out: colons" }).status, 0);
  const text = fs.readFileSync(entryFile(dir, "prefer-glob-tests"), "utf8");
  const entry = parseEntry(text);
  assert.equal(entry.description, "watch out: colons");
  assert.equal(serializeEntry(entry), text);
});

// --- list -------------------------------------------------------------------------

test("list: metadata-only JSON (no body keys) with status/type/scope filters", () => {
  const dir = tmpFile("dir");
  assert.equal(addEntry(dir, { name: "impl-member", type: "implementation", scope: "member" }).status, 0);
  assert.equal(addEntry(dir, { name: "plan-workspace", type: "planning", scope: "workspace" }).status, 0);
  assert.equal(cli("promote", dir, "plan-workspace").status, 0);

  const all = JSON.parse(cli("list", dir).stdout);
  assert.equal(all.length, 2);
  for (const row of all) {
    for (const k of ["trigger", "directive", "why", "body"]) {
      assert.equal(k in row, false, `list row leaks body key "${k}"`);
    }
    assert.equal(row.path, entryFile(dir, row.name));
  }
  const byStatus = JSON.parse(cli("list", dir, "--status", "candidate").stdout);
  assert.deepEqual(byStatus.map((r) => r.name), ["impl-member"]);
  const byType = JSON.parse(cli("list", dir, "--type", "implementation").stdout);
  assert.deepEqual(byType.map((r) => r.name), ["impl-member"]);
  const byScope = JSON.parse(cli("list", dir, "--scope", "member").stdout);
  assert.deepEqual(byScope.map((r) => r.name), ["impl-member"]);
});

test("list: missing dir yields [] (not an error)", () => {
  const r = cli("list", tmpFile("never-created"));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), []);
});

test("list: a corrupted entry file dies naming the file", () => {
  const dir = tmpFile("dir");
  assert.equal(addEntry(dir).status, 0);
  fs.writeFileSync(path.join(dir, "garbage.md"), "this is not an entry\n");
  const r = cli("list", dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /garbage\.md/);
});

// --- promote ------------------------------------------------------------------------

test("promote: candidate -> active, body byte-identical, INDEX section moves", () => {
  const dir = tmpFile("dir");
  assert.equal(addEntry(dir).status, 0);
  assert.match(indexSection(dir, "candidate"), /prefer-glob-tests/);

  const before = fs.readFileSync(entryFile(dir, "prefer-glob-tests"), "utf8");
  const r = cli("promote", dir, "prefer-glob-tests");
  assert.equal(r.status, 0, r.stderr);
  const after_ = fs.readFileSync(entryFile(dir, "prefer-glob-tests"), "utf8");
  // the ONLY change is the status line; body (and all other frontmatter) byte-identical
  assert.equal(after_, before.replace("status: candidate", "status: active"));
  assert.match(indexSection(dir, "active"), /prefer-glob-tests/);
  assert.doesNotMatch(indexSection(dir, "candidate"), /prefer-glob-tests/);
});

test("promote: an active entry cannot be promoted again", () => {
  const dir = tmpFile("dir");
  assert.equal(addEntry(dir).status, 0);
  assert.equal(cli("promote", dir, "prefer-glob-tests").status, 0);
  const r = cli("promote", dir, "prefer-glob-tests");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /only candidates/);
});

test("promote: refuses a supersedes-carrying candidate, routing to supersede", () => {
  const dir = tmpFile("dir");
  assert.equal(addEntry(dir, { name: "old-rule" }).status, 0);
  assert.equal(cli("promote", dir, "old-rule").status, 0);
  assert.equal(addEntry(dir, { name: "new-rule", supersedes: "old-rule" }).status, 0);
  const r = cli("promote", dir, "new-rule");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /supersede/);
  assert.match(r.stderr, /old-rule/);
  // nothing changed: still a candidate
  const entry = parseEntry(fs.readFileSync(entryFile(dir, "new-rule"), "utf8"));
  assert.equal(entry.status, "candidate");
});

// --- drop --------------------------------------------------------------------------

test("drop: deletes a candidate and updates INDEX", () => {
  const dir = tmpFile("dir");
  assert.equal(addEntry(dir).status, 0);
  const r = cli("drop", dir, "prefer-glob-tests");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(entryFile(dir, "prefer-glob-tests")), false);
  assert.doesNotMatch(indexText(dir), /prefer-glob-tests/);
  assert.match(indexSection(dir, "candidate"), /\(none\)/);
});

test("drop: an active entry cannot be dropped", () => {
  const dir = tmpFile("dir");
  assert.equal(addEntry(dir).status, 0);
  assert.equal(cli("promote", dir, "prefer-glob-tests").status, 0);
  const r = cli("drop", dir, "prefer-glob-tests");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /only candidates can be dropped/);
  assert.ok(fs.existsSync(entryFile(dir, "prefer-glob-tests")));
});

// --- supersede -----------------------------------------------------------------------

test("supersede: old active -> superseded, new candidate -> active with supersedes set", () => {
  const dir = tmpFile("dir");
  assert.equal(addEntry(dir, { name: "old-rule" }).status, 0);
  assert.equal(cli("promote", dir, "old-rule").status, 0);
  assert.equal(addEntry(dir, { name: "new-rule" }).status, 0); // no supersedes at add time
  const r = cli("supersede", dir, "old-rule", "new-rule");
  assert.equal(r.status, 0, r.stderr);
  const oldE = parseEntry(fs.readFileSync(entryFile(dir, "old-rule"), "utf8"));
  const newE = parseEntry(fs.readFileSync(entryFile(dir, "new-rule"), "utf8"));
  assert.equal(oldE.status, "superseded");
  assert.equal(newE.status, "active");
  assert.equal(newE.supersedes, "old-rule");
  assert.match(indexSection(dir, "superseded"), /old-rule/);
  assert.match(indexSection(dir, "active"), /new-rule/);
});

test("supersede: a candidate that already carries supersedes reaches the same end state (idempotent confirm)", () => {
  const dir = tmpFile("dir");
  assert.equal(addEntry(dir, { name: "old-rule" }).status, 0);
  assert.equal(cli("promote", dir, "old-rule").status, 0);
  assert.equal(addEntry(dir, { name: "new-rule", supersedes: "old-rule" }).status, 0);
  const r = cli("supersede", dir, "old-rule", "new-rule");
  assert.equal(r.status, 0, r.stderr);
  const oldE = parseEntry(fs.readFileSync(entryFile(dir, "old-rule"), "utf8"));
  const newE = parseEntry(fs.readFileSync(entryFile(dir, "new-rule"), "utf8"));
  assert.equal(oldE.status, "superseded");
  assert.equal(newE.status, "active");
  assert.equal(newE.supersedes, "old-rule");
});

test("supersede: wrong statuses die", () => {
  const dir = tmpFile("dir");
  assert.equal(addEntry(dir, { name: "old-rule" }).status, 0); // still candidate
  assert.equal(addEntry(dir, { name: "new-rule" }).status, 0);
  const r1 = cli("supersede", dir, "old-rule", "new-rule"); // old not active
  assert.notEqual(r1.status, 0);
  assert.match(r1.stderr, /must be active/);

  assert.equal(cli("promote", dir, "old-rule").status, 0);
  assert.equal(cli("promote", dir, "new-rule").status, 0); // now BOTH active
  const r2 = cli("supersede", dir, "old-rule", "new-rule"); // new not candidate
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /must be a candidate/);

  const r3 = cli("supersede", dir, "ghost", "new-rule"); // missing entry
  assert.notEqual(r3.status, 0);
  assert.match(r3.stderr, /no such entry/);
});

// --- index ---------------------------------------------------------------------------

test("index: deterministic (identical modulo GENERATED), fixed section order, (none) for empty", () => {
  const dir = tmpFile("dir");
  assert.equal(addEntry(dir, { name: "b-entry" }).status, 0);
  assert.equal(addEntry(dir, { name: "a-entry" }).status, 0);
  assert.equal(cli("promote", dir, "a-entry").status, 0);

  assert.equal(cli("index", dir).status, 0);
  const first = indexText(dir);
  assert.equal(cli("index", dir).status, 0);
  const second = indexText(dir);
  const strip = (t) => t.split("\n").filter((l) => !l.startsWith("GENERATED:")).join("\n");
  assert.equal(strip(first), strip(second));

  const active = first.indexOf("## active");
  const candidate = first.indexOf("## candidate");
  const superseded = first.indexOf("## superseded");
  assert.ok(active >= 0 && active < candidate && candidate < superseded, `section order wrong:\n${first}`);
  assert.match(indexSection(dir, "active"), /a-entry \[implementation\/member\]/);
  assert.match(indexSection(dir, "candidate"), /b-entry/);
  assert.match(indexSection(dir, "superseded"), /\(none\)/);
});

// --- effective -----------------------------------------------------------------------

// Shared two-dir fixture (workspace + member), built once via the real CLI.
let EFF = null;
function effectiveFixture() {
  if (EFF) return EFF;
  const ws = tmpFile("ws-intel");
  const mem = tmpFile("mem-intel");
  const mk = (dir, over, promote = true) => {
    assert.equal(addEntry(dir, over).status, 0, `fixture add failed: ${over.name}`);
    if (promote) assert.equal(cli("promote", dir, over.name).status, 0, `fixture promote failed: ${over.name}`);
  };
  mk(ws, { name: "ent-plan", type: "planning" });
  mk(ws, { name: "ent-impl", type: "implementation" });
  mk(ws, { name: "ent-rev", type: "review" });
  mk(ws, { name: "ent-all", type: "all" });
  mk(ws, { name: "ent-cand", type: "planning" }, false); // stays candidate
  mk(ws, { name: "ent-old", type: "all" });
  mk(ws, { name: "ent-new", type: "all" }, false);
  assert.equal(cli("supersede", ws, "ent-old", "ent-new").status, 0); // ent-old superseded
  mk(ws, { name: "shared", type: "all", scope: "workspace", directive: "workspace version" });
  mk(mem, { name: "shared", type: "all", directive: "member version" });
  mk(mem, { name: "mem-only", type: "planning" });
  EFF = { ws, mem };
  return EFF;
}
function effective(args) {
  const r = cli("effective", ...args);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("effective: hoists trigger/directive/why to top-level keys alongside frontmatter + path", () => {
  const { ws } = effectiveFixture();
  const rows = effective(["--phase", "implementation", ws]);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(typeof row.trigger, "string");
    assert.equal(typeof row.directive, "string");
    assert.equal(typeof row.why, "string");
    assert.equal("body" in row, false);
    assert.equal(typeof row.path, "string");
    assert.equal(row.status, "active");
    assert.ok(row.name && row.type && row.scope && row.provenance_date);
  }
});

test("effective: phase routing (planning / implementation / review / comma union)", () => {
  const { ws } = effectiveFixture();
  const names = (args) => effective(args).map((r) => r.name);
  assert.deepEqual(names(["--phase", "planning", ws]), ["ent-all", "ent-new", "ent-plan", "shared"]);
  assert.deepEqual(names(["--phase", "implementation", ws]), ["ent-all", "ent-impl", "ent-new", "shared"]);
  assert.deepEqual(names(["--phase", "review", ws]), ["ent-all", "ent-impl", "ent-new", "ent-rev", "shared"]);
  assert.deepEqual(names(["--phase", "planning,review", ws]),
    ["ent-all", "ent-impl", "ent-new", "ent-plan", "ent-rev", "shared"]);
});

test("effective: candidates only with --candidates; superseded never", () => {
  const { ws } = effectiveFixture();
  const plain = effective(["--phase", "planning", ws]).map((r) => r.name);
  assert.ok(!plain.includes("ent-cand"), "candidate leaked without --candidates");
  const withC = effective(["--phase", "planning", "--candidates", ws]).map((r) => r.name);
  assert.ok(withC.includes("ent-cand"), "--candidates did not include the candidate");
  for (const args of [["--phase", "planning", ws], ["--phase", "planning", "--candidates", ws]]) {
    assert.ok(!effective(args).map((r) => r.name).includes("ent-old"), "superseded entry leaked");
  }
});

test("effective: later dir wins name collisions (member over workspace); sorted; missing dirs skipped", () => {
  const { ws, mem } = effectiveFixture();
  const rows = effective(["--phase", "planning", ws, mem, tmpFile("no-such-dir")]);
  const names = rows.map((r) => r.name);
  assert.deepEqual(names, [...names].sort(), "output not sorted by name");
  assert.ok(names.includes("mem-only"));
  const shared = rows.find((r) => r.name === "shared");
  assert.equal(shared.directive, "member version");
  assert.equal(shared.path, entryFile(mem, "shared"));
});

test("PHASE_TYPES: the exported mapping matches the contract", () => {
  assert.deepEqual(PHASE_TYPES, {
    planning: ["planning", "all"],
    implementation: ["implementation", "all"],
    review: ["implementation", "review", "all"],
  });
});

// --- validate ------------------------------------------------------------------------

test("validate: OK on a clean dir; dies naming the file on a bad entry", () => {
  const dir = tmpFile("dir");
  assert.equal(addEntry(dir).status, 0);
  const rOk = cli("validate", dir);
  assert.equal(rOk.status, 0, rOk.stderr);
  assert.match(rOk.stdout, /OK/);

  fs.writeFileSync(path.join(dir, "broken.md"), "---\nname: broken\n---\n\nno headings\n");
  const rBad = cli("validate", dir);
  assert.notEqual(rBad.status, 0);
  assert.match(rBad.stderr, /broken\.md/);
});
