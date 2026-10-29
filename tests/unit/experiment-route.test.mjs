// Route-level coverage for api/experiment.js (#122 / PR #132 security follow-up).
// Mocks Redis-over-REST and the z.ai chat provider via global fetch — no real
// network, no secrets. Kills route-wiring mutants that the pure guard/unit
// suites miss: claim skipped, finish skipped, cooldown stamped on failure,
// parseExperimentModels bypassed.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { KEY_HEADER } from '../../lib/habit-key.js';

const KV = 'https://kv.test.invalid';
const ZAI_CHAT = 'https://api.z.ai/api/paas/v4/chat/completions';
// Placeholder name required by tools/lib-secret-scan.mjs (HABIT_KEY=SECRET is allowlisted).
const SECRET = 'unit-' + 'test-' + 'habit-key';
const ZAI_STUB = 'zai-' + 'stub-' + 'key';

const ENV_KEYS = [
  'VERCEL_ENV',
  'HABIT_KEY',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'ZAI_API_KEY',
  'ZAI_BASE_URL',
  'ZAI_MODEL',
  'REDIS_KEY_PREFIX',
  'PREVIEW_REDIS_ISOLATED'
];

let savedEnv;
let savedFetch;
let redis;
let providerCalls;
let providerMode; // 'ok' | 'abort'

/** Minimal Redis-over-REST stand-in (SET NX EX / GET / DEL / LRANGE). */
function memoryRedis() {
  const store = new Map(); // key -> { kind:'string'|'list', value, expAt }
  const api = {
    _now: Date.now(),
    store,
    seedDataset(items) {
      store.set('habits:dataset', {
        kind: 'list',
        value: items.map((it) => JSON.stringify(it)),
        expAt: Infinity
      });
    },
    holdLock(startedAt = api._now) {
      store.set('habits:experiment:lock', {
        kind: 'string',
        value: String(startedAt),
        expAt: api._now + 90_000
      });
    },
    lockHeld() {
      return store.has('habits:experiment:lock');
    },
    cooldownStamped() {
      const cur = store.get('habits:experiment:cooldown');
      return Boolean(cur && cur.kind === 'string' && cur.value);
    },
    async apply(args) {
      const op = String(args[0] || '').toUpperCase();
      const key = args[1];
      const purge = (k) => {
        const cur = store.get(k);
        if (cur && cur.expAt <= api._now) store.delete(k);
      };
      if (op === 'SET') {
        purge(key);
        const flags = args.slice(3).map(String);
        const nx = flags.includes('NX');
        let exSec = null;
        const exIdx = flags.indexOf('EX');
        if (exIdx >= 0) exSec = Number(flags[exIdx + 1]);
        if (nx && store.has(key)) return null;
        store.set(key, {
          kind: 'string',
          value: String(args[2]),
          expAt: exSec != null ? api._now + exSec * 1000 : Infinity
        });
        return 'OK';
      }
      if (op === 'GET') {
        purge(key);
        const cur = store.get(key);
        if (!cur || cur.kind !== 'string') return null;
        return cur.value;
      }
      if (op === 'DEL') {
        const had = store.delete(key);
        return had ? 1 : 0;
      }
      if (op === 'LRANGE') {
        purge(key);
        const cur = store.get(key);
        if (!cur || cur.kind !== 'list') return [];
        const list = cur.value;
        let start = Number(args[2]);
        let stop = Number(args[3]);
        if (start < 0) start = Math.max(0, list.length + start);
        if (stop < 0) stop = list.length + stop;
        return list.slice(start, stop + 1);
      }
      throw new Error('unsupported redis op ' + op);
    }
  };
  return api;
}

function sampleDatasetItem() {
  return {
    at: 1_700_000_000_000,
    input: { kind: 'suggest', context: { note: 'route-test' } },
    output: { rawSlots: [{ habit: 'Water', emoji: '💧', label: 'Water' }] },
    metadata: { quality: { composite: 0.5, jsonValid: 1, specificity: 0.4 } }
  };
}

function mkRes() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.setHeader = (k, v) => {
    res.headers[k.toLowerCase()] = v;
    return res;
  };
  res.getHeader = (k) => res.headers[k.toLowerCase()];
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  res.send = (b) => {
    res.body = b;
    return res;
  };
  res.end = (b) => {
    if (b !== undefined) res.body = b;
    return res;
  };
  return res;
}

async function callExperiment(query = {}) {
  const { default: handler } = await import('../../api/experiment.js');
  const req = {
    method: 'GET',
    headers: { [KEY_HEADER]: SECRET },
    query: { run: '1', ...query }
  };
  const res = mkRes();
  await handler(req, res);
  return res;
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.VERCEL_ENV = 'production';
  process.env.HABIT_KEY = SECRET;
  process.env.KV_REST_API_URL = KV;
  process.env.KV_REST_API_TOKEN = 'kv-token-for-tests';
  process.env.ZAI_API_KEY = ZAI_STUB;

  redis = memoryRedis();
  redis.seedDataset([sampleDatasetItem()]);
  providerCalls = 0;
  providerMode = 'ok';
  savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(KV)) {
      let args = [];
      try {
        args = JSON.parse(init.body || '[]');
      } catch {
        /* ignore */
      }
      const result = await redis.apply(args);
      return new Response(JSON.stringify({ result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (u === ZAI_CHAT || u.includes('/chat/completions')) {
      providerCalls += 1;
      if (providerMode === 'abort') {
        const err = new Error('provider aborted');
        err.name = 'AbortError';
        throw err;
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"slots":[{"habit":"Water","emoji":"💧","label":"H2O","reason":"test"}]}' } }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    throw new Error('unexpected fetch: ' + u);
  };
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

test('experiment route: unknown model → 400 and 0 provider calls', async () => {
  const res = await callExperiment({ models: 'evil-model-not-allowed' });
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body?.error || ''), /Unknown model/);
  assert.equal(providerCalls, 0, 'provider must not be called for a rejected model');
  assert.equal(redis.lockHeld(), false, 'must not claim the lock after a 400');
});

test("experiment route: rejects 'GLM-5.2' (wrong case) with 400 and 0 provider calls", async () => {
  const res = await callExperiment({ models: 'GLM-5.2' });
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body?.error || ''), /Unknown model/);
  assert.match(String(res.body?.error || ''), /GLM-5\.2/);
  assert.equal(providerCalls, 0);
});

test("experiment route: rejects 'glm-5.2x' with 400 and 0 provider calls", async () => {
  const res = await callExperiment({ models: 'glm-5.2x' });
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body?.error || ''), /Unknown model/);
  assert.match(String(res.body?.error || ''), /glm-5\.2x/);
  assert.equal(providerCalls, 0);
});

test('experiment route: lock already held → 429 and 0 provider calls', async () => {
  redis.holdLock();
  const res = await callExperiment({ models: 'glm-4.7-flash' });
  assert.equal(res.statusCode, 429);
  assert.match(String(res.body?.error || ''), /try again/i);
  assert.ok(Number(res.body?.retryAfter) >= 1);
  assert.ok(res.headers['retry-after']);
  assert.equal(providerCalls, 0, 'must not call the provider when the lock is held');
});

test('experiment route: chat AbortError → lock released and cooldown NOT stamped', async () => {
  providerMode = 'abort';
  const res = await callExperiment({ models: 'glm-4.7-flash', n: '1' });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body?.error, 'Experiment failed.');
  assert.ok(providerCalls >= 1, 'provider was invoked');
  assert.equal(redis.lockHeld(), false, 'finishExperimentRun must DEL the lock on failure');
  assert.equal(
    redis.cooldownStamped(),
    false,
    'cooldown must not be stamped when the run fails (succeeded stays false)'
  );
});

test('experiment route: cooldown SET failure → 500, lock kept, no silent success', async () => {
  const origApply = redis.apply.bind(redis);
  redis.apply = async (args) => {
    const op = String(args[0] || '').toUpperCase();
    const key = String(args[1] || '');
    // Only the cooldown stamp (not lock NX or experiment:latest).
    if (op === 'SET' && key.includes('experiment:cooldown')) {
      throw new Error('cooldown SET boom');
    }
    return origApply(args);
  };
  const res = await callExperiment({ models: 'glm-4.7-flash', n: '1' });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body?.error, 'Experiment failed.');
  assert.ok(providerCalls >= 1, 'run completed before cooldown stamp');
  assert.equal(redis.cooldownStamped(), false, 'cooldown must not land');
  assert.equal(redis.lockHeld(), true, 'lock retained until TTL when stamp fails');
});
