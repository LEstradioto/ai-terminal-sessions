'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_HEARTBEAT_MS = 5000;
const DEFAULT_STALE_MS = 20000;
const DEFAULT_HANDOFF_MS = 4000;
const DEFAULT_RETRY_MS = 100;

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
        this.acquiredAt = this.now();
        const handle = await fs.promises.open(this.file, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(this.payload()), 'utf8');
        await handle.close();
        this.acquired = true;
        this.timer = setInterval(() => {
          this.renew().catch(() => {});
        }, this.heartbeatMs);
        return { acquired: true, owner: this.payload() };
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error;
        const owner = await this.readOwner();
        const heartbeatAt = Number(owner && (owner.heartbeatAt || owner.acquiredAt)) || 0;
        const heartbeatFresh = owner && this.now() - heartbeatAt <= this.staleMs;
        const ownerAlive = owner && this.processAlive(owner.pid);
        if (heartbeatFresh && ownerAlive !== false) {
          if (Date.now() < handoffDeadline) {
            await delay(Math.min(this.retryMs, handoffDeadline - Date.now()));
            continue;
          }
          return { acquired: false, owner };
        }
        await this.removeIfOwner(owner);
      }
    }
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
    if (!owner || owner.instanceId !== this.instanceId) {
      this.stop();
      return false;
    }
    this.acquiredAt = Number(owner.acquiredAt) || this.now();
    const temporary = `${this.file}.${this.instanceId}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(this.payload()), { mode: 0o600 });
    const current = await this.readOwner();
    if (!current || current.instanceId !== this.instanceId) {
      await fs.promises.unlink(temporary).catch(() => {});
      this.stop();
      return false;
    }
    await fs.promises.rename(temporary, this.file);
    return true;
  }

  async release() {
    this.stop();
    if (!this.acquired) return;
    const owner = await this.readOwner();
    if (owner && owner.instanceId === this.instanceId) {
      await fs.promises.unlink(this.file).catch((error) => {
        if (!error || error.code !== 'ENOENT') throw error;
      });
    }
    this.acquired = false;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
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
      await fs.promises.unlink(this.file).catch((error) => {
        if (!error || error.code !== 'ENOENT') throw error;
      });
    }
  }
}

function isProcessAlive(pid) {
  const candidate = Number(pid);
  if (!Number.isInteger(candidate) || candidate <= 0) return undefined;
  try {
    process.kill(candidate, 0);
    return true;
  } catch (error) {
    return error && error.code === 'ESRCH' ? false : true;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

module.exports = {
  DEFAULT_HANDOFF_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_STALE_MS,
  WorkspaceLease,
  isProcessAlive,
};
