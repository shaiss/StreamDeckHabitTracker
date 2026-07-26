import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreOutput } from '../../lib/quality.js';

test('specific well-formed output scores high', () => {
  const q = scoreOutput([
    { habit: 'Mood', emoji: '🙂', label: 'Mood', reason: 'You tapped Eat at 1am — mood connects your late nights to how you feel.' }
  ]);
  assert.ok(q.composite > 0.8, JSON.stringify(q));
});

test('duplicating a fixed habit zeroes noDuplicates; custom fixedNames honored', () => {
  const dup = scoreOutput([{ habit: 'Drink', emoji: '💧', label: 'Drink', reason: 'generic' }]);
  assert.equal(dup.noDuplicates, 0);
  const custom = scoreOutput([{ habit: 'Drink', emoji: '💧', label: 'Drink', reason: 'generic' }], { fixedNames: ['Foo'] });
  assert.equal(custom.noDuplicates, 1);
});

test('parse failure scores zero; long labels fail labelFit', () => {
  assert.equal(scoreOutput(null, { parseOk: false }).composite, 0);
  assert.equal(scoreOutput([{ habit: 'X', emoji: '✨', label: 'A very long label indeed', reason: '' }]).labelFit, 0);
});
