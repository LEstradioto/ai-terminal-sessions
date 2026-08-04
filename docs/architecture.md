# Architecture

Each managed VS Code tab maps to one session and one window in a private tmux server. The window may contain an agent pane plus server, logs, tests, CI, or shell helpers:

```text
VS Code terminal tab
  → disposable node-pty attach client
    → tmux -L ai-terminal-sessions
      → one tmux session and window
        → one or more persistent panes
```

VS Code remains the tab multiplexer. tmux supplies process persistence and optional helpers inside a tab. The private server ignores the user's tmux configuration, uses the standard `Ctrl+B` prefix, hides its status bar, and leaves right-click to VS Code.

## Functional core and I/O shell

Focused modules own draft parsing, transcript selection, status transitions, ordering, history compaction, ANSI preview rendering, input classification, and state normalization. `extension.js` coordinates VS Code events around six visible boundaries:

- `runtime.js` wraps filesystem, process, workbench, and workspace lease behavior.
- `tmux.js` and `tmux-pty.js` own persistent processes and the disposable terminal bridge.
- `agents.js`, `transcripts.js`, and `rename-context.js` observe Codex and Claude Code without sending transcript data unless the user explicitly runs AI rename.
- `session-state.js` and `session-recovery.js` own active state, drafts, archives, snapshots, and workspace moves.
- `session-presentation.js` owns tab status, icons, pane roles, and activity rules.
- `monitor-model.js` and `monitor-view.js` own the bottom panel monitor.

Every pane receives a stable logical ID stored in a tmux pane option. Agent identity, reply acknowledgement, role, restore policy, draft, working directory, and focus are tracked per logical pane. The tab title projects the focused pane's state. Aggregate background attention and working counts stay in the VS Code status bar.

Codex session identity normally comes from its local log database. If that database rotates while an old process remains alive, the extension checks only that process's open Codex transcript files and reads their session metadata. An unidentified agent process remains idle until reliable activity metadata is available.

Turn status uses provider boundaries instead of terminal silence. Codex starts on `task_started` and becomes ready only after `task_complete`. Claude starts on a human prompt and becomes ready only after `turn_duration`. The start, completion, and elapsed duration are stored per pane, so a final-answer redraw cannot turn a tab green early and a long turn keeps its timer across extension reloads. Ready uses the provider's completion timestamp and stays green until the next submitted input in that pane.

Mouse wheel behavior is also pane-aware. Codex and shell panes enter tmux scrollback, while Claude panes receive the event in Claude Code's own alternate-screen UI. Existing live panes have their routing options reapplied on attach so upgrades do not leave them unconfigured. Explicit page-up and page-down commands always open tmux history. Clipboard writes pass through a local non-empty filter so a focus click cannot erase an external copy.

Tab icon choices use an allowlisted set of built-in VS Code icons and terminal ANSI theme colors. Automatic mode classifies Codex and Claude from the existing agent scan, and recognizes Rails servers from process arguments plus the standard Rails application marker. Manual choices stay locked until Automatic is selected again. The public terminal API only accepts appearance at creation time, so automatic detection saves the new appearance for the next safe terminal recreation or reload. It never reconnects a live tab just to change its icon. An explicit manual icon change may reconnect the disposable VS Code PTY client to the same live tmux session.

Durable state writes are serialized through `SessionStateStore`. A per-workspace file lease prevents two extension hosts from writing or terminating the same sessions at once. Destructive close first confirms tmux termination and only then removes recovery state.

Closed sessions use a separate workspace-scoped archive. Agent session IDs deduplicate repeat closes, previews are bounded and sanitized, and restoring an entry adds only its tab. The rolling snapshot history remains independent and is reserved for explicit bulk recovery.

Workspace relocation is a two-phase operation. Preparation writes an atomic transfer bundle before stopping any process. Only after every managed tmux session stops does it clear the old workspace's active restore set. Import maps old workspace roots to the newly opened roots, persists the relocated recovery stores, rebuilds tabs and panes, and finally deletes the transfer bundle.

## Restore contract

- If tmux is alive, a new disposable PTY client attaches to it.
- After a cold boot, each Codex and Claude Code pane resumes only when a valid saved UUID is present.
- Saved pane geometry and the previously focused pane are reapplied after pane creation.
- Generic helper processes are never automatically re-executed after a cold boot or workspace move. Their panes return as shells.
- Explicit tab close follows `closeBehavior`; clean shell exit removes the saved tab.
- Window reload/shutdown keeps tmux and restores visual tabs in their captured order.
- Serialized terminal editor shells are disposable. On startup, unresolved shells belonging to the current VS Code workspace storage are closed before fresh PTY clients are created.

## Compatibility boundary

Session Monitor is a contributed VS Code webview view in the native bottom panel. It no longer creates an auxiliary window or depends on floating-window commands. Startup retains a best-effort migration path that closes monitor editors serialized by older releases and returns any stranded terminal editors to the main window.

The bundled `node-pty` loader depends on the compatible module shipped with the tested VS Code build. If it is missing, activation fails with a visible error instead of silently losing sessions.
