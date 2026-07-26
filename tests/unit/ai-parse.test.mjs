import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from '../../lib/ai.js';

test('extracts JSON from fenced and prose-wrapped replies', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here you go: {"slots":[{"habit":"X"}]} hope that helps'), { slots: [{ habit: 'X' }] });
});

test('throws on replies with no JSON object', () => {
  assert.throws(() => extractJson('no json here'));
});

test('ignores a stray brace in trailing prose', () => {
  // The exact shape that 500'd the first live roster pass: an empty result
  // followed by reasoning that happened to contain "}".
  assert.deepEqual(extractJson('{"proposals":[]}\n\nNothing to change (your roster is tight} today.'), { proposals: [] });
  assert.deepEqual(extractJson('```json\n{"slots":[]}\n```\nI kept them as-is }'), { slots: [] });
});

test('takes the first object when a reply contains several', () => {
  assert.deepEqual(extractJson('{"proposals":[{"kind":"add"}]} then junk {"proposals":[]}'), {
    proposals: [{ kind: 'add' }]
  });
});

test('braces inside string values never end the object early', () => {
  assert.deepEqual(extractJson('{"reason":"you said \\"stop} now\\"","kind":"retire"}'), {
    reason: 'you said "stop} now"',
    kind: 'retire'
  });
  assert.deepEqual(extractJson('prose {"label":"a}b"} more'), { label: 'a}b' });
});

test('throws on a truncated object rather than inventing a shape', () => {
  // A reply cut off mid-object is unrecoverable — callers treat the throw as
  // "no usable output" instead of acting on a half-parsed payload.
  assert.throws(() => extractJson('{"a":{"b":1}'));
});
