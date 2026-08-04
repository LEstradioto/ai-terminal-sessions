'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { mergeObservedAgent } = require('../session-presentation');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
const ptySource = fs.readFileSync(path.join(__dirname, '..', 'tmux-pty.js'), 'utf8');

test('an active terminal is not auto-acknowledged in the same scan that becomes ready', () => {
  const start = source.indexOf('async scanRecord(');
  const end = source.indexOf('\n  updateAutomaticTitle(', start);
  const scanRecord = source.slice(start, end);
  assert.doesNotMatch(scanRecord, /terminal === vscode\.window\.activeTerminal/);
  assert.doesNotMatch(scanRecord, /acknowledgeReady\(record\)/);
});

test('only a submitted terminal message acknowledges pending attention', () => {
  const start = ptySource.indexOf('  handleInput(data) {');
  const end = ptySource.indexOf('\n  setDimensions(', start);
  const handleInput = ptySource.slice(start, end);
  const submitted = handleInput.indexOf('if (input.submitted)');
  const acknowledge = handleInput.indexOf('acknowledgeSubmittedInput(this.record)');
  assert.ok(submitted >= 0);
  assert.ok(acknowledge > submitted);
  const acknowledgeStart = source.indexOf('  async acknowledgeSubmittedInput(record)');
  const acknowledgeEnd = source.indexOf('\n  refreshPtyName(', acknowledgeStart);
  const acknowledgeSubmitted = source.slice(acknowledgeStart, acknowledgeEnd);
  assert.match(acknowledgeSubmitted, /acknowledgeAttention\(record, pane\)/);
  assert.match(acknowledgeSubmitted, /noteTerminalActivity\(record, 'input', true, pane\)/);
});

test('focus changes acknowledge interruptions but not completed answers', () => {
  const start = source.indexOf('vscode.window.onDidChangeActiveTerminal');
  const end = source.indexOf('\n    }));', start);
  const listener = source.slice(start, end);
  assert.match(listener, /if \(!record \|\| this\.restoringTabs\) return/);
  assert.ok(listener.indexOf('this.restoringTabs') < listener.indexOf('record.lastFocusedAt'));
  assert.match(listener, /acknowledgeInterrupted\(record\)/);
  assert.doesNotMatch(listener, /acknowledgeAttention\(record\)/);
});

test('a repeated interrupted transcript event becomes idle after acknowledgement', () => {
  const previous = {
    type: 'codex',
    sessionId: 'session-1',
    status: 'interrupted',
    lastActivityAt: 100,
    interruptedAt: 100,
    lastAcknowledgedInterruptedAt: 100,
  };
  const observed = { ...previous, lastAcknowledgedInterruptedAt: undefined };
  assert.equal(mergeObservedAgent(previous, observed, 200).status, 'idle');
});
