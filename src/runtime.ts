import type { Plugin } from "@opencode/plugin";
import type { ModelRef } from "./types.js";

/**
 * A model entry exposed by `swarm({ action: "models" })`.
 */
export interface AvailableModel {
  providerID: string;
  providerName: string;
  modelID: string;
  modelName: string;
  isDefault?: boolean;
}

/**
 * Minimal session/runtime surface used by the dispatcher.
 *
 * Keeping this small makes the swarm logic testable without an OpenCode
 * server and isolates all OpenCode 2.x API shape conversions here.
 */
export interface SessionRuntime {
  createSession(options: {
    title: string;
    directory: string;
    parentID?: string;
    model?: ModelRef;
  }): Promise<string>;
  promptSession(options: {
    sessionID: string;
    text: string;
    delivery?: "steer" | "queue";
  }): Promise<void>;
  switchModel(sessionID: string, model: ModelRef): Promise<void>;
  interruptSession(sessionID: string): Promise<void>;
  removeSession(sessionID: string): Promise<void>;
  getSessionModel(sessionID: string): Promise<ModelRef | undefined>;
  /** true = running, false = idle, undefined = session missing/unreachable. */
  isSessionBusy(sessionID: string): Promise<boolean | undefined>;
  syntheticMessage(options: {
    sessionID: string;
    text: string;
    description?: string;
  }): Promise<void>;
  listModels(): Promise<AvailableModel[]>;
}

function toApiModel(model: ModelRef): {
  providerID: string;
  id: string;
  variant?: string;
} {
  return {
    providerID: model.providerID,
    id: model.modelID,
    ...(model.variant ? { variant: model.variant } : {}),
  };
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * OpenCode 2.x plugin-context adapter.
 */
export class OpenCodeRuntime implements SessionRuntime {
  private readonly ctx: Plugin.Context;

  constructor(ctx: Plugin.Context) {
    this.ctx = ctx;
  }

  async createSession(options: {
    title: string;
    directory: string;
    parentID?: string;
    model?: ModelRef;
  }): Promise<string> {
    const info = await this.ctx.session.create({
      title: options.title,
      location: { directory: options.directory },
      ...(options.parentID ? { parentID: options.parentID } : {}),
      ...(options.model ? { model: toApiModel(options.model) } : {}),
    });
    if (!info?.id) {
      throw new Error(`Failed to create OpenCode session "${options.title}".`);
    }
    return info.id;
  }

  async promptSession(options: {
    sessionID: string;
    text: string;
    delivery?: "steer" | "queue";
  }): Promise<void> {
    await this.ctx.session.prompt({
      sessionID: options.sessionID,
      text: options.text,
      delivery: options.delivery ?? "queue",
    });
  }

  async switchModel(sessionID: string, model: ModelRef): Promise<void> {
    await this.ctx.session.switchModel({
      sessionID,
      model: toApiModel(model),
    });
  }

  async interruptSession(sessionID: string): Promise<void> {
    await this.ctx.session.interrupt({ sessionID, resume: false });
  }

  async removeSession(sessionID: string): Promise<void> {
    await this.ctx.session.remove({ sessionID });
  }

  async getSessionModel(sessionID: string): Promise<ModelRef | undefined> {
    try {
      const info = await this.ctx.session.get({ sessionID });
      if (!info?.model) {
        return undefined;
      }
      return {
        providerID: info.model.providerID,
        modelID: info.model.id,
        ...(info.model.variant ? { variant: info.model.variant } : {}),
      };
    } catch {
      return undefined;
    }
  }

  async syntheticMessage(options: {
    sessionID: string;
    text: string;
    description?: string;
  }): Promise<void> {
    try {
      await this.ctx.session.synthetic({
        sessionID: options.sessionID,
        text: options.text,
        ...(options.description ? { description: options.description } : {}),
      });
    } catch {
      // Synthetic status is best-effort and must never block the swarm.
    }
  }

  async isSessionBusy(sessionID: string): Promise<boolean | undefined> {
    try {
      const info = await this.ctx.session.get({ sessionID });
      const busy = timestampMs(info?.time?.busy);
      const idle = timestampMs(info?.time?.idle);
      if (busy === undefined) {
        return false;
      }
      // `busy` is the start of the latest execution; `idle` is the end of the
      // previous one. A later idle timestamp means the session is parked.
      return idle === undefined || busy > idle;
    } catch {
      return undefined;
    }
  }

  async listModels(): Promise<AvailableModel[]> {
    try {
      const [modelsResult, defaultResult] = await Promise.all([
        this.ctx.model.list({ types: ["chat"] }),
        this.ctx.model.default().catch(() => undefined),
      ]);
      const models = modelsResult?.data ?? [];
      const defaultModel = defaultResult?.data;
      const available = models.filter(
        (model) =>
          model.enabled !== false &&
          model.capabilities?.tools !== false,
      );
      return available.map((model) => {
        const modelID = model.modelID || model.id;
        return {
          providerID: model.providerID,
          providerName: model.providerID,
          modelID,
          modelName: model.name || modelID,
          isDefault:
            defaultModel?.providerID === model.providerID &&
            (defaultModel.modelID || defaultModel.id) === modelID,
        };
      });
    } catch {
      return [];
    }
  }
}
