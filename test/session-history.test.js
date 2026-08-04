'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  appendSessionSnapshot,
  historyPayload,
  normalizeSessionHistory,
  snapshotRecords,
} = require('../session-recovery');

function record(id, tabOrder, title = id) {
  return {
    id,
    workspaceKey: 'workspace',
    tmuxSession: `tmux-${id}`,
    cwd: '/tmp/project',
    manualTitle: title,
    iconPreset: 'server',
    createdAt: tabOrder + 1,
    tabOrder,
    status: 'running',
    windows: [{
      index: 0,
      name: 'shell',
      active: true,
      panes: [{
        index: 0,
        cwd: '/tmp/project',
        active: true,
        lastTerminalActivityAt: 123,
        lastTerminalActivitySource: 'output',
        agent: { type: 'codex', sessionId: 'session-id', active: true, pid: 999 },
      }],
    }],
  };
}

test('snapshot preserves restore metadata and visual order but drops volatile process data', () => {
  const records = snapshotRecords([record('right', 1), record('left', 0)]);
  assert.deepEqual(records.map((item) => item.id), ['left', 'right']);
  assert.equal(records[0].manualTitle, 'left');
  assert.equal(records[0].iconPreset, 'server');
  assert.equal(records[0].iconMode, 'manual');
  assert.equal(records[0].windows[0].panes[0].agent.sessionId, 'session-id');
  assert.equal(records[0].windows[0].panes[0].agent.pid, undefined);
  assert.equal(records[0].windows[0].panes[0].lastTerminalActivityAt, 123);
  assert.equal(records[0].windows[0].panes[0].lastTerminalActivitySource, 'output');
  assert.equal(records[0].status, undefined);
});

test('history deduplicates normal saves and forces a checkpoint before destructive changes', () => {
  const first = appendSessionSnapshot([], [record('a', 0)], { now: 1000 });
  const duplicate = appendSessionSnapshot(first.history, [record('a', 0)], { now: 2000 });
  const forced = appendSessionSnapshot(duplicate.history, [record('a', 0)], {
    now: 3000,
    force: true,
    reason: 'before-remove',
  });
  assert.equal(first.history.length, 1);
  assert.equal(duplicate.changed, false);
  assert.equal(forced.history.length, 2);
  assert.equal(forced.history[1].reason, 'before-remove');
});

test('history keeps a bounded seven-day rolling window', () => {
  let history = [];
  for (let index = 0; index < 25; index += 1) {
    history = appendSessionSnapshot(history, [record(`s${index}`, index)], {
      now: 10_000 + index,
      maxSnapshots: 20,
      maxAgeMs: 1_000_000,
    }).history;
  }
  assert.equal(history.length, 20);
  assert.equal(history[0].records[0].id, 's5');

  const payload = historyPayload('workspace', history, 20_000);
  assert.equal(normalizeSessionHistory(payload, 'other', { now: 20_000 }).length, 0);
  assert.equal(normalizeSessionHistory(payload, 'workspace', {
    now: 20_000,
    maxAgeMs: 1_000_000,
  }).length, 20);
});
