'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { extractConversationPreview } = require('../transcripts');

test('extracts user and assistant messages from Codex without duplicate event formats', () => {
  const entries = [
    { type: 'event_msg', payload: { type: 'user_message', message: 'Fix pricing' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix pricing' }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Done', phase: 'final_answer' } },
  ];
  assert.deepEqual(extractConversationPreview('codex', entries), [
    { role: 'user', text: 'Fix pricing' },
    { role: 'assistant', text: 'Done' },
  ]);
});

test('extracts only visible Claude conversation text', () => {
  const entries = [
    { message: { role: 'user', content: 'Build auth' } },
    { message: { role: 'assistant', content: [{ type: 'thinking', text: 'private' }, { type: 'text', text: 'Implemented auth' }] } },
    { isMeta: true, message: { role: 'user', content: 'hidden' } },
  ];
  assert.deepEqual(extractConversationPreview('claude', entries), [
    { role: 'user', text: 'Build auth' },
    { role: 'assistant', text: 'Implemented auth' },
  ]);
});
