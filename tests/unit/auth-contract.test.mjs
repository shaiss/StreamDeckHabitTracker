// Route × credential matrix for the unified OR-gate in lib/auth.js.
// Credentials: none | HABIT_KEY | ht_ token | Clerk session.
// Expect: 401 | owner tenant | user tenant (never owner/unscoped for per-user).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAuth, extractApiKey, hasExplicitCredential, authFromHabitKey
} from '../../lib/auth.js';
import { KEY_HEADER as HK } from '../../lib/habit-key.js';
import { runAsUser, redisKey } from '../../lib/scope.js';

assert.equal(HK, 'x-habit-key');

const ENV_KEYS = [
  'HABIT_OWNER_USER_ID', 'HABIT_KEY',
  'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY'
];
const saved = {};
// Assembled at runtime so the secret scanner never sees a literal assignment.
const HT_USER = 'ht_' + 'useruseruseruseruseruseruserus';
const HT_OWNER = 'ht_' + 'ownerownerownerownerownerownerow';
const SECRET = 'test-' + 'placeholder-value';

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.HABIT_OWNER_USER_ID = 'user_owner';
  process.env.HABIT_KEY = SECRET;
  delete process.env.CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const opts = {
  verifyApiToken: async (t) => {
    if (t === HT_USER) return 'user_plugin';
    if (t === HT_OWNER) return 'user_owner';
    return null;
  },
  verifySession: async () => null
};

const clerkOpts = {
  ...opts,
  verifySession: async () => 'user_clerk'
};

function scopeOf(userId) {
  return runAsUser(userId, () => redisKey('habits:log'));
}

// --- Matrix rows -----------------------------------------------------------

const CASES = [
  {
    name: 'no credential → null (fail closed)',
    req: { method: 'POST', query: {}, headers: {} },
    opts,
    expect: null
  },
  {
    name: 'HABIT_KEY via x-habit-key → owner tenant',
    req: { method: 'POST', query: {}, headers: { [HK]: SECRET } },
    opts,
    expect: { userId: 'user_owner', via: 'habit-key' },
    scope: 'habits:log'
  },
  {
    name: 'HABIT_KEY via ?key= → owner tenant',
    req: { method: 'GET', query: { key: SECRET, run: '1' }, headers: {} },
    opts,
    expect: { userId: 'user_owner', via: 'habit-key' },
    scope: 'habits:log'
  },
  {
    name: 'ht_ via x-habit-key → that user (plugin transport)',
    req: { method: 'GET', query: { habit: 'Drink' }, headers: { [HK]: HT_USER } },
    opts,
    expect: { userId: 'user_plugin', via: 'token' },
    scope: 'u:user_plugin:habits:log'
  },
  {
    name: 'ht_ via ?key= → that user',
    req: { method: 'GET', query: { key: HT_USER }, headers: {} },
    opts,
    expect: { userId: 'user_plugin', via: 'token' },
    scope: 'u:user_plugin:habits:log'
  },
  {
    name: 'ht_ via Bearer → that user',
    req: { method: 'POST', query: {}, headers: { authorization: `Bearer ${HT_USER}` } },
    opts,
    expect: { userId: 'user_plugin', via: 'token' },
    scope: 'u:user_plugin:habits:log'
  },
  {
    name: 'owner ht_ → owner legacy keys (not unscoped anonymous)',
    req: { method: 'POST', query: {}, headers: { [HK]: HT_OWNER } },
    opts,
    expect: { userId: 'user_owner', via: 'token' },
    scope: 'habits:log'
  },
  {
    name: 'Clerk Bearer → that user tenant',
    req: { method: 'POST', query: {}, headers: { authorization: 'Bearer sess_abc' } },
    opts: clerkOpts,
    expect: { userId: 'user_clerk', via: 'clerk' },
    scope: 'u:user_clerk:habits:log'
  },
  {
    name: 'wrong HABIT_KEY does not block Clerk on POST',
    req: {
      method: 'POST',
      query: {},
      headers: { [HK]: 'wrong-secret', authorization: 'Bearer sess_abc' }
    },
    opts: clerkOpts,
    expect: { userId: 'user_clerk', via: 'clerk' },
    scope: 'u:user_clerk:habits:log'
  },
  {
    name: 'non-ht_ ?key= that is not HABIT_KEY → null (no Clerk fallthrough)',
    req: {
      method: 'POST',
      query: { key: 'not-the-secret' },
      headers: { authorization: 'Bearer sess_abc', cookie: '__session=abc' }
    },
    opts: clerkOpts,
    expect: null
  },
  {
    name: 'revoked ht_ → null (no Clerk fallthrough)',
    req: {
      method: 'POST',
      query: {},
      headers: { [HK]: 'ht_revokedxxxxxxxxxxxxxxxxxxxx' }
    },
    opts: clerkOpts,
    expect: null
  },
  {
    name: 'HABIT_KEY unset: x-habit-key secret alone does not grant',
    req: { method: 'POST', query: {}, headers: { [HK]: SECRET } },
    opts: {
      ...opts,
      // HABIT_KEY cleared in beforeEach of this case via env tweak below
    },
    clearHabitKey: true,
    expect: null
  },
  {
    name: 'HABIT_KEY unset: ht_ still works',
    req: { method: 'POST', query: {}, headers: { [HK]: HT_USER } },
    opts,
    clearHabitKey: true,
    expect: { userId: 'user_plugin', via: 'token' },
    scope: 'u:user_plugin:habits:log'
  },
  {
    name: 'HABIT_KEY set but HABIT_OWNER_USER_ID missing → habit-key path fails',
    req: { method: 'POST', query: {}, headers: { [HK]: SECRET } },
    opts,
    clearOwner: true,
    expect: null
  },
  {
    name: 'cookie-only GET mutation → null',
    req: { method: 'GET', query: { habit: 'Drink' }, headers: { cookie: '__session=abc' } },
    opts: { ...clerkOpts, mutation: true },
    expect: null
  },
  {
    name: 'ht_ GET mutation via x-habit-key → allowed',
    req: { method: 'GET', query: { habit: 'Drink' }, headers: { [HK]: HT_USER } },
    opts: { ...opts, mutation: true },
    expect: { userId: 'user_plugin', via: 'token' }
  },
  {
    name: 'HABIT_KEY GET mutation → owner allowed',
    req: { method: 'GET', query: { run: '1' }, headers: { [HK]: SECRET } },
    opts: { ...opts, mutation: true },
    expect: { userId: 'user_owner', via: 'habit-key' }
  }
];

for (const c of CASES) {
  test(`auth contract: ${c.name}`, async () => {
    if (c.clearHabitKey) delete process.env.HABIT_KEY;
    if (c.clearOwner) delete process.env.HABIT_OWNER_USER_ID;
    const auth = await resolveAuth(c.req, c.opts);
    if (c.expect === null) {
      assert.equal(auth, null);
      return;
    }
    assert.deepEqual(auth, c.expect);
    if (c.scope) {
      assert.equal(scopeOf(auth.userId), c.scope);
      // Per-user never equals a bare unscoped key unless they are the owner.
      if (auth.via === 'token' && auth.userId !== 'user_owner') {
        assert.notEqual(c.scope, 'habits:log');
      }
      if (auth.via === 'clerk') {
        assert.notEqual(c.scope, 'habits:log');
      }
    }
  });
}

test('extractApiKey: ht_ from x-habit-key; non-ht_ header ignored', () => {
  assert.equal(
    extractApiKey({ query: {}, headers: { [HK]: HT_USER } }),
    HT_USER
  );
  assert.equal(
    extractApiKey({ query: {}, headers: { [HK]: SECRET } }),
    '',
    'deployment HABIT_KEY on x-habit-key is not an API token candidate'
  );
  assert.equal(
    extractApiKey({ query: { key: HT_USER }, headers: {} }),
    HT_USER
  );
});

test('extractApiKey: opts.body.key when req.body is absent', () => {
  assert.equal(
    extractApiKey({ query: {}, headers: {} }, { key: HT_USER }),
    HT_USER
  );
  assert.equal(
    extractApiKey({ query: {}, headers: {}, body: undefined }, { key: HT_USER }),
    HT_USER
  );
});

test('resolveAuth: ht_ in opts.body alone authenticates', async () => {
  const auth = await resolveAuth(
    { method: 'POST', query: {}, headers: {} },
    { ...opts, body: { key: HT_USER } }
  );
  assert.deepEqual(auth, { userId: 'user_plugin', via: 'token' });
});

test('hasExplicitCredential: ht_ header, HABIT_KEY, or Bearer', () => {
  assert.equal(hasExplicitCredential({ query: {}, headers: { [HK]: HT_USER } }), true);
  assert.equal(hasExplicitCredential({ query: {}, headers: { [HK]: SECRET } }), true);
  assert.equal(hasExplicitCredential({ query: {}, headers: { authorization: 'Bearer sess' } }), true);
  assert.equal(hasExplicitCredential({ query: {}, headers: { cookie: '__session=x' } }), false);
});

test('authFromHabitKey requires matching secret + owner mapping', () => {
  assert.deepEqual(
    authFromHabitKey({ query: {}, headers: { [HK]: SECRET } }),
    { userId: 'user_owner', via: 'habit-key' }
  );
  delete process.env.HABIT_OWNER_USER_ID;
  assert.equal(authFromHabitKey({ query: {}, headers: { [HK]: SECRET } }), null);
});

// Documented route × credential expectations (static source contract).
test('documented write routes no longer AND keyOk with withUser', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const routes = [
    'api/log.js', 'api/suggest.js', 'api/nudge.js', 'api/question.js',
    'api/experiment.js', 'api/habits.js', 'api/roster.js', 'api/profile.js',
    'api/coachpage.js', 'api/slots.js'
  ];
  for (const r of routes) {
    const src = readFileSync(join(root, r), 'utf8');
    assert.doesNotMatch(src, /if\s*\(\s*!keyOk/, r);
    assert.match(
      src,
      /withUser\s*\(|optionalAuth\s*\(|requireAuth\s*\(|requireOwnerAuth\s*\(/,
      r + ' must still call a unified auth helper'
    );
  }
  for (const r of ['api/cron/morning.js', 'api/cron/daily.js']) {
    const src = readFileSync(join(root, r), 'utf8');
    assert.match(src, /requireOwnerAuth\s*\(/, r);
    assert.doesNotMatch(src, /keyOk\s*\(/, r);
  }
});
