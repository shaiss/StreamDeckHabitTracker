// GET  /api/habits          -> { habits: [{name, emoji, label}] }
// POST /api/habits          -> replace the whole list (body: {habits: [...]})
// The live habit list backing the API, coach, and virtual deck. Physical deck
// keys are baked into imported profiles — regenerate them after edits.
// HABIT_KEY (if set) gates writes via ?key= or body.key.
import { isConfigured } from '../lib/store.js';
import { getHabits, saveHabits, validateHabits } from '../lib/habits.js';

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
      res.status(200).json({ habits: await getHabits() });
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
