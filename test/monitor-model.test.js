'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SessionMonitor,
  activeProcess,
  activityLabel,
  ansiTerminalPreview,
  previewChangedAt,
  statusLabel,
  statusTone,
  turnDurationLabel,
} = require('../monitor-model');

test('monitor toggle closes a focused panel and restores the previous terminal', async () => {
  const commands = [];
  let restored = 0;
  const terminal = { show: () => { restored += 1; } };
  const vscode = {
    commands: { executeCommand: async (command) => commands.push(command) },
    window: { terminals: [terminal] },
  };
  const owner = monitorOwner();
  const monitor = new SessionMonitor(owner, {
    vscode,
    workspaceName: () => 'workspace',
    waitFor: async () => true,
    titleFor: () => 'session',
  });
  monitor.view = { visible: true };
  monitor.focused = true;
  monitor.returnTerminal = terminal;

  await monitor.toggle();

  assert.deepEqual(commands, ['workbench.action.closePanel']);
  assert.equal(restored, 1);
  assert.equal(monitor.focused, false);
});

function monitorOwner() {
  return {
    activeRecord: () => undefined,
    deactivating: false,
    log: () => {},
    output: { appendLine: () => {} },
    pinnedRecords: () => [],
    records: new Map(),
    terminals: new Map(),
  };
}
const { monitorHtml } = require('../monitor-view');

test('preserves ANSI 256-color, truecolor, background and text attributes', () => {
  const raw = [
    '\u001b[1;38;5;46mgreen bold\u001b[0m plain',
    '\u001b[2;3;4;38;2;143;179;239;48;5;22mstyled\u001b[0m',
  ].join('\n');
  const terminal = ansiTerminalPreview(raw, 12);

  assert.equal(terminal.text, 'green bold plain\nstyled');
  assert.deepEqual(terminal.lines[0], [
    { text: 'green bold', fg: 46, bold: true },
    { text: ' plain' },
  ]);
  assert.deepEqual(terminal.lines[1], [{
    text: 'styled',
    fg: [143, 179, 239],
    bg: 22,
    dim: true,
    italic: true,
    underline: true,
  }]);
});

test('formats activity age for a compact instrument label', () => {
  const now = 1_000_000;
  assert.equal(activityLabel(now - 5_000, now), 'NOW');
  assert.equal(activityLabel(now - 45_000, now), '45S');
  assert.equal(activityLabel(now - 5 * 60_000, now), '5M');
  assert.equal(activityLabel(now - 3 * 3_600_000, now), '3H');
  assert.equal(activityLabel(0, now), '-');
});

test('formats live and completed prompt duration independently from activity age', () => {
  const now = 1_000_000;
  assert.equal(turnDurationLabel({ status: 'running', turnStartedAt: now - 65_000 }, now), 'TURN 1M 05S');
  assert.equal(turnDurationLabel({
    status: 'done',
    turnStartedAt: now - 80_000,
    turnCompletedAt: now - 20_000,
    turnDurationMs: 60_000,
  }, now), 'TURN 1M 00S');
  assert.equal(turnDurationLabel({}, now), '');
});

test('opening the monitor does not make an old unchanged session look recent', () => {
  const oldActivity = 1_000;
  assert.equal(previewChangedAt(undefined, 'old output', oldActivity, 99_000), oldActivity);
  assert.equal(previewChangedAt(
    { preview: 'old output', changedAt: oldActivity },
    'new output',
    oldActivity,
    99_000,
  ), 99_000);
});

test('maps agent and acknowledged states to monitor tones', () => {
  assert.equal(statusTone('running', false), 'working');
  assert.equal(statusTone('waiting', false), 'waiting');
  assert.equal(statusTone('done', false), 'ready');
  assert.equal(statusTone('done', true), 'idle');
  assert.equal(statusLabel('done', false), 'READY');
  assert.equal(statusLabel('done', true), 'IDLE');
});

test('finds the active pane process', () => {
  const record = {
    windows: [{
      active: true,
      panes: [
        { active: false, process: 'zsh' },
        { active: true, process: 'node', agent: { process: 'codex' } },
      ],
    }],
  };
  assert.equal(activeProcess(record), 'codex');
  assert.equal(activeProcess({}), 'shell');
});

test('webview HTML has a strict CSP and escapes workspace text', () => {
  const html = monitorHtml({ cspSource: 'vscode-webview://test' }, '<unsafe & workspace>');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /style-src-attr 'unsafe-inline'/);
  assert.match(html, /script-src 'nonce-[A-Za-z0-9_-]+'/);
  assert.match(html, /&lt;unsafe &amp; workspace&gt;/);
  assert.match(html, /--monitor-accent:/);
  assert.match(html, /class="monitor-label">Session Monitor</);
  assert.doesNotMatch(html, /<unsafe & workspace>/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /max-width: 580px/);
  assert.match(html, /repeat\(auto-fit, minmax\(260px, 1fr\)\)/);
  assert.match(html, /font-size: 8\.75px/);
  assert.match(html, /min-height: 34px/);
  assert.match(html, />Session Monitor<\/span>/);
  assert.match(html, /sessions\.length \+ '\/4'/);
  assert.match(html, /screen\.scrollTop = screen\.scrollHeight/);
  assert.match(html, /article\.addEventListener\('click'/);
  assert.doesNotMatch(html, /article\.addEventListener\('dblclick'/);
  assert.match(html, /article\.tabIndex = 0/);
  assert.match(html, /event\.data\.type === 'focus-monitor'/);
  assert.match(html, /type: 'focus-state'/);
  assert.match(html, /event\.key === 'ArrowLeft'/);
  assert.match(html, /event\.key === 'ArrowRight'/);
  assert.match(html, /event\.key === 'Escape'/);
  assert.match(html, /type: 'return'/);
  assert.match(html, /card\.focus\(\{ preventScroll: true \}\)/);
  assert.match(html, /inside a managed terminal/);
  assert.match(html, /Terminal output for/);
  assert.match(html, /function xtermColor/);
  assert.match(html, /session\.turn/);
});
