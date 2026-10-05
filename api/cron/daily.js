// Cron: end-of-day digest. Auth model matches ./morning.js.
import { isConfigured } from '../../lib/store.js';
import { zaiKey } from '../../lib/ai.js';
import { dailyDigest } from '../../lib/coach.js';
import { authorized } from './morning.js';
import { ownerUserId, runAsUser } from '../../lib/scope.js';

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
      const doc = await dailyDigest();
      res.status(200).json(doc || { error: 'no digest produced' });
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
