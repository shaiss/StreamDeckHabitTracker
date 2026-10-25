// Auth guard for mutating (and user-scoped read) API handlers.
//
// Unified write/read credential contract (OR — one shared decision):
//   1. Valid per-user `ht_…` token (x-habit-key / ?key= / Bearer / body.key)
//      → that user's tenant keys only.
//   2. Matching deployment HABIT_KEY (prefer x-habit-key; also ?key=/body for
//      transition) when HABIT_KEY is set → owner tenant (HABIT_OWNER_USER_ID).
//   3. Valid Clerk session JWT (Authorization: Bearer or __session cookie)
//      → that user's tenant keys only.
//   Else → 401 (fail closed). No anonymous writes. Ever.
//
// Invariants:
//   - A per-user credential never reaches owner/unscoped data (always
//     runAsUser(that userId)).
//   - A non-ht_ ?key= is never accepted as a Clerk credential (no cookie
//     fallthrough); it may still match HABIT_KEY via habitKeyMatches().
//   - HABIT_KEY unset does not grant via path (2) — compatible with #116's
//     fail-closed keyOk without importing that change. Clerk/ht_ still work.
//   - If Clerk env is missing, path (3) cannot succeed; ht_ / HABIT_KEY still can.
//
// GET mutations are cookie-blind: a Clerk __session cookie alone never
// authorizes a state change on GET (top-level navigation / <img> CSRF).
// Writes on GET need an ht_ token, HABIT_KEY, or an explicit
// `Authorization: Bearer <Clerk session>` header. Cookie-only sessions
// remain valid for reads and for POST/DELETE.
//
// @clerk/backend is loaded lazily so unit CI (zero npm install by design) can
// still import this module and exercise resolveAuth with injected verifiers.
import { verifyApiToken, looksLikeApiToken } from './tokens.js';
import { habitKeyMatches, KEY_HEADER } from './habit-key.js';
import { runAsUser, ownerUserId } from './scope.js';

// Integrator sets CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY on Vercel.
// @clerk/backend accepts these names when passed explicitly (and as defaults).
export function publishableKey() {
  return (process.env.CLERK_PUBLISHABLE_KEY || '').trim();
}

export function secretKey() {
  return (process.env.CLERK_SECRET_KEY || '').trim();
}

export function clerkConfigured() {
  return Boolean(publishableKey() && secretKey());
}

/**
 * Origins allowed as the session token `azp` (authorized party).
 *
 * Prefer `CLERK_AUTHORIZED_PARTIES` (comma-separated). When unset or empty
 * after trim, fall back to https:// origins from Vercel system env vars so
 * azp checks stay on by default without a manual list. Localhost is added
 * only outside production (VERCEL_ENV === 'production', else NODE_ENV).
 *
 * Empty list would skip Clerk's azp check — we never return that from the
 * unset path. An explicit non-empty CLERK_AUTHORIZED_PARTIES wins as-is.
 */
export function authorizedParties() {
  const raw = process.env.CLERK_AUTHORIZED_PARTIES;
  if (raw != null && String(raw).trim() !== '') {
    const parsed = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    // All-empty entries (e.g. ",,") would skip Clerk's azp check — fall back.
    if (parsed.length) return parsed;
  }
  return defaultAuthorizedParties();
}

/** Best-effort production/preview origins from Vercel + local dev hosts. */
export function defaultAuthorizedParties() {
  const origins = [];
  for (const host of [
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_URL
  ]) {
    const h = String(host || '').trim();
    if (!h) continue;
    origins.push(/^https?:\/\//i.test(h) ? h : `https://${h}`);
  }
  // Vercel sets NODE_ENV=production on preview too — prefer VERCEL_ENV.
  const isProd = process.env.VERCEL_ENV
    ? process.env.VERCEL_ENV === 'production'
    : process.env.NODE_ENV === 'production';
  if (!isProd) {
    origins.push('http://localhost:3000', 'http://127.0.0.1:3000');
  }
  return [...new Set(origins)];
}

/** Options object passed to Clerk authenticateRequest (exported for unit tests). */
export function authenticateRequestOpts() {
  return {
    secretKey: secretKey(),
    publishableKey: publishableKey(),
    authorizedParties: authorizedParties()
  };
}

/** CORS headers so browser clients can send Authorization + x-habit-key. */
export function setCors(res, { methods = 'GET, POST, DELETE, OPTIONS' } = {}) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, x-habit-key'
  );
}

export function handleOptions(req, res, methods) {
  setCors(res, { methods });
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

function header(req, name) {
  const h = req.headers || {};
  return h[name] || h[name.toLowerCase()] || '';
}

/**
 * Pull a plugin API token candidate.
 * Prefer x-habit-key when it looks like `ht_…` (Stream Deck plugin transport).
 * Non-ht_ x-habit-key values are left for the HABIT_KEY path — never returned
 * here, so a deployment secret cannot be mistaken for a Clerk/ht_ credential.
 * Also accepts ?key=, Authorization: Bearer ht_…, and JSON body.key
 * (opts.body when req.body is absent — same as habitKeyMatches).
 */
export function extractApiKey(req, body) {
  const hk = String(header(req, KEY_HEADER) || '').trim();
  if (looksLikeApiToken(hk)) return hk;

  const q = req.query || {};
  if (q.key) return String(q.key);

  const auth = String(header(req, 'authorization') || '');
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m && looksLikeApiToken(m[1].trim())) return m[1].trim();

  const b = body !== undefined ? body : req.body;
  if (b && typeof b === 'object' && b.key) return String(b.key);
  return '';
}

export function isReadMethod(req) {
  const m = String(req.method || 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD';
}

/**
 * True when the caller presented a credential a third-party page cannot
 * attach: an ht_ plugin token (incl. x-habit-key), a matching HABIT_KEY, or
 * an Authorization: Bearer header (Clerk session JWT or ht_ token).
 * Cookie-only Clerk sessions return false.
 */
export function hasExplicitCredential(req, body) {
  const apiKey = extractApiKey(req, body);
  if (apiKey && looksLikeApiToken(apiKey)) return true;
  if (habitKeyMatches(req, body)) return true;
  const auth = String(header(req, 'authorization') || '');
  return /^Bearer\s+\S+/i.test(auth);
}

/**
 * Owner-tenant auth from a matching deployment HABIT_KEY.
 * Requires HABIT_OWNER_USER_ID so Redis scoping stays defined.
 * @returns {{ userId: string, via: 'habit-key' } | null}
 */
export function authFromHabitKey(req, body) {
  if (!habitKeyMatches(req, body)) return null;
  const owner = ownerUserId();
  if (!owner) return null;
  return { userId: owner, via: 'habit-key' };
}

function toFetchRequest(req) {
  const proto = String(header(req, 'x-forwarded-proto') || 'https').split(',')[0].trim();
  const host = String(header(req, 'x-forwarded-host') || header(req, 'host') || 'localhost').split(',')[0].trim();
  const url = `${proto}://${host}${req.url || '/'}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (v == null) continue;
    headers.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return new Request(url, { method: req.method || 'GET', headers });
}

/**
 * Clerk session → userId, or null if missing/invalid.
 * Infra failures (import, network, Clerk 5xx) propagate — same split as
 * verifyApiToken. authenticateRequest returns isAuthenticated:false for a
 * bad/expired session; that is not an infra error.
 */
async function defaultVerifySession(req) {
  if (!clerkConfigured()) return null;
  const { createClerkClient } = await import('@clerk/backend');
  const client = createClerkClient({
    secretKey: secretKey(),
    publishableKey: publishableKey()
  });
  const state = await client.authenticateRequest(
    toFetchRequest(req),
    authenticateRequestOpts()
  );
  if (!state.isAuthenticated) return null;
  const auth = state.toAuth();
  return auth?.userId || null;
}

/**
 * Resolve the caller to a tenant userId (unified OR-gate).
 * @returns {{ userId: string, via: 'token'|'habit-key'|'clerk' } | null}
 *
 * opts.verifySession / opts.verifyApiToken — injectable for unit tests.
 * opts.body — optional JSON body for HABIT_KEY / body.key presentation.
 */
export async function resolveAuth(req, opts = {}) {
  const body = opts.body;
  const apiKey = extractApiKey(req, body);

  if (apiKey) {
    const verifyTok = opts.verifyApiToken || verifyApiToken;
    if (looksLikeApiToken(apiKey)) {
      // Explicit ht_ credential: verify or 401 — never fall through to Clerk.
      const userId = await verifyTok(apiKey);
      return userId ? { userId, via: 'token' } : null;
    }
    // Non-ht_ ?key=/body.key: may still be the deployment HABIT_KEY.
    // Never treat it as a Clerk credential (no cookie fallthrough).
    return authFromHabitKey(req, body);
  }

  // No ?key=/body.key/ht_ header token. HABIT_KEY may still ride only on
  // x-habit-key (plugin/CI). Check before Clerk so owner tooling works.
  const fromHabitKey = authFromHabitKey(req, body);
  if (fromHabitKey) return fromHabitKey;

  if (opts.mutation && isReadMethod(req) && !hasExplicitCredential(req, body)) {
    return null;
  }

  const verifySess = opts.verifySession || defaultVerifySession;
  const userId = await verifySess(req);
  return userId ? { userId, via: 'clerk' } : null;
}

/**
 * Require auth; send 401 and return null on failure.
 * opts.plain — text/plain body (for /api/log).
 */
export async function requireAuth(req, res, opts = {}) {
  const auth = await resolveAuth(req, { ...opts, mutation: opts.mutation !== false });
  if (!auth) {
    if (opts.plain) res.status(401).send('Unauthorized');
    else res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return auth;
}

/** requireAuth + runAsUser so Redis keys scope to the caller. */
export async function withUser(req, res, fn, opts = {}) {
  const auth = await requireAuth(req, res, opts);
  if (!auth) return null;
  return runAsUser(auth.userId, () => fn(auth));
}

/**
 * Optional auth for reads that expose personal data.
 * Returns auth or null (caller serves public/empty payload).
 */
export async function optionalAuth(req, opts = {}) {
  return resolveAuth(req, { ...opts, mutation: opts.mutation === true });
}

/** Cron / system jobs act as the owner tenant when HABIT_OWNER_USER_ID is set. */
export function ownerOrNull() {
  return ownerUserId() || null;
}

export function cronSecret() {
  return (process.env.CRON_SECRET || '').trim();
}

/** True only when CRON_SECRET is set AND Authorization matches it. Fail closed if unset. */
export function isCronBearer(req) {
  const secret = cronSecret();
  if (!secret) return false;
  return String(header(req, 'authorization') || '') === `Bearer ${secret}`;
}

/**
 * Owner-tenant gate (cron + owner coaching admin).
 *
 * Allowed callers:
 *   1. Vercel Cron with Authorization: Bearer ${CRON_SECRET} (secret must be set)
 *   2. Clerk session or ht_ token whose userId === HABIT_OWNER_USER_ID
 *
 * Fail closed: missing HABIT_OWNER_USER_ID → no user/token passes.
 * Missing CRON_SECRET → bearer path refused.
 *
 * @returns {{ ok: true, via: 'cron'|'clerk'|'token', userId?: string }
 *         | { ok: false, status: 401|403 }}
 */
export async function resolveOwnerAuth(req, opts = {}) {
  if (isCronBearer(req)) {
    // Cron still needs a tenant to scope Redis writes; caller checks ownerUserId().
    return { ok: true, via: 'cron' };
  }

  const auth = await resolveAuth(req, { ...opts, mutation: opts.mutation !== false });
  if (!auth) return { ok: false, status: 401 };

  const owner = ownerUserId();
  // No owner configured → no Clerk/token may act as the owner tenant.
  if (!owner || auth.userId !== owner) return { ok: false, status: 403 };

  return { ok: true, via: auth.via, userId: auth.userId };
}

/**
 * requireOwnerAuth: send 401/403 with a generic body (never owner data) and return null.
 */
export async function requireOwnerAuth(req, res, opts = {}) {
  const gate = await resolveOwnerAuth(req, opts);
  if (!gate.ok) {
    res.status(gate.status).json({
      error: gate.status === 401 ? 'Unauthorized' : 'Forbidden'
    });
    return null;
  }
  return gate;
}
