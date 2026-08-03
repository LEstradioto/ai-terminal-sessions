'use strict';

const crypto = require('node:crypto');

function monitorHtml(webview, workspaceName) {
  const nonce = randomNonce();
  const workspace = escapeHtml(workspaceName || 'workspace');
  const csp = [
    "default-src 'none'",
    `style-src-elem ${webview.cspSource} 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Session Monitor</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --panel: var(--vscode-sideBar-background, var(--vscode-editor-background));
      --panel-strong: var(--vscode-editorWidget-background, var(--panel));
      --border: color-mix(in srgb, var(--vscode-panel-border, #7a7a7a) 72%, transparent);
      --text: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --hover: var(--vscode-list-hoverBackground);
      --working: var(--vscode-terminal-ansiYellow, #d7ba7d);
      --waiting: var(--vscode-terminal-ansiBrightYellow, #e5c07b);
      --ready: var(--vscode-terminal-ansiGreen, #73c991);
      --error: var(--vscode-terminal-ansiRed, #f14c4c);
      --idle: var(--vscode-descriptionForeground, #8b8b8b);
      --monitor-accent: var(--vscode-terminal-ansiCyan, #4fa8b8);
      --ansi-0: var(--vscode-terminal-ansiBlack, #000000);
      --ansi-1: var(--vscode-terminal-ansiRed, #cd3131);
      --ansi-2: var(--vscode-terminal-ansiGreen, #0dbc79);
      --ansi-3: var(--vscode-terminal-ansiYellow, #e5e510);
      --ansi-4: var(--vscode-terminal-ansiBlue, #2472c8);
      --ansi-5: var(--vscode-terminal-ansiMagenta, #bc3fbc);
      --ansi-6: var(--vscode-terminal-ansiCyan, #11a8cd);
      --ansi-7: var(--vscode-terminal-ansiWhite, #e5e5e5);
      --ansi-8: var(--vscode-terminal-ansiBrightBlack, #666666);
      --ansi-9: var(--vscode-terminal-ansiBrightRed, #f14c4c);
      --ansi-10: var(--vscode-terminal-ansiBrightGreen, #23d18b);
      --ansi-11: var(--vscode-terminal-ansiBrightYellow, #f5f543);
      --ansi-12: var(--vscode-terminal-ansiBrightBlue, #3b8eea);
      --ansi-13: var(--vscode-terminal-ansiBrightMagenta, #d670d6);
      --ansi-14: var(--vscode-terminal-ansiBrightCyan, #29b8db);
      --ansi-15: var(--vscode-terminal-ansiBrightWhite, #e5e5e5);
      --sans: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
      --mono: var(--vscode-editor-font-family, "SFMono-Regular", Consolas, monospace);
    }

    * { box-sizing: border-box; }

    html, body { min-height: 100%; }

    body {
      margin: 0;
      background:
        repeating-linear-gradient(0deg, transparent 0 23px, color-mix(in srgb, var(--border) 12%, transparent) 23px 24px),
        var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 11px;
    }

    .shell {
      min-height: 100vh;
      padding: 7px;
    }

    .masthead {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 22px;
      margin: -7px -7px 6px;
      padding: 0 7px;
      border-bottom: 1px solid color-mix(in srgb, var(--monitor-accent) 34%, var(--border));
      background: color-mix(in srgb, var(--monitor-accent) 11%, var(--panel));
      color: var(--muted);
      font-family: var(--mono);
      font-size: 8.5px;
      letter-spacing: .08em;
      line-height: 1;
      text-transform: uppercase;
      font-variant-numeric: tabular-nums;
    }

    .identity, .counter {
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
    }

    .monitor-mark {
      position: relative;
      flex: 0 0 auto;
      width: 8px;
      height: 8px;
      border: 1px solid var(--monitor-accent);
      border-radius: 2px;
      box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--monitor-accent) 10%, transparent);
    }

    .monitor-mark::after {
      position: absolute;
      inset: 2px;
      border-radius: 1px;
      background: var(--monitor-accent);
      content: "";
    }

    .monitor-label { color: var(--text); font-weight: 700; }
    .counter { color: color-mix(in srgb, var(--monitor-accent) 72%, var(--text)); }

    .workspace {
      overflow: hidden;
      color: var(--text);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 6px;
    }

    .card {
      --tone: var(--idle);
      position: relative;
      min-width: 0;
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 5px;
      background: color-mix(in srgb, var(--panel-strong) 94%, transparent);
      box-shadow: 0 3px 10px color-mix(in srgb, #000 10%, transparent);
      cursor: pointer;
      transition: border-color 120ms ease, transform 120ms ease;
    }

    .card::before {
      position: absolute;
      inset: 0 auto 0 0;
      width: 2px;
      background: var(--tone);
      content: "";
    }

    .card[data-tone="working"] { --tone: var(--working); }
    .card[data-tone="waiting"] { --tone: var(--waiting); }
    .card[data-tone="ready"] { --tone: var(--ready); }
    .card[data-tone="error"] { --tone: var(--error); }

    .card[data-fresh="true"] {
      animation: signal 720ms ease-out;
    }

    .card:focus-within, .card:hover {
      border-color: color-mix(in srgb, var(--tone) 64%, var(--border));
    }

    .card:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -2px;
    }

    .card-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 5px;
      min-height: 34px;
      padding: 5px 5px 4px 8px;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 65%, transparent);
    }

    .title-block { min-width: 0; }

    .title {
      overflow: hidden;
      margin: 0 0 1px;
      font-size: 10.5px;
      font-weight: 650;
      letter-spacing: .01em;
      line-height: 1.15;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .meta {
      display: flex;
      align-items: center;
      gap: 5px;
      overflow: hidden;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 8px;
      letter-spacing: .04em;
      line-height: 1.1;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .state { color: var(--tone); font-weight: 700; }
    .process { overflow: hidden; text-overflow: ellipsis; }

    .actions { display: flex; gap: 2px; }

    button {
      display: grid;
      width: 23px;
      height: 23px;
      padding: 0;
      place-items: center;
      border: 1px solid transparent;
      border-radius: 3px;
      background: transparent;
      color: var(--muted);
      font: 600 10px/1 var(--sans);
      cursor: pointer;
    }

    button:hover { background: var(--hover); color: var(--text); }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

    .screen {
      min-height: 98px;
      max-height: 175px;
      margin: 0;
      overflow: auto;
      padding: 6px 7px 7px 8px;
      color: var(--text);
      font-family: var(--mono);
      font-size: 8.75px;
      font-variant-ligatures: none;
      line-height: 1.28;
      overflow-wrap: anywhere;
      scrollbar-width: thin;
      white-space: pre-wrap;
    }

    .terminal-line { min-height: 1.28em; }
    .ansi-bold { font-weight: 700; }
    .ansi-dim { opacity: .62; }
    .ansi-italic { font-style: italic; }
    .ansi-underline { text-decoration: underline; text-underline-offset: 2px; }
    .ansi-strike { text-decoration: line-through; }
    .ansi-hidden { visibility: hidden; }
    .ansi-inverse { color: var(--bg) !important; background-color: var(--text) !important; }

    .ansi-fg-0 { color: var(--ansi-0); } .ansi-bg-0 { background-color: var(--ansi-0); }
    .ansi-fg-1 { color: var(--ansi-1); } .ansi-bg-1 { background-color: var(--ansi-1); }
    .ansi-fg-2 { color: var(--ansi-2); } .ansi-bg-2 { background-color: var(--ansi-2); }
    .ansi-fg-3 { color: var(--ansi-3); } .ansi-bg-3 { background-color: var(--ansi-3); }
    .ansi-fg-4 { color: var(--ansi-4); } .ansi-bg-4 { background-color: var(--ansi-4); }
    .ansi-fg-5 { color: var(--ansi-5); } .ansi-bg-5 { background-color: var(--ansi-5); }
    .ansi-fg-6 { color: var(--ansi-6); } .ansi-bg-6 { background-color: var(--ansi-6); }
    .ansi-fg-7 { color: var(--ansi-7); } .ansi-bg-7 { background-color: var(--ansi-7); }
    .ansi-fg-8 { color: var(--ansi-8); } .ansi-bg-8 { background-color: var(--ansi-8); }
    .ansi-fg-9 { color: var(--ansi-9); } .ansi-bg-9 { background-color: var(--ansi-9); }
    .ansi-fg-10 { color: var(--ansi-10); } .ansi-bg-10 { background-color: var(--ansi-10); }
    .ansi-fg-11 { color: var(--ansi-11); } .ansi-bg-11 { background-color: var(--ansi-11); }
    .ansi-fg-12 { color: var(--ansi-12); } .ansi-bg-12 { background-color: var(--ansi-12); }
    .ansi-fg-13 { color: var(--ansi-13); } .ansi-bg-13 { background-color: var(--ansi-13); }
    .ansi-fg-14 { color: var(--ansi-14); } .ansi-bg-14 { background-color: var(--ansi-14); }
    .ansi-fg-15 { color: var(--ansi-15); } .ansi-bg-15 { background-color: var(--ansi-15); }

    .empty {
      display: grid;
      min-height: calc(100vh - 30px);
      place-items: center;
      border: 1px dashed var(--border);
      border-radius: 5px;
      color: var(--muted);
      text-align: center;
    }

    .empty strong {
      display: block;
      margin-bottom: 4px;
      color: var(--text);
      font-size: 11px;
      font-weight: 650;
    }

    .key {
      display: inline-block;
      min-width: 18px;
      margin: 0 1px;
      padding: 1px 3px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--panel);
      color: var(--text);
      font: 8px/1.2 var(--mono);
    }

    @keyframes signal {
      0% { box-shadow: 0 0 0 1px var(--tone), 0 0 22px color-mix(in srgb, var(--tone) 30%, transparent); }
      100% { box-shadow: 0 3px 10px color-mix(in srgb, #000 10%, transparent); }
    }

    @media (max-width: 580px) {
      .shell { padding: 6px; }
      .masthead { margin: -6px -6px 6px; padding: 0 6px; }
      .grid { grid-template-columns: 1fr; }
      .screen { min-height: 90px; max-height: 150px; }
      .workspace { display: none; }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: 1ms !important; transition-duration: 1ms !important; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="masthead">
      <div class="identity"><span class="monitor-mark" aria-hidden="true"></span><span class="monitor-label">Session Monitor</span><span class="workspace">· ${workspace}</span></div>
      <div class="counter"><span id="updated">LIVE</span><span id="count">0/4</span></div>
    </header>
    <main id="grid" class="grid" aria-live="polite"></main>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const grid = document.getElementById('grid');
    const count = document.getElementById('count');
    const updated = document.getElementById('updated');
    let activeCardId;
    let focusRequested = false;
    vscode.setState({ open: true });

    function emptyState() {
      const wrapper = document.createElement('section');
      wrapper.className = 'empty';
      const content = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = 'No monitored sessions';
      const hint = document.createElement('span');
      hint.append('Use ');
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = 'Hyper ↓';
      hint.append(key, ' inside a managed terminal.');
      content.append(title, hint);
      wrapper.append(content);
      return wrapper;
    }

    function actionButton(label, glyph, action, id) {
      const button = document.createElement('button');
      button.type = 'button';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.textContent = glyph;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        vscode.postMessage({ type: action, id });
      });
      return button;
    }

    function xtermColor(value) {
      if (Array.isArray(value) && value.length === 3) {
        const rgb = value.map((part) => Math.max(0, Math.min(255, Number(part) || 0)));
        return 'rgb(' + rgb.join(', ') + ')';
      }
      const index = Math.max(0, Math.min(255, Number(value) || 0));
      if (index < 16) return undefined;
      if (index >= 232) {
        const gray = 8 + (index - 232) * 10;
        return 'rgb(' + gray + ', ' + gray + ', ' + gray + ')';
      }
      const offset = index - 16;
      const levels = [0, 95, 135, 175, 215, 255];
      const red = levels[Math.floor(offset / 36) % 6];
      const green = levels[Math.floor(offset / 6) % 6];
      const blue = levels[offset % 6];
      return 'rgb(' + red + ', ' + green + ', ' + blue + ')';
    }

    function applyAnsiColor(span, property, prefix, value) {
      if (value === undefined || value === null) return;
      if (Number.isInteger(value) && value >= 0 && value < 16) {
        span.classList.add(prefix + value);
        return;
      }
      const color = xtermColor(value);
      if (color) span.style[property] = color;
    }

    function terminalScreen(session) {
      const screen = document.createElement('div');
      screen.className = 'screen';
      screen.setAttribute('role', 'log');
      screen.setAttribute('aria-label', 'Terminal output for ' + session.title);
      const lines = Array.isArray(session.lines) ? session.lines : [];
      if (!lines.length) {
        screen.textContent = session.preview || 'Waiting for terminal output…';
        return screen;
      }

      for (const segments of lines) {
        const line = document.createElement('div');
        line.className = 'terminal-line';
        for (const segment of Array.isArray(segments) ? segments : []) {
          const span = document.createElement('span');
          span.textContent = String(segment.text || '');
          if (segment.bold) span.classList.add('ansi-bold');
          if (segment.dim) span.classList.add('ansi-dim');
          if (segment.italic) span.classList.add('ansi-italic');
          if (segment.underline) span.classList.add('ansi-underline');
          if (segment.strike) span.classList.add('ansi-strike');
          if (segment.hidden) span.classList.add('ansi-hidden');
          if (segment.inverse) span.classList.add('ansi-inverse');
          const foreground = segment.bold && Number.isInteger(segment.fg) && segment.fg < 8
            ? segment.fg + 8
            : segment.fg;
          applyAnsiColor(span, 'color', 'ansi-fg-', foreground);
          applyAnsiColor(span, 'backgroundColor', 'ansi-bg-', segment.bg);
          line.append(span);
        }
        screen.append(line);
      }
      return screen;
    }

    function sessionCard(session) {
      const article = document.createElement('article');
      article.className = 'card';
      article.tabIndex = 0;
      article.dataset.id = session.id;
      article.setAttribute('aria-label', 'Open terminal ' + session.title);
      article.dataset.tone = session.tone;
      article.dataset.fresh = String(Boolean(session.fresh));

      const header = document.createElement('header');
      header.className = 'card-header';
      const titleBlock = document.createElement('div');
      titleBlock.className = 'title-block';
      const title = document.createElement('h2');
      title.className = 'title';
      title.textContent = session.title;
      const meta = document.createElement('div');
      meta.className = 'meta';
      const state = document.createElement('span');
      state.className = 'state';
      state.textContent = session.status;
      const process = document.createElement('span');
      process.className = 'process';
      process.textContent = session.process;
      const turn = document.createElement('span');
      turn.className = 'turn';
      turn.textContent = session.turn || '';
      const age = document.createElement('span');
      age.textContent = session.age;
      meta.append(state, process);
      if (session.turn) meta.append(turn);
      if (session.age) meta.append(age);
      titleBlock.append(title, meta);

      const actions = document.createElement('div');
      actions.className = 'actions';
      actions.append(
        actionButton('Open terminal', '↗', 'focus', session.id),
        actionButton('Remove from monitor', '×', 'unpin', session.id),
      );
      header.append(titleBlock, actions);

      const screen = terminalScreen(session);
      article.append(header, screen);
      article.addEventListener('focus', () => { activeCardId = session.id; });
      article.addEventListener('click', () => vscode.postMessage({ type: 'focus', id: session.id }));
      article.addEventListener('keydown', (event) => {
        if (event.target !== article) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        vscode.postMessage({ type: 'focus', id: session.id });
      });
      return article;
    }

    function cards() {
      return Array.from(grid.querySelectorAll('.card'));
    }

    function focusCard(id, fallbackIndex = 0) {
      const items = cards();
      if (!items.length) return false;
      const matching = items.find((card) => card.dataset.id === id);
      const card = matching || items[Math.max(0, Math.min(items.length - 1, fallbackIndex))];
      activeCardId = card.dataset.id;
      card.focus({ preventScroll: true });
      card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      vscode.postMessage({ type: 'focus-state', focused: true });
      return true;
    }

    function moveCard(direction) {
      const items = cards();
      if (!items.length) return;
      const focused = document.activeElement && document.activeElement.closest('.card');
      const current = Math.max(0, items.indexOf(focused));
      const next = (current + direction + items.length) % items.length;
      focusCard(items[next].dataset.id, next);
    }

    function render(payload) {
      const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
      grid.replaceChildren(...(sessions.length ? sessions.map(sessionCard) : [emptyState()]));
      grid.classList.toggle('grid', sessions.length > 0);
      count.textContent = sessions.length + '/4';
      updated.textContent = payload.updated || 'LIVE';
      requestAnimationFrame(() => {
        document.querySelectorAll('.screen').forEach((screen) => {
          screen.scrollTop = screen.scrollHeight;
        });
        if (focusRequested || document.hasFocus()) {
          focusRequested = false;
          focusCard(activeCardId);
        }
      });
    }

    window.addEventListener('message', (event) => {
      if (!event.data) return;
      if (event.data.type === 'snapshot') render(event.data);
      if (event.data.type === 'focus-monitor') {
        focusRequested = true;
        requestAnimationFrame(() => {
          if (focusCard(activeCardId)) focusRequested = false;
        });
      }
    });
    window.addEventListener('focus', () => vscode.postMessage({ type: 'focus-state', focused: true }));
    window.addEventListener('blur', () => vscode.postMessage({ type: 'focus-state', focused: false }));
    document.addEventListener('keydown', (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        vscode.postMessage({ type: 'return' });
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveCard(-1);
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        moveCard(1);
      }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function randomNonce() {
  return crypto.randomBytes(24).toString('base64url');
}

module.exports = { escapeHtml, monitorHtml };
