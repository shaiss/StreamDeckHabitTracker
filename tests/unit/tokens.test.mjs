// Per-user ht_ token store: peppered hash, preview prefix, atomic create cleanup.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const ENV_KEYS = [
  'HABIT_TOKEN_PEPPER',
  'REDIS_KEY_PREFIX',
  'PREVIEW_REDIS_PREFIX',
  'PREVIEW_REDIS_ISOLATED',
  'VERCEL_ENV',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'STORAGE_REST_API_URL',
  'STORAGE_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'REDIS_REST_URL',
  'REDIS_REST_TOKEN'
];
const saved = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HABIT_TOKEN_PEPPER = 'unit-test-pepper';
  process.env.VERCEL_ENV = 'production';
  process.env.KV_REST_API_URL = 'https://example-redis.test';
  process.env.KV_REST_API_TOKEN = 'token-long-enough';
});
afterEach(() => {
  mock.restoreAll();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function loadTokens() {
  // Fresh module so env + fetch mocks apply.
  return import('../../lib/tokens.js?' + Date.now() + Math.random());
}

function expectedHash(plaintext, pepper = 'unit-test-pepper') {
  return createHash('sha256')
    .update(pepper, 'utf8')
    .update('\0', 'utf8')
    .update(plaintext, 'utf8')
    .digest('hex');
}

test('hashToken mixes pepper; different peppers diverge', async () => {
  const { hashToken } = await loadTokens();
  const a = hashToken('ht_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(a, expectedHash('ht_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
  process.env.HABIT_TOKEN_PEPPER = 'other-pepper';
  const { hashToken: hash2 } = await loadTokens();
  assert.notEqual(hash2('ht_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), a);
});

test('looksLikeApiToken requires ht_ prefix and length', async () => {
  const { looksLikeApiToken } = await loadTokens();
  assert.equal(looksLikeApiToken('ht_aaaaaaaaaaaaaaaaaaaa'), true);
  assert.equal(looksLikeApiToken('deploy-secret'), false);
  assert.equal(looksLikeApiToken('ht_short'), false);
  assert.equal(looksLikeApiToken(null), false);
});

test('verifyApiToken returns null when pepper unset', async () => {
  delete process.env.HABIT_TOKEN_PEPPER;
  const { verifyApiToken } = await loadTokens();
  assert.equal(await verifyApiToken('ht_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), null);
});

test('createApiToken refuses without pepper', async () => {
  delete process.env.HABIT_TOKEN_PEPPER;
  const { createApiToken } = await loadTokens();
  await assert.rejects(() => createApiToken('user_a'), /HABIT_TOKEN_PEPPER/);
});

test('create + verify round-trip; Redis keys are env-prefixed', async () => {
  process.env.REDIS_KEY_PREFIX = 'preview:';
  process.env.VERCEL_ENV = 'preview';
  const calls = [];
  mock.method(global, 'fetch', async (_url, init) => {
    const args = JSON.parse(init.body);
    calls.push(args);
    if (args[0] === 'SET') return { ok: true, json: async () => ({ result: 'OK' }) };
    if (args[0] === 'SADD') return { ok: true, json: async () => ({ result: 1 }) };
    if (args[0] === 'GET') {
      const meta = JSON.parse(calls.find((c) => c[0] === 'SET')[2]);
      return { ok: true, json: async () => ({ result: JSON.stringify(meta) }) };
    }
    return { ok: true, json: async () => ({ result: null }) };
  });
  const { createApiToken, verifyApiToken, hashToken } = await loadTokens();
  const { token, meta } = await createApiToken('user_a', { label: 'Deck' });
  assert.match(token, /^ht_/);
  assert.equal(meta.hash, hashToken(token));
  assert.ok(calls.some((c) => c[0] === 'SET' && String(c[1]).startsWith('preview:habits:apitoken:')));
  assert.ok(calls.some((c) => c[0] === 'SADD' && c[1] === 'preview:habits:apitokens:user_a'));
  assert.equal(await verifyApiToken(token), 'user_a');
});

test('STORAGE_REST_API_* credentials are enough for token ops', async () => {
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  process.env.STORAGE_REST_API_URL = 'https://storage-redis.test';
  process.env.STORAGE_REST_API_TOKEN = 'storage-token-long';
  const urls = [];
  mock.method(global, 'fetch', async (url, init) => {
    urls.push(url);
    const args = JSON.parse(init.body);
    if (args[0] === 'SET') return { ok: true, json: async () => ({ result: 'OK' }) };
    if (args[0] === 'SADD') return { ok: true, json: async () => ({ result: 1 }) };
    return { ok: true, json: async () => ({ result: null }) };
  });
  const { createApiToken } = await loadTokens();
  await createApiToken('user_b');
  assert.equal(urls[0], 'https://storage-redis.test');
});

test('createApiToken deletes meta when SADD fails (no orphan credential)', async () => {
  const ops = [];
  mock.method(global, 'fetch', async (_url, init) => {
    const args = JSON.parse(init.body);
    ops.push(args[0]);
    if (args[0] === 'SET') return { ok: true, json: async () => ({ result: 'OK' }) };
    if (args[0] === 'SADD') return { ok: false, text: async () => 'boom' };
    if (args[0] === 'DEL') return { ok: true, json: async () => ({ result: 1 }) };
    return { ok: true, json: async () => ({ result: null }) };
  });
  const { createApiToken } = await loadTokens();
  await assert.rejects(() => createApiToken('user_c'), /store/);
  assert.deepEqual(ops, ['SET', 'SADD', 'DEL']);
});

test('verify compares stored hash in constant-time path (mismatch → null)', async () => {
  mock.method(global, 'fetch', async (_url, init) => {
    const args = JSON.parse(init.body);
    if (args[0] === 'GET') {
      return {
        ok: true,
        json: async () => ({
          result: JSON.stringify({
            userId: 'user_x',
            hash: '0'.repeat(64) // wrong hash
          })
        })
      };
    }
    return { ok: true, json: async () => ({ result: null }) };
  });
  const { verifyApiToken } = await loadTokens();
  assert.equal(await verifyApiToken('ht_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), null);
});
