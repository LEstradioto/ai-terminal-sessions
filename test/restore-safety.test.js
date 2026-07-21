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
  const end = source.indexOf('\n  async resizeSession(', start);
  const configure = source.slice(start, end);
  assert.match(configure, /'mouse', 'on'/);
  assert.doesNotMatch(configure, /'mouse', 'off'/);
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
