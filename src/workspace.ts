/// <reference types="node" />
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceMode } from "./types.js";

/**
 * Git worktree isolation for swarm workers.
 *
 * Author: Michael Christensen
 */

const execFileAsync = promisify(execFile);

/**
 * Result of preparing a workspace for a swarm member.
 */
export interface PreparedWorkspace {
  workspacePath: string;
  branchName?: string;
  warning?: string;
  /** Dependency folders linked from the root into the worktree. */
  linkedDependencies?: string[];
}

/**
 * Git-ignored dependency folders that a fresh worktree lacks. Linking them
 * from the root lets workers run checks immediately instead of failing or
 * reinstalling. Build caches (`target`, `dist`) are deliberately not shared:
 * concurrent builds into one folder would collide.
 */
export const DEPENDENCY_DIRS = ["node_modules", ".venv", "venv"] as const;

function sanitizeSegment(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96);
  if (!clean || clean === "." || clean === "..") {
    return "worker";
  }
  return clean;
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 500);
}

/**
 * Manages git worktree isolation for swarm workers.
 */
export class WorkspaceManager {
  /**
   * Prepares an isolated or inherited workspace directory for a swarm member.
   */
  async prepareWorkspace(
    rootDir: string,
    swarmId: string,
    memberName: string,
    mode: WorkspaceMode,
  ): Promise<PreparedWorkspace> {
    if (mode === "inherit") {
      return { workspacePath: rootDir };
    }

    const safeSwarmId = sanitizeSegment(swarmId);
    const safeMemberName = sanitizeSegment(memberName);

    try {
      await runGit(rootDir, ["rev-parse", "--is-inside-work-tree"]);
      await runGit(rootDir, ["rev-parse", "--verify", "HEAD"]);
    } catch {
      return {
        workspacePath: rootDir,
        warning: `Workspace mode "${mode}" requested for "${memberName}", but "${rootDir}" is not a git repository with a valid HEAD. Falling back to the shared root.`,
      };
    }

    const worktreePath = path.join(
      rootDir,
      ".opencode",
      "mswarm",
      "worktrees",
      safeSwarmId,
      safeMemberName,
    );

    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

    if (fs.existsSync(worktreePath)) {
      await this.removeWorktree(rootDir, worktreePath);
    }

    if (mode === "branch") {
      const baseBranch = `mswarm/${safeSwarmId}/${safeMemberName}`;
      let branchName = baseBranch;
      try {
        // Never delete a branch left by an earlier worker with the same name.
        // Preserved branches are how completed work reaches integration.
        for (let suffix = 2; suffix < 100; suffix++) {
          if (!(await this.branchExists(rootDir, branchName))) {
            break;
          }
          branchName = `${baseBranch}-${suffix}`;
        }
        await runGit(rootDir, [
          "worktree",
          "add",
          "-b",
          branchName,
          worktreePath,
          "HEAD",
        ]);
        return {
          workspacePath: worktreePath,
          branchName,
          ...(await this.linkDependencies(rootDir, worktreePath)),
        };
      } catch (error) {
        return {
          workspacePath: rootDir,
          warning: `Failed to create git worktree branch "${branchName}" for "${memberName}" (${shortError(error)}). Falling back to the shared root.`,
        };
      }
    }

    // mode === "share": detached worktree from HEAD, isolated from other workers.
    try {
      await runGit(rootDir, [
        "worktree",
        "add",
        "--detach",
        worktreePath,
        "HEAD",
      ]);
      return {
        workspacePath: worktreePath,
        ...(await this.linkDependencies(rootDir, worktreePath)),
      };
    } catch (error) {
      return {
        workspacePath: rootDir,
        warning: `Failed to create detached git worktree for "${memberName}" (${shortError(error)}). Falling back to the shared root.`,
      };
    }
  }

  private async branchExists(
    rootDir: string,
    branchName: string,
  ): Promise<boolean> {
    try {
      const { stdout } = await runGit(rootDir, ["branch", "--list", branchName]);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private pruneEmptyParents(workspacePath: string, stopAt: string): void {
    const stop = path.resolve(stopAt);
    let current = path.dirname(path.resolve(workspacePath));
    while (current !== stop && current.startsWith(stop + path.sep)) {
      try {
        if (fs.readdirSync(current).length > 0) {
          return;
        }
        fs.rmdirSync(current);
      } catch {
        return;
      }
      current = path.dirname(current);
    }
  }

  /**
   * Links git-ignored dependency folders from the root into a new worktree.
   * A folder is linked only when the worktree ignores it, so the link can
   * never be committed. Junctions on Windows need no admin rights.
   */
  private async linkDependencies(
    rootDir: string,
    worktreePath: string,
  ): Promise<{ linkedDependencies?: string[] }> {
    const linked: string[] = [];
    for (const name of DEPENDENCY_DIRS) {
      const source = path.join(rootDir, name);
      const target = path.join(worktreePath, name);
      try {
        if (!fs.statSync(source).isDirectory() || fs.existsSync(target)) {
          continue;
        }
        // Exit code 0 means ignored; anything else throws. The trailing
        // slash matters: the folder does not exist in the worktree yet, so
        // without it a directory-only pattern like `node_modules/` misses.
        await runGit(worktreePath, ["check-ignore", "-q", `${name}/`]);
        fs.symlinkSync(
          path.resolve(source),
          target,
          process.platform === "win32" ? "junction" : "dir",
        );
        linked.push(name);
      } catch {
        // Missing, not ignored, or not linkable: the worker installs instead.
      }
    }
    return linked.length > 0 ? { linkedDependencies: linked } : {};
  }

  /**
   * Removes dependency links before the worktree itself. `git worktree
   * remove` leaves the directory behind when it contains a junction, and
   * unlinking first guarantees the shared root folder is never traversed.
   */
  private unlinkDependencies(workspacePath: string): void {
    for (const name of DEPENDENCY_DIRS) {
      const target = path.join(workspacePath, name);
      try {
        if (fs.lstatSync(target).isSymbolicLink()) {
          fs.unlinkSync(target);
        }
      } catch {
        // Not present.
      }
    }
  }

  private async removeWorktree(
    rootDir: string,
    workspacePath: string,
  ): Promise<void> {
    this.unlinkDependencies(workspacePath);
    try {
      await runGit(rootDir, ["worktree", "remove", "--force", workspacePath]);
    } catch {
      if (fs.existsSync(workspacePath)) {
        fs.rmSync(workspacePath, { recursive: true, force: true });
      }
    }
    await runGit(rootDir, ["worktree", "prune"]).catch(() => {});
  }

  /**
   * Removes an isolated worktree. Branches created by mSwarm are preserved by
   * default so committed work can still be merged after a worker is killed.
   */
  async cleanupWorkspace(
    rootDir: string,
    workspacePath: string,
    branchName?: string,
    options: { deleteBranch?: boolean } = {},
  ): Promise<void> {
    const resolvedRoot = path.resolve(rootDir);
    const resolvedWorktree = path.resolve(workspacePath);
    const expectedPrefix = path.resolve(
      rootDir,
      ".opencode",
      "mswarm",
      "worktrees",
    );

    if (
      resolvedWorktree !== resolvedRoot &&
      resolvedWorktree.startsWith(expectedPrefix + path.sep)
    ) {
      await this.removeWorktree(rootDir, workspacePath);
      this.pruneEmptyParents(workspacePath, expectedPrefix);
      try {
        if (
          fs.existsSync(expectedPrefix) &&
          fs.readdirSync(expectedPrefix).length === 0
        ) {
          fs.rmdirSync(expectedPrefix);
        }
      } catch {
        // Leave a non-empty or locked directory in place.
      }
    }

    if (branchName && branchName.startsWith("mswarm/") && options.deleteBranch) {
      await runGit(rootDir, ["branch", "-D", branchName]).catch(() => {});
    }
  }
}
