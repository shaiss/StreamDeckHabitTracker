// Tiny storage layer backed by a Redis-compatible REST API.
// Works with Vercel KV or an Upstash Redis integration — both expose a REST
// endpoint + token. We look for the standard env var names first, then fall
// back to auto-detecting any Redis-REST-looking vars, so connecting either
// integration in the Vercel dashboard "just works" no matter how it prefixes
// its variables.
//
// Non-production Redis isolation (#104 / #106): optional REDIS_KEY_PREFIX
// (or PREVIEW_REDIS_PREFIX) namespaces every logical habits:* key. Whenever
// VERCEL_ENV is not exactly `production`, Redis commands fail closed unless a
// non-empty prefix is set OR PREVIEW_REDIS_ISOLATED=1 (ops attestation that
// the non-prod env has its own Upstash DB). Prefer a separate Preview/Dev
// Upstash database; the prefix is defense-in-depth. See
// docs/preview-isolation.md.

function creds() {
  const env = process.env;

  // Standard names, in priority order.
  let url =
    env.KV_REST_API_URL ||
    env.UPSTASH_REDIS_REST_URL ||
    env.REDIS_REST_URL ||
    env.STORAGE_REST_API_URL;
  let token =
    env.KV_REST_API_TOKEN ||
    env.UPSTASH_REDIS_REST_TOKEN ||
    env.REDIS_REST_TOKEN ||
    env.STORAGE_REST_API_TOKEN;

  // Fallback: sniff out a REST URL (https, from a redis-ish var).
  if (!url) {
    const k = Object.keys(env).find(
      (k) => /URL$/i.test(k) && /(KV|UPSTASH|REDIS|STORAGE)/i.test(k) && /^https:\/\//i.test(env[k] || '')
    );
    if (k) url = env[k];
  }
  // Fallback: a write token (exclude read-only).
  if (!token) {
    const k = Object.keys(env).find(
      (k) =>
        /TOKEN$/i.test(k) &&
        !/READ_ONLY/i.test(k) &&
        /(KV|UPSTASH|REDIS|STORAGE)/i.test(k) &&
        (env[k] || '').length > 10
    );
    if (k) token = env[k];
  }
  return { url, token };
}

export function isConfigured() {
  const { url, token } = creds();
  return Boolean(url && token);
}

// Names (not values) of detected credential vars — for the health check.
export function detectedKeys() {
  return Object.keys(process.env).filter(
    (k) => /(KV|UPSTASH|REDIS|STORAGE)/i.test(k) && /(URL|TOKEN)$/i.test(k)
  );
}

/** Trimmed key namespace; empty in Production. Applied at call time (env can change in tests). */
export function redisKeyPrefix() {
  const raw = process.env.REDIS_KEY_PREFIX ?? process.env.PREVIEW_REDIS_PREFIX ?? '';
  return String(raw).trim();
}

/** Prefix a logical habits:* key. Production leaves REDIS_KEY_PREFIX unset. */
export function redisKey(logical) {
  return redisKeyPrefix() + logical;
}

/** True only for Vercel Preview deployments (VERCEL_ENV=preview). */
export function isPreviewEnv() {
  return process.env.VERCEL_ENV === 'preview';
}

/**
 * True whenever this is not Production — including preview, development,
 * unset, or any unexpected VERCEL_ENV value (#106).
 */
export function isNonProductionEnv() {
  return process.env.VERCEL_ENV !== 'production';
}

/** Ops flag: non-prod env vars point at a separate Upstash DB (not Production). */
export function previewRedisIsolatedFlag() {
  const v = String(process.env.PREVIEW_REDIS_ISOLATED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Non-production may use Redis only with a key prefix and/or an attested
 * separate DB. Unconfigured Redis is fine (API degrades); configured-but-
 * unisolated is not. Production is unrestricted by this gate.
 */
export function previewStorageAllowed() {
  if (!isNonProductionEnv()) return true;
  if (!isConfigured()) return true;
  if (redisKeyPrefix()) return true;
  if (previewRedisIsolatedFlag()) return true;
  return false;
}

export function assertPreviewStorageSafe() {
  if (previewStorageAllowed()) return;
  throw new Error(
    'Non-production storage isolation required (#106): set REDIS_KEY_PREFIX (e.g. preview:) ' +
      'or PREVIEW_REDIS_ISOLATED=1 after wiring a non-production-only Upstash DB. ' +
      'See docs/preview-isolation.md'
  );
}

/**
 * Health/diagnostics — booleans and env name only; never secret values.
 * Field name `previewIsolation` on /api/health is kept for callers; the gate
 * applies to every non-production VERCEL_ENV (#106).
 */
export function previewIsolationStatus() {
  const nonProduction = isNonProductionEnv();
  return {
    vercelEnv: process.env.VERCEL_ENV || null,
    nonProduction,
    required: nonProduction && isConfigured(),
    ok: previewStorageAllowed(),
    keyPrefixSet: Boolean(redisKeyPrefix()),
    separateDbFlag: previewRedisIsolatedFlag()
  };
}

async function cmd(args) {
  assertPreviewStorageSafe();
  const { url, token } = creds();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  if (!res.ok) {
    throw new Error(`store ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return json.result;
}

// Shared by lib/habits.js and lib/dataset.js so every Redis path honors the
// same preview fail-closed gate (their former private cmd() mirrors skipped it).
export { cmd as redisCmd };

// Append one entry: { h: habit, t: epoch-ms, note }
export async function append(entry) {
  return cmd(['RPUSH', redisKey('habits:log'), JSON.stringify(entry)]);
}

// A value no real entry can equal — every stored entry is a JSON object.
const TOMBSTONE = '__ht_removed__';

// Remove the NEWEST entry matching `pred` and return it (null if none match).
// Backs the long-press "oops" undo (issue #33).
//
// Redis lists have no delete-by-predicate, so this uses the standard
// LSET-tombstone + LREM pair. The ordering matters: LSET pins the exact index
// first, then LREM removes that one element by value. Indexes counted from the
// head are stable for us because entries only ever arrive via RPUSH — a
// concurrent write can shift positions *after* ours, never renumber it.
export async function removeLast(pred) {
  const key = redisKey('habits:log');
  const list = (await cmd(['LRANGE', key, '0', '-1'])) || [];
  for (let i = list.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(list[i]);
    } catch {
      continue;   // a tombstone mid-removal, or corrupt data all() also skips
    }
    if (!pred(entry)) continue;
    await cmd(['LSET', key, String(i), TOMBSTONE]);
    await cmd(['LREM', key, '1', TOMBSTONE]);
    return entry;
  }
  return null;
}

// AI slot map: { slots: [def|null x4], suggestedAt, model }

export async function getSlots() {
  const empty = { slots: [null, null, null, null], suggestedAt: 0, reactedAt: 0, model: '' };
  const raw = await cmd(['GET', redisKey('habits:slots')]);
  if (!raw) return empty;
  try {
    const doc = JSON.parse(raw);
    // Lazy expiry: timely feedback keys (e.g. "was that meal good?") carry an
    // expiresAt and simply stop resolving once stale — no sweeper needed.
    const now = Date.now();
    const slots = (Array.isArray(doc.slots) ? doc.slots.slice(0, 4) : []).map((s) =>
      s && s.expiresAt && s.expiresAt < now ? null : s
    );
    while (slots.length < 4) slots.push(null);
    return { slots, suggestedAt: doc.suggestedAt || 0, reactedAt: doc.reactedAt || 0, model: doc.model || '' };
  } catch {
    return empty;
  }
}

// Coach page slots (issue #52): a second, WIDER array backing the Coach page
// of the multi-page profile, deliberately separate from habits:slots. The
// front four stay the 4-slot wire contract everything else is shaped around
// (history corpus, scorer, nudge/question placement); this array answers
// "what else does the coach have", not "what does it want right now".
// /api/log?slot=5..16 resolves here (index slot-5).
export const COACH_PAGE_SIZE = 12;

export async function getCoachPage() {
  const empty = { slots: Array.from({ length: COACH_PAGE_SIZE }, () => null), updatedAt: 0, model: '' };
  const raw = await cmd(['GET', redisKey('habits:coach:page')]);
  if (!raw) return empty;
  try {
    const doc = JSON.parse(raw);
    // Same lazy expiry as getSlots: time-scoped keys stop resolving when stale.
    const now = Date.now();
    const slots = (Array.isArray(doc.slots) ? doc.slots.slice(0, COACH_PAGE_SIZE) : []).map((s) =>
      s && s.expiresAt && s.expiresAt < now ? null : s
    );
    while (slots.length < COACH_PAGE_SIZE) slots.push(null);
    return { slots, updatedAt: doc.updatedAt || 0, model: doc.model || '' };
  } catch {
    return empty;
  }
}

export async function setCoachPage(doc) {
  return cmd(['SET', redisKey('habits:coach:page'), JSON.stringify(doc)]);
}

export async function setSlots(doc) {
  await cmd(['SET', redisKey('habits:slots'), JSON.stringify(doc)]);
  // Append to assignment history so suggestions can be scored later against
  // what the human actually tapped (behavioral scorer, issue #6).
  if (Array.isArray(doc.slots) && doc.slots.some(Boolean)) {
    const histKey = redisKey('habits:slots:hist');
    const rec = {
      at: Date.now(),
      engine: doc.engine || '',
      slots: doc.slots.map((s) =>
        s
          ? {
              habit: s.habit,
              emoji: s.emoji,
              label: s.label,
              assignedAt: s.assignedAt,
              expiresAt: s.expiresAt || 0,
              // Nudges are scored like any suggestion, but the flag survives
              // into history so nudge hit-rate stays separable later.
              ...(s.nudge ? { nudge: 1 } : {})
            }
          : null
      )
    };
    await cmd(['RPUSH', histKey, JSON.stringify(rec)]);
    await cmd(['LTRIM', histKey, '-200', '-1']);
  }
}

export async function getSlotHistory() {
  const res = await cmd(['LRANGE', redisKey('habits:slots:hist'), '0', '-1']);
  return (res || [])
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// The coach's pending fixed-roster proposals plus the soft-retirement archive
// ({ proposals, archive, rejected, lastRunAt, model, engine }) — see
// lib/roster.js. Callers normalize; a missing/corrupt doc reads as null.

export async function getRoster() {
  const raw = await cmd(['GET', redisKey('habits:roster')]);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function setRoster(doc) {
  return cmd(['SET', redisKey('habits:roster'), JSON.stringify(doc)]);
}

// Coach-owned adaptive targets (#70): pending ramp-up proposals, applied-change
// history, and dismissal memory ({ proposals, history, rejected, lastRunAt,
// model, engine }) — see lib/target.js. Missing key → null (first boot).
// Unparseable / non-object values MUST throw — returning null would let
// normalizeTargets empty-normalize and a later setTargets wipe real data if
// the corrupt read was a transient decode glitch (or race with a partial write).
export async function getTargets() {
  const raw = await cmd(['GET', redisKey('habits:targets')]);
  // Only a missing key is first-boot empty. An empty string is corrupt storage
  // — must not null-short-circuit (normalizeTargets + setTargets would wipe).
  if (raw == null) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const err = new Error('habits:targets value is unparseable');
    err.code = 'TARGETS_CORRUPT';
    err.cause = cause;
    throw err;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const err = new Error('habits:targets value has unexpected shape');
    err.code = 'TARGETS_CORRUPT';
    throw err;
  }
  return parsed;
}

export async function setTargets(doc) {
  return cmd(['SET', redisKey('habits:targets'), JSON.stringify(doc)]);
}

// Atomic two-key write for goal changes that also append target history.
// Sequential saveHabits-then-setTargets can leave habits updated with no
// matching history entry when the second SET fails. Prefer MSET (one Redis
// command — all keys set or none) over a Lua double-SET: script isolation is
// not rollback, so a failing second redis.call('SET') would leave the first.
// habitsClean must already be prepareHabits()-shaped.
export async function setHabitsAndTargets(habitsClean, targetsDoc) {
  return cmd([
    'MSET',
    redisKey('habits:config'),
    JSON.stringify(habitsClean),
    redisKey('habits:targets'),
    JSON.stringify(targetsDoc)
  ]);
}

// Serialize POST /api/targets decisions with targetPass writes across BOTH
// habits:config and habits:targets. Unconditional full-document SETs on either
// path can otherwise restore a stale proposal or goal the other just changed.
// SET NX + tokened DEL mirrors claimTakeover; Upstash REST has no sticky WATCH.
// TTL is renewed while fn runs so a slow Redis stretch cannot expire the lock
// and let a second writer acquire — then get overwritten by the first's late
// write. Release stays token-checked so an expired/stolen lock is never DELed
// by the wrong holder.
export const TARGETS_LOCK_TTL_SEC = 90;
const RELEASE_TARGETS_LOCK_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const RENEW_TARGETS_LOCK_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], tonumber(ARGV[2])) else return 0 end";

export async function withTargetsLock(fn) {
  const lockKey = redisKey('habits:targets:lock');
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const ok = await cmd(['SET', lockKey, token, 'NX', 'EX', String(TARGETS_LOCK_TTL_SEC)]);
  if (ok !== 'OK') {
    const err = new Error('Another targets update is in progress.');
    err.code = 'TARGETS_BUSY';
    throw err;
  }
  // Renew at ~1/3 TTL so a long protected section cannot outlive the key.
  const renewEveryMs = Math.max(1_000, Math.floor((TARGETS_LOCK_TTL_SEC * 1000) / 3));
  const renewTimer = setInterval(() => {
    cmd(['EVAL', RENEW_TARGETS_LOCK_LUA, '1', lockKey, token, String(TARGETS_LOCK_TTL_SEC)]).catch(
      () => { /* release/TTL still clear a stranded lock */ }
    );
  }, renewEveryMs);
  // Don't keep the event loop alive solely for renewal.
  if (typeof renewTimer.unref === 'function') renewTimer.unref();
  try {
    return await fn();
  } finally {
    clearInterval(renewTimer);
    try {
      await cmd(['EVAL', RELEASE_TARGETS_LOCK_LUA, '1', lockKey, token]);
    } catch {
      /* TTL clears a stranded lock if release fails */
    }
  }
}

// Proactive-nudge state ({ checkedAt, lastAt, habit, slot, count }) — the
// throttle claims checkedAt BEFORE evaluating so concurrent pollers can't
// double-run the check (see nudgePass in lib/coach.js).

export async function getNudgeState() {
  const raw = await cmd(['GET', redisKey('habits:nudge')]);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function setNudgeState(doc) {
  return cmd(['SET', redisKey('habits:nudge'), JSON.stringify(doc)]);
}

// One-shot daily takeover claim (#54): SET NX is the atomic check-and-set,
// so exactly ONE caller per local day ever sees true — a GET-then-SET pair
// here would let two concurrent claims both come back granted. The
// takeoverAt/takeoverDay mirror in habits:nudge is observability, not the
// lock. 48h TTL keeps the keyspace clean without a sweeper.

export async function claimTakeover(day) {
  const res = await cmd([
    'SET',
    redisKey('habits:takeover:') + day,
    String(Date.now()),
    'NX',
    'EX',
    '172800'
  ]);
  return res === 'OK';
}

// Explicit "not today" dismissals ({ habit, slot, at }) — the third nudge
// outcome, which is otherwise indistinguishable from silence. Kept in its own
// list rather than folded into habits:log: a dismissal is emphatically NOT a
// tap, and anything that reads the log as "things the human did" must not see
// it (issue #35).

export async function appendDismissal(rec) {
  const key = redisKey('habits:nudge:dismissed');
  await cmd(['RPUSH', key, JSON.stringify(rec)]);
  await cmd(['LTRIM', key, '-200', '-1']);
}

export async function getDismissals() {
  const res = await cmd(['LRANGE', redisKey('habits:nudge:dismissed'), '0', '-1']);
  return (res || [])
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// The coach's questions ({ qid, text, habit, askedAt, expiresAt, answer?,
// answeredAt?, dismissedAt? }) — one append-only list, from which the OPEN
// question is derived rather than stored separately, so the two can never
// disagree (see openQuestion in lib/question.js, issue #34).

export async function getQuestions() {
  const res = await cmd(['LRANGE', redisKey('habits:question:hist'), '0', '-1']);
  return (res || [])
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function appendQuestion(rec) {
  const key = redisKey('habits:question:hist');
  await cmd(['RPUSH', key, JSON.stringify(rec)]);
  await cmd(['LTRIM', key, '-200', '-1']);
}

// Resolve a question in place: apply `patch` to the newest record with this
// qid. Same head-relative-index reasoning as removeLast() — RPUSH-only means a
// concurrent write cannot renumber the element we just located.
export async function patchQuestion(qid, patch) {
  const key = redisKey('habits:question:hist');
  const list = (await cmd(['LRANGE', key, '0', '-1'])) || [];
  for (let i = list.length - 1; i >= 0; i--) {
    let rec;
    try {
      rec = JSON.parse(list[i]);
    } catch {
      continue;
    }
    if (rec.qid !== qid) continue;
    const next = { ...rec, ...patch };
    await cmd(['LSET', key, String(i), JSON.stringify(next)]);
    return next;
  }
  return null;
}

// Last contact from a PHYSICAL deck ({ at, plugin, keys }). Written only when
// the Stream Deck plugin polls (it tags its request `?deck=<version>`), never
// by the dashboard or virtual deck — so "the hardware is live" is
// distinguishable from "nothing has ever connected" (issue #5).

export async function getDeckState() {
  const raw = await cmd(['GET', redisKey('habits:deck')]);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function setDeckState(doc) {
  return cmd(['SET', redisKey('habits:deck'), JSON.stringify(doc)]);
}

// The coach's persistent working notes (hypotheses about its human).
// The human's profile/settings ({ tz, name, about, updatedAt }).

export async function getProfile() {
  const raw = await cmd(['GET', redisKey('habits:profile')]);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function setProfile(doc) {
  return cmd(['SET', redisKey('habits:profile'), JSON.stringify(doc)]);
}

// Latest daily digest written by the coach ({ text, date, model, at }).

export async function getInsight() {
  const raw = await cmd(['GET', redisKey('habits:insight')]);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function setInsight(doc) {
  return cmd(['SET', redisKey('habits:insight'), JSON.stringify(doc)]);
}

export async function getCoachMemory() {
  const raw = await cmd(['GET', redisKey('habits:coach:memory')]);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function setCoachMemory(doc) {
  return cmd(['SET', redisKey('habits:coach:memory'), JSON.stringify(doc)]);
}

// Return every entry, oldest first.
export async function all() {
  const res = await cmd(['LRANGE', redisKey('habits:log'), '0', '-1']);
  return (res || [])
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
