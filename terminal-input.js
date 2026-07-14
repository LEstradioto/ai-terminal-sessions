'use strict';

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

module.exports = { PASTE_END, PASTE_START, analyzeTerminalInput };
