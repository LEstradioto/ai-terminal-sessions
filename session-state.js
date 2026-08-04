'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeIconMode, normalizeIconPreset } = require('./session-presentation');
const { normalizePaneRole, normalizeRestorePolicy } = require('./session-presentation');

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
  const status = VALID_STATUS.has(agent.status) ? agent.status : 'idle';
  const turnCompletedAt = finiteNumber(agent.turnCompletedAt);
  return {
    type: agent.type,
    sessionId: agent.sessionId,
    active: Boolean(agent.active),
    status,
    title: shortString(agent.title, 500),
    lastActivityAt: finiteNumber(agent.lastActivityAt),
    lastSeenAt: finiteNumber(agent.lastSeenAt),
    turnStartedAt: finiteNumber(agent.turnStartedAt),
    turnCompletedAt,
    turnDurationMs: finiteNumber(agent.turnDurationMs),
    readyAt: normalizeReadyAt(status, agent.readyAt, turnCompletedAt),
    lastAcknowledgedReadyAt: finiteNumber(agent.lastAcknowledgedReadyAt),
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
  const status = VALID_STATUS.has(raw.status) ? raw.status : 'idle';
  const turnCompletedAt = finiteNumber(raw.turnCompletedAt);
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
    status,
    monitorPinned: Boolean(raw.monitorPinned),
    monitorPinnedAt: finiteNumber(raw.monitorPinnedAt),
    tabOrder: Number.isFinite(raw.tabOrder) ? Number(raw.tabOrder) : undefined,
    createdAt: finiteNumber(raw.createdAt),
    updatedAt: finiteNumber(raw.updatedAt),
    lastFocusedAt: finiteNumber(raw.lastFocusedAt),
    activePaneId: shortString(raw.activePaneId, 128),
    backgroundAttentionCount: finiteNumber(raw.backgroundAttentionCount),
    readyAt: normalizeReadyAt(status, raw.readyAt, turnCompletedAt),
    lastAcknowledgedReadyAt: finiteNumber(raw.lastAcknowledgedReadyAt),
    interruptedAt: finiteNumber(raw.interruptedAt),
    lastAcknowledgedInterruptedAt: finiteNumber(raw.lastAcknowledgedInterruptedAt),
    lastAgentActivityAt: finiteNumber(raw.lastAgentActivityAt),
    turnStartedAt: finiteNumber(raw.turnStartedAt),
    turnCompletedAt,
    turnDurationMs: finiteNumber(raw.turnDurationMs),
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

function normalizeReadyAt(status, readyAt, turnCompletedAt) {
  const ready = finiteNumber(readyAt);
  const completed = finiteNumber(turnCompletedAt);
  if (status === 'done' && ready > completed && completed > 0) return completed;
  return ready;
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

function numericOrder(record) {
  return Number.isFinite(record && record.tabOrder) ? record.tabOrder : Number.MAX_SAFE_INTEGER;
}

function compareSessionOrder(left, right) {
  return numericOrder(left) - numericOrder(right)
    || (Number(left && left.createdAt) || 0) - (Number(right && right.createdAt) || 0)
    || String(left && left.id || '').localeCompare(String(right && right.id || ''));
}

function sortRecordsForRestore(records) {
  return [...records].sort(compareSessionOrder);
}

function recordIdsForTabLabels(tabLabels, terminals) {
  const byName = new Map();
  for (const terminal of terminals) {
    if (!terminal || !terminal.id || !terminal.name) continue;
    const bucket = byName.get(terminal.name) || [];
    bucket.push(terminal);
    byName.set(terminal.name, bucket);
  }
  for (const bucket of byName.values()) bucket.sort(compareSessionOrder);
  return orderedRecordIds(tabLabels, byName);
}

function orderedRecordIds(tabLabels, recordsByName) {
  const ids = [];
  for (const label of tabLabels) {
    const bucket = recordsByName.get(label);
    if (bucket && bucket.length) ids.push(bucket.shift().id);
  }
  return ids;
}

function applyVisualOrder(records, orderedIds) {
  let changed = false;
  orderedIds.forEach((recordId, index) => {
    const record = records.get(recordId);
    if (!record || record.tabOrder === index) return;
    record.tabOrder = index;
    changed = true;
  });
  return changed;
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

class WorkspaceRecoveryFiles {
  constructor(directory, workspaceHash) {
    this.directory = directory;
    this.paths = new Map([
      ['drafts', path.join(directory, `drafts-${workspaceHash}.json`)],
      ['history', path.join(directory, `history-${workspaceHash}.json`)],
      ['archive', path.join(directory, `archive-${workspaceHash}.json`)],
    ]);
    this.queues = new Map();
  }

  async read(kind) {
    const file = this.file(kind);
    try {
      return JSON.parse(await fs.promises.readFile(file, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  write(kind, payload) {
    const pending = this.queues.get(kind) || Promise.resolve();
    const queued = pending.catch(() => {}).then(() => this.writeNow(kind, payload));
    this.queues.set(kind, queued);
    return queued;
  }

  async writeNow(kind, payload) {
    const file = this.file(kind);
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.promises.mkdir(this.directory, { recursive: true });
    await fs.promises.writeFile(temporary, JSON.stringify(payload), {
      encoding: 'utf8', mode: 0o600,
    });
    await fs.promises.rename(temporary, file);
  }

  async removeAll() {
    await Promise.all([...this.paths.values()].map(async (file) => {
      try { await fs.promises.unlink(file); } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
    }));
  }

  flush() {
    return Promise.all([...this.queues.values()].map((pending) => pending.catch(() => {})));
  }

  file(kind) {
    const file = this.paths.get(kind);
    if (!file) throw new Error(`Unknown recovery file "${kind}"; expected drafts, history, or archive`);
    return file;
  }
}

module.exports = {
  SESSION_STATE_VERSION,
  SessionStateStore,
  WorkspaceRecoveryFiles,
  applyVisualOrder,
  compareSessionOrder,
  normalizeSessionRecord,
  normalizeStatePayload,
  recordIdsForTabLabels,
  sortRecordsForRestore,
  statePayload,
};
