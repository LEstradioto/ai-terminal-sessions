'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { latestTranscriptActivity } = require('../transcript-activity');

test('Claude activity ignores resume metadata that only touches the transcript file', () => {
  const entries = [
    { timestamp: '2026-07-08T01:48:09.803Z', type: 'assistant', message: { role: 'assistant' } },
    { timestamp: null, type: 'last-prompt' },
    { timestamp: null, type: 'permission-mode' },
  ];
  assert.equal(
    latestTranscriptActivity(entries, 'claude'),
    Date.parse('2026-07-08T01:48:09.803Z'),
  );
});

test('Codex activity ignores bookkeeping events after the final answer', () => {
  const entries = [
    {
      timestamp: '2026-07-12T02:32:53.257Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', phase: 'final_answer' },
    },
    {
      timestamp: '2026-07-13T20:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'token_count' },
    },
    {
      timestamp: '2026-07-13T20:00:01.000Z',
      type: 'inter_agent_communication_metadata',
    },
  ];
  assert.equal(
    latestTranscriptActivity(entries, 'codex'),
    Date.parse('2026-07-12T02:32:53.257Z'),
  );
});
