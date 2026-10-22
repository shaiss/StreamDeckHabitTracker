import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withThinkingDisabled } from '../../lib/zai-fetch.js';

test('injects thinking:disabled on chat/completions bodies that lack it', () => {
  const init = withThinkingDisabled('https://api.z.ai/api/paas/v4/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'glm-5.2', messages: [] })
  });
  assert.deepEqual(JSON.parse(init.body).thinking, { type: 'disabled' });
});

test('does not overwrite an explicit thinking field', () => {
  const init = withThinkingDisabled('https://api.z.ai/api/paas/v4/chat/completions', {
    body: JSON.stringify({ model: 'x', thinking: { type: 'enabled' } })
  });
  assert.deepEqual(JSON.parse(init.body).thinking, { type: 'enabled' });
});

test('leaves non-chat-completions requests untouched', () => {
  const original = { body: JSON.stringify({ model: 'x' }) };
  const init = withThinkingDisabled('https://api.z.ai/api/paas/v4/embeddings', original);
  assert.equal(init, original);
  assert.equal(JSON.parse(init.body).thinking, undefined);
});

test('passes through unparseable bodies without throwing', () => {
  const original = { body: 'not-json{' };
  const init = withThinkingDisabled('https://api.z.ai/api/paas/v4/chat/completions', original);
  assert.equal(init, original);
});
