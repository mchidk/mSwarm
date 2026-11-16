import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SwarmStore } from "../src/store.js";

describe("SwarmStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mswarm-store-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates and reloads a swarm with coordinator and main channel", () => {
    const store = new SwarmStore(tmpDir);
    const model = { providerID: "anthropic", modelID: "claude-sonnet-4" };
    const swarm = store.createOrGetSwarm("sess-coord-1", tmpDir, model);

    assert.equal(swarm.coordinatorSessionID, "sess-coord-1");
    assert.deepEqual(swarm.selectedModel, model);
    assert.equal(swarm.members.coordinator?.role, "coordinator");
    assert.deepEqual(swarm.members.coordinator?.model, model);
    assert.equal(swarm.channels[0]?.name, "main");

    // Reload from disk in a fresh SwarmStore instance
    const reloaded = new SwarmStore(tmpDir);
    const ctx = reloaded.getSwarmBySession("sess-coord-1");
    assert.ok(ctx);
    assert.equal(ctx.swarm.swarmId, swarm.swarmId);
    assert.equal(ctx.member.name, "coordinator");
    assert.deepEqual(ctx.swarm.selectedModel, model);
  });

  it("validates member names and reserved names", () => {
    const store = new SwarmStore(tmpDir);
    const swarm = store.createOrGetSwarm("sess-1", tmpDir);

    assert.throws(
      () =>
        store.addMember(swarm.swarmId, {
          name: "all",
          role: "worker",
          state: "working",
          sessionID: "s2",
          workspace: "inherit",
          wakeMode: "mentions_only",
        }),
      /reserved/,
    );

    assert.throws(
      () =>
        store.addMember(swarm.swarmId, {
          name: "bad name",
          role: "worker",
          state: "working",
          sessionID: "s2",
          workspace: "inherit",
          wakeMode: "mentions_only",
        }),
      /Invalid member name/,
    );
  });

  it("parses @name, @prefix, @all, and @#channel mentions and wakes matching members", () => {
    const store = new SwarmStore(tmpDir);
    const swarm = store.createOrGetSwarm("sess-coord", tmpDir);

    store.addMember(swarm.swarmId, {
      name: "worker-1",
      role: "worker",
      state: "waiting",
      sessionID: "sess-w1",
      workspace: "inherit",
      wakeMode: "mentions_only",
    });
    store.addMember(swarm.swarmId, {
      name: "worker-2",
      role: "worker",
      state: "waiting",
      sessionID: "sess-w2",
      workspace: "inherit",
      wakeMode: "mentions_only",
    });
    store.addMember(swarm.swarmId, {
      name: "observer",
      role: "worker",
      state: "waiting",
      sessionID: "sess-obs",
      workspace: "inherit",
      wakeMode: "all",
    });

    // Prefix mention @worker wakes worker-1, worker-2, and wakeMode:all observer
    const prefixRes = store.postMessage(
      swarm.swarmId,
      "coordinator",
      "@worker please start",
    );
    assert.deepEqual(prefixRes.message.mentions, ["worker"]);
    assert.deepEqual(
      prefixRes.recipientsToWake.map((m) => m.name).sort(),
      ["observer", "worker-1", "worker-2"],
    );

    // @#main is rejected
    assert.throws(
      () => store.postMessage(swarm.swarmId, "coordinator", "@#main hello"),
      /Cannot mention @#main/,
    );

    assert.throws(
      () =>
        store.postMessage(
          swarm.swarmId,
          "coordinator",
          "x".repeat(64_001),
        ),
      /too long/,
    );

    // Custom channel + @#channel mention
    store.createChannel(swarm.swarmId, "backend", "API work", "coordinator");
    store.subscribeChannel(swarm.swarmId, "backend", "worker-1");

    const chRes = store.postMessage(
      swarm.swarmId,
      "coordinator",
      "@#backend check schema",
      "backend",
    );
    assert.deepEqual(chRes.message.mentions, ["#backend"]);
    assert.deepEqual(
      chRes.recipientsToWake.map((m) => m.name),
      ["worker-1"],
    );
  });

  it("keeps separate store instances coherent through disk refresh", () => {
    const storeA = new SwarmStore(tmpDir);
    const early = new SwarmStore(tmpDir);
    const swarm = storeA.createOrGetSwarm("sess-coord", tmpDir);

    storeA.addMember(swarm.swarmId, {
      name: "alice",
      role: "worker",
      state: "waiting",
      sessionID: "sess-alice",
      workspace: "inherit",
      wakeMode: "mentions_only",
    });

    const found = early.getSwarmBySession("sess-alice");
    assert.ok(found, "a newer store instance should discover the worker");
    assert.equal(found.member.name, "alice");

    const storeB = new SwarmStore(tmpDir);
    storeB.postMessage(swarm.swarmId, "coordinator", "@alice hello");

    const fromA = storeA.readBoard(swarm.swarmId, "coordinator", { since: 0 });
    assert.equal(fromA.messages.length, 1);
    assert.match(fromA.messages[0]?.text ?? "", /hello/);
    assert.ok((storeA.getSwarm(swarm.swarmId)?.revision ?? 0) >= 2);
  });

  it("deletes a swarm and prunes empty state directories", () => {
    const store = new SwarmStore(tmpDir);
    const swarm = store.createOrGetSwarm("coord-delete", tmpDir);
    store.addMember(swarm.swarmId, {
      name: "worker",
      role: "worker",
      state: "waiting",
      sessionID: "sess-worker",
      workspace: "inherit",
      wakeMode: "mentions_only",
    });
    assert.ok(
      fs.existsSync(path.join(tmpDir, ".opencode", "mswarm", "swarms")),
    );

    store.deleteSwarm(swarm.swarmId);
    assert.equal(store.getSwarm(swarm.swarmId), undefined);
    assert.equal(store.getSwarmBySession("coord-delete"), undefined);
    assert.equal(
      fs.existsSync(path.join(tmpDir, ".opencode")),
      false,
      "empty .opencode/mswarm directories should be pruned",
    );
  });

  it("refreshes getMember and listSwarms from disk", () => {
    const reader = new SwarmStore(tmpDir);
    const writer = new SwarmStore(tmpDir);
    const swarm = writer.createOrGetSwarm("coord-refresh", tmpDir);
    writer.addMember(swarm.swarmId, {
      name: "bob",
      role: "worker",
      state: "waiting",
      sessionID: "sess-bob",
      workspace: "inherit",
      wakeMode: "mentions_only",
    });

    assert.equal(reader.getMember(swarm.swarmId, "bob")?.name, "bob");
    assert.ok(
      reader.listSwarms().some((candidate) => candidate.swarmId === swarm.swarmId),
    );

    const second = writer.createOrGetSwarm("coord-second", tmpDir);
    assert.ok(
      reader.listSwarms().some((candidate) => candidate.swarmId === second.swarmId),
      "listSwarms should discover a swarm created after this store loaded",
    );
  });

  it("supports readBoard since, limit, seqs, and status", () => {
    const store = new SwarmStore(tmpDir);
    const swarm = store.createOrGetSwarm("sess-coord", tmpDir);
    store.addMember(swarm.swarmId, {
      name: "alice",
      role: "worker",
      state: "waiting",
      sessionID: "sess-alice",
      workspace: "inherit",
      wakeMode: "mentions_only",
      waitingSinceSeq: 1,
    });

    store.postMessage(swarm.swarmId, "coordinator", "msg 1");
    store.postMessage(swarm.swarmId, "coordinator", "@alice msg 2");
    store.postMessage(swarm.swarmId, "alice", "@coordinator msg 3");

    const sinceOne = store.readBoard(swarm.swarmId, "alice", { since: 1 });
    assert.deepEqual(
      sinceOne.messages.map((m) => m.seq),
      [2, 3],
    );

    const bySeq = store.readBoard(swarm.swarmId, "coordinator", { seqs: [1, 3] });
    assert.deepEqual(
      bySeq.messages.map((m) => m.seq),
      [1, 3],
    );

    const status = store.readBoard(swarm.swarmId, "alice", { status: true });
    assert.equal(status.name, "alice");
    assert.equal(status.state, "waiting");
    assert.equal(status.lastReadSeq, 3);
    assert.equal(status.lastPostSeq, 3);
  });
});
