/**
 * Shared type definitions for mSwarm.
 *
 * Author: Michael Christensen
 */

/**
 * Reference to a specific provider and model in OpenCode.
 *
 * Internally mSwarm uses `modelID`; the OpenCode 2.x plugin API calls the
 * same field `id`, so conversions live in one place (`src/runtime.ts`).
 */
export interface ModelRef {
  providerID: string;
  modelID: string;
  variant?: string;
}

/**
 * Lifecycle state of a swarm member.
 */
export type MemberState = "waiting" | "working" | "stopped" | "killed";

/**
 * Role of a member within the swarm.
 */
export type MemberRole = "coordinator" | "worker" | "scout" | "monitor";

/**
 * Workspace isolation mode for a spawned worker.
 */
export type WorkspaceMode = "inherit" | "share" | "branch";

/**
 * Wakeup filter applied when a member is waiting on the message board.
 */
export type WakeMode = "mentions_only" | "all";

/**
 * Metadata and runtime state for a single swarm member.
 */
export interface SwarmMember {
  name: string;
  role: MemberRole;
  state: MemberState;
  sessionID: string;
  parentName?: string;
  model?: ModelRef;
  workspace: WorkspaceMode;
  workspacePath?: string;
  branchName?: string;
  wakeMode: WakeMode;
  waitingSinceSeq?: number;
  lastPostSeq?: number;
  lastReadSeq?: number;
  /** The assignment given when this member was spawned. */
  brief?: string;
  /** Channels this member is subscribed to. */
  channels?: string[];
  /** Name of the member that spawned this one. */
  addedBy?: string;
  /** Member or session this worker was forked from, when applicable. */
  forkFrom?: string;
  /** Last error reported by the member session. */
  lastError?: string;
  lastActiveAt: string;
  createdAt: string;
  killedAt?: string;
}

/**
 * A named channel on the swarm message board.
 */
export interface BoardChannel {
  id: string;
  name: string;
  description?: string;
  topic?: string;
  creator?: string;
  archived?: boolean;
  subscribers?: string[];
  createdAt: string;
}

/**
 * A single message posted to the swarm message board.
 */
export interface BoardMessage {
  seq: number;
  channel?: string;
  agent: string;
  text: string;
  time: string;
  mentions: string[];
  requestId?: string;
}

/**
 * Persistent state of an mSwarm instance.
 */
export interface SwarmState {
  version: number;
  swarmId: string;
  title?: string;
  rootDirectory: string;
  coordinatorSessionID: string;
  selectedModel?: ModelRef;
  createdAt: string;
  updatedAt: string;
  headSeq: number;
  channels: BoardChannel[];
  members: Record<string, SwarmMember>;
  messages: BoardMessage[];
}

/**
 * Options for querying messages from the swarm board.
 */
export interface ReadBoardOptions {
  since?: number;
  limit?: number;
  seqs?: number[];
  channel?: string;
}

/**
 * Options for adding one or more workers to the swarm.
 */
export interface AddWorkerOptions {
  name: string;
  brief: string;
  role?: MemberRole;
  model?: ModelRef | string;
  fork?: string;
  workspace?: WorkspaceMode;
  n?: number;
  tasks?: string[];
  addedBy?: string;
  channels?: string[];
}

/**
 * Summary entry returned by swarm status queries.
 */
export interface SwarmStatusEntry {
  name: string;
  role: MemberRole;
  state: MemberState;
  model?: ModelRef;
  workspace: WorkspaceMode;
  wakeMode?: WakeMode;
  waitingSinceSeq?: number;
  lastPostSeq?: number;
  lastReadSeq?: number;
  lastActiveAt: string;
  parentName?: string;
  brief?: string;
  channels?: string[];
  lastError?: string;
}

/**
 * A failure while spawning one worker in a batch.
 */
export interface AddWorkerFailure {
  name: string;
  error: string;
}

/**
 * Result of spawning a batch of workers.
 */
export interface AddWorkersResult {
  created: SwarmMember[];
  failures: AddWorkerFailure[];
  warnings: string[];
}
