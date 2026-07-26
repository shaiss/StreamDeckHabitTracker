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
