'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { analyzeTerminalInput } = require('../terminal-input');

test('Enter outside a paste submits the composer', () => {
  assert.equal(analyzeTerminalInput('hello\r').submitted, true);
});

test('multiline bracketed paste remains recoverable until a real Enter', () => {
  const start = analyzeTerminalInput('\x1b[200~first\nsecond');
  assert.deepEqual(start, { editing: true, pasteActive: true, submitted: false });
  const end = analyzeTerminalInput('third\n\x1b[201~', start.pasteActive);
  assert.deepEqual(end, { editing: true, pasteActive: false, submitted: false });
  assert.equal(analyzeTerminalInput('\r', end.pasteActive).submitted, true);
});
