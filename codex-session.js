'use strict';

const path = require('node:path');

const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const TRANSCRIPT_ID_RE = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;

function codexTranscriptPathsFromLsof(raw, codexHome) {
  const sessionsRoot = `${path.resolve(codexHome, 'sessions')}${path.sep}`;
  const seen = new Set();
  const result = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.startsWith('n')) continue;
    const file = path.resolve(line.slice(1));
    if (!file.startsWith(sessionsRoot) || !TRANSCRIPT_ID_RE.test(file) || seen.has(file)) continue;
    seen.add(file);
    result.push(file);
  }
  return result;
}

function codexSessionIdFromTranscriptPath(file) {
  return String(file || '').match(TRANSCRIPT_ID_RE)?.[1];
}

function codexSessionIdFromMetadata(text) {
  for (const line of String(text || '').split('\n').slice(0, 4)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'session_meta') continue;
      const sessionId = entry.payload && (entry.payload.session_id || entry.payload.id);
      if (UUID_RE.test(sessionId || '')) return sessionId;
    } catch {}
  }
  return undefined;
}

function codexSessionCacheExpired(cached, now, refreshMs = 5000) {
  if (!cached || !Number.isFinite(Number(cached.at))) return true;
  return Number(now) - Number(cached.at) >= Math.max(0, Number(refreshMs) || 0);
}

function newestCodexSessionCandidate(candidates, fallbackSessionId) {
  const latest = [...(Array.isArray(candidates) ? candidates : [])]
    .filter((candidate) => UUID_RE.test(candidate && candidate.sessionId || ''))
    .sort((a, b) => Number(b.modifiedAt || 0) - Number(a.modifiedAt || 0))[0];
  if (latest) return latest.sessionId;
  return UUID_RE.test(fallbackSessionId || '') ? fallbackSessionId : undefined;
}

module.exports = {
  codexSessionCacheExpired,
  codexSessionIdFromMetadata,
  codexSessionIdFromTranscriptPath,
  codexTranscriptPathsFromLsof,
  newestCodexSessionCandidate,
};
