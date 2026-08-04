'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeRelocationBundle,
  relocatePath,
  relocateWorkspaceBundle,
  relocationBundle,
} = require('../session-recovery');

function sampleBundle() {
  return relocationBundle({
    id: 'move-1',
    createdAt: 100,
    workspaceKey: 'file:///Users/dev/project',
    roots: [{ name: 'project', fsPath: '/Users/dev/project' }],
    records: [{
      id: 'record-1',
      workspaceKey: 'file:///Users/dev/project',
      tmuxSession: 'vsc-project-123',
      cwd: '/Users/dev/project',
      windows: [{ panes: [
        { cwd: '/Users/dev/project/apps/web' },
        { cwd: '/tmp/outside' },
      ] }],
    }],
    drafts: { 'record-1': { text: 'unfinished', capturedAt: 90 } },
    snapshots: [{ records: [{
      id: 'record-1',
      cwd: '/Users/dev/project/old',
      windows: [],
    }] }],
    archive: [{ record: {
      id: 'closed-1',
      cwd: '/Users/dev/project/archive',
      windows: [],
    } }],
  });
}

test('rewrites workspace paths while preserving external paths and recovery data', () => {
  const relocated = relocateWorkspaceBundle(
    sampleBundle(),
    'file:///Volumes/Code/project',
    [{ name: 'project', fsPath: '/Volumes/Code/project' }],
  );
  assert.equal(relocated.records[0].workspaceKey, 'file:///Volumes/Code/project');
  assert.equal(relocated.records[0].cwd, '/Volumes/Code/project');
  assert.equal(relocated.records[0].windows[0].panes[0].cwd, '/Volumes/Code/project/apps/web');
  assert.equal(relocated.records[0].windows[0].panes[1].cwd, '/tmp/outside');
  assert.equal(relocated.snapshots[0].records[0].cwd, '/Volumes/Code/project/old');
  assert.equal(relocated.archive[0].record.cwd, '/Volumes/Code/project/archive');
  assert.equal(relocated.drafts['record-1'].text, 'unfinished');
});

test('matches multi-root workspaces by folder name instead of order', () => {
  const bundle = relocationBundle({
    workspaceKey: 'file:///old/project.code-workspace',
    roots: [
      { name: 'api', fsPath: '/old/api' },
      { name: 'web', fsPath: '/old/web' },
    ],
    records: [],
  });
  const relocated = relocateWorkspaceBundle(bundle, 'file:///new/project.code-workspace', [
    { name: 'web', fsPath: '/new/web' },
    { name: 'api', fsPath: '/new/api' },
  ]);
  assert.equal(relocatePath('/old/api/app', [
    { source: '/old/api', target: '/new/api' },
  ]), '/new/api/app');
  assert.deepEqual(relocated.targetRoots.map((root) => root.name), ['web', 'api']);
});

test('rejects malformed bundles and unmatched workspace roots', () => {
  assert.equal(normalizeRelocationBundle({ version: 99 }), undefined);
  assert.throws(() => relocationBundle({
    workspaceKey: 'file:///workspace',
    roots: [{ name: 'missing', fsPath: '' }],
  }), /at least one root/);
  assert.throws(() => relocateWorkspaceBundle(sampleBundle(), 'new', [
    { name: 'one', fsPath: '/new/one' },
    { name: 'two', fsPath: '/new/two' },
  ]), /root count changed/);
});
