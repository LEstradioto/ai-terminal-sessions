'use strict';

const crypto = require('node:crypto');

const HISTORY_VERSION = 1;
const DEFAULT_MAX_SNAPSHOTS = 20;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function restorableAgent(agent) {
  if (!agent || !agent.type || !agent.sessionId) return undefined;
  return {
    type: String(agent.type),
    sessionId: String(agent.sessionId),
    active: Boolean(agent.active),
  };
}

function restorableWindows(windows) {
  if (!Array.isArray(windows)) return [];
  return windows.map((window) => ({
    index: Number(window.index) || 0,
    name: String(window.name || 'shell'),
    active: Boolean(window.active),
    panes: Array.isArray(window.panes) ? window.panes.map((pane) => {
      const agent = restorableAgent(pane.agent);
      return {
        index: Number(pane.index) || 0,
        cwd: String(pane.cwd || ''),
        process: String(pane.process || ''),
        active: Boolean(pane.active),
        ...(agent && { agent }),
      };
    }) : [],
  }));
}

function restorableRecord(record) {
  return {
    id: String(record.id || ''),
    workspaceKey: String(record.workspaceKey || ''),
    tmuxSession: String(record.tmuxSession || ''),
    cwd: String(record.cwd || ''),
    owned: record.owned !== false,
    autoTitle: String(record.autoTitle || ''),
    manualTitle: String(record.manualTitle || ''),
    monitorPinned: Boolean(record.monitorPinned),
    monitorPinnedAt: Number(record.monitorPinnedAt) || 0,
    createdAt: Number(record.createdAt) || 0,
    updatedAt: Number(record.updatedAt) || 0,
    lastFocusedAt: Number(record.lastFocusedAt) || 0,
    tabOrder: Number.isFinite(record.tabOrder) ? record.tabOrder : undefined,
    windows: restorableWindows(record.windows),
  };
}

function snapshotRecords(records) {
  return [...records]
    .filter((record) => record && record.id && record.tmuxSession)
    .map(restorableRecord)
    .sort((left, right) => (
      (Number.isFinite(left.tabOrder) ? left.tabOrder : Number.MAX_SAFE_INTEGER)
      - (Number.isFinite(right.tabOrder) ? right.tabOrder : Number.MAX_SAFE_INTEGER)
      || left.createdAt - right.createdAt
      || left.id.localeCompare(right.id)
    ));
}

function recordsFingerprint(records) {
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

function trimSnapshots(snapshots, now, options = {}) {
  const maxSnapshots = Math.max(1, Number(options.maxSnapshots) || DEFAULT_MAX_SNAPSHOTS);
  const maxAgeMs = Math.max(1, Number(options.maxAgeMs) || DEFAULT_MAX_AGE_MS);
  return snapshots
    .filter((snapshot) => snapshot && now - (Number(snapshot.savedAt) || 0) <= maxAgeMs)
    .slice(-maxSnapshots);
}

function appendSessionSnapshot(history, records, options = {}) {
  const now = Number(options.now) || Date.now();
  const snapshots = trimSnapshots(Array.isArray(history) ? history : [], now, options);
  const compactRecords = snapshotRecords(records);
  if (!compactRecords.length) return { history: snapshots, changed: snapshots.length !== (history || []).length };

  const fingerprint = recordsFingerprint(compactRecords);
  const last = snapshots[snapshots.length - 1];
  if (!options.force && last && last.fingerprint === fingerprint) {
    return { history: snapshots, changed: snapshots.length !== (history || []).length };
  }

  snapshots.push({
    id: `${now}-${fingerprint.slice(0, 10)}`,
    savedAt: now,
    reason: String(options.reason || 'state'),
    fingerprint,
    records: compactRecords,
  });
  return { history: trimSnapshots(snapshots, now, options), changed: true };
}

function normalizeSessionHistory(payload, workspaceKey, options = {}) {
  const now = Number(options.now) || Date.now();
  if (!payload || payload.version !== HISTORY_VERSION || payload.workspaceKey !== workspaceKey) return [];
  const valid = (Array.isArray(payload.snapshots) ? payload.snapshots : []).filter((snapshot) => (
    snapshot && Array.isArray(snapshot.records) && snapshot.records.length
  ));
  return trimSnapshots(valid, now, options);
}

function historyPayload(workspaceKey, snapshots, savedAt = Date.now()) {
  return {
    version: HISTORY_VERSION,
    workspaceKey,
    savedAt,
    snapshots,
  };
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_SNAPSHOTS,
  HISTORY_VERSION,
  appendSessionSnapshot,
  historyPayload,
  normalizeSessionHistory,
  recordsFingerprint,
  restorableRecord,
  snapshotRecords,
};
