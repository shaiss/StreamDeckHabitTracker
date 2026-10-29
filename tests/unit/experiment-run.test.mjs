// #122 follow-up: experiment run deadline (AbortSignal), signal plumbing through
// chat/store, vercel maxDuration, and server-side error logging without leaking
// details to callers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chat } from '../../lib/ai.js';
import { redisCmd } from '../../lib/store.js';
import { storeExperiment } from '../../lib/dataset.js';
import { EXPERIMENT_RUN_TIMEOUT_MS, EXPERIMENT_LOCK_TTL_SEC } from '../../lib/experiment-guard.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
const experimentSrc = readFileSync(join(ROOT, 'api/experiment.js'), 'utf8');

test('vercel.json gives api/experiment.js a 60s maxDuration like sibling coach routes', () => {
  assert.equal(vercel.functions['api/experiment.js']?.maxDuration, 60);
  assert.equal(vercel.functions['api/suggest.js']?.maxDuration, 60);
});

test('api/experiment.js bounds the run with AbortSignal and clears the timer', () => {
  assert.match(experimentSrc, /AbortController/);
  assert.match(experimentSrc, /EXPERIMENT_RUN_TIMEOUT_MS/);
  assert.match(experimentSrc, /clearTimeout\(runTimer\)/);
  assert.match(experimentSrc, /signal:\s*signal|signal\b/);
  assert.ok(
    EXPERIMENT_RUN_TIMEOUT_MS < EXPERIMENT_LOCK_TTL_SEC * 1000,
    'deadline must stay under the Redis lease'
  );
});

test('api/experiment.js starts the abort deadline before claimExperimentRun', () => {
  const abortAt = experimentSrc.indexOf('new AbortController');
  const claimAt = experimentSrc.indexOf('claimExperimentRun(');
  assert.ok(abortAt >= 0 && claimAt >= 0, 'both sites present');
  assert.ok(abortAt < claimAt, 'AbortController must be created before claim Redis ops');
  assert.match(experimentSrc, /claimExperimentRun\(\{\s*signal\s*\}\)/);
});

test('api/experiment.js fails closed when cooldown stamp fails (no silent 200)', () => {
  // Successful path stamps cooldown before res.status(200); stamp failure → 500.
  assert.match(experimentSrc, /await finishExperimentRun\(\{\s*ok:\s*true,\s*token:\s*lockToken,\s*signal\s*\}\)/);
  const finishOkAt = experimentSrc.indexOf('finishExperimentRun({ ok: true');
  const ok200At = experimentSrc.indexOf("res.status(200).json(doc)");
  assert.ok(finishOkAt >= 0 && ok200At >= 0);
  assert.ok(finishOkAt < ok200At, 'cooldown stamp must precede the success response');
  assert.match(experimentSrc, /lockHandled\s*=\s*true/);
});

test('api/experiment.js logs unexpected failures server-side without changing the 500 body', () => {
  assert.match(experimentSrc, /logExperimentError\('experiment failed:'/);
  assert.match(experimentSrc, /logExperimentError\('finishExperimentRun failed:'/);
  assert.match(experimentSrc, /res\.status\(500\)\.json\(\{\s*error:\s*'Experiment failed\.'\s*\}\)/);
  // Logger must not dump the raw Error object (stack / possible response text).
  assert.doesNotMatch(experimentSrc, /console\.error\([^)]*\berr\b\s*\)/);
});

test('chat forwards AbortSignal to the provider fetch', async () => {
  const ctrl = new AbortController();
  let sawSignal;
  const original = globalThis.fetch;
  const prevKey = process.env.ZAI_API_KEY;
  process.env.ZAI_API_KEY = 'unit-test-key';
  globalThis.fetch = async (_url, init = {}) => {
    sawSignal = init.signal;
    assert.equal(init.signal, ctrl.signal);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"slots":[]}' } }] })
    };
  };
  try {
    const text = await chat([{ role: 'user', content: 'hi' }], {
      model: 'glm-4.7-flash',
      signal: ctrl.signal
    });
    assert.equal(text, '{"slots":[]}');
    assert.equal(sawSignal, ctrl.signal);
  } finally {
    globalThis.fetch = original;
    if (prevKey === undefined) delete process.env.ZAI_API_KEY;
    else process.env.ZAI_API_KEY = prevKey;
  }
});

test('chat rejects when the AbortSignal is already aborted', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const prevKey = process.env.ZAI_API_KEY;
  process.env.ZAI_API_KEY = 'unit-test-key';
  try {
    // Real fetch short-circuits on an aborted signal (no network I/O).
    await assert.rejects(
      () => chat([{ role: 'user', content: 'hi' }], { model: 'glm-4.7-flash', signal: ctrl.signal }),
      (err) => err?.name === 'AbortError' || /abort/i.test(String(err?.message || err))
    );
  } finally {
    if (prevKey === undefined) delete process.env.ZAI_API_KEY;
    else process.env.ZAI_API_KEY = prevKey;
  }
});

test('redisCmd and storeExperiment forward AbortSignal to the storage fetch', async () => {
  const ctrl = new AbortController();
  let sawSignal;
  const original = globalThis.fetch;
  const envKeys = ['VERCEL_ENV', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'REDIS_KEY_PREFIX'];
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  process.env.VERCEL_ENV = 'production';
  process.env.KV_REST_API_URL = 'https://kv.test.invalid';
  process.env.KV_REST_API_TOKEN = 'kv-token-for-tests';
  delete process.env.REDIS_KEY_PREFIX;

  globalThis.fetch = async (_url, init = {}) => {
    sawSignal = init.signal;
    return { ok: true, json: async () => ({ result: 'OK' }) };
  };
  try {
    await redisCmd(['PING'], { signal: ctrl.signal });
    assert.equal(sawSignal, ctrl.signal);

    sawSignal = undefined;
    await storeExperiment({ at: 1, models: {} }, { signal: ctrl.signal });
    assert.equal(sawSignal, ctrl.signal);
  } finally {
    globalThis.fetch = original;
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
