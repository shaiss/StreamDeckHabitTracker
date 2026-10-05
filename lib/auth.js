// Auth guard for mutating (and user-scoped read) API handlers.
//
// Fail closed:
//   - No anonymous writes. Ever.
//   - If Clerk env vars are missing, the Clerk session path cannot succeed.
//   - A valid per-user API token (`ht_…` via ?key= / Authorization / body.key)
//     still authenticates the plugin even when Clerk is misconfigured — the
//     token was issued under a real userId and is hashed server-side.
//
// Two credentials are accepted:
//   1. Clerk session JWT (Authorization: Bearer <session> or __session cookie)
//   2. Per-user plugin API token (lib/tokens.js) — preferred for Stream Deck
//
// The old deployment-wide HABIT_KEY is NOT a write credential anymore.
//
// @clerk/backend is loaded lazily so unit CI (zero npm install by design) can
// still import this module and exercise resolveAuth with injected verifiers.
import { verifyApiToken, looksLikeApiToken } from './tokens.js';
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

/** CORS headers so browser clients can send Authorization. */
export function setCors(res, { methods = 'GET, POST, DELETE, OPTIONS' } = {}) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
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

/** Pull a plugin API token from query, Authorization, or JSON body. */
export function extractApiKey(req) {
  const q = req.query || {};
  if (q.key) return String(q.key);
  const auth = String(header(req, 'authorization') || '');
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m && looksLikeApiToken(m[1].trim())) return m[1].trim();
  const body = req.body;
  if (body && typeof body === 'object' && body.key) return String(body.key);
  return '';
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

async function defaultVerifySession(req) {
  if (!clerkConfigured()) return null;
  try {
    const { createClerkClient } = await import('@clerk/backend');
    const client = createClerkClient({
      secretKey: secretKey(),
      publishableKey: publishableKey()
    });
    const state = await client.authenticateRequest(toFetchRequest(req), {
      secretKey: secretKey(),
      publishableKey: publishableKey()
    });
    if (!state.isAuthenticated) return null;
    const auth = state.toAuth();
    return auth?.userId || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the caller to a Clerk userId.
 * @returns {{ userId: string, via: 'token'|'clerk' } | null}
 *
 * opts.verifySession / opts.verifyApiToken — injectable for unit tests.
 */
export async function resolveAuth(req, opts = {}) {
  const apiKey = extractApiKey(req);
  if (apiKey) {
    // An explicit key that isn't a valid ht_ token (or is revoked) must 401 —
    // never fall through to cookies and accidentally grant another identity.
    const verifyTok = opts.verifyApiToken || verifyApiToken;
    if (!looksLikeApiToken(apiKey)) return null;
    const userId = await verifyTok(apiKey);
    return userId ? { userId, via: 'token' } : null;
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
  const auth = await resolveAuth(req, opts);
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
  return resolveAuth(req, opts);
}

/** Cron / system jobs act as the owner tenant when HABIT_OWNER_USER_ID is set. */
export function ownerOrNull() {
  return ownerUserId() || null;
}
