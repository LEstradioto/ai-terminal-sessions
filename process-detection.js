'use strict';

const path = require('node:path');

function commandExecutable(command) {
  const match = String(command || '').trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return match && (match[1] || match[2] || match[3]);
}

function executableBases(processInfo) {
  return [processInfo && processInfo.comm, commandExecutable(processInfo && processInfo.command)]
    .filter(Boolean)
    .map((value) => path.basename(String(value)).toLocaleLowerCase());
}

function matchesExecutable(processInfo, expected) {
  const name = String(expected || '').toLocaleLowerCase();
  return executableBases(processInfo).some((base) => (
    base === name || base.startsWith(`${name}-`)
  ));
}

module.exports = { commandExecutable, executableBases, matchesExecutable };
