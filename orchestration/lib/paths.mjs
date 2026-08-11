// Single source of truth for WHERE orchestration files live, keyed by topology.
// This is the code form of the location rules in WORKSPACE.md — importable so
// the hook, the setup flow, and runs never re-encode the convention in prose.
//
// Location pattern is uniform: <root>/.claude/orchestration/. The only variable
// is the `.local` filename suffix, used inside a repo (single-repo / monorepo)
// where the profile must be gitignored. A multi-repo parent folder is not a
// repo, so its profile needs no suffix.

import path from "node:path";
import { fileURLToPath } from "node:url";

export function orchestrationDir(root) {
  return path.join(root, ".claude", "orchestration");
}

// Learned-guidance (intelligence) entries dir at a root.
export function intelligenceDir(root) {
  return path.join(orchestrationDir(root), "intelligence");
}

// Same convention resolved for a member. For member path "." this equals
// intelligenceDir(workspaceRoot) — the single-repo collapse: workspace and
// member scope share ONE directory (the `scope` field on entries still records
// the intent).
export function memberIntelligenceDir(workspaceRoot, memberPath) {
  return intelligenceDir(path.resolve(workspaceRoot, memberPath === "." ? "" : memberPath));
}

export function profilePaths(root, topology) {
  const dir = orchestrationDir(root);
  const local = topology !== "multi-repo";
  const stem = local ? "workspace.local" : "workspace";
  return {
    dir,
    local,
    profile: path.join(dir, `${stem}.json`),   // machine source of truth
    rendered: path.join(dir, `${stem}.md`),     // human-readable rendered view
    draft: path.join(dir, `${stem}.json.draft`),// interrupted-setup checkpoint
    overrides: path.join(dir, "overrides.local.json"), // durable user overrides (Phase B)
    intelligence: intelligenceDir(root),        // learned-guidance entries dir
  };
}

// CLI: resolve the orchestration file locations for a root + topology so the
// command and agent read the convention from code, never re-derive it in prose.
//   node paths.mjs <root> <single-repo|monorepo|multi-repo>
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [root, topology] = process.argv.slice(2);
  if (!root || !topology) {
    process.stderr.write("usage: paths.mjs <root> <single-repo|monorepo|multi-repo>\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(profilePaths(path.resolve(root), topology), null, 2) + "\n");
}
