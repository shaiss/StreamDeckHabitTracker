// Cron: morning pass. Auth: Bearer CRON_SECRET (preferred) or ?run=1 with
// a valid owner plugin token / session. Runs as HABIT_OWNER_USER_ID.
import { isConfigured } from '../../lib/store.js';
import { zaiKey } from '../../lib/ai.js';
import { morningPass, rosterPass, coachPagePass } from '../../lib/coach.js';
import { ownerUserId, runAsUser } from '../../lib/scope.js';
import { resolveAuth } from '../../lib/auth.js';

export async function authorized(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers?.authorization === `Bearer ${cronSecret}`) return true;
  const q = req.query || {};
  if (q.run === '1') {
    // Manual trigger: require a real user credential (Clerk or ht_ token).
    const auth = await resolveAuth(req);
    return Boolean(auth);
  }
  // Vercel cron without CRON_SECRET configured: accept the platform call.
  return !cronSecret;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    if (!(await authorized(req))) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const owner = ownerUserId();
    if (!owner) {
      res.status(503).json({
        error: 'HABIT_OWNER_USER_ID is not set — cron cannot scope to a tenant.'
      });
      return;
    }
    if (!zaiKey() || !isConfigured()) {
      res.status(503).json({ error: 'AI or storage not configured.' });
      return;
    }
    await runAsUser(owner, async () => {
      const doc = await morningPass();
      const roster = await rosterPass().catch(() => null);
      const coachPage = await coachPagePass().catch(() => null);
      res.status(200).json({
        ...(doc || { error: 'no usable suggestions' }),
        rosterProposals: roster ? roster.proposals.length : 0,
        coachPageKeys: coachPage ? coachPage.slots.filter(Boolean).length : 0
      });
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
