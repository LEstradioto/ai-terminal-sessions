# AI Terminal Sessions

Agent workflows don't need another dashboard. Sometimes all you need is tabs.

I built this for the way I already use VS Code: Codex, Claude Code, servers, and CI jobs open side by side, with fast keyboard navigation and no lost context after a reload.

[![VS Code 1.127+](https://img.shields.io/badge/VS%20Code-1.127%2B-23a8f2)](https://code.visualstudio.com/)
[![macOS preview](https://img.shields.io/badge/platform-macOS-111827)](#tested-setup)
[![MIT](https://img.shields.io/badge/license-MIT-34d399)](LICENSE)

[![Persistent AI sessions running in ordinary VS Code tabs](media/tabs.png)](media/ai-terminal-sessions-demo.mp4)

[Watch the 45-second demo](media/ai-terminal-sessions-demo.mp4)

## What it does

| Feature | Behavior |
|---|---|
| Persistent tabs | Each VS Code tab owns a private tmux session with one or more panes |
| Cold restore | Codex and Claude panes resume independently; helper panes return as shells without rerunning commands |
| Agent status | Tabs show working, permission, ready, interrupted, and idle states |
| Session counter | Shows saved, working, and attention counts, and catches restore mismatches |
| Session Monitor | Pins up to four ANSI-colored, auto-scrolling previews in a compact floating window |
| Draft recovery | Saves the visible composer after 1.5 seconds and restores it without submitting |
| Session history | Keeps up to 500 closed tabs with one-tab restore and a local message preview |
| Contextual rename | Uses the latest two useful messages to make a short lowercase topic |
| Automatic icons | Distinguishes Codex, Claude Code, Rails servers, and regular shells |
| Pane support | Keeps one main agent per tab while allowing servers, logs, tests, or other helpers beside it |

![A compact Session Monitor pinned over the main VS Code window](media/session-monitor.gif)

## Daily workflow

1. Open a persistent terminal and start Codex, Claude Code, a server, or a watch command.
2. Move through sessions like browser tabs.
3. Read the tab marker to see which agent is working or waiting for you.
4. Pin long-running output to the Session Monitor when you want it in view.
5. Reload VS Code whenever you need to. The tabs, order, panes, processes, names, and drafts return.

The Command Palette stays focused on five entry points:

- **New Persistent Terminal**
- **Session History**
- **Customize Active Tab...**
- **Show or Hide Session Monitor**
- **More Actions...**

Right-click a managed tab for rename, icon, draft, pane, pin, and attention actions. **Rename with AI** also remains directly available in the Command Palette.

## Status markers

| Marker | Meaning |
|---|---|
| `○⠋` | Agent working |
| `🟠` | Waiting for permission or a tool |
| `🟢` | New answer ready |
| `🔴` | Interrupted turn that still needs review |
| `🟨` | Idle for less than 30 minutes |
| `🟧` | Idle for 30 minutes to 4 hours |
| `🟫` | Idle for more than 4 hours |

Green stays green until you send the next message or mark the session as handled. Focusing a tab or editing a draft does not clear it.

## Install

This is a macOS preview. It needs VS Code 1.127 or newer, tmux 3.4 or newer, and Node.js 20 when building from source.

It is not published to the Visual Studio Marketplace yet. I want more daily use behind the restore and recovery paths before doing that.

```sh
brew install tmux
git clone https://github.com/LEstradioto/ai-terminal-sessions.git
cd ai-terminal-sessions
npm test
```

Open the repo in VS Code and press `F5`, or build a local VSIX:

```sh
npx @vscode/vsce package
code --install-extension ai-terminal-sessions-0.6.0.vsix
```

Open **AI Sessions: More Actions...** and choose **Use as default terminal profile** only if you want the terminal `+` button to create managed tabs.

### Tested setup

I use this daily on an Apple Silicon Mac with macOS 26.5.2, VS Code 1.128.1, zsh 5.9, tmux 3.6a, Codex CLI, and Claude Code.

I have not tested Intel Macs, other operating systems, shells, terminal configurations, multiplexers, or agent harnesses. If your setup differs, expect rough edges and include versions plus a redacted log when [opening an issue](https://github.com/LEstradioto/ai-terminal-sessions/issues).

`tmux`, `codex`, and `claude` are resolved from `PATH`. Set absolute paths in `aiTerminalSessions.executables` when a CLI works in Terminal.app but not in VS Code. The private tmux server ignores `~/.tmux.conf`, so personal bindings do not leak into managed tabs.

## Shortcuts and tmux

| Action | Default | My setup |
|---|---:|---:|
| Pin active tab | `Cmd+Option+Down` | `Hyper+Down` |
| Toggle monitor | `Cmd+Option+Up` | `Hyper+Up` |
| Scroll tmux history | `Shift+Page Up/Down` | Same |
| Move between tabs | Your VS Code binding | `Hyper+Left/Right` |

"Hyper" is my macOS Hyper key mapped to `Cmd+Option`. The extension does not register it.

On a MacBook, `Page Up/Down` is `Fn+Up/Down`, so keyboard scrolling is `Shift+Fn+Up/Down`. Copy mode uses `v` to begin selection, arrow keys to extend it, and `y` to copy. Mouse selection also enters copy mode and keeps the selected text visible after copying. While it is active, the status bar shows **Jump to bottom**. Click it, or press `q` or `Escape`, to return to live output.

Each tab keeps the standard tmux prefix, `Ctrl+B`. Useful follow-up keys are `%` to split right, `"` to split down, arrow keys to change pane, `o` for the next pane, `z` to zoom, `x` to close, `[` for scrollback, and `?` for the full list. The tab context menu exposes the same pane actions while you learn the bindings.

## Close, restore, and history

| Action | Default behavior |
|---|---|
| Close a tab with X or a shortcut | Kill its private tmux session and remove the live tab |
| Exit the shell cleanly | Remove the live tab |
| Reload or close the VS Code window | Keep the process and restore the tab |
| Restart the machine | Resume saved Codex and Claude sessions; restore generic tabs as shells |

Explicitly closed tabs stay in **Session History**. Browse the local preview and press `Enter` to restore one tab. Snapshot recovery remains available as an advanced fallback and warns before adding several tabs.

Before moving a workspace to another disk, use **Prepare workspace move...**. The extension saves recovery data, stops managed processes, and provides a matching import action for the new path. See [Troubleshooting](docs/troubleshooting.md#moving-a-workspace-to-another-disk) for the full sequence.

## Config and privacy

The public settings cover close behavior, cold restore, editor or panel placement, drafts, the monitor, notifications, and executable paths. The defaults are meant to work without setup.

There is no telemetry or hosted service. State, drafts, previews, and history stay local. **Rename with AI** runs only when requested and sends at most two recent user messages to the selected Codex, Claude, or VS Code provider. Choose the deterministic `local` provider to avoid model calls.

The extension reads local Codex and Claude metadata to restore sessions and derive status. See [Data and privacy](docs/privacy.md) for the exact data flow and deletion steps.

Before uninstalling, choose **AI Sessions: More Actions...**, then **Stop all managed sessions...**.

## Limits

- macOS only for now.
- One VS Code window controls a workspace at a time.
- One tmux session and one tmux window belong to each tab. A tab may contain several panes.
- tmux owns managed scrollback, so the native VS Code scrollbar does not represent its history.
- Generic processes survive VS Code restarts but not machine restarts or a prepared workspace move. Their panes return as shells and commands are not rerun.
- The floating monitor depends on optional VS Code workbench capabilities and may fall back to a normal editor.
- macOS can attribute access from a long-lived terminal child process to VS Code. If the repeated "access data from other apps" prompt appears, inspect the responsible binary before granting broader permissions. See [Troubleshooting](docs/troubleshooting.md#macos-keeps-asking-to-access-data-from-other-apps).
- The PTY bridge uses the compatible `node-pty` bundled with the tested VS Code build.

See [Architecture](docs/architecture.md) for the internals.

## Development

There are no runtime npm dependencies.

```sh
npm run check
npm run test:coverage
```

The [demo](demo) uses fake transcripts and a fake Codex process. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before sending code or logs.

## License

[MIT](LICENSE). Not affiliated with Microsoft, OpenAI, or Anthropic.
