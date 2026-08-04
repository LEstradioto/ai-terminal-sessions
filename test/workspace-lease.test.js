'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WorkspaceLease } = require('../runtime');

test('only one extension host can own a workspace lease', async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-terminal-lease-'));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'workspace.lease');
  const first = new WorkspaceLease(file, { instanceId: 'first', heartbeatMs: 60000 });
  const second = new WorkspaceLease(file, {
    instanceId: 'second', heartbeatMs: 60000, handoffMs: 0,
  });
  assert.equal((await first.acquire()).acquired, true);
  const blocked = await second.acquire();
  assert.equal(blocked.acquired, false);
  assert.equal(blocked.owner.instanceId, 'first');
  await first.release();
  assert.equal((await second.acquire()).acquired, true);
  await second.release();
});

test('a stale lease can be recovered after a crashed host', async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-terminal-stale-'));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'workspace.lease');
  await fs.promises.writeFile(file, JSON.stringify({ instanceId: 'dead', heartbeatAt: 1 }));
  const lease = new WorkspaceLease(file, {
    instanceId: 'replacement',
    heartbeatMs: 60000,
    staleMs: 100,
    now: () => 1000,
  });
  assert.equal((await lease.acquire()).acquired, true);
  await lease.release();
});

test('a fresh lease owned by a dead extension host is recovered immediately', async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-terminal-dead-pid-'));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'workspace.lease');
  await fs.promises.writeFile(file, JSON.stringify({
    instanceId: 'dead', pid: 1234, heartbeatAt: Date.now(),
  }));
  const lease = new WorkspaceLease(file, {
    instanceId: 'replacement',
    heartbeatMs: 60000,
    processAlive: () => false,
  });
  assert.equal((await lease.acquire()).acquired, true);
  await lease.release();
});

test('reload handoff waits briefly for the previous extension host to release', async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-terminal-handoff-'));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'workspace.lease');
  const first = new WorkspaceLease(file, { instanceId: 'first', heartbeatMs: 60000 });
  const second = new WorkspaceLease(file, {
    instanceId: 'second', heartbeatMs: 60000, handoffMs: 500, retryMs: 10,
  });
  assert.equal((await first.acquire()).acquired, true);
  setTimeout(() => first.release(), 30);
  assert.equal((await second.acquire()).acquired, true);
  await second.release();
});
