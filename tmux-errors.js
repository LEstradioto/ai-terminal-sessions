'use strict';

function tmuxErrorMessage(error) {
  if (!error) return 'unknown error';
  return error.stderr || error.message || String(error);
}

function isMissingTmuxSessionError(error) {
  const message = tmuxErrorMessage(error).toLocaleLowerCase();
  return Number(error && error.code) === 1 && (
    message.includes("can't find session")
    || message.includes('no server running')
    || message.includes('failed to connect to server')
    || (message.includes('error connecting to') && message.includes('no such file or directory'))
  );
}

module.exports = { isMissingTmuxSessionError, tmuxErrorMessage };
