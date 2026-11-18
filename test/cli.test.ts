import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_URL = pathToFileURL(
  path.join(REPO_ROOT, "test", "ts-resolve-hook.mjs"),
).href;
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.ts");

function runCli(args: string[], cwd: string): string {
  return execFileSync(
    process.execPath,
    ["--import", HOOK_URL, CLI_PATH, ...args],
    {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    },
  );
}

describe("opencode-mswarm CLI", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mswarm-cli-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prints help", () => {
    const out = runCli(["--help"], tmpDir);
    assert.match(out, /Usage: opencode-mswarm/);
    assert.match(out, /Michael Christensen/);
  });

  it("installs, reports status, and uninstalls in project opencode.json", () => {
    const installOut = runCli(["install", "--project"], tmpDir);
    assert.match(installOut, /Added "opencode-mswarm"/);

    const cfgPath = path.join(tmpDir, "opencode.json");
    const config = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
      plugins: string[];
      agents: Record<
        string,
        {
          mode?: string;
          description?: string;
          permissions?: Array<{
            action: string;
            resource?: string;
            effect: string;
          }>;
        }
      >;
    };
    assert.deepEqual(config.plugins, ["opencode-mswarm"]);
    assert.equal(config.agents.swarm?.mode, "primary");
    assert.match(config.agents.swarm?.description ?? "", /mSwarm coordinator/);
    assert.deepEqual(config.agents.swarm?.permissions, [
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
    ]);

    const statusOut = runCli(["status"], tmpDir);
    assert.match(statusOut, /Project: installed/);
    assert.match(statusOut, /Swarm mode \(Shift\+Tab\):/);

    const uninstallOut = runCli(["uninstall", "--project"], tmpDir);
    assert.match(uninstallOut, /Removed "opencode-mswarm"/);
    assert.match(uninstallOut, /Removed the "swarm" primary agent/);

    const after = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
      plugins: string[];
      agents?: Record<string, unknown>;
    };
    assert.deepEqual(after.plugins, []);
    assert.equal(after.agents, undefined);
  });

  it("supports an existing opencode.jsonc with comments and trailing commas", () => {
    const jsoncPath = path.join(tmpDir, "opencode.jsonc");
    fs.writeFileSync(
      jsoncPath,
      `{\n  // existing comment\n  "plugins": ["other-plugin",], // inline comment\n}\n`,
      "utf8",
    );

    const installOut = runCli(["install", "--project"], tmpDir);
    assert.match(installOut, /Added "opencode-mswarm"/);

    const raw = fs.readFileSync(jsoncPath, "utf8");
    assert.match(raw, /\/\/ existing comment/);
    assert.match(raw, /\/\/ inline comment/);
    const parsed = parseJsonc(raw) as {
      plugins: string[];
      agents?: Record<string, { mode?: string }>;
    };
    assert.deepEqual(parsed.plugins, ["other-plugin", "opencode-mswarm"]);
    assert.equal(parsed.agents?.swarm?.mode, "primary");

    const uninstallOut = runCli(["uninstall", "--project"], tmpDir);
    assert.match(uninstallOut, /Removed "opencode-mswarm"/);
    const after = fs.readFileSync(jsoncPath, "utf8");
    assert.match(after, /\/\/ existing comment/);
    assert.match(after, /\/\/ inline comment/);
  });

  it("installs and uninstalls a local checkout with --local", () => {
    const installOut = runCli(["install", "--project", "--local"], tmpDir);
    assert.match(installOut, /Added local plugin/);

    const cfgPath = path.join(tmpDir, "opencode.json");
    const config = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
      plugins: string[];
      agents?: Record<string, unknown>;
    };
    assert.deepEqual(config.plugins, [path.resolve(REPO_ROOT)]);
    assert.ok(config.agents?.swarm);

    const statusOut = runCli(["status"], tmpDir);
    assert.match(statusOut, /Project: installed/);

    const uninstallOut = runCli([
      "uninstall",
      "--project",
      "--local",
    ], tmpDir);
    assert.match(uninstallOut, /Removed "opencode-mswarm"/);
    const after = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
      plugins: string[];
    };
    assert.deepEqual(after.plugins, []);
  });

  it("finds the project config from a nested directory", () => {
    const projectConfig = path.join(tmpDir, "opencode.json");
    fs.writeFileSync(projectConfig, JSON.stringify({}, null, 2), "utf8");
    const nested = path.join(tmpDir, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });

    const installOut = runCli(["install"], nested);
    assert.match(installOut, /Added "opencode-mswarm"/);
    const parsed = JSON.parse(fs.readFileSync(projectConfig, "utf8")) as {
      plugins: string[];
      agents?: Record<string, unknown>;
    };
    assert.deepEqual(parsed.plugins, ["opencode-mswarm"]);
    assert.ok(parsed.agents?.swarm);
    assert.equal(fs.existsSync(path.join(nested, "opencode.json")), false);
  });

  it("recognizes versioned plugin entries without duplicating them", () => {
    const cfgPath = path.join(tmpDir, "opencode.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ plugins: ["opencode-mswarm@1.2.3"] }, null, 2),
      "utf8",
    );

    const installOut = runCli(["install", "--project"], tmpDir);
    assert.match(installOut, /already configured/);
    const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
      plugins: string[];
    };
    assert.deepEqual(parsed.plugins, ["opencode-mswarm@1.2.3"]);

    const statusOut = runCli(["status"], tmpDir);
    assert.match(statusOut, /Project: installed/);
  });

  it("migrates a legacy plugin array to plugins on install", () => {
    const cfgPath = path.join(tmpDir, "opencode.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ plugin: ["other-plugin"] }, null, 2),
      "utf8",
    );

    const installOut = runCli(["install", "--project"], tmpDir);
    assert.match(installOut, /Added "opencode-mswarm"/);

    const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
      plugins: string[];
      plugin?: string[];
    };
    assert.deepEqual(parsed.plugins, ["other-plugin", "opencode-mswarm"]);
    assert.equal(parsed.plugin, undefined);
  });
  it("upgrades an earlier mSwarm agent entry but never a customized one", () => {
    const description =
      "mSwarm coordinator: delegates work to parallel worker sessions with a shared board and isolated worktrees";
    const cfgPath = path.join(tmpDir, "opencode.json");
    const write = (agent: Record<string, unknown>) =>
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({ plugins: ["opencode-mswarm"], agents: { swarm: agent } }, null, 2),
        "utf8",
      );
    const read = () =>
      (JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
        agents: { swarm: { permissions?: unknown[] } };
      }).agents.swarm.permissions;

    write({
      description,
      mode: "primary",
      permissions: [{ action: "subagent", resource: "*", effect: "deny" }],
    });
    const out = runCli(["install", "--project"], tmpDir);
    assert.match(out, /Updated the "swarm" agent's default permissions/);
    assert.deepEqual(read(), [
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
    ]);

    // Idempotent: a second install changes nothing.
    assert.doesNotMatch(runCli(["install", "--project"], tmpDir), /Updated the "swarm"/);

    write({ description: "my own coordinator", mode: "primary", permissions: [] });
    runCli(["install", "--project"], tmpDir);
    assert.deepEqual(read(), [], "a customized agent is left alone");
  });
});
