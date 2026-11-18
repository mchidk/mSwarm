import { buildWakeupPrompt, buildWorkerKickoff } from "./prompts.js";
import type {
  AvailableModel,
  SessionRuntime,
} from "./runtime.js";
import type {
  PostMessageResult,
  StoredSwarmMember,
  StoredSwarmState,
  SwarmStore,
} from "./store.js";
import type {
  AddWorkerFailure,
  AddWorkerOptions,
  AddWorkersResult,
  BoardMessage,
  ModelRef,
  WakeMode,
} from "./types.js";
import type { WorkspaceManager } from "./workspace.js";

export type { AvailableModel } from "./runtime.js";

/**
 * Result of calling `SwarmDispatcher.waitForBoard()`.
 */
export type WaitForBoardResult =
  | {
      status: "messages";
      messages: BoardMessage[];
      head: number;
      truncated?: number;
    }
  | {
      status: "parked";
      since: number;
    };

const MAX_WAKE_MESSAGES = 100;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function takeBatch(messages: BoardMessage[]): {
  batch: BoardMessage[];
  remaining: number;
} {
  if (messages.length <= MAX_WAKE_MESSAGES) {
    return { batch: messages, remaining: 0 };
  }
  return {
    batch: messages.slice(0, MAX_WAKE_MESSAGES),
    remaining: messages.length - MAX_WAKE_MESSAGES,
  };
}

function firstLine(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function activeMembersSummary(swarm: StoredSwarmState): string {
  const active = Object.values(swarm.members).filter(
    (member) => member.role !== "coordinator" && member.state !== "killed",
  );
  if (active.length === 0) {
    return "no active workers";
  }
  return active
    .map(
      (member) =>
        `@${member.name} ${member.state}${
          member.brief ? ` (${firstLine(member.brief, 80)})` : ""
        }`,
    )
    .join("; ");
}

function normalizeVariant(variant: string | undefined): string {
  return !variant || variant === "default" ? "" : variant;
}

function sameModel(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  if (!a || !b) {
    return a === b;
  }
  return (
    a.providerID === b.providerID &&
    a.modelID === b.modelID &&
    normalizeVariant(a.variant) === normalizeVariant(b.variant)
  );
}

/**
 * Coordinates OpenCode sessions, SwarmStore state, and WorkspaceManager worktrees.
 *
 * Author: Michael Christensen
 */
export class SwarmDispatcher {
  private readonly sessionModels = new Map<string, ModelRef>();
  private readonly runtime: SessionRuntime;
  private readonly store: SwarmStore;
  private readonly workspace: WorkspaceManager;

  constructor(
    runtime: SessionRuntime,
    store: SwarmStore,
    workspace: WorkspaceManager,
  ) {
    this.runtime = runtime;
    this.store = store;
    this.workspace = workspace;
  }

  /**
   * Records the active model for a session so spawned workers can inherit it.
   */
  recordSessionModel(sessionID: string, model: ModelRef): void {
    this.sessionModels.set(sessionID, { ...model });

    const ctx = this.store.getSwarmBySession(sessionID);
    if (!ctx) {
      return;
    }
    const { swarm, member } = ctx;
    if (member.role === "coordinator") {
      if (
        !sameModel(swarm.selectedModel, model) ||
        !sameModel(member.model, model)
      ) {
        this.store.setCoordinatorModel(swarm.swarmId, model);
      }
      return;
    }
    if (!sameModel(member.model, model)) {
      this.store.updateMember(swarm.swarmId, member.name, { model });
    }
  }

  /**
   * Resolves the selected model for a session from cache, store, or OpenCode.
   */
  async resolveSelectedModel(sessionID: string): Promise<ModelRef | undefined> {
    const cached = this.sessionModels.get(sessionID);
    if (cached) {
      return cached;
    }

    const ctx = this.store.getSwarmBySession(sessionID);
    if (ctx?.member.model) {
      this.sessionModels.set(sessionID, ctx.member.model);
      return ctx.member.model;
    }
    if (ctx?.swarm.selectedModel) {
      this.sessionModels.set(sessionID, ctx.swarm.selectedModel);
      return ctx.swarm.selectedModel;
    }

    const resolved = await this.runtime.getSessionModel(sessionID);
    if (resolved) {
      this.sessionModels.set(sessionID, resolved);
    }
    return resolved;
  }

  /**
   * Lists available models from configured OpenCode providers.
   */
  async listModels(): Promise<AvailableModel[]> {
    return this.runtime.listModels();
  }

  /**
   * Parses a `providerID/modelID` string or matches a model by ID or name.
   */
  async resolveModelRef(
    modelInput: string | ModelRef | undefined,
    fallback: ModelRef,
  ): Promise<ModelRef>;
  async resolveModelRef(
    modelInput: string | ModelRef | undefined,
    fallback?: ModelRef,
  ): Promise<ModelRef | undefined>;
  async resolveModelRef(
    modelInput: string | ModelRef | undefined,
    fallback?: ModelRef,
  ): Promise<ModelRef | undefined> {
    if (!modelInput) {
      return fallback;
    }
    if (typeof modelInput !== "string") {
      return modelInput;
    }

    const trimmed = modelInput.trim();
    if (!trimmed) {
      return fallback;
    }

    const hashIndex = trimmed.indexOf("#");
    const variant =
      hashIndex > 0 && hashIndex < trimmed.length - 1
        ? trimmed.slice(hashIndex + 1).trim()
        : undefined;
    const base = hashIndex > 0 ? trimmed.slice(0, hashIndex).trim() : trimmed;

    const slashIndex = base.indexOf("/");
    if (slashIndex > 0 && slashIndex < base.length - 1) {
      return {
        providerID: base.slice(0, slashIndex).trim(),
        modelID: base.slice(slashIndex + 1).trim(),
        ...(variant ? { variant } : {}),
      };
    }

    const available = await this.listModels();
    const lower = base.toLowerCase();

    const exactId =
      available.find((model) => model.modelID === base) ??
      available.find((model) => model.modelID.toLowerCase() === lower);
    if (exactId) {
      return {
        providerID: exactId.providerID,
        modelID: exactId.modelID,
        ...(variant ? { variant } : {}),
      };
    }

    const exactName = available.find(
      (model) => model.modelName.toLowerCase() === lower,
    );
    if (exactName) {
      return {
        providerID: exactName.providerID,
        modelID: exactName.modelID,
        ...(variant ? { variant } : {}),
      };
    }

    const partial = available.filter(
      (model) =>
        model.modelID.toLowerCase().includes(lower) ||
        model.modelName.toLowerCase().includes(lower),
    );
    if (partial.length === 1) {
      const match = partial[0]!;
      return {
        providerID: match.providerID,
        modelID: match.modelID,
        ...(variant ? { variant } : {}),
      };
    }
    if (partial.length > 1) {
      const examples = partial
        .slice(0, 5)
        .map((model) => `${model.providerID}/${model.modelID}`)
        .join(", ");
      throw new Error(
        `Model "${modelInput}" is ambiguous. Matches: ${examples}. Use providerID/modelID.`,
      );
    }

    throw new Error(
      `Unknown model "${modelInput}". Use swarm{action:"models"} to inspect available models.`,
    );
  }

  private buildSpecs(opts: AddWorkerOptions): Array<{ name: string; brief: string }> {
    const maxWorkers = 32;
    if (opts.tasks && opts.tasks.length > 0) {
      if (opts.tasks.length > maxWorkers) {
        throw new Error(`Too many tasks (${opts.tasks.length}); maximum is ${maxWorkers}.`);
      }
      return opts.tasks.map((task, index) => ({
        name: `${opts.name}-${index + 1}`,
        brief: `${opts.brief}\n\nAssigned slice (${index + 1}/${opts.tasks!.length}): ${task}`,
      }));
    }

    if (opts.n && opts.n > 1) {
      if (opts.n > maxWorkers) {
        throw new Error(`Too many workers (${opts.n}); maximum is ${maxWorkers}.`);
      }
      return Array.from({ length: opts.n }, (_, index) => ({
        name: `${opts.name}-${index + 1}`,
        brief: opts.brief,
      }));
    }

    return [{ name: opts.name, brief: opts.brief }];
  }

  /**
   * Spawns one or more workers (single, `n` copies, or `tasks` sharded),
   * prepares workspaces, posts briefs to the board, and starts their OpenCode
   * sessions.
   */
  async addWorkers(
    callerSessionID: string,
    opts: AddWorkerOptions,
  ): Promise<AddWorkersResult> {
    const callerCtx = this.store.getSwarmBySession(callerSessionID);
    if (!callerCtx) {
      throw new Error(
        `Session "${callerSessionID}" is not part of an active swarm.`,
      );
    }

    const { swarm, member: caller } = callerCtx;
    this.store.validateMemberName(opts.name);
    const brief = opts.brief.trim();
    if (!brief) {
      throw new Error("Worker brief cannot be empty.");
    }
    if (brief.length > 32_000) {
      throw new Error(
        `Worker brief is too long (${brief.length} characters; maximum is 32,000).`,
      );
    }

    const specs = this.buildSpecs(opts);
    this.store.assertMemberNamesAvailable(
      swarm.swarmId,
      specs.map((spec) => spec.name),
    );

    const fallbackModel =
      (await this.resolveSelectedModel(callerSessionID)) ?? swarm.selectedModel;
    const targetModel = await this.resolveModelRef(opts.model, fallbackModel);
    const workspaceMode = opts.workspace ?? "inherit";

    let forkParentSessionID: string | undefined;
    let forkFrom: string | undefined;
    if (opts.fork) {
      if (opts.fork === "coordinator") {
        forkParentSessionID = swarm.coordinatorSessionID;
        forkFrom = "coordinator";
      } else {
        const forkTarget = this.store.getMember(swarm.swarmId, opts.fork);
        if (!forkTarget || forkTarget.state === "killed") {
          throw new Error(
            `Cannot fork from "${opts.fork}": member not found or already killed.`,
          );
        }
        forkParentSessionID = forkTarget.sessionID;
        forkFrom = forkTarget.name;
      }
    }

    const created: StoredSwarmMember[] = [];
    const failures: AddWorkerFailure[] = [];
    const warnings: string[] = [];

    for (const spec of specs) {
      let prepared: Awaited<ReturnType<WorkspaceManager["prepareWorkspace"]>>;
      try {
        prepared = await this.workspace.prepareWorkspace(
          swarm.rootDirectory,
          swarm.swarmId,
          spec.name,
          workspaceMode,
        );
      } catch (error) {
        failures.push({
          name: spec.name,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (prepared.warning) {
        warnings.push(`${spec.name}: ${prepared.warning}`);
      }

      let sessionID: string;
      try {
        sessionID = await this.runtime.createSession({
          title: `swarm:${spec.name}`,
          directory: prepared.workspacePath,
          parentID: forkParentSessionID ?? callerSessionID,
          ...(targetModel ? { model: targetModel } : {}),
        });
      } catch (error) {
        failures.push({
          name: spec.name,
          error: `Failed to create session: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        if (workspaceMode !== "inherit") {
          await this.workspace
            .cleanupWorkspace(
              swarm.rootDirectory,
              prepared.workspacePath,
              prepared.branchName,
              { deleteBranch: true },
            )
            .catch(() => {});
        }
        continue;
      }

      let member: StoredSwarmMember;
      try {
        member = this.store.addMember(swarm.swarmId, {
          name: spec.name,
          role: opts.role ?? "worker",
          state: "working",
          sessionID,
          parentName: caller.name,
          model: targetModel,
          workspace: workspaceMode,
          workspacePath: prepared.workspacePath,
          branchName: prepared.branchName,
          wakeMode: "mentions_only",
          brief: spec.brief,
          channels: opts.channels,
          addedBy: caller.name,
          forkFrom,
        });
      } catch (error) {
        failures.push({
          name: spec.name,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.runtime.removeSession(sessionID).catch(() => {});
        if (workspaceMode !== "inherit") {
          await this.workspace
            .cleanupWorkspace(
              swarm.rootDirectory,
              prepared.workspacePath,
              prepared.branchName,
              { deleteBranch: true },
            )
            .catch(() => {});
        }
        continue;
      }

      if (targetModel) {
        this.sessionModels.set(sessionID, targetModel);
      }

      let briefSeq: number | undefined;
      try {
        const posted = this.store.postMessage(
          swarm.swarmId,
          caller.name,
          `@${spec.name} ${spec.brief}`,
          "main",
          { mentions: [spec.name] },
        );
        // The initial prompt already contains the brief. Mark it read so a
        // completed execution does not deliver the assignment a second time.
        this.store.updateMember(swarm.swarmId, member.name, {
          lastReadSeq: posted.message.seq,
        });
        briefSeq = posted.message.seq;
      } catch (error) {
        warnings.push(
          `${spec.name}: failed to post brief to board: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const refreshed =
        this.store.getMember(swarm.swarmId, member.name) ?? member;
      // The assignment and contract are injected as the worker's system
      // prompt on every request (see the plugin's context hook), so the
      // first user message only starts the work instead of repeating a brief
      // of up to 32k characters in the history.
      const promptText = buildWorkerKickoff(
        refreshed,
        briefSeq,
        { warning: prepared.warning, linkedDependencies: prepared.linkedDependencies },
      );

      try {
        await this.runtime.promptSession({
          sessionID,
          text: promptText,
          delivery: "queue",
        });
        const liveSwarm = this.store.getSwarm(swarm.swarmId) ?? swarm;
        await this.runtime.syntheticMessage({
          sessionID: liveSwarm.coordinatorSessionID,
          text: `[mSwarm] Spawned @${refreshed.name} (${workspaceMode}${
            refreshed.branchName ? `, branch ${refreshed.branchName}` : ""
          }): ${firstLine(spec.brief)}. Active: ${activeMembersSummary(
            liveSwarm,
          )}. Head #${liveSwarm.headSeq}.`,
          description: "mSwarm worker spawned",
        });
        created.push(refreshed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.updateMember(swarm.swarmId, member.name, {
          state: "stopped",
          lastError: `Failed to start session: ${message}`,
        });
        failures.push({
          name: spec.name,
          error: `Failed to start session: ${message}`,
        });
        await this.runtime.removeSession(sessionID).catch(() => {});
        if (workspaceMode !== "inherit") {
          await this.workspace
            .cleanupWorkspace(
              swarm.rootDirectory,
              prepared.workspacePath,
              prepared.branchName,
              { deleteBranch: true },
            )
            .catch(() => {});
        }
        this.store.updateMember(swarm.swarmId, member.name, {
          state: "killed",
          killedAt: new Date().toISOString(),
        });
      }
    }

    if (opts.channels && opts.channels.length > 0) {
      for (const member of created) {
        for (const channel of opts.channels) {
          try {
            this.store.subscribeChannel(swarm.swarmId, channel, member.name);
          } catch (error) {
            warnings.push(
              `${member.name}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    }

    return { created, failures, warnings };
  }

  /**
   * Switches a waiting worker (or the caller itself) to another model while
   * preserving its session history.
   */
  async switchModel(
    callerSessionID: string,
    targetName?: string,
    modelStr?: string,
  ): Promise<{ member: StoredSwarmMember; model: ModelRef; notified: boolean }> {
    const callerCtx = this.store.getSwarmBySession(callerSessionID);
    if (!callerCtx) {
      throw new Error(
        `Session "${callerSessionID}" is not part of an active swarm.`,
      );
    }

    const { swarm, member: caller } = callerCtx;
    const resolvedName = targetName?.trim() || caller.name;
    const target = this.store.getMember(swarm.swarmId, resolvedName);
    if (!target) {
      throw new Error(
        `Member "${resolvedName}" not found in swarm "${swarm.swarmId}".`,
      );
    }

    const isSelf = target.name === caller.name;
    if (
      !isSelf &&
      caller.role !== "coordinator" &&
      target.parentName !== caller.name
    ) {
      throw new Error(
        `Permission denied: "${caller.name}" can only switch models for itself or helpers it added.`,
      );
    }

    if (target.state === "killed") {
      throw new Error(`Cannot switch model for killed member "${target.name}".`);
    }
    if (!isSelf && target.state === "working") {
      throw new Error(
        `Member "${target.name}" is currently working. Wait until it is waiting before switching its model.`,
      );
    }

    const fallback =
      swarm.selectedModel ?? (await this.resolveSelectedModel(callerSessionID));
    const newModel = modelStr
      ? await this.resolveModelRef(modelStr, fallback)
      : fallback;

    if (!newModel) {
      throw new Error("Could not resolve a target model.");
    }

    await this.runtime.switchModel(target.sessionID, newModel);
    this.sessionModels.set(target.sessionID, newModel);

    if (target.role === "coordinator") {
      this.store.setSelectedModel(swarm.swarmId, newModel);
    }

    let updated = this.store.updateMember(swarm.swarmId, target.name, {
      model: newModel,
      state: "working",
      waitingSinceSeq: undefined,
      lastError: undefined,
    });

    const notice = `[swarm notice] Your model has been switched to ${newModel.providerID}/${newModel.modelID}. Resume any unfinished work or call \`swarm_wait\` if idle.`;
    let notified = true;
    try {
      await this.runtime.promptSession({
        sessionID: target.sessionID,
        text: notice,
        delivery: "queue",
        metadata: { mswarmControl: true },
      });
    } catch (error) {
      notified = false;
      updated = this.store.updateMember(swarm.swarmId, target.name, {
        state: "stopped",
        lastError: `Model switched, but the session could not be notified: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }

    return { member: updated, model: newModel, notified };
  }

  /**
   * Permanently kills a worker (or numbered group prefix), aborts its session,
   * and cleans up its workspace.
   */
  async killWorker(
    callerSessionID: string,
    targetName: string,
  ): Promise<StoredSwarmMember[]> {
    const callerCtx = this.store.getSwarmBySession(callerSessionID);
    if (!callerCtx) {
      throw new Error(
        `Session "${callerSessionID}" is not part of an active swarm.`,
      );
    }

    const { swarm, member: caller } = callerCtx;
    const exact = swarm.members[targetName];
    const targets: StoredSwarmMember[] = exact
      ? [exact]
      : Object.values(swarm.members).filter((member) =>
          new RegExp(`^${escapeRegex(targetName)}-\\d+$`).test(member.name),
        );

    if (targets.length === 0) {
      throw new Error(
        `Member "${targetName}" not found in swarm "${swarm.swarmId}".`,
      );
    }

    // Validate the whole batch before side effects.
    for (const target of targets) {
      if (target.role === "coordinator") {
        throw new Error("Cannot kill the coordinator.");
      }
      if (
        caller.role !== "coordinator" &&
        target.parentName !== caller.name
      ) {
        throw new Error(
          `Permission denied: "${caller.name}" can only kill helpers it added.`,
        );
      }
    }

    const killed: StoredSwarmMember[] = [];
    for (const target of targets) {
      if (target.state === "killed") {
        continue;
      }

      await this.runtime.interruptSession(target.sessionID).catch(() => {});

      if (target.workspacePath && target.workspace !== "inherit") {
        await this.workspace
          .cleanupWorkspace(
            swarm.rootDirectory,
            target.workspacePath,
            target.branchName,
          )
          .catch(() => {});
      }

      const updated = this.store.updateMember(swarm.swarmId, target.name, {
        state: "killed",
        waitingSinceSeq: undefined,
        killedAt: new Date().toISOString(),
      });
      killed.push(updated);

      const liveSwarm = this.store.getSwarm(swarm.swarmId) ?? swarm;
      await this.runtime.syntheticMessage({
        sessionID: liveSwarm.coordinatorSessionID,
        text: `[mSwarm] Killed @${target.name}. Active: ${activeMembersSummary(
          liveSwarm,
        )}. Head #${liveSwarm.headSeq}.`,
        description: "mSwarm worker killed",
      });
    }

    return killed;
  }

  /**
   * Posts a message to the board and wakes any waiting/stopped matching recipients.
   */
  async postAndWake(
    callerSessionID: string,
    text: string,
    channel?: string,
  ): Promise<PostMessageResult & { woken: string[] }> {
    const callerCtx = this.store.getSwarmBySession(callerSessionID);
    if (!callerCtx) {
      throw new Error(
        `Session "${callerSessionID}" is not part of an active swarm.`,
      );
    }

    const { swarm } = callerCtx;
    const result = this.store.postMessage(
      swarm.swarmId,
      callerCtx.member.name,
      text,
      channel,
    );
    // Re-read after the write in case another plugin instance refreshed the
    // state while this call was in flight.
    const freshSwarm = this.store.getSwarm(swarm.swarmId) ?? swarm;

    const woken: string[] = [];
    for (const recipient of result.recipientsToWake) {
      // Re-read the member: another instance may have advanced its watermark
      // or resumed it between the post and the wake attempt.
      const current = freshSwarm.members[recipient.name] ?? recipient;
      if (current.state !== "waiting" && current.state !== "stopped") {
        continue;
      }
      const unread = this.store.getMatchingMessages(
        freshSwarm,
        current,
        Math.max(current.lastReadSeq ?? 0, current.waitingSinceSeq ?? 0),
        current.wakeMode !== "all",
      );
      const { batch, remaining } = takeBatch(
        unread.length > 0 ? unread : [result.message],
      );
      const didWake = await this.wakeMember(
        freshSwarm,
        current,
        batch,
        remaining,
      );
      if (didWake) {
        woken.push(current.name);
      }
    }

    return { ...result, woken };
  }

  /**
   * Returns matching messages after `since` immediately if any exist, or parks
   * the caller.
   */
  waitForBoard(
    callerSessionID: string,
    since: number,
    mentionsOnly: boolean = true,
  ): WaitForBoardResult {
    const callerCtx = this.store.getSwarmBySession(callerSessionID);
    if (!callerCtx) {
      throw new Error(
        `Session "${callerSessionID}" is not part of an active swarm.`,
      );
    }

    const { swarm, member } = callerCtx;
    const wakeMode: WakeMode = mentionsOnly ? "mentions_only" : "all";
    // A model occasionally passes a future or stale seq. Treat anything past
    // the head as "caught up" so the wait can still be woken by the next post,
    // and never go below what was already delivered (for example the initial
    // brief, or a wakeup batch), so `since: 0` does not replay old messages.
    const normalizedSince = Math.max(
      0,
      Math.min(since, swarm.headSeq),
      Math.min(member.lastReadSeq ?? 0, swarm.headSeq),
    );
    const matching = this.store.getMatchingMessages(
      swarm,
      member,
      normalizedSince,
      mentionsOnly,
    );

    if (matching.length > 0) {
      const { batch, remaining } = takeBatch(matching);
      const lastSeq = batch[batch.length - 1]!.seq;
      this.store.updateMember(swarm.swarmId, member.name, {
        lastReadSeq: Math.max(member.lastReadSeq ?? 0, lastSeq),
        wakeMode,
        state: "working",
        waitingSinceSeq: undefined,
      });
      return {
        status: "messages",
        messages: batch,
        head: swarm.headSeq,
        ...(remaining > 0 ? { truncated: remaining } : {}),
      };
    }

    this.store.updateMember(swarm.swarmId, member.name, {
      state: "waiting",
      waitingSinceSeq: normalizedSince,
      wakeMode,
    });

    return {
      status: "parked",
      since: normalizedSince,
    };
  }

  /**
   * Reconciles members left in `working` after a plugin reload. Only idle
   * sessions are advanced, so a genuinely running session is left alone.
   */
  async reconcileOnStartup(): Promise<void> {
    for (const swarm of this.store.listSwarms()) {
      for (const member of Object.values(swarm.members)) {
        if (member.state !== "working") {
          continue;
        }
        const busy = await this.runtime.isSessionBusy(member.sessionID);
        if (busy === false) {
          await this.handleSessionIdle(member.sessionID);
        } else if (busy === undefined) {
          this.store.updateMember(swarm.swarmId, member.name, {
            state: "stopped",
            lastError: "Session is no longer reachable.",
          });
        }
      }
    }
  }

  /**
   * Handles a completed OpenCode execution: wakes members with unread matching
   * messages, otherwise transitions them to `waiting`.
   */
  async handleSessionIdle(sessionID: string): Promise<void> {
    const ctx = this.store.getSwarmBySession(sessionID);
    if (!ctx) {
      return;
    }

    const { swarm, member } = ctx;
    if (member.state === "killed" || member.state !== "working") {
      return;
    }

    const since = Math.max(
      member.waitingSinceSeq ?? 0,
      member.lastReadSeq ?? 0,
    );
    const mentionsOnly = member.wakeMode !== "all";
    const unread = this.store.getMatchingMessages(
      swarm,
      member,
      since,
      mentionsOnly,
    );

    if (unread.length > 0) {
      const { batch, remaining } = takeBatch(unread);
      await this.wakeMember(swarm, member, batch, remaining);
      return;
    }

    this.store.updateMember(swarm.swarmId, member.name, {
      state: "waiting",
      waitingSinceSeq: Math.max(
        member.waitingSinceSeq ?? 0,
        member.lastReadSeq ?? 0,
        swarm.headSeq,
      ),
    });
  }

  /**
   * Handles model-selection events so workers inherit mid-session changes.
   */
  handleSessionModelSelected(sessionID: string, model: ModelRef): void {
    this.recordSessionModel(sessionID, model);
  }

  /**
   * Reports a failed worker session to its parent and marks the worker stopped.
   */
  async handleSessionFailure(
    sessionID: string,
    error: string,
  ): Promise<void> {
    const ctx = this.store.getSwarmBySession(sessionID);
    if (!ctx) {
      return;
    }
    const { swarm, member } = ctx;
    if (member.state === "killed") {
      return;
    }

    this.store.updateMember(swarm.swarmId, member.name, {
      state: "stopped",
      lastError: error.slice(0, 500),
      waitingSinceSeq: undefined,
    });

    await this.runtime.syntheticMessage({
      sessionID: swarm.coordinatorSessionID,
      text: `[mSwarm] Error: @${member.name} failed - ${firstLine(error, 160)}`,
      description: "mSwarm worker error",
    });

    if (member.role === "coordinator") {
      return;
    }

    const parent = member.parentName ?? "coordinator";
    try {
      await this.postAndWake(
        sessionID,
        `@${parent} [error] Worker session encountered an error: ${error}`,
      );
    } catch {
      // Ignore board notification failures during error handling.
    }
  }

  /**
   * Handles a user interrupt: workers stop cleanly; the coordinator is simply idle.
   */
  handleSessionInterrupted(sessionID: string): void {
    const ctx = this.store.getSwarmBySession(sessionID);
    if (!ctx) {
      return;
    }
    const { swarm, member } = ctx;
    if (member.state === "killed") {
      return;
    }
    if (member.role === "coordinator") {
      this.store.updateMember(swarm.swarmId, member.name, {
        state: "waiting",
        waitingSinceSeq: swarm.headSeq,
      });
    } else {
      this.store.updateMember(swarm.swarmId, member.name, {
        state: "stopped",
        waitingSinceSeq: undefined,
      });
    }
  }

  /**
   * Marks a removed OpenCode session as killed and cleans up its worktree.
   */
  async handleSessionDeleted(sessionID: string): Promise<void> {
    const ctx = this.store.getSwarmBySession(sessionID);
    if (!ctx) {
      return;
    }
    const { swarm, member } = ctx;
    if (member.state === "killed") {
      return;
    }

    if (member.role === "coordinator") {
      for (const other of Object.values(swarm.members)) {
        if (other.workspacePath && other.workspace !== "inherit") {
          await this.workspace
            .cleanupWorkspace(
              swarm.rootDirectory,
              other.workspacePath,
              other.branchName,
            )
            .catch(() => {});
        }
      }
      this.store.deleteSwarm(swarm.swarmId);
      return;
    }

    this.store.updateMember(swarm.swarmId, member.name, {
      state: "killed",
      waitingSinceSeq: undefined,
      killedAt: new Date().toISOString(),
    });
    if (member.workspacePath && member.workspace !== "inherit") {
      await this.workspace
        .cleanupWorkspace(
          swarm.rootDirectory,
          member.workspacePath,
          member.branchName,
        )
        .catch(() => {});
    }
    const liveSwarm = this.store.getSwarm(swarm.swarmId) ?? swarm;
    await this.runtime.syntheticMessage({
      sessionID: liveSwarm.coordinatorSessionID,
      text: `[mSwarm] Removed @${member.name} (session deleted). Active: ${activeMembersSummary(
        liveSwarm,
      )}.`,
      description: "mSwarm worker session deleted",
    });
  }

  private async wakeMember(
    swarm: StoredSwarmState,
    member: StoredSwarmMember,
    messages: BoardMessage[],
    remaining: number = 0,
  ): Promise<boolean> {
    const latest = this.store.getMember(swarm.swarmId, member.name) ?? member;
    if (latest.state === "killed") {
      return false;
    }
    const lastSeq = messages[messages.length - 1]?.seq ?? swarm.headSeq;

    // Mark working before prompting so concurrent posts do not double-wake.
    this.store.updateMember(swarm.swarmId, latest.name, {
      state: "working",
      waitingSinceSeq: undefined,
    });

    const model =
      latest.model ??
      swarm.selectedModel ??
      (await this.resolveSelectedModel(latest.sessionID));
    const basePrompt = buildWakeupPrompt(latest, messages);
    const promptText =
      remaining > 0
        ? `${basePrompt}\n\n[${remaining} more unread board message(s) are waiting. Finish this batch, then read or wait again.]`
        : basePrompt;

    try {
      await this.runtime.promptSession({
        sessionID: latest.sessionID,
        text: promptText,
        delivery: "queue",
        metadata: { mswarmWake: true },
      });
      const current =
        this.store.getMember(swarm.swarmId, latest.name) ?? latest;
      if (current.state === "killed") {
        return true;
      }
      // Only advance the read watermark after the wake was accepted, so a
      // failed delivery can be retried by a later post.
      this.store.updateMember(swarm.swarmId, latest.name, {
        state: "working",
        waitingSinceSeq: undefined,
        lastReadSeq: Math.max(current.lastReadSeq ?? 0, lastSeq),
        lastError: undefined,
        ...(model && !current.model ? { model } : {}),
      });
      return true;
    } catch (error) {
      const current =
        this.store.getMember(swarm.swarmId, latest.name) ?? latest;
      if (current.state !== "killed") {
        this.store.updateMember(swarm.swarmId, latest.name, {
          state: "stopped",
          lastError: `Wake failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
      return false;
    }
  }
}
