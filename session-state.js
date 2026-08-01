'use strict';

const { normalizeIconMode, normalizeIconPreset } = require('./terminal-icons');
const { normalizePaneRole, normalizeRestorePolicy } = require('./pane-model');

const SESSION_STATE_VERSION = 1;
const VALID_STATUS = new Set(['idle', 'running', 'waiting', 'done', 'interrupted', 'error']);
const VALID_AGENT = new Set(['claude', 'codex']);
const VALID_TERMINAL_ACTIVITY_SOURCE = new Set(['input', 'output']);
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function shortString(value, maximum = 500) {
  return String(value || '').slice(0, maximum);
}

function normalizeAgent(agent) {
  if (!agent || !VALID_AGENT.has(agent.type) || !UUID_RE.test(agent.sessionId || '')) return undefined;
  return {
    type: agent.type,
    sessionId: agent.sessionId,
    active: Boolean(agent.active),
    status: VALID_STATUS.has(agent.status) ? agent.status : 'idle',
    title: shortString(agent.title, 500),
    lastActivityAt: finiteNumber(agent.lastActivityAt),
    lastSeenAt: finiteNumber(agent.lastSeenAt),
    readyAt: finiteNumber(agent.readyAt),
    lastAcknowledgedReadyAt: finiteNumber(agent.lastAcknowledgedReadyAt),
    manuallyNeedsAttention: Boolean(agent.manuallyNeedsAttention),
    interruptedAt: finiteNumber(agent.interruptedAt),
    lastAcknowledgedInterruptedAt: finiteNumber(agent.lastAcknowledgedInterruptedAt),
  };
}

function normalizeWindows(windows) {
  if (!Array.isArray(windows)) return [];
  return windows.slice(0, 8).map((window) => ({
    id: shortString(window && window.id, 80),
    index: finiteNumber(window && window.index),
    name: shortString(window && window.name, 80) || 'shell',
    active: Boolean(window && window.active),
    layout: shortString(window && window.layout, 2000),
    panes: Array.isArray(window && window.panes) ? window.panes.slice(0, 16).map((pane) => {
      const agent = normalizeAgent(pane && pane.agent);
      return {
        id: shortString(pane && pane.id, 80),
        logicalId: shortString(pane && pane.logicalId, 128),
        index: finiteNumber(pane && pane.index),
        cwd: shortString(pane && pane.cwd, 4096),
        process: shortString(pane && pane.process, 256),
        active: Boolean(pane && pane.active),
        lastTerminalActivityAt: finiteNumber(pane && pane.lastTerminalActivityAt),
        lastTerminalActivitySource: VALID_TERMINAL_ACTIVITY_SOURCE.has(
          pane && pane.lastTerminalActivitySource
        ) ? pane.lastTerminalActivitySource : undefined,
        role: normalizePaneRole(pane && pane.role, Boolean(agent)),
        restorePolicy: normalizeRestorePolicy(pane && pane.restorePolicy, Boolean(agent)),
        ...(agent && { agent }),
      };
    }) : [],
  }));
}

function normalizeSessionRecord(raw, workspaceKey) {
  if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.tmuxSession !== 'string') return undefined;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(raw.tmuxSession)) return undefined;
  const activeAgent = normalizeAgent(raw.activeAgent);
  return {
    id: shortString(raw.id, 128),
    workspaceKey,
    tmuxSession: raw.tmuxSession,
    cwd: shortString(raw.cwd, 4096),
    owned: raw.owned !== false,
    autoTitle: shortString(raw.autoTitle, 80),
    manualTitle: shortString(raw.manualTitle, 80),
    iconPreset: normalizeIconPreset(raw.iconPreset),
    iconMode: normalizeIconMode(raw.iconMode, raw.iconPreset),
    sourceTitle: shortString(raw.sourceTitle, 500),
    status: VALID_STATUS.has(raw.status) ? raw.status : 'idle',
    monitorPinned: Boolean(raw.monitorPinned),
    monitorPinnedAt: finiteNumber(raw.monitorPinnedAt),
    tabOrder: Number.isFinite(raw.tabOrder) ? Number(raw.tabOrder) : undefined,
    createdAt: finiteNumber(raw.createdAt),
    updatedAt: finiteNumber(raw.updatedAt),
    lastFocusedAt: finiteNumber(raw.lastFocusedAt),
    activePaneId: shortString(raw.activePaneId, 128),
    backgroundAttentionCount: finiteNumber(raw.backgroundAttentionCount),
    readyAt: finiteNumber(raw.readyAt),
    lastAcknowledgedReadyAt: finiteNumber(raw.lastAcknowledgedReadyAt),
    manuallyNeedsAttention: Boolean(raw.manuallyNeedsAttention),
    interruptedAt: finiteNumber(raw.interruptedAt),
    lastAcknowledgedInterruptedAt: finiteNumber(raw.lastAcknowledgedInterruptedAt),
    lastAgentActivityAt: finiteNumber(raw.lastAgentActivityAt),
    lastTerminalActivityAt: finiteNumber(raw.lastTerminalActivityAt),
    lastTerminalActivitySource: VALID_TERMINAL_ACTIVITY_SOURCE.has(raw.lastTerminalActivitySource)
      ? raw.lastTerminalActivitySource
      : undefined,
    lastAutoTitleAt: finiteNumber(raw.lastAutoTitleAt),
    lastRestoredAt: finiteNumber(raw.lastRestoredAt),
    lastRenamedAt: finiteNumber(raw.lastRenamedAt),
    nativeRenamedAt: finiteNumber(raw.nativeRenamedAt),
    titleSourceSessionId: shortString(raw.titleSourceSessionId, 128),
    lastRenameProvider: shortString(raw.lastRenameProvider, 32),
    lastRenameModel: shortString(raw.lastRenameModel, 128),
    windows: normalizeWindows(raw.windows),
    ...(activeAgent && { activeAgent: { type: activeAgent.type, sessionId: activeAgent.sessionId } }),
  };
}

function statePayload(workspaceKey, records, revision = 0, savedAt = Date.now()) {
  return {
    version: SESSION_STATE_VERSION,
    workspaceKey,
    revision: finiteNumber(revision),
    savedAt,
    records: [...records].map((record) => normalizeSessionRecord(record, workspaceKey)).filter(Boolean),
  };
}

function normalizeStatePayload(payload, workspaceKey) {
  if (!payload || payload.version !== SESSION_STATE_VERSION
    || payload.workspaceKey !== workspaceKey || !Array.isArray(payload.records)) return undefined;
  return statePayload(
    workspaceKey,
    payload.records,
    finiteNumber(payload.revision),
    finiteNumber(payload.savedAt),
  );
}

class SessionStateStore {
  constructor(options) {
    this.workspaceState = options.workspaceState;
    this.globalState = options.globalState;
    this.stateKey = options.stateKey;
    this.backupKey = options.backupKey;
    this.workspaceKey = options.workspaceKey;
    this.queue = Promise.resolve();
  }

  load() {
    return [
      this.workspaceState.get(this.stateKey),
      this.globalState.get(this.backupKey),
    ].map((payload) => normalizeStatePayload(payload, this.workspaceKey))
      .filter(Boolean)
      .sort((left, right) => right.revision - left.revision || right.savedAt - left.savedAt)[0];
  }

  save(records, revision, savedAt = Date.now()) {
    const payload = statePayload(this.workspaceKey, records, revision, savedAt);
    this.queue = this.queue.catch(() => {}).then(() => Promise.all([
      this.workspaceState.update(this.stateKey, payload),
      this.globalState.update(this.backupKey, payload),
    ]));
    return this.queue.then(() => payload);
  }

  clear() {
    this.queue = this.queue.catch(() => {}).then(() => Promise.all([
      this.workspaceState.update(this.stateKey, undefined),
      this.globalState.update(this.backupKey, undefined),
    ]));
    return this.queue;
  }

  flush() {
    return this.queue;
  }
}

module.exports = {
  SESSION_STATE_VERSION,
  SessionStateStore,
  normalizeSessionRecord,
  normalizeStatePayload,
  statePayload,
};
