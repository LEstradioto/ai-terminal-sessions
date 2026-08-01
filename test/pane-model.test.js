'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  agentNeedsAttention,
  focusedPane,
  mergeObservedAgent,
  paneKey,
  sessionPaneSummary,
} = require('../pane-model');

test('selects the active pane inside the active window', () => {
  const record = { windows: [
    { active: false, panes: [{ logicalId: 'old', active: true }] },
    { active: true, panes: [
      { logicalId: 'helper', active: false },
      { logicalId: 'agent', active: true },
    ] },
  ] };
  assert.equal(focusedPane(record).logicalId, 'agent');
  assert.equal(paneKey('tab', focusedPane(record)), 'tab:agent');
});

test('tracks ready acknowledgement independently for each agent pane', () => {
  const previous = {
    type: 'codex',
    sessionId: 'one',
    status: 'running',
    lastActivityAt: 10,
  };
  const ready = mergeObservedAgent(previous, {
    type: 'codex',
    sessionId: 'one',
    status: 'done',
    lastActivityAt: 20,
  }, 100);
  assert.equal(ready.readyAt, 100);
  assert.equal(ready.newlyReady, true);
  assert.equal(agentNeedsAttention(ready), true);
  ready.lastAcknowledgedReadyAt = 100;
  assert.equal(agentNeedsAttention(ready), false);

  const repeated = mergeObservedAgent({ ...ready, status: 'idle' }, {
    type: 'codex',
    sessionId: 'one',
    status: 'done',
    lastActivityAt: 20,
  }, 200);
  assert.equal(repeated.newlyReady, false);
  assert.equal(repeated.readyAt, 100);
});

test('an acknowledged interrupted event stays idle until transcript activity changes', () => {
  const previous = {
    type: 'claude',
    sessionId: 'one',
    status: 'idle',
    lastActivityAt: 20,
    interruptedAt: 100,
    lastAcknowledgedInterruptedAt: 100,
  };
  const repeated = mergeObservedAgent(previous, {
    type: 'claude',
    sessionId: 'one',
    status: 'interrupted',
    lastActivityAt: 20,
  }, 200);
  assert.equal(repeated.status, 'idle');
  assert.equal(agentNeedsAttention(repeated), false);

  const changed = mergeObservedAgent(repeated, {
    type: 'claude',
    sessionId: 'one',
    status: 'interrupted',
    lastActivityAt: 21,
  }, 300);
  assert.equal(changed.status, 'interrupted');
  assert.equal(agentNeedsAttention(changed), true);
});

test('summarizes background pane attention separately from the focused pane', () => {
  const record = { windows: [{ active: true, panes: [
    { active: true, role: 'server' },
    { active: false, agent: { status: 'done', readyAt: 20, lastAcknowledgedReadyAt: 0 } },
    { active: false, agent: { status: 'running' } },
  ] }] };
  assert.deepEqual(sessionPaneSummary(record), {
    panes: 3,
    agents: 2,
    attention: 1,
    working: 1,
  });
});
