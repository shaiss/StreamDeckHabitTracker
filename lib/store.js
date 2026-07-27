// Tiny storage layer backed by a Redis-compatible REST API.
// Works with Vercel KV or an Upstash Redis integration — both expose a REST
// endpoint + token. We look for the standard env var names first, then fall
// back to auto-detecting any Redis-REST-looking vars, so connecting either
// integration in the Vercel dashboard "just works" no matter how it prefixes
// its variables.

const KEY = 'habits:log';

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

async function cmd(args) {
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

// Append one entry: { h: habit, t: epoch-ms, note }
export async function append(entry) {
  return cmd(['RPUSH', KEY, JSON.stringify(entry)]);
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
  const list = (await cmd(['LRANGE', KEY, '0', '-1'])) || [];
  for (let i = list.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(list[i]);
    } catch {
      continue;   // a tombstone mid-removal, or corrupt data all() also skips
    }
    if (!pred(entry)) continue;
    await cmd(['LSET', KEY, String(i), TOMBSTONE]);
    await cmd(['LREM', KEY, '1', TOMBSTONE]);
    return entry;
  }
  return null;
}

// AI slot map: { slots: [def|null x4], suggestedAt, model }
const SLOTS_KEY = 'habits:slots';

export async function getSlots() {
  const empty = { slots: [null, null, null, null], suggestedAt: 0, reactedAt: 0, model: '' };
  const raw = await cmd(['GET', SLOTS_KEY]);
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

const SLOTS_HIST_KEY = 'habits:slots:hist';

export async function setSlots(doc) {
  await cmd(['SET', SLOTS_KEY, JSON.stringify(doc)]);
  // Append to assignment history so suggestions can be scored later against
  // what the human actually tapped (behavioral scorer, issue #6).
  if (Array.isArray(doc.slots) && doc.slots.some(Boolean)) {
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
    await cmd(['RPUSH', SLOTS_HIST_KEY, JSON.stringify(rec)]);
    await cmd(['LTRIM', SLOTS_HIST_KEY, '-200', '-1']);
  }
}

export async function getSlotHistory() {
  const res = await cmd(['LRANGE', SLOTS_HIST_KEY, '0', '-1']);
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
const ROSTER_KEY = 'habits:roster';

export async function getRoster() {
  const raw = await cmd(['GET', ROSTER_KEY]);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function setRoster(doc) {
  return cmd(['SET', ROSTER_KEY, JSON.stringify(doc)]);
}

// Proactive-nudge state ({ checkedAt, lastAt, habit, slot, count }) — the
// throttle claims checkedAt BEFORE evaluating so concurrent pollers can't
// double-run the check (see nudgePass in lib/coach.js).
const NUDGE_KEY = 'habits:nudge';

export async function getNudgeState() {
  const raw = await cmd(['GET', NUDGE_KEY]);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function setNudgeState(doc) {
  return cmd(['SET', NUDGE_KEY, JSON.stringify(doc)]);
}

// Explicit "not today" dismissals ({ habit, slot, at }) — the third nudge
// outcome, which is otherwise indistinguishable from silence. Kept in its own
// list rather than folded into habits:log: a dismissal is emphatically NOT a
// tap, and anything that reads the log as "things the human did" must not see
// it (issue #35).
const NUDGE_DISMISS_KEY = 'habits:nudge:dismissed';

export async function appendDismissal(rec) {
  await cmd(['RPUSH', NUDGE_DISMISS_KEY, JSON.stringify(rec)]);
  await cmd(['LTRIM', NUDGE_DISMISS_KEY, '-200', '-1']);
}

export async function getDismissals() {
  const res = await cmd(['LRANGE', NUDGE_DISMISS_KEY, '0', '-1']);
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

// Last contact from a PHYSICAL deck ({ at, plugin, keys }). Written only when
// the Stream Deck plugin polls (it tags its request `?deck=<version>`), never
// by the dashboard or virtual deck — so "the hardware is live" is
// distinguishable from "nothing has ever connected" (issue #5).
const DECK_KEY = 'habits:deck';

export async function getDeckState() {
  const raw = await cmd(['GET', DECK_KEY]);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function setDeckState(doc) {
  return cmd(['SET', DECK_KEY, JSON.stringify(doc)]);
}

// The coach's persistent working notes (hypotheses about its human).
const MEMORY_KEY = 'habits:coach:memory';

// The human's profile/settings ({ tz, name, about, updatedAt }).
const PROFILE_KEY = 'habits:profile';

export async function getProfile() {
  const raw = await cmd(['GET', PROFILE_KEY]);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function setProfile(doc) {
  return cmd(['SET', PROFILE_KEY, JSON.stringify(doc)]);
}

// Latest daily digest written by the coach ({ text, date, model, at }).
const INSIGHT_KEY = 'habits:insight';

export async function getInsight() {
  const raw = await cmd(['GET', INSIGHT_KEY]);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function setInsight(doc) {
  return cmd(['SET', INSIGHT_KEY, JSON.stringify(doc)]);
}

export async function getCoachMemory() {
  const raw = await cmd(['GET', MEMORY_KEY]);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function setCoachMemory(doc) {
  return cmd(['SET', MEMORY_KEY, JSON.stringify(doc)]);
}

// Return every entry, oldest first.
export async function all() {
  const res = await cmd(['LRANGE', KEY, '0', '-1']);
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
