'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  codexSessionCacheExpired,
  codexSessionIdFromMetadata,
  codexSessionIdFromTranscriptPath,
  codexTranscriptPathsFromLsof,
  newestCodexSessionCandidate,
} = require('../transcripts');

const MAIN_ID = '019f6241-4f84-78a2-b027-c83ef34346fa';
const CHILD_ID = '019f6241-59ed-7990-911f-bcfb3bf6daa8';

test('finds only Codex transcripts opened by a process', () => {
  const home = '/Users/test/.codex';
  const main = `${home}/sessions/2026/07/14/rollout-${MAIN_ID}.jsonl`;
  const raw = [
    'p6452',
    `n${main}`,
    `n${main}`,
    `n${home}/sessions/2026/07/14/rollout-${CHILD_ID}.jsonl`,
    `n${home}/logs_2.sqlite`,
    'n/tmp/unrelated.jsonl',
  ].join('\n');
  assert.deepEqual(codexTranscriptPathsFromLsof(raw, home), [
    main,
    `${home}/sessions/2026/07/14/rollout-${CHILD_ID}.jsonl`,
  ]);
  assert.equal(codexSessionIdFromTranscriptPath(main), MAIN_ID);
});

test('uses the parent session ID recorded by a subagent transcript', () => {
  const metadata = JSON.stringify({
    type: 'session_meta',
    payload: {
      session_id: MAIN_ID,
      id: CHILD_ID,
      thread_source: 'subagent',
    },
  });
  assert.equal(codexSessionIdFromMetadata(metadata), MAIN_ID);
  assert.equal(codexSessionIdFromMetadata('{"type":"event_msg"}'), undefined);
});

test('refreshes a cached Codex session ID so compaction can rotate the transcript', () => {
  const cached = { at: 1000, sessionId: MAIN_ID };
  assert.equal(codexSessionCacheExpired(cached, 5999, 5000), false);
  assert.equal(codexSessionCacheExpired(cached, 6000, 5000), true);
});

test('chooses the newest open root session after Codex compaction', () => {
  assert.equal(newestCodexSessionCandidate([
    { sessionId: MAIN_ID, modifiedAt: 100 },
    { sessionId: CHILD_ID, modifiedAt: 200 },
  ], MAIN_ID), CHILD_ID);
  assert.equal(newestCodexSessionCandidate([], MAIN_ID), MAIN_ID);
});
