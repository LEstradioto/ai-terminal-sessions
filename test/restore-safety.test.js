'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

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
  assert.ok(restoreTabs.indexOf('await this.ensureSession(record)') < restoreTabs.indexOf('this.openRecord(record, true)'));
});

test('serialized monitor keeps its native auxiliary window bounds', () => {
  const serializerStart = source.indexOf('registerWebviewPanelSerializer(MONITOR_VIEW_TYPE');
  const serializerEnd = source.indexOf('vscode.window.onDidOpenTerminal', serializerStart);
  const restoreStart = source.indexOf('  async restoreSerializedMonitor(');
  const restoreEnd = source.indexOf('\n  async loadState()', restoreStart);
  assert.notEqual(serializerStart, -1);
  assert.notEqual(serializerEnd, -1);
  assert.notEqual(restoreStart, -1);
  assert.notEqual(restoreEnd, -1);

  const serializer = source.slice(serializerStart, serializerEnd);
  const restore = source.slice(restoreStart, restoreEnd);
  assert.match(serializer, /this\.restoreSerializedMonitor\(panel\)/);
  assert.doesNotMatch(serializer, /panel\.dispose\(\)/);
  assert.match(restore, /this\.attachMonitorPanel\(panel\)/);
  assert.match(restore, /this\.workbench\.switchToMainWindow\(\)/);
});

test('healthy manual restore leaves a floating monitor in place', () => {
  const start = source.indexOf('  async restoreTabsImpl(');
  const end = source.indexOf('\n  async showSessionHistory(', start);
  const restore = source.slice(start, end);
  assert.match(restore, /!this\.monitorPanel \|\| this\.hasSuspiciousTerminalEditors\(\)/);
  assert.match(restore, /if \(recoverAuxiliaryEditors\)/);
  assert.match(restore, /kept healthy monitor window in place with saved bounds/);
});

test('monitor toggle preserves the auxiliary window instead of disposing it', () => {
  const toggleStart = source.indexOf('  async toggleMonitor()');
  const toggleEnd = source.indexOf('\n  async openMonitor()', toggleStart);
  const toggle = source.slice(toggleStart, toggleEnd);
  assert.match(toggle, /this\.monitorHidden \? this\.showMonitor\(\) : this\.hideMonitor\(\)/);
  assert.doesNotMatch(toggle, /this\.monitorPanel\.dispose\(\)/);

  const hideStart = source.indexOf('  async hideMonitor()');
  const hideEnd = source.indexOf('\n  async showMonitor()', hideStart);
  const hide = source.slice(hideStart, hideEnd);
  assert.match(hide, /this\.workbench\.hidePanel\(panel\)/);
  assert.match(hide, /this\.setMonitorHidden\(true\)/);
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
  assert.match(appearance, /await this\.ensureSession\(record\)/);
  assert.match(appearance, /this\.openRecord\(record, true\)/);
  assert.match(appearance, /waitFor\(\(\) => pty\.bridgeReady\(\), 1800, 25\)/);
  assert.match(appearance, /await pty\.replayVisiblePane\(\)/);
});

test('automatic icons refresh only for the active terminal after startup', () => {
  const start = source.indexOf('  async ensureAutomaticTerminalAppearance(record)');
  const end = source.indexOf('\n  async reopenTerminalAppearance(record)', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const automatic = source.slice(start, end);
  assert.match(automatic, /!this\.started \|\| this\.restoringTabs/);
  assert.match(automatic, /active\.id !== record\.id/);
  assert.match(automatic, /pty\.iconPreset === normalizeIconPreset\(record\.iconPreset\)/);
  assert.match(automatic, /this\.appearanceRefreshes/);
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

test('private tmux sessions handle mouse wheel scrolling', () => {
  const start = source.indexOf('  async configureTmuxSession(');
  const end = source.indexOf('\n  async configurePanePresentation(', start);
  const configure = source.slice(start, end);
  assert.match(configure, /'mouse', 'on'/);
  assert.doesNotMatch(configure, /'mouse', 'off'/);
});

test('tmux copy mode keeps mouse selection visible and copies it on macOS', () => {
  const start = source.indexOf('  async configureTmuxSession(');
  const end = source.indexOf('\n  async configurePanePresentation(', start);
  const configure = source.slice(start, end);
  assert.match(configure, /'copy-command', '\/usr\/bin\/pbcopy'/);
  assert.match(configure, /'MouseDragEnd1Pane',[\s\S]*?'copy-pipe-no-clear'/);
  assert.match(configure, /'copy-mode', 'v', 'send-keys', '-X', 'begin-selection'/);
  assert.match(configure, /'copy-mode', 'y', 'send-keys', '-X', 'copy-pipe-and-cancel'/);
});

test('new tmux panes receive a larger scrollback history before creation', () => {
  assert.match(source, /const DEFAULT_TMUX_HISTORY_LIMIT = 20000;/);
  const restoreStart = source.indexOf('  async restoreTmuxSession(');
  const restoreEnd = source.indexOf('\n  restoreCommand(', restoreStart);
  const restore = source.slice(restoreStart, restoreEnd);
  assert.ok(
    restore.indexOf("'set-option', '-g', 'history-limit'")
      < restore.indexOf("'new-session', '-d'"),
  );
});

test('cold restore rebuilds every saved pane, layout, and focused pane', () => {
  const start = source.indexOf('  async restoreTmuxSession(');
  const end = source.indexOf('\n  restoredPaneRuntime(', start);
  const restore = source.slice(start, end);
  assert.match(restore, /const savedPanes = \[\.\.\.savedWindow\.panes\]/);
  assert.match(restore, /for \(const pane of savedPanes\.slice\(1\)\)/);
  assert.match(restore, /'split-window', '-d', '-P', '-F', '#\{pane_id\}'/);
  assert.match(restore, /this\.restoreCommand\(pane\.agent\)/);
  assert.match(restore, /'select-layout'/);
  assert.match(restore, /'select-pane', '-t', activePane\.id/);
  assert.match(restore, /record\.activePaneId = activePane\.logicalId/);
});

test('configures each tmux session with one client invocation', () => {
  const configureStart = source.indexOf('  async configureTmuxSession(');
  const configureEnd = source.indexOf('\n  async configurePanePresentation(', configureStart);
  const configure = source.slice(configureStart, configureEnd);
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
    < close.indexOf('await this.killTmuxSession(record.tmuxSession)'));
});

test('workspace relocation suspends restore state only after every tmux session stops', () => {
  const prepareStart = source.indexOf('  async prepareWorkspaceMove()');
  const prepareEnd = source.indexOf('\n  async importWorkspaceMove()', prepareStart);
  const prepare = source.slice(prepareStart, prepareEnd);
  assert.ok(prepare.indexOf('await this.writeRelocationBundle(bundle)')
    < prepare.indexOf('await this.killTmuxSession(record.tmuxSession)'));
  assert.ok(prepare.indexOf('if (failures.length)') < prepare.indexOf('this.records.clear()'));
  assert.doesNotMatch(prepare, /this\.drafts\.clear\(\)/);
  assert.doesNotMatch(prepare, /this\.sessionHistory = \[\]/);

  const importStart = source.indexOf('  async importWorkspaceMove()');
  const importEnd = source.indexOf('\n  async writeRelocationBundle(', importStart);
  const imported = source.slice(importStart, importEnd);
  assert.ok(imported.indexOf('await this.restoreTabs(true)')
    < imported.indexOf('fs.promises.unlink(picked.file)'));
});

test('restored terminals replay a pane snapshot after the live bridge attaches', () => {
  const ptyStart = source.indexOf('class ManagedTmuxPty');
  const ptyEnd = source.indexOf('\n\/\* tmux owns the processes', ptyStart);
  const pty = source.slice(ptyStart, ptyEnd);
  assert.match(pty, /await this\.primeDisplay\(\)/);
  assert.match(pty, /'capture-pane', '-p', '-e'/);
  assert.match(pty, /this\.writeEmitter\.fire\(`\\x1b\[2J\\x1b\[H/);
});

test('commands resolve a managed terminal from the active editor tab', () => {
  const start = source.indexOf('  activeRecord()');
  const end = source.indexOf('\n  async renameActive()', start);
  const activeRecord = source.slice(start, end);
  assert.match(activeRecord, /activeTab\.input instanceof vscode\.TabInputTerminal/);
  assert.match(activeRecord, /recordIdsForTabLabels\(\[activeTab\.label\], terminals\)/);
});
