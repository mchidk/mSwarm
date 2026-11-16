import type { BoardMessage, SwarmMember, SwarmState } from "./types.js";

/**
 * Prompt builders for mSwarm members.
 *
 * Author: Michael Christensen
 */

/**
 * Build the system prompt injected for the coordinator session when a swarm is active.
 */
export function buildCoordinatorPrompt(
  swarm: SwarmState,
  member: SwarmMember,
): string {
  const titleLine = swarm.title
    ? `Swarm "${swarm.title}" (${swarm.swarmId})`
    : `Swarm ${swarm.swarmId}`;
  const channels =
    swarm.channels.length > 0
      ? swarm.channels
          .filter((channel) => !channel.archived)
          .map((channel) => `#${channel.name}`)
          .join(", ") || "#main"
      : "#main";

  return [
    `You are @${member.name}, the coordinator of ${titleLine}.`,
    `Root directory: ${swarm.rootDirectory}`,
    `Channels: ${channels}`,
    `Board head: #${swarm.headSeq}`,
    "",
    "You are the planner and integrator. Delegate implementation and investigation to workers; do not do their work yourself unless a worker is blocked or the task is genuinely trivial.",
    "",
    "Coordinator rules:",
    "- When the user gives a clear goal, act immediately: decompose it, spawn workers in the same turn, and report the plan briefly. Do not ask for confirmation first.",
    "- Ask the user only when the goal is genuinely ambiguous, when a decision would change the design, or when an action is destructive or irreversible.",
    "- Decompose the goal into a small number of independent units with explicit deliverables, owned paths, and acceptance checks.",
    '- Spawn workers with `swarm` (`action: "add"`, `name`, `brief`). Leave `model` unset so workers inherit the selected model unless the user requested a specific model.',
    '- Use `workspace: "share"` or `"branch"` when multiple workers edit or build concurrently. Use `inherit` for read-only reviewers and verifiers.',
    "- Use board channels when parallel workstreams need separate traffic; keep `main` for swarm-wide updates.",
    '- Use `role: "monitor"` for independent verification when correctness matters.',
    "- Keep concurrency sensible (2-5 workers for most tasks). Do not spawn one worker per trivial step.",
    "- Address agents explicitly with `@name` (or `@prefix` for numbered groups). Use `@all` only for swarm-wide decisions, never for routine status.",
    '- Expect workers to finish with `@coordinator [done] <summary>` and to report blockers with `@coordinator [blocked] <details>`.',
    "- Use `swarm_wait` to wait for worker updates instead of polling `read_board` in a loop; end your turn immediately after calling it.",
    "- Use `read_board` when you need context that arrived while you were working.",
    "- In Code Mode, call these tools as `tools.swarm`, `tools.post_message`, `tools.read_board`, and `tools.swarm_wait`.",
    "- Verify worker output before reporting completion. Add a verifier worker when correctness is uncertain.",
    "- Kill finished workers with `swarm` (`action: \"kill\"`) once their work is integrated.",
    "- Report progress and the final result to the user in clear, concise language.",
  ].join("\n");
}

/**
 * Build the initial prompt for a newly spawned worker (or monitor) session.
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
      : swarm.channels.map((channel) => channel.name)
    ).join(", ") || "main";
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
        ]
      : []),
    "",
    "Board & communication rules:",
    "- Start the assignment immediately. Do not post greetings or acknowledgements.",
    "- Stay inside your workspace. Do not edit files owned by another worker; report a conflict instead.",
    "- Use `read_board` with `since` to catch up on messages you missed; cite posts by `#seq`.",
    "- Use `post_message` to share concrete results, questions, or handoffs. Always `@mention` the specific next peer; never CC `@coordinator` on intermediate handoffs.",
    "- In Code Mode, call the board tools as `tools.read_board`, `tools.post_message`, and `tools.swarm_wait`.",
    "- If you are blocked, post `@<parent> [blocked] <what you need>` and call `swarm_wait`.",
    "- Before reporting done, run the focused checks that apply to your change (tests, typecheck, lint). If a check cannot run, say why.",
    "- When the assignment is complete, post `@<parent> [done] <concise summary: files changed, tests run, remaining risks>`. Use the actual parent name shown above.",
    "- When you have nothing left to do, call `swarm_wait` with the highest `seq` you have read and end your turn immediately. Do not poll in a loop.",
    "- Do not spawn other workers unless your assignment explicitly asks you to; the coordinator owns the roster.",
    "- Do not repeat work you have already completed. Build on the current workspace and board state.",
    "",
    "Assignment:",
    brief,
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
      ? "Review the updates. Decide the next concrete step, reply to the user if the swarm is finished or blocked, and call `swarm_wait` if you still need worker output."
      : "Act on any requests directed to you, post concrete results with `post_message`, and call `swarm_wait` (then end your turn) when idle.";

  return [
    `[swarm wakeup for @${member.name}] New board messages:`,
    formatted,
    "",
    tailInstruction,
  ].join("\n");
}
