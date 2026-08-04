# Changelog

All notable changes to AI Terminal Sessions are documented here.

## 0.6.0

- Added a short public demo to the README and tightened the product overview around the daily tab workflow.
- Documented how to identify the child process behind repeated macOS App Data prompts without granting VS Code Full Disk Access.
- Moved Session Monitor into the native VS Code bottom panel beside Problems, Output, and Terminal.
- Stopped automatic process icon detection from reconnecting a live terminal and flashing its screen.
- Restored focus to the tab selected by VS Code after a terminal exits or closes.
- Kept mouse-wheel history inside tmux even when Codex uses its alternate screen.
- Made normal click and drag select and copy text, then return immediately to live output.
- Made double click copy one terminal word.
- Added arrow-key navigation, `Enter`, and `Escape` to the focused Session Monitor.
- Restored Rename with AI as a fast Command Palette action for the active managed tab.
- Kept tmux mouse selections visible and copied them directly to the macOS clipboard.
- Added a visible **Jump to bottom** action while the active pane is paused in tmux copy mode.
- Added `v`, arrow keys, and `y` as a simple keyboard selection flow in tmux copy mode.
- Added multiple panes per tab with the standard `Ctrl+B` tmux prefix and a contextual pane actions menu.
- Tracked agent status, attention acknowledgement, roles, focus, and drafts independently per pane.
- Restored saved pane layouts and resumed Codex or Claude agents independently after a cold boot.
- Kept the tab marker tied to the focused pane while counting background pane work and attention in the status bar.
- Kept the active prompt timer and last completed turn time visible in the status bar.
- Routed Claude mouse selection to its own alternate-screen UI instead of an empty tmux copy view.
- Added a safe prepare and import workflow for moving a workspace to another folder or disk.
- Left right-click to VS Code instead of opening both the VS Code and tmux menus.

## 0.5.6

- Kept a completed answer green until the user submits the next terminal message, regardless of tab focus or draft editing.
- Added contextual actions to mark a session as handled or manually flag it for attention.

## 0.5.5

- Refreshed Codex session identity while a process stays alive so compacted conversations keep reporting their current working and ready states.
- Chose the newest open parent transcript when the Codex log database is unavailable.

## 0.5.4

- Activated during workbench startup instead of waiting for every eager extension to finish.
- Restored tabs in the background without blocking VS Code startup.
- Collapsed per-session tmux setup into one client invocation to reduce restore overhead.

## 0.5.3

- Increased new managed terminal scrollback from the tmux default of 2,000 lines to 20,000 lines.
- Documented the physical `Shift+Fn+Up/Down` paging shortcut for MacBook keyboards.

## 0.5.2

- Preserved the floating Session Monitor's native size and position across window reloads.
- Kept a healthy monitor in place during manual tab restore instead of rebuilding its auxiliary window.
- Added a compact cyan identity bar without changing terminal ANSI colors.

## 0.5.1

- Recovered Codex session identity from transcripts still opened by the process when Codex rotates its local log database.
- Stopped treating an unidentified Codex or Claude process as permanently working.
- Fixed old completed sessions showing a working marker for days.

## 0.5.0

- Added a status bar counter for total sessions, working agents, and sessions needing attention.
- Added a fast session switcher grouped by attention, working, recent, and older activity.
- Added restore health checks that warn when saved sessions, live terminal connections, and visible tabs disagree after reload.

## 0.4.9

- Treated Codex and Claude interruptions as acknowledgement-based attention events instead of permanent errors.
- Cleared a red interrupted marker after the user returns to or interacts with its tab.
- Prevented an old `turn_aborted` transcript event from reactivating the red marker on every poll.
- Migrated existing stuck interruptions using their saved agent activity and real tab-focus timestamps.

## 0.4.8

- Made tab icons automatic by default for Codex, Claude Code, Rails servers, and regular shells.
- Added dedicated Codex, Claude Code, and Rails presets using built-in VS Code icons and theme colors.
- Kept manual icon choices locked per tab and added an Automatic option to resume process detection.
- Limited live icon reconnection to the active tab so background sessions never steal focus.

## 0.4.7

- Added eight colored tab icon presets for terminal, agent, code, server, deploy, database, test, and debug sessions.
- Persisted each icon choice across reloads, snapshots, and closed-session history.
- Reduced the Command Palette to five clear entry points while keeping contextual actions available through two focused menus.
- Ordered the eight existing settings by workflow importance without adding new configuration.

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
