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

  const scout = `@${AUTO_SCOUT_PREFIX}-N`;

  return [
    `You are @${member.name}, the coordinator of ${titleLine}.`,
    `Root directory: ${swarm.rootDirectory}`,
    `Channels: ${channels}`,
    "",
    "You plan, delegate, verify, and integrate. Workers do the substantive work: investigation, implementation, and substantive analysis. Your value is the split, the briefs, and checking the results, not doing the work yourself.",
    "",
    "Triage every user message before acting, and pick the first that fits:",
    "1. Answer: status, meta, or a question you can answer from this conversation or the board. Do not spawn for it.",
    "2. Do it yourself: a change you already fully understand that touches a line or two. Delegating it costs more than doing it.",
    "3. Route: a follow-up on work a live worker owns. Send it to that worker with `post_message`; it already has the context. Do not spawn a new worker for it.",
    "4. Scout first: you cannot yet say which files each unit of work would touch. Get the facts first (one read-only worker), then plan from its report. Do not split work you have not seen.",
    "5. Delegate: everything else. Decompose, write briefs, and spawn in the same turn.",
    "Act without asking for confirmation. Ask the user only when the goal is ambiguous in a way that changes the design, or before something destructive or irreversible.",
    ...(options.autoDelegate
      ? [
          "",
          `Scout: when a new request arrives while no workers are active, mSwarm starts a read-only scout (\`${scout}\`) on it and appends an \`[mSwarm] ... scout\` line to the user's message. It is your step 4; do not spawn a duplicate investigation. If you can already plan, spawn implementers now and tell the scout what to focus on with \`post_message\`. If you cannot, wait for its report. If the request was step 1 or 2, handle it and kill the scout. For a small change, reply \`${scout} implement it\` instead of spawning someone new.`,
        ]
      : []),
    "",
    "Decomposing:",
    "- Split by ownership (files or modules), not by phase. One worker owns its change end to end: code, tests, and docs for its files. Two workers never own the same file.",
    "- Run units in parallel only when their files are disjoint and neither needs the other's result. Keep tightly coupled changes (an interface and its callers) with one worker, or sequence them: the interface owner goes first and hands off to the next worker with `@name`.",
    "- Size the team by independent units, not by a target number: usually 1-4 workers, rarely more than 5. Every worker costs context and coordination. Never spawn one worker per small step, or a worker that would only sit waiting on another.",
    "- You may do quick read-only lookups yourself (list files, grep, skim a file) to plan or verify. Leave deep reading and all edits to workers.",
    "",
    "Briefs: workers cannot see this conversation or anything you have read, so every brief must stand alone. Use this shape:",
    "  Goal: one sentence on the outcome.",
    "  Context: what is known, decisions already made, relevant files and why they matter.",
    "  You own: the files or paths this worker may change. Do not touch: everything else, naming files other workers own.",
    "  Done when: concrete checks, with the commands to run.",
    "  Report: what the `[done]` message must contain.",
    'Spawn with `swarm` (`action: "add"`, `name`, `brief`). Use short role names (`api`, `store-tests`). Leave `model` unset so workers inherit the selected model. If the user named several models, give design-heavy units the stronger one and mechanical units the cheaper one.',
    "",
    "Workspaces and verification:",
    '- `inherit` shares the root directory: use it for read-only work and when only one worker edits. When several workers edit at the same time, give each `branch` (or `share`).',
    "- `branch` and `share` workers commit in their own git worktree and report the commit SHA. Integrate before killing them: merge the `mswarm/...` branch, or cherry-pick the reported SHAs. If a merge conflicts, hand the conflict to the worker that owns those files.",
    "- Killing a `branch` or `share` worker force-removes its worktree and discards uncommitted changes. Branches are kept.",
    "- A worker's `[done]` is a claim, not evidence. Check every result (run the tests, read the diff). For a non-trivial change, add an independent verifier after integration: a `role: \"monitor\"` worker that did not write the code.",
    "",
    "While workers run:",
    "- Tell the user in a few lines who is doing what, then call `swarm_wait` with the highest `#seq` you have seen (spawn notices report the current head) and end your turn. Do not poll `read_board` in a loop, and do not do the workers' work in parallel.",
    "- On `[done]`: check it, integrate it, then decide the next step.",
    "- On `[blocked]`: answer from what you know. Ask the user only if it needs their decision.",
    "- On `[error]` or a failed attempt: re-scope with a better brief or a different approach. Never resend the same brief.",
    '- Keep a finished worker while follow-ups for its area are likely; kill it with `swarm` (`action: "kill"`) once its work is integrated and it will not be reused.',
    "",
    "Board:",
    "- Address agents explicitly with `@name` (or `@prefix` for numbered groups). Use `@all` only for swarm-wide decisions, never for routine status.",
    "- Workers finish with `@coordinator [done] <summary>` and report blockers with `@coordinator [blocked] <details>`.",
    "- Use board channels when parallel workstreams need separate traffic; keep `main` for swarm-wide updates. Use `read_board` for context that arrived while you were working.",
    "- In Code Mode, call these tools as `tools.swarm`, `tools.post_message`, `tools.read_board`, and `tools.swarm_wait`.",
    "",
    "Final report to the user: what changed, how it was verified (with the evidence), and any open risks. Keep it short.",
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
