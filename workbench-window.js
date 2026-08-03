'use strict';

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

module.exports = { COMMANDS, WorkbenchWindowAdapter };
