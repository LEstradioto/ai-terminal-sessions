'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isMissingTmuxSessionError } = require('../tmux-errors');

test('recognizes absent tmux sessions and servers', () => {
  assert.equal(isMissingTmuxSessionError({ code: 1, stderr: "can't find session: demo" }), true);
  assert.equal(isMissingTmuxSessionError({ code: 1, stderr: 'no server running on /tmp/tmux.sock' }), true);
  assert.equal(isMissingTmuxSessionError({
    code: 1,
    stderr: 'error connecting to /tmp/tmux.sock (No such file or directory)',
  }), true);
});

test('does not hide infrastructure failures as missing sessions', () => {
  assert.equal(isMissingTmuxSessionError({ code: 'ETIMEDOUT', message: 'timed out' }), false);
  assert.equal(isMissingTmuxSessionError({ code: 1, stderr: 'operation not permitted' }), false);
  assert.equal(isMissingTmuxSessionError({ code: 2, stderr: "can't find session: demo" }), false);
});
