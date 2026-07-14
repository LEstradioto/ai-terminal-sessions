'use strict';

const SESSION_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];
const TITLES = ['video ads', 'favicon gen', 'auth solving', 'ci watch'];
const STATUSES = ['running', 'done', 'waiting', 'running'];

async function seedDemo(manager) {
  if (manager.records.size) return false;
  const now = Date.now();
  for (let index = 0; index < SESSION_IDS.length; index += 1) {
    const sessionId = SESSION_IDS[index];
    manager.createRecord({
      manualTitle: TITLES[index],
      autoTitle: TITLES[index],
      status: STATUSES[index],
      readyAt: index === 1 ? now : 0,
      monitorPinned: index === 0 || index === 3,
      monitorPinnedAt: index === 0 || index === 3 ? now + index : 0,
      windows: [{
        index: 0,
        name: 'shell',
        active: true,
        panes: [{
          index: 0,
          cwd: manager.workspaceKey.replace(/^file:\/\//, ''),
          active: true,
          agent: { type: 'codex', sessionId, active: true },
        }],
      }],
    });
  }
  await manager.persist('demo-seed');
  return true;
}

module.exports = { seedDemo };
