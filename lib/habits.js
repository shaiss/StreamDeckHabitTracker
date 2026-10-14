// Runtime habit list. Redis (habits:config) is the live source of truth,
// seeded from config/habits.json on first read; the file remains the input
// for GENERATED artifacts (icons, hardware profiles), so after editing habits
// here, physical decks need a profile regen (rebuild-artifacts skill) while
// the API, coach, and virtual deck update immediately.
import { BASE_HABITS } from './ai.js';
import { redisCmd, redisKey } from './store.js';

function configKey() {
  return redisKey('habits:config');
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

// Atomic compare-and-set over Redis REST (Upstash has no sticky WATCH connection).
// SET only if GET still equals the exact bytes we read — never clobber a concurrent
// saveHabits() custom catalog that landed between our GET and this write.
const CAS_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('set', KEYS[1], ARGV[2]) else return false end";

async function casSetIfEqual(key, expectedRaw, nextRaw) {
  return redisCmd(['EVAL', CAS_LUA, '1', key, expectedRaw, nextRaw]);
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
      const g = Number(h.goal);
      if (!Number.isInteger(g) || g < 1 || g > 99) {
        return `Habit "${name}" goal must be a whole number between 1 and 99 (omit for the default of 1).`;
      }
    }
  }
  return null;
}

export async function getHabits() {
  try {
    const key = configKey();
    const raw = await redisCmd(['GET', key]);
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
            const ok = await casSetIfEqual(key, raw, JSON.stringify(next));
            if (ok === 'OK') return next;
            // Lost the race — Redis no longer holds the seed we read. Serve
            // whatever won (custom catalog or an already-migrated seed).
            const again = await redisCmd(['GET', key]);
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
  } catch { /* fall through to the seed */ }
  return seedHabits();
}

export async function saveHabits(list) {
  const clean = list.map((h) => {
    const g = Number(h.goal);
    const item = {
      name: String(h.name),
      emoji: String(h.emoji).slice(0, 8),
      label: String(h.label).slice(0, 12),
      origin: h.origin === 'coach' ? 'coach' : 'human'
    };
    if (Number.isInteger(g) && g >= 1 && g <= 99) item.goal = g;
    return item;
  });
  await redisCmd(['SET', configKey(), JSON.stringify(clean)]);
  return clean;
}
