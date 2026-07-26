import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ask } from '../../lib/coach.js';

// ask() is the pure-Mastra coach entry point (lib/coach.js). It accepts an
// injectable `generate` (defaults to the real agent's generate()), so it can
// be tested without Redis, a network, or @mastra/core. These tests pin the
// contract the callers rely on: success returns {text, engine:'mastra'}; an
// empty reply throws so each caller's graceful-fail runs; and memory is no
// longer prepended by hand (recall now happens inside the agent via its
// recall_hypotheses tool — see lib/agent.js).

test('returns {text, engine:"mastra"} on a non-empty agent reply', async () => {
  const fake = async (prompt) => ({ text: '{"slots":[]}' });
  const out = await ask('decide the keys', { generate: fake });
  assert.equal(out.engine, 'mastra');
  assert.equal(out.text, '{"slots":[]}');
});

test('accepts a plain string reply from generate()', async () => {
  const fake = async () => '{"change":false}';
  const out = await ask('x', { generate: fake });
  assert.equal(out.text, '{"change":false}');
  assert.equal(out.engine, 'mastra');
});

test('throws when the agent returns no text, so callers fail gracefully', async () => {
  await assert.rejects(ask('x', { generate: async () => ({ text: '' }) }), /no text/);
  await assert.rejects(ask('x', { generate: async () => ({ text: '   ' }) }), /no text/);
  await assert.rejects(ask('x', { generate: async () => null }), /no text/);
});

test('propagates a thrown generate() (no silent raw-z.ai fallback anymore)', async () => {
  const boom = async () => { throw new Error('upstream 500'); };
  await assert.rejects(ask('x', { generate: boom }), /upstream 500/);
});

test('does NOT manually prepend hypothesis notes to the prompt', async () => {
  // The old ask() prepended "Your previous hypothesis notes:\n..." by hand.
  // Recall is now Mastra-mediated (recall_hypotheses tool), so the prompt must
  // reach generate() unchanged.
  let seen = null;
  const fake = async (prompt) => { seen = prompt; return { text: '{"slots":[]}' }; };
  await ask('decide the keys', { generate: fake });
  assert.equal(seen, 'decide the keys');
  assert.doesNotMatch(seen, /hypothesis notes/i);
});
