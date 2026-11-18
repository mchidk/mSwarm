#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits, modify } from "jsonc-parser";

/**
 * CLI for adding/removing opencode-mswarm in OpenCode 2.x configuration.
 *
 * Author: Michael Christensen
 */

const PLUGIN_NAME = "opencode-mswarm";
const SWARM_AGENT_ID = "swarm";
const SWARM_AGENT_DESCRIPTION =
  "mSwarm coordinator: delegates work to parallel worker sessions with a shared board and isolated worktrees";
const SWARM_AGENT_COLOR = "#8b5cf6";

type Scope = "project" | "global";
type PluginEntry = string | { package: string; options?: Record<string, unknown> };

interface OpenCodeConfig {
  /** OpenCode 2.x key. */
  plugins?: PluginEntry[];
  /** Legacy OpenCode 1.x key, migrated on install. */
  plugin?: PluginEntry[];
  /** Primary agents; the "swarm" entry is selectable with Shift+Tab. */
  agents?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

function getGlobalConfigPath(): string {
  const configRoot = process.env.XDG_CONFIG_HOME
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), ".config");
  const dir = path.join(configRoot, "opencode");
  const jsoncPath = path.join(dir, "opencode.jsonc");
  if (fs.existsSync(jsoncPath)) {
    return jsoncPath;
  }
  const jsonPath = path.join(dir, "opencode.json");
  if (fs.existsSync(jsonPath)) {
    return jsonPath;
  }
  return path.join(dir, "opencode.json");
}

function getPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function getOptionValue(args: string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === name) {
      const next = args[index + 1];
      return next && !next.startsWith("-") ? next : "";
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

function resolveLocalTarget(
  args: string[],
  cwd: string,
): string | undefined {
  const value = getOptionValue(args, "--local");
  if (value === undefined) {
    return undefined;
  }
  return path.resolve(cwd, value.trim() || getPackageRoot());
}

function configCandidates(dir: string): string[] {
  return [
    path.join(dir, "opencode.jsonc"),
    path.join(dir, "opencode.json"),
    path.join(dir, ".opencode", "opencode.jsonc"),
    path.join(dir, ".opencode", "opencode.json"),
  ];
}

function findProjectRoot(cwd: string): string | undefined {
  let dir = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function getProjectConfigPath(cwd: string): string {
  let dir = path.resolve(cwd);
  while (true) {
    for (const candidate of configCandidates(dir)) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  const root = findProjectRoot(cwd);
  return path.join(root ?? cwd, "opencode.json");
}

function detectDefaultScope(cwd: string): Scope {
  if (findProjectRoot(cwd)) {
    return "project";
  }
  let dir = path.resolve(cwd);
  while (true) {
    if (configCandidates(dir).some((candidate) => fs.existsSync(candidate))) {
      return "project";
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return "global";
}

function stripJsonCommentsAndTrailingCommas(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") {
        i++;
      }
      if (i < raw.length && raw[i] === "\n") {
        out += "\n";
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) {
        i++;
      }
      i++;
      continue;
    }

    out += ch;
  }

  // Remove trailing commas before `}` or `]` outside of string literals.
  let cleaned = "";
  inString = false;
  escaped = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (inString) {
      cleaned += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      cleaned += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j]!)) {
        j++;
      }
      if (out[j] === "}" || out[j] === "]") {
        continue;
      }
    }
    cleaned += ch;
  }

  return cleaned;
}

interface ConfigDocument {
  config: OpenCodeConfig;
  text: string;
}

function readConfigDocument(filePath: string): ConfigDocument {
  if (!fs.existsSync(filePath)) {
    return { config: {}, text: "" };
  }
  const text = fs.readFileSync(filePath, "utf8");
  const raw = text.trim();
  if (!raw) {
    return { config: {}, text };
  }
  try {
    return { config: JSON.parse(raw) as OpenCodeConfig, text };
  } catch {
    const stripped = stripJsonCommentsAndTrailingCommas(raw);
    return { config: JSON.parse(stripped) as OpenCodeConfig, text };
  }
}

function readConfig(filePath: string): OpenCodeConfig {
  return readConfigDocument(filePath).config;
}

interface WriteOptions {
  agents?: "update" | "remove" | "preserve";
}

/**
 * Writes the managed top-level keys back into the existing document, preserving
 * comments, key order, and unrelated settings in JSONC files.
 */
function writeConfig(
  filePath: string,
  config: OpenCodeConfig,
  originalText?: string,
  options: WriteOptions = {},
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (!originalText || originalText.trim().length === 0) {
    fs.writeFileSync(
      filePath,
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8",
    );
    return;
  }

  const eol = originalText.includes("\r\n") ? "\r\n" : "\n";
  const formattingOptions = {
    formattingOptions: {
      tabSize: 2,
      insertSpaces: true,
      eol,
    },
  };

  let updated = originalText;
  updated = applyEdits(
    updated,
    modify(updated, ["plugins"], config.plugins, formattingOptions),
  );

  if (config.plugin === undefined) {
    updated = applyEdits(
      updated,
      modify(updated, ["plugin"], undefined, formattingOptions),
    );
  } else {
    updated = applyEdits(
      updated,
      modify(updated, ["plugin"], config.plugin, formattingOptions),
    );
  }

  const agentsMode = options.agents ?? "preserve";
  if (agentsMode === "update") {
    const swarmAgent = config.agents?.[SWARM_AGENT_ID];
    updated = applyEdits(
      updated,
      modify(
        updated,
        ["agents", SWARM_AGENT_ID],
        swarmAgent,
        formattingOptions,
      ),
    );
  } else if (agentsMode === "remove") {
    updated = applyEdits(
      updated,
      modify(
        updated,
        ["agents", SWARM_AGENT_ID],
        undefined,
        formattingOptions,
      ),
    );
    if (!config.agents || Object.keys(config.agents).length === 0) {
      updated = applyEdits(
        updated,
        modify(updated, ["agents"], undefined, formattingOptions),
      );
    }
  }

  fs.writeFileSync(
    filePath,
    updated.endsWith("\n") ? updated : `${updated}${eol}`,
    "utf8",
  );
}

function entryName(entry: PluginEntry): string | undefined {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry && typeof entry.package === "string") {
    return entry.package;
  }
  return undefined;
}

function isPluginName(name: string | undefined): boolean {
  return name === PLUGIN_NAME || Boolean(name?.startsWith(`${PLUGIN_NAME}@`));
}

function entryMatches(entry: PluginEntry, target: string): boolean {
  const name = entryName(entry);
  if (!name) {
    return false;
  }
  if (target === PLUGIN_NAME) {
    return isPluginName(name);
  }
  return path.resolve(name) === path.resolve(target);
}

function hasPluginEntry(
  config: OpenCodeConfig,
  target: string = PLUGIN_NAME,
): boolean {
  return (
    (Array.isArray(config.plugins) &&
      config.plugins.some((entry) => entryMatches(entry, target))) ||
    (Array.isArray(config.plugin) &&
      config.plugin.some((entry) => entryMatches(entry, target)))
  );
}

function removePluginEntries(
  config: OpenCodeConfig,
  target: string,
): boolean {
  let changed = false;
  if (Array.isArray(config.plugins)) {
    const next = config.plugins.filter((entry) => !entryMatches(entry, target));
    if (next.length !== config.plugins.length) {
      config.plugins = next;
      changed = true;
    }
  }
  if (Array.isArray(config.plugin)) {
    const next = config.plugin.filter((entry) => !entryMatches(entry, target));
    if (next.length !== config.plugin.length) {
      config.plugin = next;
      changed = true;
    }
  }
  return changed;
}

function getSwarmAgent(config: OpenCodeConfig): Record<string, unknown> | undefined {
  const agent = config.agents?.[SWARM_AGENT_ID];
  return agent && typeof agent === "object" && !Array.isArray(agent)
    ? agent
    : undefined;
}

function hasSwarmAgent(config: OpenCodeConfig): boolean {
  return Boolean(getSwarmAgent(config));
}

type PermissionRule = { action: string; resource: string; effect: string };

/**
 * Permissions for the coordinator agent. It delegates through mSwarm workers
 * rather than the built-in subagent tool, and it never edits files itself:
 * the same `edit` deny OpenCode's own Plan agent uses. Bash stays available
 * for `git merge`/`cherry-pick` and acceptance checks.
 */
const SWARM_AGENT_PERMISSIONS: PermissionRule[] = [
  { action: "subagent", resource: "*", effect: "deny" },
  { action: "edit", resource: "*", effect: "deny" },
];

function isPermissionRule(value: unknown): value is PermissionRule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PermissionRule).action === "string" &&
    typeof (value as PermissionRule).resource === "string"
  );
}

/**
 * Adds the selectable "Swarm" primary agent, or upgrades an entry this
 * installer wrote earlier with any missing default permissions. Entries a
 * user customized (different description) are never touched.
 */
function ensureSwarmAgent(config: OpenCodeConfig): boolean {
  if (
    !config.agents ||
    typeof config.agents !== "object" ||
    Array.isArray(config.agents)
  ) {
    config.agents = {};
  }
  const existing = getSwarmAgent(config);
  if (existing) {
    if (existing.description !== SWARM_AGENT_DESCRIPTION) {
      return false;
    }
    const current = Array.isArray(existing.permissions)
      ? existing.permissions
      : [];
    const missing = SWARM_AGENT_PERMISSIONS.filter(
      (rule) =>
        !current.some(
          (candidate) =>
            isPermissionRule(candidate) &&
            candidate.action === rule.action &&
            candidate.resource === rule.resource,
        ),
    );
    if (missing.length === 0) {
      return false;
    }
    existing.permissions = [...current, ...missing.map((rule) => ({ ...rule }))];
    return true;
  }
  if (config.agents[SWARM_AGENT_ID]) {
    return false;
  }
  config.agents[SWARM_AGENT_ID] = {
    description: SWARM_AGENT_DESCRIPTION,
    mode: "primary",
    color: SWARM_AGENT_COLOR,
    permissions: SWARM_AGENT_PERMISSIONS.map((rule) => ({ ...rule })),
  };
  return true;
}

function removeSwarmAgent(config: OpenCodeConfig): boolean {
  const agent = getSwarmAgent(config);
  if (!agent || agent.description !== SWARM_AGENT_DESCRIPTION) {
    return false;
  }
  delete config.agents![SWARM_AGENT_ID];
  if (Object.keys(config.agents!).length === 0) {
    delete config.agents;
  }
  return true;
}

/**
 * Normalizes a legacy `plugin` array into the OpenCode 2.x `plugins` array.
 * Returns true when the config changed.
 */
function normalizeConfig(config: OpenCodeConfig): boolean {
  let changed = false;
  if (!Array.isArray(config.plugins)) {
    config.plugins = [];
    changed = true;
  }
  if (Array.isArray(config.plugin) && config.plugin.length > 0) {
    for (const entry of config.plugin) {
      if (!config.plugins.some((candidate) => entryName(candidate) === entryName(entry))) {
        config.plugins.push(entry);
      }
    }
    delete config.plugin;
    changed = true;
  }
  return changed;
}

function resolveScope(args: string[], cwd: string): Scope {
  if (args.includes("--global")) {
    return "global";
  }
  if (args.includes("--project")) {
    return "project";
  }
  return detectDefaultScope(cwd);
}

function getTargetPath(scope: Scope, cwd: string): string {
  return scope === "global" ? getGlobalConfigPath() : getProjectConfigPath(cwd);
}

function cmdInstall(args: string[], cwd: string): number {
  const scope = resolveScope(args, cwd);
  const configPath = getTargetPath(scope, cwd);

  let document: ConfigDocument;
  try {
    document = readConfigDocument(configPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to parse ${configPath}: ${message}`);
    return 1;
  }
  const config = document.config;

  const normalized = normalizeConfig(config);
  const hadAgent = hasSwarmAgent(config);
  const agentAdded = ensureSwarmAgent(config);
  const localTarget = resolveLocalTarget(args, cwd);
  const targetEntry = localTarget ?? PLUGIN_NAME;

  // A local install is a switch: remove a published-package entry so the
  // checkout is the single source of truth.
  let switched = false;
  if (localTarget) {
    switched = removePluginEntries(config, PLUGIN_NAME);
  } else {
    // Switching back from a checkout to the published package.
    switched = removePluginEntries(config, getPackageRoot());
  }

  const alreadyInstalled = hasPluginEntry(config, targetEntry);
  if (!alreadyInstalled) {
    config.plugins!.push(targetEntry);
  }

  if (!alreadyInstalled || switched || normalized || agentAdded) {
    writeConfig(configPath, config, document.text, {
      agents: agentAdded ? "update" : "preserve",
    });
  }

  if (alreadyInstalled && !switched) {
    console.log(`${targetEntry} is already configured in ${configPath}.`);
  } else if (localTarget) {
    console.log(`Added local plugin "${targetEntry}" to ${configPath}.`);
  } else {
    console.log(`Added "${targetEntry}" to ${configPath}.`);
  }
  if (agentAdded) {
    console.log(
      hadAgent
        ? `Updated the "swarm" agent's default permissions (no subagents, no direct file edits).`
        : `Added the "swarm" primary agent (select it with Shift+Tab).`,
    );
  }

  console.log("");
  console.log("Next steps:");
  console.log("  1. Start OpenCode 2.x in your project.");
  console.log("  2. Select any model you want the swarm to use.");
  console.log("  3. Shift+Tab to Swarm mode and describe the goal,");
  console.log("     or run `/mswarm <your task>` from any mode.");
  console.log("  4. Use `/mswarm board` to inspect status or `/mswarm kill` to stop workers.");
  return 0;
}

function cmdUninstall(args: string[], cwd: string): number {
  const scope = resolveScope(args, cwd);
  const configPath = getTargetPath(scope, cwd);

  if (!fs.existsSync(configPath)) {
    console.log(`No config file found at ${configPath}. Nothing to uninstall.`);
    return 0;
  }

  let document: ConfigDocument;
  try {
    document = readConfigDocument(configPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to parse ${configPath}: ${message}`);
    return 1;
  }
  const config = document.config;

  const localTarget = resolveLocalTarget(args, cwd) ?? getPackageRoot();
  const pluginConfigured =
    hasPluginEntry(config) ||
    hasPluginEntry(config, localTarget) ||
    hasPluginEntry(config, getPackageRoot());
  const agentRemoved = removeSwarmAgent(config);
  if (!pluginConfigured && !agentRemoved) {
    console.log(`${PLUGIN_NAME} is not configured in ${configPath}.`);
    return 0;
  }

  removePluginEntries(config, PLUGIN_NAME);
  removePluginEntries(config, localTarget);
  removePluginEntries(config, getPackageRoot());
  writeConfig(configPath, config, document.text, {
    agents: agentRemoved ? "remove" : "preserve",
  });
  console.log(`Removed "${PLUGIN_NAME}" from ${configPath}.`);
  if (agentRemoved) {
    console.log('Removed the "swarm" primary agent.');
  }
  return 0;
}

function inspectConfigStatus(label: string, filePath: string): void {
  if (!fs.existsSync(filePath)) {
    console.log(`  ${label}: not found (${filePath})`);
    return;
  }
  try {
    const config = readConfig(filePath);
    const configured =
      hasPluginEntry(config) ||
      hasPluginEntry(config, getPackageRoot());
    const legacy = Array.isArray(config.plugin) && config.plugin.length > 0;
    console.log(
      `  ${label}: ${configured ? "installed" : "not installed"} (${filePath})${legacy ? " [legacy 'plugin' key]" : ""}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ${label}: invalid JSON (${filePath}: ${message})`);
  }
}

function inspectAgentStatus(label: string, filePath: string): void {
  if (!fs.existsSync(filePath)) {
    console.log(`  ${label}: not found (${filePath})`);
    return;
  }
  try {
    const config = readConfig(filePath);
    console.log(
      `  ${label}: ${hasSwarmAgent(config) ? "installed" : "not installed"} (${filePath})`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ${label}: invalid JSON (${filePath}: ${message})`);
  }
}

function cmdStatus(cwd: string): number {
  console.log(`${PLUGIN_NAME} configuration status:`);
  inspectConfigStatus("Project", getProjectConfigPath(cwd));
  inspectConfigStatus("Global ", getGlobalConfigPath());
  console.log("Swarm mode (Shift+Tab):");
  inspectAgentStatus("Project", getProjectConfigPath(cwd));
  inspectAgentStatus("Global ", getGlobalConfigPath());
  return 0;
}

function printHelp(): void {
  console.log(`Usage: opencode-mswarm <command> [options]

Commands:
  install [--project|--global]    Add "${PLUGIN_NAME}" to OpenCode 2.x plugins
  uninstall [--project|--global]  Remove "${PLUGIN_NAME}" from OpenCode 2.x plugins
  status                          Show whether "${PLUGIN_NAME}" is configured

Options:
  --project                       Target project opencode.json(c) (default in git/opencode projects)
  --global                        Target ~/.config/opencode/opencode.json(c)
  --local [path]                  Install this checkout (or the given path) instead of the npm package
  --help, -h                      Show this help message

Author: Michael Christensen`);
}

function main(): number {
  const args = process.argv.slice(2);
  const command = args.find((arg) => !arg.startsWith("-"));
  const cwd = process.cwd();

  if (args.includes("--help") || args.includes("-h") || !command) {
    printHelp();
    return 0;
  }

  switch (command) {
    case "install":
      return cmdInstall(args, cwd);
    case "uninstall":
      return cmdUninstall(args, cwd);
    case "status":
      return cmdStatus(cwd);
    default:
      console.error(`Unknown command: "${command}"`);
      printHelp();
      return 1;
  }
}

process.exitCode = main();
