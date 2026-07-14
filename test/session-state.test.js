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
    lastTerminalActivityAt: 123,
    lastTerminalActivitySource: 'input',
    windows: [{ panes: [{
      cwd: '/tmp/demo',
      startCommand: 'secret --token value',
      agent: {
        type: 'codex',
        sessionId: '9c0ffbf3-5cfd-40fd-a860-2b54ad18d035',
        active: true,
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
  assert.equal(pane.agent.pid, undefined);
  assert.equal(pane.agent.transcript, undefined);
  assert.equal(payload.records[0].lastTerminalActivitySource, 'input');
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
