# Changelog

All notable changes to AI Terminal Sessions are documented here.

## 0.4.6

- Added an individual closed-session archive with one-tab restore for Codex, Claude Code, and generic terminals.
- Added an instant side preview of recent local conversation messages while navigating Session History.
- Kept snapshot recovery as a separate advanced action with a modal bulk-restore warning.
- Migrated recoverable sessions from existing snapshots into the individual history automatically.

## 0.4.5

- Added keyboard paging for managed tmux terminals with `Shift+Page Up` and `Shift+Page Down`.

## 0.4.4

- Prevented blank terminal editor tabs during startup and reload by restoring PTY editors sequentially after their tmux bridges attach, then replaying the visible pane snapshot.
- Resolved right-click rename and recovery commands from the active terminal editor label when VS Code does not expose `window.activeTerminal` after restore.
- Enabled tmux mouse handling so trackpad scrolling enters terminal scrollback instead of navigating shell history.
- Made forced restore detach disposed terminal objects before recreating tabs, preventing late close events from removing replacements.
- Made manual restore recover live tmux sessions from the latest history snapshot when the saved tab index is empty.
- Removed terminal editor stubs left by extension-host restarts after identifying every newly restored live tab.

## 0.4.3

- Finished the English localization of the Session Monitor UI.

## 0.4.2

- Recovered fresh workspace leases immediately when their extension-host PID is no longer alive.
- Added a short reload handoff window so a replacement extension host waits for its predecessor to release the lease.

## 0.4.1

- Prevented PTY reconnect redraws from resetting idle-age colors after tab restore.
- Kept agent cadence tied to transcript activity while preserving explicit shell input and generic process output as activity.
- Prevented restore-driven focus changes from acknowledging ready responses or refreshing focus timestamps.
- Added a one-time repair for legacy restore bursts already persisted by older builds.
- Reduced the public configuration surface from 25 settings to eight workflow decisions with stable product defaults.
- Made the entire Session Monitor card focus its terminal on click or keyboard activation.
- Made contextual titles lowercase and filtered acknowledgements and slash commands without assuming Portuguese-only input.

## 0.4.0: Open-source preview

- Added a compact floating Session Monitor with ANSI color and auto-scroll.
- Added workspace-scoped session history, tab order recovery, and composer draft recovery.
- Added live attention states, including an animated working indicator and acknowledged idle tiers.
- Added contextual one- or two-word AI rename using recent agent messages.
- Preserved `Shift+Enter` through tmux and propagated terminal resize events.
- Added a per-workspace process lease to prevent two VS Code windows from controlling the same sessions.
- Serialized state writes, validated persisted records, and removed volatile process/transcript data from durable state.
- Made destructive close transactional: failed tmux termination keeps recovery data.
- Added Workspace Trust, virtual workspace, platform, and internal-workbench capability declarations.
- Added stop-all and private recovery data cleanup commands.
- Recreate serialized Session Monitor windows after startup and discard unresolved VS Code terminal editor stubs, preventing `db259…` tabs and terminals stranded in the monitor after reload.

## 0.3.3

- Added the neutral outline working indicator with reduced-motion support.

Earlier versions were local development builds and were not published as public releases.
