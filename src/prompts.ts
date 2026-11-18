import type { BoardMessage, SwarmMember, SwarmState } from "./types.js";

/**
 * Prompt builders for mSwarm members.
 *
 * System prompts built here are injected before every model call, so they are
 * kept stable across turns (no roster, head seq, or other per-turn values) to
 * stay prompt-cache friendly. Per-turn facts travel in user-visible messages
 * instead: the worker kickoff, wakeups, and spawn notices.
 *
 * Author: Michael Christensen
 */

/** Name prefix used for automatically started first-responder scouts. */
export const AUTO_SCOUT_PREFIX = "auto";

/**
 * Options that change the coordinator contract.
 */
export interface CoordinatorPromptOptions {
  /** Whether mSwarm starts an `auto-*` scout for new requests. */
  autoDelegate?: boolean;
}

/**
 * Build the system prompt injected for the coordinator session.
 */
export function buildCoordinatorPrompt(
  swarm: SwarmState,
  member: SwarmMember,
  options: CoordinatorPromptOptions = {},
): string {
  const titleLine = swarm.title
    ? `Swarm "${swarm.title}" (${swarm.swarmId})`
    : `Swarm ${swarm.swarmId}`;
  const channels =
    swarm.channels
      .filter((channel) => !channel.archived)
      .map((channel) => `#${channel.name}`)
      .join(", ") || "#main";

  return [
    `You are @${member.name}, the coordinator of ${titleLine}.`,
    `Root directory: ${swarm.rootDirectory}`,
    `Channels: ${channels}`,
    "",
    "You are the planner and integrator. Delegate implementation, investigation, and substantive analysis to workers; do not do their work yourself unless a worker is blocked or the task is genuinely trivial.",
    "",
    "Coordinator rules:",
    "- When the user gives a clear goal, act immediately: decompose it, spawn workers in the same turn, and report the plan briefly. Do not ask for confirmation first.",
    "- Ask the user only when the goal is genuinely ambiguous, when a decision would change the design, or when an action is destructive or irreversible.",
    ...(options.autoDelegate
      ? [
          `- When a new request arrives while no workers are active, mSwarm starts a read-only scout (\`@${AUTO_SCOUT_PREFIX}-N\`) on it and appends an \`[mSwarm] ... scout\` line to the user's message. Do not spawn a duplicate investigation. Spawn implementers for the parts you can already plan, and tell the scout what to focus on with \`post_message\`. For a small task, reply \`@${AUTO_SCOUT_PREFIX}-N implement it\` instead of spawning someone new.`,
        ]
      : []),
    "",
    "Briefs:",
    "- Workers cannot see this conversation or anything you have read. Every brief must stand alone: the goal, relevant context and decisions already made, the files or paths the worker owns, what is out of scope, acceptance checks, and what to report.",
    "- Decompose the goal into a small number of independent units. Two workers must never own the same file.",
    '- Spawn workers with `swarm` (`action: "add"`, `name`, `brief`). Leave `model` unset so workers inherit the selected model unless the user requested a specific model.',
    "- Keep concurrency sensible (2-5 workers for most tasks). Do not spawn one worker per trivial step.",
    "",
    "Workspaces and integration:",
    '- `inherit` shares the root directory. Use it for read-only work and for a single editor. When several workers edit or build at the same time, use `branch` (or `share`).',
    "- `branch` and `share` workers commit in their own git worktree and report the commit SHA. Integrate before killing them: merge the `mswarm/...` branch, or cherry-pick the reported SHAs for `share` workers.",
    "- Killing a `branch` or `share` worker force-removes its worktree and discards uncommitted changes. Branches are kept.",
    "",
    "Communication:",
    "- Address agents explicitly with `@name` (or `@prefix` for numbered groups). Use `@all` only for swarm-wide decisions, never for routine status.",
    "- Workers finish with `@coordinator [done] <summary>` and report blockers with `@coordinator [blocked] <details>`.",
    "- Use board channels when parallel workstreams need separate traffic; keep `main` for swarm-wide updates.",
    "- Use `swarm_wait` to wait for worker updates instead of polling `read_board` in a loop; end your turn immediately after calling it. Pass the highest `#seq` you have seen (spawn notices report the current head).",
    "- Use `read_board` when you need context that arrived while you were working.",
    "- In Code Mode, call these tools as `tools.swarm`, `tools.post_message`, `tools.read_board`, and `tools.swarm_wait`.",
    "",
    "Finishing:",
    '- Verify worker output before reporting completion. Use `role: "monitor"` for an independent check when correctness matters.',
    '- Kill finished workers with `swarm` (`action: "kill"`) once their work is integrated.',
    "- Report progress and the final result to the user in clear, concise language.",
  ].join("\n");
}

function workspaceRules(swarm: SwarmState, member: SwarmMember): string[] {
  if (member.role === "monitor") {
    return [];
  }
  // A share/branch request that fell back to the root (no git, worktree
  // failure) behaves exactly like inherit.
  const isolated =
    member.workspace !== "inherit" &&
    member.workspacePath !== undefined &&
    member.workspacePath !== swarm.rootDirectory;
  if (!isolated) {
    return [
      "- This directory is shared with the coordinator and other workers. Edit only the files your assignment gives you; if you need to touch anything else, report a conflict instead.",
    ];
  }
  const where = member.branchName
    ? `on branch \`${member.branchName}\``
    : "in this detached worktree";
  return [
    `- You work in your own git worktree. Commit your changes ${where} before reporting done, and include the commit SHA in your report.`,
    "- Uncommitted changes are deleted when you are killed.",
  ];
}

/**
 * Build the system prompt for a worker (or monitor) session. It contains the
 * contract and the assignment; the kickoff message only starts the work.
 */
export function buildWorkerPrompt(
  swarm: SwarmState,
  member: SwarmMember,
  brief: string,
): string {
  const workDir = member.workspacePath ?? swarm.rootDirectory;
  const channels =
    (member.channels && member.channels.length > 0
      ? member.channels
      : ["main"]
    ).join(", ");
  const parent = member.parentName ?? "coordinator";

  return [
    `You are @${member.name} (role: ${member.role}) in swarm ${swarm.swarmId}.`,
    `Workspace: ${workDir} (mode: ${member.workspace})`,
    `Subscribed channels: ${channels}`,
    `Parent: @${parent}`,
    ...(member.role === "monitor"
      ? [
          "",
          "Monitor rules:",
          "- Observe, verify, and report. Do not edit files or run commands that change state.",
          `- Report with \`@${parent} [pass] <evidence>\` or \`@${parent} [fail] <what is wrong, where, and how you found it>\`.`,
        ]
      : []),
    "",
    "Board & communication rules:",
    "- You are not the user's point of entry. The coordinator talks to the user; report through the board and your parent.",
    "- Start the assignment immediately. Do not post greetings or acknowledgements.",
    ...workspaceRules(swarm, member),
    "- Use `read_board` with `since` to catch up on messages you missed; cite posts by `#seq`.",
    '- Use `post_message` to share concrete results, questions, or handoffs. To find peers, call `swarm` with `action: "status"`. Always `@mention` the specific peer you need; do not CC the coordinator on intermediate handoffs.',
    "- In Code Mode, call the board tools as `tools.read_board`, `tools.post_message`, and `tools.swarm_wait`.",
    `- If you are blocked, post \`@${parent} [blocked] <what you need>\` and call \`swarm_wait\`.`,
    ...(member.role === "monitor"
      ? []
      : [
          "- Before reporting done, run the focused checks that apply to your change (tests, typecheck, lint). If a check cannot run, say why.",
          `- When the assignment is complete, post \`@${parent} [done] <concise summary: files changed, commits, tests run, remaining risks>\`.`,
        ]),
    "- When you have nothing left to do, call `swarm_wait` with the highest `#seq` you have read and end your turn immediately. Do not poll in a loop.",
    "- Do not spawn other workers unless your assignment explicitly asks you to; the coordinator owns the roster.",
    "- Do not repeat work you have already completed. Build on the current workspace and board state.",
    "",
    "Assignment:",
    brief,
  ].join("\n");
}

/**
 * Build the first user message for a newly spawned worker. The assignment
 * itself is in the system prompt, so this stays short.
 */
export function buildWorkerKickoff(
  member: SwarmMember,
  briefSeq: number | undefined,
  warning?: string,
): string {
  return [
    `[swarm kickoff for @${member.name}] Begin your assignment now.`,
    briefSeq !== undefined
      ? `Your assignment was posted as #${briefSeq}; pass at least ${briefSeq} as \`since\` when you call \`swarm_wait\`.`
      : undefined,
    warning ? `[workspace notice] ${warning}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

/**
 * Brief for the read-only scout started automatically for a new request.
 */
export function buildScoutBrief(requestText: string): string {
  return [
    "You are the coordinator's read-only scout for the user's latest request.",
    "Do not edit files unless @coordinator explicitly asks you to implement something.",
    "Investigate quickly: find the relevant files, how the code works today, risks, and how the work could be split between parallel workers (which files each would own).",
    "If the request is a question, analysis, or review, answer it fully with evidence (file paths and line numbers).",
    "Post `@coordinator [done] <findings>` when complete, or `@coordinator [blocked] <details>` if blocked. Then call `swarm_wait`, because the coordinator may send you a follow-up.",
    "",
    "User request:",
    requestText,
  ].join("\n");
}

/**
 * Format new board messages into a wakeup prompt for a parked member.
 */
export function buildWakeupPrompt(
  member: SwarmMember,
  messages: BoardMessage[],
): string {
  const formatted = messages
    .map(
      (message) =>
        `#${message.seq} [${message.channel ?? "main"}] @${message.agent}: ${message.text}`,
    )
    .join("\n");

  const tailInstruction =
    member.role === "coordinator"
      ? "If the user has an unanswered request, answer it first. Then review the worker updates, decide the next concrete step, and call `swarm_wait` only if you still need worker output."
      : "Act on any requests directed to you, post concrete results with `post_message`, and call `swarm_wait` (then end your turn) when idle.";

  return [
    `[swarm wakeup for @${member.name}] New board messages:`,
    formatted,
    "",
    tailInstruction,
  ].join("\n");
}
