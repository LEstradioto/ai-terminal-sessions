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

## The monitor reopens at the default size or position

Hide it with **AI Sessions: Show or Hide Session Monitor** or the monitor shortcut. This keeps the auxiliary window alive and restores the same size and position when you show it again.

The native macOS close button destroys the auxiliary window outside the extension's control. VS Code does not expose that window's bounds through its extension API, so a replacement may use the default size or position. If you already closed it this way, resize the replacement once and use the extension toggle from then on.

## Tabs named like `db259…` appeared after reload

These are unresolved terminal editor shells serialized by VS Code, not lost tmux sessions. The extension removes shells belonging to the current workspace before recreating its managed tabs. The serialized Session Monitor is kept in its auxiliary window, but focus returns to the main window before terminal restore begins. Run **AI Sessions: Restore Tabs Now** if stale shells from an older build are still open.

## AI rename falls back to a local title

Run **AI Sessions: Diagnose AI Rename**. It reports the detected harness, context count, CLI login status, and available VS Code models without printing transcript content. Leave the model setting empty to use the CLI default.

## Recovering after state loss

Try these in order:

1. **AI Sessions: Restore Tabs Now**;
2. **AI Sessions: Session History**;
3. **AI Sessions: Recover Orphaned Private Session**.

Session History restores one closed tab at a time. Its final advanced item opens bulk snapshot recovery and warns before adding multiple tabs. The last command finds sessions on the extension's private tmux server that still belong to the current workspace.

## Moving a workspace to another disk

Do not copy or move the folder while managed tmux processes are running. Use **AI Sessions: More Actions...**, then **Prepare workspace move...**. After it confirms every process stopped, quit VS Code, move the folder, open the new location, and choose **Import a prepared workspace move...**. If preparation reports a stop failure, inspect **Show log** and leave the folder in place.

Only paths inside the open workspace roots are rewritten. A pane that was working in a sibling or unrelated folder falls back to an existing local directory if its old path no longer exists.

## Inspecting the private server

```sh
tmux -L ai-terminal-sessions list-sessions
tmux -L ai-terminal-sessions attach -t <session-name>
```

Do not run `kill-server` unless you intend to terminate every managed process.
