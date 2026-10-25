// Anonymous callers must never spend LLM tokens. Every route that invokes the
// coach / z.ai chat path returns 401 without a credential (ht_ / HABIT_KEY /
// Clerk). Read-only coach surfaces that do not call the model stay out of this
// list (they return empty authRequired payloads instead).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import suggest from '../../api/suggest.js';
import nudge from '../../api/nudge.js';
import coachpage from '../../api/coachpage.js';
import experiment from '../../api/experiment.js';
import roster from '../../api/roster.js';
import question from '../../api/question.js';
import log from '../../api/log.js';
import morning from '../../api/cron/morning.js';
import daily from '../../api/cron/daily.js';
import token from '../../api/token.js';

const ENV_KEYS = [
  'HABIT_OWNER_USER_ID', 'HABIT_KEY', 'CRON_SECRET',
  'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY',
  'KV_REST_API_URL', 'KV_REST_API_TOKEN',
  'ZAI_API_KEY', 'HABIT_TOKEN_PEPPER'
];
const saved = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // Storage "configured" so handlers reach the auth gate (not a 503).
  process.env.KV_REST_API_URL = 'https://example-redis.test';
  process.env.KV_REST_API_TOKEN = 'token-long-enough';
  process.env.ZAI_API_KEY = 'zai-test-key-not-real';
  process.env.HABIT_OWNER_USER_ID = 'user_owner';
  process.env.HABIT_KEY = 'deploy-secret-placeholder';
  process.env.CRON_SECRET = 'cron-secret-placeholder';
  process.env.HABIT_TOKEN_PEPPER = 'unit-pepper';
  delete process.env.CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function mockRes() {
  const out = { statusCode: 200, body: null, plain: null };
  const res = {
    setHeader() { return this; },
    status(c) { out.statusCode = c; return this; },
    json(b) { out.body = b; return this; },
    send(t) { out.plain = t; return this; },
    end() { return this; },
    out
  };
  return res;
}

const anon = { method: 'GET', query: {}, headers: {}, body: {} };

const LLM_CASES = [
  {
    name: 'POST /api/suggest',
    handler: suggest,
    req: { ...anon, method: 'POST' }
  },
  {
    name: 'GET /api/suggest?run=1',
    handler: suggest,
    req: { method: 'GET', query: { run: '1' }, headers: {} }
  },
  {
    name: 'GET /api/nudge?run=1',
    handler: nudge,
    req: { method: 'GET', query: { run: '1' }, headers: {} }
  },
  {
    name: 'POST /api/nudge (force run)',
    handler: nudge,
    req: { method: 'POST', query: {}, headers: {} }
  },
  {
    name: 'GET /api/coachpage?run=1',
    handler: coachpage,
    req: { method: 'GET', query: { run: '1' }, headers: {} }
  },
  {
    name: 'GET /api/experiment?run=1',
    handler: experiment,
    req: { method: 'GET', query: { run: '1' }, headers: {} }
  },
  {
    name: 'GET /api/roster?run=1',
    handler: roster,
    req: { method: 'GET', query: { run: '1' }, headers: {} }
  },
  {
    name: 'GET /api/question?dismiss=1 (mutating; no anonymous spend path)',
    handler: question,
    req: { method: 'GET', query: { dismiss: '1', slot: '1' }, headers: {} }
  },
  {
    name: 'GET /api/log?habit=Test (triggers reactTo under auth)',
    handler: log,
    req: { method: 'GET', query: { habit: 'Test' }, headers: {} },
    plain: true
  },
  {
    name: 'GET /api/cron/morning',
    handler: morning,
    req: { method: 'GET', query: {}, headers: {} }
  },
  {
    name: 'GET /api/cron/daily',
    handler: daily,
    req: { method: 'GET', query: {}, headers: {} }
  }
];

for (const c of LLM_CASES) {
  test(`anonymous LLM route 401: ${c.name}`, async () => {
    const res = mockRes();
    await c.handler(c.req, res);
    assert.equal(res.out.statusCode, 401, c.name);
    if (c.plain) {
      assert.match(String(res.out.plain || ''), /Unauthorized/i);
    } else {
      assert.equal(res.out.body?.error, 'Unauthorized');
    }
  });
}

test('HABIT_KEY alone cannot manage /api/token (Clerk-only)', async () => {
  const res = mockRes();
  await token(
    {
      method: 'GET',
      query: {},
      headers: { 'x-habit-key': process.env.HABIT_KEY }
    },
    res
  );
  assert.equal(res.out.statusCode, 403);
  assert.match(String(res.out.body?.error || ''), /Sign in/i);
});

test('owner ht_ reaches cron morning without HABIT_KEY AND-gate', async () => {
  // Inject verify so we do not hit Redis for token lookup.
  const { resolveOwnerAuth } = await import('../../lib/auth.js');
  const HT = 'ht_' + 'ownerownerownerownerownerownerow';
  const gate = await resolveOwnerAuth(
    { method: 'POST', query: {}, headers: { 'x-habit-key': HT } },
    {
      verifyApiToken: async (t) => (t === HT ? 'user_owner' : null),
      verifySession: async () => null
    }
  );
  assert.deepEqual(gate, { ok: true, via: 'token', userId: 'user_owner' });
});

test('mind GET is read-only (no coach/LLM import) — anonymous gets empty payload, not a model call', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../api/mind.js'),
    'utf8'
  );
  assert.doesNotMatch(src, /from ['"]\.\.\/lib\/coach\.js['"]/);
  assert.doesNotMatch(src, /generateText|fullSuggest|nudgePass|chat\s*\(/);
  assert.match(src, /optionalAuth/);
});

test('frontend write gates accept HabitKey without Clerk', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const deck = readFileSync(join(root, 'public/deck.js'), 'utf8');
  assert.match(deck, /HabitKey\.get\(\)/);
  assert.match(deck, /HabitKey\.fetch\(url\)/);
  const habits = readFileSync(join(root, 'public/habits.js'), 'utf8');
  assert.match(habits, /HabitKey\.fetch\(url,\s*opts\)/);
  assert.match(habits, /hasKey/);
  const auth = readFileSync(join(root, 'public/auth.js'), 'utf8');
  assert.match(auth, /Clerk failed to load|Sign-in is unavailable/);
  assert.match(auth, /onReady/);
  const index = readFileSync(join(root, 'public/index.js'), 'utf8');
  assert.match(index, /await window\.HabitAuth\.init\(\)/);
  assert.match(index, /Revoke failed|Token revoked/);
});
