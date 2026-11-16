import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SwarmDispatcher } from "../src/dispatcher.js";
import { SwarmStore } from "../src/store.js";
import type { ModelRef } from "../src/types.js";
import { WorkspaceManager } from "../src/workspace.js";
import { MockRuntime } from "./mock-runtime.js";

const MODEL: ModelRef = { providerID: "openai", modelID: "gpt-5" };

describe("SwarmDispatcher", () => {
  let tmpDir: string;
  let store: SwarmStore;
  let runtime: MockRuntime;
  let dispatcher: SwarmDispatcher;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mswarm-disp-"));
    store = new SwarmStore(tmpDir);
    runtime = new MockRuntime();
    dispatcher = new SwarmDispatcher(runtime, store, new WorkspaceManager());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("inherits the selected model for single, n-copied, and task-sharded workers", async () => {
    store.createOrGetSwarm("coord-1", tmpDir, MODEL);
    dispatcher.recordSessionModel("coord-1", MODEL);

    const single = await dispatcher.addWorkers("coord-1", {
      name: "researcher",
      brief: "Investigate the API",
    });
    assert.equal(single.created.length, 1);
    assert.deepEqual(single.created[0]?.model, MODEL);

    const sharded = await dispatcher.addWorkers("coord-1", {
      name: "dev",
      brief: "Implement the modules",
      tasks: ["auth.ts", "db.ts"],
    });
    assert.deepEqual(
      sharded.created.map((member) => member.name),
      ["dev-1", "dev-2"],
    );
    assert.equal(runtime.createdSessions.length, 3);
    for (const session of runtime.createdSessions) {
      assert.deepEqual(session.model, MODEL);
    }
    assert.equal(runtime.prompts.length, 3);
  });

  it("marks the initial brief read so session.idle does not re-deliver it", async () => {
    const swarm = store.createOrGetSwarm("coord-1", tmpDir, MODEL);
    const [worker] = (
      await dispatcher.addWorkers("coord-1", {
        name: "alice",
        brief: "Do the thing",
      })
    ).created;
    assert.ok(worker);

    const stored = store.getMember(swarm.swarmId, "alice");
    assert.equal(stored?.lastReadSeq, 1);
    assert.equal(runtime.prompts.length, 1);

    await dispatcher.handleSessionIdle(worker.sessionID);
    assert.equal(store.getMember(swarm.swarmId, "alice")?.state, "waiting");
    assert.equal(runtime.prompts.length, 1, "brief must not be re-delivered");
  });

  it("keeps a brief's @mentions from waking unrelated workers", async () => {
    const swarm = store.createOrGetSwarm("coord-1", tmpDir, MODEL);
    const [alice] = (
      await dispatcher.addWorkers("coord-1", {
        name: "alice",
        brief: "Read this brief",
      })
    ).created;
    assert.ok(alice);
    await dispatcher.handleSessionIdle(alice.sessionID);
    assert.equal(store.getMember(swarm.swarmId, "alice")?.state, "waiting");
    const promptsBefore = runtime.prompts.length;

    await dispatcher.addWorkers("coord-1", {
      name: "bob",
      brief: "@alice please review the schema",
    });

    // Bob's brief mentions Alice in its text, but the assignment message is
    // scoped to Bob only, so Alice stays parked.
    assert.equal(store.getMember(swarm.swarmId, "alice")?.state, "waiting");
    assert.equal(runtime.prompts.length, promptsBefore + 1);
  });

  it("resolves the selected model from OpenCode when not cached", async () => {
    runtime.setSessionModel("coord-hist", {
      providerID: "google",
      modelID: "gemini-2.5-pro",
    });
    const resolved = await dispatcher.resolveSelectedModel("coord-hist");
    assert.deepEqual(resolved, {
      providerID: "google",
      modelID: "gemini-2.5-pro",
    });

    const withVariant = await dispatcher.resolveModelRef(
      "openai/gpt-5#high",
      MODEL,
    );
    assert.deepEqual(withVariant, {
      providerID: "openai",
      modelID: "gpt-5",
      variant: "high",
    });
  });

  it("supports fork, switchModel, and killWorker with permission checks", async () => {
    store.createOrGetSwarm("coord-1", tmpDir, MODEL);

    const [worker] = (
      await dispatcher.addWorkers("coord-1", {
        name: "worker-1",
        brief: "Do work",
        fork: "coordinator",
      })
    ).created;
    assert.ok(worker);
    assert.equal(runtime.createdSessions[0]?.parentID, "coord-1");

    await assert.rejects(
      () => dispatcher.switchModel("coord-1", "worker-1", "openai/gpt-5-mini"),
      /currently working/,
    );

    const parked = dispatcher.waitForBoard(worker.sessionID, 1, true);
    assert.equal(parked.status, "parked");
    const switched = await dispatcher.switchModel(
      "coord-1",
      "worker-1",
      "openai/gpt-5-mini",
    );
    assert.deepEqual(switched.model, { providerID: "openai", modelID: "gpt-5-mini" });
    assert.equal(switched.member.state, "working");
    assert.equal(runtime.switched.length, 1);

    await assert.rejects(
      () => dispatcher.killWorker(worker.sessionID, "coordinator"),
      /Cannot kill the coordinator/,
    );

    const killed = await dispatcher.killWorker("coord-1", "worker-1");
    assert.equal(killed.length, 1);
    assert.equal(killed[0]?.state, "killed");
    assert.ok(runtime.interrupted.includes(worker.sessionID));
  });

  it("parks, wakes, and retries failed wakeups without losing messages", async () => {
    const swarm = store.createOrGetSwarm("coord-1", tmpDir, MODEL);
    const [worker] = (
      await dispatcher.addWorkers("coord-1", {
        name: "alice",
        brief: "Wait for tasks",
      })
    ).created;
    assert.ok(worker);

    const parked = dispatcher.waitForBoard(worker.sessionID, swarm.headSeq, true);
    assert.equal(parked.status, "parked");

    const first = await dispatcher.postAndWake("coord-1", "@alice please verify");
    assert.deepEqual(first.woken, ["alice"]);
    assert.equal(store.getMember(swarm.swarmId, "alice")?.state, "working");

    await dispatcher.handleSessionIdle(worker.sessionID);
    assert.equal(store.getMember(swarm.swarmId, "alice")?.state, "waiting");

    runtime.failPromptForSession = worker.sessionID;
    const failed = await dispatcher.postAndWake("coord-1", "@alice ping again");
    assert.deepEqual(failed.woken, []);
    assert.equal(store.getMember(swarm.swarmId, "alice")?.state, "stopped");

    runtime.failPromptForSession = undefined;
    const retried = await dispatcher.postAndWake("coord-1", "@alice retry");
    assert.deepEqual(retried.woken, ["alice"]);
    const lastPrompt = runtime.prompts[runtime.prompts.length - 1];
    assert.match(lastPrompt?.text ?? "", /ping again/);
    assert.match(lastPrompt?.text ?? "", /retry/);
  });

  it("returns unread messages without parking and marks the member working", async () => {
    const swarm = store.createOrGetSwarm("coord-1", tmpDir, MODEL);
    const [worker] = (
      await dispatcher.addWorkers("coord-1", {
        name: "alice",
        brief: "Wait",
      })
    ).created;
    assert.ok(worker);

    await dispatcher.postAndWake("coord-1", "@alice first");
    await dispatcher.handleSessionIdle(worker.sessionID);
    const head = swarm.headSeq;
    await dispatcher.postAndWake("coord-1", "@alice second");

    // The worker is waiting, so postAndWake already woke it. Parking now with
    // an older seq returns the unread message immediately.
    const result = dispatcher.waitForBoard(worker.sessionID, head, true);
    assert.equal(result.status, "messages");
    if (result.status === "messages") {
      assert.ok(result.messages.some((message) => /second/.test(message.text)));
    }
    assert.equal(store.getMember(swarm.swarmId, "alice")?.state, "working");
  });

  it("rejects traversal-like names and pre-validates batch names", async () => {
    const swarm = store.createOrGetSwarm("coord-1", tmpDir, MODEL);
    assert.throws(
      () =>
        store.addMember(swarm.swarmId, {
          name: "..\\evil",
          role: "worker",
          state: "working",
          sessionID: "bad",
          workspace: "inherit",
          wakeMode: "mentions_only",
        }),
      /Invalid member name/,
    );

    await dispatcher.addWorkers("coord-1", {
      name: "dev",
      brief: "First",
      tasks: ["one", "two"],
    });
    const before = runtime.createdSessions.length;
    await assert.rejects(
      () =>
        dispatcher.addWorkers("coord-1", {
          name: "dev",
          brief: "Second",
          tasks: ["three"],
        }),
      /already exists/,
    );
    assert.equal(runtime.createdSessions.length, before, "no partial spawn");
  });

  it("records a failed initial prompt and cleans up the failed worker", async () => {
    const swarm = store.createOrGetSwarm("coord-1", tmpDir, MODEL);
    runtime.failPromptForName = "dev";
    const result = await dispatcher.addWorkers("coord-1", {
      name: "dev",
      brief: "Implement",
    });

    assert.equal(result.created.length, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(
      store.getMember(swarm.swarmId, "dev")?.state,
      "killed",
    );
    assert.ok(runtime.removed.includes("worker-sess-1"));
  });

  it("reconciles working members after a plugin reload", async () => {
    const swarm = store.createOrGetSwarm("coord-1", tmpDir, MODEL);
    const [worker] = (
      await dispatcher.addWorkers("coord-1", {
        name: "alice",
        brief: "Do work",
      })
    ).created;
    assert.ok(worker);
    store.addMember(swarm.swarmId, {
      name: "ghost",
      role: "worker",
      state: "working",
      sessionID: "sess-gone",
      workspace: "inherit",
      wakeMode: "mentions_only",
    });
    runtime.missingSessions.add("sess-gone");
    runtime.busySessions.add(worker.sessionID);

    await dispatcher.reconcileOnStartup();
    assert.equal(store.getMember(swarm.swarmId, "alice")?.state, "working");
    assert.equal(store.getMember(swarm.swarmId, "ghost")?.state, "stopped");

    runtime.busySessions.delete(worker.sessionID);
    await dispatcher.reconcileOnStartup();
    assert.equal(store.getMember(swarm.swarmId, "alice")?.state, "waiting");
  });

  it("reports worker failures to the parent and wakes it", async () => {
    const swarm = store.createOrGetSwarm("coord-1", tmpDir, MODEL);
    const [worker] = (
      await dispatcher.addWorkers("coord-1", {
        name: "alice",
        brief: "Do work",
      })
    ).created;
    assert.ok(worker);
    await dispatcher.handleSessionIdle(worker.sessionID);
    await dispatcher.handleSessionIdle("coord-1");
    assert.equal(
      store.getMember(swarm.swarmId, "coordinator")?.state,
      "waiting",
    );

    await dispatcher.handleSessionFailure(worker.sessionID, "boom");
    assert.equal(store.getMember(swarm.swarmId, "alice")?.state, "stopped");
    assert.equal(store.getMember(swarm.swarmId, "coordinator")?.state, "working");
    const lastMessage = store
      .getSwarm(swarm.swarmId)
      ?.messages[store.getSwarm(swarm.swarmId)!.messages.length - 1];
    assert.match(lastMessage?.text ?? "", /\[error\]/);
    assert.match(
      runtime.prompts[runtime.prompts.length - 1]?.text ?? "",
      /\[error\]/,
      "the parent should be woken by the error report",
    );
  });
});
