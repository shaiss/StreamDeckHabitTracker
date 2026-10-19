import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_NOTES,
  MEMORY_MAX,
  recallHypothesesNotes,
  updateHypothesesNotes
} from '../../lib/coach-memory.js';

test('recall returns placeholder when memory is empty', async () => {
  const out = await recallHypothesesNotes({ getMemory: async () => null });
  assert.deepEqual(out, { notes: EMPTY_NOTES });
});

test('recall returns stored notes', async () => {
  const out = await recallHypothesesNotes({
    getMemory: async () => ({ notes: 'prefers morning water', updatedAt: 1 })
  });
  assert.deepEqual(out, { notes: 'prefers morning water' });
});

test('recall survives a store failure', async () => {
  const out = await recallHypothesesNotes({
    getMemory: async () => {
      throw new Error('redis down');
    }
  });
  assert.deepEqual(out, { notes: EMPTY_NOTES });
});

test('update overwrites, caps length, and stamps updatedAt', async () => {
  const writes = [];
  const long = 'x'.repeat(MEMORY_MAX + 50);
  const out = await updateHypothesesNotes(long, {
    setMemory: async (doc) => {
      writes.push(doc);
    },
    now: () => 42
  });
  assert.deepEqual(out, { saved: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].notes.length, MEMORY_MAX);
  assert.equal(writes[0].updatedAt, 42);
});
