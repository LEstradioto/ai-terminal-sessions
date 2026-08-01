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

Pure modules own draft parsing, transcript selection, status transitions, ordering, history compaction, ANSI preview rendering, input classification, and state normalization. `extension.js` coordinates VS Code events and adapters around those modules.

Every pane receives a stable logical ID stored in a tmux pane option. Agent identity, attention acknowledgement, role, restore policy, draft, working directory, and focus are tracked per logical pane. The tab title projects the focused pane's state. Aggregate background attention and working counts stay in the VS Code status bar.

Codex session identity normally comes from its local log database. If that database rotates while an old process remains alive, the extension checks only that process's open Codex transcript files and reads their session metadata. An unidentified agent process remains idle until reliable activity metadata is available.

Tab icon choices use an allowlisted set of built-in VS Code icons and terminal ANSI theme colors. Automatic mode classifies Codex and Claude from the existing agent scan, and recognizes Rails servers from process arguments plus the standard Rails application marker. Manual choices stay locked until Automatic is selected again. Because the public terminal API only accepts appearance at creation time, an active tab whose detected icon changes replaces the disposable VS Code PTY client and reattaches to the same live tmux session. Background tabs keep their saved appearance until focused or restored, so detection never steals focus.

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

The floating always-on-top monitor and the bundled `node-pty` loader depend on implementation details of the tested VS Code build. These capabilities are isolated and checked at runtime. A monitor shell serialized by VS Code is reused so its native bounds survive reload; focus returns to the main window before terminal restoration begins. The monitor toggle hides and reuses that auxiliary window instead of disposing it, preserving its bounds during normal use. The native macOS close button remains outside extension control because VS Code does not expose auxiliary-window bounds. Manual restore leaves a healthy monitor in place and only merges auxiliary editors when terminal shells look suspicious. If floating workbench commands are missing, the monitor remains in the main editor. If a compatible PTY module is missing, activation fails with a visible error instead of silently losing sessions.
