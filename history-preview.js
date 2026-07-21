'use strict';

const { escapeHtml } = require('./monitor-view');

function historyPreviewHtml(entry, options = {}) {
  const title = escapeHtml(entry && entry.title || 'Session preview');
  const provider = escapeHtml(entry && entry.provider || 'terminal');
  const archivedAt = entry && entry.archivedAt
    ? escapeHtml(new Date(entry.archivedAt).toLocaleString())
    : 'unknown date';
  const loading = Boolean(options.loading);
  const messages = entry && Array.isArray(entry.preview) ? entry.preview : [];
  const body = loading
    ? '<div class="empty">Loading local transcript preview...</div>'
    : messages.length
      ? messages.map((message) => {
        const label = message.role === 'assistant' ? 'Agent'
          : message.role === 'draft' ? 'Recovered draft' : 'You';
        return `<article class="message ${escapeHtml(message.role)}"><div class="role">${label}</div><pre>${escapeHtml(message.text)}</pre></article>`;
      }).join('')
      : '<div class="empty">No message preview is available for this session.</div>';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; padding: 18px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 12px/1.45 var(--vscode-font-family); }
    header { position: sticky; top: 0; z-index: 1; padding: 0 0 12px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
    h1 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
    .meta, .role { color: var(--vscode-descriptionForeground); }
    main { display: grid; gap: 10px; padding-top: 12px; }
    .message { padding: 10px 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-textCodeBlock-background); }
    .message.user { border-left: 2px solid var(--vscode-terminal-ansiCyan); }
    .message.assistant { border-left: 2px solid var(--vscode-terminal-ansiGreen); }
    .message.draft { border-left: 2px solid var(--vscode-terminal-ansiYellow); }
    .role { margin-bottom: 5px; font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: inherit; font: inherit; }
    .empty { padding: 24px 8px; color: var(--vscode-descriptionForeground); text-align: center; }
  </style>
</head>
<body>
  <header><h1>${title}</h1><div class="meta">${provider} · closed ${archivedAt}</div></header>
  <main>${body}</main>
</body>
</html>`;
}

module.exports = { historyPreviewHtml };
