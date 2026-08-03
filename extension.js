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
const { extractConversationPreview } = require('./conversation-preview');
const {
  codexSessionCacheExpired,
  codexSessionIdFromMetadata,
  codexSessionIdFromTranscriptPath,
  codexTranscriptPathsFromLsof,
  newestCodexSessionCandidate,
} = require('./codex-session');
const { extractDraft } = require('./draft-recovery');
const {
  activityReference,
  interruptionReference,
  terminalStatusIcon,
} = require('./session-status');
const {
  activeProcess,
  activityLabel,
  ansiTerminalPreview,
  previewChangedAt,
  statusLabel,
  statusTone,
} = require('./monitor-model');
const { monitorHtml } = require('./monitor-view');
const { historyPreviewHtml } = require('./history-preview');
const {
  appendSessionSnapshot,
  historyPayload,
  normalizeSessionHistory,
} = require('./session-history');
const {
  archiveKey,
  archivePayload,
  migrateSnapshotsToArchive,
  normalizeArchivePayload,
  normalizePreview,
  sessionAgent,
  upsertArchivedSession,
} = require('./session-archive');
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
const {
  agentNeedsAttention,
  focusedPane,
  mergeObservedAgent,
  normalizePaneRole,
  normalizeRestorePolicy,
  paneKey,
  sameAgent,
  sessionPaneSummary,
  sessionPanes,
} = require('./pane-model');
const {
  normalizeRelocationBundle,
  relocateWorkspaceBundle,
  relocationBundle,
} = require('./workspace-relocation');
const { WorkspaceLease } = require('./workspace-lease');
const { WorkbenchWindowAdapter } = require('./workbench-window');
const { matchesExecutable } = require('./process-detection');
const { isMissingTmuxSessionError } = require('./tmux-errors');
const {
  DEFAULT_ICON_PRESET,
  ICON_PRESETS,
  automaticIconPreset,
  iconPreset,
  normalizeIconMode,
  normalizeIconPreset,
} = require('./terminal-icons');
const {
  isSerializedTerminalStubLabel,
  staleManagedTerminalTabs,
} = require('./workbench-recovery');
const {
  recordTitle,
  sessionCounts,
  sessionNeedsAttention,
  sessionTabHealth,
} = require('./session-counter');

const STATE_KEY = 'aiTerminalSessions.state.v1';
const PROFILE_ID = 'aiTerminalSessions.profile';
const LEGACY_MONITOR_VIEW_TYPE = 'aiTerminalSessions.monitor';
const MONITOR_VIEW_ID = 'aiTerminalSessions.sessionMonitor';
const MONITOR_CONTAINER_COMMAND = 'workbench.view.extension.aiTerminalSessionsPanel';
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
const DEFAULT_TMUX_HISTORY_LIMIT = 20000;
const CODEX_SESSION_REFRESH_MS = 5000;
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
let activeManager;
let activeLease;
let activeStartPromise;
let nodePtyModule;

async function activate(context) {
  const activationStartedAt = Date.now();
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
    // Eager activation should register quickly and let the workbench continue
    // starting while terminal tabs restore in the background.
    let startPromise;
    startPromise = manager.start()
      .then(() => {
        output.appendLine(
          `[startup] ready in ${Date.now() - activationStartedAt}ms with ${manager.records.size} session(s)`,
        );
      })
      .catch(async (error) => {
        output.appendLine(`[startup] failed: ${compactDiagnostic(messageOf(error))}`);
        vscode.window.showErrorMessage(
          `AI Terminal Sessions could not start: ${compactDiagnostic(messageOf(error))}`,
        );
        if (activeManager === manager) activeManager = undefined;
        if (activeLease === lease) {
          await lease.release();
          activeLease = undefined;
        }
      })
      .finally(() => {
        if (activeStartPromise === startPromise) activeStartPromise = undefined;
      });
    activeStartPromise = startPromise;
  } catch (error) {
    activeManager = undefined;
    await lease.release();
    activeLease = undefined;
    throw error;
  }
}

async function deactivate() {
  if (activeStartPromise) await activeStartPromise;
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
    this.sessionArchive = [];
    this.archivePersistQueue = Promise.resolve();
    this.archiveStorePath = path.join(
      this.context.globalStorageUri.fsPath,
      `archive-${this.workspaceHash}.json`,
    );
    this.relocationStorePath = path.join(this.context.globalStorageUri.fsPath, 'relocations');
    this.monitorView = undefined;
    this.monitorTimer = undefined;
    this.monitorRefreshing = false;
    this.monitorPreviewCache = new Map();
    this.monitorOpenPromise = undefined;
    this.monitorFocused = false;
    this.monitorReturnTerminal = undefined;
    this.legacyMonitorRecoveryPromise = undefined;
    this.workspaceStorageId = path.basename(
      (this.context.storageUri && this.context.storageUri.fsPath) || '',
    );
    this.sessionStatusBar = undefined;
    this.copyModeStatusBar = undefined;
    this.closeEventsInFlight = 0;
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
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.changeIcon', () => this.changeActiveIcon()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.customizeActive', () => this.customizeActive()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.moreActions', () => this.showMoreActions()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.diagnoseRenameAI', () => this.diagnoseRenameAI()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.restoreDraft', () => this.restoreDraft()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.paneActions', () => this.showPaneActions()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.markHandled', () => this.markActiveHandled()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.markNeedsAttention', () => this.markActiveNeedsAttention()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.scrollPageUp', () => this.scrollActive('up')));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.scrollPageDown', () => this.scrollActive('down')));
    subscriptions.push(vscode.commands.registerCommand(
      'aiTerminalSessions.jumpToBottom',
      () => this.jumpActiveToBottom(),
    ));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.toggleMonitorPin', () => this.toggleMonitorPin()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.toggleMonitor', () => this.toggleMonitor()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.remove', () => this.removeActive()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.showSessionHistory', () => this.showSessionHistory()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.clearRecoveryData', () => this.clearRecoveryData()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.stopAll', () => this.stopAllManagedSessions()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.prepareWorkspaceMove', () => this.prepareWorkspaceMove()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.importWorkspaceMove', () => this.importWorkspaceMove()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.restoreNow', () => this.restoreNow()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.makeDefault', () => this.makeDefault()));
    subscriptions.push(vscode.commands.registerCommand('aiTerminalSessions.showLog', () => this.output.show()));
    subscriptions.push(vscode.commands.registerCommand(
      'aiTerminalSessions.showSessionSwitcher',
      () => this.showSessionSwitcher(),
    ));

    const sessionStatusBar = vscode.window.createStatusBarItem(
      'aiTerminalSessions.sessionCounter',
      vscode.StatusBarAlignment.Left,
      10,
    );
    sessionStatusBar.name = 'AI Terminal Sessions';
    sessionStatusBar.command = 'aiTerminalSessions.showSessionSwitcher';
    this.sessionStatusBar = sessionStatusBar;
    subscriptions.push(sessionStatusBar);
    sessionStatusBar.show();

    const copyModeStatusBar = vscode.window.createStatusBarItem(
      'aiTerminalSessions.copyMode',
      vscode.StatusBarAlignment.Left,
      9,
    );
    copyModeStatusBar.name = 'Tmux Copy Mode';
    copyModeStatusBar.command = 'aiTerminalSessions.jumpToBottom';
    this.copyModeStatusBar = copyModeStatusBar;
    subscriptions.push(copyModeStatusBar);
    this.updateSessionStatusBar();
    subscriptions.push(vscode.window.registerWebviewViewProvider(MONITOR_VIEW_ID, {
      resolveWebviewView: async (view) => this.resolveMonitorView(view),
    }, {
      webviewOptions: { retainContextWhenHidden: true },
    }));
    subscriptions.push(vscode.window.registerWebviewPanelSerializer(LEGACY_MONITOR_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => {
        this.legacyMonitorRecoveryPromise = this.disposeLegacyMonitor(panel);
        await this.legacyMonitorRecoveryPromise;
      },
    }));

    subscriptions.push(vscode.window.onDidOpenTerminal((terminal) => {
      this.handleOpenTerminal(terminal);
      this.updateSessionStatusBar();
    }));
    subscriptions.push(vscode.window.onDidCloseTerminal((terminal) => {
      const pendingAction = this.pendingCloseActions.get(terminal);
      const shouldRestoreFocus = !this.deactivating
        && pendingAction !== 'keep'
        && terminal.exitStatus?.reason !== vscode.TerminalExitReason.Shutdown;
      this.closeEventsInFlight += 1;
      this.handleCloseTerminal(terminal)
        .catch((error) => this.log('terminal-close', error))
        .finally(() => {
          this.closeEventsInFlight = Math.max(0, this.closeEventsInFlight - 1);
          this.updateSessionStatusBar();
          if (shouldRestoreFocus) {
            setTimeout(() => {
              this.focusAfterTerminalClose(terminal)
                .catch((error) => this.log('terminal-close-focus', error));
            }, 80);
          }
        });
    }));
    subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(() => {
      this.scheduleTabOrderCapture();
      const record = this.activeRecord();
      this.updateManagedTerminalContext(record);
      this.updateSessionStatusBar();
    }));
    subscriptions.push(vscode.window.tabGroups.onDidChangeTabGroups(() => {
      this.scheduleTabOrderCapture();
      this.updateManagedTerminalContext(this.activeRecord());
      this.updateSessionStatusBar();
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
      this.acknowledgeInterrupted(record);
      this.updateManagedTerminalContext(record);
      this.schedulePersist();
      this.updateSessionStatusBar();
    }));
  }

  async start() {
    await this.loadState();
    await this.loadSessionHistory();
    await this.loadDrafts();
    await this.loadSessionArchive();
    await this.migrateSessionArchive();
    await this.checkpointSessionHistory('startup');
    if (this.demoMode) {
      const { seedDemo } = require('./demo/demo-seed');
      await seedDemo(this);
    }
    await this.closeSerializedTerminalStubs();
    if (this.legacyMonitorRecoveryPromise) await this.legacyMonitorRecoveryPromise;
    await this.restoreTabs(false);
    if (this.demoMode) await this.waitForDemoSessions();
    await this.scanAll();
    this.updateManagedTerminalContext(this.activeRecord());
    await this.updateMonitorContext();
    this.started = true;
    this.updateSessionStatusBar();
    if (this.monitorView) await this.refreshMonitor();
    if (this.demoMode && !this.monitorView && this.pinnedRecords().length) {
      await this.openMonitor();
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
        Promise.resolve(vscode.window.showInformationMessage(
          'Use AI Sessions as the default terminal profile? This changes your global terminal profile and default location.',
          'Enable globally',
          'Not now',
        )).then((choice) => (
          choice === 'Enable globally' ? this.makeDefault() : undefined
        )).catch((error) => this.log('default-profile-prompt', error));
      }
    }
  }

  async closeSerializedTerminalStubs() {
    const staleTabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => (
      tab.input instanceof vscode.TabInputTerminal
      && isSerializedTerminalStubLabel(tab.label, this.workspaceStorageId)
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

  async disposeLegacyMonitor(panel) {
    try {
      if (this.hasSuspiciousTerminalEditors()) {
        await this.workbench.restoreEditorsToMainWindow();
      }
      panel.dispose();
      await this.workbench.switchToMainWindow();
      this.output.appendLine('[monitor] removed legacy floating monitor');
    } catch (error) {
      this.log('monitor-legacy', error);
    }
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

  async loadSessionArchive() {
    let payload;
    try {
      payload = JSON.parse(await fs.promises.readFile(this.archiveStorePath, 'utf8'));
    } catch (error) {
      if (error && error.code !== 'ENOENT') this.log('archive-load', error);
      return;
    }
    this.sessionArchive = normalizeArchivePayload(payload, this.workspaceKey);
    this.output.appendLine(`[archive] loaded ${this.sessionArchive.length} session(s)`);
  }

  persistSessionArchive() {
    this.archivePersistQueue = this.archivePersistQueue.catch(() => {}).then(async () => {
      const directory = path.dirname(this.archiveStorePath);
      const temporary = `${this.archiveStorePath}.${process.pid}.tmp`;
      await fs.promises.mkdir(directory, { recursive: true });
      await fs.promises.writeFile(
        temporary,
        JSON.stringify(archivePayload(this.workspaceKey, this.sessionArchive)),
        { encoding: 'utf8', mode: 0o600 },
      );
      await fs.promises.rename(temporary, this.archiveStorePath);
    });
    return this.archivePersistQueue;
  }

  async migrateSessionArchive() {
    const migrated = migrateSnapshotsToArchive(
      this.sessionArchive,
      this.sessionHistory,
      this.records.values(),
    );
    this.sessionArchive = migrated.entries;
    let changed = migrated.changed;
    for (const entry of this.sessionArchive) {
      const draft = this.latestDraftForRecord(entry.record);
      if (!draft || entry.preview.some((message) => message.role === 'draft')) continue;
      entry.preview = normalizePreview([...entry.preview, { role: 'draft', text: draft.text }]);
      changed = true;
    }
    if (!changed) return false;
    await this.persistSessionArchive();
    this.output.appendLine(`[archive] migrated ${this.sessionArchive.length} recoverable session(s)`);
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

  noteTerminalActivity(record, source = 'output', forcePersist = false, pane = focusedPane(record)) {
    if (!record || !this.records.has(record.id) || this.deactivating) return;
    const now = Date.now();
    if (pane) {
      pane.lastTerminalActivityAt = now;
      pane.lastTerminalActivitySource = source;
    }
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

  draftKeyForRecord(record, pane = focusedPane(record)) {
    return paneKey(record && record.id, pane);
  }

  latestDraftForRecord(record) {
    const prefix = `${record.id}:`;
    return [...this.drafts]
      .filter(([key]) => key === record.id || key.startsWith(prefix))
      .map(([, draft]) => draft)
      .sort((left, right) => (right.capturedAt || 0) - (left.capturedAt || 0))[0];
  }

  deleteDraftsForRecord(record) {
    const prefix = `${record.id}:`;
    for (const key of [...this.drafts.keys()]) {
      if (key === record.id || key.startsWith(prefix)) this.drafts.delete(key);
    }
  }

  async readComposer(record, pane = focusedPane(record)) {
    const target = pane && pane.id || `${record.tmuxSession}:`;
    const raw = await this.runTmux([
      'capture-pane', '-p', '-J', '-t', target, '-S', '-80',
    ], true);
    return extractDraft(raw);
  }

  async captureDraft(record) {
    if (!record || !this.records.has(record.id) || !this.config().get('draftRecovery', true)) return;
    const pane = await this.liveFocusedPane(record);
    const key = this.draftKeyForRecord(record, pane);
    const text = await this.readComposer(record, pane);
    if (!text || !this.records.has(record.id)) return;
    const previous = this.drafts.get(key);
    if (previous && previous.text === text) return;
    this.drafts.set(key, { text, capturedAt: Date.now() });
    await this.persistDrafts();
    this.output.appendLine(`[draft] saved ${record.tmuxSession}: ${text.length} character(s)`);
  }

  async restoreDraft() {
    const record = this.activeRecord();
    if (!record) return this.warnManagedTerminal();
    const pane = await this.liveFocusedPane(record);
    const snapshot = this.drafts.get(this.draftKeyForRecord(record, pane))
      || this.drafts.get(record.id);
    if (!snapshot || !snapshot.text) {
      vscode.window.showInformationMessage('There is no saved draft for this tab.');
      return;
    }

    const current = await this.readComposer(record, pane);
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
      'paste-buffer', '-p', '-d', '-b', bufferName, '-t', pane && pane.id || `${record.tmuxSession}:`,
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
    const editable = Boolean(record && !['running', 'waiting', 'error', 'interrupted'].includes(record.status));
    const needsAttention = Boolean(record && (
      record.manuallyNeedsAttention
      || (record.status === 'done'
        && Number(record.readyAt) > Number(record.lastAcknowledgedReadyAt || 0))
    ));
    vscode.commands.executeCommand('setContext', 'aiTerminalSessions.activeAttentionEditable', editable);
    vscode.commands.executeCommand('setContext', 'aiTerminalSessions.activeNeedsAttention', needsAttention);
  }

  terminalEditorLabels() {
    if (!vscode.window.tabGroups) return [];
    return vscode.window.tabGroups.all.flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputTerminal)
      .map((tab) => tab.label);
  }

  currentSessionHealth() {
    return sessionTabHealth({
      records: this.records.values(),
      connected: this.terminals.size,
      terminalTabLabels: this.terminalEditorLabels(),
      isSerializedStub: (label) => (
        isSerializedTerminalStubLabel(label, this.workspaceStorageId)
      ),
      settling: !this.started
        || this.restoringTabs
        || this.closeEventsInFlight > 0,
    });
  }

  hasSuspiciousTerminalEditors() {
    const labels = this.terminalEditorLabels();
    if (labels.some((label) => isSerializedTerminalStubLabel(label, this.workspaceStorageId))) {
      return true;
    }
    return sessionTabHealth({
      records: this.records.values(),
      connected: this.terminals.size,
      terminalTabLabels: labels,
      isSerializedStub: (label) => (
        isSerializedTerminalStubLabel(label, this.workspaceStorageId)
      ),
    }).extra > 0;
  }

  updateSessionStatusBar() {
    const item = this.sessionStatusBar;
    if (!item) return;

    const counts = sessionCounts(this.records.values());
    const health = this.currentSessionHealth();
    item.backgroundColor = undefined;

    if (!health.healthy) {
      item.text = health.extra
        ? `$(warning) ${health.visible} tabs / ${health.expected} sessions`
        : `$(warning) ${health.connected}/${health.expected} connected`;
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (counts.attention) {
      item.text = `$(bell-dot) ${counts.attentionPanes || counts.attention} · $(terminal) ${counts.total}`;
    } else if (counts.working) {
      item.text = `$(sync~spin) ${counts.workingPanes || counts.working} · $(terminal) ${counts.total}`;
    } else {
      item.text = `$(terminal) ${counts.total}`;
    }

    const healthLines = health.healthy
      ? ['Restore health: OK']
      : [
        `Restore health: ${health.extra} extra tab(s), ${health.missing} disconnected session(s)`,
      ];
    item.tooltip = [
      'AI Terminal Sessions',
      `${counts.total} saved session(s)`,
      `${counts.attentionPanes} pane(s) need attention · ${counts.workingPanes} working`,
      `${health.connected} connected · ${health.visible} visible managed tab(s)`,
      ...healthLines,
      'Click to switch sessions and inspect restore health.',
    ].join('\n');
    item.accessibilityInformation = {
      label: health.healthy
        ? `${counts.total} AI terminal sessions, ${counts.attentionPanes} panes need attention`
        : `AI terminal restore warning, ${health.extra} extra tabs and ${health.missing} disconnected sessions`,
    };
    this.updateCopyModeStatusBar();
  }

  updateCopyModeStatusBar() {
    const item = this.copyModeStatusBar;
    if (!item) return;
    const pane = focusedPane(this.activeRecord());
    if (!paneInCopyMode(pane)) {
      item.hide();
      return;
    }

    const distance = Number(pane.scrollPosition) || 0;
    item.text = '$(arrow-down) Jump to bottom';
    item.tooltip = [
      'Tmux copy mode is active.',
      distance > 0 ? `${distance} line(s) above live output.` : 'The live terminal is paused.',
      'Click to return to live output. Escape or q also exits copy mode.',
    ].join('\n');
    item.accessibilityInformation = {
      label: 'Tmux copy mode is active. Jump to live terminal output.',
    };
    item.show();
  }

  sessionSwitcherItems(now = Date.now()) {
    const records = [...this.records.values()];
    const compareActivity = (left, right) => (
      activityReference(right, right.createdAt || now)
        - activityReference(left, left.createdAt || now)
      || (left.tabOrder || 0) - (right.tabOrder || 0)
    );
    const groups = [
      {
        label: 'Needs attention',
        matches: (record) => sessionNeedsAttention(record),
      },
      {
        label: 'Working',
        matches: (record) => (
          !sessionNeedsAttention(record) && sessionPaneSummary(record).working > 0
        ),
      },
      {
        label: 'Recent',
        matches: (record) => (
          !sessionNeedsAttention(record)
          && record.status !== 'running'
          && now - activityReference(record, record.createdAt || now) < IDLE_OLD_HOURS * 3600000
        ),
      },
      {
        label: 'Older',
        matches: (record) => (
          !sessionNeedsAttention(record)
          && record.status !== 'running'
          && now - activityReference(record, record.createdAt || now) >= IDLE_OLD_HOURS * 3600000
        ),
      },
    ];
    const items = [];
    for (const group of groups) {
      const matches = records.filter(group.matches).sort(compareActivity);
      if (!matches.length) continue;
      items.push({ kind: vscode.QuickPickItemKind.Separator, label: group.label });
      for (const record of matches) {
        const acknowledged = record.status === 'done' && !sessionNeedsAttention(record);
        const marker = record.status === 'running'
          ? '$(sync~spin)'
          : terminalStatusIcon(record, {
            now,
            recentMinutes: IDLE_RECENT_MINUTES,
            oldHours: IDLE_OLD_HOURS,
          });
        items.push({
          label: `${marker} ${recordTitle(record)}`,
          description: `${statusLabel(record.status, acknowledged, record.manuallyNeedsAttention)} · ${activeProcess(record)} · ${activityLabel(activityReference(record, record.createdAt || now), now)}`,
          detail: record.cwd,
          record,
        });
      }
    }
    return items;
  }

  async showSessionSwitcher() {
    const health = this.currentSessionHealth();
    const items = [];
    if (!health.healthy) {
      const issues = [
        health.extra && `${health.extra} extra tab(s)`,
        health.missing && `${health.missing} disconnected session(s)`,
      ].filter(Boolean).join(' · ');
      items.push({
        label: '$(warning) Restore health needs attention',
        description: issues,
        detail: `${health.expected} saved · ${health.connected} connected · ${health.visible} visible`,
        action: 'health',
      });
    }

    const sessionItems = this.sessionSwitcherItems();
    if (items.length && sessionItems.length) {
      items.push({ kind: vscode.QuickPickItemKind.Separator, label: 'Open sessions' });
    }
    items.push(...sessionItems);

    if (this.sessionArchive.length || this.sessionHistory.length) {
      items.push({ kind: vscode.QuickPickItemKind.Separator, label: 'Closed sessions' });
      items.push({
        label: '$(history) Open Session History...',
        description: `${this.sessionArchive.length} saved`,
        action: 'history',
      });
    }
    if (!this.records.size) {
      items.push({
        label: '$(add) New persistent terminal',
        action: 'new',
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: 'AI Sessions',
      placeHolder: health.healthy
        ? 'Switch to a session'
        : 'Restore health warning detected',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    if (picked.record) return this.focusMonitorRecord(picked.record.id);
    if (picked.action === 'history') return this.showSessionHistory();
    if (picked.action === 'new') return this.newTerminal();
    if (picked.action === 'health') return this.showSessionHealthWarning(health);
  }

  async showSessionHealthWarning(health = this.currentSessionHealth()) {
    const details = [
      health.extra && `${health.extra} extra managed terminal tab(s) are visible`,
      health.missing && `${health.missing} saved session(s) have no terminal connection`,
    ].filter(Boolean);
    if (!details.length) {
      vscode.window.showInformationMessage('AI Sessions restore health is OK.');
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `${details.join('. ')}. Saved recovery data has not been removed.`,
      'Restore tabs now',
      'Show log',
    );
    if (choice === 'Restore tabs now') return this.restoreNow();
    if (choice === 'Show log') return this.output.show();
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

    if (pinned) await this.openMonitor(true);
    if (!pinned && !this.pinnedRecords().length && this.monitorView?.visible) {
      await this.hideMonitor();
      return;
    }
    await this.refreshMonitor();
  }

  async toggleMonitor() {
    if (this.monitorView?.visible && this.monitorFocused) return this.hideMonitor();
    return this.focusMonitor();
  }

  async focusMonitor() {
    const returnTerminal = vscode.window.activeTerminal;
    const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
    this.monitorReturnTerminal = activeTab?.input instanceof vscode.TabInputTerminal
      && returnTerminal && vscode.window.terminals.includes(returnTerminal)
      ? returnTerminal
      : undefined;
    const view = this.monitorView?.visible
      ? this.monitorView
      : await this.openMonitor(false);
    if (!view) return undefined;
    if (typeof view.show === 'function') view.show(false);
    await view.webview.postMessage({ type: 'focus-monitor' });
    return view;
  }

  async hideMonitor() {
    const view = this.monitorView;
    if (!view || !view.visible) return view;
    const returnTerminal = this.monitorReturnTerminal;
    await vscode.commands.executeCommand('workbench.action.closePanel');
    this.monitorFocused = false;
    this.stopMonitorRefresh();
    if (!this.showTerminalIfLive(returnTerminal)) {
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }
    this.output.appendLine('[monitor] bottom panel hidden');
    return view;
  }

  async openMonitor(preserveTerminalFocus = false) {
    if (this.monitorView?.visible) return this.monitorView;
    if (this.monitorOpenPromise) return this.monitorOpenPromise;

    this.monitorOpenPromise = this.openMonitorImpl(preserveTerminalFocus).finally(() => {
      this.monitorOpenPromise = undefined;
    });
    return this.monitorOpenPromise;
  }

  async openMonitorImpl(preserveTerminalFocus) {
    const returnTerminal = vscode.window.activeTerminal;
    if (this.monitorView && typeof this.monitorView.show === 'function') {
      this.monitorView.show(Boolean(preserveTerminalFocus));
    } else {
      await vscode.commands.executeCommand(MONITOR_CONTAINER_COMMAND);
      await waitFor(() => Boolean(this.monitorView), 1200, 25);
    }
    const view = this.monitorView;
    if (!view) {
      vscode.window.showErrorMessage('The Session Monitor panel could not be opened.');
      return undefined;
    }
    this.startMonitorRefresh();
    await this.refreshMonitor();
    if (preserveTerminalFocus) this.showTerminalIfLive(returnTerminal);
    this.output.appendLine('[monitor] bottom panel shown');
    return view;
  }

  async resolveMonitorView(view) {
    this.monitorView = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = monitorHtml(view.webview, getWorkspaceName());

    view.webview.onDidReceiveMessage((message) => {
      if (!message || this.deactivating) return;
      if (message.type === 'ready') {
        this.refreshMonitor().catch((error) => this.log('monitor-ready', error));
      } else if (message.type === 'focus') {
        this.focusMonitorRecord(message.id).catch((error) => this.log('monitor-focus', error));
      } else if (message.type === 'unpin') {
        const record = this.records.get(message.id);
        if (record) this.setMonitorPinned(record, false).catch((error) => this.log('monitor-unpin', error));
      } else if (message.type === 'focus-state') {
        this.monitorFocused = Boolean(message.focused);
      } else if (message.type === 'return') {
        this.returnFromMonitor().catch((error) => this.log('monitor-return', error));
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.startMonitorRefresh();
        this.refreshMonitor().catch((error) => this.log('monitor-visible', error));
      } else {
        this.monitorFocused = false;
        this.stopMonitorRefresh();
      }
    });
    view.onDidDispose(() => {
      if (this.monitorView !== view) return;
      this.monitorView = undefined;
      this.monitorFocused = false;
      this.stopMonitorRefresh();
    });
    if (view.visible) this.startMonitorRefresh();
    if (this.started) await this.refreshMonitor();
  }

  showTerminalIfLive(terminal) {
    if (!terminal || !vscode.window.terminals.includes(terminal)) return false;
    try {
      terminal.show(false);
      return true;
    } catch (error) {
      this.log('monitor-return-focus', error);
      return false;
    }
  }

  async returnFromMonitor() {
    this.monitorFocused = false;
    if (this.showTerminalIfLive(this.monitorReturnTerminal)) return;
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }

  startMonitorRefresh() {
    if (this.monitorTimer || !this.monitorView
      || !this.monitorView.visible || this.deactivating) return;
    this.monitorTimer = setInterval(() => {
      this.refreshMonitor().catch((error) => this.log('monitor-refresh', error));
    }, MONITOR_REFRESH_MS);
  }

  stopMonitorRefresh() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = undefined;
  }

  async refreshMonitor() {
    const view = this.monitorView;
    if (!view || !view.visible || this.monitorRefreshing || this.deactivating) return;
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
          status: statusLabel(record.status, acknowledged, record.manuallyNeedsAttention),
          tone: statusTone(record.status, acknowledged, record.manuallyNeedsAttention),
          age: activityLabel(activityAt, now),
          preview,
          lines: terminal.lines,
          fresh: Boolean(previous && previous.preview !== preview),
        };
      }));

      if (this.monitorView === view) {
        await view.webview.postMessage({
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
    this.monitorFocused = false;
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
      iconPreset: DEFAULT_ICON_PRESET,
      iconMode: 'auto',
      status: 'idle',
      monitorPinned: false,
      windows: [],
      tabOrder,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastFocusedAt: Date.now(),
      manuallyNeedsAttention: false,
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
    const appearance = iconPreset(record.iconPreset);
    pty.iconPreset = appearance.id;
    const options = {
      name: this.formatTerminalName(record),
      pty,
      isTransient: true,
      iconPath: new vscode.ThemeIcon(appearance.icon),
      color: new vscode.ThemeColor(appearance.color),
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

  async restoreNow() {
    const restored = await this.restoreTabs(true);
    vscode.window.showInformationMessage(
      restored
        ? `${restored} tab(s) restored in the main window.`
        : 'There are no saved sessions to restore.',
    );
  }

  async customizeActive() {
    const record = this.activeRecord();
    if (!record) return this.warnManagedTerminal();
    const title = record.manualTitle || record.autoTitle || shortTitle(record.tmuxSession);
    const items = [
      { label: '$(sparkle) Rename with AI', action: 'rename-ai' },
      { label: '$(edit) Rename manually', action: 'rename' },
      { label: '$(symbol-color) Change icon and color', action: 'icon' },
      { kind: vscode.QuickPickItemKind.Separator, label: 'Session' },
      { label: '$(history) Recover last draft', action: 'draft' },
      { label: '$(layout) Tmux pane actions', action: 'panes' },
      {
        label: record.monitorPinned
          ? '$(pinned) Remove from Session Monitor'
          : '$(pin) Pin to Session Monitor',
        action: 'pin',
      },
      { kind: vscode.QuickPickItemKind.Separator, label: 'Danger zone' },
      { label: '$(trash) Remove session...', action: 'remove' },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: `Customize ${title}`,
      placeHolder: 'Choose what to change',
    });
    if (!picked || !picked.action) return;
    if (picked.action === 'rename-ai') return this.renameActiveWithAI();
    if (picked.action === 'rename') return this.renameActive();
    if (picked.action === 'icon') return this.changeActiveIcon();
    if (picked.action === 'draft') return this.restoreDraft();
    if (picked.action === 'panes') return this.showPaneActions();
    if (picked.action === 'pin') return this.toggleMonitorPin();
    if (picked.action === 'remove') return this.removeActive();
  }

  async showMoreActions() {
    const items = [
      { label: '$(settings-gear) Open extension settings', action: 'settings' },
      { label: '$(terminal) Use as default terminal profile', action: 'default' },
      { kind: vscode.QuickPickItemKind.Separator, label: 'Recovery' },
      { label: '$(refresh) Restore tabs now', action: 'restore' },
      { label: '$(plug) Recover orphaned private session', action: 'attach' },
      { label: '$(export) Prepare workspace move...', action: 'prepare-move' },
      { label: '$(import) Import a prepared workspace move...', action: 'import-move' },
      { kind: vscode.QuickPickItemKind.Separator, label: 'Maintenance' },
      { label: '$(output) Show log', action: 'log' },
      { label: '$(pulse) Diagnose AI rename', action: 'diagnose' },
      { label: '$(clear-all) Clear recovery data...', action: 'clear' },
      { label: '$(debug-stop) Stop all managed sessions...', action: 'stop' },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'AI Sessions: More Actions',
      placeHolder: 'Settings, recovery, and maintenance',
    });
    if (!picked || !picked.action) return;
    if (picked.action === 'settings') {
      return vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:LEstradioto.ai-terminal-sessions',
      );
    }
    if (picked.action === 'default') return this.makeDefault();
    if (picked.action === 'restore') return this.restoreNow();
    if (picked.action === 'attach') return this.attachExisting();
    if (picked.action === 'prepare-move') return this.prepareWorkspaceMove();
    if (picked.action === 'import-move') return this.importWorkspaceMove();
    if (picked.action === 'log') return this.output.show();
    if (picked.action === 'diagnose') return this.diagnoseRenameAI();
    if (picked.action === 'clear') return this.clearRecoveryData();
    if (picked.action === 'stop') return this.stopAllManagedSessions();
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
    this.updateSessionStatusBar();
    this.restorePromise = this.restoreTabsImpl(force).finally(() => {
      this.restoringTabs = false;
      this.restorePromise = undefined;
      this.updateSessionStatusBar();
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
    const recoverAuxiliaryEditors = force && this.hasSuspiciousTerminalEditors();

    // A terminal editor can survive in an auxiliary window after a workbench
    // reload. Move any stranded editors back before resolving the saved tabs.
    if (recoverAuxiliaryEditors) {
      try {
        await this.workbench.restoreEditorsToMainWindow();
        await this.workbench.switchToMainWindow();
        await delay(100);
      } catch (error) {
        this.log('restore-main-editors', error);
      }
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
    this.output.appendLine(`[restore] ${force ? 'manual' : 'startup'}: ${records.length} tab(s) restored`);
    return records.length;
  }

  currentRecordForArchive(entry) {
    return this.records.get(entry.record.id)
      || [...this.records.values()].find((record) => (
        record.tmuxSession === entry.record.tmuxSession || archiveKey(record) === entry.key
      ));
  }

  async restoreArchivedSession(entry) {
    const current = this.currentRecordForArchive(entry);
    if (current) {
      const terminal = this.terminals.get(current.id) || this.openRecord(current, false);
      terminal.show(false);
      entry.lastRestoredAt = Date.now();
      await this.persistSessionArchive();
      vscode.window.setStatusBarMessage(`AI Sessions: ${entry.title} is already open`, 2500);
      return;
    }

    const tabOrder = Math.max(-1, ...[...this.records.values()].map((record) => (
      Number.isFinite(record.tabOrder) ? record.tabOrder : -1
    ))) + 1;
    const resumeAgent = sessionAgent(entry.record);
    const windows = (entry.record.windows || []).map((window) => ({
      ...window,
      panes: (window.panes || []).map((pane) => ({
        ...pane,
        ...(pane.agent && resumeAgent
          && pane.agent.type === resumeAgent.type
          && pane.agent.sessionId === resumeAgent.sessionId
          ? { agent: { ...pane.agent, active: true } }
          : {}),
      })),
    }));
    const record = normalizeSessionRecord({
      ...entry.record,
      windows,
      ...(resumeAgent && {
        activeAgent: { type: resumeAgent.type, sessionId: resumeAgent.sessionId },
      }),
      monitorPinned: false,
      monitorPinnedAt: 0,
      tabOrder,
      lastFocusedAt: Date.now(),
    }, this.workspaceKey);
    if (!record) {
      vscode.window.showErrorMessage('This history entry is no longer valid.');
      return;
    }

    this.records.set(record.id, record);
    await this.persist('archive-restore');
    try {
      await this.ensureSession(record);
      const terminal = this.openRecord(record, false);
      terminal.show(false);
      const pty = this.ptys.get(record.id);
      const ready = pty && await waitFor(() => pty.bridgeReady(), 1800, 25);
      if (ready) await pty.replayVisiblePane();
      await this.scanAll();
      entry.lastRestoredAt = Date.now();
      await this.persistSessionArchive();
      vscode.window.showInformationMessage(`Restored "${entry.title}" from session history.`);
    } catch (error) {
      this.log('archive-restore', error);
      vscode.window.showErrorMessage(`Could not restore "${entry.title}". Its recovery data was kept.`);
    }
  }

  historyQuickPickItems() {
    const items = this.sessionArchive.map((entry) => {
      const current = this.currentRecordForArchive(entry);
      const preview = [...entry.preview].reverse().find((message) => message.text);
      const time = new Date(entry.archivedAt).toLocaleString([], {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      const provider = entry.provider === 'terminal' ? 'Terminal' : providerLabel(entry.provider);
      return {
        label: `${current ? '$(circle-filled)' : '$(history)'} ${entry.title}`,
        description: current ? `${provider} · open now` : `${provider} · closed ${time}`,
        detail: preview ? preview.text.replace(/\s+/g, ' ').slice(0, 260) : 'No saved message preview',
        entry,
      };
    });
    if (this.sessionHistory.length) {
      if (items.length) items.push({ kind: vscode.QuickPickItemKind.Separator, label: 'Recovery' });
      items.push({
        label: '$(layers) Restore from a snapshot...',
        description: 'advanced · may restore multiple tabs',
        detail: 'Use only when the individual session you need is missing above.',
        action: 'snapshots',
      });
    }
    return items;
  }

  async updateHistoryPreview(panel, item, revision) {
    if (!panel || !item) return;
    if (!item.entry) {
      panel.title = 'Session History Preview';
      panel.webview.html = historyPreviewHtml({
        title: 'Snapshot recovery',
        provider: 'advanced recovery',
        preview: [],
      });
      return;
    }

    const entry = item.entry;
    panel.title = `Preview · ${entry.title}`;
    const hasConversation = entry.preview.some((message) => (
      message.role === 'user' || message.role === 'assistant'
    ));
    panel.webview.html = historyPreviewHtml(entry, {
      loading: entry.provider !== 'terminal' && !hasConversation,
    });
    if (entry.provider === 'terminal' || hasConversation) return;

    try {
      const preview = await this.conversationPreviewForRecord(entry.record);
      if (preview.length) {
        const savedDrafts = entry.preview.filter((message) => message.role === 'draft');
        entry.preview = normalizePreview([
          ...preview.filter((message) => message.role !== 'draft'),
          ...savedDrafts,
          ...preview.filter((message) => message.role === 'draft'),
        ]);
        await this.persistSessionArchive();
      }
    } catch (error) {
      this.log('archive-preview-load', error);
    }
    if (revision.current !== item.previewRevision || !panel.visible) return;
    panel.webview.html = historyPreviewHtml(entry);
  }

  async showSessionHistory() {
    if (!this.sessionArchive.length && !this.sessionHistory.length) {
      vscode.window.showInformationMessage('There are no closed sessions or snapshots for this workspace yet.');
      return;
    }

    const items = this.historyQuickPickItems();
    let previewPanel;
    try {
      previewPanel = vscode.window.createWebviewPanel(
        'aiTerminalSessions.historyPreview',
        'Session History Preview',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: false, retainContextWhenHidden: false },
      );
    } catch (error) {
      this.log('history-preview-panel', error);
    }

    const picker = vscode.window.createQuickPick();
    picker.title = 'Session history';
    picker.placeholder = 'Choose one closed session to restore';
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    picker.items = items;
    const revision = { current: 0 };
    const picked = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
        picker.hide();
      };
      picker.onDidAccept(() => finish(picker.selectedItems[0] || picker.activeItems[0]));
      picker.onDidHide(() => finish(undefined));
      picker.onDidChangeActive(([item]) => {
        revision.current += 1;
        if (!item) return;
        item.previewRevision = revision.current;
        this.updateHistoryPreview(previewPanel, item, revision)
          .catch((error) => this.log('history-preview', error));
      });
      picker.show();
      const first = items.find((item) => item.kind !== vscode.QuickPickItemKind.Separator);
      if (first) picker.activeItems = [first];
    });
    picker.dispose();
    if (previewPanel) previewPanel.dispose();
    if (!picked) return;
    if (picked.action === 'snapshots') {
      await this.showSnapshotHistory();
      return;
    }
    await this.restoreArchivedSession(picked.entry);
  }

  async showSnapshotHistory() {
    if (!this.sessionHistory.length) {
      vscode.window.showInformationMessage('There are no session snapshots for this workspace yet.');
      return;
    }

    const liveRaw = await this.runTmux(['list-sessions', '-F', '#{session_name}'], true);
    const liveSessions = new Set(liveRaw.split('\n').map((line) => line.trim()).filter(Boolean));
    const currentIds = new Set(this.records.keys());
    const currentTmux = new Set([...this.records.values()].map((record) => record.tmuxSession));
    const currentArchiveKeys = new Set([...this.records.values()].map(archiveKey));
    const items = [...this.sessionHistory].reverse().map((snapshot) => {
      const missing = snapshot.records.filter((record) => (
        !currentIds.has(record.id)
        && !currentTmux.has(record.tmuxSession)
        && !currentArchiveKeys.has(archiveKey(record))
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
      title: 'Snapshot recovery',
      placeHolder: 'Advanced recovery: choose a snapshot',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    if (!picked.missing.length) {
      vscode.window.showInformationMessage('All tabs from this snapshot are already present.');
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Snapshot recovery will add ${picked.missing.length} missing tab(s) at once. Current tabs will be kept. Use individual session history when you only need one conversation.`,
      { modal: true },
      `Restore ${picked.missing.length} tabs`,
    );
    if (choice !== `Restore ${picked.missing.length} tabs`) return;

    this.captureTabOrder();
    await this.checkpointSessionHistory('before-history-restore', true);
    const currentByTmux = new Map(
      [...this.records.values()].map((record) => [record.tmuxSession, record]),
    );
    const currentByArchiveKey = new Map(
      [...this.records.values()].map((record) => [archiveKey(record), record]),
    );
    const snapshotIds = new Set();
    let lastSnapshotOrder = Math.max(
      -1,
      ...picked.snapshot.records
        .filter((record) => Number.isFinite(record.tabOrder))
        .map((record) => record.tabOrder),
    );
    for (const raw of sortRecordsForRestore(picked.snapshot.records)) {
      const current = this.records.get(raw.id)
        || currentByTmux.get(raw.tmuxSession)
        || currentByArchiveKey.get(archiveKey(raw));
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
      'Delete saved composer drafts, closed sessions, snapshots, and prepared moves for this workspace?',
      { modal: true },
      'Delete recovery data',
    );
    if (choice !== 'Delete recovery data') return;
    const relocationFiles = (await this.readRelocationBundles())
      .filter(({ bundle }) => bundle.sourceWorkspaceKey === this.workspaceKey)
      .map(({ file }) => file);
    this.drafts.clear();
    this.sessionHistory = [];
    this.sessionArchive = [];
    await Promise.all([
      fs.promises.unlink(this.draftStorePath).catch(ignoreMissingFile),
      fs.promises.unlink(this.historyStorePath).catch(ignoreMissingFile),
      fs.promises.unlink(this.archiveStorePath).catch(ignoreMissingFile),
      ...relocationFiles.map((file) => fs.promises.unlink(file).catch(ignoreMissingFile)),
    ]);
    vscode.window.showInformationMessage('Local drafts, closed sessions, snapshots, and prepared moves were deleted.');
  }

  async prepareWorkspaceMove() {
    const records = [...this.records.values()];
    if (!records.length) {
      vscode.window.showInformationMessage('There are no managed sessions to relocate.');
      return;
    }
    const roots = currentWorkspaceRoots();
    if (!roots.length) {
      vscode.window.showErrorMessage('Open a local workspace folder before preparing a move.');
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Save ${records.length} session(s) for relocation and stop their tmux processes? Recovery data will be kept.`,
      { modal: true },
      'Prepare and stop sessions',
    );
    if (choice !== 'Prepare and stop sessions') return;

    await this.scanAll();
    await Promise.all(records.map((record) => (
      this.captureDraft(record).catch((error) => this.log('relocation-draft', error))
    )));
    await this.persist('before-relocation');
    await Promise.all([
      this.persistDrafts(),
      this.persistSessionHistory(),
      this.persistSessionArchive(),
    ]);

    const savedState = this.stateStore.load();
    const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const bundle = relocationBundle({
      id,
      workspaceKey: this.workspaceKey,
      roots,
      records: savedState ? savedState.records : records,
      drafts: Object.fromEntries(this.drafts),
      snapshots: this.sessionHistory,
      archive: this.sessionArchive,
    });
    await this.writeRelocationBundle(bundle);

    for (const record of records) {
      const terminal = this.terminals.get(record.id);
      if (terminal) this.disposeManagedTerminal(record, terminal, 'keep');
    }
    await waitFor(() => this.closeEventsInFlight === 0, 2000, 25);

    const failures = [];
    for (const record of records) {
      try {
        await this.killTmuxSession(record.tmuxSession);
      } catch (error) {
        failures.push(record.tmuxSession);
        this.log('relocation-stop', error);
      }
    }
    if (failures.length) {
      vscode.window.showErrorMessage(
        `${failures.length} session(s) could not be stopped. The relocation bundle was saved; inspect the log before moving files.`,
      );
      return;
    }
    for (const record of records) {
      this.cancelDraftCapture(record);
      this.monitorPreviewCache.delete(record.id);
    }
    this.records.clear();
    await Promise.all([
      this.persist('relocation-suspended'),
      this.updateMonitorContext(),
    ]);
    this.updateSessionStatusBar();
    vscode.window.showInformationMessage(
      'Workspace move prepared. Quit VS Code, move the folder, open its new location, then run Import a Prepared Workspace Move.',
    );
  }

  async importWorkspaceMove() {
    if (this.records.size) {
      vscode.window.showWarningMessage(
        'Import relocation data into a workspace with no managed sessions to avoid duplicate tabs.',
      );
      return;
    }
    const roots = currentWorkspaceRoots();
    if (!roots.length) {
      vscode.window.showErrorMessage('Open the relocated local workspace before importing its sessions.');
      return;
    }
    const bundles = await this.readRelocationBundles();
    if (!bundles.length) {
      vscode.window.showInformationMessage('No prepared workspace moves were found.');
      return;
    }
    const picked = await vscode.window.showQuickPick(bundles.map(({ bundle, file }) => ({
      label: `$(folder-opened) ${bundle.sourceRoots.map((root) => root.name).join(', ')}`,
      description: `${bundle.records.length} session(s) · ${new Date(bundle.createdAt).toLocaleString()}`,
      detail: bundle.sourceRoots.map((root) => root.fsPath).join(' · '),
      bundle,
      file,
    })), {
      title: 'Import Prepared Workspace Move',
      placeHolder: 'Choose the previous workspace location',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;

    let relocated;
    try {
      relocated = relocateWorkspaceBundle(picked.bundle, this.workspaceKey, roots);
    } catch (error) {
      vscode.window.showErrorMessage(`Could not import workspace move: ${messageOf(error)}`);
      return;
    }
    for (const raw of sortRecordsForRestore(relocated.records)) {
      const record = normalizeSessionRecord(raw, this.workspaceKey);
      if (record) this.records.set(record.id, record);
    }
    this.drafts = new Map(Object.entries(relocated.drafts || {}));
    this.sessionHistory = normalizeSessionHistory(historyPayload(
      this.workspaceKey,
      relocated.snapshots,
    ), this.workspaceKey);
    this.sessionArchive = normalizeArchivePayload(archivePayload(
      this.workspaceKey,
      relocated.archive,
    ), this.workspaceKey);
    await this.persist('relocation-import');
    await Promise.all([
      this.persistDrafts(),
      this.persistSessionHistory(),
      this.persistSessionArchive(),
    ]);
    await this.restoreTabs(true);
    await this.scanAll();
    await fs.promises.unlink(picked.file).catch(ignoreMissingFile);
    vscode.window.showInformationMessage(`${this.records.size} relocated session(s) restored.`);
  }

  async writeRelocationBundle(bundle) {
    await fs.promises.mkdir(this.relocationStorePath, { recursive: true, mode: 0o700 });
    const file = path.join(this.relocationStorePath, `${bundle.id}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(bundle), { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(temporary, file);
    return file;
  }

  async readRelocationBundles() {
    let files;
    try {
      files = await fs.promises.readdir(this.relocationStorePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
    const results = await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (name) => {
      const file = path.join(this.relocationStorePath, name);
      try {
        const bundle = normalizeRelocationBundle(JSON.parse(await fs.promises.readFile(file, 'utf8')));
        return bundle ? { bundle, file } : undefined;
      } catch (error) {
        this.log('relocation-load', error);
        return undefined;
      }
    }));
    return results.filter(Boolean).sort((left, right) => right.bundle.createdAt - left.bundle.createdAt);
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
        this.deleteDraftsForRecord(record);
        this.monitorPreviewCache.delete(record.id);
      } catch (error) {
        failures.push(record.tmuxSession);
        this.log('stop-all', error);
      }
    }
    await Promise.all([this.persist('stop-all'), this.persistDrafts(), this.updateMonitorContext()]);
    if (!this.records.size) {
      this.sessionHistory = [];
      this.sessionArchive = [];
      await Promise.all([
        fs.promises.unlink(this.historyStorePath).catch(ignoreMissingFile),
        fs.promises.unlink(this.draftStorePath).catch(ignoreMissingFile),
        fs.promises.unlink(this.archiveStorePath).catch(ignoreMissingFile),
      ]);
    }
    if (this.monitorView?.visible && !this.pinnedRecords().length) await this.hideMonitor();
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

  async focusAfterTerminalClose(closedTerminal) {
    if (this.deactivating) return;
    if (vscode.window.activeTerminal === closedTerminal) await delay(40);
    // Let the workbench choose the next tab, then focus that tab's editor. A
    // terminal.show() call here could select a different tab from VS Code's
    // choice when activeTerminal is still catching up with the tab model.
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
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

  async jumpActiveToBottom() {
    const record = this.activeRecord();
    if (!record) return this.warnManagedTerminal();
    const target = `${record.tmuxSession}:`;
    await this.runTmux([
      'send-keys', '-X', '-t', target, 'history-bottom', ';',
      'send-keys', '-X', '-t', target, 'cancel',
    ], true);
    const pane = focusedPane(record);
    if (pane) {
      pane.inMode = false;
      pane.mode = '';
      pane.scrollPosition = 0;
    }
    this.updateCopyModeStatusBar();
    await delay(80);
    await this.scanAll();
  }

  async showPaneActions() {
    const record = this.activeRecord();
    if (!record) return this.warnManagedTerminal();
    await this.scanAll();
    const pane = focusedPane(record);
    const panes = sessionPanes(record);
    const items = [
      { label: '$(split-horizontal) Split right', description: 'Ctrl+B %', action: 'split-right' },
      { label: '$(split-vertical) Split down', description: 'Ctrl+B "', action: 'split-down' },
      { label: '$(arrow-swap) Focus next pane', description: 'Ctrl+B o', action: 'next' },
      { label: '$(screen-full) Toggle pane zoom', description: 'Ctrl+B z', action: 'zoom' },
      { label: '$(symbol-property) Set pane role...', action: 'role' },
      { label: '$(book) Enter scrollback', description: 'Ctrl+B [', action: 'copy-mode' },
      { kind: vscode.QuickPickItemKind.Separator, label: 'Keyboard' },
      {
        label: '$(keyboard) Show tmux keyboard reference',
        description: 'Ctrl+B ?',
        action: 'help',
      },
    ];
    if (panes.length > 1) {
      items.push({ kind: vscode.QuickPickItemKind.Separator, label: 'Pane' });
      items.push({ label: '$(trash) Close focused pane...', description: 'Ctrl+B x', action: 'close' });
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: `Tmux Panes · ${recordTitle(record)}`,
      placeHolder: `${panes.length || 1} pane(s) · Prefix is Ctrl+B`,
    });
    if (!picked || !picked.action) return;
    const target = pane && pane.id || `${record.tmuxSession}:`;
    if (picked.action === 'split-right' || picked.action === 'split-down') {
      await this.runTmux([
        'split-window', picked.action === 'split-right' ? '-h' : '-v',
        '-t', target,
        '-c', existingDirectory(pane && pane.cwd || record.cwd),
      ]);
    } else if (picked.action === 'next') {
      await this.runTmux(['select-pane', '-t', `${record.tmuxSession}:.+`], true);
    } else if (picked.action === 'zoom') {
      await this.runTmux(['resize-pane', '-Z', '-t', target]);
    } else if (picked.action === 'copy-mode') {
      await this.runTmux(['copy-mode', '-u', '-t', target]);
    } else if (picked.action === 'role') {
      await this.changeFocusedPaneRole(record, pane);
      return;
    } else if (picked.action === 'close') {
      const confirmation = await vscode.window.showWarningMessage(
        'Close the focused tmux pane and terminate its process?',
        { modal: true },
        'Close pane',
      );
      if (confirmation !== 'Close pane') return;
      await this.runTmux(['kill-pane', '-t', target]);
    } else if (picked.action === 'help') {
      await vscode.window.showInformationMessage(
        'Ctrl+B then: % split right · " split down · arrows move · o next · z zoom · x close · [ scrollback · ? all bindings',
      );
      return;
    }
    await delay(80);
    await this.scanAll();
    this.schedulePersist();
  }

  async changeFocusedPaneRole(record, pane = focusedPane(record)) {
    if (!pane) return;
    if (pane.agent) {
      vscode.window.showInformationMessage('Agent pane roles are detected automatically.');
      return;
    }
    const roles = [
      ['server', '$(server) Server'],
      ['logs', '$(output) Logs'],
      ['test', '$(beaker) Tests'],
      ['ci', '$(rocket) CI or deploy'],
      ['shell', '$(terminal) Shell'],
      ['helper', '$(tools) Helper'],
    ].map(([role, label]) => ({ label, role, picked: pane.role === role }));
    const picked = await vscode.window.showQuickPick(roles, {
      title: 'Pane role',
      placeHolder: 'Used in the tmux pane border and restore metadata',
    });
    if (!picked) return;
    pane.role = picked.role;
    pane.restorePolicy = pane.agent ? 'resume-agent' : 'shell';
    await this.configurePanePresentation(record);
    this.schedulePersist();
  }

  async markActiveHandled() {
    const record = this.activeRecord();
    if (!record) return this.warnManagedTerminal();
    await this.scanAll();
    if (!this.acknowledgeAttention(record)) return;
    this.schedulePersist();
  }

  async markActiveNeedsAttention() {
    const record = this.activeRecord();
    if (!record) return this.warnManagedTerminal();
    await this.scanAll();
    if (['running', 'waiting', 'error', 'interrupted'].includes(record.status)) return;
    if (record.manuallyNeedsAttention) return;
    const agent = focusedPane(record)?.agent;
    if (agent) agent.manuallyNeedsAttention = true;
    record.manuallyNeedsAttention = true;
    this.refreshPtyName(record);
    this.updateManagedTerminalContext(record);
    this.updateSessionStatusBar();
    this.schedulePersist();
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

  async changeActiveIcon() {
    const record = this.activeRecord();
    if (!record) return this.warnManagedTerminal();
    const current = normalizeIconPreset(record.iconPreset);
    const mode = normalizeIconMode(record.iconMode, record.iconPreset);
    const automatic = normalizeIconPreset(record.detectedIconPreset || automaticIconPreset({
      agentType: record.activeAgent && record.activeAgent.type,
    }));
    const items = [{
      label: '$(wand) Automatic',
      description: `Currently detects ${iconPreset(automatic).label}`,
      detail: mode === 'auto' ? 'Current mode' : undefined,
      mode: 'auto',
    }, {
      kind: vscode.QuickPickItemKind.Separator,
      label: 'Manual icons',
    }, ...ICON_PRESETS.map((preset) => ({
      label: `${preset.marker} ${preset.label}`,
      description: preset.description,
      detail: mode === 'manual' && preset.id === current ? 'Current icon' : undefined,
      preset,
      mode: 'manual',
    }))];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Tab icon and color',
      placeHolder: 'Choose an icon for this session',
      matchOnDescription: true,
    });
    if (!picked || !picked.mode) return;
    if (picked.mode === 'auto' && mode === 'auto') return;
    if (picked.mode === 'manual' && mode === 'manual' && picked.preset.id === current) return;

    this.captureTabOrder();
    record.iconMode = picked.mode;
    record.iconPreset = picked.mode === 'auto' ? automatic : picked.preset.id;
    await this.persist('icon-change');
    try {
      await this.reopenTerminalAppearance(record);
    } catch (error) {
      this.log('appearance', error);
      vscode.window.showErrorMessage(
        'The icon was saved, but the tab could not reconnect. Use More Actions to restore tabs.',
      );
      return;
    }
    vscode.window.setStatusBarMessage(
      picked.mode === 'auto'
        ? 'AI Sessions: automatic icon detection enabled'
        : `AI Sessions: ${picked.preset.label} icon applied`,
      2500,
    );
  }

  async reopenTerminalAppearance(record) {
    const terminal = this.terminals.get(record.id);
    if (!terminal) return;
    const currentPty = this.ptys.get(record.id);
    if (currentPty && currentPty.iconPreset === normalizeIconPreset(record.iconPreset)) return;
    this.captureTabOrder();
    this.disposeManagedTerminal(record, terminal, 'keep');
    await delay(100);
    if (!this.records.has(record.id)) return;

    await this.ensureSession(record);
    const replacement = this.openRecord(record, true);
    replacement.show(false);
    const pty = this.ptys.get(record.id);
    const ready = pty && await waitFor(() => pty.bridgeReady(), 1800, 25);
    if (ready) await pty.replayVisiblePane();
    else this.output.appendLine(`[appearance] PTY bridge did not open: ${record.tmuxSession}`);
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

  async transcriptForAgent(record, agent) {
    if (!agent) return undefined;
    if (agent.transcript && fs.existsSync(agent.transcript)) return agent.transcript;
    let transcript;
    if (agent.type === 'codex' && UUID_RE.test(agent.sessionId || '')) {
      transcript = this.codexTranscriptCache.get(agent.sessionId)
        || await findFileEndingWith(path.join(codexHome(), 'sessions'), `${agent.sessionId}.jsonl`);
      if (transcript) this.codexTranscriptCache.set(agent.sessionId, transcript);
    } else if (agent.type === 'claude' && UUID_RE.test(agent.sessionId || '')) {
      const pane = (record.windows || []).flatMap((window) => window.panes || [])
        .find((item) => item.agent && item.agent.type === agent.type
          && item.agent.sessionId === agent.sessionId);
      if (pane && pane.cwd) {
        const candidate = path.join(
          os.homedir(), '.claude', 'projects', encodeClaudeProject(pane.cwd), `${agent.sessionId}.jsonl`,
        );
        if (fs.existsSync(candidate)) transcript = candidate;
      }
    }
    if (transcript) agent.transcript = transcript;
    return transcript;
  }

  async conversationPreviewForRecord(record) {
    const agent = this.renameAgent(record) || sessionAgent(record);
    const transcript = await this.transcriptForAgent(record, agent);
    let preview = [];
    if (agent && transcript) {
      const snapshot = await readJsonlTail(transcript);
      preview = extractConversationPreview(agent.type, snapshot.entries);
    }
    const draft = this.latestDraftForRecord(record);
    if (draft && draft.text) preview.push({ role: 'draft', text: draft.text });
    return normalizePreview(preview);
  }

  async archiveSession(record, closeAction) {
    let preview = [];
    try {
      preview = await this.conversationPreviewForRecord(record);
    } catch (error) {
      this.log('archive-preview', error);
    }
    const result = upsertArchivedSession(this.sessionArchive, record, {
      archivedAt: Date.now(),
      closeAction,
      preview,
    });
    this.sessionArchive = result.entries;
    if (!result.changed) return undefined;
    await this.persistSessionArchive();
    this.output.appendLine(`[archive] saved ${result.entry.title}: ${closeAction}`);
    return result.entry;
  }

  async renameContext(record) {
    const agent = this.renameAgent(record);
    const transcript = await this.transcriptForAgent(record, agent);

    let messages = [];
    let bytesRead = 0;
    let error;
    if (agent && transcript) {
      try {
        const result = await readRecentUserMessages(agent.type, transcript, 2);
        messages = result.messages;
        bytesRead = result.bytesRead;
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
    try {
      await this.captureDraft(record);
    } catch (error) {
      this.log('archive-draft', error);
    }
    try {
      await this.archiveSession(record, action);
    } catch (error) {
      this.log('archive-save', error);
    }
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
    this.deleteDraftsForRecord(record);
    await Promise.all([this.persist(), this.persistDrafts(), this.updateMonitorContext()]);
    if (wasPinned && !this.pinnedRecords().length && this.monitorView?.visible) {
      await this.hideMonitor();
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
      items.push({
        label: name,
        description: `orphaned private session · ${panes.length || 1} pane(s)`,
        name,
      });
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
    const savedPanes = [...savedWindow.panes].sort((left, right) => left.index - right.index);
    const savedPane = savedPanes[0];
    // history-limit is captured when tmux creates a window. Set the global
    // default in the same command queue before new-session so the first pane
    // also receives the larger scrollback buffer on a fresh private server.
    const args = [
      'set-option', '-g', 'history-limit', String(DEFAULT_TMUX_HISTORY_LIMIT), ';',
      'new-session', '-d', '-s', record.tmuxSession,
      '-n', safeTmuxName(savedWindow.name || 'shell'),
      '-c', existingDirectory(savedPane.cwd || record.cwd),
    ];
    if (dimensions) args.push('-x', String(dimensions.columns), '-y', String(dimensions.rows));
    const command = this.restoreCommand(savedPane.agent);
    if (command) args.push(command);
    await this.runTmux(args);

    const restoredPanes = [];
    const firstPaneId = (await this.runTmux([
      'display-message', '-p', '-t', `${record.tmuxSession}:.0`, '#{pane_id}',
    ])).trim();
    restoredPanes.push(this.restoredPaneRuntime(savedPane, firstPaneId));

    for (const pane of savedPanes.slice(1)) {
      const split = [
        'split-window', '-d', '-P', '-F', '#{pane_id}',
        '-t', `${record.tmuxSession}:`,
        '-c', existingDirectory(pane.cwd || record.cwd),
      ];
      const paneCommand = this.restoreCommand(pane.agent);
      if (paneCommand) split.push(paneCommand);
      const paneId = (await this.runTmux(split)).trim().split('\n').filter(Boolean).pop();
      restoredPanes.push(this.restoredPaneRuntime(pane, paneId));
    }

    const runtimeWindow = { ...savedWindow, panes: restoredPanes };
    await this.configurePanePresentation({ ...record, windows: [runtimeWindow] });
    if (savedWindow.layout && restoredPanes.length > 1) {
      await this.runTmux([
        'select-layout', '-t', `${record.tmuxSession}:`, savedWindow.layout,
      ], true);
    }
    const activeIndex = Math.max(0, savedPanes.findIndex((pane) => pane.active));
    const activePane = restoredPanes[activeIndex] || restoredPanes[0];
    if (activePane && activePane.id) {
      await this.runTmux(['select-pane', '-t', activePane.id], true);
      record.activePaneId = activePane.logicalId;
    }
  }

  restoredPaneRuntime(savedPane, paneId) {
    const logicalId = savedPane.logicalId || crypto.randomUUID();
    savedPane.logicalId = logicalId;
    return {
      ...savedPane,
      id: paneId,
      logicalId,
      role: normalizePaneRole(savedPane.role, Boolean(savedPane.agent)),
      restorePolicy: normalizeRestorePolicy(savedPane.restorePolicy, Boolean(savedPane.agent)),
    };
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
    await this.runTmux([
      'set-option', '-s', 'terminal-features[100]', 'xterm*:extkeys', ';',
      'set-option', '-s', 'extended-keys-format', 'csi-u', ';',
      'set-option', '-t', record.tmuxSession, 'extended-keys', 'always', ';',
      'set-option', '-t', record.tmuxSession, '@ai-terminal-id', record.id, ';',
      'set-option', '-t', record.tmuxSession, '@ai-terminal-workspace', this.workspaceHash, ';',
      'set-option', '-t', record.tmuxSession, 'destroy-unattached', 'off', ';',
      'set-option', '-t', record.tmuxSession, 'status', 'off', ';',
      'set-option', '-t', record.tmuxSession, 'set-titles', 'off', ';',
      'set-option', '-t', record.tmuxSession, 'prefix', 'C-b', ';',
      'set-option', '-t', record.tmuxSession, 'prefix2', 'None', ';',
      'set-option', '-t', record.tmuxSession, 'mouse', 'on', ';',
      'set-option', '-s', 'copy-command', '/usr/bin/pbcopy', ';',
      // Keep wheel scrolling inside tmux even when Codex uses the alternate
      // screen. A normal drag selects and copies, then exits copy mode on
      // release so a tiny movement cannot leave the terminal paused.
      'bind-key', '-T', 'root', 'WheelUpPane', 'copy-mode', '-e', '-t', '=', ';',
      'bind-key', '-T', 'root', 'MouseDrag1Pane', 'copy-mode', '-M', '-t', '=', ';',
      'bind-key', '-T', 'root', 'DoubleClick1Pane',
      'select-pane', '-t', '=', '\\;',
      'copy-mode', '-H', '-t', '=', '\\;',
      'send-keys', '-X', '-t', '=', 'select-word', '\\;',
      'send-keys', '-X', '-t', '=', 'copy-pipe-and-cancel', ';',
      'bind-key', '-T', 'copy-mode', 'MouseDragEnd1Pane',
      'send-keys', '-X', 'copy-pipe-and-cancel', ';',
      'bind-key', '-T', 'copy-mode-vi', 'MouseDragEnd1Pane',
      'send-keys', '-X', 'copy-pipe-and-cancel', ';',
      'bind-key', '-T', 'copy-mode', 'v', 'send-keys', '-X', 'begin-selection', ';',
      'bind-key', '-T', 'copy-mode', 'y', 'send-keys', '-X', 'copy-pipe-and-cancel', ';',
      'bind-key', '-T', 'copy-mode-vi', 'v', 'send-keys', '-X', 'begin-selection', ';',
      'bind-key', '-T', 'copy-mode-vi', 'y', 'send-keys', '-X', 'copy-pipe-and-cancel', ';',
      'unbind-key', '-q', '-T', 'root', 'MouseDown3Pane', ';',
      'unbind-key', '-q', '-T', 'root', 'M-MouseDown3Pane', ';',
      'set-window-option', '-t', `${record.tmuxSession}:`, 'window-size', 'latest', ';',
      'set-window-option', '-t', `${record.tmuxSession}:`, 'automatic-rename', 'off', ';',
      'set-window-option', '-t', `${record.tmuxSession}:`, 'pane-border-status',
      sessionPanes(record).length > 1 ? 'top' : 'off', ';',
      'set-window-option', '-t', `${record.tmuxSession}:`, 'pane-border-format',
      ' #{?pane_active,#[bold],}#{pane_index} #{@ai-pane-role} ',
    ]);
  }

  async configurePanePresentation(record) {
    const panes = sessionPanes(record);
    const args = [];
    for (const pane of panes) {
      if (!pane.id) continue;
      if (args.length) args.push(';');
      args.push(
        'set-option', '-p', '-t', pane.id, '@ai-pane-id', pane.logicalId || crypto.randomUUID(), ';',
        'set-option', '-p', '-t', pane.id, '@ai-pane-role', pane.role || 'shell',
      );
    }
    if (args.length) args.push(';');
    args.push(
      'set-window-option', '-t', `${record.tmuxSession}:`, 'pane-border-status',
      panes.length > 1 ? 'top' : 'off', ';',
      'set-window-option', '-t', `${record.tmuxSession}:`, 'pane-border-format',
      ' #{?pane_active,#[bold],}#{pane_index} #{@ai-pane-role} ',
    );
    await this.runTmux(args, true);
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
      '#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_layout}\t#{pane_id}\t#{@ai-pane-id}\t#{pane_index}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_active}\t#{pane_title}\t#{pane_in_mode}\t#{pane_mode}\t#{scroll_position}\t#{pane_start_command}',
    ], true);
    const parsedPanes = parseTmuxPanes(panesRaw);
    await this.ensurePaneIdentities(parsedPanes);
    const panesBySession = groupPanesBySession(parsedPanes);
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
    this.updateSessionStatusBar();
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

  async ensurePaneIdentities(panes) {
    const recordsBySession = new Map(
      [...this.records.values()].map((record) => [record.tmuxSession, record]),
    );
    const commands = [];
    for (const pane of panes) {
      if (pane.logicalId) continue;
      const record = recordsBySession.get(pane.session);
      const previous = record && (record.windows || [])
        .find((window) => window.index === pane.windowIndex)?.panes
        ?.find((item) => item.index === pane.paneIndex);
      pane.logicalId = previous && previous.logicalId || crypto.randomUUID();
      if (commands.length) commands.push(';');
      commands.push(
        'set-option', '-p', '-t', pane.id, '@ai-pane-id', pane.logicalId,
      );
    }
    if (commands.length) await this.runTmux(commands, true);
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
    const previousByLogicalId = new Map();
    for (const window of oldWindows) {
      for (const pane of window.panes || []) {
        previousByPosition.set(`${window.index}:${pane.index}`, pane);
        if (pane.logicalId) previousByLogicalId.set(pane.logicalId, pane);
      }
    }

    const windowsById = new Map();
    const events = [];
    for (const pane of panes) {
      let window = windowsById.get(pane.windowId);
      if (!window) {
        window = {
          id: pane.windowId,
          index: pane.windowIndex,
          name: pane.windowName,
          active: pane.windowActive,
          layout: pane.layout,
          panes: [],
        };
        windowsById.set(pane.windowId, window);
      }
      const previous = previousByLogicalId.get(pane.logicalId)
        || previousByPosition.get(`${pane.windowIndex}:${pane.paneIndex}`);
      let previousAgent = previous && previous.agent;
      if (previousAgent && sameAgent(previousAgent, record.activeAgent)) {
        previousAgent = {
          ...previousAgent,
          lastActivityAt: Number(previousAgent.lastActivityAt)
            || Number(record.lastAgentActivityAt) || 0,
          readyAt: Number(previousAgent.readyAt) || Number(record.readyAt) || 0,
          lastAcknowledgedReadyAt: Number(previousAgent.lastAcknowledgedReadyAt)
            || Number(record.lastAcknowledgedReadyAt) || 0,
          manuallyNeedsAttention: Boolean(
            previousAgent.manuallyNeedsAttention || record.manuallyNeedsAttention
          ),
          interruptedAt: Number(previousAgent.interruptedAt) || Number(record.interruptedAt) || 0,
          lastAcknowledgedInterruptedAt: Number(previousAgent.lastAcknowledgedInterruptedAt)
            || Number(record.lastAcknowledgedInterruptedAt) || 0,
        };
      }
      const observedAgent = await this.detectAgent(pane, processTable, now, record, previousAgent);
      let agent = observedAgent && mergeObservedAgent(previousAgent, observedAgent, now);
      if (!agent && previousAgent) {
        const grace = now - (previousAgent.lastSeenAt || 0) < 10000;
        agent = { ...previousAgent, active: grace, status: grace ? previousAgent.status : 'idle' };
        if (!grace) delete agent.pid;
      }
      if (agent && (agent.newlyReady
        || (previousAgent && previousAgent.status === 'running' && agent.status === 'waiting'))) {
        events.push({ agent, status: agent.status });
      }
      window.panes.push({
        id: pane.id,
        logicalId: pane.logicalId,
        index: pane.paneIndex,
        cwd: pane.cwd,
        process: pane.command,
        startCommand: pane.startCommand,
        active: pane.active,
        inMode: pane.inMode,
        mode: pane.mode,
        scrollPosition: pane.scrollPosition,
        lastTerminalActivityAt: Number(previous && previous.lastTerminalActivityAt)
          || (previous && previous.active ? Number(record.lastTerminalActivityAt) || 0 : 0),
        lastTerminalActivitySource: previous && previous.lastTerminalActivitySource
          || (previous && previous.active ? record.lastTerminalActivitySource : undefined),
        role: normalizePaneRole(previous && previous.role, Boolean(agent)),
        restorePolicy: normalizeRestorePolicy(previous && previous.restorePolicy, Boolean(agent)),
        ...(agent && { agent }),
      });
    }

    const windows = [...windowsById.values()]
      .sort((a, b) => a.index - b.index)
      .map((window) => ({
        ...window,
        panes: window.panes.sort((a, b) => a.index - b.index),
      }));
    const focused = focusedPane({ windows });
    const selected = focused && focused.agent && focused.agent.active ? focused.agent : undefined;
    const allAgents = windows.flatMap((window) => window.panes)
      .map((pane) => pane.agent)
      .filter(Boolean);
    const processes = panes.flatMap((pane) => descendantsOf(Number(pane.pid), processTable));
    const detectedIconPreset = automaticIconPreset({
      agentType: selected && selected.type,
      processes,
      railsProject: panes.some((pane) => (
        fs.existsSync(path.join(pane.cwd, 'config', 'application.rb'))
      )),
    });
    const oldFingerprint = record.fingerprint;
    const oldPaneCount = sessionPanes(record).length;

    record.windows = windows;
    record.activePaneId = focused && focused.logicalId;
    record.cwd = focused && focused.cwd || record.cwd;
    record.lastAgentActivityAt = selected ? Number(selected.lastActivityAt) || 0 : 0;
    record.lastTerminalActivityAt = focused ? Number(focused.lastTerminalActivityAt) || 0 : 0;
    record.lastTerminalActivitySource = focused && focused.lastTerminalActivitySource;
    record.status = selected ? selected.status : 'idle';
    record.readyAt = selected ? Number(selected.readyAt) || 0 : 0;
    record.lastAcknowledgedReadyAt = selected
      ? Number(selected.lastAcknowledgedReadyAt) || 0 : 0;
    record.manuallyNeedsAttention = selected ? Boolean(selected.manuallyNeedsAttention) : false;
    record.interruptedAt = selected ? Number(selected.interruptedAt) || 0 : 0;
    record.lastAcknowledgedInterruptedAt = selected
      ? Number(selected.lastAcknowledgedInterruptedAt) || 0 : 0;
    record.sourceTitle = selected && selected.title ? selected.title : record.sourceTitle;
    record.activeAgent = selected ? { type: selected.type, sessionId: selected.sessionId } : undefined;
    record.backgroundAttentionCount = allAgents.filter((agent) => (
      agent !== selected && agentNeedsAttention(agent)
    )).length;
    record.detectedIconPreset = detectedIconPreset;
    if (normalizeIconMode(record.iconMode, record.iconPreset) === 'auto') {
      record.iconPreset = detectedIconPreset;
    }
    record.updatedAt = snapshotDue ? now : record.updatedAt;
    this.updateAutomaticTitle(record, selected, now);
    record.fingerprint = fingerprintRecord(record);
    this.refreshPtyName(record);
    if (this.activeRecord()?.id === record.id) this.updateManagedTerminalContext(record);
    if (oldPaneCount !== sessionPanes(record).length) {
      this.configurePanePresentation(record).catch((error) => this.log('pane-presentation', error));
    }

    for (const event of events) {
      this.notifyReady(record, event.status, event.agent.title);
    }
    return oldFingerprint !== record.fingerprint;
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

  acknowledgeReady(record, pane = focusedPane(record)) {
    if (!record) return false;
    const agent = pane && pane.agent;
    const status = agent ? agent.status : record.status;
    const readyAt = agent ? Number(agent.readyAt) || 0 : Number(record.readyAt) || 0;
    const acknowledgedAt = agent
      ? Number(agent.lastAcknowledgedReadyAt) || 0
      : Number(record.lastAcknowledgedReadyAt) || 0;
    if (status !== 'done' || !readyAt || acknowledgedAt >= readyAt) return false;
    if (agent) agent.lastAcknowledgedReadyAt = readyAt;
    record.lastAcknowledgedReadyAt = readyAt;
    this.refreshPtyName(record);
    return true;
  }

  acknowledgeInterrupted(record, pane = focusedPane(record)) {
    if (!record) return false;
    const agent = pane && pane.agent;
    const interruptedAt = agent
      ? Number(agent.interruptedAt) || Number(agent.lastActivityAt) || 0
      : interruptionReference(record);
    const acknowledgedAt = agent
      ? Number(agent.lastAcknowledgedInterruptedAt) || 0
      : Number(record.lastAcknowledgedInterruptedAt) || 0;
    if (!interruptedAt
      || acknowledgedAt >= interruptedAt) return false;
    if (agent) {
      agent.lastAcknowledgedInterruptedAt = interruptedAt;
      if (agent.status === 'interrupted') agent.status = 'idle';
    }
    record.lastAcknowledgedInterruptedAt = interruptedAt;
    if (record.status === 'interrupted') record.status = 'idle';
    this.refreshPtyName(record);
    return true;
  }

  acknowledgeAttention(record, pane = focusedPane(record)) {
    const agent = pane && pane.agent;
    const manual = Boolean(record && (record.manuallyNeedsAttention
      || agent && agent.manuallyNeedsAttention));
    if (agent) agent.manuallyNeedsAttention = false;
    if (record) record.manuallyNeedsAttention = false;
    const ready = this.acknowledgeReady(record, pane);
    const interrupted = this.acknowledgeInterrupted(record, pane);
    const changed = manual || ready || interrupted;
    if (changed) {
      this.refreshPtyName(record);
      this.updateManagedTerminalContext(record);
      this.updateSessionStatusBar();
    }
    return changed;
  }

  async acknowledgeSubmittedInput(record) {
    const pane = await this.liveFocusedPane(record);
    this.acknowledgeAttention(record, pane);
    this.noteTerminalActivity(record, 'input', true, pane);
  }

  async liveFocusedPane(record) {
    let pane = focusedPane(record);
    const raw = (await this.runTmux([
      'display-message', '-p', '-t', `${record.tmuxSession}:`,
      '#{pane_id}\t#{@ai-pane-id}',
    ], true)).trim();
    const [paneId, logicalId] = raw.split('\t');
    let exact = sessionPanes(record).find((candidate) => (
      candidate.id === paneId || logicalId && candidate.logicalId === logicalId
    ));
    if (!exact && paneId) {
      await this.scanAll();
      exact = sessionPanes(record).find((candidate) => (
        candidate.id === paneId || logicalId && candidate.logicalId === logicalId
      ));
    }
    return exact || pane;
  }

  refreshPtyName(record) {
    const pty = this.ptys.get(record.id);
    if (pty) pty.setName(this.formatTerminalName(record));
  }

  notifyReady(record, status, paneTitle = '') {
    if (!this.config().get('notifyWhenReady', false)) return;
    const terminal = this.terminals.get(record.id);
    if (terminal && terminal === vscode.window.activeTerminal) return;
    const title = record.manualTitle || record.autoTitle || record.tmuxSession;
    const subject = paneTitle && paneTitle !== title ? `${title} · ${paneTitle}` : title;
    const message = status === 'waiting'
      ? `${subject} is waiting for permission.`
      : `${subject} finished and needs your attention.`;
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
    await Promise.all([this.persist(), this.persistDrafts(), this.archivePersistQueue]);
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
      logicalId: parts[7],
      paneIndex: Number(parts[8]),
      pid: Number(parts[9]),
      cwd: parts[10],
      command: parts[11],
      active: parts[12] === '1',
      title: parts[13],
      inMode: parts[14] === '1',
      mode: parts[15],
      scrollPosition: Math.max(0, Number(parts[16]) || 0),
      startCommand: parts.slice(17).join('\t'),
    };
  }).filter((pane) => pane.session && pane.id);
}

function paneInCopyMode(pane) {
  if (!pane || !pane.inMode) return false;
  return !pane.mode || /^(?:copy|view)-mode/.test(pane.mode);
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

async function readFilePrefix(file, maxBytes = 256 * 1024) {
  let handle;
  try {
    handle = await fs.promises.open(file, 'r');
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return buffer.toString('utf8');
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

function fingerprintRecord(record) {
  const windows = (record.windows || []).map((window) => ({
    index: window.index,
    name: window.name,
    active: window.active,
    layout: window.layout,
    panes: (window.panes || []).map((pane) => ({
      logicalId: pane.logicalId,
      index: pane.index,
      cwd: pane.cwd,
      process: pane.process,
      startCommand: pane.startCommand,
      active: pane.active,
      lastTerminalActivityAt: pane.lastTerminalActivityAt,
      lastTerminalActivitySource: pane.lastTerminalActivitySource,
      role: pane.role,
      restorePolicy: pane.restorePolicy,
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
        readyAt: pane.agent.readyAt,
        lastAcknowledgedReadyAt: pane.agent.lastAcknowledgedReadyAt,
        manuallyNeedsAttention: pane.agent.manuallyNeedsAttention,
        interruptedAt: pane.agent.interruptedAt,
        lastAcknowledgedInterruptedAt: pane.agent.lastAcknowledgedInterruptedAt,
      },
    })),
  }));
  return hashText(JSON.stringify({
    status: record.status,
    autoTitle: record.autoTitle,
    manualTitle: record.manualTitle,
    iconMode: record.iconMode,
    iconPreset: record.iconPreset,
    activeAgent: record.activeAgent,
    lastAgentActivityAt: record.lastAgentActivityAt,
    lastTerminalActivityAt: record.lastTerminalActivityAt,
    lastTerminalActivitySource: record.lastTerminalActivitySource,
    readyAt: record.readyAt,
    lastAcknowledgedReadyAt: record.lastAcknowledgedReadyAt,
    manuallyNeedsAttention: record.manuallyNeedsAttention,
    interruptedAt: record.interruptedAt,
    lastAcknowledgedInterruptedAt: record.lastAcknowledgedInterruptedAt,
    activePaneId: record.activePaneId,
    backgroundAttentionCount: record.backgroundAttentionCount,
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

function currentWorkspaceRoots() {
  return (vscode.workspace.workspaceFolders || []).map((folder) => ({
    name: folder.name,
    fsPath: folder.uri.fsPath,
  })).filter((root) => root.fsPath);
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
