# mSwarm

**Antigravity-style multi-agent orchestration for OpenCode 2.x - with first-class Swarm mode.**

mSwarm turns OpenCode into a coordinator plus a team of specialized worker sessions. It adds a persistent shared
message board, targeted wakeups, git worktree isolation, and an event-driven wait mechanism with zero polling.

**Author:** Michael Christensen

---

## Highlights

- **Swarm mode built into the mode switcher** - after installation, press **Shift+Tab** until the **swarm** agent
  appears, then describe the goal. No slash command required. `/mswarm <goal>` also works from Build or Plan.
- **Selected-model inheritance** - workers inherit the model selected for the session unless a per-worker or
  per-swarm model is chosen.
- **Zero-polling `swarm_wait`** - workers park without burning tokens, then wake through OpenCode's
  `session.execution.succeeded` event and `session.prompt`.
- **Targeted addressing** - `@name`, `@prefix` for numbered groups, `@all`, and `@#channel` for channel subscribers.
- **Channels** - create, join, leave, list, and archive parallel workstreams.
- **Workspace isolation** - `inherit`, `share` (detached worktree), or `branch` (`mswarm/<swarm>/<member>` worktree).
- **Sharding and forks** - `n` copies, per-slice `tasks`, and parent-linked `fork` sessions.
- **Durable board** - append-only messages, members, channels, and state persisted atomically under
  `.opencode/mswarm/swarms/<swarmId>.json`.
- **OpenCode 2.x native** - implemented with `@opencode/plugin` `Plugin.define`, `ctx.tool.transform`,
  `ctx.command.transform`, session hooks, and the public event stream.

---

## Requirements

- OpenCode **2.3.0 or newer** (the V2 plugin API).
- Node.js **22 or newer**.
- Git is optional. Without a git repository, `share` and `branch` modes fall back to the shared root with a warning.

> OpenCode 1.x plugins use a different API and cannot load this version. mSwarm 0.2.x targets OpenCode 2.x.

---

## Installation

### CLI (recommended)

```bash
npx opencode-mswarm install
```

> `npx` resolves the package from npm. Until `opencode-mswarm` is published, use **Local development** below and point
> `plugins` at this checkout.

This adds `opencode-mswarm` to the `plugins` array and registers the **swarm** primary agent so it is available with
Shift+Tab.

Options:

```bash
npx opencode-mswarm install --project   # ./opencode.json(c)
npx opencode-mswarm install --global    # ~/.config/opencode/opencode.json(c)
npx opencode-mswarm install --local     # Use this checkout instead of the npm package
npx opencode-mswarm status              # Show plugin and Swarm-mode status
npx opencode-mswarm uninstall           # Remove plugin and the Swarm agent
```

### Manual configuration

Add the plugin and the Swarm agent to your `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-mswarm"],
  "agents": {
    "swarm": {
      "description": "mSwarm coordinator: delegates work to parallel worker sessions with a shared board and isolated worktrees",
      "mode": "primary",
      "color": "#8b5cf6",
      "permissions": [
        { "action": "subagent", "resource": "*", "effect": "deny" }
      ]
    }
  }
}
```

The plugin adds the full coordinator instructions at request time, so the agent entry can stay minimal.

### Local development

```bash
npm install
npm run build
node dist/cli.js install --project --local
```

`--local` writes this checkout's absolute path into `plugins` instead of the npm package name. You can also pass an
explicit path:

```bash
node dist/cli.js install --project --local C:/path/to/mSwarm
```

Or configure it manually:

```jsonc
{
  "plugins": ["C:/path/to/mSwarm"]
}
```

OpenCode watches configuration and plugin changes; use `/reload` if a rebuild is not picked up.

---

## Usage

### Swarm mode

1. Press **Shift+Tab** until the status line shows **swarm**.
2. Describe the goal, for example:

   ```text
   Refactor the auth module, add tests, and update the API docs.
   ```

3. The coordinator plans the work, spawns workers, and reports back when the swarm finishes or is blocked.

### Slash commands

- `/mswarm <goal>` - initialize a swarm in the current session and start coordinating.
- `/mswarm board` - show members, states, channels, and recent board messages.
- `/mswarm kill` - abort and clean up active workers in the current swarm.

### Switching models

List configured models:

```json
swarm({ "action": "models" })
```

Switch a waiting worker (or yourself) while preserving its session history:

```json
swarm({
  "action": "model",
  "name": "worker-1",
  "model": "providerID/modelID"
})
```

### Tools

| Tool | Purpose | Key parameters |
| :--- | :--- | :--- |
| `swarm` | Lifecycle, roster, models, channels | `action`: `title` \| `add` \| `status` \| `models` \| `model` \| `kill` \| `channel` |
| `post_message` | Post to the board and wake mentioned members | `text`, `channel?` |
| `read_board` | Read board messages or inspect your own state | `since?`, `limit?`, `seqs?`, `channel?`, `status?` |
| `swarm_wait` | Park until a matching message arrives | `since`, `mentions_only?` |

`swarm` (`action: "add"`) accepts `workspace`, `role` (`worker` or `monitor`), `n`, `tasks`, `fork`, `channels`, and
`model`.

---

## How it works

```text
User (Swarm mode or /mswarm <goal>)
  │
  ▼
Coordinator Session ──(swarm.add)──▶ Worker Sessions (inherit / share / branch)
  │                                       │
  │◀────────── Shared Board ──────────────┘
  │      (post_message / read_board)
  │
  ▼
Event-driven wakeup
  • Worker calls swarm_wait(since) and ends its turn
  • OpenCode emits session.execution.succeeded; the dispatcher parks the worker
  • A matching post (@name, @prefix, @all, @#channel) calls session.prompt
    with the unread messages; no timers or polling loops
```

1. **Swarm mode** creates the coordinator record on the first model request. `/mswarm` does the same from any mode.
2. **The board** records an append-only sequence of `#seq` messages, members, channels, and read/post watermarks.
   State is written atomically (write, fsync, rename) with retries for transient Windows file locks.
3. **Workers** are created as independent OpenCode sessions, optionally isolated in git worktrees, and started with a
   worker brief. Their initial brief is marked read immediately so a completed execution cannot re-deliver it.
4. **Wakeups** are driven by `session.execution.succeeded`, `session.execution.failed`,
   `session.execution.interrupted`, `session.model.selected`, and `session.deleted` events. The read watermark
   advances only after a wake prompt is accepted, so a failed delivery is retried by the next post instead of being
   lost.
5. **State transitions** are reinforced by the prompt and model-context hooks: an admitted prompt or model request
   marks the member working, and a completed execution with no unread messages marks it waiting.

### Workspace modes

| Mode | Behavior |
| :--- | :--- |
| `inherit` | Worker uses the project root. Best for read-only reviewers and verifiers. |
| `share` | Detached git worktree from `HEAD`. Best for concurrent authors who do not need a named branch. |
| `branch` | Git worktree on `mswarm/<swarmId>/<memberName>`. Best when each worker's changes should be reviewed or merged independently. |

Worktrees live under `.opencode/mswarm/worktrees/` and are removed on `kill`. **Branches are preserved by default**, so
committed worker changes remain available for review or merge after the worktree is cleaned up. Re-spawning a member
with the same name uses a numbered branch suffix instead of deleting the earlier branch. Detached `share` worktrees
have no branch, so integrate or commit their changes before killing the worker.

The state directory is git-ignored by default in this repository; add `.opencode/mswarm/` to your own `.gitignore` if
needed.

### Sharding and forks

- `n: 3` with `name: "dev"` creates `dev-1`, `dev-2`, `dev-3`.
- `tasks: ["auth", "db"]` creates `dev-1` and `dev-2` with their own slice of the brief.
- `fork: "coordinator"` or `fork: "<member>"` creates a child session linked to the source session. OpenCode 2.x's
  plugin context does not expose history-copying forks, so mSwarm creates a linked child and gives the worker the
  board brief rather than claiming an exact transcript copy.

---

## Reliability notes

- Names and channel names are validated against a strict safe pattern, preventing path traversal through worktree
  directory names.
- Batch spawns validate every target name before creating any session, so a name collision cannot leave orphan
  sessions or worktrees.
- A failed worker startup is marked `killed`, its session is removed, and its worktree is cleaned up.
- Brief text is posted with an explicit mention scope, so `@mentions` inside a brief cannot wake unrelated workers.
- Board messages are capped at 64 KB, and the board keeps the most recent 2,000 messages per swarm to keep writes
  fast; read watermarks are advanced when old messages are pruned.
- Workers report `[done]`, `[blocked]`, and `[error]` to their parent. The coordinator is woken by these reports only
  when it is actually idle.

---

## State

```text
.opencode/mswarm/
  swarms/
    <swarmId>.json      # members, channels, messages, model, watermarks
  worktrees/
    <swarmId>/
      <memberName>/     # optional isolated workspaces
```

State is local to the project and can be deleted when no swarm is running. The plugin reloads existing state at
startup, so a restart does not lose the roster or board.

---

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/
npm test            # node --test with the TypeScript resolve hook
```

The test suite covers the store, dispatcher state machine, worktree lifecycle, CLI configuration migration, and the
OpenCode 2.x plugin registration/tool/command/event wiring. See [CHANGELOG.md](CHANGELOG.md) for release notes.

---

## Author

**Michael Christensen**

## License

[MIT](LICENSE)
