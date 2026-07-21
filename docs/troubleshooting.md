# Troubleshooting

## `tmux` was not found

Install tmux with Homebrew, ensure it is executable, and either expose it through `PATH` or set the `tmux` field in `aiTerminalSessions.executables`.

```sh
brew install tmux
tmux -V
```

Executable-path settings are machine-scoped and cannot be supplied by an untrusted workspace.

## A second VS Code window says the workspace is already controlled

Only one extension host may own a workspace at a time. This prevents one window from overwriting state or terminating sessions used by another. Close the first window and wait a few seconds. A stale lease left by a crash expires automatically.

## The floating monitor stays in the main editor

Floating and always-on-top behavior uses optional workbench capabilities in VS Code 1.127. When a capability is unavailable, the monitor intentionally falls back to a normal editor panel. Session persistence and pinning continue to work.

## Tabs named like `db259…` appeared after reload

These are unresolved terminal editor shells serialized by VS Code, not lost tmux sessions. Version 0.4.0 removes shells belonging to the current workspace before recreating its managed tabs and replaces a serialized auxiliary monitor only after the main restore completes. Run **AI Sessions: Restore Tabs Now** if stale shells from an older build are still open.

## AI rename falls back to a local title

Run **AI Sessions: Diagnose AI Rename**. It reports the detected harness, context count, CLI login status, and available VS Code models without printing transcript content. Leave the model setting empty to use the CLI default.

## Recovering after state loss

Try these in order:

1. **AI Sessions: Restore Tabs Now**;
2. **AI Sessions: Session History**;
3. **AI Sessions: Recover Orphaned Private Session**.

Session History restores one closed tab at a time. Its final advanced item opens bulk snapshot recovery and warns before adding multiple tabs. The last command finds one-pane sessions on the extension's private tmux server that still belong to the current workspace.

## Inspecting the private server

```sh
tmux -L ai-terminal-sessions list-sessions
tmux -L ai-terminal-sessions attach -t <session-name>
```

Do not run `kill-server` unless you intend to terminate every managed process.
