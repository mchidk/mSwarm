import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { WorkspaceManager } from "../src/workspace.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

describe("WorkspaceManager", () => {
  let tmpDir: string;
  let manager: WorkspaceManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mswarm-ws-"));
    manager = new WorkspaceManager();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns rootDir for inherit mode", async () => {
    const res = await manager.prepareWorkspace(tmpDir, "swarm-1", "w1", "inherit");
    assert.equal(res.workspacePath, tmpDir);
    assert.equal(res.branchName, undefined);
    assert.equal(res.warning, undefined);
  });

  it("falls back to rootDir with a warning when directory is not a git repo", async () => {
    const res = await manager.prepareWorkspace(tmpDir, "swarm-1", "w1", "share");
    assert.equal(res.workspacePath, tmpDir);
    assert.match(res.warning ?? "", /not a git repository/);
  });

  it("creates and cleans up share and branch git worktrees", async () => {
    git(tmpDir, ["init"]);
    git(tmpDir, ["config", "user.email", "test@example.com"]);
    git(tmpDir, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# test\n", "utf8");
    git(tmpDir, ["add", "README.md"]);
    git(tmpDir, ["commit", "-m", "initial"]);

    const share = await manager.prepareWorkspace(tmpDir, "sw1", "sharer", "share");
    assert.notEqual(share.workspacePath, tmpDir);
    assert.equal(share.branchName, undefined);
    assert.ok(fs.existsSync(path.join(share.workspacePath, "README.md")));

    await manager.cleanupWorkspace(tmpDir, share.workspacePath, share.branchName);
    assert.equal(fs.existsSync(share.workspacePath), false);
    assert.equal(
      fs.existsSync(
        path.join(tmpDir, ".opencode", "mswarm", "worktrees", "sw1"),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(tmpDir, ".opencode", "mswarm", "worktrees")),
      false,
      "empty worktrees root should be pruned",
    );

    const branch = await manager.prepareWorkspace(tmpDir, "sw1", "brancher", "branch");
    assert.notEqual(branch.workspacePath, tmpDir);
    assert.equal(branch.branchName, "mswarm/sw1/brancher");
    assert.ok(fs.existsSync(path.join(branch.workspacePath, "README.md")));

    await manager.cleanupWorkspace(tmpDir, branch.workspacePath, branch.branchName);
    assert.equal(fs.existsSync(branch.workspacePath), false);
    const preserved = git(tmpDir, ["branch", "--list", "mswarm/sw1/brancher"]).trim();
    assert.notEqual(preserved, "", "a completed branch must survive worktree cleanup");

    const reused = await manager.prepareWorkspace(
      tmpDir,
      "sw1",
      "brancher",
      "branch",
    );
    assert.equal(reused.branchName, "mswarm/sw1/brancher-2");
    await manager.cleanupWorkspace(tmpDir, reused.workspacePath, reused.branchName, {
      deleteBranch: true,
    });
    assert.equal(
      fs.existsSync(
        path.join(tmpDir, ".opencode", "mswarm", "worktrees", "sw1"),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(tmpDir, ".opencode", "mswarm", "worktrees")),
      false,
    );

    await manager.cleanupWorkspace(tmpDir, branch.workspacePath, branch.branchName, {
      deleteBranch: true,
    });
    const deleted = git(tmpDir, ["branch", "--list", "mswarm/sw1/brancher"]).trim();
    assert.equal(deleted, "");
  });

  it("links ignored dependency folders and never deletes them on cleanup", async () => {
    git(tmpDir, ["init"]);
    git(tmpDir, ["config", "user.email", "test@example.com"]);
    git(tmpDir, ["config", "user.name", "Test User"]);
    // node_modules is ignored; venv is not, so it must not be linked.
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "node_modules/\n", "utf8");
    git(tmpDir, ["add", ".gitignore"]);
    git(tmpDir, ["commit", "-m", "initial"]);
    const pkg = path.join(tmpDir, "node_modules", "pkg", "index.js");
    fs.mkdirSync(path.dirname(pkg), { recursive: true });
    fs.writeFileSync(pkg, "module.exports = 1;\n", "utf8");
    fs.mkdirSync(path.join(tmpDir, "venv"));

    const branch = await manager.prepareWorkspace(tmpDir, "sw2", "deps", "branch");
    assert.deepEqual(branch.linkedDependencies, ["node_modules"]);
    const linked = path.join(branch.workspacePath, "node_modules");
    assert.ok(fs.lstatSync(linked).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(linked, "pkg", "index.js")));
    assert.equal(fs.existsSync(path.join(branch.workspacePath, "venv")), false);
    assert.equal(
      git(branch.workspacePath, ["status", "--porcelain"]).trim(),
      "",
      "the link must not show up as a change",
    );

    await manager.cleanupWorkspace(tmpDir, branch.workspacePath, branch.branchName, {
      deleteBranch: true,
    });
    assert.ok(fs.existsSync(pkg), "the root node_modules must survive cleanup");
    assert.equal(fs.existsSync(branch.workspacePath), false, "no leftover worktree folder");
    assert.equal(
      fs.existsSync(path.join(tmpDir, ".opencode", "mswarm", "worktrees")),
      false,
    );
  });
});
