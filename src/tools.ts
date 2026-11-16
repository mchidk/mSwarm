import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import type {
  Info as ToolInfo,
  ToolContext,
} from "@opencode/plugin/promise/tool";
import type { SwarmDispatcher } from "./dispatcher.js";
import type { SwarmStore } from "./store.js";

/**
 * V2 tool definitions for mSwarm.
 *
 * Author: Michael Christensen
 */

function toJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

function toErrorJson(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return toJson({ ok: false, error: message });
}

type SwarmArgs = {
  action:
    | "title"
    | "add"
    | "status"
    | "models"
    | "model"
    | "kill"
    | "channel";
  title?: string;
  name?: string;
  brief?: string;
  model?: string;
  fork?: string;
  workspace?: "inherit" | "share" | "branch";
  role?: "worker" | "monitor";
  n?: number;
  tasks?: string[];
  channels?: string[];
  op?: "create" | "join" | "leave" | "list" | "archive";
  channel?: string;
  topic?: string;
};

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

const stringProp = (description: string): Record<string, unknown> => ({
  type: "string",
  description,
});

const swarmInput = objectSchema(
  {
    action: {
      type: "string",
      description:
        "Management action: title, add, status, models, model, kill, or channel.",
      enum: ["title", "add", "status", "models", "model", "kill", "channel"],
    },
    title: stringProp("Swarm title (action: title)."),
    name: stringProp("Worker or member name."),
    brief: stringProp(
      "Concrete assignment for the worker: deliverables, owned paths, and acceptance checks (action: add).",
    ),
    model: stringProp(
      "Model as providerID/modelID, or a model ID/name to resolve (actions: add, model).",
    ),
    fork: stringProp(
      "Optional member name or 'coordinator' whose session should parent the new worker.",
    ),
    workspace: {
      type: "string",
      description:
        "Workspace isolation: inherit (shared root), share (detached git worktree), or branch (git worktree with a branch).",
      enum: ["inherit", "share", "branch"],
    },
    role: {
      type: "string",
      description:
        "Worker role: worker (default) or monitor (read-only observation).",
      enum: ["worker", "monitor"],
    },
    n: {
      type: "integer",
      description: "Spawn n numbered copies named <name>-1..<name>-n.",
      minimum: 1,
      maximum: 32,
    },
    tasks: {
      type: "array",
      description:
        "Spawn one numbered worker per task, each with its own slice of the brief.",
      items: { type: "string" },
      maxItems: 32,
    },
    channels: {
      type: "array",
      description: "Channels the new workers should subscribe to.",
      items: { type: "string" },
      maxItems: 16,
    },
    op: {
      type: "string",
      description:
        "Channel operation: create, join, leave, list, or archive (action: channel).",
      enum: ["create", "join", "leave", "list", "archive"],
    },
    channel: stringProp("Channel name without the leading #."),
    topic: stringProp("Channel topic/description (op: create)."),
  },
  ["action"],
);

const postMessageInput = objectSchema(
  {
    text: stringProp(
      "Message text. Use @name, @prefix, @all, or @#channel to wake the right members.",
    ),
    channel: stringProp("Optional channel name. Defaults to main."),
  },
  ["text"],
);

const readBoardInput = objectSchema({
  since: {
    type: "integer",
    description: "Only return messages after this sequence number.",
    minimum: 0,
  },
  limit: {
    type: "integer",
    description: "Maximum number of messages to return (default 20, max 200).",
    minimum: 1,
    maximum: 200,
  },
  seqs: {
    type: "array",
    description: "Read specific message sequence numbers.",
    items: { type: "integer", minimum: 1 },
    maxItems: 200,
  },
  channel: stringProp(
    "Optional channel filter, or '*' to read every visible channel.",
  ),
  status: {
    type: "boolean",
    description: "Return your own board state instead of messages.",
  },
});

const waitInput = objectSchema(
  {
    since: {
      type: "integer",
      description:
        "Highest board sequence number you have already read. The call parks only if nothing newer matches.",
      minimum: 0,
    },
    mentions_only: {
      type: "boolean",
      description:
        "Wake only for messages that mention you or a channel you subscribe to (default true).",
    },
  },
  ["since"],
);

/**
 * Creates the tool definitions registered by the plugin.
 */
export function createSwarmTools(
  ctx: PluginContext,
  store: SwarmStore,
  dispatcher: SwarmDispatcher,
  rootDir: string,
): ToolInfo[] {
  const isSwarmAgent = (agent: string): boolean => {
    const id = String(agent).toLowerCase();
    return id === "swarm" || id === "mswarm";
  };

  const ensureSwarmContext = async (sessionID: string) => {
    const existing = store.getSwarmBySession(sessionID);
    if (existing) {
      return existing;
    }
    const selectedModel = await dispatcher.resolveSelectedModel(sessionID);
    const swarm = store.createOrGetSwarm(sessionID, rootDir, selectedModel);
    const created = store.getSwarmBySession(sessionID);
    if (!created) {
      throw new Error(`Failed to initialize swarm for session "${sessionID}".`);
    }
    return created;
  };

  const swarmTool: ToolInfo = {
    name: "swarm",
    description:
      "Manage the mSwarm multi-agent team: set the title, spawn workers (add), inspect status, list models, switch model, kill workers, or manage board channels.",
    input: swarmInput,
    async execute(rawInput: unknown, context: ToolContext) {
      const args = rawInput as SwarmArgs;
      try {
        switch (args.action) {
          case "models": {
            const models = await dispatcher.listModels();
            return {
              content: toJson({
                ok: true,
                count: models.length,
                models,
              }),
            };
          }

          case "title": {
            const title = args.title?.trim();
            if (!title) {
              return { content: toErrorJson('Parameter "title" is required for action "title".') };
            }
            const swarmCtx = await ensureSwarmContext(context.sessionID);
            store.setTitle(swarmCtx.swarm.swarmId, title);
            return {
              content: toJson({
                ok: true,
                swarmId: swarmCtx.swarm.swarmId,
                title,
              }),
            };
          }

          case "add": {
            const name = args.name?.trim();
            const brief = args.brief?.trim();
            if (!name) {
              return { content: toErrorJson('Parameter "name" is required for action "add".') };
            }
            if (!brief) {
              return { content: toErrorJson('Parameter "brief" is required for action "add".') };
            }

            const swarmCtx = await ensureSwarmContext(context.sessionID);
            const result = await dispatcher.addWorkers(context.sessionID, {
              name,
              brief,
              model: args.model,
              fork: args.fork,
              workspace: args.workspace,
              role: args.role,
              n: args.n,
              tasks: args.tasks,
              channels: args.channels,
            });

            return {
              content: toJson({
                ok: result.created.length > 0,
                swarmId: swarmCtx.swarm.swarmId,
                added: result.created.map((member) => ({
                  name: member.name,
                  role: member.role,
                  state: member.state,
                  model: member.model,
                  workspace: member.workspace,
                  workspacePath: member.workspacePath,
                  branchName: member.branchName,
                  channels: member.channels ?? ["main"],
                })),
                failures: result.failures,
                warnings: result.warnings,
                ...(result.created.length === 0 && result.failures.length > 0
                  ? { error: "No workers were started." }
                  : {}),
              }),
            };
          }

          case "status": {
            const swarmCtx = store.getSwarmBySession(context.sessionID);
            if (!swarmCtx) {
              if (isSwarmAgent(context.agent)) {
                return {
                  content: toJson({
                    ok: true,
                    swarmId: context.sessionID,
                    head: 0,
                    members: [
                      {
                        name: "coordinator",
                        role: "coordinator",
                        state: "working",
                        sessionID: context.sessionID,
                        workspace: "inherit",
                      },
                    ],
                    note: "No workers yet. Use swarm add to start the team.",
                  }),
                };
              }
              return {
                content: toErrorJson(
                  `Session "${context.sessionID}" is not part of an active swarm.`,
                ),
              };
            }
            const status = store.getStatus(swarmCtx.swarm.swarmId);
            return { content: toJson({ ok: true, ...status }) };
          }

          case "model": {
            const result = await dispatcher.switchModel(
              context.sessionID,
              args.name,
              args.model,
            );
            return {
              content: toJson({
                ok: true,
                member: result.member.name,
                model: result.model,
                state: result.member.state,
                notified: result.notified,
                ...(result.member.lastError
                  ? { warning: result.member.lastError }
                  : {}),
              }),
            };
          }

          case "kill": {
            const name = args.name?.trim();
            if (!name) {
              return { content: toErrorJson('Parameter "name" is required for action "kill".') };
            }
            const killed = await dispatcher.killWorker(context.sessionID, name);
            return {
              content: toJson({
                ok: true,
                killed: killed.map((member) => member.name),
              }),
            };
          }

          case "channel": {
            const swarmCtx = store.getSwarmBySession(context.sessionID);
            if (!swarmCtx) {
              return {
                content: toErrorJson(
                  `Session "${context.sessionID}" is not part of an active swarm.`,
                ),
              };
            }
            const op = args.op ?? "list";

            if (op === "list") {
              const channels = store.listChannels(swarmCtx.swarm.swarmId);
              return { content: toJson({ ok: true, channels }) };
            }

            const channel = args.channel?.trim();
            if (!channel) {
              return {
                content: toErrorJson(
                  `Parameter "channel" is required for channel op "${op}".`,
                ),
              };
            }

            if (op === "create") {
              const created = store.createChannel(
                swarmCtx.swarm.swarmId,
                channel,
                args.topic?.trim() ?? "",
                swarmCtx.member.name,
              );
              return { content: toJson({ ok: true, channel: created }) };
            }

            const target = args.name?.trim() || swarmCtx.member.name;
            if (
              target !== swarmCtx.member.name &&
              swarmCtx.member.role !== "coordinator"
            ) {
              const targetMember = store.getMember(
                swarmCtx.swarm.swarmId,
                target,
              );
              if (!targetMember || targetMember.parentName !== swarmCtx.member.name) {
                return {
                  content: toErrorJson(
                    `Permission denied: "${swarmCtx.member.name}" cannot manage channels for "${target}".`,
                  ),
                };
              }
            }

            if (op === "join") {
              store.subscribeChannel(swarmCtx.swarm.swarmId, channel, target);
              return {
                content: toJson({
                  ok: true,
                  channel: channel.replace(/^#/, ""),
                  member: target,
                  joined: true,
                }),
              };
            }

            if (op === "leave") {
              store.unsubscribeChannel(swarmCtx.swarm.swarmId, channel, target);
              return {
                content: toJson({
                  ok: true,
                  channel: channel.replace(/^#/, ""),
                  member: target,
                  left: true,
                }),
              };
            }

            if (op === "archive") {
              const archived = store.archiveChannel(
                swarmCtx.swarm.swarmId,
                channel,
              );
              return { content: toJson({ ok: true, channel: archived }) };
            }

            return { content: toErrorJson(`Unsupported channel op "${op}".`) };
          }

          default:
            return {
              content: toErrorJson(`Unsupported swarm action "${args.action}".`),
            };
        }
      } catch (error) {
        return { content: toErrorJson(error) };
      }
    },
  };

  const postMessageTool: ToolInfo = {
    name: "post_message",
    description:
      "Post a message to the shared swarm board (optionally to a channel) and wake matching @mentioned members.",
    input: postMessageInput,
    async execute(rawInput: unknown, context: ToolContext) {
      const args = rawInput as { text: string; channel?: string };
      try {
        const result = await dispatcher.postAndWake(
          context.sessionID,
          args.text,
          args.channel,
        );
        return {
          content: toJson({
            ok: true,
            seq: result.message.seq,
            channel: result.message.channel ?? "main",
            mentions: result.message.mentions,
            woken: result.woken,
          }),
        };
      } catch (error) {
        return { content: toErrorJson(error) };
      }
    },
  };

  const readBoardTool: ToolInfo = {
    name: "read_board",
    description:
      "Read messages from the swarm board (oldest first when `since` is set, otherwise most recent), or inspect your own board state with `status: true`.",
    input: readBoardInput,
    async execute(rawInput: unknown, context: ToolContext) {
      const args = rawInput as {
        since?: number;
        limit?: number;
        seqs?: number[];
        channel?: string;
        status?: boolean;
      };
      try {
        const swarmCtx = store.getSwarmBySession(context.sessionID);
        if (!swarmCtx) {
          if (isSwarmAgent(context.agent)) {
            if (args.status) {
              return {
                content: toJson({
                  ok: true,
                  status: {
                    name: "coordinator",
                    state: "working",
                    wakeMode: "mentions_only",
                    channels: ["main"],
                    brief: undefined,
                  },
                }),
              };
            }
            return {
              content: toJson({
                ok: true,
                messages: [],
                head: 0,
                note: "No workers yet. Use swarm add to start the team.",
              }),
            };
          }
          return {
            content: toErrorJson(
              `Session "${context.sessionID}" is not part of an active swarm.`,
            ),
          };
        }

        if (args.status) {
          const memberStatus = store.readBoard(
            swarmCtx.swarm.swarmId,
            swarmCtx.member.name,
            { status: true },
          );
          return { content: toJson({ ok: true, status: memberStatus }) };
        }

        const result = store.readBoard(
          swarmCtx.swarm.swarmId,
          swarmCtx.member.name,
          {
            since: args.since,
            limit: args.limit,
            seqs: args.seqs,
            channel: args.channel,
          },
        );
        return { content: toJson({ ok: true, ...result }) };
      } catch (error) {
        return { content: toErrorJson(error) };
      }
    },
  };

  const waitTool: ToolInfo = {
    name: "swarm_wait",
    description:
      "Wait for new matching board messages after `since`. Returns immediately if unread messages exist; otherwise parks you until a matching post wakes you. End your turn immediately after a parked result.",
    input: waitInput,
    async execute(rawInput: unknown, context: ToolContext) {
      const args = rawInput as { since: number; mentions_only?: boolean };
      try {
        const result = dispatcher.waitForBoard(
          context.sessionID,
          args.since,
          args.mentions_only ?? true,
        );
        return { content: toJson({ ok: true, ...result }) };
      } catch (error) {
        return { content: toErrorJson(error) };
      }
    },
  };

  return [swarmTool, postMessageTool, readBoardTool, waitTool];
}
