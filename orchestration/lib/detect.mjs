#!/usr/bin/env node
// Deterministic workspace detection. This is the executable form of the
// "Detection algorithm" section of WORKSPACE.md — that prose is now this
// script's SPEC, not runtime instructions for an LLM. Every field is derived
// from a command output or a file read; nothing is guessed. Ambiguity becomes
// a `decisions_needed` entry, never an invented value.
//
// Usage:   node detect.mjs [workspace-root]      (defaults to cwd)
// Output:  a workspace.json object (schema orchestration/workspace@3) on stdout,
//          with `decisions_needed` populated. The command/agent layer resolves
//          those decisions into overrides.local.json and derives the profile
//          via lib/overrides.mjs (detected ⊕ overrides).
//
// Exit codes: 0 = detected; 2 = nothing to orchestrate (blocked); 1 = error.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_SCHEMA, validateWorkspace } from "./schema.mjs";
import { pluginVersion } from "./version.mjs";

const IGNORE_DIRS = new Set(["node_modules", "vendor", "dist", "build", ".git"]);
// Allowlist for the unknown-with-sources check: presence of any such file makes an
// unrecognized member a code-ambiguity that must surface as a decision.
const SOURCE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs", ".java",
  ".kt", ".kts", ".rb", ".php", ".cs", ".c", ".h", ".cpp", ".cc", ".hpp",
  ".sh", ".ps1", ".swift", ".scala",
]);
const DEFAULT_BRANCHES = new Set(["main", "master"]);

const FRONTEND_RE = /^(react|vue|svelte|next|@angular\/core|@sveltejs\/kit)$|^vite$/;
const BACKEND_NODE_RE = /^@nestjs\/core$|^express$|^fastify$|^koa$|^@hapi\/hapi$/;
// Only true application frameworks count as a web-service signal. aiohttp/tornado
// are deliberately excluded: they are widely transitive (tornado ships with Jupyter)
// and would misflag notebook/data repos as backend services.
const PY_WEB_RE = /\b(flask|django|fastapi|starlette|sanic)\b/i;

// --- shell / fs helpers -----------------------------------------------------

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
// Normalize to forward slashes so profiles are stable across platforms.
const posix = (p) => p.split(path.sep).join("/");
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function readText(p) { try { return fs.readFileSync(p, "utf8"); } catch { return null; } }
function listDirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !IGNORE_DIRS.has(d.name))
      .map((d) => d.name);
  } catch { return []; }
}

// --- topology ---------------------------------------------------------------

function detectTopology(root) {
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"]) === "true";
  if (inside) {
    const top = git(root, ["rev-parse", "--show-toplevel"]) || root;
    const subProjects = subProjectDirs(top);
    // Monorepo when there are ≥2 real sub-projects, OR a workspace config declares one
    // and at least one sub-project exists. subProjects are real member paths (fixes the
    // old placeholder path that yielded zero members for declared-workspace monorepos).
    const isMono = subProjects.length > 1 || (hasWorkspaceConfig(top) && subProjects.length >= 1);
    return { topology: isMono ? "monorepo" : "single-repo", root: top, subProjects };
  }
  // not a repo → scan immediate children for independent repos
  const childRepos = listDirs(root).filter((d) => exists(path.join(root, d, ".git")));
  if (childRepos.length >= 1) return { topology: "multi-repo", root, childRepos };
  return { topology: null, root, childRepos: [] };
}

// Real sub-project directories under a repo: subdirs (depth ≤ 2) that hold a
// manifest. Paths are relative to the repo root and POSIX-normalized so profiles
// are stable across platforms. Returns actual member paths — never placeholders.
function subProjectDirs(top) {
  const manifests = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts"];
  const found = new Set();
  const walk = (dir, depth) => {
    if (depth > 2) return;
    for (const name of listDirs(dir)) {
      const sub = path.join(dir, name);
      if (manifests.some((m) => exists(path.join(sub, m)))) found.add(posix(path.relative(top, sub)));
      walk(sub, depth + 1);
    }
  };
  walk(top, 1);
  return [...found].sort();
}

// Does the repo DECLARE a workspace/monorepo (npm/yarn `workspaces`, pnpm, nx, turbo,
// lerna)? Used only as a topology signal — the member list always comes from the real
// directory walk above, so a declared monorepo enumerates its actual packages.
function hasWorkspaceConfig(top) {
  const rootPkg = readJSON(path.join(top, "package.json"));
  if (rootPkg && rootPkg.workspaces) return true;
  return ["pnpm-workspace.yaml", "nx.json", "turbo.json", "lerna.json"]
    .some((f) => exists(path.join(top, f)));
}

// --- per-member profiling ---------------------------------------------------

// .ipynb at the member root or any immediate subdirectory.
function hasNotebooks(abs) {
  if (!exists(abs)) return false;
  let top;
  try { top = fs.readdirSync(abs, { withFileTypes: true }); } catch { return false; }
  if (top.some((d) => d.isFile() && d.name.endsWith(".ipynb"))) return true;
  return top
    .filter((d) => d.isDirectory() && !IGNORE_DIRS.has(d.name))
    .some((d) => {
      try { return fs.readdirSync(path.join(abs, d.name)).some((f) => f.endsWith(".ipynb")); }
      catch { return false; }
    });
}

// Does the member contain source files (per SOURCE_EXTENSIONS)? Used only for
// kind=unknown members, where "has sources but no recognized manifest" must become
// a `decisions_needed` entry instead of silence. Deterministic: a git listing or a
// file walk, never a guess.
//   Branch 1 (git): `ls-files --cached --others --exclude-standard`. `--others
//   --exclude-standard` is load-bearing — a freshly-initialized/mid-setup repo has
//   UNTRACKED source files (they count), while gitignored junk must not count.
//   Branch 2 (not a repo / git unavailable): bounded filesystem walk, depth ≤ 4.
// Both branches apply the SAME filters — the SOURCE_EXTENSIONS allowlist, plus
// exclusion of any path with an IGNORE_DIRS or dot-directory segment (user ruling:
// e.g. CI scripts under `.github/` alone do NOT make a member "code") — so the two
// branches answer identically on the same tree, except that only git knows
// .gitignore and only the walk is depth-capped.
function hasSourceFiles(abs) {
  const isSource = (name) => SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase());
  const skipDir = (name) => IGNORE_DIRS.has(name) || name.startsWith(".");
  const listed = git(abs, ["ls-files", "--cached", "--others", "--exclude-standard"]);
  if (listed !== null) {
    return listed.split("\n").some((line) => {
      if (!line) return false;
      const segs = line.split("/"); // git emits POSIX paths
      return isSource(segs[segs.length - 1]) && !segs.slice(0, -1).some(skipDir);
    });
  }
  const walk = (dir, depth) => {
    if (depth > 4) return false;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    if (entries.some((e) => e.isFile() && isSource(e.name))) return true;
    return entries.some((e) => e.isDirectory() && !skipDir(e.name) && walk(path.join(dir, e.name), depth + 1));
  };
  return walk(abs, 1);
}

function classifyStack(abs) {
  const pkg = readJSON(path.join(abs, "package.json"));
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const keys = Object.keys(deps);
    const ts = "typescript" in deps || exists(path.join(abs, "tsconfig.json"));
    const isFront = keys.some((k) => FRONTEND_RE.test(k));
    const isBack = keys.some((k) => BACKEND_NODE_RE.test(k));
    let label = "Node";
    if (keys.some((k) => /^@nestjs\/core$/.test(k))) label = "NestJS";
    else if (deps.express) label = "Express";
    else if (deps.fastify) label = "Fastify";
    else if (deps.koa) label = "Koa";
    else if (deps.next) label = "Next.js";
    else if (deps.react) label = "React";
    else if (deps.vue) label = "Vue";
    else if (deps.svelte || deps["@sveltejs/kit"]) label = "Svelte";
    return { kind: "node", pkg, deps, label: `${label}/${ts ? "TS" : "JS"}`, isFront, isBack };
  }
  // python
  const req = readText(path.join(abs, "requirements.txt")) || "";
  const pyproj = readText(path.join(abs, "pyproject.toml")) || "";
  const notebooks = hasNotebooks(abs);
  if (req || pyproj || notebooks) {
    const blob = req + "\n" + pyproj;
    const isWeb = PY_WEB_RE.test(blob);
    const isML = /catboost|sklearn|scikit-learn|pandas|numpy|torch|tensorflow|xgboost|jupyter/i.test(blob);
    return { kind: "python", label: "Python", isFront: false, isBack: isWeb,
      isResearch: !isWeb && (notebooks || isML) };
  }
  if (exists(path.join(abs, "go.mod"))) return { kind: "go", label: "Go", isFront: false, isBack: true };
  // Rust / Java — presence-only detection, no `pkg`, so gates derive to all-null.
  // Gates come only from manifest-declared command strings; `cargo test`/`mvn test`
  // are toolchain conventions, not manifest facts (wrappers like ./mvnw make them
  // wrong), so rust/java gates stay null and the missing-gate decisions ask the user.
  if (exists(path.join(abs, "Cargo.toml"))) return { kind: "rust", label: "Rust", isFront: false, isBack: false };
  // pom.xml wins over gradle: Maven-primary repos commonly carry stray gradle files.
  if (exists(path.join(abs, "pom.xml"))) return { kind: "java", label: "Java (Maven)", isFront: false, isBack: false };
  if (exists(path.join(abs, "build.gradle")) || exists(path.join(abs, "build.gradle.kts")))
    return { kind: "java", label: "Java (Gradle)", isFront: false, isBack: false };
  // infra-only?
  const composeFiles = exists(abs)
    ? fs.readdirSync(abs).filter((f) => /^docker-compose.*\.ya?ml$/.test(f))
    : [];
  if (composeFiles.length && !exists(path.join(abs, "package.json"))) {
    return { kind: "infra", label: "infra (docker-compose)", isFront: false, isBack: false, isInfra: true };
  }
  return { kind: "unknown", label: "unknown", isFront: false, isBack: false };
}

// Exact gate command strings from package.json scripts (never fabricated).
function extractGates(s, notes) {
  if (!s) return { convention: null, lint: null, test: null, build: null };
  const gates = {
    convention: s.format ?? null,
    lint: s.lint ?? null,
    test: s.test ?? null,
    build: s.build ?? null,
  };
  if (gates.build == null) {
    const fallbackKey = Object.keys(s)
      .filter((k) => /^build(:|$)/.test(k) && !/docker/i.test(k))
      .sort((a, b) => (a === "build:local" ? -1 : b === "build:local" ? 1 : a.localeCompare(b)))[0];
    if (fallbackKey) { gates.build = s[fallbackKey]; notes.push(`build gate taken from "${fallbackKey}" script`); }
  }
  if (s["test:e2e"]) notes.push(`has test:e2e = ${s["test:e2e"]}`);
  return gates;
}

// Resolve the fixed knowledge-link slots for a member (path relative to the
// workspace root, matching member.path). A slot is the path if the artifact
// exists on disk, else null. `rubrics` has no standard member location, so it
// stays null here and is filled via overrides/extra when a user has one.
function knowledgeLinks(abs, rel) {
  const base = rel === "." ? "" : rel;
  const link = (sub) => (exists(path.join(abs, sub)) ? posix(path.join(base, sub)) : null);
  return {
    claude_md: link("CLAUDE.md"),
    skills: link(".claude/skills"),
    rubrics: null,
    extra: {},
  };
}

function profileMember(root, rel, topology) {
  const abs = path.join(root, rel === "." ? "" : rel);
  const notes = [];
  const isGit = exists(path.join(abs, ".git")) || git(abs, ["rev-parse", "--is-inside-work-tree"]) === "true";
  const branch = isGit
    ? (git(abs, ["symbolic-ref", "--short", "HEAD"]) || git(abs, ["rev-parse", "--abbrev-ref", "HEAD"]))
    : null;
  const stack = classifyStack(abs);
  const claudeMd = exists(path.join(abs, "CLAUDE.md"));
  const gates = extractGates(stack.pkg && stack.pkg.scripts, notes);
  // A "code" member is one an engineering specialist would implement in (it has a
  // recognized language stack). infra-only / unknown members are still included and
  // fully usable. An unknown member WITH source files is a code-ambiguity: it gets
  // the stack-unrecognized + CLAUDE.md decisions (never gate decisions — a gate
  // command can't be sanity-checked before the stack is labeled); infra-only and
  // truly source-less members stay silent. No member is ever classified into an
  // owning agent: the architect picks each task's engineer from the task's nature
  // + this stack.
  const isCode = ["node", "python", "go", "rust", "java"].includes(stack.kind);
  // Only unknown members pay the source-scan cost; infra/code kinds never trigger it.
  const hasSources = stack.kind === "unknown" ? hasSourceFiles(abs) : false;

  if (branch && !DEFAULT_BRANCHES.has(branch))
    notes.push(`on branch "${branch}" (not a long-lived default) — re-verify diff baseline per run`);
  if (!claudeMd && (isCode || hasSources))
    notes.push("no CLAUDE.md — specialists operate with reduced project context");
  if (gates.lint == null && gates.convention == null && isCode)
    notes.push("no lint/format script — runs test+build gates only");

  const reportsDir = topology === "multi-repo"
    ? path.join(rel, ".claude/reports") + "/"
    : ".claude/reports/";

  const member = {
    id: rel === "." ? path.basename(root) : path.basename(rel),
    path: rel,
    git: !!isGit,
    default_branch: branch,
    stack: stack.label,
    claude_md: claudeMd ? "present" : "absent",
    reports_dir: reportsDir,
    gates,
    knowledge: knowledgeLinks(abs, rel),
    notes,
  };
  return { member, claudeMd, isCode, hasSources };
}

// --- decisions --------------------------------------------------------------

function decisionsFor(member, claudeMd, isCode, hasSources) {
  const out = [];
  // Stack question first: it is the root ambiguity (push order = display order).
  // The answer is recorded as a durable `stack` override (overrides.mjs set).
  if (hasSources) {
    out.push({
      member: member.id,
      question: `${member.id} has source files but no recognized manifest — what is this member's stack?`,
      recommended: "provide a stack label (recorded as a stack override)",
      options: ["<provide stack label>", "leave as unknown"],
    });
  }
  if (!claudeMd && (isCode || hasSources)) {
    out.push({
      member: member.id,
      question: `${member.id} has no CLAUDE.md — how should specialists bind to it?`,
      recommended: "proceed with reduced context",
      options: ["generate minimal CLAUDE.md", "proceed with reduced context"],
    });
  }
  // Gate decisions stay isCode-only (deliberately NOT raised for unknown-with-
  // sources members — fixed plan-level exclusion).
  for (const k of ["test", "build"]) {
    if (member.gates[k] == null && isCode) {
      out.push({
        member: member.id,
        question: `${member.id} has no detectable ${k} gate — confirm "none" or provide a command?`,
        recommended: "none",
        options: ["none", "<provide command>"],
      });
    }
  }
  return out;
}

// --- main -------------------------------------------------------------------

function detect(rootArg) {
  const root = path.resolve(rootArg || process.cwd());
  const topo = detectTopology(root);
  if (!topo.topology) {
    return { blocked: true, message: `No git repository in ${root} and no child repos — nothing to orchestrate. Where does the code live?` };
  }

  let relPaths;
  if (topo.topology === "single-repo") relPaths = ["."];
  else if (topo.topology === "multi-repo") relPaths = topo.childRepos.sort();
  else relPaths = [...topo.subProjects].sort(); // monorepo — real member paths

  const members = [];
  const decisions = [];
  for (const rel of relPaths) {
    const { member, claudeMd, isCode, hasSources } = profileMember(topo.root, rel, topo.topology);
    members.push(member);
    decisions.push(...decisionsFor(member, claudeMd, isCode, hasSources));
  }

  return {
    schema: WORKSPACE_SCHEMA,
    plugin_version: pluginVersion(),
    generated: new Date().toISOString(),
    topology: topo.topology,
    workspace_root: topo.root,
    members,
    decisions_needed: decisions,
    defaults: { architect: "default-on", parallelism: "opt-in", human_gate: "per-task" },
  };
}

// CLI entry
// fileURLToPath (not URL.pathname) — the latter yields "/E:/..." on Windows,
// which path.resolve turns into "E:\E:\...", making this guard always false.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = detect(process.argv[2]);
  if (result.blocked) {
    process.stderr.write(result.message + "\n");
    process.exit(2);
  }
  // Validate facts portion (decisions_needed is allowed pre-finalize).
  const check = validateWorkspace({ ...result, decisions_needed: undefined });
  if (!check.valid) {
    process.stderr.write("detect.mjs produced an invalid workspace shape:\n" + check.errors.join("\n") + "\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

export { detect, detectTopology, classifyStack, extractGates, knowledgeLinks, hasSourceFiles };
