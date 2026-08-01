'use strict';

const { interruptionWasAcknowledged } = require('./session-status');
const { normalizedTerminalLabel } = require('./workbench-recovery');
const { sessionPaneSummary } = require('./pane-model');

function readyNeedsAttention(record) {
  return record && record.status === 'done'
    && Number(record.readyAt) > 0
    && Number(record.lastAcknowledgedReadyAt || 0) < Number(record.readyAt);
}

function sessionNeedsAttention(record) {
  if (!record) return false;
  if (sessionPaneSummary(record).attention > 0) return true;
  if (record.manuallyNeedsAttention) return true;
  if (record.status === 'waiting' || record.status === 'error') return true;
  if (record.status === 'interrupted') return !interruptionWasAcknowledged(record);
  return readyNeedsAttention(record);
}

function sessionCounts(records) {
  const sessions = [...records];
  const summaries = sessions.map(sessionPaneSummary);
  const legacyAttention = sessions.filter((record, index) => (
    summaries[index].agents === 0 && sessionNeedsAttention(record)
  )).length;
  const legacyWorking = sessions.filter((record, index) => (
    summaries[index].agents === 0 && record && record.status === 'running'
  )).length;
  return {
    total: sessions.length,
    attention: sessions.filter(sessionNeedsAttention).length,
    attentionPanes: legacyAttention
      + summaries.reduce((total, summary) => total + summary.attention, 0),
    working: sessions.filter((record, index) => (
      record && (record.status === 'running' || summaries[index].working > 0)
    )).length,
    workingPanes: legacyWorking
      + summaries.reduce((total, summary) => total + summary.working, 0),
  };
}

function recordTitle(record) {
  return String(record && (record.manualTitle || record.autoTitle || record.tmuxSession) || '')
    .trim();
}

function sessionTabHealth(options = {}) {
  const records = [...(options.records || [])];
  const managedTitles = new Set(records.map(recordTitle).map(normalizedTerminalLabel).filter(Boolean));
  const labels = Array.isArray(options.terminalTabLabels) ? options.terminalTabLabels : [];
  const isSerializedStub = typeof options.isSerializedStub === 'function'
    ? options.isSerializedStub
    : () => false;
  const visible = labels.filter((label) => (
    managedTitles.has(normalizedTerminalLabel(label)) || isSerializedStub(label)
  )).length;
  const expected = records.length;
  const connected = Math.max(0, Number(options.connected) || 0);
  const settling = Boolean(options.settling);
  const extra = settling ? 0 : Math.max(0, visible - expected);
  const missing = settling ? 0 : Math.max(0, expected - connected);
  return {
    expected,
    connected,
    visible,
    extra,
    missing,
    healthy: extra === 0 && missing === 0,
  };
}

module.exports = {
  readyNeedsAttention,
  recordTitle,
  sessionCounts,
  sessionNeedsAttention,
  sessionTabHealth,
};
