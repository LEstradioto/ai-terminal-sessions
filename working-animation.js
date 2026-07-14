'use strict';

const WORKING_FRAMES = Object.freeze([
  '○⠋', '○⠙', '○⠹', '○⠸', '○⠼', '○⠴', '○⠦', '○⠧', '○⠇', '○⠏',
]);

function workingIndicator(frame = 0, reducedMotion = false) {
  if (reducedMotion) return '○';
  const index = Math.abs(Number(frame) || 0) % WORKING_FRAMES.length;
  return WORKING_FRAMES[index];
}

module.exports = { WORKING_FRAMES, workingIndicator };
