'use strict';

const path = require('node:path');
const {
  configuredExecutable,
  defaultWorkspaceCwd,
  delay,
  existingDirectory,
  execFileText,
  messageOf,
} = require('./runtime');
const {
  hasAgentContext,
  hasMeaningfulTerminalOutput,
  sessionPanes,
} = require('./session-presentation');

let nodePtyModule;

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

function analyzeTerminalInput(input, pasteActive = false) {
  const text = String(input || '');
  let cursor = 0;
  let submitted = false;
  let editing = false;

  while (cursor < text.length) {
    if (text.startsWith(PASTE_START, cursor)) {
      pasteActive = true;
      editing = true;
      cursor += PASTE_START.length;
      continue;
    }
    if (text.startsWith(PASTE_END, cursor)) {
      pasteActive = false;
      editing = true;
      cursor += PASTE_END.length;
      continue;
    }
    const character = text[cursor];
    if (!pasteActive && (character === '\r' || character === '\n')) submitted = true;
    else editing = true;
    cursor += 1;
  }

  return { editing, pasteActive, submitted };
}

class ManagedTmuxPty {
  constructor(manager, record) {
    this.manager = manager;
    this.record = record;
    this.wait = manager.wait || delay;
    this.vscode = manager.vscode || require('vscode');
    this.writeEmitter = new this.vscode.EventEmitter();
    this.closeEmitter = new this.vscode.EventEmitter();
    this.nameEmitter = new this.vscode.EventEmitter();
    this.onDidWrite = this.writeEmitter.event;
    this.onDidClose = this.closeEmitter.event;
    this.onDidChangeName = this.nameEmitter.event;
    this.child = undefined;
    this.childDisposables = [];
    this.closed = false;
    this.opened = false;
    this.lastName = '';
    this.lastNameChangedAt = 0;
    this.lastCapturedNativeName = '';
    this.pendingTmuxDimensions = undefined;
    this.resizeTimer = undefined;
    this.resizeInFlight = false;
    this.lastResizeAt = 0;
    this.ignoreOutputActivityUntil = 0;
    this.bracketedPasteActive = false;
    this.dimensions = { columns: 80, rows: 24 };
    this.firstOutputPromise = new Promise((resolve) => {
      this.resolveFirstOutput = resolve;
    });
  }

  async open(initialDimensions) {
    this.opened = true;
    if (initialDimensions) this.dimensions = initialDimensions;
    this.setName(this.manager.formatTerminalName(this.record));
    try {
      await this.manager.tmux.ensureSession(this.record, initialDimensions);
      if (this.closed) return;
      this.spawnBridge();
      await this.primeDisplay();
    } catch (error) {
      this.manager.log('pty-open', error);
      this.writeEmitter.fire(`\r\nAI Terminal Sessions: ${messageOf(error)}\r\n`);
      this.closeEmitter.fire(1);
    }
  }

  spawnBridge() {
    const nodePty = loadNodePty(this.vscode);
    const child = nodePty.spawn(this.manager.tmux.tmuxPath(), this.manager.tmux.tmuxArguments([
      'attach-session', '-t', this.record.tmuxSession,
    ]), {
      name: 'xterm-256color',
      cols: this.dimensions.columns,
      rows: this.dimensions.rows,
      cwd: existingDirectory(this.record.cwd, defaultWorkspaceCwd(this.vscode)),
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    this.child = child;
    this.ignoreOutputActivityUntil = Date.now() + 10000;
    this.childDisposables = [
      child.onData((data) => {
        this.writeEmitter.fire(data);
        this.noteFirstOutput();
        const now = Date.now();
        if (!hasAgentContext(this.record)
          && now >= this.ignoreOutputActivityUntil
          && now - this.lastResizeAt >= 750
          && hasMeaningfulTerminalOutput(data)) {
          this.manager.noteTerminalActivity(this.record, 'output');
        }
      }),
      child.onExit((event) => {
        this.child = undefined;
        if (!this.closed) this.closeEmitter.fire(event.exitCode);
      }),
    ];
  }

  bridgeReady() {
    return this.opened && Boolean(this.child) && !this.closed;
  }

  noteFirstOutput() {
    if (!this.resolveFirstOutput) return;
    this.resolveFirstOutput();
    this.resolveFirstOutput = undefined;
  }

  async primeDisplay() {
    // tmux normally redraws immediately on attach, but a background VS Code
    // terminal can miss that first burst while its renderer is still mounting.
    // Wait until that burst has reached VS Code, then redraw the full client
    // at staggered intervals while xterm completes its first layout pass.
    await Promise.race([this.firstOutputPromise, this.wait(250)]);
    await this.wait(80);
    await this.replayVisiblePane();
    if (sessionPanes(this.record).length < 2) return;
    for (const interval of [180, 400]) {
      await this.wait(interval);
      if (!this.bridgeReady()) return;
      await this.manager.tmux.redrawSession(this.record.tmuxSession);
    }
  }

  async replayVisiblePane() {
    if (!this.bridgeReady()) return 0;
    let redrawn = await this.manager.tmux.redrawSession(this.record.tmuxSession);
    if (!redrawn) {
      await this.wait(40);
      redrawn = await this.manager.tmux.redrawSession(this.record.tmuxSession);
    }
    if (redrawn || sessionPanes(this.record).length > 1) return redrawn;
    const snapshot = await this.manager.tmux.runTmux([
      'capture-pane', '-p', '-e', '-t', `${this.record.tmuxSession}:`,
    ], true);
    if (!snapshot || !snapshot.trim()) return 0;
    this.writeEmitter.fire(`\x1b[2J\x1b[H${snapshot.replace(/\n/g, '\r\n')}`);
    return 0;
  }

  handleInput(data) {
    if (this.child) this.child.write(data);
    const input = analyzeTerminalInput(data, this.bracketedPasteActive);
    this.bracketedPasteActive = input.pasteActive;
    if (input.submitted) {
      this.manager.acknowledgeSubmittedInput(this.record)
        .catch((error) => this.manager.log('attention-submit', error));
      this.manager.cancelDraftCapture(this.record);
    } else if (input.editing) {
      this.manager.scheduleDraftCapture(this.record);
    }
  }

  setDimensions(dimensions) {
    if (!dimensions || dimensions.columns < 2 || dimensions.rows < 2) return;
    this.dimensions = dimensions;
    this.lastResizeAt = Date.now();
    if (this.child) {
      try { this.child.resize(dimensions.columns, dimensions.rows); } catch (error) {
        this.manager.log('resize', error);
      }
    }
    this.queueTmuxResize(dimensions);
  }

  queueTmuxResize(dimensions) {
    this.pendingTmuxDimensions = { ...dimensions };
    if (this.closed || this.resizeTimer || this.resizeInFlight) return;
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      this.flushTmuxResize().catch((error) => this.manager.log('resize-tmux', error));
    }, 50);
  }

  async flushTmuxResize() {
    if (this.closed || this.resizeInFlight || !this.pendingTmuxDimensions) return;
    const dimensions = this.pendingTmuxDimensions;
    this.pendingTmuxDimensions = undefined;
    this.resizeInFlight = true;
    try {
      await this.manager.tmux.resizeSession(this.record, dimensions);
    } finally {
      this.resizeInFlight = false;
      if (this.pendingTmuxDimensions) this.queueTmuxResize(this.pendingTmuxDimensions);
    }
  }

  setName(name) {
    if (!name || name === this.lastName) return;
    this.lastName = name;
    this.lastNameChangedAt = Date.now();
    if (this.opened) this.nameEmitter.fire(name);
  }

  close() {
    this.dispose();
  }

  dispose() {
    this.closed = true;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = undefined;
    this.pendingTmuxDimensions = undefined;
    for (const disposable of this.childDisposables) {
      try { disposable.dispose(); } catch {}
    }
    this.childDisposables = [];
    const child = this.child;
    this.child = undefined;
    if (child) {
      try { child.kill('SIGTERM'); } catch {}
    }
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
    this.nameEmitter.dispose();
  }
}

/* tmux owns the processes; node-pty is only the disposable attach client. */
function loadNodePty(vscode) {
  if (nodePtyModule) return nodePtyModule;
  const candidates = [];
  if (vscode.env && vscode.env.appRoot) {
    candidates.push(path.join(vscode.env.appRoot, 'node_modules', 'node-pty'));
  }
  candidates.push('node-pty');
  for (const candidate of candidates) {
    try {
      nodePtyModule = require(candidate);
      return nodePtyModule;
    } catch {}
  }
  throw new Error('node-pty was not found in the VS Code installation');
}

/**
 * Verifies both runtime bridges before any session restore begins.
 * Example: await validateTerminalRuntime(config, vscode).
 */
async function validateTerminalRuntime(config, vscode, dependencies = {}) {
  const runExecutable = dependencies.execFileText || execFileText;
  const loadPty = dependencies.loadNodePty || loadNodePty;
  const tmux = configuredExecutable(config, 'tmux');
  await runExecutable(tmux, ['-V'], { timeout: 3000 });
  return loadPty(vscode);
}

const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const DIVIDER_CHARACTERS = new Set(Array.from(`─━═-=_╭╮╰╯┌┐└┘\u2014`));
const PROMPT_MARKERS = new Set(['›', '❯', '>']);

function extractDraft(rawText) {
  const lines = normalizeLines(rawText);
  if (!lines.length) return undefined;

  const divider = lastClaudeDividerPair(lines);
  if (divider) {
    return usableDraft(cleanComposerLines(lines.slice(divider.top + 1, divider.bottom)));
  }

  const markerIndex = lastPromptMarkerIndex(lines);
  if (markerIndex === -1) return undefined;
  const candidate = [];
  for (let index = markerIndex; index < lines.length && index <= markerIndex + 14; index += 1) {
    const line = lines[index];
    if (index > markerIndex && (isDividerLine(line) || isStatusLine(line))) break;
    candidate.push(line);
  }
  return usableDraft(cleanComposerLines(candidate));
}

function normalizeLines(rawText) {
  return String(rawText || '')
    .replace(ANSI_RE, '')
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''));
}

function lastClaudeDividerPair(lines) {
  const indexes = lines.map((line, index) => isDividerLine(line) ? index : -1)
    .filter((index) => index >= 0);
  let result;
  for (const top of indexes) {
    for (const bottom of indexes) {
      const gap = bottom - top;
      if (gap < 2 || gap > 12) continue;
      if (lines.slice(top + 1, bottom).some(containsPromptMarker)) result = { top, bottom };
    }
  }
  return result;
}

function lastPromptMarkerIndex(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (containsPromptMarker(lines[index])) return index;
  }
  return -1;
}

function containsPromptMarker(line) {
  const value = String(line || '').trimStart()
    .replace(/^[│┃|]\s*/u, '');
  return PROMPT_MARKERS.has(value[0]) && (value.length === 1 || /\s/u.test(value[1]));
}

function cleanComposerLines(lines) {
  const cleaned = lines.map((line) => {
    let value = String(line || '').trim();
    value = value.replace(/^[│┃║▌▐▏▕]+/u, '').trim();
    value = value.replace(/[│┃║▌▐▏▕]+$/u, '').trim();
    if (value.length >= 2 && PROMPT_MARKERS.has(value[0]) && /\s/u.test(value[1])) {
      value = value.slice(2).trim();
    }
    return value;
  });
  while (cleaned.length && !cleaned[0]) cleaned.shift();
  while (cleaned.length && !cleaned[cleaned.length - 1]) cleaned.pop();
  return cleaned.join('\n');
}

function usableDraft(text) {
  const value = String(text || '').trim();
  if (value.length < 2 || !/[\p{L}\p{N}]/u.test(value)) return undefined;
  if (isPlaceholder(value)) return undefined;
  return value.slice(0, 50000);
}

function isPlaceholder(text) {
  const value = text.replace(/\s+/g, ' ').trim();
  return /^(?:Improve documentation in @filename|Describe (?:a |your )?task|Ask Codex|Type (?:a |your )?(?:message|request|prompt))\.?$/iu.test(value);
}

function isDividerLine(line) {
  const value = String(line || '').trim();
  if (value.length < 8) return false;
  const characters = Array.from(value);
  const dividerCount = characters.filter((character) => DIVIDER_CHARACTERS.has(character)).length;
  return dividerCount / characters.length >= 0.45;
}

function isStatusLine(line) {
  const value = String(line || '').trim().toLocaleLowerCase();
  if (!value) return false;
  const fragments = [
    'esc to', 'ctrl+', 'enter to', '? for shortcuts', 'tokens used', 'tokens remaining',
    'auto mode on', 'goal achieved', 'alt+m', ' = menu',
  ];
  if (fragments.some((fragment) => value.includes(fragment))) return true;
  if (value.includes('context ') && value.includes(' window')) return true;
  if (/^gpt-[\w.-]+\b/u.test(value) && value.includes('used')) return true;
  if (/^workspace-/u.test(value)) return true;
  return false;
}

module.exports = {
  ManagedTmuxPty,
  PASTE_END,
  PASTE_START,
  analyzeTerminalInput,
  containsPromptMarker,
  extractDraft,
  isDividerLine,
  isPlaceholder,
  isStatusLine,
  loadNodePty,
  validateTerminalRuntime,
};
