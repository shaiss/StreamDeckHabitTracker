// GET  /api/roster        -> { proposals, archive, lastRunAt, model }
// GET  /api/roster?run=1  -> run a coach roster pass now (30s cooldown)
// POST /api/roster        -> { id, decision: 'approve'|'dismiss' } | { restore: 'Name' }
//
// The self-managing-roster surface: the coach proposes changes to the fixed
// habit list (lib/coach.js rosterPass, also run by the morning cron) and the
// human decides here. Approvals apply immediately and atomically enough — the
// habit list is written first, so a failure leaves the proposal pending rather
// than silently losing the change. Retirement is soft; see lib/roster.js.
// HABIT_KEY (if set) gates writes via ?key= or body.key, matching api/habits.js.
import { isConfigured, getRoster, setRoster } from '../lib/store.js';
import { getHabits, saveHabits, validateHabits } from '../lib/habits.js';
import { zaiKey } from '../lib/ai.js';
import { rosterPass, ROSTER_COOLDOWN_MS } from '../lib/coach.js';
import { normalizeRoster, applyDecision, restoreFromArchive } from '../lib/roster.js';

const view = (doc) => ({
  proposals: doc.proposals,
  archive: doc.archive,
  lastRunAt: doc.lastRunAt,
  model: doc.model
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!isConfigured()) {
      res.status(503).json({ error: 'Storage not connected.' });
      return;
    }
    const q = req.query || {};
    const secret = process.env.HABIT_KEY;

    if (req.method !== 'POST') {
      const current = normalizeRoster(await getRoster());
      if (q.run !== '1') {
        res.status(200).json(view(current));
        return;
      }
      if (secret && q.key !== secret) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      if (!zaiKey()) {
        res.status(503).json({ error: 'No AI key set — add ZAI_API_KEY in Vercel, then redeploy.' });
        return;
      }
      if (Date.now() - current.lastRunAt < ROSTER_COOLDOWN_MS) {
        res.status(429).json({ error: 'Just ran — try again in half a minute.', ...view(current) });
        return;
      }
      const doc = await rosterPass();
      res.status(200).json({ added: doc.added, ...view(doc) });
      return;
    }

    const body = typeof req.body === 'object' && req.body ? req.body : {};
    if (secret && body.key !== secret && q.key !== secret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const [habits, roster] = await Promise.all([getHabits(), getRoster()]);
    const result = body.restore
      ? restoreFromArchive({ habits, roster, name: String(body.restore) })
      : applyDecision({
          habits,
          roster,
          id: String(body.id || ''),
          decision: String(body.decision || '')
        });
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }
    // Defense in depth: the coach influenced this list, so it has to pass the
    // same validation a hand-edited save does before it can land.
    let saved = habits;
    if (result.habits !== habits) {
      const err = validateHabits(result.habits);
      if (err) {
        res.status(400).json({ error: err });
        return;
      }
      saved = await saveHabits(result.habits);
    }
    await setRoster(result.roster);
    res.status(200).json({ ok: true, applied: result.applied, habits: saved, ...view(result.roster) });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
