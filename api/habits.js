// GET  /api/habits          -> { habits: [{name, emoji, label}] }
// POST /api/habits          -> replace the whole list (body: {habits: [...]})
// The live habit list backing the API, coach, and virtual deck. Physical deck
// keys are baked into imported profiles — regenerate them after edits.
// HABIT_KEY (if set) gates writes via ?key= or body.key.
import { isConfigured, getSlots, getSlotHistory, all } from '../lib/store.js';
import { getHabits, saveHabits, validateHabits } from '../lib/habits.js';
import { scoreSuggestions } from '../lib/scorer.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!isConfigured()) {
      res.status(503).json({ error: 'Storage not connected.' });
      return;
    }
    if (req.method !== 'POST') {
      const habits = (await getHabits()).map((h) => ({ origin: 'human', ...h }));
      // The coach's inventions: every habit it has ever assigned to a slot,
      // with behavioral stats — so the manager can show lineage and offer
      // promotion to a fixed key.
      const [history, entries, current] = await Promise.all([
        getSlotHistory().catch(() => []),
        all().catch(() => []),
        getSlots().catch(() => ({ slots: [] }))
      ]);
      const fixedNames = new Set(habits.map((h) => h.name.toLowerCase()));
      const track = Object.fromEntries(scoreSuggestions(history, entries).perHabit.map((r) => [r.habit, r]));
      const seen = new Map();
      for (const rec of history) {
        for (const def of rec.slots || []) {
          if (!def?.habit || fixedNames.has(def.habit.toLowerCase())) continue;
          const prev = seen.get(def.habit);
          if (!prev) seen.set(def.habit, { habit: def.habit, firstAt: def.assignedAt || rec.at });
          else prev.firstAt = Math.min(prev.firstAt, def.assignedAt || rec.at);
        }
      }
      // emoji/label: newest history rec that carries them, else the current
      // slot def, else the emoji captured on tap entries.
      for (const rec of [...history].reverse()) {
        for (const def of rec.slots || []) {
          const item = def?.habit && seen.get(def.habit);
          if (item && !item.emoji && def.emoji) { item.emoji = def.emoji; item.label = def.label; }
        }
      }
      for (const d of (current.slots || []).filter(Boolean)) {
        const item = seen.get(d.habit);
        if (item && !item.emoji) { item.emoji = d.emoji; item.label = d.label; }
      }
      for (const e of entries) {
        const item = e.slot && seen.get(e.h);
        if (item && !item.emoji && e.e) item.emoji = e.e;
      }
      const activeNames = new Set((current.slots || []).filter(Boolean).map((d) => d.habit));
      const coachHabits = [...seen.values()].map((it) => ({
        ...it,
        emoji: it.emoji || '✨',
        label: it.label || it.habit,
        active: activeNames.has(it.habit),
        offered: track[it.habit]?.offered || 0,
        landed: track[it.habit]?.landed || 0,
        taps: track[it.habit]?.taps || 0
      })).sort((a, b) => (b.active - a.active) || (b.taps - a.taps));
      res.status(200).json({ habits, coachHabits });
      return;
    }
    const body = typeof req.body === 'object' && req.body ? req.body : {};
    const secret = process.env.HABIT_KEY;
    if (secret && body.key !== secret && (req.query || {}).key !== secret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const err = validateHabits(body.habits);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
    const habits = await saveHabits(body.habits);
    res.status(200).json({ ok: true, habits });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
