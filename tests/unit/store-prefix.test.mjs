import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  redisKeyPrefix,
  redisKey,
  isPreviewEnv,
  isNonProductionEnv,
  previewRedisIsolatedFlag,
  previewStorageAllowed,
  assertPreviewStorageSafe,
  previewIsolationStatus,
  redisCmd
} from '../../lib/store.js';
import { runAsUser } from '../../lib/scope.js';

const OWNER = 'user_owner_prefix_test';

/** redisKey requires tenant ALS; owner maps logical keys without u: prefix. */
function asOwner(fn) {
  const prev = process.env.HABIT_OWNER_USER_ID;
  process.env.HABIT_OWNER_USER_ID = OWNER;
  return runAsUser(OWNER, fn).finally(() => {
    if (prev === undefined) delete process.env.HABIT_OWNER_USER_ID;
    else process.env.HABIT_OWNER_USER_ID = prev;
  });
}

const TRACKED = [
  'VERCEL_ENV',
  'REDIS_KEY_PREFIX',
  'PREVIEW_REDIS_PREFIX',
  'PREVIEW_REDIS_ISOLATED',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'HABIT_OWNER_USER_ID'
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

function withConfiguredRedis() {
  process.env.KV_REST_API_URL = 'https://example.test';
  process.env.KV_REST_API_TOKEN = 'token-long-enough';
}

test('redisKeyPrefix is empty when unset (Production default)', async () => {
  assert.equal(redisKeyPrefix(), '');
  await asOwner(() => {
    assert.equal(redisKey('habits:log'), 'habits:log');
  });
});

test('REDIS_KEY_PREFIX namespaces every logical key', async () => {
  process.env.REDIS_KEY_PREFIX = 'preview:';
  assert.equal(redisKeyPrefix(), 'preview:');
  await asOwner(() => {
    assert.equal(redisKey('habits:log'), 'preview:habits:log');
    assert.equal(redisKey('habits:slots'), 'preview:habits:slots');
    assert.equal(redisKey('habits:takeover:') + '2026-10-14', 'preview:habits:takeover:2026-10-14');
  });
});

test('PREVIEW_REDIS_PREFIX is an alias when REDIS_KEY_PREFIX is unset', async () => {
  process.env.PREVIEW_REDIS_PREFIX = 'pv:';
  assert.equal(redisKeyPrefix(), 'pv:');
  await asOwner(() => {
    assert.equal(redisKey('habits:config'), 'pv:habits:config');
  });
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

test('isNonProductionEnv is true for every VERCEL_ENV except production', () => {
  assert.equal(isNonProductionEnv(), true); // unset
  process.env.VERCEL_ENV = 'preview';
  assert.equal(isNonProductionEnv(), true);
  process.env.VERCEL_ENV = 'development';
  assert.equal(isNonProductionEnv(), true);
  process.env.VERCEL_ENV = 'staging';
  assert.equal(isNonProductionEnv(), true);
  process.env.VERCEL_ENV = 'production';
  assert.equal(isNonProductionEnv(), false);
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
  withConfiguredRedis();
  assert.equal(previewStorageAllowed(), false);
  assert.throws(() => assertPreviewStorageSafe(), /Non-production storage isolation required/);
  const st = previewIsolationStatus();
  assert.equal(st.nonProduction, true);
  assert.equal(st.required, true);
  assert.equal(st.ok, false);
  assert.equal(st.keyPrefixSet, false);
  assert.equal(st.separateDbFlag, false);
});

test('development fail-closed: configured Development without prefix or flag is denied', () => {
  process.env.VERCEL_ENV = 'development';
  withConfiguredRedis();
  assert.equal(previewStorageAllowed(), false);
  assert.throws(() => assertPreviewStorageSafe(), /Non-production storage isolation required/);
  const st = previewIsolationStatus();
  assert.equal(st.vercelEnv, 'development');
  assert.equal(st.nonProduction, true);
  assert.equal(st.required, true);
  assert.equal(st.ok, false);
});

test('unknown/unset VERCEL_ENV fail-closed when Redis is configured', () => {
  // VERCEL_ENV deliberately unset
  withConfiguredRedis();
  assert.equal(isNonProductionEnv(), true);
  assert.equal(previewStorageAllowed(), false);
  assert.throws(() => assertPreviewStorageSafe(), /Non-production storage isolation required/);
  assert.equal(previewIsolationStatus().required, true);
  assert.equal(previewIsolationStatus().ok, false);

  process.env.VERCEL_ENV = 'custom-env';
  assert.equal(previewStorageAllowed(), false);
  assert.equal(previewIsolationStatus().nonProduction, true);
});

test('preview allowed when REDIS_KEY_PREFIX is set (defense-in-depth)', () => {
  process.env.VERCEL_ENV = 'preview';
  withConfiguredRedis();
  process.env.REDIS_KEY_PREFIX = 'preview:';
  assert.equal(previewStorageAllowed(), true);
  assert.doesNotThrow(() => assertPreviewStorageSafe());
  assert.equal(previewIsolationStatus().ok, true);
  assert.equal(previewIsolationStatus().keyPrefixSet, true);
});

test('isolated non-prod ok: development with PREVIEW_REDIS_ISOLATED attests a separate DB', () => {
  process.env.VERCEL_ENV = 'development';
  withConfiguredRedis();
  process.env.PREVIEW_REDIS_ISOLATED = '1';
  assert.equal(previewStorageAllowed(), true);
  assert.doesNotThrow(() => assertPreviewStorageSafe());
  assert.equal(previewIsolationStatus().separateDbFlag, true);
  assert.equal(previewIsolationStatus().ok, true);
});

test('preview allowed when PREVIEW_REDIS_ISOLATED attests a separate Upstash DB', () => {
  process.env.VERCEL_ENV = 'preview';
  withConfiguredRedis();
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
  withConfiguredRedis();
  assert.equal(isNonProductionEnv(), false);
  assert.equal(previewStorageAllowed(), true);
  assert.equal(previewIsolationStatus().nonProduction, false);
  assert.equal(previewIsolationStatus().required, false);
  assert.equal(previewIsolationStatus().ok, true);
});

test('redisCmd fails closed in Preview before fetch when isolation is missing', async () => {
  process.env.VERCEL_ENV = 'preview';
  withConfiguredRedis();
  let fetched = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    return { ok: true, json: async () => ({ result: null }) };
  };
  try {
    await asOwner(async () => {
      await assert.rejects(() => redisCmd(['GET', redisKey('habits:log')]), /Non-production storage isolation/);
    });
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('redisCmd fails closed in Development before fetch when isolation is missing', async () => {
  process.env.VERCEL_ENV = 'development';
  withConfiguredRedis();
  let fetched = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    return { ok: true, json: async () => ({ result: null }) };
  };
  try {
    await asOwner(async () => {
      await assert.rejects(() => redisCmd(['GET', redisKey('habits:log')]), /Non-production storage isolation/);
    });
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('redisCmd issues prefixed keys when isolation is via REDIS_KEY_PREFIX', async () => {
  process.env.VERCEL_ENV = 'preview';
  withConfiguredRedis();
  process.env.REDIS_KEY_PREFIX = 'preview:';
  let body;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ result: 'OK' }) };
  };
  try {
    await asOwner(async () => {
      await redisCmd(['SET', redisKey('habits:slots'), '{}']);
    });
    assert.deepEqual(body, ['SET', 'preview:habits:slots', '{}']);
  } finally {
    globalThis.fetch = original;
  }
});
