'use strict';

const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const DIVIDER_CHARACTERS = new Set(Array.from(`─━═-=_╭╮╰╯┌┐└┘\u2014`));
const PROMPT_MARKERS = new Set(['›', '❯', '>']);

function extractDraft(rawText) {
  const lines = normalizeLines(rawText);
  if (!lines.length) return undefined;

  const divider = lastClaudeDividerPair(lines);
  if (divider) {
    return usableDraft(cleanComposerLines(lines.slice(divider.top + 1, divider.bottom)));
  }

  const markerIndex = lastPromptMarkerIndex(lines);
  if (markerIndex === -1) return undefined;
  const candidate = [];
  for (let index = markerIndex; index < lines.length && index <= markerIndex + 14; index += 1) {
    const line = lines[index];
    if (index > markerIndex && (isDividerLine(line) || isStatusLine(line))) break;
    candidate.push(line);
  }
  return usableDraft(cleanComposerLines(candidate));
}

function normalizeLines(rawText) {
  return String(rawText || '')
    .replace(ANSI_RE, '')
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''));
}

function lastClaudeDividerPair(lines) {
  const indexes = lines.map((line, index) => isDividerLine(line) ? index : -1)
    .filter((index) => index >= 0);
  let result;
  for (const top of indexes) {
    for (const bottom of indexes) {
      const gap = bottom - top;
      if (gap < 2 || gap > 12) continue;
      if (lines.slice(top + 1, bottom).some(containsPromptMarker)) result = { top, bottom };
    }
  }
  return result;
}

function lastPromptMarkerIndex(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (containsPromptMarker(lines[index])) return index;
  }
  return -1;
}

function containsPromptMarker(line) {
  const value = String(line || '').trimStart()
    .replace(/^[│┃|]\s*/u, '');
  return PROMPT_MARKERS.has(value[0]) && (value.length === 1 || /\s/u.test(value[1]));
}

function cleanComposerLines(lines) {
  const cleaned = lines.map((line) => {
    let value = String(line || '').trim();
    value = value.replace(/^[│┃║▌▐▏▕]+/u, '').trim();
    value = value.replace(/[│┃║▌▐▏▕]+$/u, '').trim();
    if (value.length >= 2 && PROMPT_MARKERS.has(value[0]) && /\s/u.test(value[1])) {
      value = value.slice(2).trim();
    }
    return value;
  });
  while (cleaned.length && !cleaned[0]) cleaned.shift();
  while (cleaned.length && !cleaned[cleaned.length - 1]) cleaned.pop();
  return cleaned.join('\n');
}

function usableDraft(text) {
  const value = String(text || '').trim();
  if (value.length < 2 || !/[\p{L}\p{N}]/u.test(value)) return undefined;
  if (isPlaceholder(value)) return undefined;
  return value.slice(0, 50000);
}

function isPlaceholder(text) {
  const value = text.replace(/\s+/g, ' ').trim();
  return /^(?:Improve documentation in @filename|Describe (?:a |your )?task|Ask Codex|Type (?:a |your )?(?:message|request|prompt))\.?$/iu.test(value);
}

function isDividerLine(line) {
  const value = String(line || '').trim();
  if (value.length < 8) return false;
  const characters = Array.from(value);
  const dividerCount = characters.filter((character) => DIVIDER_CHARACTERS.has(character)).length;
  return dividerCount / characters.length >= 0.45;
}

function isStatusLine(line) {
  const value = String(line || '').trim().toLocaleLowerCase();
  if (!value) return false;
  const fragments = [
    'esc to', 'ctrl+', 'enter to', '? for shortcuts', 'tokens used', 'tokens remaining',
    'auto mode on', 'goal achieved', 'alt+m', ' = menu',
  ];
  if (fragments.some((fragment) => value.includes(fragment))) return true;
  if (value.includes('context ') && value.includes(' window')) return true;
  if (/^gpt-[\w.-]+\b/u.test(value) && value.includes('used')) return true;
  if (/^workspace-/u.test(value)) return true;
  return false;
}

module.exports = {
  containsPromptMarker,
  extractDraft,
  isDividerLine,
  isPlaceholder,
  isStatusLine,
};
