'use strict';

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
  return (record.windows || []).some((window) => (window.panes || []).some((pane) => (
    pane.agent && pane.agent.active !== false
  )));
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
  effectiveTerminalActivityAt,
  hasAgentContext,
  hasMeaningfulTerminalOutput,
  repairLegacyRestoreActivity,
};
