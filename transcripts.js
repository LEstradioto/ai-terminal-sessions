'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const TRANSCRIPT_ID_RE = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;

function codexTranscriptPathsFromLsof(raw, codexHome) {
  const sessionsRoot = `${path.resolve(codexHome, 'sessions')}${path.sep}`;
  const seen = new Set();
  const result = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.startsWith('n')) continue;
    const file = path.resolve(line.slice(1));
    if (!file.startsWith(sessionsRoot) || !TRANSCRIPT_ID_RE.test(file) || seen.has(file)) continue;
    seen.add(file);
    result.push(file);
  }
  return result;
}

function codexSessionIdFromTranscriptPath(file) {
  return String(file || '').match(TRANSCRIPT_ID_RE)?.[1];
}

function codexSessionIdFromMetadata(text) {
  for (const line of String(text || '').split('\n').slice(0, 4)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'session_meta') continue;
      const sessionId = entry.payload && (entry.payload.session_id || entry.payload.id);
      if (UUID_RE.test(sessionId || '')) return sessionId;
    } catch {}
  }
  return undefined;
}

function codexSessionCacheExpired(cached, now, refreshMs = 5000) {
  if (!cached || !Number.isFinite(Number(cached.at))) return true;
  return Number(now) - Number(cached.at) >= Math.max(0, Number(refreshMs) || 0);
}

function newestCodexSessionCandidate(candidates, fallbackSessionId) {
  const latest = [...(Array.isArray(candidates) ? candidates : [])]
    .filter((candidate) => UUID_RE.test(candidate && candidate.sessionId || ''))
    .sort((a, b) => Number(b.modifiedAt || 0) - Number(a.modifiedAt || 0))[0];
  if (latest) return latest.sessionId;
  return UUID_RE.test(fallbackSessionId || '') ? fallbackSessionId : undefined;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isClaudeActivity(entry) {
  const role = entry && entry.message && entry.message.role;
  return role === 'user' || role === 'assistant';
}

function isCodexActivity(entry) {
  if (!entry) return false;
  const payload = entry.payload || {};
  if (entry.type === 'event_msg') {
    return ['task_complete', 'turn_aborted', 'task_started', 'user_message', 'agent_message']
      .includes(payload.type);
  }
  if (entry.type === 'response_item') {
    if (payload.type === 'message') return payload.role !== 'developer';
    return [
      'function_call', 'function_call_output', 'reasoning', 'custom_tool_call',
      'custom_tool_call_output', 'web_search_call',
    ].includes(payload.type);
  }
  return ['message', 'function_call', 'function_call_output', 'reasoning'].includes(entry.type);
}

function latestTranscriptActivity(entries, provider) {
  let latest = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const semantic = provider === 'claude' ? isClaudeActivity(entry) : isCodexActivity(entry);
    if (!semantic) continue;
    latest = Math.max(latest, timestampMs(entry.timestamp));
  }
  return latest || undefined;
}

function codexTurnTiming(entries) {
  let turnStartedAt = 0;
  let turnCompletedAt = 0;
  let turnDurationMs = 0;
  let status;
  let taskStartedAt = 0;
  let promptSeenForTask = false;

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.type !== 'event_msg') continue;
    const event = entry.payload && entry.payload.type;
    const timestamp = timestampMs(entry.timestamp);
    if (!timestamp) continue;

    if (event === 'task_started') {
      const followsPrompt = status === 'running' && turnStartedAt
        && timestamp >= turnStartedAt && timestamp - turnStartedAt <= 5000;
      if (!followsPrompt) turnStartedAt = timestamp;
      taskStartedAt = timestamp;
      promptSeenForTask = followsPrompt;
      turnCompletedAt = 0;
      turnDurationMs = 0;
      status = 'running';
    } else if (event === 'user_message') {
      if (taskStartedAt && !promptSeenForTask
        && timestamp >= taskStartedAt && timestamp - taskStartedAt <= 5000) {
        turnStartedAt = timestamp;
        promptSeenForTask = true;
      } else if (!turnStartedAt || turnCompletedAt) {
        turnStartedAt = timestamp;
      }
      turnCompletedAt = 0;
      turnDurationMs = 0;
      status = 'running';
    } else if (event === 'task_complete' || event === 'turn_aborted') {
      turnCompletedAt = timestamp;
      turnDurationMs = turnStartedAt && timestamp >= turnStartedAt
        ? timestamp - turnStartedAt
        : 0;
      status = event === 'task_complete' ? 'done' : 'interrupted';
      taskStartedAt = 0;
      promptSeenForTask = false;
    }
  }

  return compactTurnTiming({ turnStartedAt, turnCompletedAt, turnDurationMs, status });
}

function claudeTurnTiming(entries) {
  let turnStartedAt = 0;
  let turnCompletedAt = 0;
  let turnDurationMs = 0;
  let status;

  for (const entry of Array.isArray(entries) ? entries : []) {
    const timestamp = timestampMs(entry && entry.timestamp);
    if (!timestamp) continue;

    if (isClaudeInterruptedEvent(entry)) {
      turnCompletedAt = timestamp;
      turnDurationMs = turnStartedAt && timestamp >= turnStartedAt
        ? timestamp - turnStartedAt
        : 0;
      status = 'interrupted';
      continue;
    }

    if (isClaudeHumanPrompt(entry)) {
      turnStartedAt = timestamp;
      turnCompletedAt = 0;
      turnDurationMs = 0;
      status = 'running';
      continue;
    }

    if (entry && entry.type === 'system' && entry.subtype === 'turn_duration') {
      turnCompletedAt = timestamp;
      const providerDuration = finiteDuration(entry.durationMs ?? entry.duration_ms);
      turnDurationMs = providerDuration || (
        turnStartedAt && timestamp >= turnStartedAt ? timestamp - turnStartedAt : 0
      );
      if (!turnStartedAt && turnDurationMs) {
        turnStartedAt = Math.max(0, timestamp - turnDurationMs);
      }
      status = 'done';
    }
  }

  return compactTurnTiming({ turnStartedAt, turnCompletedAt, turnDurationMs, status });
}

function isClaudeHumanPrompt(entry) {
  if (!entry || entry.type !== 'user' || entry.isMeta || entry.isSidechain
    || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) return false;
  const message = entry.message;
  if (!message || message.role !== 'user') return false;
  if (typeof message.content === 'string') return Boolean(message.content.trim());
  return Array.isArray(message.content) && message.content.some((item) => (
    item && item.type === 'text' && String(item.text || '').trim()
  ));
}

function isClaudeInterruptedEvent(entry) {
  if (!entry || entry.type !== 'user' || !entry.message || entry.message.role !== 'user') {
    return false;
  }
  const content = entry.message.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((item) => item && item.type === 'text').map((item) => item.text || '').join('\n')
      : '';
  return text.trimStart().startsWith('[Request interrupted');
}

function compactTurnTiming(timing) {
  const result = {};
  if (timing.turnStartedAt) result.turnStartedAt = timing.turnStartedAt;
  if (timing.turnCompletedAt) result.turnCompletedAt = timing.turnCompletedAt;
  if (timing.turnDurationMs) result.turnDurationMs = timing.turnDurationMs;
  if (timing.status) result.status = timing.status;
  return result;
}

function finiteDuration(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

async function inspectClaudeTranscript(file, metadataStatus) {
  const snapshot = await readJsonlTail(file);
  const transcriptActivityAt = latestTranscriptActivity(snapshot.entries, 'claude') || snapshot.modifiedAt;
  const transcriptAgeMs = transcriptActivityAt ? Math.max(0, Date.now() - transcriptActivityAt) : 0;
  const timing = claudeTurnTiming(snapshot.entries);
  let status = timing.status || (metadataStatus ? 'running' : 'idle');
  let title;
  let lastToolUse = false;
  let lastAssistantEndedTurn = false;
  for (const entry of snapshot.entries) {
    if (entry.type === 'custom-title' && entry.customTitle) title = entry.customTitle;
    const message = entry.message;
    if (!message || !message.role) continue;
    const items = Array.isArray(message.content)
      ? message.content
      : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : [];
    if (!title && message.role === 'user') {
      const text = typeof message.content === 'string'
        ? message.content
        : items.find((item) => item.type === 'text')?.text;
      if (isUsefulPrompt(text)) title = text;
    }
    if (message.role === 'assistant') {
      lastToolUse = items.some((item) => item.type === 'tool_use');
      lastAssistantEndedTurn = message.stop_reason === 'end_turn'
        && items.some((item) => item.type === 'text');
    } else if (message.role === 'user') {
      lastToolUse = false;
      lastAssistantEndedTurn = false;
    }
  }
  if (!timing.status && metadataStatus === 'idle' && lastAssistantEndedTurn) status = 'done';
  if (metadataStatus && metadataStatus !== 'idle' && lastToolUse && transcriptAgeMs >= 3000) status = 'waiting';
  return { status, title, lastActivityAt: transcriptActivityAt || undefined, ...timing };
}

async function inspectCodexTranscript(file) {
  const snapshot = await readJsonlTail(file);
  const transcriptActivityAt = latestTranscriptActivity(snapshot.entries, 'codex') || snapshot.modifiedAt;
  const transcriptAgeMs = transcriptActivityAt ? Math.max(0, Date.now() - transcriptActivityAt) : 0;
  const timing = codexTurnTiming(snapshot.entries);
  const usesTaskBoundaries = snapshot.entries.some((entry) => entry && entry.type === 'event_msg');
  let legacyStatus = 'running';
  let title;
  let lastToolCall = false;
  for (const entry of snapshot.entries) {
    const payload = entry.payload || {};
    if (!title) {
      if (entry.type === 'event_msg' && payload.type === 'user_message' && isUsefulPrompt(payload.message)) {
        title = payload.message;
      } else if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
        const text = Array.isArray(payload.content)
          ? payload.content.filter((item) => item.type === 'input_text').map((item) => item.text || '').join('\n')
          : '';
        if (isUsefulPrompt(text)) title = text;
      }
    }
    let nextStatus;
    let toolCall = false;
    if (entry.type === 'event_msg') {
      if (payload.type === 'task_complete') nextStatus = 'done';
      else if (payload.type === 'turn_aborted') nextStatus = 'interrupted';
      else if (payload.type === 'task_started' || payload.type === 'user_message') nextStatus = 'running';
      else if (payload.type === 'agent_message') nextStatus = payload.phase === 'final_answer' ? 'done' : 'running';
    } else if (entry.type === 'response_item') {
      if (payload.type === 'message' && payload.role !== 'developer') {
        nextStatus = payload.role === 'assistant' && payload.phase === 'final_answer' ? 'done' : 'running';
      } else if (['function_call', 'function_call_output', 'reasoning', 'custom_tool_call', 'custom_tool_call_output', 'web_search_call'].includes(payload.type)) {
        nextStatus = 'running';
        toolCall = payload.type === 'function_call';
      }
    } else if (['message', 'function_call', 'function_call_output', 'reasoning'].includes(entry.type)) {
      nextStatus = 'running';
      toolCall = entry.type === 'function_call';
    }
    if (nextStatus) {
      legacyStatus = nextStatus;
      lastToolCall = toolCall;
    }
  }
  let status = timing.status || (usesTaskBoundaries && legacyStatus === 'done'
    ? 'running'
    : legacyStatus);
  if (status === 'running' && lastToolCall && transcriptAgeMs >= 3000) status = 'waiting';
  return { status, title, lastActivityAt: transcriptActivityAt || undefined, ...timing };
}

function turnTimingFields(journal) {
  if (!journal) return {};
  const result = {};
  for (const field of ['turnStartedAt', 'turnCompletedAt', 'turnDurationMs']) {
    const value = Number(journal[field]);
    if (Number.isFinite(value) && value > 0) result[field] = value;
  }
  return result;
}

async function readJsonlTail(file, maxBytes = 512 * 1024) {
  if (!file) return { entries: [], ageMs: 0, modifiedAt: 0 };
  let handle;
  try {
    const stat = await fs.promises.stat(file);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    handle = await fs.promises.open(file, 'r');
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(Math.max(0, text.indexOf('\n') + 1));
    const entries = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
    return { entries, ageMs: Math.max(0, Date.now() - stat.mtimeMs), modifiedAt: stat.mtimeMs };
  } catch {
    return { entries: [], ageMs: 0, modifiedAt: 0 };
  } finally {
    if (handle) await handle.close();
  }
}

async function readFilePrefix(file, maxBytes = 256 * 1024) {
  let handle;
  try {
    handle = await fs.promises.open(file, 'r');
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return buffer.toString('utf8');
  } finally {
    if (handle) await handle.close();
  }
}

async function findFileEndingWith(root, suffix) {
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  entries.sort((a, b) => b.name.localeCompare(a.name));
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(suffix)) return full;
    if (entry.isDirectory()) {
      const found = await findFileEndingWith(full, suffix);
      if (found) return found;
    }
  }
  return undefined;
}

function encodeClaudeProject(value) {
  return String(value || '').replace(/[/._]/g, '-');
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function isUsefulPrompt(text) {
  if (!text || typeof text !== 'string') return false;
  const value = text.trim();
  return value.length > 1
    && !value.startsWith('<')
    && !value.startsWith('{')
    && !value.startsWith('# AGENTS.md')
    && !value.startsWith('[Request interrupted');
}

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
  claudeTurnTiming,
  cleanMessageText,
  codexHome,
  codexSessionCacheExpired,
  codexSessionIdFromMetadata,
  codexSessionIdFromTranscriptPath,
  codexTranscriptPathsFromLsof,
  codexTurnTiming,
  encodeClaudeProject,
  extractConversationPreview,
  findFileEndingWith,
  inspectClaudeTranscript,
  inspectCodexTranscript,
  latestTranscriptActivity,
  newestCodexSessionCandidate,
  readFilePrefix,
  readJsonlTail,
  turnTimingFields,
};
