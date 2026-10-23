// #111 targets/roster decide key prompt + route wiring against #112's
// fail-closed helper (lib/habit-key.js is copied verbatim from that PR —
// its own habit-key.test.mjs / fail-closed.test.mjs own the helper itself).
//
// Focus: api/targets|roster|habits use keyDenied; habits.html keeps the key
// in memory only and treats 503 as misconfiguration (no re-prompt) while
// 401 clears + re-prompts once; targets decide returns 503 in production
// with HABIT_KEY unset and does no write.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';
import { KEY_HEADER, MISCONFIGURED, keyDenied, keyStatus } from '../../lib/habit-key.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const DUMMY = 'test-habit-key-111-dummy';

const ENV_KEYS = ['HABIT_KEY', 'VERCEL_ENV', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'ZAI_API_KEY'];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

test('api/targets, roster, habits gate writes through keyDenied (body where accepted)', () => {
  for (const f of ['api/targets.js', 'api/roster.js', 'api/habits.js']) {
    const src = read(f);
    assert.match(src, /from '\.\.\/lib\/habit-key\.js'/);
    assert.match(src, /keyDenied\(req/);
    assert.doesNotMatch(src, /\bkeyOk\b/, f + ' must not call keyOk directly');
    assert.doesNotMatch(src, /status\(401\)\.json\(\{\s*error:\s*'Unauthorized'/);
  }
  assert.match(read('api/habits.js'), /keyDenied\(req, res, body\)/);
  assert.match(read('api/roster.js'), /keyDenied\(req, res, body\)/);
  assert.match(read('api/targets.js'), /keyDenied\(req, res, body\)/);
});

test('habits.html: in-memory key only; 401 re-prompts; 503 shows misconfig (no storage)', () => {
  const src = read('public/habits.html');
  assert.match(src, /pageHabitKey/);
  assert.match(src, /x-habit-key/);
  assert.match(src, /promptHabitKey/);
  // Never persist the key (a comment may name the forbidden stores).
  assert.doesNotMatch(src, /sessionStorage\.(get|set|remove)Item|sessionStorage\[/);
  assert.doesNotMatch(src, /localStorage\.(get|set|remove)Item|localStorage\[/);
  assert.doesNotMatch(src, /document\.cookie\s*=/);
  // 401 clears + re-prompts; 503 does not re-prompt.
  assert.match(src, /res\.status === 401/);
  assert.match(src, /res\.status === 503/);
  assert.match(src, /Server misconfigured/);
  const idx503 = src.indexOf('res.status === 503');
  const idx401 = src.indexOf('res.status === 401');
  assert.ok(idx503 > 0 && idx401 > idx503, '503 handled before 401 re-prompt');
  const after503 = src.slice(idx503, idx401);
  assert.doesNotMatch(after503, /promptHabitKey/);
});

test('keyDenied: production + unset HABIT_KEY → 503 body; no proceed', () => {
  process.env.VERCEL_ENV = 'production';
  delete process.env.HABIT_KEY;
  assert.equal(keyStatus({ headers: {}, query: {} }, null), 503);
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
  assert.equal(keyDenied({ headers: {}, query: {} }, res), true);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, MISCONFIGURED);
});

test('keyDenied: wrong key → 401; correct header → proceed', () => {
  process.env.VERCEL_ENV = 'production';
  process.env.HABIT_KEY = DUMMY;
  const bad = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
  assert.equal(keyDenied({ headers: { [KEY_HEADER]: 'wrong-key-not-secret' }, query: {} }, bad), true);
  assert.equal(bad.statusCode, 401);
  const ok = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
  assert.equal(keyDenied({ headers: { [KEY_HEADER]: DUMMY }, query: {} }, ok), false);
  assert.equal(ok.statusCode, 200);
});

// Invoke the real targets decide handler (AI SDK stubs) so a production
// misconfig answers 503 before any Redis write.
const STUBS = {
  '@vercel/functions': 'export function waitUntil(p) { Promise.resolve(p).catch(() => {}); }',
  ai: 'export const generateText = () => Promise.reject(new Error("model stubbed"));' +
    'export const tool = (x) => x; export const stepCountIs = () => () => false;',
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

test('targets decide POST: production + HABIT_KEY unset → 503, no write', async () => {
  process.env.VERCEL_ENV = 'production';
  delete process.env.HABIT_KEY;
  process.env.KV_REST_API_URL = 'https://kv.test.invalid';
  process.env.KV_REST_API_TOKEN = 'kv-token-for-tests';
  process.env.ZAI_API_KEY = 'zai-stub';

  const writes = [];
  const WRITE = new Set(['SET', 'SETNX', 'RPUSH', 'LPUSH', 'DEL', 'HSET', 'MSET', 'GETSET']);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://kv.test.invalid')) {
      let args = [];
      try { args = JSON.parse(init.body || '[]'); } catch { /* ignore */ }
      const cmd = String(args[0] || '').toUpperCase();
      if (WRITE.has(cmd)) writes.push(cmd);
      return new Response(JSON.stringify({ result: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('{"error":"stubbed"}', { status: 500 });
  };

  try {
    const { default: handler } = await import('../../api/targets.js');
    const res = {
      statusCode: 200,
      body: null,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; return this; },
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; }
    };
    await handler(
      {
        method: 'POST',
        headers: {},
        query: {},
        body: { id: 'p1', decision: 'approve' }
      },
      res
    );
    assert.equal(res.statusCode, 503);
    assert.equal(res.body?.error, MISCONFIGURED);
    assert.deepEqual(writes, [], 'no Redis write on misconfigured production');
  } finally {
    globalThis.fetch = savedFetch;
  }
});
