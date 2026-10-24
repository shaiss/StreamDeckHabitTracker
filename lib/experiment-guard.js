// Guards for /api/experiment?run=1 (#122): server-side model allowlist and a
// Redis lock + cooldown so a keyed caller cannot fan out arbitrary z.ai
// models or hammer parallel chat() calls.
//
// Lock key (habits:experiment:lock): SET NX EX with a random ownership token
// — at most one run in flight. Released via compare-and-delete (Lua EVAL) so
// a run that outlives the TTL cannot DEL a lock another run now holds (#134).
// TTL is still a safety net if the process dies mid-run.
//
// Cooldown key (habits:experiment:cooldown): stamped only after a successful
// claim that actually starts work; blocks a new claim until
// EXPERIMENT_COOLDOWN_MS has elapsed. A failed run releases the lock without
// refreshing the cooldown so a transient error can be retried.

import { randomUUID } from 'node:crypto';
import { redisCmd, redisKey } from './store.js';

/** Minimum interval between experiment runs (also used for Retry-After). */
export const EXPERIMENT_COOLDOWN_MS = 60_000;

/** In-flight lock TTL — covers the ~60s handler budget with slack. */
export const EXPERIMENT_LOCK_TTL_SEC = 90;

/**
 * Wall-clock budget for work held under the lock (chat + storeExperiment).
 * Must stay comfortably below EXPERIMENT_LOCK_TTL_SEC so a hung provider
 * cannot outlive the lease and allow a second run=1 to start.
 */
export const EXPERIMENT_RUN_TIMEOUT_MS = 55_000;

/** Models callers may pass via ?models=. Defaults stay on this list. */
export const EXPERIMENT_ALLOWED_MODELS = Object.freeze([
  'glm-5.2',
  'glm-4.7-flash'
]);

/** Cap on unknown model names echoed in the 400 body (#133). */
export const EXPERIMENT_MODEL_ECHO_MAX = 40;

/**
 * Per-run failure status stored on experiment docs (never raw provider text).
 * GET /api/experiment is unkeyed + CORS *, so only this short enum is public.
 */
export const EXPERIMENT_RUN_ERROR = 'provider_error';

const LOCK_LOGICAL = 'habits:experiment:lock';
const COOLDOWN_LOGICAL = 'habits:experiment:cooldown';

// Same EVAL shape as lib/habits.js casSetIfEqual — Upstash REST has no WATCH.
const RELEASE_IF_OWNER_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export function experimentAllowlist(preferred) {
  const allow = new Set(EXPERIMENT_ALLOWED_MODELS);
  if (typeof preferred === 'string' && preferred.trim()) allow.add(preferred.trim());
  return allow;
}

function echoModelName(name) {
  const s = String(name);
  return s.length <= EXPERIMENT_MODEL_ECHO_MAX ? s : s.slice(0, EXPERIMENT_MODEL_ECHO_MAX);
}

/**
 * Parse ?models= (or the default preferred + fallback pair) against the
 * allowlist. Never throws; returns { ok, models } or { ok:false, error }.
 * Dedupes names (first wins) before applying max (#133).
 */
export function parseExperimentModels(raw, { preferred = 'glm-5.2', max = 3 } = {}) {
  const fallback = `${preferred},glm-4.7-flash`;
  const seen = new Set();
  const list = [];
  for (const part of String(raw == null || raw === '' ? fallback : raw).split(',')) {
    const s = part.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    list.push(s);
    if (list.length >= max) break;
  }
  if (!list.length) {
    return { ok: false, error: 'No models specified.' };
  }
  const allow = experimentAllowlist(preferred);
  const unknown = list.filter((m) => !allow.has(m));
  if (unknown.length) {
    const allowed = [...allow].sort().join(', ');
    const echoed = unknown.map(echoModelName).join(', ');
    return {
      ok: false,
      error: `Unknown model(s): ${echoed}. Allowed: ${allowed}.`
    };
  }
  return { ok: true, models: list };
}

function retryAfterSec(msLeft) {
  return Math.max(1, Math.ceil(msLeft / 1000));
}

async function releaseLockIfOwned(cmd, lockKey, token) {
  if (token == null || token === '') return 0;
  return cmd(['EVAL', RELEASE_IF_OWNER_LUA, '1', lockKey, String(token)]);
}

/**
 * Claim the in-flight lock and enforce the cooldown. `cmd` is injectable for
 * unit tests (defaults to Redis-over-REST). On success returns `{ ok, token }`
 * — pass `token` to finishExperimentRun so release is ownership-checked.
 */
export async function claimExperimentRun({ now = Date.now(), cmd = redisCmd } = {}) {
  const lockKey = redisKey(LOCK_LOGICAL);
  const coolKey = redisKey(COOLDOWN_LOGICAL);
  const token = randomUUID();
  const set = await cmd([
    'SET',
    lockKey,
    token,
    'NX',
    'EX',
    String(EXPERIMENT_LOCK_TTL_SEC)
  ]);
  if (set !== 'OK') {
    // Lock value is an opaque token — remaining lease is unknown without TTL;
    // report the full lock window (same upper bound as before when GET was
    // unparseable).
    return { ok: false, retryAfterSec: retryAfterSec(EXPERIMENT_LOCK_TTL_SEC * 1000) };
  }

  // Lock is held; if the cooldown read throws, release it so callers are not
  // stuck on 429 until the 90s TTL. A failed release must not mask the original.
  try {
    const lastRaw = await cmd(['GET', coolKey]);
    const last = lastRaw == null || lastRaw === '' ? 0 : Number(lastRaw);
    if (Number.isFinite(last) && last > 0 && now - last < EXPERIMENT_COOLDOWN_MS) {
      await releaseLockIfOwned(cmd, lockKey, token);
      return {
        ok: false,
        retryAfterSec: retryAfterSec(EXPERIMENT_COOLDOWN_MS - (now - last))
      };
    }
    return { ok: true, token };
  } catch (err) {
    await releaseLockIfOwned(cmd, lockKey, token).catch(() => {});
    throw err;
  }
}

/**
 * Release the in-flight lock only if `token` still owns it. When `ok` is true,
 * stamp the cooldown so the next claim waits EXPERIMENT_COOLDOWN_MS. Safe to
 * call after a throw.
 */
export async function finishExperimentRun({
  ok = false,
  token,
  now = Date.now(),
  cmd = redisCmd
} = {}) {
  const lockKey = redisKey(LOCK_LOGICAL);
  const coolKey = redisKey(COOLDOWN_LOGICAL);
  try {
    if (ok) {
      const coolTtl = Math.ceil(EXPERIMENT_COOLDOWN_MS / 1000) + EXPERIMENT_LOCK_TTL_SEC;
      await cmd(['SET', coolKey, String(now), 'EX', String(coolTtl)]);
    }
  } finally {
    await releaseLockIfOwned(cmd, lockKey, token);
  }
}
