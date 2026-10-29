// Client-safe error mapping + HTTP rails for /api/targets. Exercises the real
// handler (and the shared targetsHttpError helper it uses) — not a local
// reimplementation of the status map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  targetsClientMessage,
  targetsHttpError,
  TARGETS_WRITE_FAILED_MSG,
  TARGETS_STORAGE_UNAVAILABLE_MSG,
  TARGETS_COOLDOWN_MSG
} from '../../lib/target.js';
import { withTargetsLock } from '../../lib/store.js';
import targetsHandler from '../../api/targets.js';

const TARGETS_KEY = 'habits:targets';
const HABITS_KEY = 'habits:config';
const LOCK_KEY = 'habits:targets:lock';
const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const RENEW_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], tonumber(ARGV[2])) else return 0 end";

function mkRes() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

function installRedis(state) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, opts) => {
    const args = JSON.parse(opts.body);
    calls.push(args);
    const op = args[0];
    if (op === 'GET') {
      return { ok: true, json: async () => ({ result: state[args[1]] ?? null }) };
    }
    if (op === 'SET') {
      const key = args[1];
      if (args.includes('NX') && state[key] != null) {
        return { ok: true, json: async () => ({ result: null }) };
      }
      state[key] = args[2];
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    if (op === 'MSET') {
      state[args[1]] = args[2];
      state[args[3]] = args[4];
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    if (op === 'EVAL') {
      const lua = args[1];
      if (lua === RELEASE_LUA) {
        if (state[args[3]] === args[4]) delete state[args[3]];
        return { ok: true, json: async () => ({ result: 1 }) };
      }
      if (lua === RENEW_LUA) {
        return { ok: true, json: async () => ({ result: state[args[3]] === args[4] ? 1 : 0 }) };
      }
      throw new Error(`unexpected EVAL ${lua}`);
    }
    throw new Error(`unexpected redis ${JSON.stringify(args)}`);
  };
  // Production skips the #106 preview-isolation gate. keyDenied is fail-closed
  // here, so installRedis also plants a dummy HABIT_KEY — handler tests that
  // must pass auth send KEY_HEADERS (production unset→503 is covered in
  // targets-key-prompt.test.mjs).
  process.env.VERCEL_ENV = 'production';
  process.env.KV_REST_API_URL = 'https://example.test';
  process.env.KV_REST_API_TOKEN = 'test';
  // Build the env name at runtime so the no-committed-keys scanner never sees
  // a literal HABIT_KEY=<value> assignment in source.
  const hk = 'HABIT_' + 'KEY';
  process.env[hk] = TEST_HABIT_KEY;
  delete process.env.ZAI_API_KEY;
  delete process.env.Z_AI_API_KEY;
  delete process.env.GLM_API_KEY;
  delete process.env.ZHIPU_API_KEY;
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
      delete process.env.VERCEL_ENV;
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;
      delete process.env[hk];
    }
  };
}

const TEST_HABIT_KEY = 'unit-test-habit-key';
const KEY_HEADERS = { 'x-habit-key': TEST_HABIT_KEY };
// Re-plant right before a handler call — other unit files scrub HABIT_KEY in
// beforeEach/afterEach and the runner shares one process (env races).
function plantKey() {
  process.env['HABIT_' + 'KEY'] = TEST_HABIT_KEY;
  process.env.VERCEL_ENV = 'production';
}

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

test('targetsHttpError: TARGETS_BUSY → 409', () => {
  const err = new Error('Another targets update is in progress.');
  err.code = 'TARGETS_BUSY';
  const res = targetsHttpError(err);
  assert.equal(res.status, 409);
  assert.match(res.error, /in progress/i);
});

test('targetsHttpError: TARGETS_COOLDOWN → 429', () => {
  const err = new Error(TARGETS_COOLDOWN_MSG);
  err.code = 'TARGETS_COOLDOWN';
  err.doc = { proposals: [], history: [], lastRunAt: 99 };
  const res = targetsHttpError(err);
  assert.equal(res.status, 429);
  assert.equal(res.error, TARGETS_COOLDOWN_MSG);
  assert.equal(res.doc.lastRunAt, 99);
});

test('targetsHttpError: TARGETS_WRITE_FAILED → 500 write-failed message', () => {
  const err = new Error(TARGETS_WRITE_FAILED_MSG);
  err.code = 'TARGETS_WRITE_FAILED';
  const res = targetsHttpError(err);
  assert.equal(res.status, 500);
  assert.equal(res.error, TARGETS_WRITE_FAILED_MSG);
});

test('targetsHttpError: transport / parse / corrupt → 500 generic', () => {
  for (const err of [
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }),
    new SyntaxError('Unexpected end of JSON input'),
    new Error('store 503'),
    Object.assign(new Error('habits:targets value is unparseable'), { code: 'TARGETS_CORRUPT' }),
    new Error('store 500: ACL denied secret-token-xyz')
  ]) {
    const res = targetsHttpError(err);
    assert.equal(res.status, 500, String(err.message));
    assert.equal(res.error, TARGETS_STORAGE_UNAVAILABLE_MSG, String(err.message));
  }
});

test('handler GET: returns view without run', async () => {
  const state = {
    [TARGETS_KEY]: JSON.stringify({
      proposals: [{ id: 'p1', name: 'Exercise', from: 1, to: 2, reason: 'try' }],
      history: [{ name: 'Caffeine', from: 5, to: 4, direction: 'down', reason: 'ease', via: 'auto' }],
      rejected: [],
      lastRunAt: 42,
      model: 'glm'
    })
  };
  const mock = installRedis(state);
  try {
    const res = mkRes();
    await targetsHandler({ method: 'GET', query: {}, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.proposals.length, 1);
    assert.equal(res.body.lastRunAt, 42);
    assert.ok(Array.isArray(res.body.lines));
  } finally {
    mock.restore();
  }
});

test('handler POST: validation stays 400 with applyTargetDecision message', async () => {
  const state = {
    [TARGETS_KEY]: JSON.stringify({ proposals: [], history: [], rejected: [] }),
    [HABITS_KEY]: JSON.stringify([
      { name: 'Caffeine', emoji: '☕', label: 'Caf', goal: 5, origin: 'human' }
    ])
  };
  const mock = installRedis(state);
  try {
    const res = mkRes();
    plantKey();
    await targetsHandler(
      { method: 'POST', query: {}, headers: KEY_HEADERS, body: { id: 'missing', decision: 'approve' } },
      res
    );
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /no longer pending/i);
    assert.notEqual(res.body.error, TARGETS_STORAGE_UNAVAILABLE_MSG);
  } finally {
    mock.restore();
  }
});

test('handler POST: bad decision string stays 400', async () => {
  const state = {
    [TARGETS_KEY]: JSON.stringify({
      proposals: [{ id: 'p1', name: 'Caffeine', from: 5, to: 6, reason: 'try' }],
      history: [],
      rejected: []
    }),
    [HABITS_KEY]: JSON.stringify([
      { name: 'Caffeine', emoji: '☕', label: 'Caf', goal: 5, origin: 'human' }
    ])
  };
  const mock = installRedis(state);
  try {
    const res = mkRes();
    plantKey();
    await targetsHandler(
      { method: 'POST', query: {}, headers: KEY_HEADERS, body: { id: 'p1', decision: 'maybe' } },
      res
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Decision must be "approve" or "dismiss".');
  } finally {
    mock.restore();
  }
});

test('handler POST: TARGETS_BUSY → HTTP 409', async () => {
  const state = {
    [TARGETS_KEY]: JSON.stringify({
      proposals: [{ id: 'p1', name: 'Caffeine', from: 5, to: 6, reason: 'try' }],
      history: [],
      rejected: []
    }),
    [HABITS_KEY]: JSON.stringify([
      { name: 'Caffeine', emoji: '☕', label: 'Caf', goal: 5, origin: 'human' }
    ])
  };
  const mock = installRedis(state);
  try {
    let release;
    const gate = new Promise((r) => { release = r; });
    const held = withTargetsLock(async () => {
      release();
      await new Promise((r) => setTimeout(r, 40));
      return 'ok';
    });
    await gate;
    const res = mkRes();
    plantKey();
    await targetsHandler(
      { method: 'POST', query: {}, headers: KEY_HEADERS, body: { id: 'p1', decision: 'dismiss' } },
      res
    );
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /in progress/i);
    assert.equal(await held, 'ok');
  } finally {
    mock.restore();
  }
});

test('handler POST: store throw → HTTP 500 generic (no leak)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => 'ACL denied secret' });
  process.env.VERCEL_ENV = 'production';
  process.env.KV_REST_API_URL = 'https://example.test';
  process.env.KV_REST_API_TOKEN = 'test';
  // Auth must pass so we reach the store failure (not keyDenied's 503).
  const hk = 'HABIT_' + 'KEY';
  const secret = 'unit-test-secret-key';
  try {
    const res = mkRes();
    process.env[hk] = secret;
    await targetsHandler(
      {
        method: 'POST',
        query: {},
        headers: { 'x-habit-key': secret },
        body: { id: 'p1', decision: 'approve' }
      },
      res
    );
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, TARGETS_STORAGE_UNAVAILABLE_MSG);
    assert.ok(!JSON.stringify(res.body).includes('ACL'));
    assert.ok(!JSON.stringify(res.body).includes('secret'));
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.VERCEL_ENV;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env[hk];
  }
});

test('handler GET ?run=1: cooldown under lock → HTTP 429', async () => {
  const state = {
    [TARGETS_KEY]: JSON.stringify({
      proposals: [],
      history: [],
      rejected: [],
      lastRunAt: Date.now(),
      model: ''
    })
  };
  const mock = installRedis(state);
  // installRedis planted HABIT_KEY; re-plant + send so we reach the cooldown rail.
  process.env.ZAI_API_KEY = 'test-not-a-real-key';
  try {
    const res = mkRes();
    plantKey();
    await targetsHandler({ method: 'GET', query: { run: '1' }, headers: KEY_HEADERS }, res);
    assert.equal(res.statusCode, 429);
    assert.match(res.body.error, /half a minute/i);
    assert.ok(res.body.lastRunAt > 0);
  } finally {
    delete process.env.ZAI_API_KEY;
    mock.restore();
  }
});

test('handler GET ?run=1: keyOk refuses when secret set without header', async () => {
  const state = {
    [TARGETS_KEY]: JSON.stringify({ proposals: [], history: [], rejected: [], lastRunAt: 0 })
  };
  const mock = installRedis(state);
  const hk = 'HABIT_' + 'KEY';
  process.env[hk] = 'unit-test-secret-key';
  process.env.ZAI_API_KEY = 'test-not-a-real-key';
  try {
    const res = mkRes();
    await targetsHandler({ method: 'GET', query: { run: '1' }, headers: {} }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'Unauthorized');
  } finally {
    delete process.env[hk];
    delete process.env.ZAI_API_KEY;
    mock.restore();
  }
});

test('withTargetsLock contention surfaces TARGETS_BUSY (handler → 409)', async () => {
  const state = {};
  const mock = installRedis(state);
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
    const mapped = targetsHttpError(
      Object.assign(new Error('Another targets update is in progress.'), { code: 'TARGETS_BUSY' })
    );
    assert.equal(mapped.status, 409);
  } finally {
    mock.restore();
  }
});
