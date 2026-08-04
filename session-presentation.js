'use strict';

const { normalizedTerminalLabel } = require('./runtime');

const DEFAULT_ICON_PRESET = 'terminal';
const VALID_ICON_MODES = new Set(['auto', 'manual']);

const STATUS_ICON = Object.freeze({
  idleRecent: '🟨',
  idleCooling: '🟧',
  idleOld: '🟫',
  running: '🟡',
  waiting: '🟠',
  done: '🟢',
  interrupted: '🔴',
  error: '🔴',
});

const WORKING_FRAMES = Object.freeze([
  '○⠋', '○⠙', '○⠹', '○⠸', '○⠼', '○⠴', '○⠦', '○⠧', '○⠇', '○⠏',
]);

const ICON_PRESETS = Object.freeze([
  preset('terminal', 'Terminal', '🔷', 'terminal-tmux', 'terminal.ansiCyan', 'General shell and tmux work'),
  preset('codex', 'Codex', '🟢', 'sparkle', 'terminal.ansiGreen', 'Detected Codex CLI sessions'),
  preset('claude', 'Claude Code', '🟠', 'comment-discussion', 'terminal.ansiYellow', 'Detected Claude Code sessions'),
  preset('rails', 'Rails Server', '🔴', 'ruby', 'terminal.ansiRed', 'Detected Rails and Puma servers'),
  preset('agent', 'Agent', '🟣', 'robot', 'terminal.ansiMagenta', 'Codex, Claude Code, and other agents'),
  preset('code', 'Code', '🔵', 'code', 'terminal.ansiBlue', 'Implementation and refactoring'),
  preset('server', 'Server', '🟡', 'server', 'terminal.ansiYellow', 'Local servers and long-running processes'),
  preset('deploy', 'Deploy', '🟢', 'rocket', 'terminal.ansiGreen', 'CI, releases, and deploys'),
  preset('database', 'Database', '🟪', 'database', 'terminal.ansiBrightMagenta', 'Databases, queues, and storage'),
  preset('tests', 'Tests', '🧪', 'beaker', 'terminal.ansiBrightGreen', 'Test suites and checks'),
  preset('debug', 'Debug', '🔴', 'bug', 'terminal.ansiRed', 'Debugging and incident work'),
]);

const ICON_PRESETS_BY_ID = new Map(ICON_PRESETS.map((item) => [item.id, item]));

function preset(id, label, marker, icon, color, description) {
  return Object.freeze({ id, label, marker, icon, color, description });
}

function normalizeIconPreset(value) {
  return ICON_PRESETS_BY_ID.has(value) ? value : DEFAULT_ICON_PRESET;
}

function iconPreset(value) {
  return ICON_PRESETS_BY_ID.get(normalizeIconPreset(value));
}

function normalizeIconMode(value, selectedPreset) {
  if (VALID_ICON_MODES.has(value)) return value;
  return selectedPreset && normalizeIconPreset(selectedPreset) !== DEFAULT_ICON_PRESET
    ? 'manual'
    : 'auto';
}

function isRailsServerProcess(processInfo) {
  const command = String(processInfo && processInfo.command || '').replace(/\\/g, '/');
  return /(?:^|\s)(?:\S*\/)?(?:bin\/)?rails\s+(?:server|s)\b/i.test(command)
    || /(?:^|\s)\S*puma(?:\s|$).*?(?:config\/puma\.rb|-C\s+\S*puma\.rb)/i.test(command);
}

function isPumaProcess(processInfo) {
  const value = `${processInfo && processInfo.comm || ''} ${processInfo && processInfo.command || ''}`;
  return /(?:^|[\s/])puma(?:\s|$)/i.test(value);
}

function automaticIconPreset(options = {}) {
  if (options.agentType === 'codex') return 'codex';
  if (options.agentType === 'claude') return 'claude';
  const processes = options.processes || [];
  if (processes.some(isRailsServerProcess)) return 'rails';
  if (options.railsProject && processes.some(isPumaProcess)) return 'rails';
  return DEFAULT_ICON_PRESET;
}

function terminalStatusIcon(record, options = {}) {
  const now = finiteNumber(options.now, Date.now());
  const actionIcon = activeStatusIcon(record);
  if (actionIcon) return actionIcon;

  const recentMinutes = Math.max(1, finiteNumber(options.recentMinutes, 30));
  const oldHours = Math.max(recentMinutes / 60, finiteNumber(options.oldHours, 4));
  const ageMs = Math.max(0, now - activityReference(record, now));
  if (ageMs < recentMinutes * 60 * 1000) return STATUS_ICON.idleRecent;
  if (ageMs < oldHours * 60 * 60 * 1000) return STATUS_ICON.idleCooling;
  return STATUS_ICON.idleOld;
}

function activeStatusIcon(record) {
  const status = record && record.status;
  if (status === 'running' || status === 'waiting' || status === 'error') return STATUS_ICON[status];
  if (status === 'interrupted' && !interruptionWasAcknowledged(record)) return STATUS_ICON.interrupted;
  if (status === 'done' && !readyWasAcknowledged(record)) return STATUS_ICON.done;
  return undefined;
}

function interruptionReference(record) {
  return finiteNumber(record && record.interruptedAt,
    finiteNumber(record && record.lastAgentActivityAt, 0));
}

function interruptionWasAcknowledged(record) {
  const interruptedAt = interruptionReference(record);
  if (!interruptedAt) return false;
  return Math.max(
    finiteNumber(record && record.lastAcknowledgedInterruptedAt, 0),
    finiteNumber(record && record.lastFocusedAt, 0),
  ) >= interruptedAt;
}

function readyWasAcknowledged(record) {
  const readyAt = finiteNumber(record && record.readyAt, 0);
  if (!readyAt) return false;
  return finiteNumber(record && record.lastAcknowledgedReadyAt, 0) >= readyAt;
}

function activityReference(record, fallback) {
  const agentActivity = finiteNumber(record && record.lastAgentActivityAt, 0);
  const semanticActivity = Math.max(agentActivity, effectiveTerminalActivityAt(record));
  if (semanticActivity > 0) return semanticActivity;
  return finiteNumber(record && record.readyAt,
    finiteNumber(record && record.createdAt, fallback));
}

function readyNeedsAttention(record) {
  return record && record.status === 'done'
    && Number(record.readyAt) > 0
    && Number(record.lastAcknowledgedReadyAt || 0) < Number(record.readyAt);
}

function sessionNeedsAttention(record) {
  if (!record) return false;
  if (sessionPaneSummary(record).attention > 0) return true;
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
  return sessionCountSummary(sessions, summaries, legacyAttention, legacyWorking);
}

function sessionCountSummary(sessions, summaries, legacyAttention, legacyWorking) {
  return {
    total: sessions.length,
    attention: sessions.filter(sessionNeedsAttention).length,
    attentionPanes: legacyAttention + summaries.reduce((sum, item) => sum + item.attention, 0),
    working: sessions.filter((record, index) => (
      record && (record.status === 'running' || summaries[index].working > 0)
    )).length,
    workingPanes: legacyWorking + summaries.reduce((sum, item) => sum + item.working, 0),
  };
}

function recordTitle(record) {
  return String(record && (record.manualTitle || record.autoTitle || record.tmuxSession) || '').trim();
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
  return tabHealthSummary(records.length, Number(options.connected), visible, Boolean(options.settling));
}

function tabHealthSummary(expected, connectedValue, visible, settling) {
  const connected = Math.max(0, connectedValue || 0);
  const extra = settling ? 0 : Math.max(0, visible - expected);
  const missing = settling ? 0 : Math.max(0, expected - connected);
  return { expected, connected, visible, extra, missing, healthy: extra === 0 && missing === 0 };
}

function workingIndicator(frame = 0, reducedMotion = false) {
  if (reducedMotion) return '○';
  const index = Math.abs(Number(frame) || 0) % WORKING_FRAMES.length;
  return WORKING_FRAMES[index];
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

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
  const turn = mergeTurnTiming(prior, observed);
  const previousActivity = Number(prior.lastActivityAt) || 0;
  const currentActivity = Number(observed.lastActivityAt) || 0;
  const priorCompletion = Number(prior.turnCompletedAt) || 0;
  const completionWasBackfilled = related
    && prior.status === 'done'
    && !priorCompletion
    && currentActivity <= previousActivity;
  const newCompletion = turn.turnCompletedAt > priorCompletion && !completionWasBackfilled;
  const newlyReady = observed.status === 'done' && (
    newCompletion
    || currentActivity > previousActivity
    || (!related && !Number(prior.readyAt))
    || (prior.status !== 'done' && !Number(prior.readyAt))
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
    ...turn,
    readyAt: newlyReady
      ? turn.turnCompletedAt || currentActivity || now
      : Number(prior.readyAt) || 0,
    lastAcknowledgedReadyAt: Number(prior.lastAcknowledgedReadyAt) || 0,
    status: observed.status === 'interrupted' && interruptionAcknowledged
      ? 'idle'
      : observed.status,
    interruptedAt,
    lastAcknowledgedInterruptedAt: Number(prior.lastAcknowledgedInterruptedAt) || 0,
    newlyReady,
    newlyInterrupted,
  };
}

function mergeTurnTiming(previous, observed) {
  const priorStart = positiveNumber(previous && previous.turnStartedAt);
  const priorCompleted = positiveNumber(previous && previous.turnCompletedAt);
  const observedStart = positiveNumber(observed && observed.turnStartedAt);
  const observedCompleted = positiveNumber(observed && observed.turnCompletedAt);
  const observedDuration = positiveNumber(observed && observed.turnDurationMs);
  let turnStartedAt = priorStart;
  let turnCompletedAt = priorCompleted;
  let turnDurationMs = positiveNumber(previous && previous.turnDurationMs);

  if (observedStart > priorStart) {
    turnStartedAt = observedStart;
    turnCompletedAt = observedCompleted >= observedStart ? observedCompleted : 0;
    turnDurationMs = turnCompletedAt
      ? observedDuration || turnCompletedAt - turnStartedAt
      : 0;
  } else if (observedStart && observedStart === priorStart) {
    turnCompletedAt = observedCompleted >= observedStart ? observedCompleted : 0;
    turnDurationMs = turnCompletedAt
      ? observedDuration || turnCompletedAt - turnStartedAt
      : 0;
  } else if (observedCompleted > priorCompleted) {
    turnCompletedAt = observedCompleted;
    turnDurationMs = observedDuration || (
      turnStartedAt && observedCompleted >= turnStartedAt
        ? observedCompleted - turnStartedAt
        : 0
    );
    if (!turnStartedAt && turnDurationMs) {
      turnStartedAt = Math.max(0, observedCompleted - turnDurationMs);
    }
  } else if ((observed.status === 'running' || observed.status === 'waiting')
    && priorCompleted && positiveNumber(observed.lastActivityAt) > priorCompleted) {
    // The transcript tail can lose the beginning of a very long new turn.
    // Prefer no timer to presenting the previous turn's duration as current.
    turnStartedAt = 0;
    turnCompletedAt = 0;
    turnDurationMs = 0;
  }

  return { turnStartedAt, turnCompletedAt, turnDurationMs };
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function agentNeedsAttention(agent) {
  if (!agent) return false;
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

function hasMeaningfulTerminalOutput(data) {
  return String(data || '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim().length > 0;
}

function hasAgentContext(record) {
  if (!record) return false;
  if (record.activeAgent && record.activeAgent.type) return true;
  const window = (record.windows || []).find((item) => item.active) || (record.windows || [])[0];
  const pane = window && ((window.panes || []).find((item) => item.active) || window.panes[0]);
  return Boolean(pane && pane.agent && pane.agent.active !== false);
}

function effectiveTerminalActivityAt(record) {
  const timestamp = finiteTimestamp(record && record.lastTerminalActivityAt);
  if (!timestamp || hasAgentContext(record)) return 0;
  const source = record && record.lastTerminalActivitySource;
  if (source === 'input' || source === 'output') return timestamp;

  // Before activity sources were persisted, PTY reconnect redraws could be
  // recorded as terminal activity. Legacy timestamps remain trustworthy only
  // for records that have never had semantic agent activity.
  return finiteTimestamp(record && record.lastAgentActivityAt) ? 0 : timestamp;
}

function repairLegacyRestoreActivity(records, clusterWindowMs = 1000) {
  const candidates = [...records].filter((record) => (
    finiteTimestamp(record && record.lastTerminalActivityAt)
    && record.lastTerminalActivitySource !== 'input'
    && record.lastTerminalActivitySource !== 'output'
  )).sort((left, right) => left.lastTerminalActivityAt - right.lastTerminalActivityAt);
  let repaired = 0;
  let cluster = [];

  const flush = () => {
    if (cluster.length >= 2) {
      for (const record of cluster) {
        record.lastTerminalActivityAt = 0;
        repaired += 1;
      }
    }
    cluster = [];
  };

  for (const record of candidates) {
    const previous = cluster[cluster.length - 1];
    if (previous && record.lastTerminalActivityAt - previous.lastTerminalActivityAt > clusterWindowMs) {
      flush();
    }
    cluster.push(record);
  }
  flush();
  return repaired;
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

module.exports = {
  DEFAULT_ICON_PRESET,
  ICON_PRESETS,
  STATUS_ICON,
  VALID_PANE_ROLE,
  VALID_RESTORE_POLICY,
  WORKING_FRAMES,
  activityReference,
  agentNeedsAttention,
  automaticIconPreset,
  effectiveTerminalActivityAt,
  focusedPane,
  hasAgentContext,
  hasMeaningfulTerminalOutput,
  iconPreset,
  interruptionReference,
  interruptionWasAcknowledged,
  isPumaProcess,
  isRailsServerProcess,
  mergeObservedAgent,
  mergeTurnTiming,
  normalizeIconMode,
  normalizeIconPreset,
  normalizePaneRole,
  normalizeRestorePolicy,
  paneKey,
  readyNeedsAttention,
  readyWasAcknowledged,
  recordTitle,
  repairLegacyRestoreActivity,
  sameAgent,
  sessionCounts,
  sessionNeedsAttention,
  sessionPaneSummary,
  sessionPanes,
  sessionTabHealth,
  terminalStatusIcon,
  workingIndicator,
};
