'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

test('an active terminal is not auto-acknowledged in the same scan that becomes ready', () => {
  const start = source.indexOf('async scanRecord(');
  const end = source.indexOf('\n  async detectAgent(', start);
  const scanRecord = source.slice(start, end);
  assert.doesNotMatch(scanRecord, /terminal === vscode\.window\.activeTerminal/);
  assert.doesNotMatch(scanRecord, /acknowledgeReady\(record\)/);
});

test('the first actual terminal interaction acknowledges a ready response', () => {
  const start = source.indexOf('  handleInput(data) {');
  const end = source.indexOf('\n  setDimensions(', start);
  const handleInput = source.slice(start, end);
  assert.match(handleInput, /acknowledgeReady\(this\.record\)/);
  assert.match(handleInput, /schedulePersist\(\)/);
});

test('restore-driven focus changes do not acknowledge or rejuvenate sessions', () => {
  const start = source.indexOf('vscode.window.onDidChangeActiveTerminal');
  const end = source.indexOf('\n    }));', start);
  const listener = source.slice(start, end);
  assert.match(listener, /if \(!record \|\| this\.restoringTabs\) return/);
  assert.ok(listener.indexOf('this.restoringTabs') < listener.indexOf('record.lastFocusedAt'));
  assert.ok(listener.indexOf('this.restoringTabs') < listener.indexOf('this.acknowledgeReady(record)'));
});
