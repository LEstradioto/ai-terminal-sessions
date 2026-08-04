'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  applyVisualOrder,
  recordIdsForTabLabels,
  sortRecordsForRestore,
} = require('../session-state');

test('restores records in captured horizontal tab order', () => {
  const records = [
    { id: 'created-first', createdAt: 1, tabOrder: 2 },
    { id: 'visual-first', createdAt: 3, tabOrder: 0 },
    { id: 'visual-middle', createdAt: 2, tabOrder: 1 },
  ];
  assert.deepEqual(sortRecordsForRestore(records).map((record) => record.id), [
    'visual-first', 'visual-middle', 'created-first',
  ]);
});

test('maps visual labels to managed records with stable duplicate-title matching', () => {
  const ids = recordIdsForTabLabels(['Build', 'Auth', 'Build'], [
    { id: 'build-two', name: 'Build', tabOrder: 2, createdAt: 2 },
    { id: 'auth', name: 'Auth', tabOrder: 1, createdAt: 3 },
    { id: 'build-one', name: 'Build', tabOrder: 0, createdAt: 1 },
  ]);
  assert.deepEqual(ids, ['build-one', 'auth', 'build-two']);
});

test('writes the observed order only to matching records', () => {
  const records = new Map([
    ['a', { id: 'a', tabOrder: 3 }],
    ['b', { id: 'b', tabOrder: 4 }],
    ['panel', { id: 'panel', tabOrder: 9 }],
  ]);
  assert.equal(applyVisualOrder(records, ['b', 'a']), true);
  assert.equal(records.get('b').tabOrder, 0);
  assert.equal(records.get('a').tabOrder, 1);
  assert.equal(records.get('panel').tabOrder, 9);
  assert.equal(applyVisualOrder(records, ['b', 'a']), false);
});
