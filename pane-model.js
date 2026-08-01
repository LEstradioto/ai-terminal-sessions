'use strict';

const VALID_RESTORE_POLICY = new Set(['resume-agent', 'shell', 'restart-command', 'manual']);
const VALID_PANE_ROLE = new Set(['agent', 'server', 'logs', 'test', 'ci', 'shell', 'helper']);

function sessionPanes(record) {
  return (record && record.windows || []).flatMap((window) => (window.panes || []).map((pane) => ({
    ...pane,
    windowId: window.id,
    windowIndex: window.index,
    windowActive: window.active,
  })));
}

function focusedPane(record) {
  const windows = record && record.windows || [];
  const window = windows.find((item) => item.active) || windows[0];
  if (!window) return undefined;
  return (window.panes || []).find((pane) => pane.active) || window.panes && window.panes[0];
}

function paneKey(recordId, pane) {
  const logicalId = pane && pane.logicalId;
  return logicalId ? `${recordId}:${logicalId}` : String(recordId || '');
}

function sameAgent(left, right) {
  return Boolean(left && right && left.type === right.type && left.sessionId
    && left.sessionId === right.sessionId);
}

function mergeObservedAgent(previous, observed, now = Date.now()) {
  if (!observed) return undefined;
  const related = sameAgent(previous, observed);
  const prior = related ? previous : {};
  const previousActivity = Number(prior.lastActivityAt) || 0;
  const currentActivity = Number(observed.lastActivityAt) || 0;
  const newlyReady = observed.status === 'done' && (
    !Number(prior.readyAt) || currentActivity > previousActivity
  );
  const newlyInterrupted = observed.status === 'interrupted' && (
    !Number(prior.interruptedAt) || currentActivity > previousActivity
  );
  const interruptedAt = newlyInterrupted
    ? Math.max(currentActivity, now)
    : Number(prior.interruptedAt) || 0;
  const interruptionAcknowledged = interruptedAt > 0
    && Number(prior.lastAcknowledgedInterruptedAt) >= interruptedAt;
  return {
    ...prior,
    ...observed,
    readyAt: newlyReady ? now : Number(prior.readyAt) || 0,
    lastAcknowledgedReadyAt: Number(prior.lastAcknowledgedReadyAt) || 0,
    status: observed.status === 'interrupted' && interruptionAcknowledged
      ? 'idle'
      : observed.status,
    interruptedAt,
    lastAcknowledgedInterruptedAt: Number(prior.lastAcknowledgedInterruptedAt) || 0,
    manuallyNeedsAttention: Boolean(prior.manuallyNeedsAttention),
    newlyReady,
    newlyInterrupted,
  };
}

function agentNeedsAttention(agent) {
  if (!agent) return false;
  if (agent.manuallyNeedsAttention) return true;
  if (agent.status === 'waiting' || agent.status === 'error') return true;
  if (agent.status === 'interrupted') {
    return Number(agent.lastAcknowledgedInterruptedAt || 0) < Number(agent.interruptedAt || 0);
  }
  return agent.status === 'done'
    && Number(agent.readyAt) > Number(agent.lastAcknowledgedReadyAt || 0);
}

function sessionPaneSummary(record) {
  const panes = sessionPanes(record);
  const agents = panes.filter((pane) => pane.agent).map((pane) => pane.agent);
  return {
    panes: panes.length,
    agents: agents.length,
    attention: agents.filter(agentNeedsAttention).length,
    working: agents.filter((agent) => agent.status === 'running').length,
  };
}

function normalizePaneRole(value, hasAgent = false) {
  if (hasAgent) return 'agent';
  return VALID_PANE_ROLE.has(value) ? value : 'shell';
}

function normalizeRestorePolicy(value, hasAgent = false) {
  if (hasAgent) return 'resume-agent';
  return VALID_RESTORE_POLICY.has(value) ? value : 'shell';
}

module.exports = {
  VALID_PANE_ROLE,
  VALID_RESTORE_POLICY,
  agentNeedsAttention,
  focusedPane,
  mergeObservedAgent,
  normalizePaneRole,
  normalizeRestorePolicy,
  paneKey,
  sameAgent,
  sessionPaneSummary,
  sessionPanes,
};
