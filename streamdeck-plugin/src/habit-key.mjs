// Where the Stream Deck plugin gets its HABIT_KEY, and how it sends it.
//
// Source of truth: the plugin's GLOBAL settings ({ habitKey }), entered once
// in the Property Inspector (ui/settings.html) and stored by the Stream Deck
// app on this machine. Nothing in git, the bundled profile, the manifest, or
// the .streamDeckPlugin zip ever carries it.
//
// Fallback: a per-key settings.key from an older, locally generated profile
// (node tools/generate.mjs … --plugin --key=<SECRET>). Still honored so those
// decks keep working, but it is sent the same way — as a header.
//
// Transport: the x-habit-key request header only. The key never rides in a
// URL, so it cannot leak through request logs or error messages.
export const KEY_HEADER = 'x-habit-key';

// The key may only travel to HabitDeck's own origins (Cipher M1). A per-key
// profile can name ANY base, so without this pin the shared global key would
// be handed to whatever host a hostile or mistyped profile points at. Exact
// origin match, https only — a lookalike such as habitdeck.fyi.evil.com, an
// http:// downgrade, an odd port, or userinfo tricks all get no key.
export const KEY_ORIGINS = Object.freeze([
  'https://stream-deck-habit-tracker.vercel.app',
  'https://habitdeck.fyi'
]);

export function keyAllowedFor(base) {
  if (typeof base !== 'string' || !base) return false;
  let u;
  try { u = new URL(base); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  return KEY_ORIGINS.includes(u.origin);
}

// `base` is the URL the request is about to go to. No base, or one outside
// KEY_ORIGINS, means no key at all — global or per-key.
export function resolveKey(globalSettings, settings, base) {
  if (!keyAllowedFor(base)) return '';
  const g = globalSettings && typeof globalSettings.habitKey === 'string' ? globalSettings.habitKey.trim() : '';
  if (g) return g;
  const s = settings && typeof settings.key === 'string' ? settings.key.trim() : '';
  return s;
}

export function keyedInit(key, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (key) headers[KEY_HEADER] = key;
  return { ...init, headers };
}

export { redactKey } from '../../lib/habit-key.js';
