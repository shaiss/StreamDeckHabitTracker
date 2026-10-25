import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runAsUser, redisKey, isOwner, ownerUserId } from '../../lib/scope.js';
import {
  resolveAuth, requireAuth, optionalAuth, clerkConfigured, publishableKey,
  resolveOwnerAuth, requireOwnerAuth, isCronBearer,
  authorizedParties, defaultAuthorizedParties, authenticateRequestOpts
} from '../../lib/auth.js';

const ENV_KEYS = [
  'HABIT_OWNER_USER_ID', 'HABIT_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'CRON_SECRET',
  'CLERK_AUTHORIZED_PARTIES',
  'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_BRANCH_URL', 'VERCEL_URL', 'VERCEL_ENV',
  'NODE_ENV'
];
const saved = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('owner redisKey is the legacy unprefixed key (no copy, no rename)', () => {
  process.env.HABIT_OWNER_USER_ID = 'user_owner';
  assert.equal(isOwner('user_owner'), true);
  assert.equal(isOwner('user_other'), false);
  const k = runAsUser('user_owner', () => redisKey('habits:log'));
  assert.equal(k, 'habits:log');
  assert.equal(runAsUser('user_owner', () => redisKey('habits:slots')), 'habits:slots');
  assert.equal(runAsUser('user_owner', () => redisKey('habits:config')), 'habits:config');
});

test('non-owner redisKey is prefixed and never equals the legacy key', () => {
  process.env.HABIT_OWNER_USER_ID = 'user_owner';
  const k = runAsUser('user_new', () => redisKey('habits:log'));
  assert.equal(k, 'u:user_new:habits:log');
  assert.notEqual(k, 'habits:log');
});

test('two users never share a redisKey for the same logical base', () => {
  process.env.HABIT_OWNER_USER_ID = 'user_owner';
  const a = runAsUser('user_a', () => redisKey('habits:log'));
  const b = runAsUser('user_b', () => redisKey('habits:log'));
  const owner = runAsUser('user_owner', () => redisKey('habits:log'));
  assert.notEqual(a, b);
  assert.notEqual(a, owner);
  assert.notEqual(b, owner);
  assert.equal(owner, 'habits:log');
});

test('owner mapping is idempotent — repeated calls always hit the same legacy key', () => {
  process.env.HABIT_OWNER_USER_ID = 'user_owner';
  const keys = Array.from({ length: 5 }, () =>
    runAsUser('user_owner', () => redisKey('habits:log'))
  );
  assert.deepEqual(keys, ['habits:log', 'habits:log', 'habits:log', 'habits:log', 'habits:log']);
});

test('redisKey throws without runAsUser (fail closed on missing scope)', () => {
  assert.throws(() => redisKey('habits:log'), /no user scope/);
});

test('clerkConfigured is false when env keys are missing', () => {
  delete process.env.CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  assert.equal(clerkConfigured(), false);
  assert.equal(publishableKey(), '');
});

test('clerkConfigured is true when CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY are set', () => {
  process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_x';
  process.env.CLERK_SECRET_KEY = 'sk_test_x';
  assert.equal(clerkConfigured(), true);
});

function mockRes() {
  const out = { statusCode: 200, body: null };
  return {
    out,
    status(c) { out.statusCode = c; return this; },
    json(b) { out.body = b; return this; },
    send(b) { out.body = b; return this; }
  };
}

test('resolveAuth: 401 path — no session and no token → null', async () => {
  delete process.env.CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  const auth = await resolveAuth({ query: {}, headers: {} });
  assert.equal(auth, null);
});

test('requireAuth sends 401 when Clerk env missing and no token', async () => {
  delete process.env.CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  const res = mockRes();
  const auth = await requireAuth({ query: {}, headers: {} }, res);
  assert.equal(auth, null);
  assert.equal(res.out.statusCode, 401);
  assert.deepEqual(res.out.body, { error: 'Unauthorized' });
});

test('requireAuth plain text 401 for /api/log style', async () => {
  delete process.env.CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  const res = mockRes();
  await requireAuth({ query: {}, headers: {} }, res, { plain: true });
  assert.equal(res.out.statusCode, 401);
  assert.equal(res.out.body, 'Unauthorized');
});

test('valid Clerk session mock → userId', async () => {
  process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_x';
  process.env.CLERK_SECRET_KEY = 'sk_test_x';
  const auth = await resolveAuth(
    { query: {}, headers: { authorization: 'Bearer sess_abc' } },
    { verifySession: async () => 'user_session' }
  );
  assert.deepEqual(auth, { userId: 'user_session', via: 'clerk' });
});

test('plugin API token path binds to the token userId', async () => {
  delete process.env.CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  const auth = await resolveAuth(
    { query: { key: 'ht_deadbeefdeadbeefdeadbeefdeadbeef' }, headers: {} },
    {
      verifyApiToken: async (t) => (t.startsWith('ht_') ? 'user_plugin' : null),
      verifySession: async () => 'should_not_run'
    }
  );
  assert.deepEqual(auth, { userId: 'user_plugin', via: 'token' });
});

test('plugin token via x-habit-key (Stream Deck transport) binds to userId', async () => {
  delete process.env.CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.HABIT_KEY;
  const hk = 'x-habit-' + 'key';
  const tok = 'ht_' + 'deadbeefdeadbeefdeadbeefdeadbeef';
  const auth = await resolveAuth(
    { query: {}, headers: { [hk]: tok } },
    {
      verifyApiToken: async (t) => (t.startsWith('ht_') ? 'user_plugin' : null),
      verifySession: async () => 'should_not_run'
    }
  );
  assert.deepEqual(auth, { userId: 'user_plugin', via: 'token' });
});

test('HABIT_KEY via x-habit-key authorizes as owner tenant', async () => {
  const secret = 'test-' + 'placeholder-value';
  const hk = 'x-habit-' + 'key';
  process.env.HABIT_KEY = secret;
  process.env.HABIT_OWNER_USER_ID = 'user_owner';
  const auth = await resolveAuth(
    { query: {}, headers: { [hk]: secret } },
    { verifySession: async () => 'should_not_run', verifyApiToken: async () => 'nope' }
  );
  assert.deepEqual(auth, { userId: 'user_owner', via: 'habit-key' });
});

test('invalid plugin token does not fall through to Clerk session', async () => {
  process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_x';
  process.env.CLERK_SECRET_KEY = 'sk_test_x';
  const auth = await resolveAuth(
    { query: { key: 'ht_revokedxxxxxxxxxxxxxxxxxxxx' }, headers: { authorization: 'Bearer sess' } },
    {
      verifyApiToken: async () => null,
      verifySession: async () => 'user_session'
    }
  );
  assert.equal(auth, null);
});

test('cross-user isolation: different tokens resolve to different userIds', async () => {
  const map = {
    ht_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: 'user_a',
    ht_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: 'user_b'
  };
  const a = await resolveAuth(
    { query: { key: 'ht_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, headers: {} },
    { verifyApiToken: async (t) => map[t] || null }
  );
  const b = await resolveAuth(
    { query: { key: 'ht_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, headers: {} },
    { verifyApiToken: async (t) => map[t] || null }
  );
  assert.equal(a.userId, 'user_a');
  assert.equal(b.userId, 'user_b');
  assert.notEqual(a.userId, b.userId);
});

test('legacy HABIT_KEY-shaped secrets are rejected (not ht_ tokens)', async () => {
  process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_x';
  process.env.CLERK_SECRET_KEY = 'sk_test_x';
  const auth = await resolveAuth(
    { query: { key: 'old-shared-secret' }, headers: {} },
    { verifySession: async () => 'user_x', verifyApiToken: async () => 'nope' }
  );
  // Non-ht_ key is treated as an explicit bad credential → null (no session fallthrough)
  assert.equal(auth, null);
});

test('ownerUserId reads HABIT_OWNER_USER_ID', () => {
  process.env.HABIT_OWNER_USER_ID = ' user_owner ';
  assert.equal(ownerUserId(), 'user_owner');
});

// --- Owner-only gate (cron + owner coaching admin) ---

const ownerOpts = (userId) => ({
  verifySession: async () => userId || null,
  verifyApiToken: async (t) => {
    if (t === 'ht_ownerownerownerownerownerownerow') return 'user_owner';
    if (t === 'ht_otherotherotherotherotherotherot') return 'user_other';
    return null;
  }
});

test('owner session may call owner-only routes', async () => {
  process.env.HABIT_OWNER_USER_ID = 'user_owner';
  process.env.CRON_SECRET = 'cron-secret';
  const gate = await resolveOwnerAuth(
    { query: {}, headers: { authorization: 'Bearer sess' } },
    ownerOpts('user_owner')
  );
  assert.deepEqual(gate, { ok: true, via: 'clerk', userId: 'user_owner' });
});

test('owner ht_ token may call owner-only routes', async () => {
  process.env.HABIT_OWNER_USER_ID = 'user_owner';
  delete process.env.CRON_SECRET;
  const gate = await resolveOwnerAuth(
    { query: { key: 'ht_ownerownerownerownerownerownerow' }, headers: {} },
    ownerOpts(null)
  );
  assert.equal(gate.ok, true);
  assert.equal(gate.via, 'token');
  assert.equal(gate.userId, 'user_owner');
});

test('valid CRON_SECRET bearer may call owner-only routes', async () => {
  process.env.HABIT_OWNER_USER_ID = 'user_owner';
  process.env.CRON_SECRET = 'cron-secret';
  const req = { query: {}, headers: { authorization: 'Bearer cron-secret' } };
  assert.equal(isCronBearer(req), true);
  const gate = await resolveOwnerAuth(req, ownerOpts('user_other'));
  assert.deepEqual(gate, { ok: true, via: 'cron' });
});

test('non-owner session gets 403 on owner-only routes', async () => {
  process.env.HABIT_OWNER_USER_ID = 'user_owner';
  process.env.CRON_SECRET = 'cron-secret';
  const gate = await resolveOwnerAuth(
    { query: {}, headers: { authorization: 'Bearer sess' } },
    ownerOpts('user_other')
  );
  assert.deepEqual(gate, { ok: false, status: 403 });
  const res = mockRes();
  await requireOwnerAuth(
    { query: {}, headers: { authorization: 'Bearer sess' } },
    res,
    ownerOpts('user_other')
  );
  assert.equal(res.out.statusCode, 403);
  assert.deepEqual(res.out.body, { error: 'Forbidden' });
});

test('non-owner ht_ token gets 403 on owner-only routes', async () => {
  process.env.HABIT_OWNER_USER_ID = 'user_owner';
  const gate = await resolveOwnerAuth(
    { query: { key: 'ht_otherotherotherotherotherotherot' }, headers: {} },
    ownerOpts(null)
  );
  assert.deepEqual(gate, { ok: false, status: 403 });
});

test('anonymous gets 401 on owner-only routes', async () => {
  process.env.HABIT_OWNER_USER_ID = 'user_owner';
  process.env.CRON_SECRET = 'cron-secret';
  const gate = await resolveOwnerAuth(
    { query: {}, headers: {} },
    ownerOpts(null)
  );
  assert.deepEqual(gate, { ok: false, status: 401 });
  const res = mockRes();
  await requireOwnerAuth({ query: {}, headers: {} }, res, ownerOpts(null));
  assert.equal(res.out.statusCode, 401);
  assert.deepEqual(res.out.body, { error: 'Unauthorized' });
});

test('HABIT_OWNER_USER_ID unset: no Clerk user or token passes owner gate', async () => {
  delete process.env.HABIT_OWNER_USER_ID;
  process.env.CRON_SECRET = 'cron-secret';
  const sess = await resolveOwnerAuth(
    { query: {}, headers: { authorization: 'Bearer sess' } },
    ownerOpts('user_owner')
  );
  assert.deepEqual(sess, { ok: false, status: 403 });
  const tok = await resolveOwnerAuth(
    { query: { key: 'ht_ownerownerownerownerownerownerow' }, headers: {} },
    ownerOpts(null)
  );
  assert.deepEqual(tok, { ok: false, status: 403 });
});

test('CRON_SECRET unset: bearer path refused (even with Authorization header)', async () => {
  process.env.HABIT_OWNER_USER_ID = 'user_owner';
  delete process.env.CRON_SECRET;
  const req = { query: {}, headers: { authorization: 'Bearer anything' } };
  assert.equal(isCronBearer(req), false);
  // Header is not an ht_ token and session verify returns null → 401
  const gate = await resolveOwnerAuth(req, ownerOpts(null));
  assert.deepEqual(gate, { ok: false, status: 401 });
});

test('cookie-only GET mutation is rejected (no session verify)', async () => {
  let verified = false;
  const res = mockRes();
  const auth = await requireAuth(
    { method: 'GET', query: { habit: 'Drink' }, headers: { cookie: '__session=abc' } },
    res,
    {
      verifySession: async () => { verified = true; return 'user_session'; },
      verifyApiToken: async () => 'nope'
    }
  );
  assert.equal(auth, null);
  assert.equal(verified, false);
  assert.equal(res.out.statusCode, 401);
});

test('Bearer Clerk session GET mutation is allowed', async () => {
  const res = mockRes();
  const auth = await requireAuth(
    { method: 'GET', query: { habit: 'Drink' }, headers: { authorization: 'Bearer sess_abc' } },
    res,
    { verifySession: async () => 'user_session' }
  );
  assert.deepEqual(auth, { userId: 'user_session', via: 'clerk' });
  assert.equal(res.out.statusCode, 200);
});

test('ht_ token GET mutation is allowed', async () => {
  const res = mockRes();
  const auth = await requireAuth(
    {
      method: 'GET',
      query: { habit: 'Drink', key: 'ht_deadbeefdeadbeefdeadbeefdeadbeef' },
      headers: {}
    },
    res,
    {
      verifyApiToken: async (t) => (t.startsWith('ht_') ? 'user_plugin' : null),
      verifySession: async () => 'should_not_run'
    }
  );
  assert.deepEqual(auth, { userId: 'user_plugin', via: 'token' });
});

test('cookie-only GET read is allowed', async () => {
  const auth = await optionalAuth(
    { method: 'GET', query: {}, headers: { cookie: '__session=abc' } },
    { verifySession: async () => 'user_session' }
  );
  assert.deepEqual(auth, { userId: 'user_session', via: 'clerk' });
});

test('cookie-only POST mutation is still allowed', async () => {
  const res = mockRes();
  const auth = await requireAuth(
    { method: 'POST', query: {}, headers: { cookie: '__session=abc' } },
    res,
    { verifySession: async () => 'user_session' }
  );
  assert.deepEqual(auth, { userId: 'user_session', via: 'clerk' });
});

test('session-verify infra error is 5xx, not 401', async () => {
  const res = mockRes();
  const req = { method: 'GET', query: {}, headers: { authorization: 'Bearer sess_abc' } };
  const opts = {
    verifySession: async () => { throw new Error('Clerk JWKS unreachable'); }
  };
  try {
    await requireAuth(req, res, opts);
    assert.fail('requireAuth should propagate infra errors');
  } catch (err) {
    assert.match(err.message, /JWKS unreachable/);
    assert.equal(res.out.statusCode, 200, 'must not send 401 before throwing');
    assert.equal(res.out.body, null);
  }
  // Same split the API handlers use: catch → 500, never rewrite as signed-out.
  try {
    await requireAuth(req, res, opts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
  assert.equal(res.out.statusCode, 500);
  assert.equal(res.out.body.error.includes('JWKS'), true);
  assert.notEqual(res.out.body.error, 'Unauthorized');
});

test('cookie-only GET cannot pass owner-only cron', async () => {
  process.env.HABIT_OWNER_USER_ID = 'user_owner';
  process.env.CRON_SECRET = 'cron-secret';
  const gate = await resolveOwnerAuth(
    { method: 'GET', query: {}, headers: { cookie: '__session=abc' } },
    ownerOpts('user_owner')
  );
  assert.deepEqual(gate, { ok: false, status: 401 });
});

test('wrong CRON_SECRET does not grant access and does not leak owner data', async () => {
  process.env.HABIT_OWNER_USER_ID = 'user_owner';
  process.env.CRON_SECRET = 'cron-secret';
  const res = mockRes();
  await requireOwnerAuth(
    { query: {}, headers: { authorization: 'Bearer wrong' } },
    res,
    ownerOpts(null)
  );
  assert.equal(res.out.statusCode, 401);
  assert.equal(JSON.stringify(res.out.body).includes('user_owner'), false);
  assert.deepEqual(res.out.body, { error: 'Unauthorized' });
});

// --- authorizedParties (Clerk azp / CSRF hardening) ---

test('authorizedParties: trims and drops empty comma entries', () => {
  process.env.CLERK_AUTHORIZED_PARTIES = ' https://a.example , ,https://b.example,  ';
  assert.deepEqual(authorizedParties(), ['https://a.example', 'https://b.example']);
});

test('authorizedParties: unset falls back to Vercel https origins + localhost off-prod', () => {
  delete process.env.CLERK_AUTHORIZED_PARTIES;
  delete process.env.VERCEL_ENV;
  delete process.env.NODE_ENV;
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'stream-deck-habit-tracker.vercel.app';
  process.env.VERCEL_BRANCH_URL = 'https://preview-branch.vercel.app';
  process.env.VERCEL_URL = 'deploy-hash.vercel.app';
  assert.deepEqual(authorizedParties(), [
    'https://stream-deck-habit-tracker.vercel.app',
    'https://preview-branch.vercel.app',
    'https://deploy-hash.vercel.app',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ]);
});

test('authorizedParties: blank env falls back (protection on by default)', () => {
  process.env.CLERK_AUTHORIZED_PARTIES = '  ,  ';
  process.env.VERCEL_ENV = 'production';
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'prod.vercel.app';
  delete process.env.VERCEL_BRANCH_URL;
  delete process.env.VERCEL_URL;
  assert.deepEqual(authorizedParties(), ['https://prod.vercel.app']);
  assert.deepEqual(authorizedParties(), defaultAuthorizedParties());
});

test('authorizedParties: production omits localhost', () => {
  delete process.env.CLERK_AUTHORIZED_PARTIES;
  process.env.VERCEL_ENV = 'production';
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'prod.vercel.app';
  delete process.env.VERCEL_BRANCH_URL;
  delete process.env.VERCEL_URL;
  assert.deepEqual(authorizedParties(), ['https://prod.vercel.app']);
});

test('authenticateRequestOpts passes authorizedParties to Clerk options', () => {
  process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_x';
  process.env.CLERK_SECRET_KEY = 'sk_test_x';
  process.env.CLERK_AUTHORIZED_PARTIES = 'https://habitdeck.fyi, https://www.habitdeck.fyi';
  const opts = authenticateRequestOpts();
  assert.equal(opts.secretKey, 'sk_test_x');
  assert.equal(opts.publishableKey, 'pk_test_x');
  assert.deepEqual(opts.authorizedParties, [
    'https://habitdeck.fyi',
    'https://www.habitdeck.fyi'
  ]);
  // Same list the session path feeds authenticateRequest.
  assert.deepEqual(opts.authorizedParties, authorizedParties());
});
