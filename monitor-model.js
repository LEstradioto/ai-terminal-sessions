'use strict';

const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const SGR_RE = /\x1b\[([0-9;:]*)m/g;
const DIVIDER_RUN_RE = /([─━═\-=])\1{15,}/gu;

function terminalPreview(rawText, maxLines = 12) {
  return ansiTerminalPreview(rawText, maxLines).text;
}

function ansiTerminalPreview(rawText, maxLines = 12) {
  const limit = Math.max(1, Math.min(40, Number(maxLines) || 12));
  const lines = [[]];
  let state = defaultAnsiState();
  let cursor = 0;
  const source = String(rawText || '').replace(/\r/g, '');
  SGR_RE.lastIndex = 0;

  for (let match = SGR_RE.exec(source); match; match = SGR_RE.exec(source)) {
    appendAnsiText(lines, source.slice(cursor, match.index), state);
    state = applySgr(state, match[1]);
    cursor = match.index + match[0].length;
  }
  appendAnsiText(lines, source.slice(cursor), state);

  const normalized = lines.map((segments) => trimAnsiLine(segments));
  while (normalized.length && !lineText(normalized[normalized.length - 1])) normalized.pop();
  const selected = normalized.slice(-limit).map((segments) => truncateAnsiLine(segments, 500));
  return {
    text: selected.map(lineText).join('\n').trimEnd(),
    lines: selected,
  };
}

function appendAnsiText(lines, rawText, state) {
  const text = String(rawText || '').replace(ANSI_RE, '');
  const parts = text.split('\n');
  for (let index = 0; index < parts.length; index += 1) {
    if (index > 0) lines.push([]);
    const value = parts[index].replace(
      DIVIDER_RUN_RE,
      (match) => `${match.slice(0, 12)}…`,
    );
    if (!value) continue;
    const line = lines[lines.length - 1];
    const style = compactAnsiState(state);
    const previous = line[line.length - 1];
    if (previous && sameAnsiStyle(previous, style)) previous.text += value;
    else line.push({ text: value, ...style });
  }
}

function defaultAnsiState() {
  return {
    fg: undefined,
    bg: undefined,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
    hidden: false,
    strike: false,
  };
}

function compactAnsiState(state) {
  const style = {};
  for (const key of ['fg', 'bg', 'bold', 'dim', 'italic', 'underline', 'inverse', 'hidden', 'strike']) {
    if (state[key] !== undefined && state[key] !== false) style[key] = state[key];
  }
  return style;
}

function applySgr(current, rawParameters) {
  let state = { ...current };
  const parameters = rawParameters === ''
    ? [0]
    : rawParameters.replace(/::/g, ':').split(/[;:]/).filter(Boolean).map(Number);

  for (let index = 0; index < parameters.length; index += 1) {
    const code = Number.isFinite(parameters[index]) ? parameters[index] : 0;
    if (code === 0) state = defaultAnsiState();
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 7) state.inverse = true;
    else if (code === 8) state.hidden = true;
    else if (code === 9) state.strike = true;
    else if (code === 22) { state.bold = false; state.dim = false; }
    else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 27) state.inverse = false;
    else if (code === 28) state.hidden = false;
    else if (code === 29) state.strike = false;
    else if (code >= 30 && code <= 37) state.fg = code - 30;
    else if (code >= 90 && code <= 97) state.fg = code - 90 + 8;
    else if (code === 39) state.fg = undefined;
    else if (code >= 40 && code <= 47) state.bg = code - 40;
    else if (code >= 100 && code <= 107) state.bg = code - 100 + 8;
    else if (code === 49) state.bg = undefined;
    else if ((code === 38 || code === 48) && parameters[index + 1] === 5) {
      const color = clampColorIndex(parameters[index + 2]);
      if (code === 38) state.fg = color;
      else state.bg = color;
      index += 2;
    } else if ((code === 38 || code === 48) && parameters[index + 1] === 2) {
      const color = [
        clampByte(parameters[index + 2]),
        clampByte(parameters[index + 3]),
        clampByte(parameters[index + 4]),
      ];
      if (code === 38) state.fg = color;
      else state.bg = color;
      index += 4;
    }
  }
  return state;
}

function trimAnsiLine(segments) {
  const result = segments.map((segment) => ({ ...segment }));
  while (result.length) {
    const last = result[result.length - 1];
    last.text = last.text.replace(/\s+$/u, '');
    if (last.text) break;
    result.pop();
  }
  return result;
}

function truncateAnsiLine(segments, maxCharacters) {
  const result = [];
  let remaining = maxCharacters;
  for (const segment of segments) {
    if (remaining <= 0) break;
    const characters = Array.from(segment.text);
    const text = characters.slice(0, remaining).join('');
    if (text) result.push({ ...segment, text });
    remaining -= characters.length;
  }
  return result;
}

function lineText(segments) {
  return segments.map((segment) => segment.text).join('');
}

function sameAnsiStyle(segment, style) {
  const keys = ['fg', 'bg', 'bold', 'dim', 'italic', 'underline', 'inverse', 'hidden', 'strike'];
  return keys.every((key) => JSON.stringify(segment[key]) === JSON.stringify(style[key]));
}

function clampColorIndex(value) {
  return Math.max(0, Math.min(255, Number(value) || 0));
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Number(value) || 0));
}

function activityLabel(activityAt, now = Date.now()) {
  const timestamp = Number(activityAt) || 0;
  if (!timestamp) return '-';
  const ageMs = Math.max(0, Number(now) - timestamp);
  if (ageMs < 15 * 1000) return 'NOW';
  if (ageMs < 60 * 1000) return `${Math.floor(ageMs / 1000)}S`;
  if (ageMs < 60 * 60 * 1000) return `${Math.floor(ageMs / 60000)}M`;
  if (ageMs < 24 * 60 * 60 * 1000) return `${Math.floor(ageMs / 3600000)}H`;
  return `${Math.floor(ageMs / 86400000)}D`;
}

function previewChangedAt(previous, preview, fallbackActivityAt, now = Date.now()) {
  if (!previous) return Number(fallbackActivityAt) || 0;
  return previous.preview !== preview ? now : Number(previous.changedAt) || 0;
}

function statusTone(status, acknowledged) {
  if (status === 'running') return 'working';
  if (status === 'waiting') return 'waiting';
  if (status === 'interrupted' || status === 'error') return 'error';
  if (status === 'done' && !acknowledged) return 'ready';
  return 'idle';
}

function statusLabel(status, acknowledged) {
  return {
    running: 'WORKING',
    waiting: 'WAITING',
    interrupted: 'STOPPED',
    error: 'ERROR',
  }[status] || (status === 'done' && !acknowledged ? 'READY' : 'IDLE');
}

function activeProcess(record) {
  const windows = Array.isArray(record && record.windows) ? record.windows : [];
  const activeWindow = windows.find((window) => window.active) || windows[0];
  const panes = Array.isArray(activeWindow && activeWindow.panes) ? activeWindow.panes : [];
  const activePane = panes.find((pane) => pane.active) || panes[0];
  return activePane && (activePane.agent?.process || activePane.process) || 'shell';
}

module.exports = {
  activeProcess,
  activityLabel,
  ansiTerminalPreview,
  previewChangedAt,
  statusLabel,
  statusTone,
  terminalPreview,
};
