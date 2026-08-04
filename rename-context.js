'use strict';

const fs = require('fs');
const os = require('node:os');
const readline = require('readline');
const {
  execFileInputText,
  messageOf,
  stripStatusPrefix,
} = require('./runtime');

const SLASH_COMMAND_RE = /^\/[\p{L}\p{N}_-]+(?:\s|$)/u;
const ACKNOWLEDGEMENT_PHRASES = [
  'ok', 'okay', 'yes', 'yep', 'yup', 'perfect', 'great', 'done', 'thanks', 'thank you',
  'go ahead', 'do it', 'continue', 'proceed', 'carry on', 'sounds good',
  'sim', 'nao', 'não', 'perfeito', 'beleza', 'feito', 'valeu', 'obrigado', 'obrigada',
  'pode fazer', 'manda', 'continua', 'segue',
  'sí', 'si', 'vale', 'perfecto', 'perfecta', 'gracias', 'adelante', 'continúa', 'hazlo',
  'oui', 'non', 'parfait', 'merci', 'vas y',
  'ja', 'nein', 'perfekt', 'danke', 'weiter', 'mach weiter',
  'sì', 'no', 'perfetto', 'perfetta', 'grazie', 'vai',
  'はい', '続けて', '好的', '可以', '继续', '네', '좋아요', '계속',
].map((phrase) => phrase.split(' '));

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function textFromContent(content, acceptedTypes) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item && acceptedTypes.has(item.type) && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function candidateFromClaude(entry) {
  if (!entry || entry.isMeta || entry.isSidechain) return undefined;
  const message = entry.message;
  if (!message || message.role !== 'user') return undefined;
  return textFromContent(message.content, new Set(['text', 'input_text']));
}

function candidateFromCodex(entry) {
  if (!entry) return undefined;
  const payload = entry.payload || {};
  if (entry.type === 'event_msg' && payload.type === 'user_message') {
    return payload.message;
  }
  if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
    return textFromContent(payload.content, new Set(['input_text', 'text']));
  }
  return undefined;
}

function isMeaningfulRenameMessage(text) {
  const value = normalizeWhitespace(text);
  if (value.length < 2 || isAcknowledgementOnly(value) || SLASH_COMMAND_RE.test(value)) return false;
  return !value.startsWith('<')
    && !value.startsWith('{')
    && !value.startsWith('# AGENTS.md')
    && !value.startsWith('[Request interrupted')
    && !value.startsWith('The following is the Codex agent history');
}

function isAcknowledgementOnly(text) {
  const tokens = String(text || '').toLocaleLowerCase()
    .replace(new RegExp('[.!?,;:>…\\u2014\\u2013-]+', 'gu'), ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (!tokens.length || tokens.length > 12) return false;
  const reachable = new Set([0]);
  for (let index = 0; index < tokens.length; index += 1) {
    if (!reachable.has(index)) continue;
    for (const phrase of ACKNOWLEDGEMENT_PHRASES) {
      if (phrase.every((token, offset) => tokens[index + offset] === token)) {
        reachable.add(index + phrase.length);
      }
    }
  }
  return reachable.has(tokens.length);
}

function extractRecentUserMessages(agentType, entries, limit = 2) {
  const found = [];
  const seen = new Set();
  const candidateFor = agentType === 'claude' ? candidateFromClaude : candidateFromCodex;
  for (let index = entries.length - 1; index >= 0 && found.length < limit; index -= 1) {
    const text = normalizeWhitespace(candidateFor(entries[index]));
    if (!isMeaningfulRenameMessage(text)) continue;
    const key = text.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(text);
  }
  return found.reverse();
}

async function readRecentUserMessages(agentType, file, limit = 2) {
  const stat = await fs.promises.stat(file);
  const recent = [];
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const message = extractRecentUserMessages(agentType, [entry], 1)[0];
      if (!message) continue;
      const key = message.toLocaleLowerCase();
      const duplicate = recent.findIndex((item) => item.key === key);
      if (duplicate >= 0) recent.splice(duplicate, 1);
      recent.push({ key, message });
      if (recent.length > limit) recent.shift();
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return {
    messages: recent.map((item) => item.message),
    bytesRead: stat.size,
  };
}

function buildRenameSource(messages, fallback, maxChars = 1600) {
  const useful = messages.length ? messages : [normalizeWhitespace(fallback)];
  const perMessage = Math.max(240, Math.floor(maxChars / useful.length) - 40);
  return useful
    .map((message, index) => `Recent user message ${index + 1}: ${message.slice(0, perMessage)}`)
    .join('\n\n')
    .slice(0, maxChars);
}

function normalizeContextTitle(input) {
  const tokens = normalizeWhitespace(String(input || '').replace(/["'`*_#.,:;!?()[\]{}<>]/g, ' '))
    .match(/[\p{L}\p{N}-]+/gu) || [];
  if (!tokens.length) return undefined;
  return tokens.slice(0, 2).map((token) => token.toLocaleLowerCase()).join(' ');
}

function preferredRecordAgent(record) {
  const agents = (record.windows || []).flatMap((window) => (window.panes || []))
    .map((pane) => pane.agent)
    .filter(Boolean);
  const selected = record.activeAgent && agents.find((agent) => (
    agent.type === record.activeAgent.type && agent.sessionId === record.activeAgent.sessionId
  ));
  return selected
    || agents.find((agent) => agent.active && agent.transcript)
    || agents.find((agent) => agent.transcript)
    || agents.find((agent) => agent.active)
    || agents[0];
}

async function renameContext(record, transcriptForAgent, log) {
  const agent = preferredRecordAgent(record);
  const transcript = await transcriptForAgent(record, agent);
  const recent = await recentRenameMessages(agent, transcript, log);
  const fallback = record.sourceTitle || record.autoTitle || record.manualTitle || record.tmuxSession;
  return {
    agent,
    transcript,
    ...recent,
    localSource: recent.messages.length ? [...recent.messages].reverse().join(' ') : fallback,
    source: buildRenameSource(recent.messages, fallback),
  };
}

async function recentRenameMessages(agent, transcript, log) {
  if (!agent || !transcript) return { messages: [], bytesRead: 0, error: undefined };
  try {
    const result = await readRecentUserMessages(agent.type, transcript, 2);
    return { ...result, error: undefined };
  } catch (error) {
    log('rename-context', error);
    return { messages: [], bytesRead: 0, error: messageOf(error) };
  }
}

function renameProvider(configured, agent) {
  if (configured === 'local' || configured === 'vscode') return configured;
  if (agent && (agent.type === 'codex' || agent.type === 'claude')) return agent.type;
  return 'vscode';
}

async function generateRenameTitle(provider, source, localSource, options) {
  if (provider === 'local') {
    return { title: normalizeContextTitle(localSource) || 'terminal', provider, model: 'deterministic' };
  }
  const request = renameRequest(provider, options);
  const raw = request.languageModel
    ? await languageModelTitle(options.vscode, renamePrompt(source))
    : await execFileInputText(request.file, request.args, renamePrompt(source), request.options);
  const title = normalizeContextTitle(raw.text || raw);
  if (!title) throw new Error(`${providerLabel(provider)} returned an empty title`);
  return { title, provider, model: raw.model || request.model };
}

function renameRequest(provider, options) {
  if (provider === 'codex') return {
    file: options.codexPath,
    args: [
      'exec', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--skip-git-repo-check', '--color', 'never', '-C', os.tmpdir(),
      '-c', 'model_reasoning_effort="low"', '-',
    ],
    options: { timeout: 45000 },
    model: 'CLI default',
  };
  if (provider === 'claude') return {
    file: options.claudePath,
    args: [
      '-p', '--safe-mode', '--tools', '', '--permission-mode', 'dontAsk',
      '--no-session-persistence', '--output-format', 'text',
    ],
    options: { timeout: 45000, cwd: os.tmpdir() },
    model: 'CLI default',
  };
  if (provider === 'vscode') return { languageModel: true };
  throw new Error(`Unsupported rename provider: ${provider}`);
}

async function languageModelTitle(vscode, prompt) {
  const models = vscode.lm ? await vscode.lm.selectChatModels() : [];
  if (!models.length) throw new Error('No VS Code language model is available');
  const selected = models[0];
  let text = '';
  const response = await selected.sendRequest([vscode.LanguageModelChatMessage.User(prompt)]);
  for await (const chunk of response.text) {
    text += chunk;
    if (text.length > 160) break;
  }
  return { text, model: selected.name || selected.id || selected.family || 'language-model' };
}

function renamePrompt(source) {
  return [
    'Create a compact working-context label for the conversation from the recent user messages below.',
    'Use 1 or 2 short words. Prefer object + activity when that is more informative than one word.',
    'Use familiar product or developer shorthand when natural, even inside a Portuguese conversation.',
    'Use lowercase only. Good style examples: video ads, favicon gen, auth solving, mob nav.',
    'Avoid generic project names, status words, and labels such as Session or Task.',
    'Return only the title: no quotes, punctuation, explanation, or tool use.',
    '',
    source,
  ].join('\n');
}

function providerLabel(provider) {
  return {
    codex: 'Codex',
    claude: 'Claude',
    vscode: 'VS Code model',
    local: 'local generator',
  }[provider] || provider;
}

module.exports = {
  buildRenameSource,
  extractRecentUserMessages,
  generateRenameTitle,
  isAcknowledgementOnly,
  isMeaningfulRenameMessage,
  normalizeContextTitle,
  preferredRecordAgent,
  providerLabel,
  readRecentUserMessages,
  renameContext,
  renameProvider,
  stripStatusPrefix,
};
