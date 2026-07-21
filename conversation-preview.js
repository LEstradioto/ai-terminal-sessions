'use strict';

const MAX_MESSAGE_CHARS = 1600;
const DEFAULT_MESSAGE_LIMIT = 6;

function contentText(content, acceptedTypes) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item && acceptedTypes.has(item.type) && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function cleanMessageText(value) {
  const text = String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text
    || text.startsWith('<environment_context>')
    || text.startsWith('<user_instructions>')
    || text.startsWith('# AGENTS.md')
    || text.startsWith('The following is the Codex agent history')) return '';
  return text.slice(0, MAX_MESSAGE_CHARS);
}

function claudeMessage(entry) {
  if (!entry || entry.isMeta || entry.isSidechain || !entry.message) return undefined;
  const role = entry.message.role;
  if (role !== 'user' && role !== 'assistant') return undefined;
  const types = role === 'user'
    ? new Set(['text', 'input_text'])
    : new Set(['text', 'output_text']);
  const text = cleanMessageText(contentText(entry.message.content, types));
  return text ? { role, text } : undefined;
}

function codexMessage(entry) {
  if (!entry) return undefined;
  const payload = entry.payload || {};
  if (entry.type === 'event_msg' && payload.type === 'user_message') {
    const text = cleanMessageText(payload.message);
    return text ? { role: 'user', text } : undefined;
  }
  if (entry.type === 'event_msg' && payload.type === 'agent_message') {
    const text = cleanMessageText(payload.message);
    return text ? { role: 'assistant', text } : undefined;
  }
  if (entry.type !== 'response_item' || payload.type !== 'message') return undefined;
  if (payload.role !== 'user' && payload.role !== 'assistant') return undefined;
  const types = payload.role === 'user'
    ? new Set(['input_text', 'text'])
    : new Set(['output_text', 'text']);
  const text = cleanMessageText(contentText(payload.content, types));
  return text ? { role: payload.role, text } : undefined;
}

function extractConversationPreview(agentType, entries, limit = DEFAULT_MESSAGE_LIMIT) {
  const messageFor = agentType === 'claude' ? claudeMessage : codexMessage;
  const messages = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const message = messageFor(entry);
    if (!message) continue;
    const key = `${message.role}\u0000${message.text.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    messages.push(message);
  }
  return messages.slice(-Math.max(1, Number(limit) || DEFAULT_MESSAGE_LIMIT));
}

module.exports = {
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_CHARS,
  cleanMessageText,
  extractConversationPreview,
};
