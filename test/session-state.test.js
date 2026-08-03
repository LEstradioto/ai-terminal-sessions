'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SessionStateStore, normalizeStatePayload, statePayload } = require('../session-state');

class MemoryState {
  constructor(delay = () => 0) {
    this.values = new Map();
    this.delay = delay;
    this.writes = [];
  }

  get(key) { return this.values.get(key); }

  async update(key, value) {
    await new Promise((resolve) => setTimeout(resolve, this.delay(value)));
    this.values.set(key, value);
    this.writes.push(value && value.revision);
  }
}

function record(title = 'First') {
  return {
    id: '08c20d2c-2387-4c32-9382-8cf6f42474bd',
    tmuxSession: 'vsc-demo-123abc',
    cwd: '/tmp/demo',
    manualTitle: title,
    iconPreset: 'debug',
    lastTerminalActivityAt: 123,
    lastTerminalActivitySource: 'input',
    interruptedAt: 100,
    lastAcknowledgedInterruptedAt: 90,
    status: 'done',
    readyAt: 1700,
    turnStartedAt: 1000,
    turnCompletedAt: 1500,
    turnDurationMs: 500,
    windows: [{ panes: [{
      cwd: '/tmp/demo',
      lastTerminalActivityAt: 120,
      lastTerminalActivitySource: 'input',
      startCommand: 'secret --token value',
      agent: {
        type: 'codex',
        sessionId: '9c0ffbf3-5cfd-40fd-a860-2b54ad18d035',
        active: true,
        status: 'done',
        readyAt: 1700,
        turnStartedAt: 1000,
        turnCompletedAt: 1500,
        turnDurationMs: 500,
        pid: 123,
        transcript: '/Users/private/.codex/session.jsonl',
      },
    }] }],
  };
}

test('state schema rejects incompatible payloads and removes volatile private fields', () => {
  assert.equal(normalizeStatePayload({ version: 99, records: [] }, 'workspace'), undefined);
  const payload = statePayload('workspace', [record()], 3, 10);
  const pane = payload.records[0].windows[0].panes[0];
  assert.equal(pane.startCommand, undefined);
  assert.equal(pane.lastTerminalActivityAt, 120);
  assert.equal(pane.lastTerminalActivitySource, 'input');
  assert.equal(pane.agent.pid, undefined);
  assert.equal(pane.agent.transcript, undefined);
  assert.equal(pane.agent.turnDurationMs, 500);
  assert.equal(payload.records[0].lastTerminalActivitySource, 'input');
  assert.equal(payload.records[0].iconPreset, 'debug');
  assert.equal(payload.records[0].iconMode, 'manual');
  assert.equal(payload.records[0].interruptedAt, 100);
  assert.equal(payload.records[0].lastAcknowledgedInterruptedAt, 90);
  assert.equal(payload.records[0].readyAt, 1500);
  assert.equal(pane.agent.readyAt, 1500);
  assert.equal(payload.records[0].turnStartedAt, 1000);
  assert.equal(payload.records[0].turnCompletedAt, 1500);
  assert.equal(payload.records[0].turnDurationMs, 500);
});

test('repairs scan-time ready timestamps using the real turn completion', () => {
  const value = record();
  value.lastAcknowledgedReadyAt = 1550;
  const normalized = statePayload('workspace', [value]).records[0];
  assert.equal(normalized.readyAt, 1500);
  assert.ok(normalized.lastAcknowledgedReadyAt >= normalized.readyAt);
});

test('state falls back safely when an icon preset is unknown', () => {
  const value = record();
  value.iconPreset = 'user-supplied-icon';
  assert.equal(statePayload('workspace', [value]).records[0].iconPreset, 'terminal');
  assert.equal(statePayload('workspace', [value]).records[0].iconMode, 'auto');
});

test('state writes are serialized so the latest revision wins', async () => {
  const workspaceState = new MemoryState((value) => value && value.revision === 1 ? 20 : 0);
  const globalState = new MemoryState((value) => value && value.revision === 1 ? 20 : 0);
  const store = new SessionStateStore({
    workspaceState,
    globalState,
    stateKey: 'state',
    backupKey: 'backup',
    workspaceKey: 'workspace',
  });
  const first = store.save([record('First')], 1);
  const second = store.save([record('Latest')], 2);
  await Promise.all([first, second]);
  assert.deepEqual(workspaceState.writes, [1, 2]);
  assert.equal(store.load().records[0].manualTitle, 'Latest');
});
