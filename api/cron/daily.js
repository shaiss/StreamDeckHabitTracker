// Cron: end-of-day digest — owner-tenant only (same gate as ./morning.js).
import { isConfigured } from '../../lib/store.js';
import { zaiKey } from '../../lib/ai.js';
import { dailyDigest } from '../../lib/coach.js';
import { ownerUserId, runAsUser } from '../../lib/scope.js';
import { requireOwnerAuth } from '../../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    if (!(await requireOwnerAuth(req, res))) return;

    const owner = ownerUserId();
    if (!owner) {
      res.status(403).json({ error: 'Forbidden' });
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
