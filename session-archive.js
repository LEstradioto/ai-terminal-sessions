'use strict';

const { restorableRecord } = require('./session-history');

const ARCHIVE_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 500;
const VALID_ROLES = new Set(['user', 'assistant', 'draft']);

function sessionAgent(record) {
  const agents = (record && record.windows || []).flatMap((window) => (window.panes || []))
    .map((pane) => pane.agent)
    .filter((agent) => agent && (agent.type === 'codex' || agent.type === 'claude') && agent.sessionId);
  if (record && record.activeAgent) {
    const selected = agents.find((agent) => (
      agent.type === record.activeAgent.type && agent.sessionId === record.activeAgent.sessionId
    ));
    if (selected) return selected;
  }
  return agents.find((agent) => agent.active) || agents[0];
}

function archiveKey(record) {
  const agents = (record && record.windows || []).flatMap((window) => (window.panes || []))
    .map((pane) => pane.agent)
    .filter((agent) => agent && agent.sessionId);
  if (agents.length > 1) return `tab:${String(record && record.id || '')}`;
  const agent = sessionAgent(record);
  return agent ? `${agent.type}:${agent.sessionId}` : `tab:${String(record && record.id || '')}`;
}

function sessionTitle(record) {
  return String(record && (record.manualTitle || record.autoTitle || record.tmuxSession) || 'terminal')
    .trim().slice(0, 80) || 'terminal';
}

function normalizePreview(preview, limit = 7) {
  const result = [];
  for (const item of Array.isArray(preview) ? preview : []) {
    if (!item || !VALID_ROLES.has(item.role)) continue;
    const text = String(item.text || '').replace(/\r\n?/g, '\n').trim().slice(0, 1600);
    if (!text) continue;
    const duplicate = result.findIndex((message) => (
      message.role === item.role && message.text === text
    ));
    if (duplicate >= 0) result.splice(duplicate, 1);
    result.push({ role: item.role, text });
  }
  return result.slice(-Math.max(1, Number(limit) || 7));
}

function normalizeArchiveEntry(raw, workspaceKey) {
  if (!raw || !raw.record) return undefined;
  const record = restorableRecord({ ...raw.record, workspaceKey });
  if (!record.id || !record.tmuxSession) return undefined;
  const key = archiveKey(record);
  if (!key || key === 'tab:') return undefined;
  const agent = sessionAgent(record);
  return {
    key,
    title: sessionTitle(record),
    provider: agent ? agent.type : 'terminal',
    archivedAt: Math.max(0, Number(raw.archivedAt) || 0),
    lastRestoredAt: Math.max(0, Number(raw.lastRestoredAt) || 0),
    closeAction: ['kill', 'forget', 'process', 'snapshot'].includes(raw.closeAction)
      ? raw.closeAction
      : 'snapshot',
    preview: normalizePreview(raw.preview),
    record,
  };
}

function upsertArchivedSession(entries, record, options = {}) {
  const normalizedRecord = restorableRecord(record);
  const candidate = normalizeArchiveEntry({
    record: normalizedRecord,
    archivedAt: Number(options.archivedAt) || Date.now(),
    lastRestoredAt: Number(options.lastRestoredAt) || 0,
    closeAction: options.closeAction,
    preview: options.preview,
  }, normalizedRecord.workspaceKey);
  if (!candidate) return { entries: Array.isArray(entries) ? entries : [], changed: false };

  const existing = (Array.isArray(entries) ? entries : []).find((entry) => entry.key === candidate.key);
  if (existing) candidate.preview = normalizePreview([...existing.preview, ...candidate.preview]);
  if (existing) candidate.lastRestoredAt = Math.max(candidate.lastRestoredAt, existing.lastRestoredAt || 0);
  candidate.archivedAt = Math.max(candidate.archivedAt, existing && existing.archivedAt || 0);

  const maximum = Math.max(1, Number(options.maxEntries) || DEFAULT_MAX_ENTRIES);
  const next = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry.key !== candidate.key)
    .concat(candidate)
    .sort((left, right) => (right.archivedAt || 0) - (left.archivedAt || 0))
    .slice(0, maximum);
  return { entries: next, changed: true, entry: candidate };
}

function normalizeArchivePayload(payload, workspaceKey, options = {}) {
  if (!payload || payload.version !== ARCHIVE_VERSION || payload.workspaceKey !== workspaceKey) return [];
  const maximum = Math.max(1, Number(options.maxEntries) || DEFAULT_MAX_ENTRIES);
  const seen = new Set();
  return (Array.isArray(payload.sessions) ? payload.sessions : [])
    .map((entry) => normalizeArchiveEntry(entry, workspaceKey))
    .filter((entry) => {
      if (!entry || seen.has(entry.key)) return false;
      seen.add(entry.key);
      return true;
    })
    .sort((left, right) => (right.archivedAt || 0) - (left.archivedAt || 0))
    .slice(0, maximum);
}

function archivePayload(workspaceKey, sessions, savedAt = Date.now()) {
  return {
    version: ARCHIVE_VERSION,
    workspaceKey,
    savedAt,
    sessions,
  };
}

function migrateSnapshotsToArchive(entries, snapshots, currentRecords, options = {}) {
  let next = Array.isArray(entries) ? entries : [];
  const current = Array.isArray(currentRecords) ? currentRecords : [...currentRecords || []];
  const currentIds = new Set(current.map((record) => record.id));
  const currentTmux = new Set(current.map((record) => record.tmuxSession));
  const currentKeys = new Set(current.map(archiveKey));
  let changed = false;

  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    for (const record of snapshot.records || []) {
      if (currentIds.has(record.id) || currentTmux.has(record.tmuxSession)
        || currentKeys.has(archiveKey(record))) continue;
      const result = upsertArchivedSession(next, record, {
        archivedAt: Number(snapshot.savedAt) || Date.now(),
        closeAction: 'snapshot',
        maxEntries: options.maxEntries,
      });
      next = result.entries;
      changed = result.changed || changed;
    }
  }
  return { entries: next, changed };
}

module.exports = {
  ARCHIVE_VERSION,
  DEFAULT_MAX_ENTRIES,
  archiveKey,
  archivePayload,
  migrateSnapshotsToArchive,
  normalizeArchivePayload,
  normalizePreview,
  sessionAgent,
  sessionTitle,
  upsertArchivedSession,
};
