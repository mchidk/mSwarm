import { Plugin } from "@opencode/plugin";
import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import type { CommandInvocation } from "@opencode/plugin/promise/command";
import { SwarmDispatcher } from "./dispatcher.js";
import { buildCoordinatorPrompt, buildWorkerPrompt } from "./prompts.js";
import { OpenCodeRuntime } from "./runtime.js";
import { SwarmStore } from "./store.js";
import { createSwarmTools } from "./tools.js";
import type { ModelRef, SwarmMember, SwarmState } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

/**
 * OpenCode 2.x plugin entrypoint for mSwarm multi-agent orchestration.
 *
 * Author: Michael Christensen
 */

function formatStructuredError(error: unknown): string {
  if (!error) {
    return "Unknown session error";
  }
  if (typeof error === "string") {
    return error;
  }
  const obj = error as {
    type?: unknown;
    name?: unknown;
    message?: unknown;
    data?: { message?: unknown };
  };
  const type =
    (typeof obj.type === "string" && obj.type) ||
    (typeof obj.name === "string" && obj.name) ||
    "SessionError";
  const message =
    (typeof obj.message === "string" && obj.message) ||
    (obj.data && typeof obj.data.message === "string" && obj.data.message) ||
    "";
  return message ? `${type}: ${message}` : type;
}

function toModelRef(model: {
  providerID: string;
  id: string;
  variant?: string;
}): ModelRef {
  return {
    providerID: model.providerID,
    modelID: model.id,
    ...(model.variant ? { variant: model.variant } : {}),
  };
}

function findBrief(
  ctx: ReturnType<SwarmStore["getSwarmBySession"]>,
): string | undefined {
  if (!ctx) {
    return undefined;
  }
  if (ctx.member.brief) {
    return ctx.member.brief;
  }
  const firstMention = ctx.swarm.messages.find((message) =>
    message.mentions.includes(ctx.member.name),
  );
  return firstMention?.text;
}

/**
 * A coordinator prompt for a Swarm-mode session before any workers exist.
 * This intentionally does not persist state; the first `swarm add` (or the
 * `/mswarm` command) creates the real swarm on disk.
 */
function transientCoordinator(
  sessionID: string,
  rootDir: string,
  model?: ModelRef,
): { swarm: SwarmState; member: SwarmMember } {
  const now = new Date().toISOString();
  const member: SwarmMember = {
    name: "coordinator",
    role: "coordinator",
    state: "working",
    sessionID,
    model,
    workspace: "inherit",
    workspacePath: rootDir,
    wakeMode: "mentions_only",
    channels: ["main"],
    lastActiveAt: now,
    createdAt: now,
  };
  const swarm: SwarmState = {
    version: 2,
    swarmId: sessionID,
    rootDirectory: rootDir,
    coordinatorSessionID: sessionID,
    selectedModel: model,
    createdAt: now,
    updatedAt: now,
    headSeq: 0,
    channels: [
      {
        id: "main",
        name: "main",
        description: "Default swarm channel",
        createdAt: now,
        archived: false,
        subscribers: ["coordinator"],
      },
    ],
    members: { coordinator: member },
    messages: [],
  };
  return { swarm, member };
}

async function handleCommand(
  ctx: PluginContext,
  store: SwarmStore,
  dispatcher: SwarmDispatcher,
  rootDir: string,
  invocation: CommandInvocation,
): Promise<void> {
  const args = invocation.prompt.text.trim();
  const lower = args.toLowerCase();
  const existing = store.getSwarmBySession(invocation.sessionID);

  if (lower === "board" || lower === "status") {
    if (!existing) {
      await ctx.session.prompt({
        sessionID: invocation.sessionID,
        text: "No active mSwarm team found for this session. Tell the user to start one with `/mswarm <goal>` or by selecting Swarm mode with Shift+Tab.",
        delivery: invocation.delivery ?? "queue",
      });
      return;
    }
    const summary = store.formatBoardSummary(existing.swarm.swarmId);
    await ctx.session.prompt({
      sessionID: invocation.sessionID,
      text: `Present this mSwarm board summary clearly to the user. Do not modify files or spawn workers.\n\n${summary}`,
      delivery: invocation.delivery ?? "queue",
    });
    return;
  }

  if (existing && existing.member.role !== "coordinator") {
    await ctx.session.prompt({
      sessionID: invocation.sessionID,
      text: "This session is a swarm worker. Use the coordinator session to manage the swarm; ask your parent with `post_message` if you need a roster or model change.",
      delivery: invocation.delivery ?? "queue",
    });
    return;
  }

  if (lower === "kill" || lower === "stop") {
    if (!existing) {
      await ctx.session.prompt({
        sessionID: invocation.sessionID,
        text: "No active mSwarm team found for this session. Nothing to stop.",
        delivery: invocation.delivery ?? "queue",
      });
      return;
    }
    const activeWorkers = Object.values(existing.swarm.members).filter(
      (member) => member.role !== "coordinator" && member.state !== "killed",
    );
    const killedNames: string[] = [];
    let failedKills = 0;
    for (const worker of activeWorkers) {
      try {
        const killed = await dispatcher.killWorker(
          invocation.sessionID,
          worker.name,
        );
        killedNames.push(...killed.map((member) => member.name));
      } catch {
        failedKills++;
      }
    }

    if (failedKills === 0) {
      store.deleteSwarm(existing.swarm.swarmId);
    }

    const cleaned =
      failedKills === 0
        ? "The swarm state and worktrees were cleaned up."
        : `${failedKills} worker(s) could not be stopped, so swarm state was retained for retry.`;
    const report =
      killedNames.length > 0
        ? `Stopped and killed active swarm workers: ${killedNames.join(", ")}. ${cleaned} Inform the user.`
        : `No active swarm workers were running. ${cleaned} Inform the user.`;
    await ctx.session.prompt({
      sessionID: invocation.sessionID,
      text: report,
      delivery: invocation.delivery ?? "queue",
    });
    return;
  }

  const selectedModel = await dispatcher.resolveSelectedModel(
    invocation.sessionID,
  );
  const swarm = store.createOrGetSwarm(
    invocation.sessionID,
    rootDir,
    selectedModel,
  );
  if (!swarm.title && args) {
    store.setTitle(swarm.swarmId, args.slice(0, 80));
  }

  const taskText =
    args ||
    "Swarm initialized. Ask the user what goal they would like the team to work on, or check board status.";
  await ctx.session.prompt({
    sessionID: invocation.sessionID,
    text: taskText,
    ...(invocation.prompt.files ? { files: invocation.prompt.files } : {}),
    ...(invocation.prompt.agents ? { agents: invocation.prompt.agents } : {}),
    ...(invocation.prompt.skills ? { skills: invocation.prompt.skills } : {}),
    delivery: invocation.delivery ?? "queue",
  });
}

/**
 * The plugin definition. Exported as the default so OpenCode 2.x can load it.
 */
export default Plugin.define({
  id: "opencode-mswarm",
  async setup(ctx) {
    const rootDir = ctx.location.project.canonical || ctx.location.directory;
    const store = new SwarmStore(rootDir);
    const workspace = new WorkspaceManager();
    const runtime = new OpenCodeRuntime(ctx);
    const dispatcher = new SwarmDispatcher(runtime, store, workspace);

    await ctx.tool.transform((editor) => {
      for (const tool of createSwarmTools(ctx, store, dispatcher, rootDir)) {
        editor.add(tool);
      }
    });

    await ctx.command.transform((editor) => {
      editor.add({
        name: "mswarm",
        description:
          "Start or manage an mSwarm multi-agent team using the selected model",
        async execute(invocation) {
          await handleCommand(ctx, store, dispatcher, rootDir, invocation);
        },
      });
    });

    // Any admitted prompt means the session is active. This keeps the roster
    // accurate when a user talks to the coordinator while workers are running.
    await ctx.session.hook("prompt", (event) => {
      store.markWorking(event.sessionID);
    });

    // Inject the coordinator/worker contract immediately before each model call.
    // Selecting the "Swarm" primary agent (Shift+Tab) is enough to start a
    // swarm: the first model request creates the coordinator record.
    await ctx.session.hook("context", (event) => {
      if (event.model) {
        dispatcher.recordSessionModel(event.sessionID, toModelRef(event.model));
      }
      const swarmCtx = store.getSwarmBySession(event.sessionID);
      const agentID = String(event.agent).toLowerCase();
      const isSwarmMode = agentID === "swarm" || agentID === "mswarm";

      if (!swarmCtx) {
        if (!isSwarmMode) {
          return;
        }
        // Do not create state just because Swarm mode is selected. Meta
        // questions and simple answers should leave no .opencode artifacts.
        const transient = transientCoordinator(
          event.sessionID,
          rootDir,
          event.model ? toModelRef(event.model) : undefined,
        );
        event.system.push({
          type: "text",
          text: buildCoordinatorPrompt(transient.swarm, transient.member),
        });
        return;
      }

      store.markWorking(event.sessionID);
      if (swarmCtx.member.role === "coordinator") {
        event.system.push({
          type: "text",
          text: buildCoordinatorPrompt(swarmCtx.swarm, swarmCtx.member),
        });
      } else {
        const brief =
          findBrief(swarmCtx) ??
          "Follow your assigned brief from the board and coordinate via post_message / swarm_wait.";
        event.system.push({
          type: "text",
          text: buildWorkerPrompt(swarmCtx.swarm, swarmCtx.member, brief),
        });
      }
    });

    const controller = new AbortController();
    const eventTypes = [
      // OpenCode 2.x emits execution completion events reliably; the public
      // session.idle event is not guaranteed for every session.
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
      "session.model.selected",
      "session.deleted",
    ] as const;

    void (async () => {
      let hadConnection = false;
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({
            signal: controller.signal,
            types: [...eventTypes],
          })) {
            hadConnection = true;
            try {
              switch (event.type) {
                case "session.execution.succeeded":
                  await dispatcher.handleSessionIdle(event.data.sessionID);
                  break;

                case "session.model.selected":
                  dispatcher.handleSessionModelSelected(
                    event.data.sessionID,
                    toModelRef(event.data.model),
                  );
                  break;

                case "session.execution.failed":
                  await dispatcher.handleSessionFailure(
                    event.data.sessionID,
                    formatStructuredError(event.data.error),
                  );
                  break;

                case "session.execution.interrupted":
                  dispatcher.handleSessionInterrupted(event.data.sessionID);
                  break;

                case "session.deleted":
                  await dispatcher.handleSessionDeleted(event.data.sessionID);
                  break;
              }
            } catch (error) {
              if (!controller.signal.aborted) {
                console.error(
                  "[opencode-mswarm] event handler failed:",
                  error instanceof Error ? error.message : error,
                );
              }
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            console.error(
              "[opencode-mswarm] event subscription ended:",
              error instanceof Error ? error.message : error,
            );
          }
        }

        if (controller.signal.aborted) {
          break;
        }

        // The public event stream is volatile. Reconnect and reconcile any
        // members whose completion events were missed during the gap.
        if (hadConnection) {
          hadConnection = false;
          await dispatcher.reconcileOnStartup().catch(() => {});
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    })();

    // Recover cleanly after a plugin reload: members left "working" whose
    // sessions are now idle are parked or woken from unread board messages.
    void dispatcher.reconcileOnStartup().catch((error) => {
      console.error(
        "[opencode-mswarm] startup reconcile failed:",
        error instanceof Error ? error.message : error,
      );
    });

    return () => {
      controller.abort();
    };
  },
});
