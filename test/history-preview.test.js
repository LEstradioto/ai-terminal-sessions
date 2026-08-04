'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { historyPreviewHtml } = require('../session-recovery');

test('history preview has a strict CSP and escapes saved messages', () => {
  const html = historyPreviewHtml({
    title: '<pricing>',
    provider: 'codex',
    archivedAt: 1000,
    preview: [{ role: 'user', text: '<script>alert(1)</script>' }],
  });
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
