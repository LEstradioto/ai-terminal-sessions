'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { escapeHtml } = require('./monitor-view');
const { normalizeIconMode, normalizeIconPreset } = require('./session-presentation');
const { normalizePaneRole, normalizeRestorePolicy } = require('./session-presentation');

const HISTORY_VERSION = 1;
const DEFAULT_MAX_SNAPSHOTS = 20;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function restorableAgent(agent) {
  if (!agent || !agent.type || !agent.sessionId) return undefined;
  return {
    type: String(agent.type),
    sessionId: String(agent.sessionId),
    active: Boolean(agent.active),
    status: String(agent.status || 'idle'),
    lastActivityAt: Number(agent.lastActivityAt) || 0,
    readyAt: Number(agent.readyAt) || 0,
    lastAcknowledgedReadyAt: Number(agent.lastAcknowledgedReadyAt) || 0,
    interruptedAt: Number(agent.interruptedAt) || 0,
    lastAcknowledgedInterruptedAt: Number(agent.lastAcknowledgedInterruptedAt) || 0,
  };
}

function restorableWindows(windows) {
  if (!Array.isArray(windows)) return [];
  return windows.map((window) => ({
    index: Number(window.index) || 0,
    name: String(window.name || 'shell'),
    active: Boolean(window.active),
    layout: String(window.layout || '').slice(0, 2000),
    panes: Array.isArray(window.panes) ? window.panes.map((pane) => {
      const agent = restorableAgent(pane.agent);
      return {
        logicalId: String(pane.logicalId || ''),
        index: Number(pane.index) || 0,
        cwd: String(pane.cwd || ''),
        process: String(pane.process || ''),
        active: Boolean(pane.active),
        lastTerminalActivityAt: Number(pane.lastTerminalActivityAt) || 0,
        lastTerminalActivitySource: ['input', 'output'].includes(pane.lastTerminalActivitySource)
          ? pane.lastTerminalActivitySource
          : undefined,
        role: normalizePaneRole(pane.role, Boolean(agent)),
        restorePolicy: normalizeRestorePolicy(pane.restorePolicy, Boolean(agent)),
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
    iconPreset: normalizeIconPreset(record.iconPreset),
    iconMode: normalizeIconMode(record.iconMode, record.iconPreset),
    monitorPinned: Boolean(record.monitorPinned),
    monitorPinnedAt: Number(record.monitorPinnedAt) || 0,
    createdAt: Number(record.createdAt) || 0,
    updatedAt: Number(record.updatedAt) || 0,
    lastFocusedAt: Number(record.lastFocusedAt) || 0,
    activePaneId: String(record.activePaneId || ''),
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

const RELOCATION_VERSION = 1;

function relocationBundle(options = {}) {
  const workspaceKey = String(options.workspaceKey || '');
  const roots = normalizeRoots(options.roots);
  if (!workspaceKey || !roots.length) throw new Error('A workspace and at least one root are required');
  return {
    version: RELOCATION_VERSION,
    id: String(options.id || `${Number(options.createdAt) || Date.now()}`),
    createdAt: Number(options.createdAt) || Date.now(),
    sourceWorkspaceKey: workspaceKey,
    sourceRoots: roots,
    records: clone(Array.isArray(options.records) ? options.records : []),
    drafts: clone(options.drafts && typeof options.drafts === 'object' ? options.drafts : {}),
    snapshots: clone(Array.isArray(options.snapshots) ? options.snapshots : []),
    archive: clone(Array.isArray(options.archive) ? options.archive : []),
  };
}

function normalizeRelocationBundle(raw) {
  if (!raw || raw.version !== RELOCATION_VERSION || !raw.sourceWorkspaceKey) return undefined;
  const sourceRoots = normalizeRoots(raw.sourceRoots);
  if (!sourceRoots.length || !Array.isArray(raw.records)) return undefined;
  return relocationBundle({
    ...raw,
    workspaceKey: raw.sourceWorkspaceKey,
    roots: sourceRoots,
  });
}

function relocateWorkspaceBundle(raw, targetWorkspaceKey, targetRoots) {
  const bundle = normalizeRelocationBundle(raw);
  const targets = normalizeRoots(targetRoots);
  if (!bundle) throw new Error('The relocation bundle is invalid');
  if (!targetWorkspaceKey || !targets.length) throw new Error('The target workspace has no local folder');
  const mappings = mapRoots(bundle.sourceRoots, targets);
  const relocateRecord = (record) => relocateSessionRecord(record, targetWorkspaceKey, mappings);
  return {
    ...bundle,
    targetWorkspaceKey,
    targetRoots: targets,
    records: bundle.records.map(relocateRecord),
    snapshots: bundle.snapshots.map((snapshot) => ({
      ...clone(snapshot),
      records: Array.isArray(snapshot && snapshot.records)
        ? snapshot.records.map(relocateRecord)
        : [],
    })),
    archive: bundle.archive.map((entry) => ({
      ...clone(entry),
      record: entry && entry.record ? relocateRecord(entry.record) : entry.record,
    })),
  };
}

function relocateSessionRecord(raw, workspaceKey, mappings) {
  const record = clone(raw || {});
  record.workspaceKey = workspaceKey;
  record.cwd = relocatePath(record.cwd, mappings);
  record.windows = Array.isArray(record.windows) ? record.windows.map((window) => ({
    ...window,
    panes: Array.isArray(window.panes) ? window.panes.map((pane) => ({
      ...pane,
      cwd: relocatePath(pane.cwd, mappings),
    })) : [],
  })) : [];
  return record;
}

function relocatePath(value, mappings) {
  const current = String(value || '');
  if (!current || !path.isAbsolute(current)) return current;
  for (const mapping of mappings) {
    const relative = path.relative(mapping.source, current);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return path.join(mapping.target, relative);
    }
  }
  return current;
}

function mapRoots(sourceRoots, targetRoots) {
  if (sourceRoots.length !== targetRoots.length) {
    throw new Error(`The workspace root count changed from ${sourceRoots.length} to ${targetRoots.length}`);
  }
  const available = [...targetRoots];
  const mappings = [];
  for (const source of sourceRoots) {
    let index = available.findIndex((target) => target.name === source.name);
    if (index < 0 && available.length === 1) index = 0;
    if (index < 0) {
      throw new Error(`Could not match the relocated workspace folder ${source.name}`);
    }
    const [target] = available.splice(index, 1);
    mappings.push({ source: source.fsPath, target: target.fsPath });
  }
  return mappings.sort((left, right) => right.source.length - left.source.length);
}

function normalizeRoots(roots) {
  return (Array.isArray(roots) ? roots : []).flatMap((root, index) => {
    const fsPath = String(root && root.fsPath || '').trim();
    if (!fsPath || !path.isAbsolute(fsPath)) return [];
    return [{
      name: String(root && root.name || `root-${index + 1}`).slice(0, 200),
      fsPath: path.resolve(fsPath),
    }];
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function historyPreviewHtml(entry, options = {}) {
  const title = escapeHtml(entry && entry.title || 'Session preview');
  const provider = escapeHtml(entry && entry.provider || 'terminal');
  const archivedAt = entry && entry.archivedAt
    ? escapeHtml(new Date(entry.archivedAt).toLocaleString())
    : 'unknown date';
  const messages = entry && Array.isArray(entry.preview) ? entry.preview : [];
  const body = options.loading
    ? '<div class="empty">Loading local transcript preview...</div>'
    : previewMessagesHtml(messages);
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

function previewMessagesHtml(messages) {
  if (!messages.length) {
    return '<div class="empty">No message preview is available for this session.</div>';
  }
  return messages.map((message) => {
    const label = message.role === 'assistant' ? 'Agent'
      : message.role === 'draft' ? 'Recovered draft' : 'You';
    return `<article class="message ${escapeHtml(message.role)}"><div class="role">${label}</div><pre>${escapeHtml(message.text)}</pre></article>`;
  }).join('');
}

module.exports = {
  ARCHIVE_VERSION,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_SNAPSHOTS,
  HISTORY_VERSION,
  RELOCATION_VERSION,
  appendSessionSnapshot,
  archiveKey,
  archivePayload,
  historyPayload,
  historyPreviewHtml,
  mapRoots,
  migrateSnapshotsToArchive,
  normalizeArchivePayload,
  normalizePreview,
  normalizeRelocationBundle,
  normalizeSessionHistory,
  recordsFingerprint,
  relocatePath,
  relocateSessionRecord,
  relocateWorkspaceBundle,
  relocationBundle,
  restorableRecord,
  sessionAgent,
  sessionTitle,
  snapshotRecords,
  upsertArchivedSession,
};
