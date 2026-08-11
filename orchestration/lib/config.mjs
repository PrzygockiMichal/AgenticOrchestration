#!/usr/bin/env node
// Plugin config — the three workspace-behavior switches (all boolean, default ON):
//   readiness_check          — the onboarding nudge when the workspace is UNconfigured
//   proactive_orchestration  — when the workspace IS configured, prime the main session
//                              to route code work through /orchestrate (off = on demand only)
//   intelligence             — capture learned behavioral guidance from user corrections
//                              and inject it into dispatch briefs (off = feature fully inert)
// Setting 1 (plugin on/off everywhere) is Claude Code's built-in `enabledPlugins`
// and is deliberately NOT modelled here.
//
// Cascade (later layer wins), by key:
//   CONFIG_DEFAULTS  <  global  <  per-workspace override
//     global:    ~/.claude/orchestration/config.json
//     workspace: <root>/.claude/orchestration/config.local.json
//
// A malformed config file never crashes anything: it is ignored (with a note)
// and the cascade falls back to the lower layer / defaults. That keeps the
// SessionStart hook which reads this defensive by construction — worst case it
// falls back to the ON default.
//
// Settings are read once per session (at SessionStart). A change made here
// mid-session does NOT apply live — the user must start a new session.
//
// Verbs:
//   node config.mjs show [workspace-root]
//   node config.mjs get  <key> [workspace-root]
//   node config.mjs set  <global|workspace> <key> <value> [workspace-root]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_SCHEMA, CONFIG_KEYS, CONFIG_DEFAULTS, validateConfig } from "./schema.mjs";

function die(msg, code = 1) { process.stderr.write(msg + "\n"); process.exit(code); }

export function globalConfigPath() {
  return path.join(os.homedir(), ".claude", "orchestration", "config.json");
}
export function workspaceConfigPath(root) {
  return path.join(root || process.cwd(), ".claude", "orchestration", "config.local.json");
}

function readMaybe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return undefined; }
}

// Merge a partial layer over an accumulator, for known keys that validate.
function mergeLayer(acc, layer, label, notes) {
  if (layer === undefined) return acc;
  const { valid, errors } = validateConfig(layer, { partial: true });
  if (!valid) { notes.push(`ignored ${label} config: ${errors.join("; ")}`); return acc; }
  const out = { ...acc };
  for (const k of CONFIG_KEYS) if (layer[k] !== undefined) out[k] = layer[k];
  return out;
}

// Effective config = defaults < global < workspace override. Never throws.
export function readEffectiveConfig(root) {
  const notes = [];
  let config = { ...CONFIG_DEFAULTS };
  config = mergeLayer(config, readMaybe(globalConfigPath()), "global", notes);
  config = mergeLayer(config, readMaybe(workspaceConfigPath(root)), "workspace", notes);
  return { config, notes };
}

// Fail-open helpers for the hook: any trouble → treat the switch as ON (default).
export function readinessCheckEnabled(root) {
  try { return readEffectiveConfig(root).config.readiness_check !== false; }
  catch { return true; }
}
export function proactiveOrchestrationEnabled(root) {
  try { return readEffectiveConfig(root).config.proactive_orchestration !== false; }
  catch { return true; }
}

// --- write ------------------------------------------------------------------

function coerce(key, raw) {
  // Every config key is a boolean (see CONFIG_KEYS). cmdSet validates the key first.
  if (raw === "true" || raw === "on") return true;
  if (raw === "false" || raw === "off") return false;
  die(`${key} expects true|false (or on|off), got "${raw}"`);
}

function cmdSet(scope, key, rawval, root) {
  if (scope !== "global" && scope !== "workspace") die(`scope must be "global" or "workspace", got "${scope}"`);
  if (!CONFIG_KEYS.includes(key)) die(`unknown config key "${key}" (known: ${CONFIG_KEYS.join(", ")})`);
  const p = scope === "global" ? globalConfigPath() : workspaceConfigPath(root);
  const obj = readMaybe(p) || {};
  obj.schema = CONFIG_SCHEMA;
  obj[key] = coerce(key, rawval);
  const { valid, errors } = validateConfig(obj, { partial: true });
  if (!valid) die("refusing to write invalid config:\n  " + errors.join("\n  "));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  process.stdout.write(`set ${key}=${obj[key]} in ${scope} config (${p})\n`);
}

function cmdShow(root) {
  const { config, notes } = readEffectiveConfig(root);
  const g = globalConfigPath();
  const w = workspaceConfigPath(root);
  process.stdout.write("Effective config (defaults < global < workspace):\n");
  for (const k of CONFIG_KEYS) process.stdout.write(`  ${k} = ${config[k]}\n`);
  process.stdout.write(`\nglobal:    ${g} ${readMaybe(g) ? "" : "(none)"}\n`);
  process.stdout.write(`workspace: ${w} ${readMaybe(w) ? "" : "(none)"}\n`);
  for (const n of notes) process.stdout.write(`NOTE: ${n}\n`);
}

// --- CLI --------------------------------------------------------------------

// fileURLToPath (not URL.pathname): the latter yields "/E:/..." on Windows.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [verb, ...rest] = process.argv.slice(2);
  switch (verb) {
    case "show": cmdShow(rest[0]); break;
    case "get": {
      if (!rest[0]) die("usage: config.mjs get <key> [workspace-root]");
      if (!CONFIG_KEYS.includes(rest[0])) die(`unknown config key "${rest[0]}" (known: ${CONFIG_KEYS.join(", ")})`);
      const { config } = readEffectiveConfig(rest[1]);
      process.stdout.write(String(config[rest[0]]) + "\n");
      break;
    }
    case "set":
      if (rest.length < 3) die("usage: config.mjs set <global|workspace> <key> <value> [workspace-root]");
      cmdSet(rest[0], rest[1], rest[2], rest[3]);
      break;
    default: die("usage: config.mjs <show|get|set> ...");
  }
}
