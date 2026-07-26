// GET/POST /api/log?habit=NAME[&note=...][&key=SECRET]  -> logs a fixed habit
// GET/POST /api/log?slot=N                              -> logs whatever habit
//   the AI currently has assigned to slot N (1-4); the habit name and emoji
//   are captured at tap time so history stays truthful after a swap.
// Returns plain text (handy when testing in a browser).
import { append, getSlots, isConfigured } from '../lib/store.js';
import { BASE_HABITS } from '../lib/ai.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const q = req.query || {};

    // Optional shared secret. Set HABIT_KEY in the Vercel project env to require it.
    const secret = process.env.HABIT_KEY;
    if (secret && q.key !== secret) {
      res.status(401).send('Unauthorized');
      return;
    }

    if (!isConfigured()) {
      res
        .status(503)
        .send('Storage not connected yet. In Vercel: Storage -> create Upstash/KV -> connect to this project, then redeploy.');
      return;
    }

    const slotNum = parseInt(q.slot, 10);
    let habit = (q.habit || '').toString().trim();
    let emoji = '';
    let slotField;

    if (!habit && slotNum >= 1 && slotNum <= 4) {
      const { slots } = await getSlots();
      const def = slots[slotNum - 1];
      if (!def) {
        res.status(409).send(`Slot ${slotNum} is empty — tap ✨ Suggest on the dashboard to let the AI fill it.`);
        return;
      }
      habit = def.habit;
      emoji = def.emoji || '';
      slotField = slotNum;
    } else if (habit) {
      emoji = BASE_HABITS.find((h) => h.name === habit)?.emoji || '';
    }

    if (!habit) {
      res.status(400).send('Missing habit');
      return;
    }

    const entry = { h: habit, t: Date.now(), note: (q.note || '').toString() };
    if (emoji) entry.e = emoji;
    if (slotField) entry.slot = slotField;
    await append(entry);
    res.status(200).send('Logged: ' + habit);
  } catch (err) {
    res.status(500).send('Error: ' + (err && err.message ? err.message : err));
  }
}
