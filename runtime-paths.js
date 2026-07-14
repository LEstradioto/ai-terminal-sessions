'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolveExecutable(configured, command) {
  const value = String(configured || command || '').replace(/^~(?=\/)/, os.homedir());
  if (value.includes(path.sep)) return value;
  const name = value || command;
  const match = String(process.env.PATH || '').split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, name))
    .find((candidate) => {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  return match || name;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function redactPath(value) {
  const text = String(value || '');
  const home = os.homedir();
  return home && text.startsWith(home) ? `~${text.slice(home.length)}` : text;
}

function redactDiagnostic(value) {
  return redactPath(value)
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[redacted-email]')
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '[redacted-id]')
    .replace(/("?(?:email|orgId|organizationId|accountId|userId)"?\s*[:=]\s*)[^,}\s]+/gi, '$1[redacted]');
}

function terminalProfileSetting(platform = process.platform) {
  return {
    darwin: 'defaultProfile.osx',
    linux: 'defaultProfile.linux',
    win32: 'defaultProfile.windows',
  }[platform];
}

module.exports = {
  redactDiagnostic,
  redactPath,
  resolveExecutable,
  shellQuote,
  terminalProfileSetting,
};
