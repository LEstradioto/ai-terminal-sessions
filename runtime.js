'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');

const STATUS_PREFIX_RE = /^(?:(?:○\s*[\u2800-\u28ff]?|[●◉✓⚠×⚪🟡🟠🟢🟧🟨🟫🔴])\s*)+/u;
const DEFAULT_HEARTBEAT_MS = 5000;
const DEFAULT_STALE_MS = 20000;
const DEFAULT_HANDOFF_MS = 4000;
const DEFAULT_RETRY_MS = 100;

const COMMANDS = Object.freeze({
  main: 'workbench.action.switchToMainWindow',
  restore: 'workbench.action.restoreEditorsToMainWindow',
});

class WorkbenchWindowAdapter {
  constructor(vscode, log, wait, commandTimeoutMs = 1500) {
    this.vscode = vscode;
    this.log = log;
    this.wait = wait;
    this.commandTimeoutMs = commandTimeoutMs;
    this.commandSetPromise = undefined;
  }

  commandSet() {
    if (!this.commandSetPromise) {
      this.commandSetPromise = this.vscode.commands.getCommands(true).then((items) => new Set(items));
    }
    return this.commandSetPromise;
  }

  async run(command, required = false) {
    const available = await this.commandSet();
    if (!available.has(command)) {
      this.log('workbench-capability', new Error(`${command} is not available`));
      if (required) throw new Error(`This VS Code build does not support ${command}`);
      return false;
    }
    await Promise.race([
      this.vscode.commands.executeCommand(command),
      this.wait(this.commandTimeoutMs).then(() => {
        throw new Error(`${command} timed out`);
      }),
    ]);
    return true;
  }

  async switchToMainWindow() {
    return this.run(COMMANDS.main);
  }

  async restoreEditorsToMainWindow() {
    return this.run(COMMANDS.restore);
  }
}

function resolveExecutable(configured, command) {
  const value = String(configured || command || '').replace(/^~(?=\/)/, os.homedir());
  if (value.includes(path.sep)) return value;
  const name = value || command;
  const match = String(process.env.PATH || '').split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, name))
    .find(isExecutable);
  return match || name;
}

function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function configuredExecutable(config, name) {
  const executables = config.get('executables', {});
  const legacy = config.get(`${name}Path`);
  const configured = executables && typeof executables === 'object'
    ? executables[name]
    : undefined;
  return resolveExecutable(legacy || configured || name, name);
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

function defaultWorkspaceCwd(vscode) {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) return folder.uri.fsPath;
  }
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders[0] ? folders[0].uri.fsPath : os.homedir();
}

function existingDirectory(candidate, fallback = os.homedir()) {
  try {
    if (candidate && fs.statSync(candidate).isDirectory()) return candidate;
  } catch {}
  return fallback;
}

function messageOf(error) {
  if (!error) return 'unknown error';
  return error.stderr || error.message || String(error);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

function execFileCapture(file, args, options = {}) {
  return execFileResult(file, args, options).then(({ stdout, stderr }) => ({
    stdout: String(stdout || '').trim(),
    stderr: String(stderr || '').trim(),
  }));
}

function execFileText(file, args, options = {}) {
  return execFileResult(file, args, options).then(({ stdout }) => String(stdout || '').trimEnd());
}

function execFileResult(file, args, options) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, processOptions(options), (error, stdout, stderr) => {
      if (error) return reject(processError(error, stdout, stderr));
      resolve({ stdout, stderr });
    });
  });
}

function execFileInputText(file, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.execFile(file, args, processOptions(options), (error, stdout, stderr) => {
      if (error) return reject(processError(error, stdout, stderr));
      resolve(String(stdout || '').trimEnd());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(String(input || ''));
  });
}

function processOptions(options) {
  return { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...options };
}

function processError(error, stdout, stderr) {
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

function isSerializedTerminalStubLabel(label, workspaceStorageId) {
  const storageId = String(workspaceStorageId || '');
  if (!/^[0-9a-f]{32}$/i.test(storageId)) return false;
  return new RegExp(`^${storageId}\\d+$`, 'i').test(String(label || ''));
}

function normalizedTerminalLabel(value) {
  return stripStatusPrefix(String(value || '')).trim().toLocaleLowerCase();
}

function stripStatusPrefix(value) {
  return String(value || '').replace(STATUS_PREFIX_RE, '').replace(/\s+/g, ' ').trim();
}

function staleManagedTerminalTabs(terminalTabs, liveTabs, managedTitles) {
  const normalizedTitles = new Set(managedTitles.map(normalizedTerminalLabel).filter(Boolean));
  return terminalTabs.filter((tab) => (
    !liveTabs.has(tab) && normalizedTitles.has(normalizedTerminalLabel(tab.label))
  ));
}

class WorkspaceLease {
  constructor(file, options = {}) {
    this.file = file;
    this.instanceId = options.instanceId || crypto.randomUUID();
    this.pid = Number(options.pid) || process.pid;
    this.heartbeatMs = Number(options.heartbeatMs) || DEFAULT_HEARTBEAT_MS;
    this.staleMs = Number(options.staleMs) || DEFAULT_STALE_MS;
    this.handoffMs = options.handoffMs === undefined
      ? DEFAULT_HANDOFF_MS
      : Math.max(0, Number(options.handoffMs) || 0);
    this.retryMs = options.retryMs === undefined
      ? DEFAULT_RETRY_MS
      : Math.max(10, Number(options.retryMs) || DEFAULT_RETRY_MS);
    this.now = options.now || Date.now;
    this.processAlive = options.processAlive || isProcessAlive;
    this.timer = undefined;
    this.acquired = false;
  }

  async acquire() {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const handoffDeadline = Date.now() + this.handoffMs;
    while (true) {
      try {
        await this.createLease();
        return { acquired: true, owner: this.payload() };
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error;
        const owner = await this.readOwner();
        if (this.isCurrentOwner(owner)) {
          if (Date.now() >= handoffDeadline) return { acquired: false, owner };
          await delay(Math.min(this.retryMs, handoffDeadline - Date.now()));
        } else {
          await this.removeIfOwner(owner);
        }
      }
    }
  }

  async createLease() {
    this.acquiredAt = this.now();
    const handle = await fs.promises.open(this.file, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(this.payload()), 'utf8');
    await handle.close();
    this.acquired = true;
    this.timer = setInterval(() => this.renew().catch(() => {}), this.heartbeatMs);
  }

  isCurrentOwner(owner) {
    const heartbeatAt = Number(owner && (owner.heartbeatAt || owner.acquiredAt)) || 0;
    const heartbeatFresh = owner && this.now() - heartbeatAt <= this.staleMs;
    return heartbeatFresh && this.processAlive(owner.pid) !== false;
  }

  payload() {
    return {
      version: 1,
      instanceId: this.instanceId,
      pid: this.pid,
      acquiredAt: this.acquiredAt || this.now(),
      heartbeatAt: this.now(),
    };
  }

  async renew() {
    if (!this.acquired) return false;
    const owner = await this.readOwner();
    if (!owner || owner.instanceId !== this.instanceId) return this.stop(false);
    this.acquiredAt = Number(owner.acquiredAt) || this.now();
    const temporary = `${this.file}.${this.instanceId}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(this.payload()), { mode: 0o600 });
    const current = await this.readOwner();
    if (!current || current.instanceId !== this.instanceId) {
      await fs.promises.unlink(temporary).catch(() => {});
      return this.stop(false);
    }
    await fs.promises.rename(temporary, this.file);
    return true;
  }

  async release() {
    this.stop();
    if (!this.acquired) return;
    const owner = await this.readOwner();
    if (owner && owner.instanceId === this.instanceId) {
      await fs.promises.unlink(this.file).catch(ignoreMissingFile);
    }
    this.acquired = false;
  }

  stop(result) {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    return result;
  }

  async readOwner() {
    try {
      return JSON.parse(await fs.promises.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error instanceof SyntaxError)) return undefined;
      throw error;
    }
  }

  async removeIfOwner(expected) {
    const current = await this.readOwner();
    if ((!expected && !current) || (expected && current && expected.instanceId === current.instanceId)) {
      await fs.promises.unlink(this.file).catch(ignoreMissingFile);
    }
  }
}

function ignoreMissingFile(error) {
  if (!error || error.code !== 'ENOENT') throw error;
}

function isProcessAlive(pid) {
  const candidate = Number(pid);
  if (!Number.isInteger(candidate) || candidate <= 0) return undefined;
  try {
    process.kill(candidate, 0);
    return true;
  } catch (error) {
    return error && error.code !== 'ESRCH';
  }
}

module.exports = {
  COMMANDS,
  DEFAULT_HANDOFF_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_STALE_MS,
  WorkbenchWindowAdapter,
  WorkspaceLease,
  configuredExecutable,
  defaultWorkspaceCwd,
  delay,
  existingDirectory,
  execFileCapture,
  execFileInputText,
  execFileText,
  isSerializedTerminalStubLabel,
  isProcessAlive,
  messageOf,
  normalizedTerminalLabel,
  redactDiagnostic,
  redactPath,
  resolveExecutable,
  shellQuote,
  staleManagedTerminalTabs,
  stripStatusPrefix,
  terminalProfileSetting,
};
