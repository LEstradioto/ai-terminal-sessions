# Contributing

Thanks for helping improve AI Terminal Sessions. The project is intentionally small: plain Node.js, the VS Code API, tmux, and no runtime npm dependencies.

## Local setup

Requirements:

- macOS;
- VS Code 1.127 or newer;
- Node.js 20 or newer;
- tmux 3.4 or newer;
- Codex and Claude Code only if you want to test agent-specific restore and rename.

Clone the repository, then run:

```sh
npm test
npm run test:coverage
```

Press `F5` in VS Code to start an Extension Development Host. The fixture under `demo/fixture` contains synthetic commands for screenshots and manual testing.

## Pull requests

- Keep session lifecycle changes small and observable.
- Add a regression test for close, restore, state, draft, or status changes.
- Do not add telemetry, secrets, real transcripts, usernames, or absolute home paths.
- Preserve the rule that generic commands are never restarted after a cold boot.
- Treat internal VS Code commands as optional capabilities with a supported fallback.

Run `npm run check` before opening a pull request. Explain user-visible behavior and data-handling changes in the PR description.
