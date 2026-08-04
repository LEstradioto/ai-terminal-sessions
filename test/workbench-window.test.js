'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { COMMANDS, WorkbenchWindowAdapter } = require('../runtime');

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

test('legacy window migration degrades without private workbench capabilities', async () => {
  const vscode = fakeVscode([]);
  const adapter = new WorkbenchWindowAdapter(vscode, () => {}, async () => {}, 10);
  assert.equal(await adapter.switchToMainWindow(), false);
  assert.equal(await adapter.restoreEditorsToMainWindow(), false);
  assert.deepEqual(vscode.executed, []);
});

test('legacy window migration calls only the two required workbench commands', async () => {
  const vscode = fakeVscode(Object.values(COMMANDS));
  const adapter = new WorkbenchWindowAdapter(
    vscode,
    () => {},
    (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds === 10 ? 10 : 0)),
    10,
  );
  assert.equal(await adapter.restoreEditorsToMainWindow(), true);
  assert.equal(await adapter.switchToMainWindow(), true);
  assert.deepEqual(vscode.executed, [COMMANDS.restore, COMMANDS.main]);
});
