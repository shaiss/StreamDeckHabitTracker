// Guards for /api/experiment?run=1 (#122): server-side model allowlist and a
// Redis lock + cooldown so a keyed caller cannot fan out arbitrary z.ai
// models or hammer parallel chat() calls.
//
// Lock key (habits:experiment:lock): SET NX EX — at most one run in flight.
// Always DEL'd in finishExperimentRun (success or throw); TTL is a safety net
// if the process dies mid-run.
//
// Cooldown key (habits:experiment:cooldown): stamped only after a successful
// claim that actually starts work; blocks a new claim until
// EXPERIMENT_COOLDOWN_MS has elapsed. A failed run releases the lock without
// refreshing the cooldown so a transient error can be retried.

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

const LOCK_LOGICAL = 'habits:experiment:lock';
const COOLDOWN_LOGICAL = 'habits:experiment:cooldown';

export function experimentAllowlist(preferred) {
  const allow = new Set(EXPERIMENT_ALLOWED_MODELS);
  if (typeof preferred === 'string' && preferred.trim()) allow.add(preferred.trim());
  return allow;
}

/**
 * Parse ?models= (or the default preferred + fallback pair) against the
 * allowlist. Never throws; returns { ok, models } or { ok:false, error }.
 */
export function parseExperimentModels(raw, { preferred = 'glm-5.2', max = 3 } = {}) {
  const fallback = `${preferred},glm-4.7-flash`;
  const list = String(raw == null || raw === '' ? fallback : raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max);
  if (!list.length) {
    return { ok: false, error: 'No models specified.' };
  }
  const allow = experimentAllowlist(preferred);
  const unknown = [...new Set(list.filter((m) => !allow.has(m)))];
  if (unknown.length) {
    const allowed = [...allow].sort().join(', ');
    return {
      ok: false,
      error: `Unknown model(s): ${unknown.join(', ')}. Allowed: ${allowed}.`
    };
  }
  return { ok: true, models: list };
}

function retryAfterSec(msLeft) {
  return Math.max(1, Math.ceil(msLeft / 1000));
}

/**
 * Claim the in-flight lock and enforce the cooldown. `cmd` is injectable for
 * unit tests (defaults to Redis-over-REST).
 */
export async function claimExperimentRun({ now = Date.now(), cmd = redisCmd } = {}) {
  const lockKey = redisKey(LOCK_LOGICAL);
  const coolKey = redisKey(COOLDOWN_LOGICAL);
  const set = await cmd([
    'SET',
    lockKey,
    String(now),
    'NX',
    'EX',
    String(EXPERIMENT_LOCK_TTL_SEC)
  ]);
  if (set !== 'OK') {
    const started = Number(await cmd(['GET', lockKey]));
    const elapsed = Number.isFinite(started) ? now - started : 0;
    const left = EXPERIMENT_LOCK_TTL_SEC * 1000 - elapsed;
    return { ok: false, retryAfterSec: retryAfterSec(left > 0 ? left : EXPERIMENT_COOLDOWN_MS) };
  }

  // Lock is held; if the cooldown read throws, release it so callers are not
  // stuck on 429 until the 90s TTL. A failed DEL must not mask the original.
  try {
    const lastRaw = await cmd(['GET', coolKey]);
    const last = lastRaw == null || lastRaw === '' ? 0 : Number(lastRaw);
    if (Number.isFinite(last) && last > 0 && now - last < EXPERIMENT_COOLDOWN_MS) {
      await cmd(['DEL', lockKey]);
      return {
        ok: false,
        retryAfterSec: retryAfterSec(EXPERIMENT_COOLDOWN_MS - (now - last))
      };
    }
    return { ok: true };
  } catch (err) {
    await cmd(['DEL', lockKey]).catch(() => {});
    throw err;
  }
}

/**
 * Release the in-flight lock. When `ok` is true, stamp the cooldown so the
 * next claim waits EXPERIMENT_COOLDOWN_MS. Safe to call after a throw.
 */
export async function finishExperimentRun({ ok = false, now = Date.now(), cmd = redisCmd } = {}) {
  const lockKey = redisKey(LOCK_LOGICAL);
  const coolKey = redisKey(COOLDOWN_LOGICAL);
  try {
    if (ok) {
      const coolTtl = Math.ceil(EXPERIMENT_COOLDOWN_MS / 1000) + EXPERIMENT_LOCK_TTL_SEC;
      await cmd(['SET', coolKey, String(now), 'EX', String(coolTtl)]);
    }
  } finally {
    await cmd(['DEL', lockKey]);
  }
}
