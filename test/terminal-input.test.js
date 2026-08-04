'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ManagedTmuxPty,
  analyzeTerminalInput,
  validateTerminalRuntime,
} = require('../tmux-pty');

class FakeEventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
  }

  fire(value) {
    for (const listener of this.listeners) listener(value);
  }

  dispose() {}
}

function fakePtyManager(tmux) {
  return {
    vscode: { EventEmitter: FakeEventEmitter },
    tmux,
    wait: async () => {},
    formatTerminalName: () => 'session',
    log: (scope, error) => { throw new Error(`${scope}: ${error.message}`); },
  };
}

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

test('PTY open delegates session creation to the tmux runtime', async () => {
  const calls = [];
  const record = { id: 'session-1', tmuxSession: 'demo', windows: [] };
  const pty = new ManagedTmuxPty(fakePtyManager({
    ensureSession: async (...args) => calls.push(args),
  }), record);
  pty.spawnBridge = () => { pty.child = {}; };
  pty.primeDisplay = async () => {};

  await pty.open({ columns: 120, rows: 40 });

  assert.deepEqual(calls, [[record, { columns: 120, rows: 40 }]]);
});

test('startup validation passes the VS Code runtime to the node-pty adapter', async () => {
  const calls = [];
  const vscode = { env: { appRoot: '/Applications/Visual Studio Code.app' } };
  const config = {
    get: (name, fallback) => name === 'executables' ? { tmux: '/opt/homebrew/bin/tmux' } : fallback,
  };

  await validateTerminalRuntime(config, vscode, {
    execFileText: async (...args) => calls.push(['tmux', ...args]),
    loadNodePty: (runtime) => calls.push(['node-pty', runtime]),
  });

  assert.deepEqual(calls, [
    ['tmux', '/opt/homebrew/bin/tmux', ['-V'], { timeout: 3000 }],
    ['node-pty', vscode],
  ]);
});

test('multipane replay requests a full tmux redraw without replacing the screen', async () => {
  const writes = [];
  const record = {
    tmuxSession: 'demo',
    windows: [{ panes: [{ id: '%1' }, { id: '%2' }] }],
  };
  const pty = new ManagedTmuxPty(fakePtyManager({
    redrawSession: async () => 1,
    runTmux: async () => { throw new Error('capture-pane must not run'); },
  }), record);
  pty.opened = true;
  pty.child = {};
  pty.onDidWrite((value) => writes.push(value));

  await pty.replayVisiblePane();

  assert.deepEqual(writes, []);
});

test('multipane display redraws after initial output and later layout passes', async () => {
  const redraws = [];
  const waits = [];
  const manager = fakePtyManager({
    redrawSession: async () => { redraws.push('demo'); return 1; },
  });
  manager.wait = async (milliseconds) => waits.push(milliseconds);
  const record = {
    tmuxSession: 'demo',
    windows: [{ panes: [{ id: '%1' }, { id: '%2' }] }],
  };
  const pty = new ManagedTmuxPty(manager, record);
  pty.opened = true;
  pty.child = {};
  pty.noteFirstOutput();

  await pty.primeDisplay();

  assert.deepEqual(redraws, ['demo', 'demo', 'demo']);
  assert.deepEqual(waits, [250, 80, 180, 400]);
});

test('single-pane replay keeps the capture fallback when no client is visible', async () => {
  const writes = [];
  const record = { tmuxSession: 'demo', windows: [{ panes: [{ id: '%1' }] }] };
  const pty = new ManagedTmuxPty(fakePtyManager({
    redrawSession: async () => 0,
    runTmux: async () => 'prompt\n',
  }), record);
  pty.opened = true;
  pty.child = {};
  pty.onDidWrite((value) => writes.push(value));

  await pty.replayVisiblePane();

  assert.deepEqual(writes, ['\x1b[2J\x1b[Hprompt\r\n']);
});
