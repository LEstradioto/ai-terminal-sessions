'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileText, messageOf, resolveExecutable } = require('./runtime');
const {
  codexHome,
  codexSessionCacheExpired,
  codexSessionIdFromMetadata,
  codexSessionIdFromTranscriptPath,
  codexTranscriptPathsFromLsof,
  encodeClaudeProject,
  findFileEndingWith,
  inspectClaudeTranscript,
  inspectCodexTranscript,
  newestCodexSessionCandidate,
  readFilePrefix,
  turnTimingFields,
} = require('./transcripts');

const CODEX_SESSION_REFRESH_MS = 5000;
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

class AgentObserver {
  constructor(options) {
    this.options = options;
    this.codexPidCache = new Map();
    this.codexTranscriptCache = new Map();
    this.codexThreadNames = new Map();
    this.codexIndexMtime = 0;
  }

  log(scope, error) {
    this.options.log(scope, error);
  }

  async detectAgent(pane, processTable, now, record, previousAgent) {
    const processes = descendantsOf(Number(pane.pid), processTable);
    const claudeCandidates = processes.filter((item) => matchesExecutable(item, 'claude'));
    for (const processInfo of claudeCandidates) {
      const agent = await this.resolveClaudeAgent(processInfo, pane, now);
      if (agent) return agent;
    }

    const codexCandidates = processes.filter((item) => matchesExecutable(item, 'codex'));
    for (const processInfo of codexCandidates) {
      const agent = await this.resolveCodexAgent(processInfo, pane, now, record, previousAgent);
      if (agent) return agent;
    }
    return undefined;
  }

  async resolveClaudeAgent(processInfo, pane, now) {
    let metadata;
    try {
      const file = path.join(os.homedir(), '.claude', 'sessions', `${processInfo.pid}.json`);
      metadata = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    } catch {
      metadata = {};
    }
    const argId = processInfo.command.match(/--session-id\s+([0-9a-f-]{36})/i)?.[1];
    const sessionId = metadata.sessionId || argId;
    if (!UUID_RE.test(sessionId || '')) {
      return {
        type: 'claude', sessionId: '', pid: processInfo.pid, process: 'claude',
        status: 'idle', title: 'Claude Code', active: true, lastSeenAt: now,
      };
    }

    const cwd = metadata.cwd || pane.cwd;
    const transcript = path.join(
      os.homedir(), '.claude', 'projects', encodeClaudeProject(cwd), `${sessionId}.jsonl`,
    );
    const journal = await inspectClaudeTranscript(transcript, metadata.status);
    return {
      type: 'claude',
      sessionId,
      pid: processInfo.pid,
      process: 'claude',
      status: journal.status,
      title: metadata.name || journal.title || path.basename(cwd),
      transcript,
      active: true,
      lastSeenAt: now,
      lastActivityAt: journal.lastActivityAt,
      ...turnTimingFields(journal),
    };
  }

  async resolveCodexAgent(processInfo, pane, now, record, previousAgent) {
    const cacheKey = `${processInfo.pid}:${processInfo.command}`;
    const cached = this.codexPidCache.get(cacheKey);
    let sessionId = cached && cached.sessionId;
    if (codexSessionCacheExpired(cached, now, CODEX_SESSION_REFRESH_MS)) {
      const argId = processInfo.command.match(/\bresume\s+([0-9a-f-]{36})\b/i)?.[1];
      const detected = await this.queryCodexSessionId(
        processInfo.pid,
        previousAgent && previousAgent.sessionId || codexSessionHint(record),
      );
      sessionId = UUID_RE.test(detected || '')
        ? detected
        : UUID_RE.test(argId || '') ? argId : sessionId;
      this.codexPidCache.set(cacheKey, { at: now, sessionId });
    }
    if (!UUID_RE.test(sessionId || '')) {
      return {
        type: 'codex', sessionId: '', pid: processInfo.pid, process: 'codex',
        status: 'idle', title: 'Codex', active: true, lastSeenAt: now,
      };
    }

    const transcript = await this.codexTranscript(sessionId);
    const journal = await inspectCodexTranscript(transcript);
    return {
      type: 'codex',
      sessionId,
      pid: processInfo.pid,
      process: 'codex',
      status: journal.status,
      title: this.codexThreadNames.get(sessionId) || journal.title || path.basename(pane.cwd),
      transcript,
      active: true,
      lastSeenAt: now,
      lastActivityAt: journal.lastActivityAt,
      ...turnTimingFields(journal),
    };
  }

  async queryCodexSessionId(pid, preferredSessionId) {
    const db = codexLogDatabase();
    if (db) {
      const query = `SELECT thread_id FROM logs WHERE process_uuid LIKE 'pid:${Number(pid)}:%' AND thread_id IS NOT NULL ORDER BY ts DESC LIMIT 1;`;
      try {
        const raw = await execFileText(resolveExecutable('sqlite3', 'sqlite3'), [
          '-readonly', '-noheader', '-cmd', '.timeout 100', db, query,
        ], { timeout: 2000 });
        const sessionId = raw.trim().split('\n')
          .find((line) => UUID_RE.test(line.trim()))?.trim();
        if (sessionId) return sessionId;
      } catch (error) {
        this.log('codex-sqlite', error);
      }
    }
    return this.queryCodexOpenSessionId(pid, preferredSessionId);
  }

  async codexTranscript(sessionId) {
    let transcript = this.codexTranscriptCache.get(sessionId);
    if (transcript && fs.existsSync(transcript)) return transcript;
    transcript = await findFileEndingWith(path.join(codexHome(), 'sessions'), `${sessionId}.jsonl`);
    if (transcript) this.codexTranscriptCache.set(sessionId, transcript);
    return transcript;
  }

  async transcriptFor(record, agent) {
    if (!agent) return undefined;
    if (agent.transcript && fs.existsSync(agent.transcript)) return agent.transcript;
    if (agent.type === 'codex' && UUID_RE.test(agent.sessionId || '')) {
      agent.transcript = await this.codexTranscript(agent.sessionId);
      return agent.transcript;
    }
    if (agent.type !== 'claude' || !UUID_RE.test(agent.sessionId || '')) return undefined;
    const pane = paneForAgent(record, agent);
    if (!pane || !pane.cwd) return undefined;
    const transcript = path.join(
      os.homedir(), '.claude', 'projects', encodeClaudeProject(pane.cwd), `${agent.sessionId}.jsonl`,
    );
    if (fs.existsSync(transcript)) agent.transcript = transcript;
    return agent.transcript;
  }

  async queryCodexOpenSessionId(pid, preferredSessionId) {
    let raw;
    try {
      raw = await execFileText(resolveExecutable('lsof', 'lsof'), [
        '-p', String(Number(pid)), '-Fn',
      ], { timeout: 2000 });
    } catch {
      return undefined;
    }
    const transcripts = codexTranscriptPathsFromLsof(raw, codexHome());
    if (!transcripts.length) return undefined;
    const candidates = [];
    for (const transcript of transcripts) {
      try {
        const [prefix, stat] = await Promise.all([
          readFilePrefix(transcript),
          fs.promises.stat(transcript),
        ]);
        const sessionId = codexSessionIdFromMetadata(prefix)
          || codexSessionIdFromTranscriptPath(transcript);
        if (sessionId) candidates.push({ sessionId, modifiedAt: stat.mtimeMs });
      } catch {}
    }
    return newestCodexSessionCandidate(candidates, preferredSessionId);
  }

  async loadCodexThreadNames() {
    const file = path.join(codexHome(), 'session_index.jsonl');
    let stat;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      return;
    }
    if (stat.mtimeMs === this.codexIndexMtime) return;
    const names = new Map();
    const text = await fs.promises.readFile(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.id && item.thread_name) names.set(item.id, item.thread_name);
      } catch {}
    }
    this.codexThreadNames = names;
    this.codexIndexMtime = stat.mtimeMs;
  }
}

function paneForAgent(record, agent) {
  return (record.windows || []).flatMap((window) => window.panes || [])
    .find((pane) => pane.agent && pane.agent.type === agent.type
      && pane.agent.sessionId === agent.sessionId);
}

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

async function readProcessTable() {
  let raw = '';
  try {
    raw = await execFileText(resolveExecutable('ps', 'ps'), [
      '-axo', 'pid=,ppid=,comm=,command=',
    ], { timeout: 3000 });
  } catch {
    return { byPid: new Map(), children: new Map() };
  }
  const byPid = new Map();
  const children = new Map();
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const item = { pid: Number(match[1]), ppid: Number(match[2]), comm: match[3], command: match[4] };
    byPid.set(item.pid, item);
    if (!children.has(item.ppid)) children.set(item.ppid, []);
    children.get(item.ppid).push(item);
  }
  return { byPid, children };
}

function descendantsOf(rootPid, table) {
  const root = table.byPid.get(rootPid);
  const result = root ? [root] : [];
  let frontier = root ? [root] : [{ pid: rootPid }];
  const seen = new Set([rootPid]);
  for (let depth = 0; depth < 7 && frontier.length; depth += 1) {
    const next = [];
    for (const parent of frontier) {
      for (const child of table.children.get(parent.pid) || []) {
        if (seen.has(child.pid)) continue;
        seen.add(child.pid);
        result.push(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return result;
}

function codexSessionHint(record) {
  const candidates = [];
  if (record && record.activeAgent && record.activeAgent.type === 'codex') {
    candidates.push(record.activeAgent.sessionId);
  }
  for (const window of record && Array.isArray(record.windows) ? record.windows : []) {
    for (const pane of Array.isArray(window.panes) ? window.panes : []) {
      if (pane.agent && pane.agent.type === 'codex') candidates.push(pane.agent.sessionId);
    }
  }
  candidates.push(record && record.titleSourceSessionId);
  return candidates.find((sessionId) => UUID_RE.test(sessionId || ''));
}

function codexLogDatabase() {
  let files;
  try {
    files = fs.readdirSync(codexHome());
  } catch {
    return undefined;
  }
  const candidates = files.map((name) => {
    const match = name.match(/^logs_(\d+)\.sqlite$/);
    return match ? { name, generation: Number(match[1]) } : undefined;
  }).filter(Boolean).sort((a, b) => b.generation - a.generation);
  return candidates.length ? path.join(codexHome(), candidates[0].name) : undefined;
}

module.exports = {
  AgentObserver,
  commandExecutable,
  descendantsOf,
  executableBases,
  matchesExecutable,
  readProcessTable,
};
