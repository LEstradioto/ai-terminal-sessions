'use strict';

const COMMANDS = Object.freeze({
  compact: 'workbench.action.enableCompactAuxiliaryWindow',
  float: 'workbench.action.moveEditorToNewWindow',
  main: 'workbench.action.switchToMainWindow',
  restore: 'workbench.action.restoreEditorsToMainWindow',
  top: 'workbench.action.enableWindowAlwaysOnTop',
  untop: 'workbench.action.disableWindowAlwaysOnTop',
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

  async focusPanel(panel) {
    if (!panel.active) {
      panel.reveal(this.vscode.ViewColumn.Active, false);
      await this.wait(80);
    }
    return Boolean(panel.active);
  }

  async showPanel(panel, options = {}) {
    const available = await this.commandSet();
    if (!available.has(COMMANDS.main) || !await this.focusPanel(panel)) return false;
    if (options.alwaysOnTop) await this.run(COMMANDS.top);
    await this.run(COMMANDS.main, true);
    return true;
  }

  async hidePanel(panel) {
    const available = await this.commandSet();
    if (!available.has(COMMANDS.main) || !await this.focusPanel(panel)) return false;
    await this.run(COMMANDS.untop);
    await this.run(COMMANDS.main, true);
    return true;
  }

  async floatPanel(panel, options = {}) {
    const available = await this.commandSet();
    if (!available.has(COMMANDS.float) || !available.has(COMMANDS.main)) return false;
    if (!panel.active) {
      panel.reveal(this.vscode.ViewColumn.Active, false);
      await this.wait(80);
    }
    if (!panel.active) return false;
    await this.run(COMMANDS.float, true);
    await this.wait(280);
    await this.run(COMMANDS.compact);
    if (options.alwaysOnTop) await this.run(COMMANDS.top);
    await this.run(COMMANDS.main, true);
    return true;
  }
}

module.exports = { COMMANDS, WorkbenchWindowAdapter };
