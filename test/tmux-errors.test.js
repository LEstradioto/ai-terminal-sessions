'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TmuxRuntime, isMissingTmuxSessionError } = require('../tmux');

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

test('redraw refreshes every client attached to the restored session', async () => {
  const calls = [];
  const runtime = Object.create(TmuxRuntime.prototype);
  runtime.runTmux = async (args) => {
    calls.push(args);
    return calls.length === 1 ? '/dev/ttys001\n/dev/ttys002\n' : '';
  };

  const count = await runtime.redrawSession('demo');

  assert.equal(count, 2);
  assert.deepEqual(calls[0], ['list-clients', '-t', 'demo', '-F', '#{client_name}']);
  assert.deepEqual(calls[1], [
    'refresh-client', '-t', '/dev/ttys001', ';',
    'refresh-client', '-t', '/dev/ttys002',
  ]);
});
