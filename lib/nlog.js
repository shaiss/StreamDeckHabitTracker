// Natural-language logging: turn a free-text report — "walked 20 min and had
// a big lunch this morning" — into habit log entries. Two halves, kept apart
// on purpose: parseNl() asks the model for a PROPOSAL and never writes;
// sanitizeNlEntries() is the pure gate every entry passes before it reaches
// the log, whether it arrived from the model or from the confirm round-trip.
// Only habits that already exist (roster + live AI slots) can be logged — the
// parser never invents keys; everything else lands in "unmatched".
import { chat, extractJson } from './ai.js';
import { getSlots, getProfile } from './store.js';
import { getHabits } from './habits.js';
import { tzHelpers } from './tz.js';

export const MAX_ENTRIES = 8;
export const MAX_BACKDATE_HOURS = 48;
export const MAX_TEXT = 500;

// Pure (context) -> string, like lib/coach.js PROMPTS, so tests can pin it.
export const NL_PROMPT = (c) =>
  'Your human is telling you, their habit coach, what they did, in plain language. ' +
  'Translate it into log entries against their EXISTING keys only. ' +
  `Keys: ${JSON.stringify(c.keys)}. ` +
  `Local time now: ${c.localTime} (${c.timezone}). ` +
  'Rules: one entry per distinct occurrence (did it twice = two entries); "habit" must be a key ' +
  '"name" from the list — never invent one; activities with no matching key go in "unmatched" verbatim; ' +
  `time hints ("this morning", "after lunch", "yesterday evening") become "hoursAgo" (1-${MAX_BACKDATE_HOURS}, ` +
  'omit when it just happened); specifics (minutes, reps, what/how it went) go in "note", short. ' +
  'Reply with ONLY JSON: ' +
  '{"entries":[{"habit":"Exercise","note":"20 min walk","hoursAgo":3}],"unmatched":["haircut"],"reply":"one short warm sentence to your human"}\n\n' +
  'Human wrote: ' + JSON.stringify(c.text);

// keys: [{name, emoji, label}] — the loggable universe. Accepts model output
// ({habit, note, hoursAgo}) and confirm round-trips ({h, note, t}); habit
// names match case-insensitively, by name first, then label. Timestamps are
// clamped into [now - MAX_BACKDATE_HOURS, now].
export function sanitizeNlEntries(parsed, keys, now = Date.now()) {
  const byId = new Map();
  for (const k of Array.isArray(keys) ? keys : []) {
    if (k?.name) byId.set(String(k.name).toLowerCase(), k);
  }
  for (const k of Array.isArray(keys) ? keys : []) {
    const label = String(k?.label || '').toLowerCase();
    if (k?.name && label && !byId.has(label)) byId.set(label, k);
  }
  const oldest = now - MAX_BACKDATE_HOURS * 3600_000;
  const out = [];
  for (const it of Array.isArray(parsed?.entries) ? parsed.entries : []) {
    if (out.length >= MAX_ENTRIES) break;
    if (!it || typeof it !== 'object') continue;
    const key = byId.get(String(it.habit ?? it.h ?? '').trim().toLowerCase());
    if (!key) continue;
    const entry = { h: key.name, t: now, note: String(it.note || '').slice(0, 120), nl: 1 };
    const t = Number(it.t);
    const hrs = Number(it.hoursAgo);
    if (Number.isFinite(t) && t > 0) entry.t = Math.min(Math.max(t, oldest), now);
    else if (Number.isFinite(hrs) && hrs > 0) entry.t = now - Math.min(hrs, MAX_BACKDATE_HOURS) * 3600_000;
    if (key.emoji) entry.e = key.emoji;
    out.push(entry);
  }
  const unmatched = (Array.isArray(parsed?.unmatched) ? parsed.unmatched : [])
    .map((u) => String(u).slice(0, 40))
    .filter(Boolean)
    .slice(0, 6);
  return { entries: out, unmatched, reply: String(parsed?.reply || '').slice(0, 240) };
}

// What can be logged right now: the human's roster plus whatever the coach
// currently has on its slot keys (an NL log of a slot habit counts toward the
// coach's track record the same way a key tap would — the human did the thing).
export async function loggableKeys() {
  const [habits, { slots }] = await Promise.all([getHabits(), getSlots()]);
  const keys = habits.map((h) => ({ name: h.name, emoji: h.emoji || '', label: h.label || '' }));
  const seen = new Set(keys.map((k) => k.name.toLowerCase()));
  for (const s of slots) {
    if (s?.habit && !seen.has(s.habit.toLowerCase())) {
      seen.add(s.habit.toLowerCase());
      keys.push({ name: s.habit, emoji: s.emoji || '', label: s.label || '', ai: true });
    }
  }
  return keys;
}

export async function parseNl(text) {
  const [keys, profile] = await Promise.all([loggableKeys(), getProfile().catch(() => null)]);
  const tzh = tzHelpers(profile?.tz);
  const localTime = new Intl.DateTimeFormat('en-US', {
    timeZone: tzh.tz, weekday: 'short', hour: 'numeric', minute: '2-digit'
  }).format(new Date());
  const context = {
    keys: keys.map((k) => ({ name: k.name, label: k.label, ...(k.ai ? { ai: true } : {}) })),
    localTime,
    timezone: tzh.tz,
    text: String(text).slice(0, MAX_TEXT)
  };
  // Parsing wants determinism, not creativity — low temperature, plain chat()
  // (no agent/memory: this is a translator, not a coach pass).
  const raw = await chat([{ role: 'user', content: NL_PROMPT(context) }], { temperature: 0.2 });
  return sanitizeNlEntries(extractJson(raw), keys);
}
