'use strict';

const fs = require('node:fs');
const path = require('node:path');

const directory = process.argv[2];
if (!directory) throw new Error('Expected the demo transcript directory');

const offsets = new Map([
  ['11111111-1111-4111-8111-111111111111', [-92_000, -90_000]],
  ['22222222-2222-4222-8222-222222222222', [-45_000, -15_000]],
  ['33333333-3333-4333-8333-333333333333', [-40_000, -35_000]],
  ['44444444-4444-4444-8444-444444444444', [-22_000, -20_000]],
]);
const now = Date.now();

for (const name of fs.readdirSync(directory)) {
  const matching = [...offsets].find(([sessionId]) => name.includes(sessionId));
  if (!matching) continue;
  const file = path.join(directory, name);
  const entries = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const timeline = matching[1];
  const output = entries.map((entry, index) => JSON.stringify({
    ...entry,
    timestamp: new Date(now + (timeline[index] ?? timeline[timeline.length - 1])).toISOString(),
  })).join('\n');
  fs.writeFileSync(file, `${output}\n`, { mode: 0o600 });
}
