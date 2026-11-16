import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import MSwarmPlugin from "../src/index.js";
import { SwarmStore } from "../src/store.js";
import type { ModelRef } from "../src/types.js";

type MockModel = ModelRef;

interface MockSession {
  id: string;
  title?: string;
  parentID?: string;
  model?: MockModel;
  location: { directory: string };
}

interface EventLike {
  type: string;
  data: Record<string, unknown>;
}

function createEventStream() {
  const queue: EventLike[] = [];
  const waiters: Array<(value: EventLike | undefined) => void> = [];
  let closed = false;

  return {
    push(event: EventLike) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(event);
      } else {
        queue.push(event);
      }
    },
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter(undefined);
      }
    },
    subscribe(options?: { types?: readonly string[]; signal?: AbortSignal }) {
      const types = options?.types;
      const signal = options?.signal;
      return {
        async *[Symbol.asyncIterator]() {
          while (!closed && !signal?.aborted) {
            const next =
              queue.length > 0
                ? queue.shift()
                : await new Promise<EventLike | undefined>((resolve) => {
                    waiters.push(resolve);
                    const onAbort = () => resolve(undefined);
                    signal?.addEventListener("abort", onAbort, { once: true });
                  });
            if (!next || closed || signal?.aborted) {
              return;
            }
            if (!types || types.includes(next.type)) {
              yield next;
            }
          }
        },
      };
    },
  };
}

function createMockContext(rootDir: string, initialModel: MockModel) {
  const sessions = new Map<string, MockSession>();
  const prompts: Array<{ sessionID: string; text: string; delivery?: string }> = [];
  const interrupts: string[] = [];
  const removed: string[] = [];
  const tools = new Map<string, { execute: (input: unknown, context: unknown) => Promise<{ content: string }> }>();
  const commands: Array<{
    name: string;
    description?: string;
    execute: (input: unknown) => Promise<void>;
  }> = [];
  const hooks: Record<string, Array<(event: unknown) => Promise<void> | void>> = {};
  const events = createEventStream();
  let nextSessionID = 1;

  sessions.set("coord-1", {
    id: "coord-1",
    title: "Coordinator",
    model: initialModel,
    location: { directory: rootDir },
  });

  const ctx = {
    app: { name: "test", version: "2.3.0", channel: "test" },
    location: {
      directory: rootDir,
      project: { id: "project-1", directory: rootDir, canonical: rootDir },
    },
    options: {},
    session: {
      create: async (input: {
        title: string;
        parentID?: string;
        model?: { providerID: string; id: string; variant?: string };
        location: { directory: string };
      }) => {
        const id = `sess-${nextSessionID++}`;
        const session: MockSession = {
          id,
          title: input.title,
          parentID: input.parentID,
          model: input.model
            ? {
                providerID: input.model.providerID,
                modelID: input.model.id,
                ...(input.model.variant ? { variant: input.model.variant } : {}),
              }
            : undefined,
          location: { directory: input.location.directory },
        };
        sessions.set(id, session);
        return session;
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions.get(sessionID);
        if (!session) {
          throw new Error("Session not found");
        }
        return {
          ...session,
          model: session.model
            ? {
                providerID: session.model.providerID,
                id: session.model.modelID,
                ...(session.model.variant ? { variant: session.model.variant } : {}),
              }
            : undefined,
        };
      },
      prompt: async (input: {
        sessionID: string;
        text: string;
        delivery?: string;
        files?: unknown;
        agents?: unknown;
        skills?: unknown;
      }) => {
        prompts.push(input);
        for (const hook of hooks.prompt ?? []) {
          await hook({
            sessionID: input.sessionID,
            prompt: {
              text: input.text,
              files: input.files,
              agents: input.agents,
              skills: input.skills,
            },
            metadata: {},
            delivery: input.delivery ?? "steer",
          });
        }
        return { id: `inbox-${prompts.length}` };
      },
      switchModel: async ({
        sessionID,
        model,
      }: {
        sessionID: string;
        model: { providerID: string; id: string; variant?: string };
      }) => {
        const session = sessions.get(sessionID);
        if (session) {
          session.model = {
            providerID: model.providerID,
            modelID: model.id,
            ...(model.variant ? { variant: model.variant } : {}),
          };
        }
      },
      interrupt: async ({ sessionID }: { sessionID: string }) => {
        interrupts.push(sessionID);
      },
      remove: async ({ sessionID }: { sessionID: string }) => {
        removed.push(sessionID);
        sessions.delete(sessionID);
      },
      hook: async (
        name: string,
        callback: (event: unknown) => Promise<void> | void,
      ) => {
        (hooks[name] ??= []).push(callback);
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (tool: { name: string; execute: (input: unknown, context: unknown) => Promise<{ content: string }> }) => {
            tools.set(tool.name, tool);
          },
          namespace: () => {},
          remove: () => {},
          list: () => [],
        });
        return { dispose: async () => {} };
      },
    },
    command: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (command: {
            name: string;
            description?: string;
            execute: (input: unknown) => Promise<void>;
          }) => {
            commands.push(command);
          },
        });
        return { dispose: async () => {} };
      },
    },
    model: {
      list: async () => ({
        location: { directory: rootDir },
        data: [
          {
            id: initialModel.modelID,
            modelID: initialModel.modelID,
            providerID: initialModel.providerID,
            name: "GPT-5",
          },
          {
            id: "gpt-5-mini",
            modelID: "gpt-5-mini",
            providerID: "openai",
            name: "GPT-5 mini",
          },
        ],
      }),
      default: async () => ({
        location: { directory: rootDir },
        data: {
          id: initialModel.modelID,
          modelID: initialModel.modelID,
          providerID: initialModel.providerID,
          name: "GPT-5",
        },
      }),
    },
    event: { subscribe: events.subscribe },
  };

  return {
    ctx,
    sessions,
    prompts,
    interrupts,
    removed,
    tools,
    commands,
    hooks,
    events,
  };
}

function toolContext(sessionID: string) {
  return {
    sessionID,
    agent: "build",
    messageID: `msg-${sessionID}`,
    id: "call-1",
    signal: new AbortController().signal,
    progress: async () => {},
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

describe("MSwarmPlugin (OpenCode 2.x)", () => {
  let tmpDir: string;
  const model: MockModel = { providerID: "openai", modelID: "gpt-5" };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mswarm-plugin-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads with an id and registers tools, command, hooks, and events", async () => {
    const mock = createMockContext(tmpDir, model);
    assert.equal(MSwarmPlugin.id, "opencode-mswarm");

    const cleanup = await MSwarmPlugin.setup(mock.ctx as never);
    assert.deepEqual(
      [...mock.tools.keys()].sort(),
      ["post_message", "read_board", "swarm", "swarm_wait"],
    );
    assert.equal(mock.commands[0]?.name, "mswarm");
    assert.equal(mock.hooks.prompt?.length, 1);
    assert.equal(mock.hooks.context?.length, 1);

    await cleanup?.();
    mock.events.close();
  });

  it("runs /mswarm, spawns a worker, wakes it, and reports status/board/kill", async () => {
    const mock = createMockContext(tmpDir, model);
    const cleanup = await MSwarmPlugin.setup(mock.ctx as never);

    const command = mock.commands.find((candidate) => candidate.name === "mswarm");
    assert.ok(command);

    await command.execute({
      sessionID: "coord-1",
      prompt: { text: "Build feature X" },
      delivery: "queue",
    });

    const store = new SwarmStore(tmpDir);
    let swarm = store.getSwarmBySession("coord-1")?.swarm;
    assert.ok(swarm);
    assert.deepEqual(swarm.selectedModel, model);
    assert.equal(mock.prompts[0]?.text, "Build feature X");

    const coordSystem: Array<{ type: string; text: string }> = [];
    await mock.hooks.context![0]!({ sessionID: "coord-1", system: coordSystem });
    assert.match(coordSystem[0]?.text ?? "", /coordinator/i);

    const addTool = mock.tools.get("swarm");
    assert.ok(addTool);
    const addResult = JSON.parse(
      await addTool.execute(
        { action: "add", name: "dev", brief: "Implement feature X" },
        toolContext("coord-1"),
      ).then((result) => result.content),
    );
    assert.equal(addResult.ok, true);
    assert.equal(addResult.added[0].name, "dev");
    assert.deepEqual(addResult.added[0].model, model);
    assert.equal(mock.sessions.get("sess-1")?.parentID, "coord-1");
    assert.equal(mock.sessions.get("sess-1")?.location.directory, tmpDir);

    const devSystem: Array<{ type: string; text: string }> = [];
    await mock.hooks.context![0]!({ sessionID: "sess-1", system: devSystem });
    assert.match(devSystem[0]?.text ?? "", /Assignment:/);
    assert.match(devSystem[0]?.text ?? "", /Implement feature X/);

    // The worker parks, then the coordinator wakes it.
    const waitTool = mock.tools.get("swarm_wait");
    assert.ok(waitTool);
    const parked = JSON.parse(
      await waitTool.execute({ since: 1 }, toolContext("sess-1")).then((r) => r.content),
    );
    assert.equal(parked.status, "parked");

    const postTool = mock.tools.get("post_message");
    assert.ok(postTool);
    const posted = JSON.parse(
      await postTool.execute(
        { text: "@dev please verify the change" },
        toolContext("coord-1"),
      ).then((r) => r.content),
    );
    assert.deepEqual(posted.woken, ["dev"]);
    assert.match(mock.prompts[mock.prompts.length - 1]?.text ?? "", /please verify/);

    // A completed execution with no unread moves the worker to waiting.
    mock.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "sess-1" },
    });
    await flush();
    const fresh = new SwarmStore(tmpDir);
    swarm = fresh.getSwarmBySession("coord-1")?.swarm;
    assert.equal(fresh.getMember(swarm!.swarmId, "dev")?.state, "waiting");

    const statusTool = mock.tools.get("swarm");
    assert.ok(statusTool);
    const status = JSON.parse(
      await statusTool.execute({ action: "status" }, toolContext("coord-1")).then(
        (r) => r.content,
      ),
    );
    assert.equal(status.ok, true);
    assert.ok(status.members.some((member: { name: string }) => member.name === "dev"));

    await command.execute({
      sessionID: "coord-1",
      prompt: { text: "board" },
      delivery: "queue",
    });
    assert.match(
      mock.prompts[mock.prompts.length - 1]?.text ?? "",
      /# Swarm:/,
    );

    await command.execute({
      sessionID: "coord-1",
      prompt: { text: "kill" },
      delivery: "queue",
    });
    assert.ok(mock.interrupts.includes("sess-1"));
    assert.match(mock.prompts[mock.prompts.length - 1]?.text ?? "", /dev/);

    await cleanup?.();
    mock.events.close();
  });

  it("creates a coordinator when the Swarm agent mode is used", async () => {
    const mock = createMockContext(tmpDir, model);
    const cleanup = await MSwarmPlugin.setup(mock.ctx as never);

    const system: Array<{ type: string; text: string }> = [];
    await mock.hooks.context![0]!({
      sessionID: "mode-session",
      agent: "swarm",
      model: { providerID: "openai", id: "gpt-5" },
      system,
    });

    const store = new SwarmStore(tmpDir);
    const swarmCtx = store.getSwarmBySession("mode-session");
    assert.ok(swarmCtx);
    assert.equal(swarmCtx.member.role, "coordinator");
    assert.deepEqual(swarmCtx.swarm.selectedModel, model);
    assert.match(system[0]?.text ?? "", /coordinator/i);

    await cleanup?.();
    mock.events.close();
  });

  it("applies session.model.selected events to the swarm", async () => {
    const mock = createMockContext(tmpDir, model);
    const cleanup = await MSwarmPlugin.setup(mock.ctx as never);
    const command = mock.commands.find((candidate) => candidate.name === "mswarm");
    assert.ok(command);
    await command.execute({
      sessionID: "coord-1",
      prompt: { text: "Build feature X" },
      delivery: "queue",
    });

    mock.events.push({
      type: "session.model.selected",
      data: {
        sessionID: "coord-1",
        model: { providerID: "openai", id: "gpt-5-mini" },
      },
    });
    await flush();

    const store = new SwarmStore(tmpDir);
    const swarm = store.getSwarmBySession("coord-1")?.swarm;
    assert.ok(swarm);
    assert.deepEqual(swarm.selectedModel, {
      providerID: "openai",
      modelID: "gpt-5-mini",
    });

    await cleanup?.();
    mock.events.close();
  });
});
