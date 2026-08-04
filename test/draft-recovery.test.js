'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractDraft } = require('../tmux-pty');

test('extracts a multiline Codex composer and stops before its status line', () => {
  const buffer = [
    'previous answer',
    '',
    '› improve this parser',
    '  preserve symbols like Map<String, Int>',
    'gpt-5.6 xhigh fast · Context 62% used · 258K window',
  ].join('\n');

  assert.equal(extractDraft(buffer), 'improve this parser\npreserve symbols like Map<String, Int>');
});

test('extracts a Claude composer between plain dividers', () => {
  const divider = '─'.repeat(80);
  const buffer = [
    'previous answer',
    divider,
    '❯\u00a0vamos testar o claude',
    '  segunda linha',
    divider,
    '  ⏵⏵ auto mode on',
  ].join('\n');

  assert.equal(extractDraft(buffer), 'vamos testar o claude\nsegunda linha');
});

test('preserves internal blank lines', () => {
  const buffer = [
    'old output',
    '› primeiro bloco',
    '',
    '  segundo bloco',
    '',
  ].join('\n');
  assert.equal(extractDraft(buffer), 'primeiro bloco\n\nsegundo bloco');
});

test('does not save empty composers or Codex suggestions', () => {
  const divider = '─'.repeat(80);
  assert.equal(extractDraft(`${divider}\n❯\u00a0\n${divider}`), undefined);
  assert.equal(extractDraft('› Improve documentation in @filename\n\ngpt-5.6 xhigh · Context 4% used · 353K window'), undefined);
});

test('an empty current marker prevents fallback to an older prompt', () => {
  const buffer = [
    '› old submitted prompt',
    'assistant output',
    '',
    '❯\u00a0',
    '  auto mode on',
  ].join('\n');
  assert.equal(extractDraft(buffer), undefined);
});

test('does not mistake a Claude branch label for the empty composer', () => {
  const top = `${'─'.repeat(20)} old branch text (Branch) ${'─'.repeat(20)}`;
  const bottom = '─'.repeat(80);
  assert.equal(extractDraft(`${top}\n❯\u00a0\n${bottom}\n  auto mode on`), undefined);
});
