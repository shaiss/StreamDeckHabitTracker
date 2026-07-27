// GET/POST /api/log?habit=NAME[&note=...][&key=SECRET]  -> logs a fixed habit
// GET/POST /api/log?slot=N                              -> logs whatever habit
//   the AI currently has assigned to slot N; one integer namespace (#52):
//   1-4 resolve the front page (habits:slots), 5-16 resolve coach-page index
//   N-5 (habits:coach:page). The habit name and emoji are captured at tap
//   time so history stays truthful after a swap.
// ...&intensity=high|low  -> tags how much of it there was ("big meal" vs
//   "snack"). The deck's double-tap gesture sends high (issue #33).
// DELETE /api/log?... (or ...&undo=1) -> removes today's most recent entry for
//   that key. The long-press "oops" affordance: no dialog, no confirmation.
// Returns plain text (handy when testing in a browser).
import { waitUntil } from '@vercel/functions';
import { append, removeLast, getSlots, getCoachPage, getProfile, isConfigured } from '../lib/store.js';
import { zaiKey } from '../lib/ai.js';
import { getHabits } from '../lib/habits.js';
import { reactTo, answerQuestion } from '../lib/coach.js';
import { tzHelpers } from '../lib/tz.js';

// Only two levels, because only two are expressible on a key: a plain tap
// means "normal" (no field at all) and a double-tap means "big". `low` exists
// for the virtual deck and future gestures; anything else is dropped rather
// than stored, so this field never becomes a free-text side channel.
const INTENSITIES = new Set(['high', 'low']);

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Undo is a DELETE, which is not a "simple" cross-origin request — without
  // these an in-browser caller from another origin gets stopped at preflight.
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
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
    const hkeyNum = parseInt(q.hkey, 10);
    let habit = (q.habit || '').toString().trim();
    let emoji = '';
    let slotField;
    let questionDef = null;   // set when this slot is one half of a 👍/👎 pair

    // ?hkey=N: positional habit key — resolve which habit currently lives at
    // that position (habit manager can change it any time), like AI slots.
    if (!habit && hkeyNum >= 1 && hkeyNum <= 10) {
      const list = await getHabits();
      const def = list[hkeyNum - 1];
      if (!def) {
        res.status(409).send(`No habit at key ${hkeyNum} — add one on the Habits page.`);
        return;
      }
      habit = def.name;
      emoji = def.emoji || '';
    }

    if (!habit && slotNum >= 1 && slotNum <= 16) {
      // One resolution path for both pages: 1..4 are the front keys, 5..16
      // index the coach page at N-5 (#52). Resolution happens at tap time and
      // the name+emoji are stored, so history stays truthful after a swap —
      // same contract either page.
      const def = slotNum <= 4
        ? (await getSlots()).slots[slotNum - 1]
        : (await getCoachPage()).slots[slotNum - 5];
      if (!def) {
        res.status(409).send(`Slot ${slotNum} is empty — tap ✨ Suggest on the dashboard to let the AI fill it.`);
        return;
      }
      habit = def.habit;
      emoji = def.emoji || '';
      slotField = slotNum;
      questionDef = def.qid ? def : null;
    } else if (habit) {
      emoji = (await getHabits()).find((h) => h.name === habit)?.emoji || '';
    }

    if (!habit) {
      res.status(400).send('Missing habit');
      return;
    }

    // Undo: drop today's most recent entry for this habit. "Today" is the
    // human's local day (profile tz), the same boundary the dashboard groups
    // by — undoing at 11 PM must not reach back into yesterday.
    if (req.method === 'DELETE' || q.undo === '1') {
      const tzh = tzHelpers((await getProfile().catch(() => null))?.tz);
      const today = tzh.day(Date.now());
      const removed = await removeLast((e) => e.h === habit && tzh.day(e.t) === today);
      if (!removed) {
        res.status(404).send('Nothing to undo: no ' + habit + ' logged today.');
        return;
      }
      res.status(200).send('Removed: ' + habit);
      return;
    }

    const entry = { h: habit, t: Date.now(), note: (q.note || '').toString() };
    if (emoji) entry.e = emoji;
    if (slotField) entry.slot = slotField;
    const intensity = (q.intensity || '').toString();
    if (INTENSITIES.has(intensity)) entry.i = intensity;
    // Answering the coach's question (#34): the tap is still a real log row,
    // but it also carries which question it answers and which way.
    if (questionDef) {
      entry.q = questionDef.qid;
      entry.a = questionDef.answer;
    }
    await append(entry);
    res.status(200).send('Logged: ' + habit + (entry.i ? ' (' + entry.i + ')' : ''));

    // A question is spent once answered: record the verdict and retire BOTH
    // halves of the pair, so the other key cannot be tapped to "answer" again.
    if (questionDef) {
      await answerQuestion(questionDef);
    }

    // The coach reacts to the tap in the background (after the response), so
    // the key's OK flash is instant while the AI decides whether to repaint
    // its slot keys. Cooldown lives inside reactTo.
    if (zaiKey()) {
      waitUntil(reactTo(entry).catch(() => {}));
    }
  } catch (err) {
    res.status(500).send('Error: ' + (err && err.message ? err.message : err));
  }
}
