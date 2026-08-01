'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_ICON_PRESET,
  ICON_PRESETS,
  automaticIconPreset,
  iconPreset,
  isPumaProcess,
  isRailsServerProcess,
  normalizeIconMode,
  normalizeIconPreset,
} = require('../terminal-icons');

test('offers a small allowlisted set of colorful terminal roles', () => {
  assert.equal(DEFAULT_ICON_PRESET, 'terminal');
  assert.equal(ICON_PRESETS.length, 11);
  assert.equal(new Set(ICON_PRESETS.map((preset) => preset.id)).size, ICON_PRESETS.length);
  for (const preset of ICON_PRESETS) {
    assert.match(preset.icon, /^[a-z0-9-]+$/);
    assert.match(preset.color, /^terminal\.ansi(?:Bright)?(?:Blue|Cyan|Green|Magenta|Red|Yellow)$/);
    assert.ok(preset.marker);
  }
});

test('normalizes unknown and legacy icon values to the terminal preset', () => {
  assert.equal(normalizeIconPreset(undefined), 'terminal');
  assert.equal(normalizeIconPreset('unknown'), 'terminal');
  assert.equal(normalizeIconPreset('server'), 'server');
  assert.equal(iconPreset('unknown').id, 'terminal');
});

test('keeps legacy customized icons manual while default terminals become automatic', () => {
  assert.equal(normalizeIconMode(undefined, 'terminal'), 'auto');
  assert.equal(normalizeIconMode(undefined, 'debug'), 'manual');
  assert.equal(normalizeIconMode('auto', 'debug'), 'auto');
});

test('automatically distinguishes Codex, Claude, Rails, and a regular shell', () => {
  assert.equal(automaticIconPreset({ agentType: 'codex' }), 'codex');
  assert.equal(automaticIconPreset({ agentType: 'claude' }), 'claude');
  assert.equal(automaticIconPreset({
    processes: [{ command: 'ruby /tmp/shop/bin/rails server -p 3000' }],
  }), 'rails');
  assert.equal(automaticIconPreset({
    processes: [{ command: 'puma -C /tmp/shop/config/puma.rb' }],
  }), 'rails');
  assert.equal(automaticIconPreset({
    processes: [{ comm: '/opt/homebrew/bin/puma', command: 'puma 7.1.0 (tcp://localhost:3000)' }],
    railsProject: true,
  }), 'rails');
  assert.equal(automaticIconPreset({ processes: [{ command: '/bin/zsh -l' }] }), 'terminal');
});

test('does not classify unrelated Ruby and Puma commands as Rails servers', () => {
  assert.equal(isRailsServerProcess({ command: 'ruby script/import.rb' }), false);
  assert.equal(isRailsServerProcess({ command: 'puma-dev -install' }), false);
  assert.equal(isPumaProcess({ command: 'puma-dev -install' }), false);
});
