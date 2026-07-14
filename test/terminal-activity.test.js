'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  effectiveTerminalActivityAt,
  hasAgentContext,
  hasMeaningfulTerminalOutput,
  repairLegacyRestoreActivity,
} = require('../terminal-activity');

test('terminal activity ignores cursor movement, redraw controls and window titles', () => {
  assert.equal(hasMeaningfulTerminalOutput('\u001b[2J\u001b[H\r\n'), false);
  assert.equal(hasMeaningfulTerminalOutput('\u001b]0;shell title\u0007\u001b[?25h'), false);
});

test('terminal activity accepts colored command and process output', () => {
  assert.equal(hasMeaningfulTerminalOutput('\u001b[32mPASS\u001b[0m\r\n'), true);
  assert.equal(hasMeaningfulTerminalOutput('Started GET /health\r\n'), true);
});

test('agent sessions ignore PTY redraw timestamps in favor of transcript activity', () => {
  const record = {
    activeAgent: { type: 'codex' },
    lastAgentActivityAt: 10,
    lastTerminalActivityAt: 100,
    lastTerminalActivitySource: 'output',
  };
  assert.equal(hasAgentContext(record), true);
  assert.equal(effectiveTerminalActivityAt(record), 0);
});

test('explicit shell input remains semantic activity after an agent exits', () => {
  const record = {
    lastAgentActivityAt: 10,
    lastTerminalActivityAt: 100,
    lastTerminalActivitySource: 'input',
  };
  assert.equal(hasAgentContext(record), false);
  assert.equal(effectiveTerminalActivityAt(record), 100);
});

test('repairs a legacy burst shared by restored PTYs but preserves isolated activity', () => {
  const records = [
    { id: 'one', lastTerminalActivityAt: 10_000 },
    { id: 'two', lastTerminalActivityAt: 10_004 },
    { id: 'three', lastTerminalActivityAt: 50_000 },
  ];
  assert.equal(repairLegacyRestoreActivity(records), 2);
  assert.equal(records[0].lastTerminalActivityAt, 0);
  assert.equal(records[1].lastTerminalActivityAt, 0);
  assert.equal(records[2].lastTerminalActivityAt, 50_000);
});
