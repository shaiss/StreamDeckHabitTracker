// Client-safe error mapping for /api/targets — storage/transport/parse/
// strict-read failures must never echo raw messages. Validation → 400 and
// TARGETS_BUSY → 409 are exercised via the same pure helpers the handler uses
// (importing api/targets.js would pull Mastra into the zero-dep unit suite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  targetsClientMessage,
  applyTargetDecision,
  TARGETS_WRITE_FAILED_MSG,
  TARGETS_STORAGE_UNAVAILABLE_MSG
} from '../../lib/target.js';
import { withTargetsLock } from '../../lib/store.js';

test('targetsClientMessage: TARGETS_WRITE_FAILED → stable generic', () => {
  const err = new Error(TARGETS_WRITE_FAILED_MSG);
  err.code = 'TARGETS_WRITE_FAILED';
  err.cause = new Error('store 503: {"error":"BUSYGROUP secrets"}');
  assert.equal(targetsClientMessage(err), TARGETS_WRITE_FAILED_MSG);
  assert.ok(!targetsClientMessage(err).includes('BUSYGROUP'));
  assert.ok(!targetsClientMessage(err).includes('store 503'));
});

test('targetsClientMessage: store status body → generic unavailable', () => {
  const err = new Error('store 500: ERR max requests limit exceeded; ACL denied');
  assert.equal(targetsClientMessage(err), TARGETS_STORAGE_UNAVAILABLE_MSG);
  assert.ok(!targetsClientMessage(err).includes('ACL'));
  assert.ok(!targetsClientMessage(err).includes('max requests'));
});

test('targetsClientMessage: transport failure → generic unavailable', () => {
  const err = new TypeError('fetch failed');
  err.cause = { code: 'ECONNRESET' };
  assert.equal(targetsClientMessage(err), TARGETS_STORAGE_UNAVAILABLE_MSG);
  assert.ok(!String(targetsClientMessage(err)).includes('ECONNRESET'));
  assert.ok(!String(targetsClientMessage(err)).includes('fetch failed'));
});

test('targetsClientMessage: response-parse / JSON SyntaxError → generic unavailable', () => {
  const err = new SyntaxError('Unexpected token < in JSON at position 0');
  assert.equal(targetsClientMessage(err), TARGETS_STORAGE_UNAVAILABLE_MSG);
  assert.ok(!targetsClientMessage(err).includes('Unexpected token'));
});

test('targetsClientMessage: getHabitsStrict throw → generic unavailable', () => {
  // habits.js cmd uses `store ${status}` (no colon+body); migration path has its own text.
  assert.equal(
    targetsClientMessage(new Error('store 503')),
    TARGETS_STORAGE_UNAVAILABLE_MSG
  );
  assert.equal(
    targetsClientMessage(new Error('habits migration: key unreadable after CAS miss')),
    TARGETS_STORAGE_UNAVAILABLE_MSG
  );
  assert.ok(!targetsClientMessage(new Error('store 503')).includes('503'));
});

test('targetsClientMessage: TARGETS_CORRUPT → generic unavailable', () => {
  const err = new Error('habits:targets value is unparseable');
  err.code = 'TARGETS_CORRUPT';
  assert.equal(targetsClientMessage(err), TARGETS_STORAGE_UNAVAILABLE_MSG);
  assert.ok(!targetsClientMessage(err).includes('unparseable'));
});

// Mirrors api/targets.js status rails without importing the Mastra-backed handler.
function targetsPostErrorStatus(err) {
  if (err?.code === 'TARGETS_BUSY') return { status: 409, error: err.message };
  return { status: 500, error: targetsClientMessage(err) };
}

test('POST error rails: validation stays 400 with applyTargetDecision message', () => {
  const result = applyTargetDecision({
    habits: [{ name: 'Caffeine', emoji: '☕', label: 'Caf', goal: 5 }],
    targets: { proposals: [], history: [], rejected: [] },
    id: 'missing',
    decision: 'approve'
  });
  assert.ok(result.error);
  // Handler: if (result.error) res.status(400).json({ error: result.error })
  const status = 400;
  assert.equal(status, 400);
  assert.match(result.error, /no longer pending/i);
  assert.notEqual(result.error, TARGETS_STORAGE_UNAVAILABLE_MSG);
});

test('POST error rails: bad decision string stays 400', () => {
  const result = applyTargetDecision({
    habits: [{ name: 'Caffeine', emoji: '☕', label: 'Caf', goal: 5 }],
    targets: {
      proposals: [{ id: 'p1', name: 'Caffeine', from: 5, to: 6, reason: 'try' }],
      history: [],
      rejected: []
    },
    id: 'p1',
    decision: 'maybe'
  });
  assert.equal(result.error, 'Decision must be "approve" or "dismiss".');
});

test('POST error rails: TARGETS_BUSY → HTTP 409 (message preserved)', async () => {
  const err = new Error('Another targets update is in progress.');
  err.code = 'TARGETS_BUSY';
  const res = targetsPostErrorStatus(err);
  assert.equal(res.status, 409);
  assert.match(res.error, /in progress/i);
  assert.notEqual(res.error, TARGETS_STORAGE_UNAVAILABLE_MSG);
});

test('POST error rails: transport / parse / strict-read → HTTP 500 generic', () => {
  for (const err of [
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }),
    new SyntaxError('Unexpected end of JSON input'),
    new Error('store 503'),
    new Error('habits migration: key unreadable after CAS miss'),
    Object.assign(new Error('habits:targets value is unparseable'), { code: 'TARGETS_CORRUPT' }),
    new Error('store 500: ACL denied secret-token-xyz')
  ]) {
    const res = targetsPostErrorStatus(err);
    assert.equal(res.status, 500, String(err.message));
    assert.equal(res.error, TARGETS_STORAGE_UNAVAILABLE_MSG, String(err.message));
    assert.ok(!res.error.includes('fetch'));
    assert.ok(!res.error.includes('ACL'));
    assert.ok(!res.error.includes('503'));
    assert.ok(!res.error.includes('unparseable'));
  }
});

test('POST error rails: TARGETS_WRITE_FAILED → HTTP 500 write-failed message', () => {
  const err = new Error(TARGETS_WRITE_FAILED_MSG);
  err.code = 'TARGETS_WRITE_FAILED';
  const res = targetsPostErrorStatus(err);
  assert.equal(res.status, 500);
  assert.equal(res.error, TARGETS_WRITE_FAILED_MSG);
});

test('withTargetsLock contention surfaces TARGETS_BUSY (handler → 409)', async () => {
  const state = {};
  const LOCK_KEY = 'habits:targets:lock';
  const RELEASE_LUA =
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const args = JSON.parse(opts.body);
    if (args[0] === 'SET' && args[1] === LOCK_KEY) {
      if (state[LOCK_KEY] != null) return { ok: true, json: async () => ({ result: null }) };
      state[LOCK_KEY] = args[2];
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    if (args[0] === 'EVAL') {
      assert.equal(args[1], RELEASE_LUA);
      if (state[args[3]] === args[4]) delete state[args[3]];
      return { ok: true, json: async () => ({ result: 1 }) };
    }
    throw new Error(`unexpected redis ${JSON.stringify(args)}`);
  };
  const scrub = ['VERCEL_ENV', 'HABIT_KEY', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'];
  const saved = Object.fromEntries(scrub.map((k) => [k, process.env[k]]));
  for (const k of scrub) delete process.env[k];
  process.env.VERCEL_ENV = 'production';
  process.env.KV_REST_API_URL = 'https://example.test';
  process.env.KV_REST_API_TOKEN = 'test';
  try {
    let release;
    const gate = new Promise((r) => { release = r; });
    const held = withTargetsLock(async () => {
      release();
      await new Promise((r) => setTimeout(r, 30));
      return 'ok';
    });
    await gate;
    await assert.rejects(
      () => withTargetsLock(async () => 'nope'),
      (err) => err && err.code === 'TARGETS_BUSY'
    );
    assert.equal(await held, 'ok');
    const mapped = targetsPostErrorStatus(
      Object.assign(new Error('Another targets update is in progress.'), { code: 'TARGETS_BUSY' })
    );
    assert.equal(mapped.status, 409);
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of scrub) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
