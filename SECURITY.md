# Security policy

## Supported versions

Security fixes are provided for the latest preview release.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose local prompts, execute an unintended command, or terminate another user's process. Use GitHub's private vulnerability reporting for this repository instead.

Include the VS Code version, macOS version, tmux version, reproduction steps, and whether the workspace was local or remote. Synthetic logs are preferred. Remove home paths, session IDs, email addresses, and transcript contents before attaching diagnostics.

## Security model

The extension launches local executables, attaches to a private tmux server, and reads local Codex/Claude metadata to restore sessions and derive status. It does not include telemetry and does not operate in untrusted or virtual workspaces. See [Data and privacy](docs/privacy.md) for the exact data flow and deletion commands.
