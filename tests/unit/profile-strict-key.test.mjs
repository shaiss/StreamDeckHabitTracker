// /api/profile writes require HABIT_KEY: while HABIT_KEY is unset in
// production the route answers 503 and does no Redis work; a wrong or missing
// key answers 401; the right key proceeds. Reads stay open. All I/O goes through a stubbed fetch to a
// .invalid host, so nothing here can reach prod, a preview, or Redis.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { strictKeyStatus, requireKeyStrict, STRICT_MISCONFIGURED } from '../../lib/habit-key-strict.js';
import { KEY_HEADER } from '../../lib/habit-key.js';
import handler from '../../api/profile.js';

const SECRET = 'unit-' + 'placeholder-' + 'not-a-key';   // fixture only, not a real key
const WRONG = 'wrong-' + SECRET;
const KV = 'https://kv.test.invalid';
const WRITE_CMDS = new Set(['SET', 'SETNX', 'EVAL', 'DEL']);

const hdr = (v) => ({ headers: v === undefined ? {} : { [KEY_HEADER]: v }, query: {} });

// ---- helper ----------------------------------------------------------------
test('strictKeyStatus: unset or blank secret in production → 503', () => {
  assert.equal(strictKeyStatus(hdr(), null, undefined, 'production'), 503);
  assert.equal(strictKeyStatus(hdr(), null, '', 'production'), 503);
  assert.equal(strictKeyStatus(hdr(), null, '   ', 'production'), 503);
  // even a presented key cannot open a production deployment with no secret
  assert.equal(strictKeyStatus(hdr(SECRET), null, undefined, 'production'), 503);
});

test('strictKeyStatus: wrong or missing key → 401', () => {
  assert.equal(strictKeyStatus(hdr(WRONG), null, SECRET, 'production'), 401);
  assert.equal(strictKeyStatus(hdr(), null, SECRET, 'production'), 401);
  assert.equal(strictKeyStatus({}, null, SECRET, 'production'), 401);
  assert.equal(strictKeyStatus(hdr(SECRET.slice(0, -1)), null, SECRET, 'production'), 401);
});

test('strictKeyStatus: correct key (header, ?key=, body.key) → 200', () => {
  assert.equal(strictKeyStatus(hdr(SECRET), null, SECRET, 'production'), 200);
  assert.equal(strictKeyStatus({ headers: {}, query: { key: SECRET } }, null, SECRET, 'production'), 200);
  assert.equal(strictKeyStatus(hdr(), { key: SECRET }, SECRET, 'production'), 200);
});

test('strictKeyStatus: outside production an unset key stays open', () => {
  assert.equal(strictKeyStatus(hdr(), null, undefined, undefined), 200);
  assert.equal(strictKeyStatus(hdr(), null, undefined, 'preview'), 200);
  assert.equal(strictKeyStatus(hdr(), null, undefined, 'development'), 200);
  // …but a set key is enforced everywhere
  assert.equal(strictKeyStatus(hdr(WRONG), null, SECRET, 'preview'), 401);
});

// ---- handler ---------------------------------------------------------------
const ENV_KEYS = ['VERCEL_ENV', 'HABIT_KEY', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'REDIS_KEY_PREFIX',
  'PREVIEW_REDIS_PREFIX', 'PREVIEW_REDIS_ISOLATED'];
let calls, savedEnv, savedFetch;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.KV_REST_API_URL = KV;
  process.env.KV_REST_API_TOKEN = 'kv-token-for-tests';
  calls = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    let args = [];
    try { args = JSON.parse(init.body || '[]'); } catch { /* not a command */ }
    calls.push({ url: String(url), cmd: String(args[0] || '').toUpperCase() });
    return new Response(JSON.stringify({ result: args[0] === 'GET' ? null : 'OK' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function mkRes() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { res.body = b; return res; };
  return res;
}
const writes = () => calls.filter((c) => WRITE_CMDS.has(c.cmd));
const redisCalls = () => calls.filter((c) => c.url.startsWith(KV));

// Autonomy-style write: coachNav change with navSeq.
const post = (key) => ({
  method: 'POST', query: {}, headers: key === undefined ? {} : { [KEY_HEADER]: key },
  body: { coachNav: 'nudge-only', navSeq: 1 }
});

test('profile write, HABIT_KEY unset in production → 503, no Redis work', async () => {
  process.env.VERCEL_ENV = 'production';
  for (const req of [post(), post(SECRET), { method: 'GET', query: { set: '1', name: 'x' }, headers: {} }]) {
    const res = mkRes();
    await handler(req, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, STRICT_MISCONFIGURED);
  }
  assert.equal(redisCalls().length, 0);
});

test('profile write, wrong or missing key → 401, no Redis work', async () => {
  process.env.VERCEL_ENV = 'production';
  process.env.HABIT_KEY = SECRET;
  for (const req of [post(), post(WRONG), { method: 'GET', query: { set: '1', name: 'x', key: WRONG }, headers: {} }]) {
    const res = mkRes();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'Unauthorized');
  }
  assert.equal(redisCalls().length, 0);
});

test('profile write, correct key → allowed and reaches storage', async () => {
  process.env.VERCEL_ENV = 'production';
  process.env.HABIT_KEY = SECRET;
  const res = mkRes();
  await handler(post(SECRET), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.coachNav, 'nudge-only');
  assert.ok(writes().length >= 1, 'a keyed write must reach the store');
});

test('profile read stays open in production, key unset or set (no write, no key needed)', async () => {
  process.env.VERCEL_ENV = 'production';
  for (const configured of [false, true]) {
    if (configured) process.env.HABIT_KEY = SECRET; else delete process.env.HABIT_KEY;
    calls = [];
    const res = mkRes();
    await handler({ method: 'GET', query: {}, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(writes().length, 0);
  }
});

test('requireKeyStrict writes the 503/401 JSON itself and reports whether to stop', () => {
  process.env.VERCEL_ENV = 'production';
  const res = mkRes();
  assert.equal(requireKeyStrict(hdr(), res, null), true);
  assert.equal(res.statusCode, 503);
  process.env.HABIT_KEY = SECRET;
  const res2 = mkRes();
  assert.equal(requireKeyStrict(hdr(WRONG), res2, null), true);
  assert.equal(res2.statusCode, 401);
  const res3 = mkRes();
  assert.equal(requireKeyStrict(hdr(SECRET), res3, null), false);
  assert.equal(res3.statusCode, 200);
});
