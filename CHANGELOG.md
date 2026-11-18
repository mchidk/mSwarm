# Changelog

All notable changes to mSwarm.

**Author:** Michael Christensen

## Unreleased

### Prompts

- The coordinator now triages every message before acting: answer from what it already knows, route to a live worker,
  scout first when it cannot yet name the files involved, or delegate. It splits work by file ownership rather than by
  phase, sizes the team by independent units, writes briefs in a fixed shape (Goal / Context / You own /
  Do not touch / Done when / Report), treats a worker's `[done]` as a claim to check, and has explicit rules for
  `[blocked]` and failed workers.
- The coordinator optimizes for wall-clock time. It is the serial bottleneck, so it never takes on work itself, even
  small changes or the investigation behind a `[blocked]` report. It spawns everything that can start now in one
  turn, acts on each report as it arrives instead of waiting for all workers, runs acceptance checks itself, and
  leaves diff review to a monitor that runs alongside the next work.
- The coordinator prompt now requires self-contained briefs (workers cannot see the conversation), forbids two workers
  owning the same file, and explains integration: merge `branch` workers, cherry-pick `share` SHAs, then kill.
- Worker prompts interpolate the real parent name in `[done]`/`[blocked]` instructions, tell isolated workers to commit
  and report the SHA (uncommitted work is lost on kill), warn `inherit` workers that the root is shared, point to
  `swarm status` for finding peers, and give monitors a `[pass]`/`[fail]` report format.
- The worker brief is no longer sent twice. It lives in the system prompt, and the first message is a short kickoff
  that names the brief's `#seq`.
- System prompts no longer change from turn to turn, which keeps prompt caching effective.

- Workers, scouts, and monitors get role-specific rules. Workers do exactly the brief, list other problems instead of
  fixing them, report `[blocked]` early when a brief looks wrong, never install packages into shared dependency
  folders, and include each check command with its result in `[done]`. Scouts are read-only and report units ready to
  spawn (`name | goal | owns | done when`). Monitors may run tests and builds but not edit source.
- The coordinator spawns scouts with `role: "scout"` and spawns straight from their units. It shards independent
  mechanical work with `tasks` (up to about 8 workers), runs the full checks once after merging instead of re-running
  every worker's checks, and schedules dependency changes as their own unit.

### Coordinator agent

- `install` now denies the `swarm` agent file edits (`edit`, as OpenCode's Plan agent does) in addition to built-in
  subagents, so delegation is enforced rather than only requested. Re-running `install` upgrades an agent entry it
  wrote earlier; customized entries are left alone.

### Worktrees

- New `branch`/`share` worktrees get the root's git-ignored dependency folders (`node_modules`, `.venv`, `venv`)
  linked in, so workers can run checks immediately. The links are removed before the worktree on cleanup. This also
  fixes `git worktree remove` leaving the folder behind when it contains a junction.

### Automatic scout (was: first responder)

- The scout now uses the new `scout` role.

- The `auto-N` worker is now a read-only scout. Implementers come from the coordinator, so the two no longer edit the
  same files.
- The scout is reserved before the coordinator's model call, and the request is annotated with
  `[mSwarm] Started read-only scout @auto-N`. The coordinator knows about it in the same turn instead of duplicating
  the work, and the coordinator prompt explains how to steer it.
- Scouts start only when no workers are active. Follow-ups such as "make it blue" no longer spawn context-free
  workers.
- Fixed: `/mswarm` without a goal started a worker whose brief was the plugin's own "ask the user" instruction.
- Fixed: the substantive-prompt check never matched inflected verbs such as "analyze", "investigate", "optimize", or
  "reviewing". It also now recognizes `why ...` and `how does ...` questions.

### Board

- `swarm_wait` never goes below the member's read watermark, so `since: 0` no longer replays the worker's own brief.
- `read_board` advances the read watermark only across returned messages, so a `limit`-truncated or channel-filtered
  read cannot mark a skipped mention as read and suppress its wakeup.

### Tools

- The swarm tools are removed from sessions that are neither in Swarm mode nor part of a swarm, so ordinary Build/Plan
  sessions do not pay their context tokens or create swarms by accident.

## 0.2.0 - 2026-11-16

### OpenCode 2.x

- Migrated from the OpenCode 1.x hook API to `@opencode/plugin` 2.x (`Plugin.define`, tool/command transforms, session
  hooks, and the public event stream).
- Added the selectable **swarm** primary agent (Shift+Tab) with subagent delegation disabled in favor of mSwarm workers.
- The plugin now loads under OpenCode 2.3.0; the previous entrypoint was rejected by the V2 loader.

### Coordinator and visibility

- The coordinator remains the single point of entry and delegates non-trivial work and follow-ups.
- Added a fire-and-forget first responder: substantive Swarm-mode prompts start one `auto-*` worker without delaying
  the coordinator's first token. Short status/meta prompts stay direct.
- Restored the concise coordinator prompt to reduce reasoning latency.
- Added live roster and spawn/kill/failure notices to the coordinator transcript.
- Avoided redundant state writes when provider/model/variant did not change.
- Swarm state is created lazily on the first worker spawn; entering Swarm mode or asking a meta question leaves no
  `.opencode` state.
- `/mswarm kill` and coordinator-session deletion remove swarm state and prune empty mSwarm directories.

### Reliability

- Wakeups now use `session.execution.succeeded` (plus failed/interrupted events) because `session.idle` is not
  emitted reliably for every session in OpenCode 2.3.
- Marked the initial worker brief read so a completed execution cannot re-deliver the assignment.
- Advanced read watermarks only after a wake prompt is accepted, so failed deliveries are retried instead of lost.
- Added atomic state writes with fsync and Windows-aware rename retries.
- Added disk-refresh coherence between plugin instances and startup reconciliation for members left `working`.
- Added bounded wake batches, a 2,000-message board cap, and a 64 KB message limit.
- Pre-validated batch worker names and cleaned up failed sessions/worktrees.
- Preserved `mswarm/*` branches on kill so committed work can still be merged.

### CLI

- Writes the OpenCode 2.x `plugins` key and migrates a legacy `plugin` array.
- Adds `--local [path]` so a checkout can be installed before the package is published.
- Supports `--global --local` so one checkout and its `swarm` agent are available in every project; avoid keeping a
  duplicate project-local config when the global install is active.
- Adds the `swarm` primary agent, preserves unrelated JSONC comments, and finds project configuration from nested
  directories.

### Documentation

- Rewrote the README for OpenCode 2.x, Swarm mode, workspace semantics, and reliability behavior.
- Added the author attribution to the README, LICENSE, package metadata, and source headers.
