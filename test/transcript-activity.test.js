'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  claudeTurnTiming,
  codexTurnTiming,
  latestTranscriptActivity,
} = require('../transcripts');

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

test('Codex turn stays running through a final answer until task_complete', () => {
  const entries = [
    { timestamp: '2026-08-03T10:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-08-03T10:00:00.200Z', type: 'event_msg', payload: { type: 'user_message' } },
    {
      timestamp: '2026-08-03T10:00:30.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer' },
    },
  ];
  assert.deepEqual(codexTurnTiming(entries), {
    turnStartedAt: Date.parse('2026-08-03T10:00:00.200Z'),
    status: 'running',
  });

  entries.push({
    timestamp: '2026-08-03T10:00:30.050Z',
    type: 'event_msg',
    payload: { type: 'task_complete' },
  });
  assert.deepEqual(codexTurnTiming(entries), {
    turnStartedAt: Date.parse('2026-08-03T10:00:00.200Z'),
    turnCompletedAt: Date.parse('2026-08-03T10:00:30.050Z'),
    turnDurationMs: 29_850,
    status: 'done',
  });
});

test('Codex keeps the prompt timestamp when older logs record task_started second', () => {
  const timing = codexTurnTiming([
    { timestamp: '2026-08-03T10:00:00.000Z', type: 'event_msg', payload: { type: 'user_message' } },
    { timestamp: '2026-08-03T10:00:00.500Z', type: 'event_msg', payload: { type: 'task_started' } },
  ]);
  assert.equal(timing.turnStartedAt, Date.parse('2026-08-03T10:00:00.000Z'));
  assert.equal(timing.status, 'running');
});

test('Claude turn only completes on the strong turn_duration boundary', () => {
  const entries = [
    {
      timestamp: '2026-08-03T10:00:00.000Z',
      type: 'user',
      origin: { kind: 'human' },
      message: { role: 'user', content: 'Fix the dashboard' },
    },
    {
      timestamp: '2026-08-03T10:00:20.000Z',
      type: 'assistant',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] },
    },
  ];
  assert.deepEqual(claudeTurnTiming(entries), {
    turnStartedAt: Date.parse('2026-08-03T10:00:00.000Z'),
    status: 'running',
  });

  entries.push({
    timestamp: '2026-08-03T10:00:20.100Z',
    type: 'system',
    subtype: 'turn_duration',
    durationMs: 20_000,
  });
  assert.deepEqual(claudeTurnTiming(entries), {
    turnStartedAt: Date.parse('2026-08-03T10:00:00.000Z'),
    turnCompletedAt: Date.parse('2026-08-03T10:00:20.100Z'),
    turnDurationMs: 20_000,
    status: 'done',
  });
});

test('Claude timer ignores tool results and starts again for the next human prompt', () => {
  const entries = [
    {
      timestamp: '2026-08-03T10:00:00.000Z',
      type: 'user',
      message: { role: 'user', content: 'First prompt' },
    },
    {
      timestamp: '2026-08-03T10:00:05.000Z',
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
    },
    {
      timestamp: '2026-08-03T10:00:10.000Z',
      type: 'system',
      subtype: 'turn_duration',
      durationMs: 10_000,
    },
    {
      timestamp: '2026-08-03T10:01:00.000Z',
      type: 'user',
      origin: { kind: 'human' },
      message: { role: 'user', content: 'Second prompt' },
    },
  ];
  assert.deepEqual(claudeTurnTiming(entries), {
    turnStartedAt: Date.parse('2026-08-03T10:01:00.000Z'),
    status: 'running',
  });
});
