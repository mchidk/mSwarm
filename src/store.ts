/// <reference types="node" />
import fs from "node:fs";
import path from "node:path";
import type {
  AddWorkerOptions,
  BoardChannel,
  BoardMessage,
  MemberRole,
  MemberState,
  ModelRef,
  ReadBoardOptions,
  SwarmMember,
  SwarmState,
  SwarmStatusEntry,
  WakeMode,
  WorkspaceMode,
} from "./types.js";

/**
 * Persistent JSON-backed store for mSwarm state, channels, members, and board messages.
 *
 * State is written atomically (write + fsync + rename) and the rename is retried on
 * Windows, where antivirus/indexer file handles can briefly produce EPERM/EACCES.
 *
 * Author: Michael Christensen
 */

const STATE_VERSION = 2;
const MAX_BOARD_MESSAGES = 2000;
const MAX_MESSAGE_CHARS = 64_000;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_NAMES = new Set(["all", "coordinator", "self", "system"]);

/** Synchronous sleep used only by the atomic-write retry path. */
const retrySleep = new Int32Array(new SharedArrayBuffer(4));

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "swarm";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}

function sleepSync(ms: number): void {
  Atomics.wait(retrySleep, 0, 0, ms);
}

function isRetryableRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

/**
 * Extended member metadata persisted by SwarmStore.
 */
export type StoredSwarmMember = SwarmMember;

/**
 * Extended channel metadata persisted by SwarmStore.
 */
export interface StoredBoardChannel extends BoardChannel {
  topic?: string;
  creator?: string;
  archived?: boolean;
  subscribers?: string[];
}

/**
 * Extended swarm state persisted by SwarmStore.
 */
export interface StoredSwarmState extends SwarmState {
  selectedModel?: ModelRef;
  channels: StoredBoardChannel[];
  members: Record<string, StoredSwarmMember>;
  /** Incremented on every write so separate plugin instances can detect changes. */
  revision?: number;
}

/**
 * Options for reading the swarm message board.
 */
export interface StoreReadBoardOptions extends ReadBoardOptions {
  status?: boolean;
}

/**
 * Status view returned when readBoard is called with status: true.
 */
export interface MemberBoardStatus {
  name: string;
  state: MemberState;
  wakeMode: WakeMode;
  waitSince?: number;
  lastReadSeq?: number;
  lastPostSeq?: number;
  channels: string[];
  brief?: string;
}

/**
 * Result of reading board messages.
 */
export interface ReadBoardResult {
  messages: BoardMessage[];
  head: number;
}

/**
 * Result of posting a message to the board.
 */
export interface PostMessageResult {
  message: BoardMessage;
  recipientsToWake: StoredSwarmMember[];
}

/**
 * Options for posting a message.
 */
export interface PostMessageOptions {
  /**
   * Override mention parsing. Used for assignment messages so text inside a
   * brief cannot accidentally wake unrelated workers.
   */
  mentions?: string[];
}

/**
 * Full status summary for a swarm.
 */
export interface SwarmStatusResult {
  swarmId: string;
  title?: string;
  selectedModel?: ModelRef;
  head: number;
  members: SwarmStatusEntry[];
}

/**
 * Persistent JSON-backed store for mSwarm.
 */
export class SwarmStore {
  private readonly baseDir: string;
  private readonly swarmsDir: string;
  private readonly swarms = new Map<string, StoredSwarmState>();
  private readonly sessionIndex = new Map<string, string>();
  private readonly fileStamps = new Map<string, string>();
  private readonly unknownSessions = new Map<string, number>();
  private tmpCounter = 0;

  constructor(baseDir: string = process.cwd()) {
    this.baseDir = path.resolve(baseDir);
    this.swarmsDir = path.join(this.baseDir, ".opencode", "mswarm", "swarms");
    this.loadAllFromDisk();
  }

  /**
   * Rebuilds the in-memory swarm cache and sessionID -> swarmId index from disk.
   */
  private loadAllFromDisk(): void {
    this.swarms.clear();
    this.sessionIndex.clear();
    this.fileStamps.clear();
    this.unknownSessions.clear();

    if (!fs.existsSync(this.swarmsDir)) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.swarmsDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const filePath = path.join(this.swarmsDir, entry.name);
      const parsed = this.readSwarmFile(filePath);
      if (parsed) {
        this.swarms.set(parsed.swarmId, parsed);
        this.indexSwarmSessions(parsed);
      }
    }
  }

  private normalizeLoadedSwarm(swarm: StoredSwarmState): void {
    swarm.version = STATE_VERSION;
    swarm.channels ??= [];
    swarm.members ??= {};
    swarm.messages ??= [];
    swarm.headSeq ??=
      swarm.messages.length > 0
        ? Math.max(...swarm.messages.map((message) => message.seq))
        : 0;

    if (!swarm.channels.some((channel) => channel.name === "main")) {
      swarm.channels.unshift({
        id: "main",
        name: "main",
        description: "Default swarm channel",
        topic: "Default swarm channel",
        createdAt: swarm.createdAt ?? nowIso(),
        archived: false,
        subscribers: ["coordinator"],
      });
    }

    for (const channel of swarm.channels) {
      channel.subscribers ??= [];
      channel.archived ??= false;
    }

    for (const member of Object.values(swarm.members)) {
      member.state ??= "stopped";
      member.workspace ??= "inherit";
      member.wakeMode ??= "mentions_only";
      member.channels ??= ["main"];
      member.lastActiveAt ??= swarm.updatedAt ?? nowIso();
      member.createdAt ??= swarm.createdAt ?? nowIso();
    }
  }

  private indexSwarmSessions(swarm: StoredSwarmState): void {
    if (swarm.coordinatorSessionID) {
      this.sessionIndex.set(swarm.coordinatorSessionID, swarm.swarmId);
    }
    for (const member of Object.values(swarm.members)) {
      if (member.sessionID) {
        this.sessionIndex.set(member.sessionID, swarm.swarmId);
      }
    }
  }

  private stampFor(filePath: string): string | undefined {
    try {
      const stat = fs.statSync(filePath);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return undefined;
    }
  }

  private readSwarmFile(filePath: string): StoredSwarmState | undefined {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as StoredSwarmState;
      if (!parsed || typeof parsed.swarmId !== "string") {
        return undefined;
      }
      this.normalizeLoadedSwarm(parsed);
      const stamp = this.stampFor(filePath);
      if (stamp) {
        this.fileStamps.set(parsed.swarmId, stamp);
      }
      return parsed;
    } catch {
      // Ignore corrupted or partial files; valid files continue loading.
      return undefined;
    }
  }

  /**
   * Re-reads a swarm when another plugin instance (or process) wrote it.
   */
  private refreshIfChanged(swarmId: string): StoredSwarmState | undefined {
    const filePath = this.getSwarmFilePath(swarmId);
    const stamp = this.stampFor(filePath);
    if (!stamp) {
      return this.swarms.get(swarmId);
    }
    if (this.fileStamps.get(swarmId) === stamp) {
      return this.swarms.get(swarmId);
    }
    const parsed = this.readSwarmFile(filePath);
    if (parsed) {
      this.swarms.set(parsed.swarmId, parsed);
      this.indexSwarmSessions(parsed);
      return parsed;
    }
    return this.swarms.get(swarmId);
  }

  private tryLoadById(swarmId: string): StoredSwarmState | undefined {
    const cached = this.refreshIfChanged(swarmId);
    if (cached) {
      return cached;
    }
    const filePath = this.getSwarmFilePath(swarmId);
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    const parsed = this.readSwarmFile(filePath);
    if (parsed) {
      this.swarms.set(parsed.swarmId, parsed);
      this.indexSwarmSessions(parsed);
    }
    return parsed;
  }

  /**
   * Finds a swarm on disk for a session created by another plugin instance.
   * Throttled so unrelated session events do not scan the directory repeatedly.
   */
  private findSwarmOnDisk(sessionID: string): StoredSwarmState | undefined {
    const now = Date.now();
    const lastMiss = this.unknownSessions.get(sessionID);
    if (lastMiss !== undefined && now - lastMiss < 2000) {
      return undefined;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.swarmsDir, { withFileTypes: true });
    } catch {
      return undefined;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const filePath = path.join(this.swarmsDir, entry.name);
      const parsed = this.readSwarmFile(filePath);
      if (!parsed) {
        continue;
      }
      this.swarms.set(parsed.swarmId, parsed);
      this.indexSwarmSessions(parsed);
      if (
        parsed.coordinatorSessionID === sessionID ||
        Object.values(parsed.members).some(
          (member) => member.sessionID === sessionID,
        )
      ) {
        this.unknownSessions.delete(sessionID);
        return parsed;
      }
    }
    if (this.unknownSessions.size > 1000) {
      this.unknownSessions.clear();
    }
    this.unknownSessions.set(sessionID, now);
    return undefined;
  }

  private getSwarmFilePath(swarmId: string): string {
    return path.join(this.swarmsDir, `${sanitizeId(swarmId)}.json`);
  }

  /**
   * Writes a swarm state file atomically.
   */
  private persist(swarm: StoredSwarmState): void {
    fs.mkdirSync(this.swarmsDir, { recursive: true });
    const filePath = this.getSwarmFilePath(swarm.swarmId);
    const tmpPath = `${filePath}.${process.pid}.${++this.tmpCounter}.tmp`;
    swarm.revision = (swarm.revision ?? 0) + 1;
    swarm.updatedAt = nowIso();
    const payload = `${JSON.stringify(swarm, null, 2)}\n`;

    const fd = fs.openSync(tmpPath, "w");
    let closed = false;
    try {
      fs.writeFileSync(fd, payload, "utf8");
      fs.fsyncSync(fd);
    } catch (error) {
      try {
        fs.closeSync(fd);
        closed = true;
      } catch {
        // Ignore close failures on the error path.
      }
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore temporary-file cleanup failures.
      }
      throw error;
    } finally {
      if (!closed) {
        fs.closeSync(fd);
      }
    }

    const delays = [0, 5, 10, 20, 40, 80, 160, 250];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      try {
        fs.renameSync(tmpPath, filePath);
        const stamp = this.stampFor(filePath);
        if (stamp) {
          this.fileStamps.set(swarm.swarmId, stamp);
        }
        return;
      } catch (error) {
        if (!isRetryableRenameError(error) || attempt === delays.length - 1) {
          try {
            fs.unlinkSync(tmpPath);
          } catch {
            // Best effort cleanup of the temporary file.
          }
          throw error;
        }
        sleepSync(delays[attempt]!);
      }
    }
  }

  private requireSwarm(swarmId: string): StoredSwarmState {
    const swarm = this.refreshIfChanged(swarmId);
    if (!swarm) {
      throw new Error(`Swarm "${swarmId}" not found.`);
    }
    return swarm;
  }

  /**
   * Creates a new swarm for rootSessionID (with main channel and coordinator member)
   * or returns the existing one.
   */
  createOrGetSwarm(
    rootSessionID: string,
    directory: string,
    selectedModel?: ModelRef,
  ): StoredSwarmState {
    const existingId = this.sessionIndex.get(rootSessionID);
    if (existingId) {
      const existing = this.refreshIfChanged(existingId);
      if (existing) {
        let changed = false;
        if (selectedModel && !existing.selectedModel) {
          existing.selectedModel = selectedModel;
          changed = true;
        }
        const coordinator = existing.members.coordinator;
        if (coordinator && selectedModel && !coordinator.model) {
          coordinator.model = selectedModel;
          changed = true;
        }
        if (changed) {
          existing.updatedAt = nowIso();
          this.persist(existing);
        }
        return existing;
      }
    }

    const swarmId = sanitizeId(rootSessionID);
    const existingById = this.tryLoadById(swarmId);
    if (existingById) {
      this.indexSwarmSessions(existingById);
      return existingById;
    }

    const now = nowIso();
    const coordinator: StoredSwarmMember = {
      name: "coordinator",
      role: "coordinator",
      state: "working",
      sessionID: rootSessionID,
      model: selectedModel,
      workspace: "inherit",
      workspacePath: path.resolve(directory),
      wakeMode: "mentions_only",
      channels: ["main"],
      lastActiveAt: now,
      createdAt: now,
    };

    const mainChannel: StoredBoardChannel = {
      id: "main",
      name: "main",
      description: "Default swarm channel",
      topic: "Default swarm channel",
      createdAt: now,
      archived: false,
      subscribers: ["coordinator"],
    };

    const swarm: StoredSwarmState = {
      version: STATE_VERSION,
      swarmId,
      rootDirectory: path.resolve(directory),
      coordinatorSessionID: rootSessionID,
      selectedModel,
      createdAt: now,
      updatedAt: now,
      headSeq: 0,
      channels: [mainChannel],
      members: { coordinator },
      messages: [],
    };

    this.swarms.set(swarmId, swarm);
    this.sessionIndex.set(rootSessionID, swarmId);
    this.persist(swarm);
    return swarm;
  }

  /**
   * Returns a swarm by its ID if present.
   */
  getSwarm(swarmId: string): StoredSwarmState | undefined {
    return this.refreshIfChanged(swarmId);
  }

  /**
   * Returns all swarms currently known to this store.
   */
  listSwarms(): StoredSwarmState[] {
    return Array.from(this.swarms.values());
  }

  /**
   * Looks up the swarm and member associated with an OpenCode sessionID.
   */
  getSwarmBySession(
    sessionID: string,
  ): { swarm: StoredSwarmState; member: StoredSwarmMember } | undefined {
    const swarmId = this.sessionIndex.get(sessionID);
    if (swarmId) {
      const swarm = this.refreshIfChanged(swarmId);
      const member = swarm
        ? Object.values(swarm.members).find((m) => m.sessionID === sessionID)
        : undefined;
      if (swarm && member) {
        return { swarm, member };
      }
    }

    // Repair the index if a state file was edited or loaded out of order.
    for (const swarm of this.swarms.values()) {
      const member = Object.values(swarm.members).find(
        (m) => m.sessionID === sessionID,
      );
      if (member) {
        this.sessionIndex.set(sessionID, swarm.swarmId);
        return { swarm, member };
      }
    }

    // A worker session may have been created by another plugin instance
    // (for example, when it runs in an isolated worktree).
    const found = this.findSwarmOnDisk(sessionID);
    if (found) {
      const member = Object.values(found.members).find(
        (m) => m.sessionID === sessionID,
      );
      if (member) {
        return { swarm: found, member };
      }
    }
    return undefined;
  }

  /**
   * Updates the swarm title.
   */
  setTitle(swarmId: string, title: string): void {
    const swarm = this.requireSwarm(swarmId);
    const clean = title.trim();
    if (!clean) {
      throw new Error("Swarm title cannot be empty.");
    }
    swarm.title = clean.slice(0, 200);
    swarm.updatedAt = nowIso();
    this.persist(swarm);
  }

  /**
   * Updates the swarm's default selected model.
   */
  setSelectedModel(swarmId: string, model: ModelRef): void {
    const swarm = this.requireSwarm(swarmId);
    swarm.selectedModel = model;
    swarm.updatedAt = nowIso();
    this.persist(swarm);
  }

  /**
   * Validates and normalizes a member name.
   */
  validateMemberName(rawName: string): string {
    const name = rawName.trim();
    if (!name) {
      throw new Error("Member name cannot be empty.");
    }
    if (RESERVED_NAMES.has(name.toLowerCase())) {
      throw new Error(`Member name "${name}" is reserved.`);
    }
    if (!NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid member name "${rawName}". Use 1-64 characters from A-Z, a-z, 0-9, ".", "_" or "-", starting with a letter or digit.`,
      );
    }
    return name;
  }

  /**
   * Validates and normalizes a channel name.
   */
  validateChannelName(rawName: string): string {
    const name = rawName.trim().replace(/^#/, "");
    if (!name) {
      throw new Error("Channel name cannot be empty.");
    }
    if (!NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid channel name "${rawName}". Use 1-64 characters from A-Z, a-z, 0-9, ".", "_" or "-", starting with a letter or digit.`,
      );
    }
    return name;
  }

  /**
   * Adds a new member to the swarm after validating name uniqueness and reserved names.
   */
  addMember(
    swarmId: string,
    member: Omit<StoredSwarmMember, "createdAt" | "lastActiveAt"> & {
      createdAt?: string;
      lastActiveAt?: string;
    },
  ): StoredSwarmMember {
    const swarm = this.requireSwarm(swarmId);
    const name = this.validateMemberName(member.name);

    if (swarm.members[name]) {
      throw new Error(`Member "${name}" already exists in swarm "${swarmId}".`);
    }

    const now = nowIso();
    const channels = dedupe(["main", ...(member.channels ?? [])]);
    const stored: StoredSwarmMember = {
      ...member,
      name,
      role: member.role ?? ("worker" as MemberRole),
      state: member.state ?? ("working" as MemberState),
      workspace: member.workspace ?? ("inherit" as WorkspaceMode),
      wakeMode: member.wakeMode ?? ("mentions_only" as WakeMode),
      channels,
      createdAt: member.createdAt ?? now,
      lastActiveAt: member.lastActiveAt ?? now,
    };

    swarm.members[name] = stored;
    if (stored.sessionID) {
      this.sessionIndex.set(stored.sessionID, swarmId);
    }

    const mainCh = swarm.channels.find((channel) => channel.name === "main");
    if (mainCh) {
      mainCh.subscribers = dedupe([...(mainCh.subscribers ?? []), name]);
    }

    swarm.updatedAt = now;
    this.persist(swarm);
    return stored;
  }

  /**
   * Reserves names before a batch spawn so a conflict cannot create orphan sessions.
   */
  assertMemberNamesAvailable(swarmId: string, names: string[]): void {
    const swarm = this.requireSwarm(swarmId);
    for (const name of names) {
      const clean = this.validateMemberName(name);
      if (swarm.members[clean]) {
        throw new Error(`Member "${clean}" already exists in swarm "${swarmId}".`);
      }
    }
  }

  /**
   * Applies a partial update to an existing swarm member.
   */
  updateMember(
    swarmId: string,
    name: string,
    patch: Partial<StoredSwarmMember>,
  ): StoredSwarmMember {
    const swarm = this.requireSwarm(swarmId);
    const existing = swarm.members[name];
    if (!existing) {
      throw new Error(`Member "${name}" not found in swarm "${swarmId}".`);
    }

    const prevSessionID = existing.sessionID;
    const updated: StoredSwarmMember = {
      ...existing,
      ...patch,
      name: existing.name,
      lastActiveAt: patch.lastActiveAt ?? nowIso(),
    };

    swarm.members[name] = updated;
    if (patch.sessionID && patch.sessionID !== prevSessionID) {
      if (prevSessionID) {
        this.sessionIndex.delete(prevSessionID);
      }
      this.sessionIndex.set(patch.sessionID, swarmId);
    }

    swarm.updatedAt = nowIso();
    this.persist(swarm);
    return updated;
  }

  /**
   * Marks a member as actively working. Used by the model context hook so a
   * direct user message (or a queued wake) cannot be treated as idle.
   */
  markWorking(sessionID: string): void {
    const ctx = this.getSwarmBySession(sessionID);
    if (!ctx) {
      return;
    }
    const { swarm, member } = ctx;
    if (member.state === "working" || member.state === "killed") {
      return;
    }
    this.updateMember(swarm.swarmId, member.name, {
      state: "working",
      waitingSinceSeq: undefined,
      lastError: undefined,
    });
  }

  /**
   * Returns a member by name, or undefined if not found.
   */
  getMember(swarmId: string, name: string): StoredSwarmMember | undefined {
    const swarm = this.swarms.get(swarmId);
    return swarm?.members[name];
  }

  /**
   * Creates a new board channel.
   */
  createChannel(
    swarmId: string,
    name: string,
    topic: string,
    creator: string,
  ): StoredBoardChannel {
    const swarm = this.requireSwarm(swarmId);
    const cleanName = this.validateChannelName(name);

    if (cleanName === "main") {
      throw new Error('Channel "main" already exists.');
    }
    if (swarm.channels.some((channel) => channel.name === cleanName)) {
      throw new Error(`Channel "${cleanName}" already exists.`);
    }

    const now = nowIso();
    const subscribers =
      creator && swarm.members[creator] ? [creator] : [];
    const channel: StoredBoardChannel = {
      id: cleanName,
      name: cleanName,
      description: topic,
      topic,
      creator,
      createdAt: now,
      archived: false,
      subscribers,
    };

    swarm.channels.push(channel);

    if (creator && swarm.members[creator]) {
      const member = swarm.members[creator]!;
      member.channels = dedupe([...(member.channels ?? ["main"]), cleanName]);
    }

    swarm.updatedAt = now;
    this.persist(swarm);
    return channel;
  }

  /**
   * Subscribes a member to a channel.
   */
  subscribeChannel(swarmId: string, channel: string, memberName: string): void {
    const swarm = this.requireSwarm(swarmId);
    const cleanChannel = this.validateChannelName(channel);
    const ch = swarm.channels.find((candidate) => candidate.name === cleanChannel);
    if (!ch) {
      throw new Error(`Channel "${cleanChannel}" does not exist.`);
    }
    if (ch.archived) {
      throw new Error(`Channel "${cleanChannel}" is archived.`);
    }
    const member = swarm.members[memberName];
    if (!member) {
      throw new Error(`Member "${memberName}" not found.`);
    }

    member.channels = dedupe([...(member.channels ?? ["main"]), cleanChannel]);
    ch.subscribers = dedupe([...(ch.subscribers ?? []), memberName]);
    swarm.updatedAt = nowIso();
    this.persist(swarm);
  }

  /**
   * Unsubscribes a member from a channel (main cannot be unsubscribed).
   */
  unsubscribeChannel(
    swarmId: string,
    channel: string,
    memberName: string,
  ): void {
    const swarm = this.requireSwarm(swarmId);
    const cleanChannel = this.validateChannelName(channel);
    if (cleanChannel === "main") {
      throw new Error('Cannot unsubscribe from "main" channel.');
    }
    const ch = swarm.channels.find((candidate) => candidate.name === cleanChannel);
    if (!ch) {
      throw new Error(`Channel "${cleanChannel}" does not exist.`);
    }
    const member = swarm.members[memberName];
    if (!member) {
      throw new Error(`Member "${memberName}" not found.`);
    }

    member.channels = (member.channels ?? ["main"]).filter(
      (candidate) => candidate !== cleanChannel,
    );
    ch.subscribers = (ch.subscribers ?? []).filter(
      (candidate) => candidate !== memberName,
    );
    swarm.updatedAt = nowIso();
    this.persist(swarm);
  }

  /**
   * Lists all channels in the swarm.
   */
  listChannels(swarmId: string): StoredBoardChannel[] {
    const swarm = this.requireSwarm(swarmId);
    return swarm.channels;
  }

  /**
   * Archives a non-main channel.
   */
  archiveChannel(swarmId: string, channel: string): StoredBoardChannel {
    const swarm = this.requireSwarm(swarmId);
    const cleanChannel = this.validateChannelName(channel);
    if (cleanChannel === "main") {
      throw new Error('Cannot archive the "main" channel.');
    }
    const ch = swarm.channels.find((candidate) => candidate.name === cleanChannel);
    if (!ch) {
      throw new Error(`Channel "${cleanChannel}" does not exist.`);
    }
    ch.archived = true;
    swarm.updatedAt = nowIso();
    this.persist(swarm);
    return ch;
  }

  private hasGroup(swarm: StoredSwarmState, prefix: string): boolean {
    const prefixRe = new RegExp(`^${escapeRegex(prefix)}-\\d+$`);
    return Object.keys(swarm.members).some((name) => prefixRe.test(name));
  }

  private resolveMemberMention(
    swarm: StoredSwarmState,
    token: string,
  ): string | undefined {
    if (token.toLowerCase() === "all") {
      return "all";
    }
    if (swarm.members[token]) {
      return token;
    }

    const trimmed = token.replace(/[.]+$/, "");
    if (trimmed && trimmed !== token) {
      if (trimmed.toLowerCase() === "all") {
        return "all";
      }
      if (swarm.members[trimmed]) {
        return trimmed;
      }
      if (this.hasGroup(swarm, trimmed)) {
        return trimmed;
      }
    }

    const lower = token.toLowerCase();
    const caseMatches = Object.keys(swarm.members).filter(
      (name) => name.toLowerCase() === lower,
    );
    if (caseMatches.length === 1) {
      return caseMatches[0]!;
    }
    if (this.hasGroup(swarm, token)) {
      return token;
    }
    return undefined;
  }

  /**
   * Parses @name, @prefix, @all, and @#channel mentions from message text.
   */
  parseMentions(swarm: StoredSwarmState, text: string): string[] {
    const mentions: string[] = [];
    const seen = new Set<string>();

    const addMention = (token: string) => {
      if (!seen.has(token)) {
        seen.add(token);
        mentions.push(token);
      }
    };

    const channelRegex = /(?:^|[^A-Za-z0-9._-])@#([A-Za-z0-9._-]+)/g;
    let match: RegExpExecArray | null;
    while ((match = channelRegex.exec(text)) !== null) {
      const raw = match[1]!;
      const channel = swarm.channels.find(
        (candidate) =>
          !candidate.archived &&
          candidate.name.toLowerCase() === raw.toLowerCase(),
      );
      if (channel) {
        addMention(`#${channel.name}`);
      }
    }

    const nameRegex = /(?:^|[^A-Za-z0-9._-])@([A-Za-z0-9._-]+)/g;
    while ((match = nameRegex.exec(text)) !== null) {
      const resolved = this.resolveMemberMention(swarm, match[1]!);
      if (resolved) {
        addMention(resolved);
      }
    }

    return mentions;
  }

  /**
   * Posts a message to the board, validates channel, parses mentions, assigns a
   * monotonic seq, updates member.lastPostSeq, persists, and returns the
   * message plus the members that match its wake rules.
   */
  postMessage(
    swarmId: string,
    agent: string,
    text: string,
    channel: string = "main",
    options: PostMessageOptions = {},
  ): PostMessageResult {
    const swarm = this.requireSwarm(swarmId);
    const targetChannel = this.validateChannelName(channel || "main");
    const messageText = text.trim();
    if (!messageText) {
      throw new Error("Cannot post an empty board message.");
    }
    if (messageText.length > MAX_MESSAGE_CHARS) {
      throw new Error(
        `Board message is too long (${messageText.length} characters; maximum is ${MAX_MESSAGE_CHARS}).`,
      );
    }

    const ch = swarm.channels.find(
      (candidate) => candidate.name === targetChannel,
    );
    if (!ch) {
      throw new Error(`Channel "${targetChannel}" does not exist.`);
    }
    if (ch.archived) {
      throw new Error(`Channel "${targetChannel}" is archived.`);
    }

    if (
      !options.mentions &&
      /(?:^|[^A-Za-z0-9._-])@#main(?![A-Za-z0-9._-])/i.test(messageText)
    ) {
      throw new Error(
        "Cannot mention @#main. Post to the main channel directly or use @all.",
      );
    }

    const mentions = options.mentions
      ? dedupe(
          options.mentions
            .map((token) => {
              const clean = token.trim().replace(/^@/, "");
              if (clean.startsWith("#")) {
                const name = clean.slice(1);
                const found = swarm.channels.find(
                  (candidate) =>
                    !candidate.archived &&
                    candidate.name.toLowerCase() === name.toLowerCase(),
                );
                return found ? `#${found.name}` : undefined;
              }
              return this.resolveMemberMention(swarm, clean);
            })
            .filter((token): token is string => Boolean(token)),
        )
      : this.parseMentions(swarm, messageText);

    const seq = ++swarm.headSeq;
    const now = nowIso();

    const message: BoardMessage = {
      seq,
      channel: targetChannel,
      agent,
      text: messageText,
      time: now,
      mentions,
    };

    swarm.messages.push(message);
    this.pruneMessages(swarm);

    const sender = swarm.members[agent];
    if (sender) {
      sender.lastPostSeq = seq;
      sender.lastActiveAt = now;
    }

    swarm.updatedAt = now;
    this.persist(swarm);

    const recipientsToWake: StoredSwarmMember[] = [];
    for (const member of Object.values(swarm.members)) {
      if (member.state === "killed" || member.name === agent) {
        continue;
      }
      const mentionsOnly = member.wakeMode !== "all";
      if (this.messageMatchesMember(member, message, mentionsOnly)) {
        recipientsToWake.push(member);
      }
    }

    return { message, recipientsToWake };
  }

  private pruneMessages(swarm: StoredSwarmState): void {
    if (swarm.messages.length <= MAX_BOARD_MESSAGES) {
      return;
    }
    const removed = swarm.messages.length - MAX_BOARD_MESSAGES;
    swarm.messages.splice(0, removed);
    const oldestKept = swarm.messages[0]?.seq;
    if (oldestKept === undefined) {
      return;
    }
    const floor = oldestKept - 1;
    for (const member of Object.values(swarm.members)) {
      if ((member.lastReadSeq ?? 0) < floor) {
        member.lastReadSeq = floor;
      }
    }
  }

  private isChannelVisibleToMember(
    member: StoredSwarmMember,
    channelName: string,
  ): boolean {
    if (channelName === "main") {
      return true;
    }
    if (member.role === "coordinator" || member.role === "monitor") {
      return true;
    }
    return member.channels?.includes(channelName) ?? false;
  }

  messageMatchesMember(
    member: StoredSwarmMember,
    msg: BoardMessage,
    mentionsOnly: boolean,
  ): boolean {
    if (msg.agent === member.name) {
      return false;
    }
    const ch = msg.channel ?? "main";
    if (!this.isChannelVisibleToMember(member, ch)) {
      return false;
    }
    if (!mentionsOnly) {
      return true;
    }

    for (const mention of msg.mentions) {
      if (mention === "all" || mention === member.name) {
        return true;
      }
      if (mention.startsWith("#")) {
        const targetCh = mention.slice(1);
        if (
          member.role === "coordinator" ||
          member.role === "monitor" ||
          member.channels?.includes(targetCh)
        ) {
          return true;
        }
        continue;
      }
      const prefixRe = new RegExp(`^${escapeRegex(mention)}-\\d+$`);
      if (prefixRe.test(member.name)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Returns messages after `since` visible to `member` matching `mentionsOnly`.
   */
  getMatchingMessages(
    swarm: StoredSwarmState,
    member: StoredSwarmMember,
    since: number,
    mentionsOnly: boolean,
  ): BoardMessage[] {
    return swarm.messages.filter(
      (msg) =>
        msg.seq > since &&
        this.messageMatchesMember(member, msg, mentionsOnly),
    );
  }

  /**
   * Reads board messages or member status for a member.
   */
  readBoard(
    swarmId: string,
    memberName: string,
    opts?: StoreReadBoardOptions & { status: true },
  ): MemberBoardStatus;
  readBoard(
    swarmId: string,
    memberName: string,
    opts?: StoreReadBoardOptions,
  ): ReadBoardResult;
  readBoard(
    swarmId: string,
    memberName: string,
    opts: StoreReadBoardOptions = {},
  ): ReadBoardResult | MemberBoardStatus {
    const swarm = this.requireSwarm(swarmId);
    const member = swarm.members[memberName];
    if (!member) {
      throw new Error(`Member "${memberName}" not found in swarm "${swarmId}".`);
    }

    if (opts.status) {
      return {
        name: member.name,
        state: member.state,
        wakeMode: member.wakeMode,
        waitSince: member.waitingSinceSeq,
        lastReadSeq: member.lastReadSeq,
        lastPostSeq: member.lastPostSeq,
        channels: member.channels ?? ["main"],
        brief: member.brief,
      };
    }

    let messages: BoardMessage[];
    if (opts.seqs && opts.seqs.length > 0) {
      const seqSet = new Set(opts.seqs);
      messages = swarm.messages.filter((message) => {
        if (!seqSet.has(message.seq)) {
          return false;
        }
        if (opts.channel === "*") {
          return true;
        }
        return this.isChannelVisibleToMember(
          member,
          message.channel ?? "main",
        );
      });
    } else {
      const limit = opts.limit ?? 20;
      const filtered = swarm.messages.filter((message) => {
        if (opts.since !== undefined && message.seq <= opts.since) {
          return false;
        }
        const ch = message.channel ?? "main";
        if (opts.channel === "*") {
          return true;
        }
        if (opts.channel) {
          return ch === opts.channel.replace(/^#/, "");
        }
        return this.isChannelVisibleToMember(member, ch);
      });

      messages =
        opts.since !== undefined
          ? filtered.slice(0, limit)
          : filtered.slice(-limit);
    }

    if (messages.length > 0) {
      const maxSeq = messages[messages.length - 1]!.seq;
      if (member.lastReadSeq === undefined || maxSeq > member.lastReadSeq) {
        member.lastReadSeq = maxSeq;
        this.persist(swarm);
      }
    }

    return {
      messages,
      head: swarm.headSeq,
    };
  }

  /**
   * Returns swarm metadata and member status entries.
   */
  getStatus(swarmId: string): SwarmStatusResult {
    const swarm = this.requireSwarm(swarmId);
    const members: SwarmStatusEntry[] = Object.values(swarm.members).map(
      (member) => ({
        name: member.name,
        role: member.role,
        state: member.state,
        model: member.model,
        workspace: member.workspace,
        wakeMode: member.wakeMode,
        waitingSinceSeq: member.waitingSinceSeq,
        lastPostSeq: member.lastPostSeq,
        lastReadSeq: member.lastReadSeq,
        lastActiveAt: member.lastActiveAt,
        parentName: member.parentName,
        brief: member.brief,
        channels: member.channels,
        lastError: member.lastError,
      }),
    );

    return {
      swarmId: swarm.swarmId,
      title: swarm.title,
      selectedModel: swarm.selectedModel,
      head: swarm.headSeq,
      members,
    };
  }

  /**
   * Formats a clean markdown summary of the swarm for `/mswarm board`.
   */
  formatBoardSummary(swarmId: string): string {
    const swarm = this.requireSwarm(swarmId);
    const lines: string[] = [];

    const title = swarm.title
      ? `${swarm.title} (${swarm.swarmId})`
      : swarm.swarmId;
    lines.push(`# Swarm: ${title}`);
    lines.push(`- **Head Seq:** #${swarm.headSeq}`);
    lines.push(`- **Members:** ${Object.keys(swarm.members).length}`);
    if (swarm.selectedModel) {
      lines.push(
        `- **Selected Model:** ${swarm.selectedModel.providerID}/${swarm.selectedModel.modelID}`,
      );
    }

    lines.push("");
    lines.push("## Members");
    for (const member of Object.values(swarm.members)) {
      const modelStr = member.model
        ? `${member.model.providerID}/${member.model.modelID}`
        : "default";
      const channelsStr = (member.channels ?? ["main"])
        .map((channel) => `#${channel}`)
        .join(", ");
      const waitInfo =
        member.state === "waiting" && member.waitingSinceSeq !== undefined
          ? ` (since #${member.waitingSinceSeq}, ${member.wakeMode})`
          : "";
      const errorInfo = member.lastError
        ? ` | error: ${member.lastError.slice(0, 120)}`
        : "";
      lines.push(
        `- **${member.name}** [${member.role}] — \`${member.state}\`${waitInfo} | model: \`${modelStr}\` | workspace: \`${member.workspace}\` | channels: ${channelsStr}${errorInfo}`,
      );
      if (member.brief) {
        lines.push(
          `  - brief: ${member.brief.replace(/\s+/g, " ").slice(0, 240)}`,
        );
      }
    }

    lines.push("");
    lines.push("## Channels");
    for (const channel of swarm.channels) {
      const archivedTag = channel.archived ? " (archived)" : "";
      const desc = channel.topic || channel.description || "";
      lines.push(`- **#${channel.name}**${archivedTag}${desc ? `: ${desc}` : ""}`);
    }

    lines.push("");
    lines.push("## Recent Board Messages");
    const recent = swarm.messages.slice(-15);
    if (recent.length === 0) {
      lines.push("_No messages posted yet._");
    } else {
      for (const message of recent) {
        const chTag =
          message.channel && message.channel !== "main"
            ? ` [#${message.channel}]`
            : "";
        const preview = message.text.replace(/\s+/g, " ").trim();
        lines.push(
          `- **#${message.seq}**${chTag} **${message.agent}**: ${preview}`,
        );
      }
    }

    return lines.join("\n");
  }
}
