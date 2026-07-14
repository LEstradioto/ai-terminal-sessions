'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildRenameSource,
  extractRecentUserMessages,
  isAcknowledgementOnly,
  isMeaningfulRenameMessage,
  normalizeContextTitle,
  readRecentUserMessages,
  stripStatusPrefix,
} = require('../rename-context');

test('extracts the two newest meaningful Claude user messages', () => {
  const entries = [
    { message: { role: 'user', content: 'old task' } },
    { message: { role: 'assistant', content: 'done' } },
    { message: { role: 'user', content: [{ type: 'text', text: 'fix terminal restore' }] } },
    { message: { role: 'user', content: 'ok' } },
    { message: { role: 'user', content: 'persist native rename' } },
  ];
  assert.deepEqual(extractRecentUserMessages('claude', entries), [
    'fix terminal restore',
    'persist native rename',
  ]);
});

test('deduplicates Codex user messages recorded in two event formats', () => {
  const entries = [
    { type: 'event_msg', payload: { type: 'user_message', message: 'improve AI titles' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'improve AI titles' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'use the last two prompts' } },
  ];
  assert.deepEqual(extractRecentUserMessages('codex', entries), [
    'improve AI titles',
    'use the last two prompts',
  ]);
});

test('builds bounded chronological context', () => {
  const source = buildRenameSource(['first topic', 'newest topic'], 'fallback', 120);
  assert.match(source, /Recent user message 1: first topic/);
  assert.match(source, /Recent user message 2: newest topic/);
  assert.ok(source.length <= 120);
});

test('filters acknowledgements and strips terminal status icons', () => {
  assert.equal(isMeaningfulRenameMessage('pode fazer'), false);
  assert.equal(isMeaningfulRenameMessage('sim, perfeito, pode fazer'), false);
  assert.equal(isAcknowledgementOnly('yes, perfect, go ahead'), true);
  assert.equal(isAcknowledgementOnly('sí, perfecto, adelante'), true);
  assert.equal(isAcknowledgementOnly('oui, parfait, vas-y'), true);
  assert.equal(isMeaningfulRenameMessage('/doctor future-command'), false);
  assert.equal(isMeaningfulRenameMessage('pode fazer o rename persistir'), true);
  assert.equal(stripStatusPrefix('\u25cf Native Rename'), 'Native Rename');
  assert.equal(stripStatusPrefix('\u2713  AI Context'), 'AI Context');
  assert.equal(stripStatusPrefix('\ud83d\udfe1 Working Agent'), 'Working Agent');
  assert.equal(stripStatusPrefix('\ud83d\udfe2 Ready Agent'), 'Ready Agent');
  assert.equal(stripStatusPrefix('\ud83d\udfe8 Recent Note'), 'Recent Note');
  assert.equal(stripStatusPrefix('\ud83d\udfe7 Cooling Note'), 'Cooling Note');
  assert.equal(stripStatusPrefix('\ud83d\udfeb Old Note'), 'Old Note');
  assert.equal(stripStatusPrefix('○⠹ Working Agent'), 'Working Agent');
  assert.equal(normalizeContextTitle('Video Ads'), 'video ads');
  assert.equal(normalizeContextTitle('FAVICON Gen.'), 'favicon gen');
});

test('streams the full transcript when recent prompts are outside the old 512 KB tail', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-terminal-rename-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'large.jsonl');
  const entries = [
    { type: 'event_msg', payload: { type: 'user_message', message: 'improve the pricing page' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(700 * 1024) } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'fix the mobile navigation' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'y'.repeat(700 * 1024) } },
  ];
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

  const result = await readRecentUserMessages('codex', file, 2);
  assert.deepEqual(result.messages, [
    'improve the pricing page',
    'fix the mobile navigation',
  ]);
  assert.ok(result.bytesRead > 1024 * 1024);
});
