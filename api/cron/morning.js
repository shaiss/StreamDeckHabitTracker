// Cron: morning pass — the coach sets the day's slot keys (see vercel.json).
// Vercel calls this with Authorization: Bearer $CRON_SECRET when that env var
// is set; manual trigger: GET ?run=1 (plus &key= if HABIT_KEY is set).
import { isConfigured } from '../../lib/store.js';
import { zaiKey } from '../../lib/ai.js';
import { morningPass, rosterPass, targetPass, coachPagePass } from '../../lib/coach.js';
import { keyOk } from '../../lib/habit-key.js';

export function authorized(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers?.authorization === `Bearer ${cronSecret}`) return true;
  const q = req.query || {};
  if (q.run === '1') {
    return keyOk(req);
  }
  // No CRON_SECRET configured: accept the (unauthenticated) cron call.
  return !cronSecret;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    if (!authorized(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!zaiKey() || !isConfigured()) {
      res.status(503).json({ error: 'AI or storage not configured.' });
      return;
    }
    const doc = await morningPass();
    // Roster review, adaptive targets, and coach-page refresh are advisory —
    // none may fail the pass that sets the day's front keys. Target runs after
    // roster (#70) and is caught so it can never fail the roster pass either.
    const roster = await rosterPass().catch(() => null);
    const targets = await targetPass().catch(() => null);
    const coachPage = await coachPagePass().catch(() => null);
    res.status(200).json({
      ...(doc || { error: 'no usable suggestions' }),
      rosterProposals: roster ? roster.proposals.length : 0,
      targetAutoApplied: targets ? targets.autoApplied || 0 : 0,
      targetQueued: targets ? targets.queued || 0 : 0,
      coachPageKeys: coachPage ? coachPage.slots.filter(Boolean).length : 0
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
