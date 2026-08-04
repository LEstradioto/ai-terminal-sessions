'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

class FakeVscodeRuntime {
  constructor() {
    this.QuickPickItemKind = { Separator: -1 };
  }
}

function loadSessionManager(vscode) {
  const originalLoad = Module._load;
  Module._load = function loadWithFakeVscode(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require('../extension').SessionManager;
  } finally {
    Module._load = originalLoad;
  }
}

test('status-bar session switcher renders the active turn duration', () => {
  const now = 1_000_000;
  const SessionManager = loadSessionManager(new FakeVscodeRuntime());
  const manager = Object.create(SessionManager.prototype);
  manager.records = new Map([['build', {
    createdAt: now - 120_000,
    lastAgentActivityAt: now,
    manualTitle: 'build',
    status: 'running',
    turnStartedAt: now - 65_000,
    windows: [{
      active: true,
      panes: [{ active: true, agent: { process: 'codex', status: 'running' } }],
    }],
  }]]);

  const items = manager.sessionSwitcherItems(now);

  assert.equal(items[0].label, 'Working');
  assert.equal(items[1].description, 'WORKING · codex · TURN 1M 05S · NOW');
});

test('status bar keeps the active and last turn duration visible', () => {
  const now = Date.now();
  const SessionManager = loadSessionManager(new FakeVscodeRuntime());
  const manager = Object.create(SessionManager.prototype);
  const agent = { process: 'codex', status: 'running' };
  const record = {
    createdAt: now - 120_000,
    lastAgentActivityAt: now,
    status: 'running',
    turnStartedAt: now - 65_000,
    windows: [{ active: true, panes: [{ active: true, agent }] }],
  };
  manager.records = new Map([['build', record]]);
  manager.sessionStatusBar = {};
  manager.activeRecord = () => record;
  manager.currentSessionHealth = () => ({
    connected: 1, expected: 1, extra: 0, healthy: true, missing: 0, visible: 1,
  });
  manager.updateCopyModeStatusBar = () => {};

  manager.updateSessionStatusBar();
  assert.equal(
    manager.sessionStatusBar.text,
    '$(sync~spin) 1 · $(terminal) 1 · $(watch) 1M 05S',
  );

  agent.status = 'done';
  agent.readyAt = now;
  record.status = 'done';
  record.readyAt = now;
  record.turnCompletedAt = now;
  record.turnDurationMs = 65_000;
  manager.updateSessionStatusBar();
  assert.equal(
    manager.sessionStatusBar.text,
    '$(bell-dot) 1 · $(terminal) 1 · $(watch) 1M 05S',
  );
  assert.match(manager.sessionStatusBar.tooltip, /Last turn: 1M 05S/);
});
