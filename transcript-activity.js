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

module.exports = {
  isClaudeActivity,
  isCodexActivity,
  latestTranscriptActivity,
  timestampMs,
};
