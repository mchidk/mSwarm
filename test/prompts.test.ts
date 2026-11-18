import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { looksSubstantive } from "../src/intent.js";
import {
  buildCoordinatorPrompt,
  buildScoutBrief,
  buildWorkerKickoff,
  buildWorkerPrompt,
} from "../src/prompts.js";
import type { SwarmMember, SwarmState } from "../src/types.js";

const NOW = "2026-01-01T00:00:00.000Z";
const ROOT = "/repo";

function swarm(): SwarmState {
  return {
    version: 2,
    swarmId: "s1",
    rootDirectory: ROOT,
    coordinatorSessionID: "coord",
    createdAt: NOW,
    updatedAt: NOW,
    headSeq: 0,
    channels: [
      { id: "main", name: "main", createdAt: NOW, archived: false },
      { id: "old", name: "old", createdAt: NOW, archived: true },
    ],
    members: {},
    messages: [],
  };
}

function member(overrides: Partial<SwarmMember> = {}): SwarmMember {
  return {
    name: "dev",
    role: "worker",
    state: "working",
    sessionID: "sess-dev",
    parentName: "lead",
    workspace: "inherit",
    workspacePath: ROOT,
    wakeMode: "mentions_only",
    lastActiveAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

describe("coordinator prompt", () => {
  const coordinator = member({ name: "coordinator", role: "coordinator" });

  it("requires self-contained briefs and integration before kill", () => {
    const text = buildCoordinatorPrompt(swarm(), coordinator);
    assert.match(text, /Workers cannot see this conversation/);
    assert.match(text, /Two workers must never own the same file/);
    assert.match(text, /Integrate before killing them/);
    assert.match(text, /discards uncommitted changes/);
    assert.match(text, /Channels: #main$/m, "archived channels are hidden");
  });

  it("describes the scout only when auto-delegation is enabled", () => {
    assert.doesNotMatch(buildCoordinatorPrompt(swarm(), coordinator), /scout/);
    const text = buildCoordinatorPrompt(swarm(), coordinator, {
      autoDelegate: true,
    });
    assert.match(text, /read-only scout \(`@auto-N`\)/);
    assert.match(text, /Do not spawn a duplicate investigation/);
  });

  it("is identical across turns for the same swarm (cache-friendly)", () => {
    const state = swarm();
    state.headSeq = 1;
    const first = buildCoordinatorPrompt(state, coordinator, { autoDelegate: true });
    state.headSeq = 42;
    state.members = { dev: member() };
    const second = buildCoordinatorPrompt(state, coordinator, { autoDelegate: true });
    assert.equal(first, second);
  });
});

describe("worker prompt", () => {
  it("interpolates the real parent name in every reporting rule", () => {
    const text = buildWorkerPrompt(swarm(), member(), "Do X");
    assert.doesNotMatch(text, /<parent>/);
    assert.match(text, /`@lead \[blocked\]/);
    assert.match(text, /`@lead \[done\]/);
    assert.match(text, /Assignment:\nDo X$/);
  });

  it("warns shared-root workers to edit only their own files", () => {
    const text = buildWorkerPrompt(swarm(), member(), "Do X");
    assert.match(text, /shared with the coordinator and other workers/);
    assert.doesNotMatch(text, /Commit your changes/);
  });

  it("tells branch workers to commit on their branch and report the SHA", () => {
    const text = buildWorkerPrompt(
      swarm(),
      member({
        workspace: "branch",
        workspacePath: "/repo/.opencode/mswarm/worktrees/s1/dev",
        branchName: "mswarm/s1/dev",
      }),
      "Do X",
    );
    assert.match(text, /Commit your changes on branch `mswarm\/s1\/dev`/);
    assert.match(text, /commit SHA/);
    assert.match(text, /Uncommitted changes are deleted/);
  });

  it("tells share workers to commit in their detached worktree", () => {
    const text = buildWorkerPrompt(
      swarm(),
      member({
        workspace: "share",
        workspacePath: "/repo/.opencode/mswarm/worktrees/s1/dev",
      }),
      "Do X",
    );
    assert.match(text, /Commit your changes in this detached worktree/);
  });

  it("treats a branch request that fell back to the root as shared", () => {
    const text = buildWorkerPrompt(
      swarm(),
      member({ workspace: "branch", workspacePath: ROOT }),
      "Do X",
    );
    assert.match(text, /shared with the coordinator/);
    assert.doesNotMatch(text, /Commit your changes/);
  });

  it("gives monitors a pass/fail report format and no done/edit rules", () => {
    const text = buildWorkerPrompt(swarm(), member({ role: "monitor" }), "Verify X");
    assert.match(text, /`@lead \[pass\] <evidence>`/);
    assert.match(text, /`@lead \[fail\]/);
    assert.doesNotMatch(text, /\[done\]/);
    assert.doesNotMatch(text, /Edit only the files/);
  });
});

describe("worker kickoff", () => {
  it("starts the work without repeating the brief", () => {
    const text = buildWorkerKickoff(member(), 7);
    assert.match(text, /@dev/);
    assert.match(text, /posted as #7/);
    assert.ok(text.length < 300);
  });

  it("carries a workspace warning", () => {
    assert.match(
      buildWorkerKickoff(member(), undefined, "fell back"),
      /\[workspace notice\] fell back/,
    );
  });
});

describe("scout brief", () => {
  it("is read-only by default and includes the request", () => {
    const text = buildScoutBrief("Refactor the store");
    assert.match(text, /read-only scout/);
    assert.match(text, /Do not edit files unless @coordinator/);
    assert.match(text, /User request:\nRefactor the store$/);
  });
});

describe("looksSubstantive", () => {
  it("matches inflected task verbs", () => {
    for (const text of [
      "analyze the auth flow",
      "investigate flaky CI",
      "optimize the query",
      "porting to rust",
      "reviewing PR 12",
      "why does login fail?",
      "how does the dispatcher wake workers",
    ]) {
      assert.equal(looksSubstantive(text), true, text);
    }
  });

  it("ignores short meta questions, greetings, and commands", () => {
    for (const text of [
      "hi",
      "thanks!",
      "what color is the swarm agent",
      "is it running?",
      "show status",
      "how are you",
      "/mswarm board",
      "",
    ]) {
      assert.equal(looksSubstantive(text), false, text);
    }
  });
});
