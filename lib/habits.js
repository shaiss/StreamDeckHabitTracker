// Runtime habit list. Redis (habits:config) is the live source of truth,
// seeded from config/habits.json on first read; the file remains the input
// for GENERATED artifacts (icons, hardware profiles), so after editing habits
// here, physical decks need a profile regen (rebuild-artifacts skill) while
// the API, coach, and virtual deck update immediately.
//
// `goal` is backward-compatible (#70): a plain int still means
// {target:n, setBy:'human'}; the object form carries coach metadata + pins.
import { BASE_HABITS } from './ai.js';

const KEY = 'habits:config';

// Normalize a goal field for validation / persistence. Returns null when the
// habit has no goal (default target 1 at read time), or {error} / a clean value.
export function normalizeGoalInput(goal) {
  if (goal === undefined || goal === null || goal === '') return null;
  if (typeof goal === 'object') {
    const target = Number(goal.target);
    if (!Number.isInteger(target) || target < 1 || target > 99) {
      return { error: 'goal.target must be a whole number between 1 and 99' };
    }
    const setBy = goal.setBy === 'coach' ? 'coach' : 'human';
    const out = { target, setBy };
    const reason = String(goal.reason || '').slice(0, 240);
    if (reason) out.reason = reason;
    const updatedAt = Number(goal.updatedAt);
    if (Number.isFinite(updatedAt) && updatedAt > 0) out.updatedAt = updatedAt;
    const floor = Number(goal.floor);
    const ceil = Number(goal.ceil);
    if (goal.floor !== undefined && goal.floor !== null && goal.floor !== '') {
      if (!Number.isInteger(floor) || floor < 1 || floor > 99) {
        return { error: 'goal.floor must be a whole number between 1 and 99' };
      }
      out.floor = floor;
    }
    if (goal.ceil !== undefined && goal.ceil !== null && goal.ceil !== '') {
      if (!Number.isInteger(ceil) || ceil < 1 || ceil > 99) {
        return { error: 'goal.ceil must be a whole number between 1 and 99' };
      }
      out.ceil = ceil;
    }
    if (out.floor != null && out.ceil != null && out.floor > out.ceil) {
      return { error: 'goal.floor cannot exceed goal.ceil' };
    }
    if (out.floor != null && target < out.floor) {
      return { error: 'goal.target cannot be below goal.floor' };
    }
    if (out.ceil != null && target > out.ceil) {
      return { error: 'goal.target cannot exceed goal.ceil' };
    }
    return out;
  }
  const g = Number(goal);
  if (!Number.isInteger(g) || g < 1 || g > 99) {
    return { error: 'goal must be a whole number between 1 and 99 (omit for the default of 1)' };
  }
  // Plain number stays a plain number on disk — readers treat it as human-set.
  return g;
}

// Catalog shipped before Code was added to config/habits.json (#91 / PR #92).
// A nonempty habits:config with exactly this identity is the stale seed — not
// a human-edited roster — so getHabits() may replace it once with BASE_HABITS.
// Intentionally custom catalogs (any other length, order, name, emoji, or
// label) are left untouched; we never blind-merge BASE_HABITS into Redis.
export const PREVIOUS_SEED = Object.freeze([
  { name: 'Pee', emoji: '🚽', label: 'Pee' },
  { name: 'Poop', emoji: '💩', label: 'Poop' },
  { name: 'Eat', emoji: '🍽', label: 'Eat' },
  { name: 'Drink', emoji: '💧', label: 'Drink' },
  { name: 'Exercise', emoji: '🏃', label: 'Exercise' },
  { name: 'Cannabis', emoji: '🌿', label: 'Cannabis' },
  { name: 'Caffeine', emoji: '✨', label: 'Caffeine' },
  { name: 'Cook', emoji: '🍳', label: 'Cook' }
]);

export function seedHabits() {
  return BASE_HABITS.map((h) => ({ name: h.name, emoji: h.emoji, label: h.label }));
}

/** True when list is the pre-Code seed (origin/goal extras ignored). */
export function isPreviousSeed(list) {
  if (!Array.isArray(list) || list.length !== PREVIOUS_SEED.length) return false;
  return PREVIOUS_SEED.every((seed, i) => {
    const h = list[i];
    return h && h.name === seed.name && h.emoji === seed.emoji && h.label === seed.label;
  });
}

async function cmd(args) {
  const url =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  if (!res.ok) throw new Error(`store ${res.status}`);
  return (await res.json()).result;
}

// Atomic compare-and-set over Redis REST (Upstash has no sticky WATCH connection).
// SET only if GET still equals the exact bytes we read — never clobber a concurrent
// saveHabits() custom catalog that landed between our GET and this write.
const CAS_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('set', KEYS[1], ARGV[2]) else return false end";

async function casSetIfEqual(key, expectedRaw, nextRaw) {
  return cmd(['EVAL', CAS_LUA, '1', key, expectedRaw, nextRaw]);
}

export function validateHabits(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 10) {
    return 'Between 1 and 10 habits.';
  }
  const seen = new Set();
  for (const h of list) {
    const name = String(h?.name || '');
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(name)) {
      return `Bad habit id "${name}" — start with a letter, letters/digits only, max 20 chars, no spaces.`;
    }
    if (seen.has(name.toLowerCase())) return `Duplicate habit "${name}".`;
    seen.add(name.toLowerCase());
    if (!h.emoji || String(h.emoji).length > 8) return `Habit "${name}" needs an emoji.`;
    if (!h.label || String(h.label).length > 12) return `Habit "${name}" needs a label (max 12 chars).`;
    if (h.origin !== undefined && !['human', 'coach'].includes(h.origin)) {
      return `Habit "${name}" has an unknown origin.`;
    }
    if (h.goal !== undefined) {
      const g = normalizeGoalInput(h.goal);
      if (g && g.error) return `Habit "${name}" ${g.error}.`;
    }
  }
  return null;
}

// Strict read for write paths (target pass / approve-dismiss). Store errors
// MUST propagate — getHabits() swallowing them as seedHabits() would let a
// later saveHabits() overwrite a custom roster after a temporary Redis blip.
// Empty/missing key still falls back to the seed catalog (first-boot case).
export async function getHabitsStrict() {
  const raw = await cmd(['GET', KEY]);
  if (raw) {
    const list = JSON.parse(raw);
    if (Array.isArray(list) && list.length) {
      // One-time seed bump: only the exact previous eight-entry catalog is
      // rewritten so profile hkey=9 (Code) resolves. Custom rosters stay.
      // Migration write is CAS on the exact GET bytes so a concurrent
      // saveHabits() cannot be overwritten by a late unconditional SET.
      if (isPreviousSeed(list)) {
        const next = seedHabits();
        try {
          const ok = await casSetIfEqual(KEY, raw, JSON.stringify(next));
          if (ok === 'OK') return next;
          // Lost the race — Redis no longer holds the seed we read. Serve
          // whatever won (custom catalog or an already-migrated seed).
          const again = await cmd(['GET', KEY]);
          if (again) {
            const cur = JSON.parse(again);
            if (Array.isArray(cur) && cur.length) return cur;
          }
        } catch { /* still serve the migrated list this request */ }
        return next;
      }
      return list;
    }
  }
  return seedHabits();
}

// Soft read for dashboards / logging — seed fallback on any store failure so
// a blip does not 500 the UI. Never use this before saveHabits().
export async function getHabits() {
  try {
    return await getHabitsStrict();
  } catch { /* fall through to the seed */ }
  return seedHabits();
}

export async function saveHabits(list) {
  const clean = list.map((h) => {
    const item = {
      name: String(h.name),
      emoji: String(h.emoji).slice(0, 8),
      label: String(h.label).slice(0, 12),
      origin: h.origin === 'coach' ? 'coach' : 'human'
    };
    const g = normalizeGoalInput(h.goal);
    if (g && !g.error) item.goal = g;
    return item;
  });
  await cmd(['SET', KEY, JSON.stringify(clean)]);
  return clean;
}
