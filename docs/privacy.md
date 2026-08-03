# Data and privacy

AI Terminal Sessions has no telemetry and no remote service of its own.

## Data read locally

To detect and restore sessions, the extension may read:

- the process table for descendants of its tmux panes;
- the presence of `config/application.rb` in a pane working directory for Rails server icon detection;
- the visible tail of managed tmux panes;
- Codex and Claude Code session metadata and transcripts under their standard home directories;
- Codex's local log index, when available;
- local open-file paths for a Codex process when its rotated log index no longer contains the session mapping;
- the current visible agent composer when draft recovery is enabled.

Transcript content is used locally for status detection and for the explicit **Rename with AI** command. Automatic polling does not send prompts to an AI model.

## Data stored locally

VS Code workspace/global storage contains an allowlisted session record: tmux name, working directory, titles, icon preset, tab order, activity and turn timing, agent type/session ID, and compact restore metadata. PIDs, transcript paths, raw commands, and pane start commands are not persisted.

Composer recovery stores one non-empty draft per managed pane, up to 50,000 characters. Session History keeps up to 500 closed-session entries per workspace. Each entry may contain up to six recent user or assistant messages and one recovered draft, limited to 1,600 characters each. These previews are read from local Codex or Claude transcripts and stored locally so browsing history does not repeatedly scan large files or call a model.

Bulk recovery keeps at most 20 snapshots for seven days. Draft, closed-session, and snapshot files are written with user-only permissions where the platform supports them.

Preparing a workspace move creates a temporary bundle in VS Code global storage. It contains the current session records, pane layout, drafts, snapshots, and closed-session archive. The file uses user-only permissions and is deleted after a successful import. Paths outside the workspace root remain unchanged.

## AI rename

Rename is opt-in per invocation. By default, Codex context goes only to the installed Codex CLI and Claude context goes only to the installed Claude CLI. The extension sends at most the two latest relevant user messages. You can choose the deterministic `local` provider to avoid any model call.

## Deleting data

Open **AI Sessions: More Actions...** and choose **Clear recovery data...** to delete drafts, closed-session previews, snapshots, and any prepared move created by the current workspace.

Open **AI Sessions: More Actions...** and choose **Stop all managed sessions...** before uninstalling to terminate the private tmux sessions and remove their local recovery data. This command does not touch your normal tmux server.

Diagnostics redact the home directory, email-shaped values, and UUID account identifiers. Review logs before sharing them because project names and tmux tab titles may still be meaningful to you.
