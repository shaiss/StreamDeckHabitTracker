import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ask } from '../../lib/coach.js';

test('ask returns text + ai-sdk engine from a string generate stub', async () => {
  const out = await ask('ping', { generate: async () => '{"slots":[]}' });
  assert.equal(out.engine, 'ai-sdk');
  assert.equal(out.text, '{"slots":[]}');
});

test('ask accepts { text } results from generate', async () => {
  const out = await ask('ping', { generate: async () => ({ text: '{"change":false}' }) });
  assert.equal(out.text, '{"change":false}');
  assert.equal(out.engine, 'ai-sdk');
});

test('ask throws when generate returns empty text', async () => {
  await assert.rejects(
    () => ask('ping', { generate: async () => ({ text: '   ' }) }),
    /no text/
  );
});

test('ask forwards the prompt to generate', async () => {
  let seen;
  await ask('hello coach', {
    generate: async (prompt) => {
      seen = prompt;
      return { text: '{}' };
    }
  });
  assert.equal(seen, 'hello coach');
});
