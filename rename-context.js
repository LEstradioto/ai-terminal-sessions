'use strict';

const fs = require('fs');
const readline = require('readline');

const STATUS_PREFIX_RE = /^(?:(?:○\s*[\u2800-\u28ff]?|[●◉✓⚠×⚪🟡🟠🟢🟧🟨🟫🔴])\s*)+/u;
const SLASH_COMMAND_RE = /^\/[\p{L}\p{N}_-]+(?:\s|$)/u;
const ACKNOWLEDGEMENT_PHRASES = [
  'ok', 'okay', 'yes', 'yep', 'yup', 'perfect', 'great', 'done', 'thanks', 'thank you',
  'go ahead', 'do it', 'continue', 'proceed', 'carry on', 'sounds good',
  'sim', 'nao', 'não', 'perfeito', 'beleza', 'feito', 'valeu', 'obrigado', 'obrigada',
  'pode fazer', 'manda', 'continua', 'segue',
  'sí', 'si', 'vale', 'perfecto', 'perfecta', 'gracias', 'adelante', 'continúa', 'hazlo',
  'oui', 'non', 'parfait', 'merci', 'vas y',
  'ja', 'nein', 'perfekt', 'danke', 'weiter', 'mach weiter',
  'sì', 'no', 'perfetto', 'perfetta', 'grazie', 'vai',
  'はい', '続けて', '好的', '可以', '继续', '네', '좋아요', '계속',
].map((phrase) => phrase.split(' '));

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function textFromContent(content, acceptedTypes) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item && acceptedTypes.has(item.type) && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function candidateFromClaude(entry) {
  if (!entry || entry.isMeta || entry.isSidechain) return undefined;
  const message = entry.message;
  if (!message || message.role !== 'user') return undefined;
  return textFromContent(message.content, new Set(['text', 'input_text']));
}

function candidateFromCodex(entry) {
  if (!entry) return undefined;
  const payload = entry.payload || {};
  if (entry.type === 'event_msg' && payload.type === 'user_message') {
    return payload.message;
  }
  if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
    return textFromContent(payload.content, new Set(['input_text', 'text']));
  }
  return undefined;
}

function isMeaningfulRenameMessage(text) {
  const value = normalizeWhitespace(text);
  if (value.length < 2 || isAcknowledgementOnly(value) || SLASH_COMMAND_RE.test(value)) return false;
  return !value.startsWith('<')
    && !value.startsWith('{')
    && !value.startsWith('# AGENTS.md')
    && !value.startsWith('[Request interrupted')
    && !value.startsWith('The following is the Codex agent history');
}

function isAcknowledgementOnly(text) {
  const tokens = String(text || '').toLocaleLowerCase()
    .replace(new RegExp('[.!?,;:>…\\u2014\\u2013-]+', 'gu'), ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (!tokens.length || tokens.length > 12) return false;
  const reachable = new Set([0]);
  for (let index = 0; index < tokens.length; index += 1) {
    if (!reachable.has(index)) continue;
    for (const phrase of ACKNOWLEDGEMENT_PHRASES) {
      if (phrase.every((token, offset) => tokens[index + offset] === token)) {
        reachable.add(index + phrase.length);
      }
    }
  }
  return reachable.has(tokens.length);
}

function extractRecentUserMessages(agentType, entries, limit = 2) {
  const found = [];
  const seen = new Set();
  const candidateFor = agentType === 'claude' ? candidateFromClaude : candidateFromCodex;
  for (let index = entries.length - 1; index >= 0 && found.length < limit; index -= 1) {
    const text = normalizeWhitespace(candidateFor(entries[index]));
    if (!isMeaningfulRenameMessage(text)) continue;
    const key = text.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(text);
  }
  return found.reverse();
}

async function readRecentUserMessages(agentType, file, limit = 2) {
  const stat = await fs.promises.stat(file);
  const recent = [];
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const message = extractRecentUserMessages(agentType, [entry], 1)[0];
      if (!message) continue;
      const key = message.toLocaleLowerCase();
      const duplicate = recent.findIndex((item) => item.key === key);
      if (duplicate >= 0) recent.splice(duplicate, 1);
      recent.push({ key, message });
      if (recent.length > limit) recent.shift();
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return {
    messages: recent.map((item) => item.message),
    bytesRead: stat.size,
  };
}

function buildRenameSource(messages, fallback, maxChars = 1600) {
  const useful = messages.length ? messages : [normalizeWhitespace(fallback)];
  const perMessage = Math.max(240, Math.floor(maxChars / useful.length) - 40);
  return useful
    .map((message, index) => `Recent user message ${index + 1}: ${message.slice(0, perMessage)}`)
    .join('\n\n')
    .slice(0, maxChars);
}

function stripStatusPrefix(value) {
  return normalizeWhitespace(String(value || '').replace(STATUS_PREFIX_RE, ''));
}

function normalizeContextTitle(input) {
  const tokens = normalizeWhitespace(String(input || '').replace(/["'`*_#.,:;!?()[\]{}<>]/g, ' '))
    .match(/[\p{L}\p{N}-]+/gu) || [];
  if (!tokens.length) return undefined;
  return tokens.slice(0, 2).map((token) => token.toLocaleLowerCase()).join(' ');
}

module.exports = {
  buildRenameSource,
  extractRecentUserMessages,
  isAcknowledgementOnly,
  isMeaningfulRenameMessage,
  normalizeContextTitle,
  readRecentUserMessages,
  stripStatusPrefix,
};
