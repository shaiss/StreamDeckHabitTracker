// #112: every gated route fails closed in production when HABIT_KEY is unset
// (503, no Redis write, no model call), rejects a wrong key (401), accepts the
// right key in the x-habit-key header, and keeps the old open behavior outside
// production. Also: cron bearer path refuses with 503 when CRON_SECRET is
// unset in production, and the timing-safe compare handles length mismatch.
//
// Unit tests are zero-dependency (CI runs them without npm install), so the
// three framework packages the routes transitively import are replaced with
// inert stubs via a module resolve hook. All I/O goes through global fetch,
// which is stubbed: nothing here can reach prod, a preview, Redis, or a model.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import crypto from 'node:crypto';

const STUBS = {
  '@vercel/functions': 'export function waitUntil(p) { (globalThis.__waitUntil ||= []).push(Promise.resolve(p).catch(() => {})); }',
  ai: 'const call = () => { globalThis.__modelCalls = (globalThis.__modelCalls || 0) + 1; return Promise.reject(new Error("model call stubbed")); };' +
    'export const generateText = call; export const streamText = call; export const tool = (x) => x;' +
    'export const isStepCount = () => () => false; export const stepCountIs = () => () => false;',
  '@ai-sdk/openai-compatible': 'export const createOpenAICompatible = () => () => ({});',
  zod: 'const p = new Proxy(function () {}, { get: () => p, apply: () => p }); export const z = p; export default p;'
};
const hooks = `const STUBS = ${JSON.stringify(STUBS)};
export async function resolve(specifier, context, next) {
  if (Object.hasOwn(STUBS, specifier)) {
    return { url: 'data:text/javascript,' + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  }
  return next(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks), import.meta.url);

const { safeEqual, keyStatus, MISCONFIGURED, KEY_HEADER } = await import('../../lib/habit-key.js');

const KV = 'https://kv.test.invalid';
const SECRET = 'unit-' + 'test-' + 'secret-value';
const WRITE_CMDS = new Set(['SET', 'SETNX', 'RPUSH', 'LPUSH', 'LSET', 'LREM', 'LTRIM', 'DEL', 'HSET', 'HDEL',
  'INCR', 'INCRBY', 'EXPIRE', 'PEXPIRE', 'GETSET', 'SADD', 'SREM', 'ZADD', 'ZREM', 'MSET', 'APPEND']);

let calls;
const ENV_KEYS = ['VERCEL_ENV', 'HABIT_KEY', 'CRON_SECRET', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'ZAI_API_KEY',
  'REDIS_KEY_PREFIX', 'PREVIEW_REDIS_ISOLATED'];
let savedEnv, savedFetch;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.KV_REST_API_URL = KV;
  process.env.KV_REST_API_TOKEN = 'kv-token-for-tests';
  process.env.ZAI_API_KEY = 'zai-stub';
  calls = [];
  globalThis.__modelCalls = 0;
  globalThis.__waitUntil = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(KV)) {
      let args = [];
      try { args = JSON.parse(init.body || '[]'); } catch { /* not a command */ }
      calls.push({ kind: 'redis', cmd: String(args[0] || '').toUpperCase(), args });
      return new Response(JSON.stringify({ result: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    calls.push({ kind: 'external', url: u });
    return new Response('{"error":"stubbed"}', { status: 500 });
  };
});

afterEach(async () => {
  await Promise.all(globalThis.__waitUntil || []);
  globalThis.fetch = savedFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function mkRes() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
  res.getHeader = (k) => res.headers[k.toLowerCase()];
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.end = (b) => { if (b !== undefined) res.body = b; return res; };
  return res;
}
const msgOf = (res) => (res.body && typeof res.body === 'object' ? res.body.error : res.body);
const writes = () => calls.filter((c) => c.kind === 'redis' && WRITE_CMDS.has(c.cmd));
const external = () => calls.filter((c) => c.kind === 'external');

// Every gated write path. `req()` builds a fresh request each time.
const ROUTES = [
  { name: 'log tap', mod: 'api/log.js', req: () => ({ method: 'GET', query: { hkey: '1' } }) },
  { name: 'log undo', mod: 'api/log.js', req: () => ({ method: 'DELETE', query: { hkey: '1' } }) },
  { name: 'habits POST', mod: 'api/habits.js', req: () => ({ method: 'POST', query: {}, body: { habits: [{ name: 'Water', emoji: '💧', label: 'Water' }] } }) },
  { name: 'roster decide', mod: 'api/roster.js', req: () => ({ method: 'POST', query: {}, body: { id: 'p1', decision: 'accept' } }) },
  { name: 'roster run', mod: 'api/roster.js', req: () => ({ method: 'GET', query: { run: '1' } }) },
  { name: 'profile POST', mod: 'api/profile.js', req: () => ({ method: 'POST', query: {}, body: { name: 'Test' } }) },
  { name: 'suggest', mod: 'api/suggest.js', req: () => ({ method: 'POST', query: {} }) },
  { name: 'nudge dismiss', mod: 'api/nudge.js', req: () => ({ method: 'POST', query: { dismiss: '1', slot: '1' } }) },
  { name: 'nudge suppress', mod: 'api/nudge.js', req: () => ({ method: 'POST', query: { suppress: '1' } }) },
  { name: 'nudge takeover', mod: 'api/nudge.js', req: () => ({ method: 'POST', query: { takeover: '1' } }) },
  { name: 'nudge run', mod: 'api/nudge.js', req: () => ({ method: 'POST', query: {} }) },
  { name: 'question dismiss', mod: 'api/question.js', req: () => ({ method: 'POST', query: { dismiss: '1', slot: '1' } }) },
  { name: 'coachpage run', mod: 'api/coachpage.js', req: () => ({ method: 'POST', query: {} }) },
  { name: 'experiment run', mod: 'api/experiment.js', req: () => ({ method: 'GET', query: { run: '1' } }) },
  { name: 'cron morning ?run=1', mod: 'api/cron/morning.js', req: () => ({ method: 'GET', query: { run: '1' } }) },
  { name: 'cron daily ?run=1', mod: 'api/cron/daily.js', req: () => ({ method: 'GET', query: { run: '1' } }) }
];

async function call(route, extraHeaders = {}) {
  const { default: handler } = await import('../../' + route.mod);
  const r = route.req();
  const req = { headers: { ...extraHeaders }, ...r };
  const res = mkRes();
  await handler(req, res);
  await Promise.all(globalThis.__waitUntil || []);
  return res;
}

for (const route of ROUTES) {
  test(`${route.name}: production + no HABIT_KEY → 503, no write, no model call`, async () => {
    process.env.VERCEL_ENV = 'production';
    const res = await call(route, { [KEY_HEADER]: 'anything' });
    assert.equal(res.statusCode, 503);
    assert.equal(msgOf(res), MISCONFIGURED);
    assert.deepEqual(writes(), [], 'no Redis write');
    assert.deepEqual(external(), [], 'no external/model fetch');
    assert.equal(globalThis.__modelCalls, 0, 'no model call');
  });

  test(`${route.name}: production + empty HABIT_KEY → 503`, async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.HABIT_KEY = '   ';
    const res = await call(route);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(writes(), []);
    assert.equal(globalThis.__modelCalls, 0);
  });

  test(`${route.name}: wrong key → 401, no write, no model call`, async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.HABIT_KEY = SECRET;
    const res = await call(route, { [KEY_HEADER]: SECRET + 'x' });
    assert.equal(res.statusCode, 401);
    assert.equal(msgOf(res), 'Unauthorized');
    assert.deepEqual(writes(), []);
    assert.deepEqual(external(), []);
    assert.equal(globalThis.__modelCalls, 0);
  });

  test(`${route.name}: right key in the header passes the gate`, async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.HABIT_KEY = SECRET;
    const res = await call(route, { [KEY_HEADER]: SECRET });
    assert.notEqual(res.statusCode, 401);
    assert.notEqual(msgOf(res), MISCONFIGURED);
    assert.ok(![401, 503].includes(res.statusCode) || msgOf(res) !== 'Unauthorized');
    assert.ok(calls.length > 0, 'the route went on to do its work');
  });

  test(`${route.name}: non-production + no HABIT_KEY behaves as before (open)`, async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.REDIS_KEY_PREFIX = 'preview:';   // #106: preview Redis needs isolation
    const res = await call(route);
    assert.notEqual(res.statusCode, 401);
    assert.notEqual(msgOf(res), MISCONFIGURED);
    assert.ok(calls.length > 0, 'the route went on to do its work');
  });
}

// The deck heartbeat on /api/slots is a write on a read endpoint: in
// production with no key it is skipped (the read itself still answers).
test('slots heartbeat: production + no HABIT_KEY → no deck-state write', async () => {
  process.env.VERCEL_ENV = 'production';
  const { default: handler } = await import('../../api/slots.js');
  const res = mkRes();
  await handler({ method: 'GET', headers: {}, query: { deck: '2.6.0', keys: '3' } }, res);
  await Promise.all(globalThis.__waitUntil || []);
  const deckWrites = writes().filter((c) => c.cmd === 'SET' && String(c.args[1]).endsWith('habits:deck'));
  assert.deepEqual(deckWrites, []);
});

test('slots heartbeat: right key → deck-state write happens', async () => {
  process.env.VERCEL_ENV = 'production';
  process.env.HABIT_KEY = SECRET;
  const { default: handler } = await import('../../api/slots.js');
  const res = mkRes();
  await handler({ method: 'GET', headers: { [KEY_HEADER]: SECRET }, query: { deck: '2.6.0', keys: '3' } }, res);
  await Promise.all(globalThis.__waitUntil || []);
  assert.ok(writes().some((c) => c.cmd === 'SET' && String(c.args[1]).endsWith('habits:deck')));
});

// ---- cron bearer path -------------------------------------------------------
for (const mod of ['api/cron/morning.js', 'api/cron/daily.js']) {
  const plain = () => ({ method: 'GET', query: {} });
  test(`${mod}: production + no CRON_SECRET → bearer path 503, no work`, async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.HABIT_KEY = SECRET;
    const res = await call({ mod, req: plain }, { authorization: 'Bearer whatever' });
    assert.equal(res.statusCode, 503);
    assert.match(msgOf(res), /CRON_SECRET/);
    assert.deepEqual(calls, []);
    assert.equal(globalThis.__modelCalls, 0);
  });

  test(`${mod}: production + CRON_SECRET → wrong bearer 401, right bearer runs`, async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.CRON_SECRET = 'cron-' + 'test-value';
    let res = await call({ mod, req: plain }, { authorization: 'Bearer nope' });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(calls, []);
    res = await call({ mod, req: plain }, { authorization: 'Bearer ' + process.env.CRON_SECRET });
    assert.notEqual(res.statusCode, 401);
    assert.notEqual(res.statusCode, 503);
    assert.ok(calls.length > 0);
  });

  test(`${mod}: non-production + no CRON_SECRET → unauthenticated cron still runs (as before)`, async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.REDIS_KEY_PREFIX = 'preview:';
    const res = await call({ mod, req: plain });
    assert.notEqual(res.statusCode, 401);
    assert.notEqual(res.statusCode, 503);
  });
}

// ---- helper ------------------------------------------------------------------
test('safeEqual: equal, unequal, and length-mismatch inputs', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', 'a'), false);
  assert.equal(safeEqual('ü', 'u'), false);   // byte length differs from char length
});

test('safeEqual: a length mismatch still runs a same-length dummy compare, then rejects', () => {
  const seen = [];
  const spy = (a, b) => { seen.push([a.length, b.length]); return crypto.timingSafeEqual(a, b); };
  assert.equal(safeEqual('short', 'much-longer-secret', spy), false);
  assert.equal(seen.length, 1, 'exactly one compare ran');
  assert.equal(seen[0][0], seen[0][1], 'the dummy compare was on equal-length buffers');
  assert.equal(seen[0][0], Buffer.byteLength('much-longer-secret'), 'sized to the secret');
  seen.length = 0;
  assert.equal(safeEqual('same-len-a', 'same-len-b', spy), false);
  assert.deepEqual(seen, [[10, 10]]);
  seen.length = 0;
  assert.equal(safeEqual('match', 'match', spy), true);
  assert.deepEqual(seen, [[5, 5]]);
});

test('keyStatus: 503 only in production with no key; header beats nothing', () => {
  const req = (k) => ({ headers: k ? { [KEY_HEADER]: k } : {}, query: {} });
  assert.equal(keyStatus(req(), null, '', 'production'), 503);
  assert.equal(keyStatus(req(), null, undefined, 'production'), 503);
  assert.equal(keyStatus(req(), null, '', 'preview'), 200);
  assert.equal(keyStatus(req(), null, '', undefined), 200);
  assert.equal(keyStatus(req(SECRET), null, SECRET, 'production'), 200);
  assert.equal(keyStatus(req('x'), null, SECRET, 'production'), 401);
  assert.equal(keyStatus({ headers: {}, query: { key: SECRET } }, null, SECRET, 'production'), 200, '?key= still accepted (transition)');
});
