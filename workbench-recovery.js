'use strict';

const { stripStatusPrefix } = require('./rename-context');

function isSerializedTerminalStubLabel(label, workspaceStorageId) {
  const storageId = String(workspaceStorageId || '');
  if (!/^[0-9a-f]{32}$/i.test(storageId)) return false;
  return new RegExp(`^${storageId}\\d+$`, 'i').test(String(label || ''));
}

function normalizedTerminalLabel(value) {
  return stripStatusPrefix(String(value || '')).trim().toLocaleLowerCase();
}

function staleManagedTerminalTabs(terminalTabs, liveTabs, managedTitles) {
  const normalizedTitles = new Set(
    managedTitles.map(normalizedTerminalLabel).filter(Boolean),
  );
  return terminalTabs.filter((tab) => (
    !liveTabs.has(tab) && normalizedTitles.has(normalizedTerminalLabel(tab.label))
  ));
}

module.exports = {
  isSerializedTerminalStubLabel,
  normalizedTerminalLabel,
  staleManagedTerminalTabs,
};
