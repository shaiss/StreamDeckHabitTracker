// GET/POST /api/log?habit=NAME[&note=...][&key=TOKEN]  -> logs a fixed habit
// GET/POST /api/log?slot=N                              -> logs whatever habit
//   the AI currently has assigned to slot N; one integer namespace (#52):
//   1-4 resolve the front page (habits:slots), 5-16 resolve coach-page index
//   N-5 (habits:coach:page). The habit name and emoji are captured at tap
//   time so history stays truthful after a swap.
// ...&intensity=high|low  -> tags how much of it there was ("big meal" vs
//   "snack"). The deck's double-tap gesture sends high (issue #33).
// DELETE /api/log?... (or ...&undo=1) -> removes today's most recent entry for
//   that key. The long-press "oops" affordance: no dialog, no confirmation.
// Auth: Clerk session OR per-user plugin API token. Fail closed — no anonymous
// writes. Returns plain text (handy when testing in a browser).
import { waitUntil } from '@vercel/functions';
import { append, removeLast, getSlots, getCoachPage, getProfile, isConfigured } from '../lib/store.js';
import { zaiKey } from '../lib/ai.js';
import { getHabits } from '../lib/habits.js';
import { reactTo, answerQuestion } from '../lib/coach.js';
import { tzHelpers } from '../lib/tz.js';
import { handleOptions, withUser, setCors } from '../lib/auth.js';
import { runAsUser } from '../lib/scope.js';

const INTENSITIES = new Set(['high', 'low']);

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (handleOptions(req, res, 'GET, POST, DELETE, OPTIONS')) return;
  setCors(res, { methods: 'GET, POST, DELETE, OPTIONS' });
  try {
    await withUser(req, res, async (auth) => {
      if (!isConfigured()) {
        res
          .status(503)
          .send('Storage not connected yet. In Vercel: Storage -> create Upstash/KV -> connect to this project, then redeploy.');
        return;
      }

      const q = req.query || {};
      const slotNum = parseInt(q.slot, 10);
      const hkeyNum = parseInt(q.hkey, 10);
      let habit = (q.habit || '').toString().trim();
      let emoji = '';
      let slotField;
      let questionDef = null;

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
      if (questionDef && (questionDef.gateRole === 'details' || questionDef.verb === 'details'
        || questionDef.answer === 'details')) {
        res.status(200).send(questionDef.question || 'Details');
        return;
      }

      if (questionDef) {
        entry.q = questionDef.qid;
        entry.a = questionDef.answer;
      }
      await append(entry);
      res.status(200).send('Logged: ' + habit + (entry.i ? ' (' + entry.i + ')' : ''));

      if (questionDef) {
        await answerQuestion(questionDef);
      }

      // waitUntil may settle after ALS exits — re-enter the same user scope.
      if (zaiKey()) {
        const uid = auth.userId;
        waitUntil(runAsUser(uid, () => reactTo(entry)).catch(() => {}));
      }
    }, { plain: true });
  } catch (err) {
    res.status(500).send('Error: ' + (err && err.message ? err.message : err));
  }
}
