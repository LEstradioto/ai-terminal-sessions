'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  redactDiagnostic, redactPath, resolveExecutable, shellQuote, terminalProfileSetting,
} = require('../runtime-paths');

test('shellQuote safely preserves spaces and apostrophes', () => {
  assert.equal(shellQuote('/tmp/Agent CLI'), "'/tmp/Agent CLI'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test('diagnostic paths redact the user home directory', () => {
  const os = require('node:os');
  assert.equal(redactPath(`${os.homedir()}/.codex/session.jsonl`), '~/.codex/session.jsonl');
});

test('diagnostics redact account identifiers even when provider JSON is malformed', () => {
  const value = redactDiagnostic('email=user@example.com orgId=2fda7962-8925-46eb-b9a8-5924b267dab2');
  assert.doesNotMatch(value, /user@example|2fda7962/);
});

test('terminal profile settings are platform aware', () => {
  assert.equal(terminalProfileSetting('darwin'), 'defaultProfile.osx');
  assert.equal(terminalProfileSetting('linux'), 'defaultProfile.linux');
  assert.equal(terminalProfileSetting('win32'), 'defaultProfile.windows');
});

test('bare executable names preserve PATH precedence', () => {
  const previous = process.env.PATH;
  process.env.PATH = path.dirname(process.execPath);
  assert.equal(resolveExecutable(path.basename(process.execPath), 'node'), process.execPath);
  assert.equal(resolveExecutable('definitely-not-installed', 'definitely-not-installed'), 'definitely-not-installed');
  assert.equal(resolveExecutable('/custom/bin/codex', 'codex'), '/custom/bin/codex');
  process.env.PATH = previous;
});
