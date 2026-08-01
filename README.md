# AI Terminal Sessions

Agent workflows don't need another dashboard. Sometimes all you need is tabs. Trust me.

I keep Codex, Claude Code, servers, and CI jobs open in VS Code and move through them like browser tabs. This extension keeps those tabs alive and tells me which one needs attention.

[![VS Code 1.127+](https://img.shields.io/badge/VS%20Code-1.127%2B-23a8f2)](https://code.visualstudio.com/)
[![macOS preview](https://img.shields.io/badge/platform-macOS-111827)](#limits)
[![MIT](https://img.shields.io/badge/license-MIT-34d399)](LICENSE)

![Persistent agent, server, and CI terminals arranged as ordinary VS Code tabs](media/tabs.png)

## My workflow

- `Hyper+Left/Right` moves through terminal tabs.
- The title marker tells me when an agent needs me.
- `Hyper+Down` pins a server or CI watch in the Session Monitor.
- Reloading VS Code restores the same tabs, in the same order, with the same processes.

![Pinning sessions while continuing to navigate terminal tabs](media/session-monitor.gif)

## Features

| Feature | Behavior |
|---|---|
| Persistent tabs | Each VS Code tab owns a private tmux session with one or more panes |
| Cold restore | Every saved Codex and Claude pane resumes independently; helper panes return as shells without rerunning commands |
| Status | The tab follows the focused pane; the status bar also counts background agents that are working or need attention |
| Session counter | Shows saved, working, and attention counts; warns when visible tabs do not match restore state |
| Session Monitor | Up to four ANSI-colored, auto-scrolling previews in a compact 2x2 window that keeps its bounds across reloads and extension toggles |
| Draft recovery | Saves each pane's visible composer after 1.5 seconds and pastes it back without submitting; `Shift+Enter` and multiline paste still work |
| History | Keeps up to 500 closed tabs, including their pane layout, with one-tab restore and a local message preview |
| Rename with AI | Uses the latest two useful messages to make a lowercase topic such as `video ads` or `auth solving` |
| Tab icons | Automatically distinguishes Codex, Claude Code, Rails servers, and regular shells; manual colored roles remain available |
| Resize | Forwards VS Code dimensions to tmux and preserves the pane layout |
| Scrollback | Keeps 20,000 lines in every new managed terminal |

## Status markers

| Marker | Meaning |
|---|---|
| `○⠋` | Agent working |
| `🟠` | Waiting for permission or a tool |
| `🟢` | New answer ready |
| `🔴` | New interrupted turn; clears after you return to the tab |
| `🟨` | Idle for less than 30 minutes |
| `🟧` | Idle for 30 minutes to 4 hours |
| `🟫` | Idle for more than 4 hours |

Green stays green until you submit the next message or explicitly mark the session as handled. Focusing the tab and editing a draft do not clear it. You can also right-click a managed tab to mark it as handled or flag it for attention. After a session is handled, the idle colors age from yellow to brown based on real agent, command, or terminal activity.

## Install

This is a macOS preview. It needs VS Code 1.127 or newer and tmux 3.4 or newer. Building from source also needs Node.js 20.

This preview is not published to the Visual Studio Marketplace yet. For now, install it from source or a local VSIX. Marketplace publication is planned after the restore and recovery paths have held up through more daily use.

### Tested setup

This started as a fix for my own workflow, and that is still the support boundary for this preview. I use it daily on an Apple Silicon Mac with macOS 26.5.2, VS Code 1.128.1, zsh 5.9, tmux 3.6a, Codex CLI, and Claude Code.

I have not tested Intel Macs, other operating systems, shells, terminal configurations, multiplexers, or agent harnesses. If your setup differs, expect rough edges and include versions plus a redacted log when [opening an issue](https://github.com/LEstradioto/ai-terminal-sessions/issues).

On another Mac, these are the things most likely to differ:

- `$SHELL` selects the login shell used when an agent is restored.
- `tmux`, `codex`, and `claude` are resolved from `PATH`. If a CLI works in Terminal.app but not here, set its absolute path in `aiTerminalSessions.executables`. Homebrew usually installs under `/opt/homebrew` on Apple Silicon and `/usr/local` on Intel.
- The private tmux server ignores `~/.tmux.conf`, so personal tmux bindings should not affect it.
- `defaultLocation` switches managed tabs between the editor and terminal panel.

```sh
brew install tmux
git clone https://github.com/LEstradioto/ai-terminal-sessions.git
cd ai-terminal-sessions
npm test
```

Open the repo in VS Code and press `F5`, or build a VSIX:

```sh
npx @vscode/vsce package
code --install-extension ai-terminal-sessions-0.6.0.vsix
```

Open **AI Sessions: More Actions...** and choose **Use as default terminal profile** only if you want the terminal `+` button to create managed tabs. The extension activates eagerly and restores in the background. VS Code does not expose extension startup priorities, so no manual ordering is required or configurable.

## Commands

The Command Palette stays focused on five entry points:

- **New Persistent Terminal**
- **Session History**
- **Customize Active Tab...** for rename, icon, draft, pin, and remove
- **Show or Hide Session Monitor**
- **More Actions...** for settings, recovery, logs, and maintenance

You can also right-click a managed terminal tab to rename it, change its icon, recover its draft, manage tmux panes, pin it, or control its attention marker. Icons start in **Automatic** mode. Choosing any specific icon locks that tab to the manual choice; choose **Automatic** again to resume detection.

The status bar counter opens a fast session switcher grouped by attention, working, recent, and older sessions. It also compares saved sessions, live connections, and visible managed tabs. After reload, a warning such as `13 tabs / 12 sessions` means restore needs inspection; click it to repair or open the log.

## Shortcuts

| Action | Default | My setup |
|---|---:|---:|
| Pin active tab | `Cmd+Option+Down` | `Hyper+Down` |
| Toggle monitor | `Cmd+Option+Up` | `Hyper+Up` |
| Scroll tmux history | `Shift+Page Up/Down` | Same |
| Move between tabs | Your VS Code binding | `Hyper+Left/Right` |

"Hyper" is my macOS Hyper key mapped to `Cmd+Option`. The extension does not register it.

Use **Show or Hide Session Monitor** or its shortcut to close the monitor. The extension hides and reuses the same auxiliary window, preserving its size and position. The native macOS close button destroys that window, so the next one may open at VS Code's default bounds. VS Code does not expose auxiliary-window bounds to extensions.

Keyboard scrolling enters tmux copy mode. Drag to select text; releasing the mouse copies it to the macOS clipboard and keeps the selection visible. For keyboard selection, press `v`, extend with the arrow keys, then press `y` to copy and return to the live terminal. Press `q` or `Escape` to cancel.
On a MacBook keyboard, `Page Up/Down` is `Fn+Up/Down`, so the full shortcut is `Shift+Fn+Up/Down`.

Tmux owns normal mouse gestures while its mouse mode is active. To make a native VS Code terminal selection instead, enable `terminal.integrated.macOptionClickForcesSelection` and hold `Option` while dragging.

Each tab uses the standard tmux prefix, `Ctrl+B`. Common follow-up keys are `%` to split right, `"` to split down, arrow keys to change pane, `o` for the next pane, `z` to zoom, `x` to close, `[` for scrollback, and `?` for the complete binding list. **Tmux Pane Actions** exposes the same operations through the tab context menu while you learn the keys. Right-click remains owned by VS Code instead of opening a second tmux menu.

## Close and restore

| Action | Default behavior |
|---|---|
| Close a tab with X or a shortcut | Kill its private tmux session and forget the tab |
| Exit the shell cleanly | Forget the tab |
| Reload or close the VS Code window | Keep the process and restore the tab |
| Restart the machine | Resume saved Codex and Claude sessions; restore generic tabs without rerunning commands |

`closeBehavior` can change an explicit close to `forget` or `keep`. Failed tmux termination never drops recovery data. One VS Code window controls a workspace at a time.

Explicitly closed tabs remain in **AI Sessions: Session History**. Move through the list to preview recent messages, then press `Enter` to restore only that tab. Snapshot recovery is still available as an advanced fallback and warns before adding multiple tabs.

### Moving a workspace

Do not move a workspace to another disk while its managed tmux processes are live. A cross-volume move copies and deletes files, so an agent or server may keep writing to the old location while the copy is in progress.

1. Open **AI Sessions: More Actions...** and choose **Prepare workspace move...**.
2. Wait for confirmation, then quit VS Code.
3. Move the folder and open it from the new location.
4. Open **More Actions...** and choose **Import a prepared workspace move...**.

Preparation saves tabs, pane layouts, agent IDs, drafts, history, and archive data in VS Code's local global storage, then stops the managed tmux processes and suspends the old workspace state. Import rewrites working directories under the workspace root, restores the tabs, and deletes the transfer bundle. If any process fails to stop, do not move the files; inspect the extension log first. Paths outside the workspace root are not rewritten.

## Rename, config, and privacy

Rename with AI only runs on command. The default `sameHarness` provider keeps Codex context in Codex and Claude context in Claude. `local` skips model calls; `vscode` uses a model provided by VS Code.

Other settings cover cold restore, editor or panel placement, drafts, monitor always-on-top, ready notifications, close behavior, and executable paths.

There is no telemetry or hosted service. State, drafts, closed-session previews, and history stay local. Automatic polling does not send prompts to a model. The extension is disabled in untrusted and virtual workspaces. See [Data and privacy](docs/privacy.md) for the exact data flow and deletion steps.

Before uninstalling, open **AI Sessions: More Actions...** and choose **Stop all managed sessions...**.

## Limits

- macOS only for now.
- One VS Code window per workspace.
- One tmux session and one tmux window per tab. A tab may contain several panes.
- The normal path is one agent pane plus helper panes. Multiple agent panes are restored independently, but this is newer and less exercised than one agent per tab.
- tmux owns scrollback inside managed tabs. Trackpad and mouse-wheel scrolling work, but the native VS Code terminal scrollbar does not represent tmux history.
- The 20,000-line scrollback limit applies when a tmux pane is created. Existing panes keep the limit they started with.
- Generic processes survive VS Code restarts but not machine restarts or a prepared workspace move. Their panes return as shells and commands are not rerun automatically.
- The floating always-on-top monitor uses optional VS Code workbench capabilities and can fall back to a regular editor.
- The PTY bridge uses the compatible `node-pty` bundled with the tested VS Code build.

See [Architecture](docs/architecture.md) and [Troubleshooting](docs/troubleshooting.md) for the internals and recovery commands.

## Development

There are no runtime npm dependencies.

```sh
npm run check
npm run test:coverage
```

The [demo](demo) uses fake transcripts and a fake Codex process. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before sending code or logs.

## License

[MIT](LICENSE). Not affiliated with Microsoft, OpenAI, or Anthropic.
