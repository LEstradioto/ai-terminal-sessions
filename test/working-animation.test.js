'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { WORKING_FRAMES, workingIndicator } = require('../working-animation');

test('working animation uses a neutral outline circle and fixed-width spinner', () => {
  assert.equal(WORKING_FRAMES.length, 10);
  assert.equal(new Set(WORKING_FRAMES).size, WORKING_FRAMES.length);
  for (const frame of WORKING_FRAMES) {
    assert.equal(frame.startsWith('○'), true);
    assert.equal([...frame].length, 2);
  }
});

test('reduced motion keeps only the static outline circle', () => {
  assert.equal(workingIndicator(0, true), '○');
  assert.equal(workingIndicator(999, true), '○');
  assert.notEqual(workingIndicator(0, false), workingIndicator(1, false));
});
