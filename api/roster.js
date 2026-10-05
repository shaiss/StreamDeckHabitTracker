// Roster reads are user-scoped; writes/runs require auth.
import { isConfigured, getRoster, setRoster } from '../lib/store.js';
import { getHabits, saveHabits, validateHabits } from '../lib/habits.js';
import { zaiKey } from '../lib/ai.js';
import { rosterPass, ROSTER_COOLDOWN_MS } from '../lib/coach.js';
import { normalizeRoster, applyDecision, restoreFromArchive } from '../lib/roster.js';
import { handleOptions, optionalAuth, withUser, setCors } from '../lib/auth.js';
import { runAsUser } from '../lib/scope.js';

const view = (doc) => ({
  proposals: doc.proposals,
  archive: doc.archive,
  lastRunAt: doc.lastRunAt,
  model: doc.model
});

export default async function handler(req, res) {
  if (handleOptions(req, res, 'GET, POST, OPTIONS')) return;
  setCors(res, { methods: 'GET, POST, OPTIONS' });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!isConfigured()) {
      res.status(503).json({ error: 'Storage not connected.' });
      return;
    }
    const q = req.query || {};

    if (req.method !== 'POST') {
      if (q.run === '1') {
        await withUser(req, res, async () => {
          const current = normalizeRoster(await getRoster());
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
        });
        return;
      }
      const auth = await optionalAuth(req);
      if (!auth) {
        res.status(200).json({ proposals: [], archive: [], lastRunAt: 0, model: '', authRequired: true });
        return;
      }
      await runAsUser(auth.userId, async () => {
        res.status(200).json(view(normalizeRoster(await getRoster())));
      });
      return;
    }

    await withUser(req, res, async () => {
      const body = typeof req.body === 'object' && req.body ? req.body : {};
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
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
