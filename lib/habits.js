// Runtime habit list. Redis (habits:config) is the live source of truth,
// seeded from config/habits.json on first read; the file remains the input
// for GENERATED artifacts (icons, hardware profiles), so after editing habits
// here, physical decks need a profile regen (rebuild-artifacts skill) while
// the API, coach, and virtual deck update immediately.
import { BASE_HABITS } from './ai.js';

const KEY = 'habits:config';

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
  }
  return null;
}

export async function getHabits() {
  try {
    const raw = await cmd(['GET', KEY]);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length) return list;
    }
  } catch { /* fall through to the seed */ }
  return BASE_HABITS.map((h) => ({ name: h.name, emoji: h.emoji, label: h.label }));
}

export async function saveHabits(list) {
  const clean = list.map((h) => ({
    name: String(h.name),
    emoji: String(h.emoji).slice(0, 8),
    label: String(h.label).slice(0, 12),
    origin: h.origin === 'coach' ? 'coach' : 'human'
  }));
  await cmd(['SET', KEY, JSON.stringify(clean)]);
  return clean;
}
