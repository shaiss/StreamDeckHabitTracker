// Cron: morning pass — owner-tenant only.
// Callers: Authorization: Bearer $CRON_SECRET, or the HABIT_OWNER_USER_ID
// Clerk session / ht_ token. Anyone else → 401/403. Never runs as a non-owner.
import { isConfigured } from '../../lib/store.js';
import { zaiKey } from '../../lib/ai.js';
import { morningPass, rosterPass, coachPagePass } from '../../lib/coach.js';
import { ownerUserId, runAsUser } from '../../lib/scope.js';
import { requireOwnerAuth, isCronBearer } from '../../lib/auth.js';
import { keyOk } from '../../lib/habit-key.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    if (!(await requireOwnerAuth(req, res))) return;
    // Vercel cron bearer skips HABIT_KEY; manual owner triggers still honor it.
    if (!isCronBearer(req) && !keyOk(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const owner = ownerUserId();
    if (!owner) {
      // Cron bearer can pass resolveOwnerAuth without an owner id — still refuse.
      res.status(403).json({ error: 'Forbidden' });
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
