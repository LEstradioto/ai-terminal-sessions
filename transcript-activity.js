'use strict';

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

module.exports = {
  claudeTurnTiming,
  codexTurnTiming,
  isClaudeActivity,
  isClaudeHumanPrompt,
  isCodexActivity,
  latestTranscriptActivity,
  timestampMs,
};
