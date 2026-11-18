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
    assert.match(text, /workers cannot see this conversation/);
    assert.match(text, /Two workers never own the same file/);
    assert.match(text, /Integrate before killing them/);
    assert.match(text, /discards uncommitted changes/);
    assert.match(text, /Channels: #main$/m, "archived channels are hidden");
  });

  it("triages before delegating, in a fixed order", () => {
    const text = buildCoordinatorPrompt(swarm(), coordinator);
    const steps = ["1. Answer:", "2. Route:", "3. Scout first:", "4. Delegate:"];
    const positions = steps.map((step) => text.indexOf(step));
    assert.ok(positions.every((position) => position >= 0), "every triage step is present");
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    assert.match(text, /Do not split work you have not seen/);
    assert.doesNotMatch(text, /Do it yourself/, "the coordinator never takes on work itself");
    assert.match(text, /Questions that need reading code go to a worker/);
  });

  it("optimizes for wall-clock time instead of doing work itself", () => {
    const text = buildCoordinatorPrompt(swarm(), coordinator);
    assert.match(text, /You are the serial bottleneck/);
    assert.match(text, /even work you could do yourself/);
    assert.match(text, /Spawn every unit that can start now in one turn/);
    assert.match(text, /Act on each report as it arrives/);
    assert.match(text, /Never take over the blocked work yourself/);
  });

  it("decomposes by ownership and sizes by independent units", () => {
    const text = buildCoordinatorPrompt(swarm(), coordinator);
    assert.match(text, /Split by ownership \(files or modules\), not by phase/);
    assert.match(text, /an interface and its callers/);
    assert.match(text, /Size the team by independent units, not by a target number/);
  });

  it("gives briefs a fixed shape", () => {
    const text = buildCoordinatorPrompt(swarm(), coordinator);
    for (const field of ["Goal:", "Context:", "You own:", "Do not touch:", "Done when:", "Report:"]) {
      assert.ok(text.includes(field), field);
    }
  });

  it("treats [done] as a claim and handles blocked and failed workers", () => {
    const text = buildCoordinatorPrompt(swarm(), coordinator);
    assert.match(text, /`\[done\]` is a claim, not evidence/);
    assert.match(text, /did not write the code/);
    assert.match(text, /On `\[blocked\]`: unblock with one short reply/);
    assert.match(text, /If unblocking needs investigation, assign it/);
    assert.match(text, /Never resend the same brief/);
  });

  it("describes the scout only when auto-delegation is enabled", () => {
    assert.doesNotMatch(buildCoordinatorPrompt(swarm(), coordinator), /@auto-N/);
    const text = buildCoordinatorPrompt(swarm(), coordinator, {
      autoDelegate: true,
    });
    assert.match(text, /read-only scout \(`@auto-N`\)/);
    assert.match(text, /do not spawn a duplicate investigation/);
    assert.match(text, /If the request was step 1, answer it and kill the scout/);
    assert.match(text, /It is your step 3/);
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
