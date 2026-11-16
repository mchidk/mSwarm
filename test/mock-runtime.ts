import type { AvailableModel, SessionRuntime } from "../src/runtime.js";
import type { ModelRef } from "../src/types.js";

/**
 * In-memory SessionRuntime used by the test suite.
 */
export class MockRuntime implements SessionRuntime {
  createdSessions: Array<{
    id: string;
    title: string;
    directory: string;
    parentID?: string;
    model?: ModelRef;
  }> = [];
  prompts: Array<{
    sessionID: string;
    text: string;
    delivery?: "steer" | "queue";
  }> = [];
  switched: Array<{ sessionID: string; model: ModelRef }> = [];
  interrupted: string[] = [];
  removed: string[] = [];
  syntheticMessages: Array<{
    sessionID: string;
    text: string;
    description?: string;
  }> = [];
  private readonly models = new Map<string, ModelRef>();
  private nextId = 1;
  busySessions = new Set<string>();
  missingSessions = new Set<string>();

  failPromptForSession?: string;
  failPromptForName?: string;
  failCreateForTitle?: string;

  modelsList: AvailableModel[] = [
    {
      providerID: "anthropic",
      providerName: "anthropic",
      modelID: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
      isDefault: true,
    },
    {
      providerID: "openai",
      providerName: "openai",
      modelID: "gpt-5",
      modelName: "GPT-5",
    },
    {
      providerID: "openai",
      providerName: "openai",
      modelID: "gpt-5-mini",
      modelName: "GPT-5 mini",
    },
  ];

  async createSession(options: {
    title: string;
    directory: string;
    parentID?: string;
    model?: ModelRef;
  }): Promise<string> {
    if (this.failCreateForTitle && options.title.includes(this.failCreateForTitle)) {
      throw new Error("Session creation failed");
    }
    const id = `worker-sess-${this.nextId++}`;
    this.createdSessions.push({ id, ...options });
    if (options.model) {
      this.models.set(id, options.model);
    }
    return id;
  }

  async promptSession(options: {
    sessionID: string;
    text: string;
    delivery?: "steer" | "queue";
  }): Promise<void> {
    if (
      this.failPromptForSession === options.sessionID ||
      (this.failPromptForName &&
        options.text.includes(`@${this.failPromptForName}`))
    ) {
      throw new Error("Session unreachable");
    }
    this.prompts.push(options);
  }

  async switchModel(sessionID: string, model: ModelRef): Promise<void> {
    this.switched.push({ sessionID, model });
    this.models.set(sessionID, model);
  }

  async interruptSession(sessionID: string): Promise<void> {
    this.interrupted.push(sessionID);
  }

  async removeSession(sessionID: string): Promise<void> {
    this.removed.push(sessionID);
    this.models.delete(sessionID);
  }

  async getSessionModel(sessionID: string): Promise<ModelRef | undefined> {
    return this.models.get(sessionID);
  }

  async syntheticMessage(options: {
    sessionID: string;
    text: string;
    description?: string;
  }): Promise<void> {
    this.syntheticMessages.push(options);
  }

  async isSessionBusy(sessionID: string): Promise<boolean | undefined> {
    if (this.missingSessions.has(sessionID)) {
      return undefined;
    }
    return this.busySessions.has(sessionID);
  }

  async listModels(): Promise<AvailableModel[]> {
    return this.modelsList;
  }

  setSessionModel(sessionID: string, model: ModelRef): void {
    this.models.set(sessionID, model);
  }
}
