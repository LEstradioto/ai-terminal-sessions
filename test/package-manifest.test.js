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

test('keeps common commands within two selections and advanced commands contextual', () => {
  const hidden = new Set(manifest.contributes.menus.commandPalette
    .filter((item) => item.when === 'false')
    .map((item) => item.command));
  const visible = manifest.contributes.commands
    .map((item) => item.command)
    .filter((command) => !hidden.has(command));
  assert.deepEqual(visible, [
    'aiTerminalSessions.new',
    'aiTerminalSessions.rename',
    'aiTerminalSessions.renameWithAI',
    'aiTerminalSessions.moreActions',
    'aiTerminalSessions.paneActions',
    'aiTerminalSessions.toggleMonitor',
    'aiTerminalSessions.showSessionHistory',
    'aiTerminalSessions.showSessionSwitcher',
  ]);
});

test('puts active-tab actions directly in the terminal context menu', () => {
  const contextMenu = manifest.contributes.menus['terminal/context'];
  const commands = contextMenu.map((item) => item.command);
  assert.ok(commands.includes('aiTerminalSessions.renameWithAI'));
  assert.ok(commands.includes('aiTerminalSessions.changeIcon'));
  assert.ok(commands.includes('aiTerminalSessions.paneActions'));
  assert.ok(commands.includes('aiTerminalSessions.changePaneRole'));
  assert.ok(!commands.includes('aiTerminalSessions.markHandled'));
  assert.ok(!commands.includes('aiTerminalSessions.markNeedsAttention'));
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
