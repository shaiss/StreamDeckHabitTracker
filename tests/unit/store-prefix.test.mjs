import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  redisKeyPrefix,
  redisKey,
  isPreviewEnv,
  previewRedisIsolatedFlag,
  previewStorageAllowed,
  assertPreviewStorageSafe,
  previewIsolationStatus,
  redisCmd
} from '../../lib/store.js';

const TRACKED = [
  'VERCEL_ENV',
  'REDIS_KEY_PREFIX',
  'PREVIEW_REDIS_PREFIX',
  'PREVIEW_REDIS_ISOLATED',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN'
];

const saved = {};

beforeEach(() => {
  for (const k of TRACKED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TRACKED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test('redisKeyPrefix is empty when unset (Production default)', () => {
  assert.equal(redisKeyPrefix(), '');
  assert.equal(redisKey('habits:log'), 'habits:log');
});

test('REDIS_KEY_PREFIX namespaces every logical key', () => {
  process.env.REDIS_KEY_PREFIX = 'preview:';
  assert.equal(redisKeyPrefix(), 'preview:');
  assert.equal(redisKey('habits:log'), 'preview:habits:log');
  assert.equal(redisKey('habits:slots'), 'preview:habits:slots');
  assert.equal(redisKey('habits:takeover:') + '2026-10-14', 'preview:habits:takeover:2026-10-14');
});

test('PREVIEW_REDIS_PREFIX is an alias when REDIS_KEY_PREFIX is unset', () => {
  process.env.PREVIEW_REDIS_PREFIX = 'pv:';
  assert.equal(redisKeyPrefix(), 'pv:');
  assert.equal(redisKey('habits:config'), 'pv:habits:config');
});

test('REDIS_KEY_PREFIX wins over PREVIEW_REDIS_PREFIX', () => {
  process.env.REDIS_KEY_PREFIX = 'a:';
  process.env.PREVIEW_REDIS_PREFIX = 'b:';
  assert.equal(redisKeyPrefix(), 'a:');
});

test('prefix trims whitespace; whitespace-only is treated as empty', () => {
  process.env.REDIS_KEY_PREFIX = '  preview:  ';
  assert.equal(redisKeyPrefix(), 'preview:');
  process.env.REDIS_KEY_PREFIX = '   ';
  assert.equal(redisKeyPrefix(), '');
});

test('isPreviewEnv is true only for VERCEL_ENV=preview', () => {
  assert.equal(isPreviewEnv(), false);
  process.env.VERCEL_ENV = 'production';
  assert.equal(isPreviewEnv(), false);
  process.env.VERCEL_ENV = 'preview';
  assert.equal(isPreviewEnv(), true);
});

test('previewRedisIsolatedFlag accepts 1/true/yes (case-insensitive)', () => {
  assert.equal(previewRedisIsolatedFlag(), false);
  process.env.PREVIEW_REDIS_ISOLATED = '1';
  assert.equal(previewRedisIsolatedFlag(), true);
  process.env.PREVIEW_REDIS_ISOLATED = 'TRUE';
  assert.equal(previewRedisIsolatedFlag(), true);
  process.env.PREVIEW_REDIS_ISOLATED = 'yes';
  assert.equal(previewRedisIsolatedFlag(), true);
  process.env.PREVIEW_REDIS_ISOLATED = 'no';
  assert.equal(previewRedisIsolatedFlag(), false);
});

test('preview fail-closed: configured Preview without prefix or flag is denied', () => {
  process.env.VERCEL_ENV = 'preview';
  process.env.KV_REST_API_URL = 'https://example.test';
  process.env.KV_REST_API_TOKEN = 'token-long-enough';
  assert.equal(previewStorageAllowed(), false);
  assert.throws(() => assertPreviewStorageSafe(), /Preview storage isolation required/);
  const st = previewIsolationStatus();
  assert.equal(st.required, true);
  assert.equal(st.ok, false);
  assert.equal(st.keyPrefixSet, false);
  assert.equal(st.separateDbFlag, false);
});

test('preview allowed when REDIS_KEY_PREFIX is set (defense-in-depth)', () => {
  process.env.VERCEL_ENV = 'preview';
  process.env.KV_REST_API_URL = 'https://example.test';
  process.env.KV_REST_API_TOKEN = 'token-long-enough';
  process.env.REDIS_KEY_PREFIX = 'preview:';
  assert.equal(previewStorageAllowed(), true);
  assert.doesNotThrow(() => assertPreviewStorageSafe());
  assert.equal(previewIsolationStatus().ok, true);
  assert.equal(previewIsolationStatus().keyPrefixSet, true);
});

test('preview allowed when PREVIEW_REDIS_ISOLATED attests a separate Upstash DB', () => {
  process.env.VERCEL_ENV = 'preview';
  process.env.KV_REST_API_URL = 'https://example.test';
  process.env.KV_REST_API_TOKEN = 'token-long-enough';
  process.env.PREVIEW_REDIS_ISOLATED = '1';
  assert.equal(previewStorageAllowed(), true);
  assert.doesNotThrow(() => assertPreviewStorageSafe());
  assert.equal(previewIsolationStatus().separateDbFlag, true);
});

test('preview with Redis unconfigured is allowed (API degrades; nothing to leak into)', () => {
  process.env.VERCEL_ENV = 'preview';
  assert.equal(previewStorageAllowed(), true);
  assert.doesNotThrow(() => assertPreviewStorageSafe());
  assert.equal(previewIsolationStatus().required, false);
  assert.equal(previewIsolationStatus().ok, true);
});

test('production never requires isolation even with Redis configured', () => {
  process.env.VERCEL_ENV = 'production';
  process.env.KV_REST_API_URL = 'https://example.test';
  process.env.KV_REST_API_TOKEN = 'token-long-enough';
  assert.equal(previewStorageAllowed(), true);
  assert.equal(previewIsolationStatus().required, false);
});

test('redisCmd fails closed in Preview before fetch when isolation is missing', async () => {
  process.env.VERCEL_ENV = 'preview';
  process.env.KV_REST_API_URL = 'https://example.test';
  process.env.KV_REST_API_TOKEN = 'token-long-enough';
  let fetched = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    return { ok: true, json: async () => ({ result: null }) };
  };
  try {
    await assert.rejects(() => redisCmd(['GET', redisKey('habits:log')]), /Preview storage isolation/);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('redisCmd issues prefixed keys when isolation is via REDIS_KEY_PREFIX', async () => {
  process.env.VERCEL_ENV = 'preview';
  process.env.KV_REST_API_URL = 'https://example.test';
  process.env.KV_REST_API_TOKEN = 'token-long-enough';
  process.env.REDIS_KEY_PREFIX = 'preview:';
  let body;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ result: 'OK' }) };
  };
  try {
    await redisCmd(['SET', redisKey('habits:slots'), '{}']);
    assert.deepEqual(body, ['SET', 'preview:habits:slots', '{}']);
  } finally {
    globalThis.fetch = original;
  }
});
