'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
const ptySource = fs.readFileSync(path.join(__dirname, '..', 'tmux-pty.js'), 'utf8');
const tmuxSource = fs.readFileSync(path.join(__dirname, '..', 'tmux.js'), 'utf8');

test('restore targets the main window and recovers stranded auxiliary editors', () => {
  const start = source.indexOf('async restoreTabs(force)');
  const end = source.indexOf('\n  handleOpenTerminal(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const restoreTabs = source.slice(start, end);
  assert.match(restoreTabs, /this\.workbench\.restoreEditorsToMainWindow\(\)/);
  assert.match(restoreTabs, /this\.workbench\.switchToMainWindow\(\)/);
  assert.match(restoreTabs, /sortRecordsForRestore\(this\.records\.values\(\)\)/);
  assert.match(restoreTabs, /this\.disposeManagedTerminal\(record, terminal, 'keep'\)/);
  assert.match(restoreTabs, /if \(!force\) await delay\(1200\)/);
  assert.match(restoreTabs, /lastTerminal\.show\(false\)/);
  assert.match(restoreTabs, /waitFor\(\(\) => pty\.bridgeReady\(\), 1800, 25\)/);
  assert.match(restoreTabs, /if \(ready\) await pty\.replayVisiblePane\(\)/);
  assert.match(restoreTabs, /vscode\.window\.activeTerminal === lastTerminal/);
  assert.match(restoreTabs, /this\.closeDuplicateManagedTerminalTabs\(liveEditorTabs, records\)/);
  assert.match(restoreTabs, /preferredTerminal\.show\(false\)/);
  assert.ok(restoreTabs.indexOf('await this.tmux.ensureSession(record)') < restoreTabs.indexOf('this.openRecord(record, true)'));
});

test('Session Monitor uses a native panel view and removes legacy floating panels', () => {
  const providerStart = source.indexOf('registerWebviewViewProvider(MONITOR_VIEW_ID');
  const providerEnd = source.indexOf('registerWebviewPanelSerializer(', providerStart);
  const serializerStart = source.indexOf('registerWebviewPanelSerializer(LEGACY_MONITOR_VIEW_TYPE');
  const serializerEnd = source.indexOf('vscode.window.onDidOpenTerminal', serializerStart);
  const migrationStart = source.indexOf('  async disposeLegacyMonitor(');
  const migrationEnd = source.indexOf('\n  async loadState()', migrationStart);
  assert.notEqual(providerStart, -1);
  assert.notEqual(providerEnd, -1);
  assert.notEqual(serializerStart, -1);
  assert.notEqual(serializerEnd, -1);
  assert.notEqual(migrationStart, -1);
  assert.notEqual(migrationEnd, -1);

  const provider = source.slice(providerStart, providerEnd);
  const serializer = source.slice(serializerStart, serializerEnd);
  const migration = source.slice(migrationStart, migrationEnd);
  assert.match(provider, /this\.monitor\.resolve\(view\)/);
  assert.match(provider, /retainContextWhenHidden: true/);
  assert.match(serializer, /this\.disposeLegacyMonitor\(panel\)/);
  assert.match(migration, /panel\.dispose\(\)/);
  assert.match(migration, /this\.workbench\.switchToMainWindow\(\)/);
});

test('manual restore leaves the native monitor panel out of editor recovery', () => {
  const start = source.indexOf('  async restoreTabsImpl(');
  const end = source.indexOf('\n  async showSessionHistory(', start);
  const restore = source.slice(start, end);
  const recoveryStart = restore.indexOf('if (recoverAuxiliaryEditors)');
  const recoveryEnd = restore.indexOf('if (force && !this.records.size)', recoveryStart);
  const recovery = restore.slice(recoveryStart, recoveryEnd);
  assert.match(restore, /force && this\.hasSuspiciousTerminalEditors\(\)/);
  assert.match(restore, /if \(recoverAuxiliaryEditors\)/);
  assert.match(recovery, /this\.workbench\.restoreEditorsToMainWindow\(\)/);
  assert.match(recovery, /this\.workbench\.switchToMainWindow\(\)/);
  assert.equal((restore.match(/this\.workbench\.switchToMainWindow\(\)/g) || []).length, 1);
  assert.doesNotMatch(restore, /monitorPanel|monitorFloating|floatMonitorPanel/);
});

test('terminal replacement is safe when the close event arrives late', () => {
  const disposeStart = source.indexOf('  disposeManagedTerminal(');
  const closeStart = source.indexOf('  async handleCloseTerminal(', disposeStart);
  const closeEnd = source.indexOf('\n  recordForTerminal(', closeStart);
  assert.notEqual(disposeStart, -1);
  assert.notEqual(closeStart, -1);
  assert.notEqual(closeEnd, -1);

  const dispose = source.slice(disposeStart, closeStart);
  const close = source.slice(closeStart, closeEnd);
  assert.match(dispose, /pendingCloseActions\.set\(terminal, action\)/);
  assert.match(dispose, /this\.terminals\.get\(record\.id\) === terminal/);
  assert.match(dispose, /this\.ptys\.get\(record\.id\) === pty/);
  assert.match(close, /this\.terminals\.get\(record\.id\) === terminal/);
  assert.match(close, /this\.ptys\.get\(record\.id\) === pty/);
  assert.match(close, /pendingCloseActions\.get\(terminal\)/);
});

test('changing an icon replaces only the terminal bridge and replays its pane', () => {
  const start = source.indexOf('  async reopenTerminalAppearance(record)');
  const end = source.indexOf('\n  async renameActiveWithAI()', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const appearance = source.slice(start, end);
  assert.match(appearance, /this\.disposeManagedTerminal\(record, terminal, 'keep'\)/);
  assert.match(appearance, /await this\.tmux\.ensureSession\(record\)/);
  assert.match(appearance, /this\.openRecord\(record, true\)/);
  assert.match(appearance, /waitFor\(\(\) => pty\.bridgeReady\(\), 1800, 25\)/);
  assert.match(appearance, /await pty\.replayVisiblePane\(\)/);
});

test('automatic icon detection defers visual replacement until a safe recreation', () => {
  assert.doesNotMatch(source, /ensureAutomaticTerminalAppearance|appearanceRefreshes/);
  const start = source.indexOf('  async scanRecord(');
  const end = source.indexOf('\n  updateAutomaticTitle(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const scan = source.slice(start, end);
  assert.match(scan, /record\.detectedIconPreset = detectedIconPreset/);
  assert.match(scan, /record\.iconPreset = detectedIconPreset/);
  assert.doesNotMatch(scan, /reopenTerminalAppearance/);
});

test('terminal close restores focus to the editor VS Code selected', () => {
  const eventStart = source.indexOf('vscode.window.onDidCloseTerminal((terminal) =>');
  const eventEnd = source.indexOf('vscode.window.tabGroups.onDidChangeTabs', eventStart);
  const event = source.slice(eventStart, eventEnd);
  const focusStart = source.indexOf('  async focusAfterTerminalClose(');
  const focusEnd = source.indexOf('\n  recordForTerminal(', focusStart);
  const focus = source.slice(focusStart, focusEnd);
  assert.match(event, /pendingAction !== 'keep'/);
  assert.match(event, /this\.focusAfterTerminalClose\(terminal\)/);
  assert.match(focus, /workbench\.action\.focusActiveEditorGroup/);
});

test('manual restore recovers live tmux sessions from the latest saved snapshot', () => {
  const recoverStart = source.indexOf('  async recoverLatestLiveHistorySnapshot(');
  const restoreStart = source.indexOf('  async restoreTabsImpl(', recoverStart);
  const restoreEnd = source.indexOf('\n  async showSessionHistory(', restoreStart);
  assert.notEqual(recoverStart, -1);
  assert.notEqual(restoreStart, -1);
  assert.notEqual(restoreEnd, -1);

  const recover = source.slice(recoverStart, restoreStart);
  const restore = source.slice(restoreStart, restoreEnd);
  assert.match(recover, /this\.sessionHistory/);
  assert.match(recover, /'list-sessions', '-F', '#\{session_name\}'/);
  assert.match(recover, /liveSessions\.has\(raw\.tmuxSession\)/);
  assert.match(recover, /normalizeSessionRecord\(raw, this\.workspaceKey\)/);
  assert.match(recover, /this\.persist\('live-history-recovery'\)/);
  assert.match(restore, /if \(force && !this\.records\.size\) await this\.recoverLatestLiveHistorySnapshot\(\)/);
});

test('private tmux sessions route wheel scrolling by pane harness', () => {
  const start = tmuxSource.indexOf('  async configureTmuxSession(');
  const end = tmuxSource.indexOf('\n  async configurePanePresentation(', start);
  const configure = tmuxSource.slice(start, end);
  assert.match(configure, /'mouse', 'on'/);
  assert.match(configure, /'WheelUpPane',[\s\S]*?@ai-pane-wheel-mode[\s\S]*?'send-keys -M', 'copy-mode -e -t ='/);
  assert.doesNotMatch(configure, /'mouse', 'off'/);

  const presentationStart = tmuxSource.indexOf('  async configurePanePresentation(');
  const presentationEnd = tmuxSource.indexOf('\n  async resizeSession(', presentationStart);
  const presentation = tmuxSource.slice(presentationStart, presentationEnd);
  assert.match(presentation, /'@ai-pane-agent'/);
  assert.match(presentation, /pane\.agent && pane\.agent\.active !== false && pane\.agent\.type === 'claude'/);

  const ensureStart = tmuxSource.indexOf('  async ensureSessionImpl(');
  const ensureEnd = tmuxSource.indexOf('\n  async tmuxHasSession(', ensureStart);
  const ensure = tmuxSource.slice(ensureStart, ensureEnd);
  assert.match(ensure, /if \(alive\) await this\.configurePanePresentation\(record\)/);
});

test('tmux click and drag copies text and immediately returns to live output', () => {
  const start = tmuxSource.indexOf('  async configureTmuxSession(');
  const end = tmuxSource.indexOf('\n  async configurePanePresentation(', start);
  const configure = tmuxSource.slice(start, end);
  assert.match(configure, /'copy-command', copyCommand/);
  assert.match(configure, /'MouseDrag1Pane', 'copy-mode', '-M', '-t', '='/);
  assert.match(configure, /'DoubleClick1Pane',[\s\S]*?'select-word',[\s\S]*?'copy-pipe-and-cancel'/);
  assert.match(configure, /'MouseDragEnd1Pane',[\s\S]*?'copy-pipe-and-cancel'/);
  assert.doesNotMatch(configure, /M-MouseDrag1Pane|copy-pipe-no-clear/);
  assert.match(configure, /'copy-mode', 'v', 'send-keys', '-X', 'begin-selection'/);
  assert.match(configure, /'copy-mode', 'y', 'send-keys', '-X', 'copy-pipe-and-cancel'/);
});

test('new tmux panes receive a larger scrollback history before creation', () => {
  assert.match(tmuxSource, /const DEFAULT_TMUX_HISTORY_LIMIT = 20000;/);
  const restoreStart = tmuxSource.indexOf('  async restoreTmuxSession(');
  const restoreEnd = tmuxSource.indexOf('\n  restoreCommand(', restoreStart);
  const restore = tmuxSource.slice(restoreStart, restoreEnd);
  assert.ok(
    restore.indexOf("'set-option', '-g', 'history-limit'")
      < restore.indexOf("'new-session', '-d'"),
  );
});

test('cold restore rebuilds every saved pane, layout, and focused pane', () => {
  const start = tmuxSource.indexOf('  async restoreTmuxSession(');
  const end = tmuxSource.indexOf('\n  restoredPaneRuntime(', start);
  const restore = tmuxSource.slice(start, end);
  assert.match(restore, /const savedPanes = \[\.\.\.savedWindow\.panes\]/);
  assert.match(restore, /for \(const pane of savedPanes\.slice\(1\)\)/);
  assert.match(restore, /'split-window', '-d', '-P', '-F', '#\{pane_id\}'/);
  assert.match(restore, /this\.restoreCommand\(pane\.agent\)/);
  assert.match(restore, /'select-layout'/);
  assert.match(restore, /'select-pane', '-t', activePane\.id/);
  assert.match(restore, /record\.activePaneId = activePane\.logicalId/);
});

test('configures each tmux session with one client invocation', () => {
  const configureStart = tmuxSource.indexOf('  async configureTmuxSession(');
  const configureEnd = tmuxSource.indexOf('\n  async configurePanePresentation(', configureStart);
  const configure = tmuxSource.slice(configureStart, configureEnd);
  assert.equal((configure.match(/await this\.runTmux\(/g) || []).length, 1);
  assert.match(configure, /'terminal-features\[100\]'/);
  assert.match(configure, /'automatic-rename', 'off'/);
  assert.match(configure, /'prefix', 'C-b'/);
  assert.match(configure, /'MouseDown3Pane'/);
});

test('managed terminals expose keyboard paging through tmux copy mode', () => {
  const start = source.indexOf('  async scrollActive(direction)');
  const end = source.indexOf('\n  async renameActive()', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const scroll = source.slice(start, end);
  assert.match(scroll, /'copy-mode', '-u', '-t', target/);
  assert.match(scroll, /'send-keys', '-X', '-t', target, 'page-down-and-cancel'/);
});

test('copy mode exposes a visible jump back to live output', () => {
  assert.match(source, /#\{pane_in_mode\}\\t#\{pane_mode\}\\t#\{scroll_position\}/);
  assert.match(source, /item\.text = '\$\(arrow-down\) Jump to bottom'/);
  const start = source.indexOf('  async jumpActiveToBottom()');
  const end = source.indexOf('\n  async showPaneActions()', start);
  const jump = source.slice(start, end);
  assert.match(jump, /'history-bottom'/);
  assert.match(jump, /'cancel'/);
});

test('session history restores one archived tab and isolates bulk snapshot recovery', () => {
  const restoreStart = source.indexOf('  async restoreArchivedSession(entry)');
  const restoreEnd = source.indexOf('\n  historyQuickPickItems()', restoreStart);
  const snapshotStart = source.indexOf('  async showSnapshotHistory()');
  const snapshotEnd = source.indexOf('\n  async clearRecoveryData()', snapshotStart);
  assert.notEqual(restoreStart, -1);
  assert.notEqual(restoreEnd, -1);
  assert.notEqual(snapshotStart, -1);
  assert.notEqual(snapshotEnd, -1);
  const restore = source.slice(restoreStart, restoreEnd);
  const snapshots = source.slice(snapshotStart, snapshotEnd);
  assert.match(restore, /this\.records\.set\(record\.id, record\)/);
  assert.match(restore, /agent: \{ \.\.\.pane\.agent, active: true \}/);
  assert.match(restore, /activeAgent: \{ type: resumeAgent\.type, sessionId: resumeAgent\.sessionId \}/);
  assert.doesNotMatch(restore, /restoreTabs/);
  assert.match(snapshots, /\{ modal: true \}/);
  assert.match(snapshots, /Restore \$\{picked\.missing\.length\} tabs/);
});

test('explicit close archives the session before tmux termination', () => {
  const start = source.indexOf('  async applyCloseAction(record, action)');
  const end = source.indexOf('\n  async attachExisting()', start);
  const close = source.slice(start, end);
  assert.ok(close.indexOf('await this.archiveSession(record, action)')
    < close.indexOf('await this.tmux.killTmuxSession(record.tmuxSession)'));
});

test('workspace relocation suspends restore state only after every tmux session stops', () => {
  const prepareStart = source.indexOf('  async prepareWorkspaceMove()');
  const prepareEnd = source.indexOf('\n  async importWorkspaceMove()', prepareStart);
  const prepare = source.slice(prepareStart, prepareEnd);
  assert.ok(prepare.indexOf('await this.writeRelocationBundle(bundle)')
    < prepare.indexOf('await this.tmux.killTmuxSession(record.tmuxSession)'));
  assert.ok(prepare.indexOf('if (failures.length)') < prepare.indexOf('this.records.clear()'));
  assert.doesNotMatch(prepare, /this\.drafts\.clear\(\)/);
  assert.doesNotMatch(prepare, /this\.sessionHistory = \[\]/);

  const importStart = source.indexOf('  async importWorkspaceMove()');
  const importEnd = source.indexOf('\n  async writeRelocationBundle(', importStart);
  const imported = source.slice(importStart, importEnd);
  assert.ok(imported.indexOf('await this.restoreTabs(true)')
    < imported.indexOf('fs.promises.unlink(picked.file)'));
});

test('commands resolve a managed terminal from the active editor tab', () => {
  const start = source.indexOf('  activeRecord()');
  const end = source.indexOf('\n  async renameActive()', start);
  const activeRecord = source.slice(start, end);
  assert.match(activeRecord, /activeTab\.input instanceof vscode\.TabInputTerminal/);
  assert.match(activeRecord, /recordIdsForTabLabels\(\[activeTab\.label\], terminals\)/);
});
