'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  archivePayload,
  migrateSnapshotsToArchive,
  normalizeArchivePayload,
  upsertArchivedSession,
} = require('../session-archive');

function record(id, sessionId = '') {
  return {
    id,
    workspaceKey: 'workspace',
    tmuxSession: `tmux-${id}`,
    cwd: '/tmp/project',
    manualTitle: id,
    createdAt: 1,
    windows: [{
      index: 0,
      panes: [{
        index: 0,
        cwd: '/tmp/project',
        active: true,
        ...(sessionId && { agent: { type: 'codex', sessionId, active: true } }),
      }],
    }],
  };
}

test('archives one entry per resumable agent session and keeps the newest preview', () => {
  const sessionId = '11111111-1111-1111-1111-111111111111';
  const first = upsertArchivedSession([], record('pricing', sessionId), {
    archivedAt: 100,
    closeAction: 'kill',
    preview: [{ role: 'user', text: 'pricing page' }],
  });
  const second = upsertArchivedSession(first.entries, record('renamed', sessionId), {
    archivedAt: 200,
    closeAction: 'forget',
    preview: [{ role: 'assistant', text: 'done' }],
  });
  assert.equal(second.entries.length, 1);
  assert.equal(second.entries[0].title, 'renamed');
  assert.deepEqual(second.entries[0].preview, [
    { role: 'user', text: 'pricing page' },
    { role: 'assistant', text: 'done' },
  ]);
});

test('migrates missing records from snapshots but excludes active sessions', () => {
  const snapshots = [{
    savedAt: 1000,
    records: [record('closed'), record('active')],
  }];
  const result = migrateSnapshotsToArchive([], snapshots, [record('active')]);
  assert.deepEqual(result.entries.map((entry) => entry.title), ['closed']);
});

test('archive payload is workspace scoped and bounded', () => {
  let entries = [];
  for (let index = 0; index < 4; index += 1) {
    entries = upsertArchivedSession(entries, record(`s${index}`), {
      archivedAt: index + 1,
      maxEntries: 3,
    }).entries;
  }
  const payload = archivePayload('workspace', entries, 5000);
  assert.equal(normalizeArchivePayload(payload, 'workspace').length, 3);
  assert.equal(normalizeArchivePayload(payload, 'other').length, 0);
});
