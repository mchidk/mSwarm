# Changelog

All notable changes to mSwarm.

**Author:** Michael Christensen

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
