'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isSerializedTerminalStubLabel,
  normalizedTerminalLabel,
  staleManagedTerminalTabs,
} = require('../workbench-recovery');

const STORAGE_ID = 'db259a869948f21b098259c1943b5733';

test('recognizes unresolved terminal editor labels from the current workspace storage', () => {
  assert.equal(isSerializedTerminalStubLabel(`${STORAGE_ID}1`, STORAGE_ID), true);
  assert.equal(isSerializedTerminalStubLabel(`${STORAGE_ID}42`, STORAGE_ID), true);
});

test('does not close named terminals or another workspace terminal stub', () => {
  assert.equal(isSerializedTerminalStubLabel('CI Watch', STORAGE_ID), false);
  assert.equal(isSerializedTerminalStubLabel('db259a869948f21b098259c1943b57341', STORAGE_ID), false);
  assert.equal(isSerializedTerminalStubLabel(`${STORAGE_ID}1`, 'not-a-storage-id'), false);
});

test('finds duplicate managed terminal tabs while preserving identified live tabs', () => {
  const oldMarketing = { label: '● marketing' };
  const liveMarketing = { label: '○ ⠋ marketing' };
  const oldFinance = { label: '🟡 finance' };
  const liveFinance = { label: '🟨 finance' };
  const unrelated = { label: 'server logs' };
  const tabs = [oldMarketing, liveMarketing, oldFinance, liveFinance, unrelated];
  const liveTabs = new Set([liveMarketing, liveFinance]);

  assert.equal(normalizedTerminalLabel('○ ⠋ Marketing'), 'marketing');
  assert.deepEqual(
    staleManagedTerminalTabs(tabs, liveTabs, ['marketing', 'Finance']),
    [oldMarketing, oldFinance],
  );
});
