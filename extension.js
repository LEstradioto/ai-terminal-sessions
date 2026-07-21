'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const childProcess = require('child_process');
const {
  buildRenameSource,
  normalizeContextTitle,
  readRecentUserMessages,
  stripStatusPrefix,
} = require('./rename-context');
const { extractDraft } = require('./draft-recovery');
const { activityReference, isNewReadyEvent, terminalStatusIcon } = require('./session-status');
const {
  activeProcess,
  activityLabel,
  ansiTerminalPreview,
  previewChangedAt,
  statusLabel,
  statusTone,
} = require('./monitor-model');
const { monitorHtml } = require('./monitor-view');
const {
  appendSessionSnapshot,
  historyPayload,
  normalizeSessionHistory,
} = require('./session-history');
const {
  applyVisualOrder,
  recordIdsForTabLabels,
  sortRecordsForRestore,
} = require('./session-order');
const { latestTranscriptActivity } = require('./transcript-activity');
const {
  hasAgentContext,
  hasMeaningfulTerminalOutput,
  repairLegacyRestoreActivity,
} = require('./terminal-activity');
const { WORKING_FRAMES, workingIndicator } = require('./working-animation');
const { analyzeTerminalInput } = require('./terminal-input');
const {
  redactDiagnostic,
  redactPath,
  resolveExecutable,
  shellQuote,
  terminalProfileSetting,
} = require('./runtime-paths');
const { SessionStateStore, normalizeSessionRecord } = require('./session-state');
const { WorkspaceLease } = require('./workspace-lease');
const { WorkbenchWindowAdapter } = require('./workbench-window');
const { matchesExecutable } = require('./process-detection');
const { isMissingTmuxSessionError } = require('./tmux-errors');
const {
  isSerializedTerminalStubLabel,
  staleManagedTerminalTabs,
} = require('./workbench-recovery');

const STATE_KEY = 'aiTerminalSessions.state.v1';
const PROFILE_ID = 'aiTerminalSessions.profile';
const MONITOR_VIEW_TYPE = 'aiTerminalSessions.monitor';
const DRAFT_MAX_CAPTURE_MS = 5000;
const DRAFT_AUTOSAVE_DELAY_MS = 1500;
const MONITOR_LINES = 12;
const MONITOR_REFRESH_MS = 1000;
const POLL_MS = 2000;
const SNAPSHOT_MS = 15000;
const TITLE_REFRESH_MS = 30 * 60 * 1000;
const IDLE_RECENT_MINUTES = 30;
const IDLE_OLD_HOURS = 4;
const DEFAULT_TMUX_SERVER = 'ai-terminal-sessions';
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
let activeManager;
let activeLease;
let nodePtyModule;

async function activate(context) {
  const output = vscode.window.createOutputChannel('AI Terminal Sessions');
  context.subscriptions.push(output);

  if (process.platform !== 'darwin') {
    output.appendLine(`[startup] unsupported platform: ${process.platform}`);
    vscode.window.showErrorMessage('AI Terminal Sessions currently supports macOS only.');
    return;
  }

  const workspaceKey = getWorkspaceKey();
  const workspaceHash = hashText(workspaceKey).slice(0, 12);
  const demoMode = context.extensionMode === vscode.ExtensionMode.Development
    && process.env.AI_TERMINAL_SESSIONS_DEMO === '1';
  const lease = new WorkspaceLease(
    path.join(context.globalStorageUri.fsPath, `workspace-${workspaceHash}.lease`),
    demoMode ? { heartbeatMs: 1000, staleMs: 3000 } : {},
  );
  const leaseResult = await lease.acquire();
  if (!leaseResult.acquired) {
    const owner = leaseResult.owner || {};
    output.appendLine(`[startup] workspace already controlled by extension host pid=${owner.pid || 'unknown'}`);
    vscode.window.showWarningMessage(
      'AI Terminal Sessions is already active for this workspace in another VS Code window.',
    );
    return;
  }
  activeLease = lease;

  try {
    const config = vscode.workspace.getConfiguration('aiTerminalSessions');
    await validateRuntime(config);

    const manager = new SessionManager(context, output, workspaceKey);
    activeManager = manager;
    manager.register();
    await manager.start();
  } catch (error) {
    activeManager = undefined;
    await lease.release();
    activeLease = undefined;
    throw error;
  }
}

async function deactivate() {
  if (activeManager) {
    await activeManager.shutdown();
    activeManager = undefined;
  }
  if (activeLease) {
    await activeLease.release();
    activeLease = undefined;
  }
}

async function validateRuntime(config) {
  const tmux = configuredExecutable(config, 'tmux');
  try {
    await execFileText(tmux, ['-V'], { timeout: 3000 });
    loadNodePty();
  } catch (error) {
    vscode.window.showErrorMessage(
      `AI Terminal Sessions could not start: ${compactDiagnostic(messageOf(error))}`,
    );
    throw error;
  }
}

class SessionManager {
  constructor(context, output, workspaceKey = getWorkspaceKey()) {
    this.context = context;
    this.output = output;
    this.workspaceKey = workspaceKey;
    this.workspaceHash = hashText(this.workspaceKey).slice(0, 12);
    this.backupKey = `${STATE_KEY}.backup.${this.workspaceHash}`;
    this.stateStore = new SessionStateStore({
      workspaceState: context.workspaceState,
      globalState: context.globalState,
      stateKey: STATE_KEY,
      backupKey: this.backupKey,
      workspaceKey: this.workspaceKey,
    });
    this.persistRevision = 0;
    this.records = new Map();
    this.ptys = new Map();
    this.terminals = new Map();
    this.pendingCloseActions = new Map();
    this.ensurePromises = new Map();
    this.codexPidCache = new Map();
    this.codexTranscriptCache = new Map();
    this.codexThreadNames = new Map();
    this.codexIndexMtime = 0;
    this.persistTimer = undefined;
    this.pollTimer = undefined;
    this.titlePollTimer = undefined;
    this.tabOrderTimer = undefined;
    this.workingAnimationTimer = undefined;
    this.workingAnimationFrame = 0;
    this.terminalActivityPersistedAt = new Map();
    this.draftCaptureTimers = new Map();
    this.draftMaxCaptureTimers = new Map();
    this.drafts = new Map();
    this.draftPersistQueue = Promise.resolve();
    this.draftStorePath = path.join(
      this.context.globalStorageUri.fsPath,
      `drafts-${this.workspaceHash}.json`,
    );
    this.sessionHistory = [];
    this.historyPersistQueue = Promise.resolve();
    this.historyStorePath = path.join(
      this.context.globalStorageUri.fsPath,
      `history-${this.workspaceHash}.json`,
    );
    this.monitorPanel = undefined;
    this.monitorTimer = undefined;
    this.monitorRefreshing = false;
    this.monitorPreviewCache = new Map();
    this.monitorOpenPromise = undefined;
    this.serializedMonitorRecoveryPromise = undefined;
    this.reopenSerializedMonitorAfterStart = false;
    this.started = false;
    this.restoringTabs = false;
    this.restorePromise = undefined;
    this.scanPromise = undefined;
    this.deactivating = false;
    this.lastSnapshotAt = 0;
    this.workbench = new WorkbenchWindowAdapter(vscode, (scope, error) => this.log(scope, error), delay);
    this.demoMode = context.extensionMode === vscode.ExtensionMode.Development
      && process.env.AI_TERMINAL_SESSIONS_DEMO === '1';
  }

  config() {
    return vscode.workspace.getConfiguration('aiTerminalSessions');
  }

  tmuxPath() {
    return configuredExecutable(this.config(), 'tmux');
  }

  tmuxServerName() {
    const legacy = this.config().get('tmuxServerName');
    return String(process.env.AI_TERMINAL_SESSIONS_TMUX_SERVER || legacy || DEFAULT_TMUX_SERVER)
      .replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64) || DEFAULT_TMUX_SERVER;
  }

  tmuxArguments(args) {
    return ['-L', this.tmuxServerName(), '-f', '/dev/null', ...args];
  }

  register() {
    const subscriptions = this.context.subscriptions;

    subscriptions.push(vscode.window.registerTerminalProfileProvider(PROFILE_ID, {
      provideTerminalProfile: async () => {
        const record = this.createRecord();
        await this.persist();
        const pty = this.createPty(record);
        return new vscode.TerminalProfile(this.terminalOptions(record, pty, false, false));
      },
    }));

    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.new', () => this.newTerminal()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.attachExisting', () => this.attachExisting()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.rename', () => this.renameActive()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.renameWithAI', () => this.renameActiveWithAI()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.diagnoseRenameAI', () => this.diagnoseRenameAI()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.restoreDraft', () => this.restoreDraft()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.scrollPageUp', () => this.scrollActive('up')));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.scrollPageDown', () => this.scrollActive('down')));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.toggleMonitorPin', () => this.toggleMonitorPin()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.toggleMonitor', () => this.toggleMonitor()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.remove', () => this.removeActive()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.showSessionHistory', () => this.showSessionHistory()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.clearRecoveryData', () => this.clearRecoveryData()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.stopAll', () => this.stopAllManagedSessions()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.restoreNow', async () => {
      const restored = await this.restoreTabs(true);
      vscode.window.showInformationMessage(
        restored
          ? `${restored} tab(s) restored in the main window.`
          : 'There are no saved sessions to restore.',
      );
    }));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.makeDefault', () => this.makeDefault()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.showLog', () => this.output.show()));
    subscriptions.push(vscode.window.registerWebviewPanelSerializer(MONITOR_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => {
        // A serialized auxiliary monitor becomes the active workbench window
        // before extension activation. Reusing it races terminal restoration
        // and can strand fresh terminal editors inside that window. Discard
        // the shell and recreate the monitor after the main tabs are ready.
        panel.dispose();
        this.reopenSerializedMonitorAfterStart = true;
        if (this.started) await this.reopenSerializedMonitor();
      },
    }));

    subscriptions.push(vscode.window.onDidOpenTerminal((terminal) => this.handleOpenTerminal(terminal)));
    subscriptions.push(vscode.window.onDidCloseTerminal((terminal) => {
      this.handleCloseTerminal(terminal).catch((error) => this.log('terminal-close', error));
    }));
    subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(() => {
      this.scheduleTabOrderCapture();
      this.updateManagedTerminalContext(this.activeRecord());
    }));
    subscriptions.push(vscode.window.tabGroups.onDidChangeTabGroups(() => {
      this.scheduleTabOrderCapture();
      this.updateManagedTerminalContext(this.activeRecord());
    }));
    subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('workbench.reduceMotion')) return;
      this.updateWorkingAnimation();
      for (const record of this.records.values()) this.refreshPtyName(record);
    }));
    subscriptions.push(vscode.window.onDidChangeActiveTerminal((terminal) => {
      const record = terminal && this.recordForTerminal(terminal);
      this.updateManagedTerminalContext(record);
      if (!record || this.restoringTabs) return;
      if (this.captureNativeRenames() || this.captureTabOrder()) this.schedulePersist();
      record.lastFocusedAt = Date.now();
      this.acknowledgeReady(record);
      this.schedulePersist();
    }));
  }

  async start() {
    await this.loadState();
    await this.loadSessionHistory();
    await this.checkpointSessionHistory('startup');
    await this.loadDrafts();
    if (this.demoMode) {
      const { seedDemo } = require('./demo/demo-seed');
      await seedDemo(this);
    }
    await this.closeSerializedTerminalStubs();
    await this.restoreTabs(false);
    if (this.demoMode) await this.waitForDemoSessions();
    await this.scanAll();
    this.updateManagedTerminalContext(this.activeRecord());
    await this.updateMonitorContext();
    this.started = true;
    if ((this.demoMode || this.reopenSerializedMonitorAfterStart) && this.pinnedRecords().length) {
      await this.reopenSerializedMonitor();
    }

    this.pollTimer = setInterval(() => {
      this.scanAll().catch((error) => this.log('scan', error));
    }, POLL_MS);
    this.titlePollTimer = setInterval(() => {
      if (this.captureNativeRenames() || this.captureTabOrder()) this.schedulePersist();
    }, 500);

    if (!this.context.globalState.get('defaultProfilePrompted.v1')) {
      await this.context.globalState.update('defaultProfilePrompted.v1', true);
      const profileSetting = terminalProfileSetting();
      const current = profileSetting
        ? vscode.workspace.getConfiguration('terminal.integrated').get(profileSetting)
        : undefined;
      if (current !== 'AI Sessions') {
        const choice = await vscode.window.showInformationMessage(
          'Use AI Sessions as the default terminal profile? This changes your global terminal profile and default location.',
          'Enable globally',
          'Not now',
        );
        if (choice === 'Enable globally') await this.makeDefault();
      }
    }
  }

  async closeSerializedTerminalStubs() {
    const storageId = path.basename((this.context.storageUri && this.context.storageUri.fsPath) || '');
    const staleTabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => (
      tab.input instanceof vscode.TabInputTerminal
      && isSerializedTerminalStubLabel(tab.label, storageId)
    ));
    if (!staleTabs.length) return 0;
    await vscode.window.tabGroups.close(staleTabs, true);
    this.output.appendLine(`[restore] removed ${staleTabs.length} unresolved terminal editor stub(s)`);
    await delay(100);
    return staleTabs.length;
  }

  async closeDuplicateManagedTerminalTabs(liveTabs, records) {
    const expected = records.filter((record) => this.terminals.has(record.id)).length;
    if (!expected || liveTabs.size !== expected) {
      if (expected) {
        this.output.appendLine(
          `[restore] skipped duplicate cleanup: identified ${liveTabs.size}/${expected} live editor tab(s)`,
        );
      }
      return 0;
    }

    const terminalTabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => (
      tab.input instanceof vscode.TabInputTerminal
    ));
    const managedTitles = records.flatMap((record) => [
      record.manualTitle,
      record.autoTitle,
      shortTitle(record.tmuxSession),
      this.terminals.get(record.id)?.name,
    ]);
    const staleTabs = staleManagedTerminalTabs(terminalTabs, liveTabs, managedTitles);
    if (!staleTabs.length) return 0;

    await vscode.window.tabGroups.close(staleTabs, true);
    this.output.appendLine(`[restore] removed ${staleTabs.length} duplicate terminal editor stub(s)`);
    await delay(100);
    return staleTabs.length;
  }

  async reopenSerializedMonitor() {
    if (this.serializedMonitorRecoveryPromise) return this.serializedMonitorRecoveryPromise;
    this.serializedMonitorRecoveryPromise = (async () => {
      await delay(150);
      if (this.deactivating || !this.pinnedRecords().length) return undefined;
      await this.workbench.switchToMainWindow();
      await delay(100);
      return this.openMonitor();
    })().finally(() => {
      this.serializedMonitorRecoveryPromise = undefined;
      this.reopenSerializedMonitorAfterStart = false;
    });
    return this.serializedMonitorRecoveryPromise;
  }

  async loadState() {
    const payload = this.stateStore.load();
    if (!payload) return;

    this.persistRevision = Number(payload.revision) || 0;

    for (const raw of payload.records) {
      const record = normalizeSessionRecord(raw, this.workspaceKey);
      if (!record) continue;
      this.records.set(record.id, record);
    }
    let nextOrder = Math.max(
      -1,
      ...[...this.records.values()]
        .filter((record) => Number.isFinite(record.tabOrder))
        .map((record) => record.tabOrder),
    ) + 1;
    const missingOrder = [...this.records.values()]
      .filter((record) => !Number.isFinite(record.tabOrder))
      .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
    for (const record of missingOrder) {
      record.tabOrder = nextOrder;
      nextOrder += 1;
    }
    const repaired = repairLegacyRestoreActivity(this.records.values());
    if (repaired) {
      this.output.appendLine(`[state] removed restore-redraw activity from ${repaired} session(s)`);
      this.schedulePersist();
    }
    this.output.appendLine(`[state] loaded ${this.records.size} session(s) for ${this.workspaceKey}`);
  }

  async waitForDemoSessions() {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const alive = await Promise.all([...this.records.values()].map((record) => (
        this.tmuxHasSession(record.tmuxSession).catch(() => false)
      )));
      if (alive.length && alive.every(Boolean)) return true;
      await delay(100);
    }
    this.output.appendLine('[demo] sessions were not ready before the monitor timeout');
    return false;
  }

  async loadSessionHistory() {
    let payload;
    try {
      payload = JSON.parse(await fs.promises.readFile(this.historyStorePath, 'utf8'));
    } catch (error) {
      if (error && error.code !== 'ENOENT') this.log('history-load', error);
      return;
    }
    this.sessionHistory = normalizeSessionHistory(payload, this.workspaceKey);
    this.output.appendLine(`[history] loaded ${this.sessionHistory.length} session snapshot(s)`);
  }

  persistSessionHistory() {
    this.historyPersistQueue = this.historyPersistQueue.catch(() => {}).then(async () => {
      const directory = path.dirname(this.historyStorePath);
      const temporary = `${this.historyStorePath}.${process.pid}.tmp`;
      await fs.promises.mkdir(directory, { recursive: true });
      await fs.promises.writeFile(
        temporary,
        JSON.stringify(historyPayload(this.workspaceKey, this.sessionHistory)),
        { encoding: 'utf8', mode: 0o600 },
      );
      await fs.promises.rename(temporary, this.historyStorePath);
    });
    return this.historyPersistQueue;
  }

  async checkpointSessionHistory(reason = 'state', force = false) {
    const result = appendSessionSnapshot(this.sessionHistory, this.records.values(), { reason, force });
    this.sessionHistory = result.history;
    if (!result.changed) return false;
    await this.persistSessionHistory();
    this.output.appendLine(`[history] saved ${this.records.size} tab(s): ${reason}`);
    return true;
  }

  async loadDrafts() {
    let payload;
    try {
      payload = JSON.parse(await fs.promises.readFile(this.draftStorePath, 'utf8'));
    } catch (error) {
      if (error && error.code !== 'ENOENT') this.log('draft-load', error);
      return;
    }
    if (!payload || payload.workspaceKey !== this.workspaceKey || !payload.drafts) return;
    for (const [recordId, snapshot] of Object.entries(payload.drafts)) {
      if (!snapshot || typeof snapshot.text !== 'string' || !snapshot.text.trim()) continue;
      this.drafts.set(recordId, {
        text: snapshot.text.slice(0, 50000),
        capturedAt: Number(snapshot.capturedAt) || 0,
      });
    }
    this.output.appendLine(`[draft] loaded ${this.drafts.size} recovery snapshot(s)`);
  }

  persistDrafts() {
    this.draftPersistQueue = this.draftPersistQueue.catch(() => {}).then(async () => {
      const directory = path.dirname(this.draftStorePath);
      const temporary = `${this.draftStorePath}.${process.pid}.tmp`;
      const drafts = Object.fromEntries(this.drafts);
      await fs.promises.mkdir(directory, { recursive: true });
      await fs.promises.writeFile(temporary, JSON.stringify({
        version: 1,
        workspaceKey: this.workspaceKey,
        savedAt: Date.now(),
        drafts,
      }), { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(temporary, this.draftStorePath);
    });
    return this.draftPersistQueue;
  }

  async persist(reason = 'state') {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.persistRevision += 1;
    await this.stateStore.save(this.records.values(), this.persistRevision);
    await this.checkpointSessionHistory(reason);
  }

  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persist().catch((error) => this.log('persist', error));
    }, 400);
  }

  noteTerminalActivity(record, source = 'output', forcePersist = false) {
    if (!record || !this.records.has(record.id) || this.deactivating) return;
    const now = Date.now();
    record.lastTerminalActivityAt = now;
    record.lastTerminalActivitySource = source;
    this.refreshPtyName(record);
    const lastPersisted = this.terminalActivityPersistedAt.get(record.id) || 0;
    if (!forcePersist && now - lastPersisted < 5000) return;
    this.terminalActivityPersistedAt.set(record.id, now);
    this.schedulePersist();
  }

  scheduleTabOrderCapture() {
    if (this.tabOrderTimer || this.deactivating) return;
    this.tabOrderTimer = setTimeout(() => {
      this.tabOrderTimer = undefined;
      if (this.captureTabOrder()) this.schedulePersist();
    }, 80);
  }

  captureTabOrder() {
    if (!vscode.window.tabGroups || !this.terminals.size) return false;
    const groups = [...vscode.window.tabGroups.all]
      .sort((left, right) => Number(left.viewColumn) - Number(right.viewColumn));
    const labels = [];
    for (const group of groups) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTerminal) labels.push(tab.label);
      }
    }
    const terminals = [...this.terminals].map(([recordId, terminal]) => {
      const record = this.records.get(recordId);
      return {
        id: recordId,
        name: terminal.name,
        tabOrder: record && record.tabOrder,
        createdAt: record && record.createdAt,
      };
    });
    return applyVisualOrder(this.records, recordIdsForTabLabels(labels, terminals));
  }

  scheduleDraftCapture(record) {
    if (!record || !this.config().get('draftRecovery', true) || this.deactivating) return;
    const current = this.draftCaptureTimers.get(record.id);
    if (current) clearTimeout(current);
    const delay = DRAFT_AUTOSAVE_DELAY_MS;
    const timer = setTimeout(() => {
      this.flushScheduledDraftCapture(record);
    }, delay);
    this.draftCaptureTimers.set(record.id, timer);
    if (!this.draftMaxCaptureTimers.has(record.id)) {
      const maximum = setTimeout(() => {
        this.flushScheduledDraftCapture(record);
      }, Math.max(delay, DRAFT_MAX_CAPTURE_MS));
      this.draftMaxCaptureTimers.set(record.id, maximum);
    }
  }

  cancelDraftCapture(record) {
    const timer = record && this.draftCaptureTimers.get(record.id);
    const maximum = record && this.draftMaxCaptureTimers.get(record.id);
    if (timer) clearTimeout(timer);
    if (maximum) clearTimeout(maximum);
    if (record) {
      this.draftCaptureTimers.delete(record.id);
      this.draftMaxCaptureTimers.delete(record.id);
    }
  }

  flushScheduledDraftCapture(record) {
    this.cancelDraftCapture(record);
    this.captureDraft(record).catch((error) => this.log('draft-capture', error));
  }

  async readComposer(record) {
    const raw = await this.runTmux([
      'capture-pane', '-p', '-J', '-t', `${record.tmuxSession}:`, '-S', '-80',
    ], true);
    return extractDraft(raw);
  }

  async captureDraft(record) {
    if (!record || !this.records.has(record.id) || !this.config().get('draftRecovery', true)) return;
    const text = await this.readComposer(record);
    if (!text || !this.records.has(record.id)) return;
    const previous = this.drafts.get(record.id);
    if (previous && previous.text === text) return;
    this.drafts.set(record.id, { text, capturedAt: Date.now() });
    await this.persistDrafts();
    this.output.appendLine(`[draft] saved ${record.tmuxSession}: ${text.length} character(s)`);
  }

  async restoreDraft() {
    const record = this.activeRecord();
    if (!record) return this.warnManagedTerminal();
    const snapshot = this.drafts.get(record.id);
    if (!snapshot || !snapshot.text) {
      vscode.window.showInformationMessage('There is no saved draft for this tab.');
      return;
    }

    const current = await this.readComposer(record);
    if (current === snapshot.text) {
      vscode.window.showInformationMessage('The latest saved draft is already in the composer.');
      return;
    }
    if (current) {
      const choice = await vscode.window.showWarningMessage(
        'The composer already contains text. Restoring the draft will append it.',
        'Copy draft',
        'Append anyway',
      );
      if (choice === 'Copy draft') {
        await vscode.env.clipboard.writeText(snapshot.text);
        vscode.window.showInformationMessage('Draft copied.');
        return;
      }
      if (choice !== 'Append anyway') return;
    }

    const bufferName = `ai-terminal-draft-${record.id.slice(0, 8)}`;
    await this.runTmuxInput(['load-buffer', '-b', bufferName, '-'], snapshot.text);
    await this.runTmux([
      'paste-buffer', '-p', '-d', '-b', bufferName, '-t', `${record.tmuxSession}:`,
    ]);
    this.output.appendLine(`[draft] restored ${record.tmuxSession}: ${snapshot.text.length} character(s)`);
    vscode.window.showInformationMessage('Latest draft restored.');
  }

  pinnedRecords() {
    return [...this.records.values()]
      .filter((record) => record.monitorPinned)
      .sort((a, b) => (a.monitorPinnedAt || 0) - (b.monitorPinnedAt || 0))
      .slice(0, 4);
  }

  updateManagedTerminalContext(record) {
    vscode.commands.executeCommand('setContext', 'aiTerminalSessions.managedTerminalActive', Boolean(record));
  }

  async updateMonitorContext() {
    await vscode.commands.executeCommand(
      'setContext',
      'aiTerminalSessions.monitorHasPins',
      this.pinnedRecords().length > 0,
    );
  }

  async toggleMonitorPin() {
    const record = this.activeRecord();
    if (!record) return this.warnManagedTerminal();
    await this.setMonitorPinned(record, !record.monitorPinned);
  }

  async setMonitorPinned(record, pinned) {
    if (!record || !this.records.has(record.id)) return;
    if (pinned && !record.monitorPinned && this.pinnedRecords().length >= 4) {
      vscode.window.showWarningMessage('The Session Monitor supports up to four sessions.');
      return;
    }

    record.monitorPinned = Boolean(pinned);
    record.monitorPinnedAt = pinned ? Date.now() : 0;
    if (!pinned) this.monitorPreviewCache.delete(record.id);
    await Promise.all([this.persist(), this.updateMonitorContext()]);

    const title = record.manualTitle || record.autoTitle || shortTitle(record.tmuxSession);
    vscode.window.setStatusBarMessage(
      pinned ? `$(pin) ${title} pinned to Session Monitor` : `$(pinned) ${title} removed from Session Monitor`,
      1800,
    );

    if (pinned && !this.monitorPanel) await this.openMonitor();
    if (!pinned && !this.pinnedRecords().length && this.monitorPanel) {
      this.monitorPanel.dispose();
      return;
    }
    await this.refreshMonitor();
  }

  async toggleMonitor() {
    if (this.monitorPanel) {
      this.monitorPanel.dispose();
      return;
    }
    await this.openMonitor();
  }

  async openMonitor() {
    if (this.monitorPanel) {
      this.monitorPanel.reveal(undefined, true);
      this.startMonitorRefresh();
      await this.refreshMonitor();
      return this.monitorPanel;
    }
    if (this.monitorOpenPromise) return this.monitorOpenPromise;

    this.monitorOpenPromise = this.openMonitorImpl().finally(() => {
      this.monitorOpenPromise = undefined;
    });
    return this.monitorOpenPromise;
  }

  async openMonitorImpl() {
    const returnTerminal = vscode.window.activeTerminal;
    const showOptions = vscode.ViewColumn.Active;
    const panel = vscode.window.createWebviewPanel(
      MONITOR_VIEW_TYPE,
      `Session Monitor · ${getWorkspaceName()}`,
      showOptions,
      { enableScripts: true, retainContextWhenHidden: false },
    );
    this.attachMonitorPanel(panel);
    await this.refreshMonitor();

    await this.floatMonitorPanel(panel, returnTerminal);
    return panel;
  }

  attachMonitorPanel(panel) {
    if (this.monitorPanel && this.monitorPanel !== panel) this.monitorPanel.dispose();
    this.monitorPanel = panel;
    panel.webview.options = { enableScripts: true };
    panel.webview.html = monitorHtml(panel.webview, getWorkspaceName());

    panel.webview.onDidReceiveMessage((message) => {
      if (!message || this.deactivating) return;
      if (message.type === 'ready') {
        this.refreshMonitor().catch((error) => this.log('monitor-ready', error));
      } else if (message.type === 'focus') {
        this.focusMonitorRecord(message.id).catch((error) => this.log('monitor-focus', error));
      } else if (message.type === 'unpin') {
        const record = this.records.get(message.id);
        if (record) this.setMonitorPinned(record, false).catch((error) => this.log('monitor-unpin', error));
      }
    });
    panel.onDidChangeViewState(() => {
      if (panel.visible) {
        this.startMonitorRefresh();
        this.refreshMonitor().catch((error) => this.log('monitor-visible', error));
      } else {
        this.stopMonitorRefresh();
      }
    });
    panel.onDidDispose(() => {
      if (this.monitorPanel !== panel) return;
      this.monitorPanel = undefined;
      this.stopMonitorRefresh();
    });
    this.startMonitorRefresh();
  }

  async floatMonitorPanel(panel, returnTerminal) {
    try {
      const floated = await this.workbench.floatPanel(panel, {
        alwaysOnTop: this.config().get('monitorAlwaysOnTop', true),
      });
      if (!floated) {
        this.output.appendLine('[monitor] floating window unavailable; kept in the main editor');
        vscode.window.setStatusBarMessage(
          'AI Sessions: floating monitor is unavailable in this VS Code build',
          5000,
        );
        return;
      }
      await delay(80);
      if (returnTerminal) returnTerminal.show(false);
      this.output.appendLine('[monitor] opened floating compact monitor');
    } catch (error) {
      this.log('monitor-float', error);
      if (returnTerminal) returnTerminal.show(false);
    }
  }

  startMonitorRefresh() {
    if (this.monitorTimer || !this.monitorPanel || !this.monitorPanel.visible || this.deactivating) return;
    this.monitorTimer = setInterval(() => {
      this.refreshMonitor().catch((error) => this.log('monitor-refresh', error));
    }, MONITOR_REFRESH_MS);
  }

  stopMonitorRefresh() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = undefined;
  }

  async refreshMonitor() {
    const panel = this.monitorPanel;
    if (!panel || !panel.visible || this.monitorRefreshing || this.deactivating) return;
    this.monitorRefreshing = true;
    try {
      const now = Date.now();
      const maxLines = MONITOR_LINES;
      const sessions = await Promise.all(this.pinnedRecords().map(async (record) => {
        const raw = await this.runTmux([
          'capture-pane', '-p', '-e', '-J', '-t', `${record.tmuxSession}:`,
        ], true);
        const terminal = ansiTerminalPreview(raw, maxLines);
        const preview = terminal.text;
        const previous = this.monitorPreviewCache.get(record.id);
        const baselineActivityAt = activityReference(record, Number(record.createdAt) || now);
        const changedAt = previewChangedAt(previous, preview, baselineActivityAt, now);
        this.monitorPreviewCache.set(record.id, { preview, changedAt });

        const acknowledged = Boolean(
          record.readyAt && (record.lastAcknowledgedReadyAt || 0) >= record.readyAt
        );
        const activityAt = hasAgentContext(record)
          ? baselineActivityAt
          : Math.max(baselineActivityAt, Number(changedAt) || 0);
        return {
          id: record.id,
          title: record.manualTitle || record.autoTitle || shortTitle(record.tmuxSession),
          process: activeProcess(record),
          status: statusLabel(record.status, acknowledged),
          tone: statusTone(record.status, acknowledged),
          age: activityLabel(activityAt, now),
          preview,
          lines: terminal.lines,
          fresh: Boolean(previous && previous.preview !== preview),
        };
      }));

      if (this.monitorPanel === panel) {
        await panel.webview.postMessage({
          type: 'snapshot',
          sessions,
          updated: new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        });
      }
    } finally {
      this.monitorRefreshing = false;
    }
  }

  async focusMonitorRecord(recordId) {
    const record = this.records.get(recordId);
    if (!record) return;
    const terminal = this.terminals.get(record.id) || this.openRecord(record, false);
    await this.workbench.switchToMainWindow();
    await delay(60);
    terminal.show(false);
  }

  createRecord(overrides = {}) {
    const id = crypto.randomUUID();
    const workspaceName = getWorkspaceName();
    const sequence = this.records.size + 1;
    const tabOrder = Math.max(
      -1,
      ...[...this.records.values()].map((record) => (
        Number.isFinite(record.tabOrder) ? record.tabOrder : -1
      )),
    ) + 1;
    const record = {
      id,
      workspaceKey: this.workspaceKey,
      tmuxSession: `vsc-${slug(workspaceName)}-${id.slice(0, 6)}`.slice(0, 60),
      cwd: getDefaultCwd(),
      owned: true,
      autoTitle: shortTitle(`${workspaceName} ${sequence}`),
      manualTitle: '',
      status: 'idle',
      monitorPinned: false,
      windows: [],
      tabOrder,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastFocusedAt: Date.now(),
      ...overrides,
    };
    this.records.set(record.id, record);
    return record;
  }

  createPty(record) {
    const existing = this.ptys.get(record.id);
    if (existing) return existing;
    const pty = new ManagedTmuxPty(this, record);
    this.ptys.set(record.id, pty);
    return pty;
  }

  terminalOptions(record, pty, includeLocation, restoring) {
    const options = {
      name: this.formatTerminalName(record),
      pty,
      isTransient: true,
      iconPath: new vscode.ThemeIcon('terminal-tmux'),
      color: new vscode.ThemeColor('terminal.ansiCyan'),
    };
    if (!includeLocation) return options;

    if (this.config().get('defaultLocation', 'editor') === 'editor') {
      options.location = {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: restoring,
      };
    } else {
      options.location = vscode.TerminalLocation.Panel;
    }
    return options;
  }

  async newTerminal() {
    const record = this.createRecord();
    await this.persist();
    this.openRecord(record, false);
  }

  openRecord(record, restoring) {
    if (this.terminals.has(record.id)) return this.terminals.get(record.id);
    const pty = this.createPty(record);
    const terminal = vscode.window.createTerminal(this.terminalOptions(record, pty, true, restoring));
    this.terminals.set(record.id, terminal);
    if (!restoring) terminal.show(false);
    return terminal;
  }

  async restoreTabs(force) {
    if (this.restorePromise) return this.restorePromise;
    this.restoringTabs = true;
    this.restorePromise = this.restoreTabsImpl(force).finally(() => {
      this.restoringTabs = false;
      this.restorePromise = undefined;
    });
    return this.restorePromise;
  }

  async recoverLatestLiveHistorySnapshot() {
    if (this.records.size || !this.sessionHistory.length) return 0;
    const liveRaw = await this.runTmux(['list-sessions', '-F', '#{session_name}'], true);
    const liveSessions = new Set(liveRaw.split('\n').map((line) => line.trim()).filter(Boolean));
    if (!liveSessions.size) return 0;

    const snapshot = [...this.sessionHistory].reverse().find((candidate) => (
      candidate.records.some((record) => liveSessions.has(record.tmuxSession))
    ));
    if (!snapshot) return 0;

    for (const raw of sortRecordsForRestore(snapshot.records)) {
      if (!liveSessions.has(raw.tmuxSession)) continue;
      const record = normalizeSessionRecord(raw, this.workspaceKey);
      if (record) this.records.set(record.id, record);
    }
    if (!this.records.size) return 0;

    await Promise.all([
      this.persist('live-history-recovery'),
      this.updateMonitorContext(),
    ]);
    this.output.appendLine(
      `[restore] recovered ${this.records.size} live session(s) from snapshot ${snapshot.id}`,
    );
    return this.records.size;
  }

  async restoreTabsImpl(force) {
    if (force) this.captureTabOrder();
    const floatingMonitor = force && this.monitorPanel
      ? this.monitorPanel
      : undefined;

    // A terminal editor can survive in an auxiliary window after a workbench
    // reload. Move any stranded editors back before resolving the saved tabs.
    if (force) {
      try {
        await this.workbench.restoreEditorsToMainWindow();
        await delay(100);
      } catch (error) {
        this.log('restore-main-editors', error);
      }
    }

    // ViewColumn.Active is scoped to the active VS Code window. Without this,
    // activation from the serialized monitor creates restored terminals inside
    // the always-on-top auxiliary window.
    try {
      await this.workbench.switchToMainWindow();
      await delay(80);
    } catch (error) {
      this.log('restore-main-window', error);
    }

    if (force && !this.records.size) await this.recoverLatestLiveHistorySnapshot();
    const records = sortRecordsForRestore(this.records.values());
    if (force) {
      for (const record of records) {
        const terminal = this.terminals.get(record.id);
        if (!terminal) continue;
        this.disposeManagedTerminal(record, terminal, 'keep');
      }
      await delay(100);
    }

    // VS Code can lazily open background terminal PTYs. Rebuild every tmux
    // session here so inactive tabs are alive before their visual clients attach.
    for (const record of records) {
      try {
        await this.ensureSession(record);
      } catch (error) {
        this.log('restore-session', error);
      }
    }

    // onStartupFinished can still precede the terminal editor mounting its DOM
    // container. Creating a custom PTY during that gap produces a real tab with
    // a live tmux session behind it, but xterm rejects `_open` and the tab stays
    // blank until a later manual restore. The forced path already runs from a
    // mounted workbench; only the activation path needs this short settling
    // window.
    if (!force) await delay(1200);

    let lastTerminal;
    const liveEditorTabs = new Set();
    for (const record of records) {
      const existing = this.terminals.get(record.id);
      if (existing) {
        lastTerminal = existing;
      } else {
        lastTerminal = this.openRecord(record, true);
      }

      // Creating all editor terminals in one burst lets VS Code allocate tab
      // shells before their xterm containers exist. Open and reveal them one at
      // a time so every custom PTY completes its attach before the next editor
      // is created. Restore-driven focus changes are ignored by the attention
      // state handler while `restoringTabs` is true.
      lastTerminal.show(false);
      const pty = this.ptys.get(record.id);
      const ready = pty && await waitFor(() => pty.bridgeReady(), 1800, 25);
      if (!ready) this.output.appendLine(`[restore] PTY bridge did not open: ${record.tmuxSession}`);
      await delay(80);
      if (ready) await pty.replayVisiblePane();
      if (vscode.window.activeTerminal === lastTerminal) {
        const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
        if (activeTab && activeTab.input instanceof vscode.TabInputTerminal) {
          liveEditorTabs.add(activeTab);
        }
      }
    }

    await this.closeDuplicateManagedTerminalTabs(liveEditorTabs, records);

    const preferredRecord = records.reduce((preferred, record) => (
      !preferred || (record.lastFocusedAt || 0) >= (preferred.lastFocusedAt || 0)
        ? record
        : preferred
    ), undefined);
    const preferredTerminal = preferredRecord && this.terminals.get(preferredRecord.id);
    // An explicit reveal is required for editor terminals. Without it VS Code
    // may select the tab shell while keeping a different Terminal object active.
    if (preferredTerminal) preferredTerminal.show(false);
    else if (lastTerminal) lastTerminal.show(false);
    if (floatingMonitor && this.monitorPanel === floatingMonitor) {
      await this.floatMonitorPanel(floatingMonitor, lastTerminal);
    }
    this.output.appendLine(`[restore] ${force ? 'manual' : 'startup'}: ${records.length} tab(s) directed to main window`);
    return records.length;
  }

  async showSessionHistory() {
    if (!this.sessionHistory.length) {
      vscode.window.showInformationMessage('There are no session snapshots for this workspace yet.');
      return;
    }

    const liveRaw = await this.runTmux(['list-sessions', '-F', '#{session_name}'], true);
    const liveSessions = new Set(liveRaw.split('\n').map((line) => line.trim()).filter(Boolean));
    const currentIds = new Set(this.records.keys());
    const currentTmux = new Set([...this.records.values()].map((record) => record.tmuxSession));
    const items = [...this.sessionHistory].reverse().map((snapshot) => {
      const missing = snapshot.records.filter((record) => (
        !currentIds.has(record.id) && !currentTmux.has(record.tmuxSession)
      ));
      const alive = snapshot.records.filter((record) => liveSessions.has(record.tmuxSession)).length;
      const titles = snapshot.records.map((record) => (
        record.manualTitle || record.autoTitle || shortTitle(record.tmuxSession)
      ));
      const time = new Date(snapshot.savedAt).toLocaleString([], {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      return {
        label: `$(history) ${time} · ${snapshot.records.length} tab(s)`,
        description: `${alive} live tmux · ${missing.length} missing`,
        detail: titles.join(' · '),
        snapshot,
        missing,
      };
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Session history',
      placeHolder: 'Choose a snapshot to restore only its missing tabs',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    if (!picked.missing.length) {
      vscode.window.showInformationMessage('All tabs from this snapshot are already present.');
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Restore ${picked.missing.length} missing tab(s)? Current tabs will be kept.`,
      'Restore missing tabs',
    );
    if (choice !== 'Restore missing tabs') return;

    this.captureTabOrder();
    await this.checkpointSessionHistory('before-history-restore', true);
    const currentByTmux = new Map(
      [...this.records.values()].map((record) => [record.tmuxSession, record]),
    );
    const snapshotIds = new Set();
    let lastSnapshotOrder = Math.max(
      -1,
      ...picked.snapshot.records
        .filter((record) => Number.isFinite(record.tabOrder))
        .map((record) => record.tabOrder),
    );
    for (const raw of sortRecordsForRestore(picked.snapshot.records)) {
      const current = this.records.get(raw.id) || currentByTmux.get(raw.tmuxSession);
      if (!current) continue;
      current.tabOrder = Number.isFinite(raw.tabOrder) ? raw.tabOrder : lastSnapshotOrder + 1;
      lastSnapshotOrder = Math.max(lastSnapshotOrder, current.tabOrder);
      snapshotIds.add(current.id);
    }
    for (const current of sortRecordsForRestore(this.records.values())) {
      if (snapshotIds.has(current.id)) continue;
      lastSnapshotOrder += 1;
      current.tabOrder = lastSnapshotOrder;
    }
    let pinnedSlots = Math.max(0, 4 - this.pinnedRecords().length);
    for (const raw of picked.missing) {
      const restorePinned = Boolean(raw.monitorPinned && pinnedSlots > 0);
      if (restorePinned) pinnedSlots -= 1;
      const record = normalizeSessionRecord({
        ...raw,
        monitorPinned: restorePinned,
        monitorPinnedAt: restorePinned ? Number(raw.monitorPinnedAt) || Date.now() : 0,
      }, this.workspaceKey);
      if (!record) continue;
      this.records.set(record.id, record);
    }
    await Promise.all([this.persist('history-restore'), this.updateMonitorContext()]);
    await this.restoreTabs(true);
    await this.scanAll();
    vscode.window.showInformationMessage(`${picked.missing.length} tab(s) restored from history.`);
  }

  async clearRecoveryData() {
    const choice = await vscode.window.showWarningMessage(
      'Delete saved composer drafts and session history for this workspace?',
      { modal: true },
      'Delete recovery data',
    );
    if (choice !== 'Delete recovery data') return;
    this.drafts.clear();
    this.sessionHistory = [];
    await Promise.all([
      fs.promises.unlink(this.draftStorePath).catch(ignoreMissingFile),
      fs.promises.unlink(this.historyStorePath).catch(ignoreMissingFile),
    ]);
    vscode.window.showInformationMessage('Local drafts and session history were deleted.');
  }

  async stopAllManagedSessions() {
    const records = [...this.records.values()];
    if (!records.length) {
      vscode.window.showInformationMessage('There are no managed sessions in this workspace.');
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Terminate ${records.length} tmux session(s), close their tabs, and delete their recovery data?`,
      { modal: true },
      'Stop all sessions',
    );
    if (choice !== 'Stop all sessions') return;

    for (const record of records) {
      const terminal = this.terminals.get(record.id);
      if (terminal) {
        this.disposeManagedTerminal(record, terminal, 'keep');
      }
    }
    await delay(100);

    const failures = [];
    for (const record of records) {
      try {
        await this.killTmuxSession(record.tmuxSession);
        this.records.delete(record.id);
        this.drafts.delete(record.id);
        this.monitorPreviewCache.delete(record.id);
      } catch (error) {
        failures.push(record.tmuxSession);
        this.log('stop-all', error);
      }
    }
    await Promise.all([this.persist('stop-all'), this.persistDrafts(), this.updateMonitorContext()]);
    if (!this.records.size) {
      this.sessionHistory = [];
      await Promise.all([
        fs.promises.unlink(this.historyStorePath).catch(ignoreMissingFile),
        fs.promises.unlink(this.draftStorePath).catch(ignoreMissingFile),
      ]);
    }
    if (this.monitorPanel && !this.pinnedRecords().length) this.monitorPanel.dispose();
    if (failures.length) {
      vscode.window.showErrorMessage(
        `${failures.length} session(s) could not be terminated. Their recovery state was kept; see the log.`,
      );
    } else {
      vscode.window.showInformationMessage('All managed sessions and local recovery data were removed.');
    }
  }

  handleOpenTerminal(terminal) {
    const pty = terminal.creationOptions && terminal.creationOptions.pty;
    if (!(pty instanceof ManagedTmuxPty) || pty.manager !== this) return;
    this.ptys.set(pty.record.id, pty);
    this.terminals.set(pty.record.id, terminal);
    this.scheduleTabOrderCapture();
  }

  disposeManagedTerminal(record, terminal, action) {
    const pty = terminal.creationOptions && terminal.creationOptions.pty;
    this.pendingCloseActions.set(terminal, action);
    if (this.terminals.get(record.id) === terminal) this.terminals.delete(record.id);
    if (this.ptys.get(record.id) === pty) this.ptys.delete(record.id);
    try {
      terminal.dispose();
    } catch (error) {
      this.pendingCloseActions.delete(terminal);
      if (pty && typeof pty.dispose === 'function') pty.dispose();
      this.log('terminal-dispose', error);
    }
  }

  async handleCloseTerminal(terminal) {
    const pty = terminal.creationOptions && terminal.creationOptions.pty;
    if (!(pty instanceof ManagedTmuxPty) || pty.manager !== this) return;
    const record = pty.record;
    if (this.terminals.get(record.id) === terminal) this.terminals.delete(record.id);
    if (this.ptys.get(record.id) === pty) this.ptys.delete(record.id);
    pty.dispose();

    const explicitAction = this.pendingCloseActions.get(terminal);
    this.pendingCloseActions.delete(terminal);

    const exitStatus = terminal.exitStatus;
    const reason = exitStatus && exitStatus.reason;
    if (this.deactivating || reason === vscode.TerminalExitReason.Shutdown) {
      this.schedulePersist();
      return;
    }

    if (explicitAction) {
      await this.applyCloseAction(record, explicitAction);
      return;
    }

    if (reason === vscode.TerminalExitReason.User) {
      let action = this.config().get('closeBehavior', 'kill');
      if (!record.owned && action === 'kill') action = 'forget';
      await this.applyCloseAction(record, action);
      return;
    }

    if (reason === vscode.TerminalExitReason.Process) {
      const sessionAlive = await this.tmuxHasSession(record.tmuxSession);
      if (exitStatus.code === 0 && !sessionAlive) {
        this.output.appendLine(`[close] clean shell exit; removing ${record.tmuxSession}`);
        await this.applyCloseAction(record, 'forget');
        return;
      }
    }

    // A tmux/server failure is treated as recoverable. The saved tab returns on restore.
    record.bridgeClosedAt = Date.now();
    this.schedulePersist();
  }

  recordForTerminal(terminal) {
    const pty = terminal.creationOptions && terminal.creationOptions.pty;
    return pty instanceof ManagedTmuxPty && pty.manager === this ? pty.record : undefined;
  }

  activeRecord() {
    const terminalRecord = vscode.window.activeTerminal
      && this.recordForTerminal(vscode.window.activeTerminal);
    if (terminalRecord) return terminalRecord;

    // TabInputTerminal intentionally exposes no Terminal instance in the
    // public API. During editor-area restore, activeTerminal may therefore be
    // empty even though a terminal tab is visibly selected. Resolve it through
    // the same stable visual-label mapping used for tab-order persistence.
    const activeTab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup
      && vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!activeTab || !(activeTab.input instanceof vscode.TabInputTerminal)) return undefined;
    const terminals = [...this.terminals].map(([recordId, managedTerminal]) => {
      const record = this.records.get(recordId);
      return {
        id: recordId,
        name: managedTerminal.name,
        tabOrder: record && record.tabOrder,
        createdAt: record && record.createdAt,
      };
    });
    const [recordId] = recordIdsForTabLabels([activeTab.label], terminals);
    return recordId && this.records.get(recordId);
  }

  async scrollActive(direction) {
    const record = this.activeRecord();
    if (!record) return this.warnManagedTerminal();
    const target = `${record.tmuxSession}:`;
    if (direction === 'up') {
      await this.runTmux(['copy-mode', '-u', '-t', target]);
      return;
    }
    await this.runTmux(['send-keys', '-X', '-t', target, 'page-down-and-cancel'], true);
  }

  async renameActive() {
    const record = this.activeRecord();
    if (!record) return this.warnManagedTerminal();
    const value = record.manualTitle || record.autoTitle || shortTitle(record.tmuxSession);
    const title = await vscode.window.showInputBox({
      title: 'Tab title',
      prompt: 'Leave empty to return to the automatic title',
      value,
    });
    if (title === undefined) return;
    record.manualTitle = normalizeWhitespace(title).slice(0, 80);
    if (!record.manualTitle) record.lastAutoTitleAt = 0;
    this.refreshPtyName(record);
    await this.persist();
  }

  async renameActiveWithAI() {
    const record = this.activeRecord();
    if (!record) return this.warnManagedTerminal();

    await this.scanAll();
    const context = await this.renameContext(record);
    if (context.agent && !context.messages.length) {
      this.output.appendLine(
        `[rename-context] ${record.tmuxSession}: no user messages; `
        + `transcript=${context.transcript || 'none'}; error=${context.error || 'none'}`,
      );
      const choice = await vscode.window.showWarningMessage(
        'No user messages were found in the transcript, so the previous title was kept.',
        'Diagnose',
        'Open log',
      );
      if (choice === 'Diagnose') await this.diagnoseRenameAI();
      if (choice === 'Open log') this.output.show();
      return;
    }
    const provider = this.renameProvider(context.agent);
    const fallbackTitle = normalizeContextTitle(context.localSource) || 'terminal';
    let result;
    let failure;
    try {
      result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Renaming with ${providerLabel(provider)}...`,
        cancellable: false,
      }, () => this.generateRenameTitle(provider, context.source, context.localSource));
    } catch (error) {
      this.log('rename-ai', error);
      failure = error;
      result = { title: fallbackTitle, provider: 'local', model: 'deterministic fallback' };
    }

    record.manualTitle = result.title;
    record.lastRenameProvider = result.provider;
    record.lastRenameModel = result.model;
    record.lastRenamedAt = Date.now();
    this.refreshPtyName(record);
    await this.persist();
    this.output.appendLine(
      `[rename-ai] ${record.tmuxSession}: ${result.provider}/${result.model}; `
      + `${context.messages.length} recent message(s); ${context.bytesRead} transcript byte(s); `
      + `title=${result.title}`,
    );

    if (failure) {
      const choice = await vscode.window.showWarningMessage(
        `${providerLabel(provider)} failed; used the local fallback "${result.title}".`,
        'Open log',
        'Diagnose',
      );
      if (choice === 'Open log') this.output.show();
      if (choice === 'Diagnose') await this.diagnoseRenameAI();
    } else {
      vscode.window.setStatusBarMessage(
        `AI Sessions: "${result.title}" via ${providerLabel(result.provider)} (${result.model})`,
        5000,
      );
    }
  }

  renameAgent(record) {
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

  async renameContext(record) {
    const agent = this.renameAgent(record);
    let transcript = agent && agent.transcript;
    if (!transcript && agent && agent.type === 'codex' && UUID_RE.test(agent.sessionId || '')) {
      transcript = this.codexTranscriptCache.get(agent.sessionId)
        || await findFileEndingWith(path.join(codexHome(), 'sessions'), `${agent.sessionId}.jsonl`);
    }
    if (!transcript && agent && agent.type === 'claude' && UUID_RE.test(agent.sessionId || '')) {
      const pane = (record.windows || []).flatMap((window) => window.panes || [])
        .find((item) => item.agent === agent);
      if (pane && pane.cwd) {
        const candidate = path.join(
          os.homedir(), '.claude', 'projects', encodeClaudeProject(pane.cwd), `${agent.sessionId}.jsonl`,
        );
        if (fs.existsSync(candidate)) transcript = candidate;
      }
    }

    let messages = [];
    let bytesRead = 0;
    let error;
    if (agent && transcript) {
      try {
        const result = await readRecentUserMessages(agent.type, transcript, 2);
        messages = result.messages;
        bytesRead = result.bytesRead;
        agent.transcript = transcript;
      } catch (readError) {
        error = messageOf(readError);
        this.log('rename-context', readError);
      }
    }
    const fallback = record.sourceTitle || record.autoTitle || record.manualTitle || record.tmuxSession;
    return {
      agent,
      messages,
      transcript,
      bytesRead,
      error,
      localSource: messages.length ? [...messages].reverse().join(' ') : fallback,
      source: buildRenameSource(messages, fallback),
    };
  }

  renameProvider(agent) {
    const configured = this.config().get('renameProvider', 'sameHarness');
    if (configured === 'local' || configured === 'vscode') return configured;
    if (agent && (agent.type === 'codex' || agent.type === 'claude')) return agent.type;
    return 'vscode';
  }

  async generateRenameTitle(provider, source, localSource = source) {
    if (provider === 'local') {
      return { title: normalizeContextTitle(localSource) || 'terminal', provider, model: 'deterministic' };
    }

    const prompt = renamePrompt(source);
    let raw;
    let model;
    if (provider === 'codex') {
      model = 'CLI default';
      const args = [
        'exec',
        '--sandbox', 'read-only',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--skip-git-repo-check',
        '--color', 'never',
        '-C', os.tmpdir(),
        '-c', 'model_reasoning_effort="low"',
        '-',
      ];
      raw = await execFileInputText(this.codexPath(), args, prompt, { timeout: 45000 });
    } else if (provider === 'claude') {
      model = 'CLI default';
      const args = [
        '-p',
        '--safe-mode',
        '--tools', '',
        '--permission-mode', 'dontAsk',
        '--no-session-persistence',
        '--output-format', 'text',
      ];
      raw = await execFileInputText(this.claudePath(), args, prompt, { timeout: 45000, cwd: os.tmpdir() });
    } else if (provider === 'vscode') {
      const models = vscode.lm ? await vscode.lm.selectChatModels() : [];
      if (!models.length) throw new Error('No VS Code language model is available');
      const selected = models[0];
      model = selected.name || selected.id || selected.family || 'language-model';
      const response = await selected.sendRequest([
        vscode.LanguageModelChatMessage.User(prompt),
      ]);
      raw = '';
      for await (const chunk of response.text) {
        raw += chunk;
        if (raw.length > 160) break;
      }
    } else {
      throw new Error(`Unsupported rename provider: ${provider}`);
    }

    const title = normalizeContextTitle(raw);
    if (!title) throw new Error(`${providerLabel(provider)} returned an empty title`);
    return { title, provider, model };
  }

  codexPath() {
    return configuredExecutable(this.config(), 'codex');
  }

  claudePath() {
    return configuredExecutable(this.config(), 'claude');
  }

  async diagnoseRenameAI() {
    const record = this.activeRecord();
    if (record) await this.scanAll();
    const context = record ? await this.renameContext(record) : undefined;
    const preferred = this.renameProvider(context && context.agent);
    const lines = [
      `[rename-diagnostic] ${new Date().toISOString()}`,
      `active managed tab: ${record ? record.tmuxSession : 'none'}`,
      `detected harness: ${context && context.agent ? context.agent.type : 'none'}`,
      `preferred provider: ${preferred}`,
      `recent relevant messages: ${context ? context.messages.length : 0}`,
      `transcript: ${context && context.transcript ? redactPath(context.transcript) : 'none'}`,
      `transcript bytes scanned: ${context ? context.bytesRead : 0}`,
      `context error: ${context && context.error ? compactDiagnostic(context.error) : 'none'}`,
    ];

    const codex = await commandStatus(
      this.codexPath(), ['login', 'status'], { timeout: 6000 },
    );
    lines.push(`codex (${redactPath(this.codexPath())}): ${codex.ok ? compactDiagnostic(codex.output) : `ERROR ${compactDiagnostic(codex.error)}`}`);

    const claude = await commandStatus(
      this.claudePath(), ['auth', 'status', '--json'], { timeout: 6000 },
    );
    lines.push(`claude (${redactPath(this.claudePath())}): ${claude.ok ? formatClaudeAuthDiagnostic(claude.output) : `ERROR ${compactDiagnostic(claude.error)}`}`);

    try {
      const models = vscode.lm ? await vscode.lm.selectChatModels() : [];
      lines.push(`VS Code language models: ${models.length}${models.length ? ` (${models.map((model) => model.name || model.id || model.family).join(', ')})` : ''}`);
    } catch (error) {
      lines.push(`VS Code language models: ERROR ${compactDiagnostic(messageOf(error))}`);
    }

    this.output.appendLine(lines.join('\n'));
    this.output.appendLine('');
    const providerReady = preferred === 'codex' ? codex.ok
      : preferred === 'claude' ? claude.ok
        : preferred === 'local' || lines.some((line) => /^VS Code language models: [1-9]/.test(line));
    const summary = providerReady
      ? `${providerLabel(preferred)} is available. Context: ${context ? context.messages.length : 0} message(s).`
      : `${providerLabel(preferred)} is unavailable; rename will use the visible local fallback.`;
    const choice = await vscode.window.showInformationMessage(summary, 'Open log');
    if (choice === 'Open log') this.output.show();
  }

  async removeActive() {
    const record = this.activeRecord();
    if (!record) return this.warnManagedTerminal();
    const choice = await vscode.window.showQuickPick([
      { label: 'Terminate tmux and remove tab', action: 'kill' },
      { label: 'Remove tab only', description: 'keep the tmux session running', action: 'forget' },
    ], { placeHolder: record.tmuxSession });
    if (!choice) return;

    const terminal = this.terminals.get(record.id);
    if (terminal) {
      this.disposeManagedTerminal(record, terminal, choice.action);
    } else {
      await this.applyCloseAction(record, choice.action);
    }
  }

  async applyCloseAction(record, action) {
    if (action === 'keep') {
      this.schedulePersist();
      return true;
    }
    this.captureTabOrder();
    await this.checkpointSessionHistory('before-remove', true);
    if (action === 'kill') {
      try {
        await this.killTmuxSession(record.tmuxSession);
      } catch (error) {
        this.log('close-kill', error);
        record.bridgeClosedAt = Date.now();
        await this.persist('kill-failed');
        const choice = await vscode.window.showErrorMessage(
          `Could not terminate ${record.tmuxSession}. Its recovery data was kept.`,
          'Forget anyway',
          'Open log',
        );
        if (choice === 'Open log') this.output.show();
        if (choice === 'Forget anyway') return this.applyCloseAction(record, 'forget');
        return false;
      }
    }
    const wasPinned = Boolean(record.monitorPinned);
    this.records.delete(record.id);
    this.monitorPreviewCache.delete(record.id);
    this.cancelDraftCapture(record);
    this.drafts.delete(record.id);
    await Promise.all([this.persist(), this.persistDrafts(), this.updateMonitorContext()]);
    if (wasPinned && !this.pinnedRecords().length && this.monitorPanel) {
      this.monitorPanel.dispose();
    } else if (wasPinned) {
      await this.refreshMonitor();
    }
    return true;
  }

  async attachExisting() {
    const raw = await this.runTmux([
      'list-sessions', '-F', '#{session_name}\t#{@ai-terminal-workspace}',
    ], true);
    const existing = new Set([...this.records.values()].map((record) => record.tmuxSession));
    const items = [];
    for (const line of raw.split('\n').filter(Boolean)) {
      const [name, workspaceHash] = line.split('\t');
      if (!name || workspaceHash !== this.workspaceHash || existing.has(name)) continue;
      const panes = (await this.runTmux([
        'list-panes', '-t', name, '-F', '#{pane_id}',
      ], true)).split('\n').filter(Boolean);
      if (panes.length !== 1) continue;
      items.push({ label: name, description: 'orphaned private session', name });
    }

    if (!items.length) {
      vscode.window.showInformationMessage('No orphaned private sessions were found for this workspace.');
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: 'Private sessions to recover as tabs in this workspace',
    });
    if (!picked || !picked.length) return;

    for (const item of picked) {
      const cwd = (await this.runTmux([
        'display-message', '-p', '-t', `${item.name}:`, '#{pane_current_path}',
      ], true)).trim() || getDefaultCwd();
      const record = this.createRecord({
        tmuxSession: item.name,
        cwd,
        owned: true,
        autoTitle: shortTitle(item.name),
      });
      this.openRecord(record, false);
    }
    await this.persist();
    await this.scanAll();
  }

  async makeDefault() {
    const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');
    const profileSetting = terminalProfileSetting();
    if (!profileSetting) throw new Error(`Unsupported platform: ${process.platform}`);
    await terminalConfig.update(profileSetting, 'AI Sessions', vscode.ConfigurationTarget.Global);
    await terminalConfig.update('defaultLocation', 'editor', vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('AI Sessions is now the default terminal profile.');
  }

  warnManagedTerminal() {
    vscode.window.showWarningMessage('The active terminal is not managed by AI Terminal Sessions.');
  }

  async ensureSession(record, dimensions) {
    const current = this.ensurePromises.get(record.id);
    if (current) return current;
    const promise = this.ensureSessionImpl(record, dimensions).finally(() => {
      this.ensurePromises.delete(record.id);
    });
    this.ensurePromises.set(record.id, promise);
    return promise;
  }

  async ensureSessionImpl(record, dimensions) {
    const alive = await this.tmuxHasSession(record.tmuxSession);
    if (!alive) {
      this.output.appendLine(`[restore] rebuilding ${record.tmuxSession}`);
      await this.restoreTmuxSession(record, dimensions);
      record.lastRestoredAt = Date.now();
      this.schedulePersist();
    }
    await this.configureTmuxSession(record);
    if (dimensions) await this.resizeSession(record, dimensions);
  }

  async tmuxHasSession(name) {
    try {
      await this.runTmux(['has-session', '-t', name]);
      return true;
    } catch (error) {
      if (isMissingTmuxSessionError(error)) return false;
      throw error;
    }
  }

  async killTmuxSession(name) {
    try {
      await this.runTmux(['kill-session', '-t', name]);
      return 'killed';
    } catch (error) {
      if (isMissingTmuxSessionError(error)) return 'missing';
      throw error;
    }
  }

  async restoreTmuxSession(record, dimensions) {
    const savedWindows = Array.isArray(record.windows)
      ? record.windows.filter((window) => Array.isArray(window.panes) && window.panes.length)
      : [];
    const fallbackWindow = {
      name: 'shell', active: true, panes: [{ cwd: record.cwd, active: true }],
    };
    const savedWindow = savedWindows.find((window) => window.active) || savedWindows[0] || fallbackWindow;
    const savedPane = savedWindow.panes.find((pane) => pane.active) || savedWindow.panes[0];
    const args = [
      'new-session', '-d', '-s', record.tmuxSession,
      '-n', safeTmuxName(savedWindow.name || 'shell'),
      '-c', existingDirectory(savedPane.cwd || record.cwd),
    ];
    if (dimensions) args.push('-x', String(dimensions.columns), '-y', String(dimensions.rows));
    const command = this.restoreCommand(savedPane.agent);
    if (command) args.push(command);
    await this.runTmux(args);
  }

  restoreCommand(agent) {
    if (!this.config().get('restoreAgents', true) || !agent || !agent.active || !UUID_RE.test(agent.sessionId || '')) {
      return undefined;
    }
    const shell = resolveExecutable(process.env.SHELL || 'zsh', 'zsh');
    let executable;
    let args;
    if (agent.type === 'claude') {
      executable = this.claudePath();
      args = ['--resume', agent.sessionId];
    } else if (agent.type === 'codex') {
      executable = this.codexPath();
      args = ['resume', agent.sessionId];
    } else {
      return undefined;
    }
    const resume = [shellQuote(executable), ...args.map(shellQuote)].join(' ');
    const command = `${resume}; exec ${shellQuote(shell)} -l`;
    return `${shellQuote(shell)} -lic ${shellQuote(command)}`;
  }

  async configureTmuxSession(record) {
    // VS Code sends modified Enter as CSI-u. The private tmux server starts
    // without a tmux.conf, so explicitly preserve extended keys for TUIs.
    await this.runTmux(['set-option', '-s', 'terminal-features[100]', 'xterm*:extkeys']);
    await this.runTmux(['set-option', '-s', 'extended-keys-format', 'csi-u']);
    await this.runTmux(['set-option', '-t', record.tmuxSession, 'extended-keys', 'always']);
    await this.runTmux(['set-option', '-t', record.tmuxSession, '@ai-terminal-id', record.id], true);
    await this.runTmux(['set-option', '-t', record.tmuxSession, '@ai-terminal-workspace', this.workspaceHash], true);
    await this.runTmux(['set-option', '-t', record.tmuxSession, 'destroy-unattached', 'off'], true);
    await this.runTmux(['set-option', '-t', record.tmuxSession, 'status', 'off'], true);
    await this.runTmux(['set-option', '-t', record.tmuxSession, 'set-titles', 'off'], true);
    await this.runTmux(['set-option', '-t', record.tmuxSession, 'prefix', 'None'], true);
    await this.runTmux(['set-option', '-t', record.tmuxSession, 'prefix2', 'None'], true);
    await this.runTmux(['set-option', '-t', record.tmuxSession, 'mouse', 'on'], true);
    await this.runTmux(['set-window-option', '-t', `${record.tmuxSession}:`, 'window-size', 'latest'], true);
    await this.runTmux(['set-window-option', '-t', `${record.tmuxSession}:`, 'automatic-rename', 'off'], true);
  }

  async resizeSession(record, dimensions) {
    if (!dimensions || dimensions.columns < 2 || dimensions.rows < 2) return;
    await this.runTmux([
      'resize-window', '-t', `${record.tmuxSession}:`,
      '-x', String(dimensions.columns), '-y', String(dimensions.rows),
    ], true);
  }

  async runTmux(args, allowFailure = false) {
    try {
      return await execFileText(this.tmuxPath(), this.tmuxArguments(args), { timeout: 6000 });
    } catch (error) {
      if (allowFailure) {
        if (!isMissingTmuxSessionError(error)) {
          this.output.appendLine(`[tmux-best-effort] ${compactDiagnostic(messageOf(error))}`);
        }
        return '';
      }
      throw error;
    }
  }

  async runTmuxInput(args, input) {
    return execFileInputText(
      this.tmuxPath(),
      this.tmuxArguments(args),
      input,
      { timeout: 6000 },
    );
  }

  async scanAll() {
    if (this.scanPromise) return this.scanPromise;
    if (this.deactivating || !this.records.size) return undefined;
    this.scanPromise = this.scanAllImpl().finally(() => {
      this.scanPromise = undefined;
    });
    return this.scanPromise;
  }

  async scanAllImpl() {
    const nativeRenameChanged = this.captureNativeRenames();
    await this.loadCodexThreadNames();
    const panesRaw = await this.runTmux([
      'list-panes', '-a', '-F',
      '#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_layout}\t#{pane_id}\t#{pane_index}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_active}\t#{pane_title}\t#{pane_start_command}',
    ], true);
    const panesBySession = groupPanesBySession(parseTmuxPanes(panesRaw));
    const processTable = await readProcessTable();
    const now = Date.now();
    const snapshotDue = now - this.lastSnapshotAt >= SNAPSHOT_MS;
    let changed = nativeRenameChanged;

    for (const record of this.records.values()) {
      const panes = panesBySession.get(record.tmuxSession) || [];
      if (!panes.length) continue;
      changed = (await this.scanRecord(record, panes, processTable, now, snapshotDue)) || changed;
    }
    this.updateWorkingAnimation();
    if (snapshotDue) this.lastSnapshotAt = now;
    if (changed || snapshotDue) this.schedulePersist();
  }

  captureNativeRenames(force = false) {
    const now = Date.now();
    let changed = false;
    for (const [recordId, terminal] of this.terminals) {
      const record = this.records.get(recordId);
      const pty = this.ptys.get(recordId);
      changed = this.captureNativeRename(record, terminal, pty, now, force) || changed;
    }
    return changed;
  }

  captureNativeRename(record, terminal, pty, now = Date.now(), force = false) {
    if (!record || !pty || !pty.opened || !terminal.name) return false;
    if (terminal.name === pty.lastName) return false;
    if (!force && now - (pty.lastNameChangedAt || 0) < 500) return false;

    const title = stripStatusPrefix(terminal.name).slice(0, 80);
    if (!title) return false;
    const expectedTitle = record.manualTitle || record.autoTitle || shortTitle(record.tmuxSession);
    if (title === expectedTitle) return false;
    if (terminal.name === pty.lastCapturedNativeName && title === record.manualTitle) return false;
    record.manualTitle = title;
    record.nativeRenamedAt = now;
    pty.lastCapturedNativeName = terminal.name;
    this.output.appendLine(`[rename-native] ${record.tmuxSession}: title=${title}`);
    pty.setName(this.formatTerminalName(record));
    return true;
  }

  async scanRecord(record, panes, processTable, now, snapshotDue) {
    const oldWindows = record.windows || [];
    const previousByPosition = new Map();
    for (const window of oldWindows) {
      for (const pane of window.panes || []) {
        previousByPosition.set(`${window.index}:${pane.index}`, pane);
      }
    }

    const windowsById = new Map();
    for (const pane of panes) {
      let window = windowsById.get(pane.windowId);
      if (!window) {
        window = {
          id: pane.windowId,
          index: pane.windowIndex,
          name: pane.windowName,
          active: pane.windowActive,
          panes: [],
        };
        windowsById.set(pane.windowId, window);
      }
      const previous = previousByPosition.get(`${pane.windowIndex}:${pane.paneIndex}`);
      let agent = await this.detectAgent(pane, processTable, now);
      if (!agent && previous && previous.agent) {
        const grace = now - (previous.agent.lastSeenAt || 0) < 10000;
        agent = { ...previous.agent, active: grace, status: grace ? previous.agent.status : 'idle' };
        if (!grace) delete agent.pid;
      }
      window.panes.push({
        id: pane.id,
        index: pane.paneIndex,
        cwd: pane.cwd,
        process: pane.command,
        startCommand: pane.startCommand,
        active: pane.active,
        ...(agent && { agent }),
      });
    }

    const windows = [...windowsById.values()]
      .sort((a, b) => a.index - b.index)
      .map((window) => ({
        ...window,
        panes: window.panes.sort((a, b) => a.index - b.index),
      }));
    const activeAgents = windows.flatMap((window) => window.panes)
      .filter((pane) => pane.agent && pane.agent.active)
      .map((pane) => ({ ...pane.agent, paneActive: pane.active }));
    activeAgents.sort((a, b) => agentPriority(b) - agentPriority(a));
    const selected = activeAgents[0];
    const oldStatus = record.status;
    const oldFingerprint = record.fingerprint;
    const newlyReady = isNewReadyEvent(record, selected);

    record.windows = windows;
    record.cwd = (windows.find((window) => window.active)?.panes.find((pane) => pane.active)?.cwd) || record.cwd;
    record.status = selected ? selected.status : 'idle';
    if (selected && selected.lastActivityAt) record.lastAgentActivityAt = selected.lastActivityAt;
    record.sourceTitle = selected && selected.title ? selected.title : record.sourceTitle;
    record.activeAgent = selected ? { type: selected.type, sessionId: selected.sessionId } : undefined;
    if (newlyReady) {
      record.readyAt = now;
    }
    record.updatedAt = snapshotDue ? now : record.updatedAt;
    this.updateAutomaticTitle(record, selected, now);
    record.fingerprint = fingerprintRecord(record);
    this.refreshPtyName(record);

    if (selected && (newlyReady || (oldStatus === 'running' && selected.status === 'waiting'))) {
      this.notifyReady(record, selected.status);
    }
    return oldFingerprint !== record.fingerprint;
  }

  async detectAgent(pane, processTable, now) {
    const processes = descendantsOf(Number(pane.pid), processTable);
    const claudeCandidates = processes.filter((item) => matchesExecutable(item, 'claude'));
    for (const processInfo of claudeCandidates) {
      const agent = await this.resolveClaudeAgent(processInfo, pane, now);
      if (agent) return agent;
    }

    const codexCandidates = processes.filter((item) => matchesExecutable(item, 'codex'));
    for (const processInfo of codexCandidates) {
      const agent = await this.resolveCodexAgent(processInfo, pane, now);
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
        status: 'running', title: 'Claude Code', active: true, lastSeenAt: now,
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
    };
  }

  async resolveCodexAgent(processInfo, pane, now) {
    const cacheKey = `${processInfo.pid}:${processInfo.command}`;
    const cached = this.codexPidCache.get(cacheKey);
    let sessionId = cached && cached.sessionId;
    if (!sessionId && (!cached || now - cached.at >= 5000)) {
      const argId = processInfo.command.match(/\bresume\s+([0-9a-f-]{36})\b/i)?.[1];
      sessionId = UUID_RE.test(argId || '') ? argId : await this.queryCodexSessionId(processInfo.pid);
      this.codexPidCache.set(cacheKey, { at: now, sessionId });
    }
    if (!UUID_RE.test(sessionId || '')) {
      return {
        type: 'codex', sessionId: '', pid: processInfo.pid, process: 'codex',
        status: 'running', title: 'Codex', active: true, lastSeenAt: now,
      };
    }

    let transcript = this.codexTranscriptCache.get(sessionId);
    if (!transcript || !fs.existsSync(transcript)) {
      transcript = await findFileEndingWith(path.join(codexHome(), 'sessions'), `${sessionId}.jsonl`);
      if (transcript) this.codexTranscriptCache.set(sessionId, transcript);
    }
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
    };
  }

  async queryCodexSessionId(pid) {
    const db = codexLogDatabase();
    if (!db) return undefined;
    const query = `SELECT thread_id FROM logs WHERE process_uuid LIKE 'pid:${Number(pid)}:%' AND thread_id IS NOT NULL ORDER BY ts DESC LIMIT 1;`;
    try {
      const raw = await execFileText(resolveExecutable('sqlite3', 'sqlite3'), [
        '-readonly', '-noheader', '-cmd', '.timeout 100', db, query,
      ], { timeout: 2000 });
      return raw.trim().split('\n').find((line) => UUID_RE.test(line.trim()))?.trim();
    } catch (error) {
      this.log('codex-sqlite', error);
      return undefined;
    }
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

  updateAutomaticTitle(record, agent, now) {
    if (record.manualTitle || !agent || !agent.title) return;
    const sourceChanged = record.titleSourceSessionId !== agent.sessionId;
    if (!record.autoTitle || sourceChanged || now - (record.lastAutoTitleAt || 0) >= TITLE_REFRESH_MS) {
      record.autoTitle = shortTitle(agent.title);
      record.lastAutoTitleAt = now;
      record.titleSourceSessionId = agent.sessionId;
    }
  }

  formatTerminalName(record) {
    const title = record.manualTitle || record.autoTitle || shortTitle(record.tmuxSession);
    if (record.status === 'running') {
      return `${workingIndicator(this.workingAnimationFrame, this.reducedMotionEnabled())} ${title}`;
    }
    const icon = terminalStatusIcon(record, {
      recentMinutes: IDLE_RECENT_MINUTES,
      oldHours: IDLE_OLD_HOURS,
    });
    return `${icon} ${title}`;
  }

  reducedMotionEnabled() {
    return vscode.workspace.getConfiguration('workbench').get('reduceMotion', 'auto') === 'on';
  }

  updateWorkingAnimation() {
    const shouldAnimate = !this.reducedMotionEnabled()
      && [...this.records.values()].some((record) => record.status === 'running');
    if (!shouldAnimate) {
      if (this.workingAnimationTimer) clearInterval(this.workingAnimationTimer);
      this.workingAnimationTimer = undefined;
      this.workingAnimationFrame = 0;
      return;
    }
    if (this.workingAnimationTimer) return;
    this.workingAnimationTimer = setInterval(() => {
      const running = [...this.records.values()].filter((record) => record.status === 'running');
      if (!running.length || this.deactivating) {
        this.updateWorkingAnimation();
        return;
      }
      this.workingAnimationFrame = (this.workingAnimationFrame + 1) % WORKING_FRAMES.length;
      for (const record of running) this.refreshPtyName(record);
    }, 800);
  }

  acknowledgeReady(record) {
    if (!record || record.status !== 'done' || !record.readyAt) return false;
    if ((record.lastAcknowledgedReadyAt || 0) >= record.readyAt) return false;
    record.lastAcknowledgedReadyAt = record.readyAt;
    this.refreshPtyName(record);
    return true;
  }

  refreshPtyName(record) {
    const pty = this.ptys.get(record.id);
    if (pty) pty.setName(this.formatTerminalName(record));
  }

  notifyReady(record, status) {
    if (!this.config().get('notifyWhenReady', false)) return;
    const terminal = this.terminals.get(record.id);
    if (terminal && terminal === vscode.window.activeTerminal) return;
    const title = record.manualTitle || record.autoTitle || record.tmuxSession;
    const message = status === 'waiting'
      ? `${title} is waiting for permission.`
      : `${title} finished and needs your attention.`;
    vscode.window.showInformationMessage(message, 'Open').then((choice) => {
      if (choice === 'Open' && terminal) terminal.show(false);
    });
  }

  log(scope, error) {
    this.output.appendLine(`[${scope}] ${messageOf(error)}`);
  }

  async shutdown() {
    if (this.deactivating) return;
    this.deactivating = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.titlePollTimer) clearInterval(this.titlePollTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.tabOrderTimer) clearTimeout(this.tabOrderTimer);
    if (this.workingAnimationTimer) clearInterval(this.workingAnimationTimer);
    this.stopMonitorRefresh();
    const draftRecords = new Map();
    const pendingDraftIds = new Set([
      ...this.draftCaptureTimers.keys(),
      ...this.draftMaxCaptureTimers.keys(),
    ]);
    for (const recordId of pendingDraftIds) {
      const record = this.records.get(recordId);
      if (record) draftRecords.set(record.id, record);
    }
    const active = this.activeRecord();
    if (active) draftRecords.set(active.id, active);
    for (const timer of this.draftCaptureTimers.values()) clearTimeout(timer);
    for (const timer of this.draftMaxCaptureTimers.values()) clearTimeout(timer);
    this.draftCaptureTimers.clear();
    this.draftMaxCaptureTimers.clear();
    this.captureTabOrder();
    this.captureNativeRenames(true);
    await Promise.all([...draftRecords.values()].map((record) => (
      this.captureDraft(record).catch((error) => this.log('draft-shutdown', error))
    )));
    for (const pty of this.ptys.values()) pty.dispose();
    await Promise.all([this.persist(), this.persistDrafts()]);
  }
}

class ManagedTmuxPty {
  constructor(manager, record) {
    this.manager = manager;
    this.record = record;
    this.writeEmitter = new vscode.EventEmitter();
    this.closeEmitter = new vscode.EventEmitter();
    this.nameEmitter = new vscode.EventEmitter();
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
  }

  async open(initialDimensions) {
    this.opened = true;
    if (initialDimensions) this.dimensions = initialDimensions;
    this.setName(this.manager.formatTerminalName(this.record));
    try {
      await this.manager.ensureSession(this.record, initialDimensions);
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
    const nodePty = loadNodePty();
    const child = nodePty.spawn(this.manager.tmuxPath(), this.manager.tmuxArguments([
      'attach-session', '-t', this.record.tmuxSession,
    ]), {
      name: 'xterm-256color',
      cols: this.dimensions.columns,
      rows: this.dimensions.rows,
      cwd: existingDirectory(this.record.cwd),
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    this.child = child;
    this.ignoreOutputActivityUntil = Date.now() + 10000;
    this.childDisposables = [
      child.onData((data) => {
        this.writeEmitter.fire(data);
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

  async primeDisplay() {
    // tmux normally redraws immediately on attach, but a background VS Code
    // terminal can miss that first burst while its renderer is still mounting.
    // Replaying the visible pane makes the attach deterministic; subsequent
    // output continues through the live node-pty bridge.
    await delay(40);
    await this.replayVisiblePane();
  }

  async replayVisiblePane() {
    if (!this.bridgeReady()) return;
    const snapshot = await this.manager.runTmux([
      'capture-pane', '-p', '-e', '-t', `${this.record.tmuxSession}:`,
    ], true);
    if (!snapshot || !snapshot.trim()) return;
    this.writeEmitter.fire(`\x1b[2J\x1b[H${snapshot.replace(/\n/g, '\r\n')}`);
  }

  handleInput(data) {
    if (this.child) this.child.write(data);
    if (this.manager.acknowledgeReady(this.record)) this.manager.schedulePersist();
    const input = analyzeTerminalInput(data, this.bracketedPasteActive);
    this.bracketedPasteActive = input.pasteActive;
    if (input.submitted) {
      this.manager.cancelDraftCapture(this.record);
      this.manager.noteTerminalActivity(this.record, 'input', true);
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
      await this.manager.resizeSession(this.record, dimensions);
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
function loadNodePty() {
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

function parseTmuxPanes(raw) {
  return raw.split('\n').filter(Boolean).map((line) => {
    const parts = line.split('\t');
    return {
      session: parts[0],
      windowId: parts[1],
      windowIndex: Number(parts[2]),
      windowName: parts[3],
      windowActive: parts[4] === '1',
      layout: parts[5],
      id: parts[6],
      paneIndex: Number(parts[7]),
      pid: Number(parts[8]),
      cwd: parts[9],
      command: parts[10],
      active: parts[11] === '1',
      title: parts[12],
      startCommand: parts.slice(13).join('\t'),
    };
  }).filter((pane) => pane.session && pane.id);
}

function groupPanesBySession(panes) {
  const result = new Map();
  for (const pane of panes) {
    if (!result.has(pane.session)) result.set(pane.session, []);
    result.get(pane.session).push(pane);
  }
  return result;
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

async function inspectClaudeTranscript(file, metadataStatus) {
  const snapshot = await readJsonlTail(file);
  const transcriptActivityAt = latestTranscriptActivity(snapshot.entries, 'claude') || snapshot.modifiedAt;
  const transcriptAgeMs = transcriptActivityAt ? Math.max(0, Date.now() - transcriptActivityAt) : 0;
  let status = metadataStatus === 'idle' ? 'done' : metadataStatus ? 'running' : 'idle';
  let title;
  let lastToolUse = false;
  for (const entry of snapshot.entries) {
    if (entry.type === 'custom-title' && entry.customTitle) title = entry.customTitle;
    const message = entry.message;
    if (!message || !message.role) continue;
    const items = Array.isArray(message.content)
      ? message.content
      : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : [];
    if (!title && message.role === 'user') {
      const text = typeof message.content === 'string'
        ? message.content
        : items.find((item) => item.type === 'text')?.text;
      if (isUsefulPrompt(text)) title = text;
    }
    if (message.role === 'assistant') {
      lastToolUse = items.some((item) => item.type === 'tool_use');
      if (lastToolUse || items.some((item) => item.type === 'thinking') || !message.stop_reason) status = 'running';
      else if (message.stop_reason === 'end_turn') status = 'done';
    } else if (message.role === 'user') {
      lastToolUse = false;
      const text = typeof message.content === 'string' ? message.content : items.find((item) => item.type === 'text')?.text;
      if (text && text.startsWith('[Request interrupted')) status = 'interrupted';
      else if (items.some((item) => item.type === 'tool_result') || isUsefulPrompt(text)) status = 'running';
    }
  }
  if (metadataStatus === 'idle') status = 'done';
  if (metadataStatus && metadataStatus !== 'idle' && lastToolUse && transcriptAgeMs >= 3000) status = 'waiting';
  return { status, title, lastActivityAt: transcriptActivityAt || undefined };
}

async function inspectCodexTranscript(file) {
  const snapshot = await readJsonlTail(file);
  const transcriptActivityAt = latestTranscriptActivity(snapshot.entries, 'codex') || snapshot.modifiedAt;
  const transcriptAgeMs = transcriptActivityAt ? Math.max(0, Date.now() - transcriptActivityAt) : 0;
  let status = 'running';
  let title;
  let lastToolCall = false;
  for (const entry of snapshot.entries) {
    const payload = entry.payload || {};
    if (!title) {
      if (entry.type === 'event_msg' && payload.type === 'user_message' && isUsefulPrompt(payload.message)) {
        title = payload.message;
      } else if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
        const text = Array.isArray(payload.content)
          ? payload.content.filter((item) => item.type === 'input_text').map((item) => item.text || '').join('\n')
          : '';
        if (isUsefulPrompt(text)) title = text;
      }
    }
    let nextStatus;
    let toolCall = false;
    if (entry.type === 'event_msg') {
      if (payload.type === 'task_complete') nextStatus = 'done';
      else if (payload.type === 'turn_aborted') nextStatus = 'interrupted';
      else if (payload.type === 'task_started' || payload.type === 'user_message') nextStatus = 'running';
      else if (payload.type === 'agent_message') nextStatus = payload.phase === 'final_answer' ? 'done' : 'running';
    } else if (entry.type === 'response_item') {
      if (payload.type === 'message' && payload.role !== 'developer') {
        nextStatus = payload.role === 'assistant' && payload.phase === 'final_answer' ? 'done' : 'running';
      } else if (['function_call', 'function_call_output', 'reasoning', 'custom_tool_call', 'custom_tool_call_output', 'web_search_call'].includes(payload.type)) {
        nextStatus = 'running';
        toolCall = payload.type === 'function_call';
      }
    } else if (['message', 'function_call', 'function_call_output', 'reasoning'].includes(entry.type)) {
      nextStatus = 'running';
      toolCall = entry.type === 'function_call';
    }
    if (nextStatus) {
      status = nextStatus;
      lastToolCall = toolCall;
    }
  }
  if (status === 'running' && lastToolCall && transcriptAgeMs >= 3000) status = 'waiting';
  return { status, title, lastActivityAt: transcriptActivityAt || undefined };
}

async function readJsonlTail(file, maxBytes = 512 * 1024) {
  if (!file) return { entries: [], ageMs: 0, modifiedAt: 0 };
  let handle;
  try {
    const stat = await fs.promises.stat(file);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    handle = await fs.promises.open(file, 'r');
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(Math.max(0, text.indexOf('\n') + 1));
    const entries = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
    return { entries, ageMs: Math.max(0, Date.now() - stat.mtimeMs), modifiedAt: stat.mtimeMs };
  } catch {
    return { entries: [], ageMs: 0, modifiedAt: 0 };
  } finally {
    if (handle) await handle.close();
  }
}

async function findFileEndingWith(root, suffix) {
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  entries.sort((a, b) => b.name.localeCompare(a.name));
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(suffix)) return full;
    if (entry.isDirectory()) {
      const found = await findFileEndingWith(full, suffix);
      if (found) return found;
    }
  }
  return undefined;
}

function shortTitle(input) {
  const stop = new Set([
    'a', 'an', 'and', 'as', 'at', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'esta', 'este', 'eu',
    'for', 'fazer', 'fix', 'help', 'i', 'in', 'is', 'me', 'my', 'no', 'o', 'of', 'ok', 'on', 'os',
    'para', 'please', 'por', 'preciso', 'que', 'quero', 'the', 'to', 'um', 'uma', 'with', 'you',
  ]);
  const normalized = normalizeWhitespace(String(input || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\\/_-]+/g, ' ')
    .replace(/["'`()[\]{}:;,.!?*#=+|<>]/g, ' '));
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) || [];
  const useful = tokens.filter((token) => {
    const lower = token.toLocaleLowerCase();
    return !stop.has(lower) && !UUID_RE.test(token) && !/^[0-9a-f]{5,}$/i.test(token);
  });
  const picked = (useful.length ? useful : tokens).slice(0, 2);
  return picked.map(titleWord).join(' ') || 'Terminal';
}

function titleWord(word) {
  if (/^[A-Z0-9]{2,}$/.test(word)) return word;
  return word.charAt(0).toLocaleUpperCase() + word.slice(1).toLocaleLowerCase();
}

function isUsefulPrompt(text) {
  if (!text || typeof text !== 'string') return false;
  const value = text.trim();
  return value.length > 1
    && !value.startsWith('<')
    && !value.startsWith('{')
    && !value.startsWith('# AGENTS.md')
    && !value.startsWith('[Request interrupted');
}

function agentPriority(agent) {
  const status = { waiting: 40, done: 30, running: 20, interrupted: 10 }[agent.status] || 0;
  return status + (agent.paneActive ? 2 : 0) + (agent.lastSeenAt || 0) / 1e13;
}

function fingerprintRecord(record) {
  const windows = (record.windows || []).map((window) => ({
    index: window.index,
    name: window.name,
    active: window.active,
    panes: (window.panes || []).map((pane) => ({
      index: pane.index,
      cwd: pane.cwd,
      process: pane.process,
      startCommand: pane.startCommand,
      active: pane.active,
      agent: pane.agent && {
        type: pane.agent.type,
        sessionId: pane.agent.sessionId,
        pid: pane.agent.pid,
        process: pane.agent.process,
        status: pane.agent.status,
        title: pane.agent.title,
        transcript: pane.agent.transcript,
        active: pane.agent.active,
        lastActivityAt: pane.agent.lastActivityAt,
      },
    })),
  }));
  return hashText(JSON.stringify({
    status: record.status,
    autoTitle: record.autoTitle,
    manualTitle: record.manualTitle,
    activeAgent: record.activeAgent,
    lastAgentActivityAt: record.lastAgentActivityAt,
    readyAt: record.readyAt,
    lastAcknowledgedReadyAt: record.lastAcknowledgedReadyAt,
    windows,
  }));
}

function getWorkspaceKey() {
  if (vscode.workspace.workspaceFile) return vscode.workspace.workspaceFile.toString();
  const folders = (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.toString()).sort();
  return folders.length ? folders.join('|') : `folderless:${getDefaultCwd()}`;
}

function getWorkspaceName() {
  if (vscode.workspace.name) return vscode.workspace.name;
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return folder ? folder.name : path.basename(getDefaultCwd()) || 'terminal';
}

function getDefaultCwd() {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) return folder.uri.fsPath;
  }
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return folder ? folder.uri.fsPath : os.homedir();
}

function existingDirectory(candidate) {
  try {
    if (candidate && fs.statSync(candidate).isDirectory()) return candidate;
  } catch {}
  return getDefaultCwd();
}

function safeTmuxName(value) {
  return normalizeWhitespace(value).replace(/[:.]/g, '-').slice(0, 50) || 'shell';
}

function slug(value) {
  return String(value || 'terminal').toLocaleLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || 'terminal';
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function encodeClaudeProject(value) {
  return String(value || '').replace(/[/._]/g, '-');
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
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

function hashText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function messageOf(error) {
  if (!error) return 'unknown error';
  return error.stderr || error.message || String(error);
}

function ignoreMissingFile(error) {
  if (!error || error.code !== 'ENOENT') throw error;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, timeoutMilliseconds, intervalMilliseconds = 25) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(intervalMilliseconds);
  }
  return Boolean(predicate());
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

function compactDiagnostic(value) {
  return normalizeWhitespace(redactDiagnostic(value)).slice(0, 300) || 'no output';
}

function formatClaudeAuthDiagnostic(value) {
  const text = String(value || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  try {
    const payload = JSON.parse(start >= 0 && end >= start ? text.slice(start, end + 1) : text);
    return [
      `loggedIn=${Boolean(payload.loggedIn)}`,
      `authMethod=${payload.authMethod || 'unknown'}`,
      `subscriptionType=${payload.subscriptionType || 'unknown'}`,
    ].join(', ');
  } catch {
    return compactDiagnostic(text);
  }
}

function configuredExecutable(config, name) {
  const executables = config.get('executables', {});
  // Read the former individual path keys when they still exist in user
  // settings so the smaller public configuration surface is non-breaking.
  const legacy = config.get(`${name}Path`);
  const configured = executables && typeof executables === 'object'
    ? executables[name]
    : undefined;
  return resolveExecutable(legacy || configured || name, name);
}

async function commandStatus(file, args, options = {}) {
  try {
    const result = await execFileCapture(file, args, options);
    return { ok: true, output: result.stdout || result.stderr };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

function execFileCapture(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
      });
    });
  });
}

function execFileInputText(file, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.execFile(file, args, {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(String(stdout || '').trimEnd());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(String(input || ''));
  });
}

function execFileText(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(String(stdout || '').trimEnd());
    });
  });
}

module.exports = { activate, deactivate };
