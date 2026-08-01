'use strict';

const DEFAULT_ICON_PRESET = 'terminal';
const VALID_ICON_MODES = new Set(['auto', 'manual']);

const ICON_PRESETS = Object.freeze([
  Object.freeze({
    id: 'terminal',
    label: 'Terminal',
    marker: '🔷',
    icon: 'terminal-tmux',
    color: 'terminal.ansiCyan',
    description: 'General shell and tmux work',
  }),
  Object.freeze({
    id: 'codex',
    label: 'Codex',
    marker: '🟢',
    icon: 'sparkle',
    color: 'terminal.ansiGreen',
    description: 'Detected Codex CLI sessions',
  }),
  Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    marker: '🟠',
    icon: 'comment-discussion',
    color: 'terminal.ansiYellow',
    description: 'Detected Claude Code sessions',
  }),
  Object.freeze({
    id: 'rails',
    label: 'Rails Server',
    marker: '🔴',
    icon: 'ruby',
    color: 'terminal.ansiRed',
    description: 'Detected Rails and Puma servers',
  }),
  Object.freeze({
    id: 'agent',
    label: 'Agent',
    marker: '🟣',
    icon: 'robot',
    color: 'terminal.ansiMagenta',
    description: 'Codex, Claude Code, and other agents',
  }),
  Object.freeze({
    id: 'code',
    label: 'Code',
    marker: '🔵',
    icon: 'code',
    color: 'terminal.ansiBlue',
    description: 'Implementation and refactoring',
  }),
  Object.freeze({
    id: 'server',
    label: 'Server',
    marker: '🟡',
    icon: 'server',
    color: 'terminal.ansiYellow',
    description: 'Local servers and long-running processes',
  }),
  Object.freeze({
    id: 'deploy',
    label: 'Deploy',
    marker: '🟢',
    icon: 'rocket',
    color: 'terminal.ansiGreen',
    description: 'CI, releases, and deploys',
  }),
  Object.freeze({
    id: 'database',
    label: 'Database',
    marker: '🟪',
    icon: 'database',
    color: 'terminal.ansiBrightMagenta',
    description: 'Databases, queues, and storage',
  }),
  Object.freeze({
    id: 'tests',
    label: 'Tests',
    marker: '🧪',
    icon: 'beaker',
    color: 'terminal.ansiBrightGreen',
    description: 'Test suites and checks',
  }),
  Object.freeze({
    id: 'debug',
    label: 'Debug',
    marker: '🔴',
    icon: 'bug',
    color: 'terminal.ansiRed',
    description: 'Debugging and incident work',
  }),
]);

const ICON_PRESETS_BY_ID = new Map(ICON_PRESETS.map((preset) => [preset.id, preset]));

function normalizeIconPreset(value) {
  return ICON_PRESETS_BY_ID.has(value) ? value : DEFAULT_ICON_PRESET;
}

function iconPreset(value) {
  return ICON_PRESETS_BY_ID.get(normalizeIconPreset(value));
}

function normalizeIconMode(value, preset) {
  if (VALID_ICON_MODES.has(value)) return value;
  return preset && normalizeIconPreset(preset) !== DEFAULT_ICON_PRESET ? 'manual' : 'auto';
}

function isRailsServerProcess(processInfo) {
  const command = String(processInfo && processInfo.command || '').replace(/\\/g, '/');
  return /(?:^|\s)(?:\S*\/)?(?:bin\/)?rails\s+(?:server|s)\b/i.test(command)
    || /(?:^|\s)\S*puma(?:\s|$).*?(?:config\/puma\.rb|-C\s+\S*puma\.rb)/i.test(command);
}

function isPumaProcess(processInfo) {
  const value = `${processInfo && processInfo.comm || ''} ${processInfo && processInfo.command || ''}`;
  return /(?:^|[\s/])puma(?:\s|$)/i.test(value);
}

function automaticIconPreset(options = {}) {
  if (options.agentType === 'codex') return 'codex';
  if (options.agentType === 'claude') return 'claude';
  if ((options.processes || []).some(isRailsServerProcess)
    || (options.railsProject && (options.processes || []).some(isPumaProcess))) return 'rails';
  return DEFAULT_ICON_PRESET;
}

module.exports = {
  DEFAULT_ICON_PRESET,
  ICON_PRESETS,
  automaticIconPreset,
  iconPreset,
  isPumaProcess,
  isRailsServerProcess,
  normalizeIconMode,
  normalizeIconPreset,
};
