'use strict';

const { effectiveTerminalActivityAt } = require('./terminal-activity');

const STATUS_ICON = {
  idleRecent: '🟨',
  idleCooling: '🟧',
  idleOld: '🟫',
  running: '🟡',
  waiting: '🟠',
  done: '🟢',
  interrupted: '🔴',
  error: '🔴',
};

function terminalStatusIcon(record, options = {}) {
  const now = finiteNumber(options.now, Date.now());
  const status = record && record.status;

  if (status === 'running' || status === 'waiting' || status === 'interrupted' || status === 'error') {
    return STATUS_ICON[status];
  }
  if (status === 'done' && !readyWasAcknowledged(record)) return STATUS_ICON.done;

  const recentMinutes = Math.max(1, finiteNumber(options.recentMinutes, 30));
  const oldHours = Math.max(recentMinutes / 60, finiteNumber(options.oldHours, 4));
  const activityAt = activityReference(record, now);
  const ageMs = Math.max(0, now - activityAt);

  if (ageMs < recentMinutes * 60 * 1000) return STATUS_ICON.idleRecent;
  if (ageMs < oldHours * 60 * 60 * 1000) return STATUS_ICON.idleCooling;
  return STATUS_ICON.idleOld;
}

function isNewReadyEvent(record, agent) {
  if (!agent || agent.status !== 'done') return false;
  if (!record || record.status !== 'done' || !record.readyAt) return true;
  const previousActivity = finiteNumber(record.lastAgentActivityAt, 0);
  const currentActivity = finiteNumber(agent.lastActivityAt, 0);
  return currentActivity > previousActivity;
}

function readyWasAcknowledged(record) {
  const readyAt = finiteNumber(record && record.readyAt, 0);
  if (!readyAt) return false;
  return finiteNumber(record && record.lastAcknowledgedReadyAt, 0) >= readyAt;
}

function activityReference(record, fallback) {
  const agentActivity = finiteNumber(record && record.lastAgentActivityAt, 0);
  const terminalActivity = effectiveTerminalActivityAt(record);
  const semanticActivity = Math.max(agentActivity, terminalActivity);
  if (semanticActivity > 0) return semanticActivity;
  return finiteNumber(record && record.readyAt,
    finiteNumber(record && record.createdAt, fallback));
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

module.exports = {
  STATUS_ICON,
  activityReference,
  isNewReadyEvent,
  readyWasAcknowledged,
  terminalStatusIcon,
};
