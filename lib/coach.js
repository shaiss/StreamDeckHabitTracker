// The AI coach: decides what the 4 slot keys should be. Runs on a Mastra
// agent (lib/agent.js) with a hypothesis-memory tool; if the agent path fails
// at runtime, a plain z.ai call (lib/ai.js) keeps the coach speaking.
//
// Every pass sees: the human's profile (name/about/timezone from settings),
// its own hypothesis notes, and its behavioral track record — which past slot
// keys the human actually tapped vs ignored (lib/scorer.js). That last loop
// is how the coach learns what lands (issue #6).
import { all, getSlots, setSlots, setInsight, getProfile, getSlotHistory } from './store.js';
import { BASE_HABITS, chat, extractJson, zaiModel } from './ai.js';
import { coachAgent, coachMemory } from './agent.js';
import { tzHelpers } from './tz.js';
import { scoreSuggestions } from './scorer.js';

export const REACT_COOLDOWN_MS = 45_000;
const REACTIVE_TTL_MS = 2 * 3600_000; // feedback keys from reactive passes expire

export function summarize(entries, tzh, days = 14) {
  const cutoff = Date.now() - days * 86400_000;
  const recent = entries.filter((e) => e.t >= cutoff);
  const perHabit = {};
  for (const e of recent) {
    const s = (perHabit[e.h] ||= { taps: 0, hours: {}, days: new Set() });
    s.taps++;
    s.hours[tzh.hour(e.t)] = (s.hours[tzh.hour(e.t)] || 0) + 1;
    s.days.add(tzh.day(e.t));
  }
  return {
    timezone: tzh.tz,
    daysOfData: new Set(recent.map((e) => tzh.day(e.t))).size,
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

export function sanitize(items, { defaultTtlMs = 0 } = {}) {
  const seen = new Set(BASE_HABITS.map((h) => h.name.toLowerCase()));
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (out.length >= 4 || !it || typeof it !== 'object') break;
    const habit = String(it.habit || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
    if (!habit || seen.has(habit.toLowerCase())) continue;
    seen.add(habit.toLowerCase());
    const def = {
      habit,
      emoji: String(it.emoji || '✨').slice(0, 8),
      label: String(it.label || habit).slice(0, 12),
      reason: String(it.reason || '').slice(0, 160),
      assignedAt: Date.now()
    };
    // The model may scope a key in time (ttlMinutes 15min..12h); reactive
    // feedback keys get a default TTL so they don't squat a slot all day.
    const ttlMin = Number(it.ttlMinutes);
    if (ttlMin >= 15 && ttlMin <= 720) def.expiresAt = Date.now() + ttlMin * 60_000;
    else if (defaultTtlMs > 0) def.expiresAt = Date.now() + defaultTtlMs;
    out.push(def);
  }
  return out;
}

// Shared per-pass context: profile, tz helpers, entries, track record.
async function gather() {
  const [profile, entries, history] = await Promise.all([
    getProfile().catch(() => null),
    all(),
    getSlotHistory().catch(() => [])
  ]);
  const tzh = tzHelpers(profile?.tz);
  const track = scoreSuggestions(history, entries);
  return {
    tzh,
    entries,
    human: {
      name: profile?.name || '',
      about: profile?.about || '',
      timezone: tzh.tz
    },
    trackRecord: {
      note: 'Keys you offered before and whether the human actually tapped them. Drop asks that keep getting ignored; build on what lands.',
      ...track
    }
  };
}

// Ask the coach. Tries the Mastra agent first; falls back to a plain z.ai
// call with the same content so a framework hiccup never silences the coach.
async function ask(request) {
  const memory = await coachMemory().catch(() => '(memory unavailable)');
  const prompt = `${request}\n\nYour previous hypothesis notes:\n${memory}`;
  try {
    const res = await coachAgent().generate(prompt);
    const text = typeof res === 'string' ? res : res?.text;
    if (!text || !text.trim()) throw new Error('agent returned no text');
    return { text, engine: 'mastra' };
  } catch (err) {
    const text = await chat([{ role: 'user', content: prompt }], { temperature: 0.8 });
    return { text, engine: 'fallback:' + String(err?.message || err).slice(0, 80) };
  }
}

async function commitSlots(items, engine, { defaultTtlMs = 0 } = {}) {
  const slots = sanitize(items, { defaultTtlMs });
  if (!slots.length) return null;
  while (slots.length < 4) slots.push(null);
  const doc = { slots, suggestedAt: Date.now(), reactedAt: Date.now(), model: zaiModel(), engine };
  await setSlots(doc);
  return doc;
}

export async function fullSuggest() {
  const prev = await getSlots();
  const ctx = await gather();
  const { text, engine } = await ask(
    'Propose what YOU want the human to start logging next — be concrete and personal, not generic. ' +
    'You may add "ttlMinutes" (15-720) to time-scoped keys. ' +
    'Reply with ONLY JSON: {"slots":[{"habit":"OneWordId","emoji":"🪴","label":"Short","reason":"why, referencing their data"}]}\n\n' +
    'Context: ' +
    JSON.stringify({
      human: ctx.human,
      fixedHabits: BASE_HABITS.map((h) => `${h.emoji} ${h.name}`).join(', '),
      currentAiSlots: prev.slots.filter(Boolean).map((s) => s.habit).join(', ') || 'none',
      trackRecord: ctx.trackRecord,
      last14Days: summarize(ctx.entries, ctx.tzh)
    })
  );
  return commitSlots(extractJson(text).slots, engine);
}

// Background pass after a tap. Never throws to the caller; failures just mean
// the keys stay as they were.
export async function reactTo(entry) {
  const prev = await getSlots();
  if (Date.now() - (prev.reactedAt || 0) < REACT_COOLDOWN_MS) return;
  // Claim the window first so concurrent taps don't double-fire the model.
  await setSlots({ ...prev, reactedAt: Date.now() });

  const ctx = await gather();
  const today = ctx.entries.filter((e) => ctx.tzh.day(e.t) === ctx.tzh.day(Date.now()));
  const { text, engine } = await ask(
    'The human JUST tapped a key. Decide whether to repaint your slot keys in response — e.g. right after Eat ' +
    'you might want "FoodGood 👍" / "FoodBad 👎" feedback keys; after Exercise, maybe "Energized" vs "Wiped". ' +
    'Only change keys when it genuinely helps you learn; otherwise keep them. ' +
    'You may add "ttlMinutes" (15-720) to any slot that should expire, e.g. a meal-feedback key. ' +
    'Reply with ONLY JSON: {"change":false} OR {"slots":[{"habit":"OneWordId","emoji":"👍","label":"Short","reason":"..."}]}\n\n' +
    'Context: ' +
    JSON.stringify({
      human: ctx.human,
      justTapped: { habit: entry.h, emoji: entry.e || '', viaAiSlot: Boolean(entry.slot), localHour: ctx.tzh.hour(entry.t) },
      todayTaps: today.map((e) => ({ h: e.h, hour: ctx.tzh.hour(e.t) })),
      currentAiSlots: prev.slots,
      fixedHabits: BASE_HABITS.map((h) => `${h.emoji} ${h.name}`).join(', '),
      trackRecord: ctx.trackRecord,
      last14Days: summarize(ctx.entries, ctx.tzh)
    })
  );
  const parsed = extractJson(text);
  if (!parsed || parsed.change === false || !Array.isArray(parsed.slots)) return;
  await commitSlots(parsed.slots, engine, { defaultTtlMs: REACTIVE_TTL_MS });
}

// Scheduled morning pass (cron): set the day's keys before the human wakes.
export async function morningPass() {
  const prev = await getSlots();
  const ctx = await gather();
  const yesterday = ctx.entries.filter((e) => ctx.tzh.day(e.t) === ctx.tzh.day(Date.now() - 86400_000));
  const { text, engine } = await ask(
    `It is morning for your human (timezone ${ctx.tzh.tz}). Review yesterday, your notes, and your track ` +
    'record, then set the keys you want active for the day ahead. You may add "ttlMinutes" (15-720) to ' +
    'time-scoped keys. ' +
    'Reply with ONLY JSON: {"slots":[{"habit":"OneWordId","emoji":"🌅","label":"Short","reason":"..."}]}\n\n' +
    'Context: ' +
    JSON.stringify({
      human: ctx.human,
      fixedHabits: BASE_HABITS.map((h) => `${h.emoji} ${h.name}`).join(', '),
      currentAiSlots: prev.slots,
      yesterdayTaps: yesterday.map((e) => ({ h: e.h, hour: ctx.tzh.hour(e.t) })),
      trackRecord: ctx.trackRecord,
      last14Days: summarize(ctx.entries, ctx.tzh)
    })
  );
  return commitSlots(extractJson(text).slots, engine);
}

// Scheduled daily digest (cron): a short insight for the dashboard.
export async function dailyDigest() {
  const ctx = await gather();
  const today = ctx.entries.filter((e) => ctx.tzh.day(e.t) === ctx.tzh.day(Date.now()));
  const { text, engine } = await ask(
    'Write your end-of-day note to your human: 2-3 sentences — what you observed today, one pattern or ' +
    'hypothesis, and what you are watching for tomorrow. Warm, specific, no filler. Address them by name ' +
    'if you know it. ' +
    'Reply with ONLY JSON: {"insight":"..."}\n\n' +
    'Context: ' +
    JSON.stringify({
      human: ctx.human,
      todayTaps: today.map((e) => ({ h: e.h, hour: ctx.tzh.hour(e.t) })),
      trackRecord: ctx.trackRecord,
      last14Days: summarize(ctx.entries, ctx.tzh)
    })
  );
  const insight = String(extractJson(text).insight || '').slice(0, 600);
  if (!insight) return null;
  const doc = { text: insight, date: ctx.tzh.day(Date.now()), model: zaiModel(), engine, at: Date.now() };
  await setInsight(doc);
  return doc;
}
