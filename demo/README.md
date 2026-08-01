# Demo and capture

The demo uses fake Codex transcripts, a fake agent process, and a private tmux server. It never opens a real project or account.

## Open a clean fixture

Close any existing AI Terminal Sessions demo window, then run:

```sh
./demo/scripts/launch.sh
```

Each launch resets only `demo/.work`, rebuilds the synthetic fixture, and opens a separate VS Code instance. Your normal settings, extensions, terminals, Codex data, and tmux server are not used.

Wait for four tabs and the Session Monitor to appear. The expected tabs are `video ads`, `favicon gen`, `auth solving`, and `ci watch`.

## Record the README demo

Use a short silent loop. The product is easier to understand by watching it than by hearing it explained.

Suggested 20 second take:

1. Start on the four colored terminal tabs.
2. Move through two tabs to show working, ready, and permission states.
3. Press `Cmd+Option+Up` to hide and show the Session Monitor.
4. Run **Developer: Reload Window** from the Command Palette.
5. End when the same tabs and monitor return.

On macOS, press `Cmd+Shift+5`, choose **Record Selected Portion**, and frame only the demo VS Code window. Record at a consistent window size, ideally 1600 by 900 or larger. Keep notifications and unrelated windows off screen.

Save the original recording outside `media/`. Keep it as a source master until the final crop and timing are approved.

## Check the capture

The privacy check samples every second of a video and runs OCR on the frames:

```sh
./demo/scripts/privacy-check.sh /path/to/capture.mov
```

Stop the isolated tmux server when finished:

```sh
./demo/scripts/cleanup.sh
```
