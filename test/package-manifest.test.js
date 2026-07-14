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
