'use strict';

function numericOrder(record) {
  return Number.isFinite(record && record.tabOrder) ? record.tabOrder : Number.MAX_SAFE_INTEGER;
}

function compareSessionOrder(left, right) {
  return numericOrder(left) - numericOrder(right)
    || (Number(left && left.createdAt) || 0) - (Number(right && right.createdAt) || 0)
    || String(left && left.id || '').localeCompare(String(right && right.id || ''));
}

function sortRecordsForRestore(records) {
  return [...records].sort(compareSessionOrder);
}

function recordIdsForTabLabels(tabLabels, terminals) {
  const byName = new Map();
  for (const terminal of terminals) {
    if (!terminal || !terminal.id || !terminal.name) continue;
    const bucket = byName.get(terminal.name) || [];
    bucket.push(terminal);
    byName.set(terminal.name, bucket);
  }
  for (const bucket of byName.values()) bucket.sort(compareSessionOrder);

  const ids = [];
  for (const label of tabLabels) {
    const bucket = byName.get(label);
    if (!bucket || !bucket.length) continue;
    ids.push(bucket.shift().id);
  }
  return ids;
}

function applyVisualOrder(records, orderedIds) {
  let changed = false;
  orderedIds.forEach((recordId, index) => {
    const record = records.get(recordId);
    if (!record || record.tabOrder === index) return;
    record.tabOrder = index;
    changed = true;
  });
  return changed;
}

module.exports = {
  applyVisualOrder,
  compareSessionOrder,
  recordIdsForTabLabels,
  sortRecordsForRestore,
};
