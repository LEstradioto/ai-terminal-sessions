'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const {
  configuredExecutable,
  execFileInputText,
  execFileText,
  existingDirectory,
  messageOf,
  redactDiagnostic,
  resolveExecutable,
  shellQuote,
} = require('./runtime');
const {
  normalizePaneRole,
  normalizeRestorePolicy,
  sessionPanes,
} = require('./session-presentation');

const DEFAULT_TMUX_HISTORY_LIMIT = 20000;
const DEFAULT_TMUX_SERVER = 'ai-terminal-sessions';
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

class TmuxRuntime {
  constructor(options) {
    this.options = options;
    this.output = options.output;
    this.extensionPath = options.extensionPath;
    this.workspaceHash = options.workspaceHash;
    this.ensurePromises = new Map();
  }

  config() {
    return this.options.config();
  }

  defaultCwd() {
    return this.options.defaultCwd();
  }

  codexPath() {
    return this.options.codexPath();
  }

  claudePath() {
    return this.options.claudePath();
  }

  schedulePersist() {
    this.options.onRestored();
  }

  tmuxPath() {
    return configuredExecutable(this.config(), 'tmux');
  }

  tmuxServerName() {
    const legacy = this.config().get('tmuxServerName');
    return String(process.env.AI_TERMINAL_SESSIONS_TMUX_SERVER || legacy || DEFAULT_TMUX_SERVER)
      .replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64) || DEFAULT_TMUX_SERVER;
  }

  tmuxArguments(args) {
    return ['-L', this.tmuxServerName(), '-f', '/dev/null', ...args];
  }

  async ensureSession(record, dimensions) {
    const current = this.ensurePromises.get(record.id);
    if (current) return current;
    const promise = this.ensureSessionImpl(record, dimensions).finally(() => {
      this.ensurePromises.delete(record.id);
    });
    this.ensurePromises.set(record.id, promise);
    return promise;
  }

  async ensureSessionImpl(record, dimensions) {
    const alive = await this.tmuxHasSession(record.tmuxSession);
    if (!alive) {
      this.output.appendLine(`[restore] rebuilding ${record.tmuxSession}`);
      await this.restoreTmuxSession(record, dimensions);
      record.lastRestoredAt = Date.now();
      this.schedulePersist();
    }
    await this.configureTmuxSession(record);
    // A live tmux session can predate newly introduced pane options. Reapply
    // the saved presentation on every attach so restored panes receive those
    // options even when their persisted agent fingerprint did not change.
    if (alive) await this.configurePanePresentation(record);
    if (dimensions) await this.resizeSession(record, dimensions);
  }

  async tmuxHasSession(name) {
    try {
      await this.runTmux(['has-session', '-t', name]);
      return true;
    } catch (error) {
      if (isMissingTmuxSessionError(error)) return false;
      throw error;
    }
  }

  async killTmuxSession(name) {
    try {
      await this.runTmux(['kill-session', '-t', name]);
      return 'killed';
    } catch (error) {
      if (isMissingTmuxSessionError(error)) return 'missing';
      throw error;
    }
  }

  async restoreTmuxSession(record, dimensions) {
    const savedWindows = Array.isArray(record.windows)
      ? record.windows.filter((window) => Array.isArray(window.panes) && window.panes.length)
      : [];
    const fallbackWindow = {
      name: 'shell', active: true, panes: [{ cwd: record.cwd, active: true }],
    };
    const savedWindow = savedWindows.find((window) => window.active) || savedWindows[0] || fallbackWindow;
    const savedPanes = [...savedWindow.panes].sort((left, right) => left.index - right.index);
    const savedPane = savedPanes[0];
    // history-limit is captured when tmux creates a window. Set the global
    // default in the same command queue before new-session so the first pane
    // also receives the larger scrollback buffer on a fresh private server.
    const args = [
      'set-option', '-g', 'history-limit', String(DEFAULT_TMUX_HISTORY_LIMIT), ';',
      'new-session', '-d', '-s', record.tmuxSession,
      '-n', safeTmuxName(savedWindow.name || 'shell'),
      '-c', existingDirectory(savedPane.cwd || record.cwd, this.defaultCwd()),
    ];
    if (dimensions) args.push('-x', String(dimensions.columns), '-y', String(dimensions.rows));
    const command = this.restoreCommand(savedPane.agent);
    if (command) args.push(command);
    await this.runTmux(args);

    const restoredPanes = [];
    const firstPaneId = (await this.runTmux([
      'display-message', '-p', '-t', `${record.tmuxSession}:.0`, '#{pane_id}',
    ])).trim();
    restoredPanes.push(this.restoredPaneRuntime(savedPane, firstPaneId));

    for (const pane of savedPanes.slice(1)) {
      const split = [
        'split-window', '-d', '-P', '-F', '#{pane_id}',
        '-t', `${record.tmuxSession}:`,
        '-c', existingDirectory(pane.cwd || record.cwd, this.defaultCwd()),
      ];
      const paneCommand = this.restoreCommand(pane.agent);
      if (paneCommand) split.push(paneCommand);
      const paneId = (await this.runTmux(split)).trim().split('\n').filter(Boolean).pop();
      restoredPanes.push(this.restoredPaneRuntime(pane, paneId));
    }

    const runtimeWindow = { ...savedWindow, panes: restoredPanes };
    await this.configurePanePresentation({ ...record, windows: [runtimeWindow] });
    if (savedWindow.layout && restoredPanes.length > 1) {
      await this.runTmux([
        'select-layout', '-t', `${record.tmuxSession}:`, savedWindow.layout,
      ], true);
    }
    const activeIndex = Math.max(0, savedPanes.findIndex((pane) => pane.active));
    const activePane = restoredPanes[activeIndex] || restoredPanes[0];
    if (activePane && activePane.id) {
      await this.runTmux(['select-pane', '-t', activePane.id], true);
      record.activePaneId = activePane.logicalId;
    }
  }

  restoredPaneRuntime(savedPane, paneId) {
    const logicalId = savedPane.logicalId || crypto.randomUUID();
    savedPane.logicalId = logicalId;
    return {
      ...savedPane,
      id: paneId,
      logicalId,
      role: normalizePaneRole(savedPane.role, Boolean(savedPane.agent)),
      restorePolicy: normalizeRestorePolicy(savedPane.restorePolicy, Boolean(savedPane.agent)),
    };
  }

  restoreCommand(agent) {
    if (!this.config().get('restoreAgents', true) || !agent || !agent.active || !UUID_RE.test(agent.sessionId || '')) {
      return undefined;
    }
    const shell = resolveExecutable(process.env.SHELL || 'zsh', 'zsh');
    let executable;
    let args;
    if (agent.type === 'claude') {
      executable = this.claudePath();
      args = ['--resume', agent.sessionId];
    } else if (agent.type === 'codex') {
      executable = this.codexPath();
      args = ['resume', agent.sessionId];
    } else {
      return undefined;
    }
    const resume = [shellQuote(executable), ...args.map(shellQuote)].join(' ');
    const command = `${resume}; exec ${shellQuote(shell)} -l`;
    return `${shellQuote(shell)} -lic ${shellQuote(command)}`;
  }

  async configureTmuxSession(record) {
    const copyCommand = `/bin/sh ${shellQuote(path.join(
      this.extensionPath,
      'copy-nonempty.sh',
    ))}`;
    // VS Code sends modified Enter as CSI-u. The private tmux server starts
    // without a tmux.conf, so explicitly preserve extended keys for TUIs.
    await this.runTmux([
      'set-option', '-s', 'terminal-features[100]', 'xterm*:extkeys', ';',
      'set-option', '-s', 'extended-keys-format', 'csi-u', ';',
      'set-option', '-t', record.tmuxSession, 'extended-keys', 'always', ';',
      'set-option', '-t', record.tmuxSession, '@ai-terminal-id', record.id, ';',
      'set-option', '-t', record.tmuxSession, '@ai-terminal-workspace', this.workspaceHash, ';',
      'set-option', '-t', record.tmuxSession, 'destroy-unattached', 'off', ';',
      'set-option', '-t', record.tmuxSession, 'status', 'off', ';',
      'set-option', '-t', record.tmuxSession, 'set-titles', 'off', ';',
      'set-option', '-t', record.tmuxSession, 'prefix', 'C-b', ';',
      'set-option', '-t', record.tmuxSession, 'prefix2', 'None', ';',
      'set-option', '-t', record.tmuxSession, 'mouse', 'on', ';',
      'set-option', '-s', 'copy-command', copyCommand, ';',
      // Codex and shells use tmux scrollback. Claude owns its alternate-screen
      // scroll UI, so panes marked "application" receive the mouse event.
      'bind-key', '-T', 'root', 'WheelUpPane',
      'if-shell', '-F', '#{==:#{@ai-pane-wheel-mode},application}',
      'send-keys -M', 'copy-mode -e -t =', ';',
      'bind-key', '-T', 'root', 'MouseDrag1Pane', 'copy-mode', '-M', '-t', '=', ';',
      'bind-key', '-T', 'root', 'DoubleClick1Pane',
      'select-pane', '-t', '=', '\\;',
      'copy-mode', '-H', '-t', '=', '\\;',
      'send-keys', '-X', '-t', '=', 'select-word', '\\;',
      'send-keys', '-X', '-t', '=', 'copy-pipe-and-cancel', ';',
      'bind-key', '-T', 'copy-mode', 'MouseDragEnd1Pane',
      'send-keys', '-X', 'copy-pipe-and-cancel', ';',
      'bind-key', '-T', 'copy-mode-vi', 'MouseDragEnd1Pane',
      'send-keys', '-X', 'copy-pipe-and-cancel', ';',
      'bind-key', '-T', 'copy-mode', 'v', 'send-keys', '-X', 'begin-selection', ';',
      'bind-key', '-T', 'copy-mode', 'y', 'send-keys', '-X', 'copy-pipe-and-cancel', ';',
      'bind-key', '-T', 'copy-mode-vi', 'v', 'send-keys', '-X', 'begin-selection', ';',
      'bind-key', '-T', 'copy-mode-vi', 'y', 'send-keys', '-X', 'copy-pipe-and-cancel', ';',
      'unbind-key', '-q', '-T', 'root', 'MouseDown3Pane', ';',
      'unbind-key', '-q', '-T', 'root', 'M-MouseDown3Pane', ';',
      'set-window-option', '-t', `${record.tmuxSession}:`, 'window-size', 'latest', ';',
      'set-window-option', '-t', `${record.tmuxSession}:`, 'automatic-rename', 'off', ';',
      'set-window-option', '-t', `${record.tmuxSession}:`, 'pane-border-status',
      sessionPanes(record).length > 1 ? 'top' : 'off', ';',
      'set-window-option', '-t', `${record.tmuxSession}:`, 'pane-border-format',
      ' #{?pane_active,#[bold],}#{pane_index} #{@ai-pane-role} ',
    ]);
  }

  async configurePanePresentation(record) {
    const panes = sessionPanes(record);
    const args = [];
    for (const pane of panes) {
      if (!pane.id) continue;
      if (args.length) args.push(';');
      args.push(
        'set-option', '-p', '-t', pane.id, '@ai-pane-id', pane.logicalId || crypto.randomUUID(), ';',
        'set-option', '-p', '-t', pane.id, '@ai-pane-role', pane.role || 'shell', ';',
        'set-option', '-p', '-t', pane.id, '@ai-pane-agent', pane.agent && pane.agent.type || 'shell', ';',
        'set-option', '-p', '-t', pane.id, '@ai-pane-wheel-mode',
        pane.agent && pane.agent.active !== false && pane.agent.type === 'claude'
          ? 'application'
          : 'history',
      );
    }
    if (args.length) args.push(';');
    args.push(
      'set-window-option', '-t', `${record.tmuxSession}:`, 'pane-border-status',
      panes.length > 1 ? 'top' : 'off', ';',
      'set-window-option', '-t', `${record.tmuxSession}:`, 'pane-border-format',
      ' #{?pane_active,#[bold],}#{pane_index} #{@ai-pane-role} ',
    );
    await this.runTmux(args, true);
  }

  async resizeSession(record, dimensions) {
    if (!dimensions || dimensions.columns < 2 || dimensions.rows < 2) return;
    await this.runTmux([
      'resize-window', '-t', `${record.tmuxSession}:`,
      '-x', String(dimensions.columns), '-y', String(dimensions.rows),
    ], true);
  }

  async redrawSession(sessionName) {
    const raw = await this.runTmux([
      'list-clients', '-t', sessionName, '-F', '#{client_name}',
    ], true);
    const clients = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!clients.length) return 0;
    const args = clients.flatMap((client, index) => [
      ...(index ? [';'] : []), 'refresh-client', '-t', client,
    ]);
    await this.runTmux(args, true);
    return clients.length;
  }

  async runTmux(args, allowFailure = false) {
    try {
      return await execFileText(this.tmuxPath(), this.tmuxArguments(args), { timeout: 6000 });
    } catch (error) {
      if (allowFailure) {
        if (!isMissingTmuxSessionError(error)) {
          this.output.appendLine(`[tmux-best-effort] ${redactDiagnostic(messageOf(error))}`);
        }
        return '';
      }
      throw error;
    }
  }

  async runTmuxInput(args, input) {
    return execFileInputText(
      this.tmuxPath(),
      this.tmuxArguments(args),
      input,
      { timeout: 6000 },
    );
  }
}

function parseTmuxPanes(raw) {
  return raw.split('\n').filter(Boolean).map((line) => {
    const parts = line.split('\t');
    return {
      session: parts[0],
      windowId: parts[1],
      windowIndex: Number(parts[2]),
      windowName: parts[3],
      windowActive: parts[4] === '1',
      layout: parts[5],
      id: parts[6],
      logicalId: parts[7],
      paneIndex: Number(parts[8]),
      pid: Number(parts[9]),
      cwd: parts[10],
      command: parts[11],
      active: parts[12] === '1',
      title: parts[13],
      inMode: parts[14] === '1',
      mode: parts[15],
      scrollPosition: Math.max(0, Number(parts[16]) || 0),
      startCommand: parts.slice(17).join('\t'),
    };
  }).filter((pane) => pane.session && pane.id);
}

function panePresentationFingerprint(record) {
  return sessionPanes(record).map((pane) => [
    pane.logicalId || pane.id,
    pane.role || 'shell',
    pane.agent && pane.agent.active !== false ? pane.agent.type : 'shell',
  ].join(':')).join('|');
}

function paneInCopyMode(pane) {
  if (!pane || !pane.inMode) return false;
  return !pane.mode || /^(?:copy|view)-mode/.test(pane.mode);
}

function groupPanesBySession(panes) {
  const result = new Map();
  for (const pane of panes) {
    if (!result.has(pane.session)) result.set(pane.session, []);
    result.get(pane.session).push(pane);
  }
  return result;
}

function safeTmuxName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ')
    .replace(/[:.]/g, '-').slice(0, 50) || 'shell';
}

function tmuxErrorMessage(error) {
  if (!error) return 'unknown error';
  return error.stderr || error.message || String(error);
}

function isMissingTmuxSessionError(error) {
  const message = tmuxErrorMessage(error).toLocaleLowerCase();
  return Number(error && error.code) === 1 && (
    message.includes("can't find session")
    || message.includes('no server running')
    || message.includes('failed to connect to server')
    || (message.includes('error connecting to') && message.includes('no such file or directory'))
  );
}

module.exports = {
  DEFAULT_TMUX_HISTORY_LIMIT,
  TmuxRuntime,
  groupPanesBySession,
  isMissingTmuxSessionError,
  paneInCopyMode,
  panePresentationFingerprint,
  parseTmuxPanes,
  tmuxErrorMessage,
};
