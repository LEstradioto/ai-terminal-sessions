'use strict';

const { monitorHtml } = require('./monitor-view');
const { activityReference, hasAgentContext } = require('./session-presentation');

const MONITOR_CONTAINER_COMMAND = 'workbench.view.extension.aiTerminalSessionsPanel';
const MONITOR_LINES = 12;
const MONITOR_REFRESH_MS = 1000;
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const SGR_RE = /\x1b\[([0-9;:]*)m/g;
const DIVIDER_RUN_RE = /([─━═\-=])\1{15,}/gu;

function ansiTerminalPreview(rawText, maxLines = 12) {
  const limit = Math.max(1, Math.min(40, Number(maxLines) || 12));
  const lines = [[]];
  let state = defaultAnsiState();
  let cursor = 0;
  const source = String(rawText || '').replace(/\r/g, '');
  SGR_RE.lastIndex = 0;

  for (let match = SGR_RE.exec(source); match; match = SGR_RE.exec(source)) {
    appendAnsiText(lines, source.slice(cursor, match.index), state);
    state = applySgr(state, match[1]);
    cursor = match.index + match[0].length;
  }
  appendAnsiText(lines, source.slice(cursor), state);

  const normalized = lines.map((segments) => trimAnsiLine(segments));
  while (normalized.length && !lineText(normalized[normalized.length - 1])) normalized.pop();
  const selected = normalized.slice(-limit).map((segments) => truncateAnsiLine(segments, 500));
  return {
    text: selected.map(lineText).join('\n').trimEnd(),
    lines: selected,
  };
}

function appendAnsiText(lines, rawText, state) {
  const text = String(rawText || '').replace(ANSI_RE, '');
  const parts = text.split('\n');
  for (let index = 0; index < parts.length; index += 1) {
    if (index > 0) lines.push([]);
    const value = parts[index].replace(
      DIVIDER_RUN_RE,
      (match) => `${match.slice(0, 12)}…`,
    );
    if (!value) continue;
    const line = lines[lines.length - 1];
    const style = compactAnsiState(state);
    const previous = line[line.length - 1];
    if (previous && sameAnsiStyle(previous, style)) previous.text += value;
    else line.push({ text: value, ...style });
  }
}

function defaultAnsiState() {
  return {
    fg: undefined,
    bg: undefined,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
    hidden: false,
    strike: false,
  };
}

function compactAnsiState(state) {
  const style = {};
  for (const key of ['fg', 'bg', 'bold', 'dim', 'italic', 'underline', 'inverse', 'hidden', 'strike']) {
    if (state[key] !== undefined && state[key] !== false) style[key] = state[key];
  }
  return style;
}

function applySgr(current, rawParameters) {
  let state = { ...current };
  const parameters = rawParameters === ''
    ? [0]
    : rawParameters.replace(/::/g, ':').split(/[;:]/).filter(Boolean).map(Number);

  for (let index = 0; index < parameters.length; index += 1) {
    const code = Number.isFinite(parameters[index]) ? parameters[index] : 0;
    if (code === 0) state = defaultAnsiState();
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 7) state.inverse = true;
    else if (code === 8) state.hidden = true;
    else if (code === 9) state.strike = true;
    else if (code === 22) { state.bold = false; state.dim = false; }
    else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 27) state.inverse = false;
    else if (code === 28) state.hidden = false;
    else if (code === 29) state.strike = false;
    else if (code >= 30 && code <= 37) state.fg = code - 30;
    else if (code >= 90 && code <= 97) state.fg = code - 90 + 8;
    else if (code === 39) state.fg = undefined;
    else if (code >= 40 && code <= 47) state.bg = code - 40;
    else if (code >= 100 && code <= 107) state.bg = code - 100 + 8;
    else if (code === 49) state.bg = undefined;
    else if ((code === 38 || code === 48) && parameters[index + 1] === 5) {
      const color = clampColorIndex(parameters[index + 2]);
      if (code === 38) state.fg = color;
      else state.bg = color;
      index += 2;
    } else if ((code === 38 || code === 48) && parameters[index + 1] === 2) {
      const color = [
        clampByte(parameters[index + 2]),
        clampByte(parameters[index + 3]),
        clampByte(parameters[index + 4]),
      ];
      if (code === 38) state.fg = color;
      else state.bg = color;
      index += 4;
    }
  }
  return state;
}

function trimAnsiLine(segments) {
  const result = segments.map((segment) => ({ ...segment }));
  while (result.length) {
    const last = result[result.length - 1];
    last.text = last.text.replace(/\s+$/u, '');
    if (last.text) break;
    result.pop();
  }
  return result;
}

function truncateAnsiLine(segments, maxCharacters) {
  const result = [];
  let remaining = maxCharacters;
  for (const segment of segments) {
    if (remaining <= 0) break;
    const characters = Array.from(segment.text);
    const text = characters.slice(0, remaining).join('');
    if (text) result.push({ ...segment, text });
    remaining -= characters.length;
  }
  return result;
}

function lineText(segments) {
  return segments.map((segment) => segment.text).join('');
}

function sameAnsiStyle(segment, style) {
  const keys = ['fg', 'bg', 'bold', 'dim', 'italic', 'underline', 'inverse', 'hidden', 'strike'];
  return keys.every((key) => JSON.stringify(segment[key]) === JSON.stringify(style[key]));
}

function clampColorIndex(value) {
  return Math.max(0, Math.min(255, Number(value) || 0));
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Number(value) || 0));
}

function activityLabel(activityAt, now = Date.now()) {
  const timestamp = Number(activityAt) || 0;
  if (!timestamp) return '-';
  const ageMs = Math.max(0, Number(now) - timestamp);
  if (ageMs < 15 * 1000) return 'NOW';
  if (ageMs < 60 * 1000) return `${Math.floor(ageMs / 1000)}S`;
  if (ageMs < 60 * 60 * 1000) return `${Math.floor(ageMs / 60000)}M`;
  if (ageMs < 24 * 60 * 60 * 1000) return `${Math.floor(ageMs / 3600000)}H`;
  return `${Math.floor(ageMs / 86400000)}D`;
}

function turnDurationLabel(record, now = Date.now()) {
  const duration = turnElapsedMs(record, now);
  if (duration === undefined) return '';
  if (duration < 1000) return 'TURN <1S';
  const totalSeconds = Math.floor(duration / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `TURN ${hours}H ${String(minutes).padStart(2, '0')}M`;
  if (minutes) return `TURN ${minutes}M ${String(seconds).padStart(2, '0')}S`;
  return `TURN ${seconds}S`;
}

function turnElapsedMs(record, now = Date.now()) {
  const startedAt = positiveNumber(record && record.turnStartedAt);
  const completedAt = positiveNumber(record && record.turnCompletedAt);
  const storedDuration = positiveNumber(record && record.turnDurationMs);
  if (completedAt) {
    if (storedDuration) return storedDuration;
    if (startedAt && completedAt >= startedAt) return completedAt - startedAt;
    return undefined;
  }
  if (startedAt && (record.status === 'running' || record.status === 'waiting')) {
    return Math.max(0, Number(now) - startedAt);
  }
  return storedDuration || undefined;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function previewChangedAt(previous, preview, fallbackActivityAt, now = Date.now()) {
  if (!previous) return Number(fallbackActivityAt) || 0;
  return previous.preview !== preview ? now : Number(previous.changedAt) || 0;
}

function statusTone(status, acknowledged) {
  if (status === 'running') return 'working';
  if (status === 'waiting') return 'waiting';
  if (status === 'interrupted' || status === 'error') return 'error';
  if (status === 'done' && !acknowledged) return 'ready';
  return 'idle';
}

function statusLabel(status, acknowledged) {
  return {
    running: 'WORKING',
    waiting: 'WAITING',
    interrupted: 'STOPPED',
    error: 'ERROR',
  }[status] || (status === 'done' && !acknowledged ? 'READY' : 'IDLE');
}

function activeProcess(record) {
  const windows = Array.isArray(record && record.windows) ? record.windows : [];
  const activeWindow = windows.find((window) => window.active) || windows[0];
  const panes = Array.isArray(activeWindow && activeWindow.panes) ? activeWindow.panes : [];
  const activePane = panes.find((pane) => pane.active) || panes[0];
  return activePane && (activePane.agent?.process || activePane.process) || 'shell';
}
class SessionMonitor {
  constructor(owner, options) {
    this.owner = owner;
    this.vscode = options.vscode;
    this.workspaceName = options.workspaceName;
    this.waitFor = options.waitFor;
    this.titleFor = options.titleFor;
    this.view = undefined;
    this.timer = undefined;
    this.refreshing = false;
    this.previewCache = new Map();
    this.openPromise = undefined;
    this.focused = false;
    this.returnTerminal = undefined;
  }

  async updateContext() {
    await this.vscode.commands.executeCommand(
      'setContext',
      'aiTerminalSessions.monitorHasPins',
      this.owner.pinnedRecords().length > 0,
    );
  }

  async togglePin() {
    const record = this.owner.activeRecord();
    if (!record) return this.owner.warnManagedTerminal();
    await this.setPinned(record, !record.monitorPinned);
  }

  async setPinned(record, pinned) {
    if (!record || !this.owner.records.has(record.id)) return;
    if (pinned && !record.monitorPinned && this.owner.pinnedRecords().length >= 4) {
      this.vscode.window.showWarningMessage('The Session Monitor supports up to four sessions.');
      return;
    }
    record.monitorPinned = Boolean(pinned);
    record.monitorPinnedAt = pinned ? Date.now() : 0;
    if (!pinned) this.previewCache.delete(record.id);
    await Promise.all([this.owner.persist(), this.updateContext()]);
    this.showPinConfirmation(record, pinned);
    if (pinned) await this.open(true);
    if (!pinned && !this.owner.pinnedRecords().length && this.view?.visible) return this.hide();
    await this.refresh();
  }

  showPinConfirmation(record, pinned) {
    const title = this.titleFor(record);
    this.vscode.window.setStatusBarMessage(
      pinned ? `$(pin) ${title} pinned to Session Monitor` : `$(pinned) ${title} removed from Session Monitor`,
      1800,
    );
  }

  async toggle() {
    if (this.view?.visible && this.focused) return this.hide();
    return this.focus();
  }

  async focus() {
    const activeTerminal = this.vscode.window.activeTerminal;
    const activeTab = this.vscode.window.tabGroups?.activeTabGroup?.activeTab;
    this.returnTerminal = activeTab?.input instanceof this.vscode.TabInputTerminal
      && activeTerminal && this.vscode.window.terminals.includes(activeTerminal)
      ? activeTerminal
      : undefined;
    const view = this.view?.visible ? this.view : await this.open(false);
    if (!view) return undefined;
    if (typeof view.show === 'function') view.show(false);
    await view.webview.postMessage({ type: 'focus-monitor' });
    return view;
  }

  async hide() {
    const view = this.view;
    if (!view || !view.visible) return view;
    const returnTerminal = this.returnTerminal;
    await this.vscode.commands.executeCommand('workbench.action.closePanel');
    this.focused = false;
    this.stop();
    if (!this.showTerminalIfLive(returnTerminal)) {
      await this.vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }
    this.owner.output.appendLine('[monitor] bottom panel hidden');
    return view;
  }

  async open(preserveTerminalFocus = false) {
    if (this.view?.visible) return this.view;
    if (this.openPromise) return this.openPromise;
    this.openPromise = this.openImpl(preserveTerminalFocus).finally(() => {
      this.openPromise = undefined;
    });
    return this.openPromise;
  }

  async openImpl(preserveTerminalFocus) {
    const returnTerminal = this.vscode.window.activeTerminal;
    if (this.view && typeof this.view.show === 'function') {
      this.view.show(Boolean(preserveTerminalFocus));
    } else {
      await this.vscode.commands.executeCommand(MONITOR_CONTAINER_COMMAND);
      await this.waitFor(() => Boolean(this.view), 1200, 25);
    }
    if (!this.view) {
      this.vscode.window.showErrorMessage('The Session Monitor panel could not be opened.');
      return undefined;
    }
    this.start();
    await this.refresh();
    if (preserveTerminalFocus) this.showTerminalIfLive(returnTerminal);
    this.owner.output.appendLine('[monitor] bottom panel shown');
    return this.view;
  }

  async resolve(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = monitorHtml(view.webview, this.workspaceName());
    view.webview.onDidReceiveMessage((message) => this.receive(message));
    view.onDidChangeVisibility(() => this.visibilityChanged(view));
    view.onDidDispose(() => this.disposed(view));
    if (view.visible) this.start();
    if (this.owner.started) await this.refresh();
  }

  receive(message) {
    if (!message || this.owner.deactivating) return;
    if (message.type === 'ready') this.run('monitor-ready', () => this.refresh());
    else if (message.type === 'focus') this.run('monitor-focus', () => this.focusRecord(message.id));
    else if (message.type === 'unpin') {
      const record = this.owner.records.get(message.id);
      if (record) this.run('monitor-unpin', () => this.setPinned(record, false));
    } else if (message.type === 'focus-state') this.focused = Boolean(message.focused);
    else if (message.type === 'return') this.run('monitor-return', () => this.return());
  }

  visibilityChanged(view) {
    if (view.visible) {
      this.start();
      this.run('monitor-visible', () => this.refresh());
      return;
    }
    this.focused = false;
    this.stop();
  }

  disposed(view) {
    if (this.view !== view) return;
    this.view = undefined;
    this.focused = false;
    this.stop();
  }

  run(scope, operation) {
    operation().catch((error) => this.owner.log(scope, error));
  }

  showTerminalIfLive(terminal) {
    if (!terminal || !this.vscode.window.terminals.includes(terminal)) return false;
    try {
      terminal.show(false);
      return true;
    } catch (error) {
      this.owner.log('monitor-return-focus', error);
      return false;
    }
  }

  async return() {
    this.focused = false;
    if (this.showTerminalIfLive(this.returnTerminal)) return;
    await this.vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }

  start() {
    if (this.timer || !this.view?.visible || this.owner.deactivating) return;
    this.timer = setInterval(() => this.run('monitor-refresh', () => this.refresh()), MONITOR_REFRESH_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async refresh() {
    const view = this.view;
    if (!view?.visible || this.refreshing || this.owner.deactivating) return;
    this.refreshing = true;
    try {
      const now = Date.now();
      const sessions = await Promise.all(
        this.owner.pinnedRecords().map((record) => this.sessionSnapshot(record, now)),
      );
      if (this.view === view) await this.postSnapshot(view, sessions, now);
    } finally {
      this.refreshing = false;
    }
  }

  async sessionSnapshot(record, now) {
    const raw = await this.owner.tmux.runTmux([
      'capture-pane', '-p', '-e', '-J', '-t', `${record.tmuxSession}:`,
    ], true);
    const terminal = ansiTerminalPreview(raw, MONITOR_LINES);
    const previous = this.previewCache.get(record.id);
    const baselineActivityAt = activityReference(record, Number(record.createdAt) || now);
    const changedAt = previewChangedAt(previous, terminal.text, baselineActivityAt, now);
    this.previewCache.set(record.id, { preview: terminal.text, changedAt });
    return monitorSnapshot(record, terminal, previous, baselineActivityAt, changedAt, now, this.titleFor);
  }

  postSnapshot(view, sessions, now) {
    return view.webview.postMessage({
      type: 'snapshot',
      sessions,
      updated: new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
  }

  async focusRecord(recordId) {
    const record = this.owner.records.get(recordId);
    if (!record) return;
    const terminal = this.owner.terminals.get(record.id) || this.owner.openRecord(record, false);
    this.focused = false;
    terminal.show(false);
  }
}

function monitorSnapshot(record, terminal, previous, baselineActivityAt, changedAt, now, titleFor) {
  const acknowledged = Boolean(record.readyAt
    && (record.lastAcknowledgedReadyAt || 0) >= record.readyAt);
  const activityAt = hasAgentContext(record)
    ? baselineActivityAt
    : Math.max(baselineActivityAt, Number(changedAt) || 0);
  const turn = turnDurationLabel(record, now);
  return {
    id: record.id,
    title: titleFor(record),
    process: activeProcess(record),
    status: statusLabel(record.status, acknowledged),
    tone: statusTone(record.status, acknowledged),
    age: turn && (record.status === 'running' || record.status === 'waiting')
      ? '' : activityLabel(activityAt, now),
    turn,
    preview: terminal.text,
    lines: terminal.lines,
    fresh: Boolean(previous && previous.preview !== terminal.text),
  };
}

module.exports = {
  activeProcess,
  activityLabel,
  ansiTerminalPreview,
  previewChangedAt,
  SessionMonitor,
  statusLabel,
  statusTone,
  turnDurationLabel,
  turnElapsedMs,
};
