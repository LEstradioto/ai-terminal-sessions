'use strict';

const path = require('node:path');

const RELOCATION_VERSION = 1;

function relocationBundle(options = {}) {
  const workspaceKey = String(options.workspaceKey || '');
  const roots = normalizeRoots(options.roots);
  if (!workspaceKey || !roots.length) throw new Error('A workspace and at least one root are required');
  return {
    version: RELOCATION_VERSION,
    id: String(options.id || `${Number(options.createdAt) || Date.now()}`),
    createdAt: Number(options.createdAt) || Date.now(),
    sourceWorkspaceKey: workspaceKey,
    sourceRoots: roots,
    records: clone(Array.isArray(options.records) ? options.records : []),
    drafts: clone(options.drafts && typeof options.drafts === 'object' ? options.drafts : {}),
    snapshots: clone(Array.isArray(options.snapshots) ? options.snapshots : []),
    archive: clone(Array.isArray(options.archive) ? options.archive : []),
  };
}

function normalizeRelocationBundle(raw) {
  if (!raw || raw.version !== RELOCATION_VERSION || !raw.sourceWorkspaceKey) return undefined;
  const sourceRoots = normalizeRoots(raw.sourceRoots);
  if (!sourceRoots.length || !Array.isArray(raw.records)) return undefined;
  return relocationBundle({
    ...raw,
    workspaceKey: raw.sourceWorkspaceKey,
    roots: sourceRoots,
  });
}

function relocateWorkspaceBundle(raw, targetWorkspaceKey, targetRoots) {
  const bundle = normalizeRelocationBundle(raw);
  const targets = normalizeRoots(targetRoots);
  if (!bundle) throw new Error('The relocation bundle is invalid');
  if (!targetWorkspaceKey || !targets.length) throw new Error('The target workspace has no local folder');
  const mappings = mapRoots(bundle.sourceRoots, targets);
  const relocateRecord = (record) => relocateSessionRecord(record, targetWorkspaceKey, mappings);
  return {
    ...bundle,
    targetWorkspaceKey,
    targetRoots: targets,
    records: bundle.records.map(relocateRecord),
    snapshots: bundle.snapshots.map((snapshot) => ({
      ...clone(snapshot),
      records: Array.isArray(snapshot && snapshot.records)
        ? snapshot.records.map(relocateRecord)
        : [],
    })),
    archive: bundle.archive.map((entry) => ({
      ...clone(entry),
      record: entry && entry.record ? relocateRecord(entry.record) : entry.record,
    })),
  };
}

function relocateSessionRecord(raw, workspaceKey, mappings) {
  const record = clone(raw || {});
  record.workspaceKey = workspaceKey;
  record.cwd = relocatePath(record.cwd, mappings);
  record.windows = Array.isArray(record.windows) ? record.windows.map((window) => ({
    ...window,
    panes: Array.isArray(window.panes) ? window.panes.map((pane) => ({
      ...pane,
      cwd: relocatePath(pane.cwd, mappings),
    })) : [],
  })) : [];
  return record;
}

function relocatePath(value, mappings) {
  const current = String(value || '');
  if (!current || !path.isAbsolute(current)) return current;
  for (const mapping of mappings) {
    const relative = path.relative(mapping.source, current);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return path.join(mapping.target, relative);
    }
  }
  return current;
}

function mapRoots(sourceRoots, targetRoots) {
  if (sourceRoots.length !== targetRoots.length) {
    throw new Error(`The workspace root count changed from ${sourceRoots.length} to ${targetRoots.length}`);
  }
  const available = [...targetRoots];
  const mappings = [];
  for (const source of sourceRoots) {
    let index = available.findIndex((target) => target.name === source.name);
    if (index < 0 && available.length === 1) index = 0;
    if (index < 0) {
      throw new Error(`Could not match the relocated workspace folder ${source.name}`);
    }
    const [target] = available.splice(index, 1);
    mappings.push({ source: source.fsPath, target: target.fsPath });
  }
  return mappings.sort((left, right) => right.source.length - left.source.length);
}

function normalizeRoots(roots) {
  return (Array.isArray(roots) ? roots : []).flatMap((root, index) => {
    const fsPath = String(root && root.fsPath || '').trim();
    if (!fsPath || !path.isAbsolute(fsPath)) return [];
    return [{
      name: String(root && root.name || `root-${index + 1}`).slice(0, 200),
      fsPath: path.resolve(fsPath),
    }];
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  RELOCATION_VERSION,
  mapRoots,
  normalizeRelocationBundle,
  relocatePath,
  relocateSessionRecord,
  relocateWorkspaceBundle,
  relocationBundle,
};
