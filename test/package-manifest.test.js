'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const manifest = require('../package.json');

test('activates eagerly so managed tabs can restore during workbench startup', () => {
  assert.deepEqual(manifest.activationEvents, ['*']);
});

const PUBLIC_SETTINGS = [
  'aiTerminalSessions.restoreAgents',
  'aiTerminalSessions.defaultLocation',
  'aiTerminalSessions.renameProvider',
  'aiTerminalSessions.draftRecovery',
  'aiTerminalSessions.notifyWhenReady',
  'aiTerminalSessions.closeBehavior',
  'aiTerminalSessions.executables',
];

test('keeps the public configuration focused on workflow decisions', () => {
  const settings = manifest.contributes.configuration.properties;
  assert.deepEqual(Object.keys(settings), PUBLIC_SETTINGS);
  assert.equal(new Set(Object.values(settings).map((setting) => setting.order)).size, PUBLIC_SETTINGS.length);
  assert.deepEqual(settings['aiTerminalSessions.executables'].default, {
    tmux: 'tmux',
    codex: 'codex',
    claude: 'claude',
  });
});

test('contributes the Session Monitor as a bottom panel view', () => {
  const container = manifest.contributes.viewsContainers.panel.find(
    (item) => item.id === 'aiTerminalSessionsPanel',
  );
  const view = manifest.contributes.views.aiTerminalSessionsPanel.find(
    (item) => item.id === 'aiTerminalSessions.sessionMonitor',
  );
  assert.equal(container.title, 'Session Monitor');
  assert.equal(container.icon, 'media/panel-icon.svg');
  assert.equal(view.type, 'webview');
});

test('keeps the Command Palette focused and exposes fast AI rename', () => {
  const hidden = new Set(manifest.contributes.menus.commandPalette
    .filter((item) => item.when === 'false')
    .map((item) => item.command));
  const visible = manifest.contributes.commands
    .map((item) => item.command)
    .filter((command) => !hidden.has(command));
  assert.deepEqual(visible, [
    'aiTerminalSessions.new',
    'aiTerminalSessions.renameWithAI',
    'aiTerminalSessions.customizeActive',
    'aiTerminalSessions.moreActions',
    'aiTerminalSessions.toggleMonitor',
    'aiTerminalSessions.showSessionHistory',
  ]);
});

test('keeps attention controls contextual and out of the Command Palette', () => {
  const contextMenu = manifest.contributes.menus['terminal/context'];
  const handled = contextMenu.find((item) => item.command === 'aiTerminalSessions.markHandled');
  const needed = contextMenu.find((item) => item.command === 'aiTerminalSessions.markNeedsAttention');
  assert.match(handled.when, /activeNeedsAttention/);
  assert.match(needed.when, /!aiTerminalSessions\.activeNeedsAttention/);

  const hidden = manifest.contributes.menus.commandPalette
    .filter((item) => item.when === 'false')
    .map((item) => item.command);
  assert.ok(hidden.includes('aiTerminalSessions.markHandled'));
  assert.ok(hidden.includes('aiTerminalSessions.markNeedsAttention'));
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
