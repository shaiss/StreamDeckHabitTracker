// The AI coach: decides what the 4 slot keys should be. Two entry points:
//  - fullSuggest(): manual refresh from the dashboard's ✨ Suggest button.
//  - reactTo(entry): fires in the background after every tap (waitUntil), so
//    the coach can respond in near real time — e.g. you tap Eat and it swaps
//    in FoodGood/FoodBad feedback keys. The slot keys are the AI's voice; the
//    Stream Deck is its interface to its human.
import { all, getSlots, setSlots } from './store.js';
import { BASE_HABITS, chat, extractJson, zaiModel } from './ai.js';

export const REACT_COOLDOWN_MS = 45_000;

export function summarize(entries, days = 14) {
  const cutoff = Date.now() - days * 86400_000;
  const recent = entries.filter((e) => e.t >= cutoff);
  const perHabit = {};
  for (const e of recent) {
    const s = (perHabit[e.h] ||= { taps: 0, hours: {}, days: new Set() });
    s.taps++;
    const d = new Date(e.t);
    s.hours[d.getHours()] = (s.hours[d.getHours()] || 0) + 1;
    s.days.add(d.toISOString().slice(0, 10));
  }
  return {
    daysOfData: new Set(recent.map((e) => new Date(e.t).toISOString().slice(0, 10))).size,
    totalTaps: recent.length,
    habits: Object.fromEntries(
      Object.entries(perHabit).map(([h, s]) => [
        h,
        {
          taps: s.taps,
          activeDays: s.days.size,
          topHours: Object.entries(s.hours).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h2]) => +h2)
        }
      ])
    )
  };
}

export function sanitize(items) {
  const seen = new Set(BASE_HABITS.map((h) => h.name.toLowerCase()));
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (out.length >= 4 || !it || typeof it !== 'object') break;
    const habit = String(it.habit || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
    if (!habit || seen.has(habit.toLowerCase())) continue;
    seen.add(habit.toLowerCase());
    out.push({
      habit,
      emoji: String(it.emoji || '✨').slice(0, 8),
      label: String(it.label || habit).slice(0, 12),
      reason: String(it.reason || '').slice(0, 160),
      assignedAt: Date.now()
    });
  }
  return out;
}

const SYSTEM = (mode) =>
  'You are the AI coach living inside a personal habit tracker. The human logs habits by tapping physical Stream Deck keys. ' +
  'You control up to 4 extra keys — they are your ONLY voice to the human, your gateway for interacting with them. ' +
  'Use them to ask for feedback, close gaps in your understanding, or test hypotheses about their day. ' +
  (mode === 'react'
    ? 'The human JUST tapped a key. Decide whether to repaint your keys in response — e.g. right after Eat you might want ' +
      '"FoodGood 👍" / "FoodBad 👎" feedback keys for the next hour; after Exercise, maybe "Energized" vs "Wiped". ' +
      'Only change keys when it genuinely helps you learn; otherwise keep them. ' +
      'Reply with ONLY JSON: {"change":false} OR {"slots":[{"habit":"OneWordId","emoji":"👍","label":"Short","reason":"..."}]}. '
    : 'Propose what YOU want the human to start logging next. Be concrete and personal, not generic. ' +
      'Reply with ONLY JSON: {"slots":[{"habit":"OneWordId","emoji":"🪴","label":"Short","reason":"why, referencing their data"}]}. ') +
  'Rules: 1-4 items; habit must be a single CamelCase word (letters/digits, max 20 chars), never duplicating the fixed habits; ' +
  'label max 10 chars; exactly one emoji per item; a full slots array replaces ALL current slots.';

export async function fullSuggest() {
  const prev = await getSlots();
  const stats = summarize(await all());
  const content = await chat(
    [
      { role: 'system', content: SYSTEM('full') },
      {
        role: 'user',
        content: JSON.stringify({
          fixedHabits: BASE_HABITS.map((h) => `${h.emoji} ${h.name}`).join(', '),
          currentAiSlots: prev.slots.filter(Boolean).map((s) => s.habit).join(', ') || 'none',
          last14Days: stats
        })
      }
    ],
    { temperature: 0.9 }
  );
  const slots = sanitize(extractJson(content).slots);
  if (!slots.length) return null;
  while (slots.length < 4) slots.push(null);
  const doc = { slots, suggestedAt: Date.now(), reactedAt: Date.now(), model: zaiModel() };
  await setSlots(doc);
  return doc;
}

// Background pass after a tap. Never throws to the caller; failures just mean
// the keys stay as they were.
export async function reactTo(entry) {
  const prev = await getSlots();
  if (Date.now() - (prev.reactedAt || 0) < REACT_COOLDOWN_MS) return;
  // Claim the window first so concurrent taps don't double-fire the model.
  await setSlots({ ...prev, reactedAt: Date.now() });

  const entries = await all();
  const today = entries.filter((e) => new Date(e.t).toDateString() === new Date().toDateString());
  const content = await chat(
    [
      { role: 'system', content: SYSTEM('react') },
      {
        role: 'user',
        content: JSON.stringify({
          justTapped: { habit: entry.h, emoji: entry.e || '', viaAiSlot: Boolean(entry.slot), localHour: new Date(entry.t).getHours() },
          todayTaps: today.map((e) => ({ h: e.h, hour: new Date(e.t).getHours() })),
          currentAiSlots: prev.slots,
          fixedHabits: BASE_HABITS.map((h) => `${h.emoji} ${h.name}`).join(', '),
          last14Days: summarize(entries)
        })
      }
    ],
    { temperature: 0.8 }
  );
  const parsed = extractJson(content);
  if (!parsed || parsed.change === false || !Array.isArray(parsed.slots)) return;
  const slots = sanitize(parsed.slots);
  if (!slots.length) return;
  while (slots.length < 4) slots.push(null);
  await setSlots({ slots, suggestedAt: Date.now(), reactedAt: Date.now(), model: zaiModel() });
}
