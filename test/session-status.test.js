'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  interruptionReference,
  interruptionWasAcknowledged,
  isNewReadyEvent,
  terminalStatusIcon,
} = require('../session-status');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

test('ages acknowledged and idle sessions through the three note colors', () => {
  const now = Date.UTC(2026, 6, 13, 18, 0, 0);
  const icon = (age) => terminalStatusIcon({
    status: 'idle',
    lastAgentActivityAt: now - age,
  }, { now, recentMinutes: 30, oldHours: 4 });

  assert.equal(icon(29 * MINUTE), '🟨');
  assert.equal(icon(30 * MINUTE), '🟧');
  assert.equal(icon(3 * HOUR), '🟧');
  assert.equal(icon(4 * HOUR), '🟫');
});

test('keeps an unseen completed answer green until its ready event is acknowledged', () => {
  const record = {
    status: 'done',
    readyAt: 200,
    lastAcknowledgedReadyAt: 100,
    lastAgentActivityAt: 50,
  };
  assert.equal(terminalStatusIcon(record, { now: 1000 }), '🟢');

  record.lastAcknowledgedReadyAt = 200;
  assert.equal(terminalStatusIcon(record, { now: 1000 }), '🟨');
});

test('a manual attention marker turns an idle session green', () => {
  const record = {
    status: 'idle',
    manuallyNeedsAttention: true,
    lastAgentActivityAt: 1,
  };
  assert.equal(terminalStatusIcon(record, { now: 10 * HOUR }), '🟢');
  record.manuallyNeedsAttention = false;
  assert.equal(terminalStatusIcon(record, { now: 10 * HOUR }), '🟫');
});

test('agent action states take precedence over idle age', () => {
  const old = { lastAgentActivityAt: 1 };
  assert.equal(terminalStatusIcon({ ...old, status: 'running' }, { now: 10 * HOUR }), '🟡');
  assert.equal(terminalStatusIcon({ ...old, status: 'waiting' }, { now: 10 * HOUR }), '🟠');
  assert.equal(terminalStatusIcon({ ...old, status: 'interrupted' }, { now: 10 * HOUR }), '🔴');
});

test('an interrupted turn stays red only until the user returns to it', () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0);
  const interruptedAt = now - 3 * HOUR;
  const record = {
    status: 'interrupted',
    interruptedAt,
    lastAgentActivityAt: interruptedAt,
    lastFocusedAt: interruptedAt - MINUTE,
  };
  assert.equal(interruptionReference(record), interruptedAt);
  assert.equal(interruptionWasAcknowledged(record), false);
  assert.equal(terminalStatusIcon(record, { now, recentMinutes: 30, oldHours: 4 }), '🔴');

  record.lastFocusedAt = interruptedAt + MINUTE;
  assert.equal(interruptionWasAcknowledged(record), true);
  assert.equal(terminalStatusIcon(record, { now, recentMinutes: 30, oldHours: 4 }), '🟧');
});

test('legacy interrupted records use agent activity as their event timestamp', () => {
  const record = {
    status: 'interrupted',
    lastAgentActivityAt: 100,
    lastFocusedAt: 200,
  };
  assert.equal(interruptionReference(record), 100);
  assert.equal(interruptionWasAcknowledged(record), true);
  assert.notEqual(terminalStatusIcon(record, { now: 1000 }), '🔴');
});

test('detects a new completed turn even when polling only observes done to done', () => {
  const record = { status: 'done', readyAt: 100, lastAgentActivityAt: 200 };
  assert.equal(isNewReadyEvent(record, { status: 'done', lastActivityAt: 201 }), true);
  assert.equal(isNewReadyEvent(record, { status: 'done', lastActivityAt: 200 }), false);
  assert.equal(isNewReadyEvent(record, { status: 'running', lastActivityAt: 300 }), false);
});

test('a regular terminal command is newer than old agent activity', () => {
  const now = Date.UTC(2026, 6, 13, 23, 0, 0);
  const record = {
    status: 'idle',
    lastAgentActivityAt: now - 5 * 24 * HOUR,
    lastTerminalActivityAt: now - 2 * MINUTE,
    lastTerminalActivitySource: 'input',
  };
  assert.equal(terminalStatusIcon(record, { now, recentMinutes: 30, oldHours: 4 }), '🟨');
});

test('restore redraw does not make an old live agent session recent', () => {
  const now = Date.UTC(2026, 6, 13, 23, 0, 0);
  const record = {
    status: 'done',
    activeAgent: { type: 'claude' },
    readyAt: now - 5 * 24 * HOUR,
    lastAcknowledgedReadyAt: now,
    lastAgentActivityAt: now - 5 * 24 * HOUR,
    lastTerminalActivityAt: now - MINUTE,
    lastTerminalActivitySource: 'output',
  };
  assert.equal(terminalStatusIcon(record, { now, recentMinutes: 30, oldHours: 4 }), '🟫');
});

test('focusing an old agent tab does not make its semantic activity recent', () => {
  const now = Date.UTC(2026, 6, 13, 23, 0, 0);
  const record = {
    status: 'idle',
    lastAgentActivityAt: now - 5 * 24 * HOUR,
    lastFocusedAt: now,
  };
  assert.equal(terminalStatusIcon(record, { now, recentMinutes: 30, oldHours: 4 }), '🟫');
});
