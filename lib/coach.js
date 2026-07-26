// The AI coach: decides what the 4 slot keys should be. Runs on a Mastra
// agent (lib/agent.js) with a hypothesis-memory tool; if the agent path fails
// at runtime, a plain z.ai call (lib/ai.js) keeps the coach speaking.
//
// Two entry points:
//  - fullSuggest(): manual refresh from the dashboard's ✨ Suggest button.
//  - reactTo(entry): fires in the background after every tap (waitUntil), so
//    the coach can respond in near real time — e.g. you tap Eat and it swaps
//    in FoodGood/FoodBad feedback keys. The slot keys are the AI's voice; the
//    Stream Deck is its interface to its human.
import { all, getSlots, setSlots } from './store.js';
import { BASE_HABITS, chat, extractJson, zaiModel } from './ai.js';
import { coachAgent, coachMemory } from './agent.js';

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

export async function fullSuggest() {
  const prev = await getSlots();
  const stats = summarize(await all());
  const { text, engine } = await ask(
    'Propose what YOU want the human to start logging next — be concrete and personal, not generic. ' +
    'Reply with ONLY JSON: {"slots":[{"habit":"OneWordId","emoji":"🪴","label":"Short","reason":"why, referencing their data"}]}\n\n' +
    'Context: ' +
    JSON.stringify({
      fixedHabits: BASE_HABITS.map((h) => `${h.emoji} ${h.name}`).join(', '),
      currentAiSlots: prev.slots.filter(Boolean).map((s) => s.habit).join(', ') || 'none',
      last14Days: stats
    })
  );
  const slots = sanitize(extractJson(text).slots);
  if (!slots.length) return null;
  while (slots.length < 4) slots.push(null);
  const doc = { slots, suggestedAt: Date.now(), reactedAt: Date.now(), model: zaiModel(), engine };
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
  const { text, engine } = await ask(
    'The human JUST tapped a key. Decide whether to repaint your slot keys in response — e.g. right after Eat ' +
    'you might want "FoodGood 👍" / "FoodBad 👎" feedback keys; after Exercise, maybe "Energized" vs "Wiped". ' +
    'Only change keys when it genuinely helps you learn; otherwise keep them. ' +
    'Reply with ONLY JSON: {"change":false} OR {"slots":[{"habit":"OneWordId","emoji":"👍","label":"Short","reason":"..."}]}\n\n' +
    'Context: ' +
    JSON.stringify({
      justTapped: { habit: entry.h, emoji: entry.e || '', viaAiSlot: Boolean(entry.slot), localHour: new Date(entry.t).getHours() },
      todayTaps: today.map((e) => ({ h: e.h, hour: new Date(e.t).getHours() })),
      currentAiSlots: prev.slots,
      fixedHabits: BASE_HABITS.map((h) => `${h.emoji} ${h.name}`).join(', '),
      last14Days: summarize(entries)
    })
  );
  const parsed = extractJson(text);
  if (!parsed || parsed.change === false || !Array.isArray(parsed.slots)) return;
  const slots = sanitize(parsed.slots);
  if (!slots.length) return;
  while (slots.length < 4) slots.push(null);
  await setSlots({ slots, suggestedAt: Date.now(), reactedAt: Date.now(), model: zaiModel(), engine });
}
