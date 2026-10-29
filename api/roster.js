// GET  /api/roster        -> { proposals, archive, lastRunAt, model }
// GET  /api/roster?run=1  -> run a coach roster pass now (30s cooldown)
// POST /api/roster        -> { id, decision: 'approve'|'dismiss' } | { restore: 'Name' }
//
// The self-managing-roster surface: the coach proposes changes to the fixed
// habit list (lib/coach.js rosterPass, also run by the morning cron) and the
// human decides here. Approvals apply immediately and atomically enough — the
// habit list is written first, so a failure leaves the proposal pending rather
// than silently losing the change. Retirement is soft; see lib/roster.js.
// HABIT_KEY gates writes via x-habit-key / ?key= / body.key (lib/habit-key.js).
// Production fails closed when the secret is unset (#112).
import { isConfigured, getRoster, setRoster, withTargetsLock } from '../lib/store.js';
import { getHabitsStrict, saveHabits, validateHabits } from '../lib/habits.js';
import { zaiKey } from '../lib/ai.js';
import { rosterPass, ROSTER_COOLDOWN_MS } from '../lib/coach.js';
import { normalizeRoster, applyDecision, restoreFromArchive } from '../lib/roster.js';
import { keyDenied } from '../lib/habit-key.js';
import { targetsHttpError } from '../lib/target.js';

const view = (doc) => ({
  proposals: doc.proposals,
  archive: doc.archive,
  lastRunAt: doc.lastRunAt,
  model: doc.model
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-habit-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  try {
    if (!isConfigured()) {
      res.status(503).json({ error: 'Storage not connected.' });
      return;
    }
    const q = req.query || {};

    if (req.method !== 'POST') {
      const current = normalizeRoster(await getRoster());
      if (q.run !== '1') {
        res.status(200).json(view(current));
        return;
      }
      if (keyDenied(req, res)) return;
      if (!zaiKey()) {
        res.status(503).json({ error: 'No AI key set — add ZAI_API_KEY in Vercel, then redeploy.' });
        return;
      }
      if (Date.now() - current.lastRunAt < ROSTER_COOLDOWN_MS) {
        res.status(429).json({ error: 'Just ran — try again in half a minute.', ...view(current) });
        return;
      }
      const doc = await rosterPass();
      res.status(200).json({ added: doc.added, parseError: doc.parseError || undefined, ...view(doc) });
      return;
    }

    const body = typeof req.body === 'object' && req.body ? req.body : {};
    if (keyDenied(req, res, body)) return;
    // Same rail as POST /api/targets: read + decide + write under withTargetsLock
    // so a concurrent target-pass MSET cannot land goals that this path then
    // overwrites with a pre-lock habits snapshot (or vice versa). Soft
    // getHabits() is never used here — a Redis blip must not seed-fallback and
    // wipe a custom roster. Contended lock → 409 TARGETS_BUSY.
    let saved;
    let result;
    try {
      await withTargetsLock(async () => {
        const [habits, roster] = await Promise.all([getHabitsStrict(), getRoster()]);
        result = body.restore
          ? restoreFromArchive({ habits, roster, name: String(body.restore) })
          : applyDecision({
              habits,
              roster,
              id: String(body.id || ''),
              decision: String(body.decision || '')
            });
        if (result.error) return;
        // Defense in depth: the coach influenced this list, so it has to pass
        // the same validation a hand-edited save does before it can land.
        saved = habits;
        if (result.habits !== habits) {
          const err = validateHabits(result.habits);
          if (err) {
            result = { error: err };
            return;
          }
          saved = await saveHabits(result.habits);
        }
        await setRoster(result.roster);
      });
    } catch (lockErr) {
      const mapped = targetsHttpError(lockErr);
      if (mapped.status === 409) {
        res.status(409).json({ error: mapped.error });
        return;
      }
      throw lockErr;
    }
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(200).json({ ok: true, applied: result.applied, habits: saved, ...view(result.roster) });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
