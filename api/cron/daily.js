// Cron: end-of-day digest — the coach writes a short insight for the
// dashboard (see vercel.json). Auth model matches ../cron/morning.js.
import { isConfigured } from '../../lib/store.js';
import { zaiKey } from '../../lib/ai.js';
import { dailyDigest } from '../../lib/coach.js';
import { authorized } from './morning.js';

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
    const doc = await dailyDigest();
    res.status(200).json(doc || { error: 'no digest produced' });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
