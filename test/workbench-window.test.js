'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { COMMANDS, WorkbenchWindowAdapter } = require('../workbench-window');

function fakeVscode(commands) {
  const executed = [];
  return {
    executed,
    ViewColumn: { Active: 1 },
    commands: {
      getCommands: async () => commands,
      executeCommand: async (command) => executed.push(command),
    },
  };
}

test('floating monitor degrades without private workbench capabilities', async () => {
  const vscode = fakeVscode([]);
  const adapter = new WorkbenchWindowAdapter(vscode, () => {}, async () => {}, 10);
  assert.equal(await adapter.floatPanel({ active: true }, { alwaysOnTop: true }), false);
  assert.deepEqual(vscode.executed, []);
});

test('floating monitor uses optional capabilities only when available', async () => {
  const vscode = fakeVscode(Object.values(COMMANDS));
  const adapter = new WorkbenchWindowAdapter(
    vscode,
    () => {},
    (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds === 10 ? 10 : 0)),
    10,
  );
  assert.equal(await adapter.floatPanel({ active: true }, { alwaysOnTop: true }), true);
  assert.deepEqual(vscode.executed, [
    COMMANDS.float, COMMANDS.compact, COMMANDS.top, COMMANDS.main,
  ]);
});

test('hides a floating monitor without destroying its auxiliary window', async () => {
  const vscode = fakeVscode(Object.values(COMMANDS));
  const panel = {
    active: false,
    reveal() { this.active = true; },
  };
  const adapter = new WorkbenchWindowAdapter(vscode, () => {}, async () => {}, 10);
  assert.equal(await adapter.hidePanel(panel), true);
  assert.deepEqual(vscode.executed, [COMMANDS.untop, COMMANDS.main]);
});

test('shows the same floating monitor and restores always-on-top', async () => {
  const vscode = fakeVscode(Object.values(COMMANDS));
  const panel = {
    active: false,
    reveal() { this.active = true; },
  };
  const adapter = new WorkbenchWindowAdapter(vscode, () => {}, async () => {}, 10);
  assert.equal(await adapter.showPanel(panel, { alwaysOnTop: true }), true);
  assert.deepEqual(vscode.executed, [COMMANDS.top, COMMANDS.main]);
});
