'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { commandExecutable, matchesExecutable } = require('../agents');

test('detects an executable from argv when macOS truncates the comm column', () => {
  const processInfo = {
    comm: '/Users/example/de',
    command: '/Users/example/demo/bin/codex resume 11111111-1111-4111-8111-111111111111',
  };
  assert.equal(matchesExecutable(processInfo, 'codex'), true);
});

test('parses quoted executable paths and native codex binary suffixes', () => {
  assert.equal(commandExecutable("'/path with spaces/claude' --resume id"), '/path with spaces/claude');
  assert.equal(matchesExecutable({ comm: 'codex-aarch64-apple-darwin' }, 'codex'), true);
});
