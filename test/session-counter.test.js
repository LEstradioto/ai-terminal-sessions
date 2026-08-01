'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  sessionCounts,
  sessionNeedsAttention,
  sessionTabHealth,
} = require('../session-counter');

function record(id, title, status = 'idle') {
  return { id, manualTitle: title, tmuxSession: `tmux-${id}`, status };
}

test('counts only unacknowledged states as attention', () => {
  const sessions = [
    record('a', 'Ready', 'running'),
    { ...record('b', 'Done', 'done'), readyAt: 20, lastAcknowledgedReadyAt: 10 },
    { ...record('c', 'Seen', 'done'), readyAt: 20, lastAcknowledgedReadyAt: 20 },
    record('d', 'Permission', 'waiting'),
    { ...record('e', 'Stopped', 'interrupted'), interruptedAt: 30, lastFocusedAt: 10 },
    { ...record('f', 'Seen stop', 'interrupted'), interruptedAt: 30, lastFocusedAt: 40 },
  ];
  assert.deepEqual(sessionCounts(sessions), {
    total: 6,
    attention: 3,
    attentionPanes: 3,
    working: 1,
    workingPanes: 1,
  });
  assert.equal(sessionNeedsAttention(sessions[5]), false);
});

test('counts an idle session manually flagged for attention', () => {
  const flagged = { ...record('a', 'Follow up'), manuallyNeedsAttention: true };
  assert.equal(sessionNeedsAttention(flagged), true);
  assert.deepEqual(sessionCounts([flagged]), {
    total: 1,
    attention: 1,
    attentionPanes: 1,
    working: 0,
    workingPanes: 0,
  });
});

test('counts pane-level work and attention without losing the session total', () => {
  const session = {
    ...record('a', 'Multipane'),
    windows: [{ panes: [
      { agent: { status: 'running' } },
      { agent: { status: 'done', readyAt: 10, lastAcknowledgedReadyAt: 0 } },
    ] }],
  };
  assert.deepEqual(sessionCounts([session]), {
    total: 1,
    attention: 1,
    attentionPanes: 1,
    working: 1,
    workingPanes: 1,
  });
});

test('detects a duplicate visible terminal without counting unrelated tabs', () => {
  const records = [record('a', 'Auth'), record('b', 'Build')];
  const health = sessionTabHealth({
    records,
    connected: 2,
    terminalTabLabels: ['🟨 Auth', '🟫 Build', '🟨 Auth', 'Regular zsh'],
  });
  assert.deepEqual(health, {
    expected: 2,
    connected: 2,
    visible: 3,
    extra: 1,
    missing: 0,
    healthy: false,
  });
});

test('detects missing bridges and serialized restore stubs after settling', () => {
  const records = [record('a', 'Auth'), record('b', 'Build')];
  const options = {
    records,
    connected: 1,
    terminalTabLabels: ['🟨 Auth', `${'a'.repeat(32)}1`],
    isSerializedStub: (label) => /^[0-9a-f]{32}\d+$/i.test(label),
  };
  assert.deepEqual(sessionTabHealth(options), {
    expected: 2,
    connected: 1,
    visible: 2,
    extra: 0,
    missing: 1,
    healthy: false,
  });
  assert.equal(sessionTabHealth({ ...options, settling: true }).healthy, true);
});
