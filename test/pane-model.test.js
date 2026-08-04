'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  agentNeedsAttention,
  focusedPane,
  mergeObservedAgent,
  paneKey,
  sessionPaneSummary,
} = require('../session-presentation');

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
  assert.equal(ready.readyAt, 20);
  assert.equal(ready.newlyReady, true);
  assert.equal(agentNeedsAttention(ready), true);
  ready.lastAcknowledgedReadyAt = 20;
  assert.equal(agentNeedsAttention(ready), false);

  const repeated = mergeObservedAgent({ ...ready, status: 'idle' }, {
    type: 'codex',
    sessionId: 'one',
    status: 'done',
    lastActivityAt: 20,
  }, 200);
  assert.equal(repeated.newlyReady, false);
  assert.equal(repeated.readyAt, 20);
});

test('keeps one prompt timer through running and strong completion observations', () => {
  const startedAt = 1_000;
  const running = mergeObservedAgent({
    type: 'codex',
    sessionId: 'one',
    status: 'done',
    turnStartedAt: 100,
    turnCompletedAt: 200,
    turnDurationMs: 100,
    readyAt: 300,
  }, {
    type: 'codex',
    sessionId: 'one',
    status: 'running',
    lastActivityAt: startedAt,
    turnStartedAt: startedAt,
  }, 2_000);
  assert.equal(running.turnStartedAt, startedAt);
  assert.equal(running.turnCompletedAt, 0);
  assert.equal(running.turnDurationMs, 0);

  const done = mergeObservedAgent(running, {
    type: 'codex',
    sessionId: 'one',
    status: 'done',
    lastActivityAt: 3_000,
    turnStartedAt: startedAt,
    turnCompletedAt: 4_000,
    turnDurationMs: 3_000,
  }, 4_100);
  assert.equal(done.turnDurationMs, 3_000);
  assert.equal(done.newlyReady, true);

  const repeated = mergeObservedAgent(done, {
    type: 'codex',
    sessionId: 'one',
    status: 'done',
    lastActivityAt: 3_000,
    turnStartedAt: startedAt,
    turnCompletedAt: 4_000,
    turnDurationMs: 3_000,
  }, 5_000);
  assert.equal(repeated.newlyReady, false);
  assert.equal(repeated.readyAt, 4_000);
});

test('does not announce a historical completion when turn timing is first backfilled', () => {
  const previous = {
    type: 'claude',
    sessionId: 'one',
    status: 'done',
    lastActivityAt: 2_000,
    readyAt: 2_000,
    lastAcknowledgedReadyAt: 2_000,
  };
  const observed = {
    type: 'claude',
    sessionId: 'one',
    status: 'done',
    lastActivityAt: 2_000,
    turnStartedAt: 1_000,
    turnCompletedAt: 2_000,
    turnDurationMs: 1_000,
  };
  const merged = mergeObservedAgent(previous, observed, 9_000);
  assert.equal(merged.newlyReady, false);
  assert.equal(merged.readyAt, 2_000);
  assert.equal(agentNeedsAttention(merged), false);
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
