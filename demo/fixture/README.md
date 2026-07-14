# AI Terminal Sessions demo

This workspace contains synthetic agent and CI output for screenshots and release demos. It has no remote, credentials, real transcripts, or production code.

The four demo tabs are:

- **Video Ads:** a working Codex session;
- **Favicon Gen:** a completed response needing attention;
- **Auth Solving:** a permission prompt;
- **CI Watch:** continuous ANSI build output.

From the repository root, run `./demo/scripts/launch.sh`. The launcher isolates VS Code user data, installed extensions, Codex data, and the tmux server. It uses in-memory VS Code secret storage and the current macOS home directory to avoid creating or unlocking a throwaway keychain.

Run `./demo/scripts/cleanup.sh` when finished. Before publishing captured media, run `./demo/scripts/privacy-check.sh <image-or-video> [...]`.
