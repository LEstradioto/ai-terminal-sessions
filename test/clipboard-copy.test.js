'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const script = path.join(__dirname, '..', 'copy-nonempty.sh');

function run(input, copyCommand) {
  return childProcess.spawnSync('/bin/sh', [script], {
    input,
    encoding: 'utf8',
    env: { ...process.env, AI_TERMINAL_PBCOPY: copyCommand },
  });
}

test('an empty tmux selection leaves the clipboard command untouched', () => {
  const result = run('', '/usr/bin/wc');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('non-empty single-line and multiline selections reach the clipboard unchanged', () => {
  for (const input of ['selected text', 'first\nsecond\n']) {
    const result = run(input, '/bin/cat');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, input);
  }
});
