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
