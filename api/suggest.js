// POST /api/suggest -> asks the LLM (z.ai GLM) to fill the AI slot keys.
// The model sees the fixed habits plus a compact summary of recent taps and
// proposes up to 4 new things worth tracking — where it wants more signal
// about the human's day. Results are stored; slot keys resolve to them at
// tap time, and the Stream Deck plugin repaints slot key faces to match.
import { all, getSlots, setSlots, isConfigured } from '../lib/store.js';
import { BASE_HABITS, chat, extractJson, zaiKey, zaiModel } from '../lib/ai.js';

const COOLDOWN_MS = 30_000;

function summarize(entries) {
  const cutoff = Date.now() - 14 * 86400_000;
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

function sanitize(items) {
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'POST here to refresh AI suggestions.' });
      return;
    }
    const secret = process.env.HABIT_KEY;
    if (secret && (req.query || {}).key !== secret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!zaiKey()) {
      res.status(503).json({
        error:
          'No AI key set. In Vercel: project -> Settings -> Environment Variables -> add ZAI_API_KEY (from z.ai), then redeploy.'
      });
      return;
    }
    if (!isConfigured()) {
      res.status(503).json({ error: 'Storage not connected.' });
      return;
    }

    const prev = await getSlots();
    if (Date.now() - prev.suggestedAt < COOLDOWN_MS) {
      res.status(429).json({ error: 'Just refreshed — try again in half a minute.', slots: prev.slots });
      return;
    }

    const stats = summarize(await all());
    const fixed = BASE_HABITS.map((h) => `${h.emoji} ${h.name}`).join(', ');
    const current = prev.slots.filter(Boolean).map((s) => s.habit).join(', ') || 'none';

    const content = await chat(
      [
        {
          role: 'system',
          content:
            'You are the AI coach living inside a personal habit tracker. The human logs habits by tapping physical Stream Deck keys. ' +
            'You control up to 4 extra keys. Propose what YOU want the human to start logging — things that would give you more signal ' +
            'about their day, close gaps in the data, or test a hypothesis about their wellbeing. Be concrete and personal, not generic. ' +
            'Reply with ONLY a JSON object, no prose, shaped exactly like: ' +
            '{"slots":[{"habit":"OneWordId","emoji":"🪴","label":"Short label","reason":"why you want this tracked, referencing their data"}]} ' +
            'Rules: 1-4 items; habit must be a single CamelCase word (letters/digits only, max 20 chars) and must not duplicate existing habits; ' +
            'label max 10 chars; exactly one emoji per item.'
        },
        {
          role: 'user',
          content: JSON.stringify({
            fixedHabits: fixed,
            currentAiSlots: current,
            last14Days: stats
          })
        }
      ],
      { temperature: 0.9 }
    );

    const slots = sanitize(extractJson(content).slots);
    if (!slots.length) {
      res.status(502).json({ error: 'Model returned no usable suggestions — try again.' });
      return;
    }
    while (slots.length < 4) slots.push(null);
    const doc = { slots, suggestedAt: Date.now(), model: zaiModel() };
    await setSlots(doc);
    res.status(200).json(doc);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
