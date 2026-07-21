# Architecture

Each managed VS Code tab maps to one window and one pane in a private tmux server:

```text
VS Code terminal tab
  → disposable node-pty attach client
    → tmux -L ai-terminal-sessions
      → one persistent shell / agent / server process
```

VS Code remains the visual multiplexer. tmux supplies process persistence only; it has no status bar, prefix, sidebar, or user configuration.

## Functional core and I/O shell

Pure modules own draft parsing, transcript selection, status transitions, ordering, history compaction, ANSI preview rendering, input classification, and state normalization. `extension.js` coordinates VS Code events and adapters around those modules.

Durable state writes are serialized through `SessionStateStore`. A per-workspace file lease prevents two extension hosts from writing or terminating the same sessions at once. Destructive close first confirms tmux termination and only then removes recovery state.

Closed sessions use a separate workspace-scoped archive. Agent session IDs deduplicate repeat closes, previews are bounded and sanitized, and restoring an entry adds only its tab. The rolling snapshot history remains independent and is reserved for explicit bulk recovery.

## Restore contract

- If tmux is alive, a new disposable PTY client attaches to it.
- After a cold boot, Codex and Claude Code resume only when a valid saved UUID is present.
- Generic processes are never automatically re-executed after a cold boot.
- Explicit tab close follows `closeBehavior`; clean shell exit removes the saved tab.
- Window reload/shutdown keeps tmux and restores visual tabs in their captured order.
- Serialized terminal editor shells are disposable. On startup, unresolved shells belonging to the current VS Code workspace storage are closed before fresh PTY clients are created.

## Compatibility boundary

The floating always-on-top monitor and the bundled `node-pty` loader depend on implementation details of the tested VS Code build. These capabilities are isolated and checked at runtime. A monitor shell serialized by VS Code is discarded and recreated only after the main terminal tabs are ready. If floating workbench commands are missing, the monitor remains in the main editor. If a compatible PTY module is missing, activation fails with a visible error instead of silently losing sessions.
