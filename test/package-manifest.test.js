'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const manifest = require('../package.json');

const PUBLIC_SETTINGS = [
  'aiTerminalSessions.restoreAgents',
  'aiTerminalSessions.defaultLocation',
  'aiTerminalSessions.renameProvider',
  'aiTerminalSessions.draftRecovery',
  'aiTerminalSessions.monitorAlwaysOnTop',
  'aiTerminalSessions.notifyWhenReady',
  'aiTerminalSessions.closeBehavior',
  'aiTerminalSessions.executables',
];

test('keeps the public configuration focused on workflow decisions', () => {
  const settings = manifest.contributes.configuration.properties;
  assert.deepEqual(Object.keys(settings), PUBLIC_SETTINGS);
  assert.deepEqual(settings['aiTerminalSessions.executables'].default, {
    tmux: 'tmux',
    codex: 'codex',
    claude: 'claude',
  });
});

test('binds keyboard paging only inside managed terminals', () => {
  const bindings = manifest.contributes.keybindings;
  const pageUp = bindings.find((binding) => binding.command === 'aiTerminalSessions.scrollPageUp');
  const pageDown = bindings.find((binding) => binding.command === 'aiTerminalSessions.scrollPageDown');
  assert.equal(pageUp.key, 'shift+pageup');
  assert.equal(pageDown.key, 'shift+pagedown');
  assert.equal(pageUp.when, 'terminalFocus && aiTerminalSessions.managedTerminalActive');
  assert.equal(pageDown.when, 'terminalFocus && aiTerminalSessions.managedTerminalActive');
});
