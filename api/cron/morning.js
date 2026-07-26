// Cron: morning pass — the coach sets the day's slot keys (see vercel.json).
// Vercel calls this with Authorization: Bearer $CRON_SECRET when that env var
// is set; manual trigger: GET ?run=1 (plus &key= if HABIT_KEY is set).
import { isConfigured } from '../../lib/store.js';
import { zaiKey } from '../../lib/ai.js';
import { morningPass } from '../../lib/coach.js';

export function authorized(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers?.authorization === `Bearer ${cronSecret}`) return true;
  const q = req.query || {};
  if (q.run === '1') {
    const habitKey = process.env.HABIT_KEY;
    return !habitKey || q.key === habitKey;
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
    res.status(200).json(doc || { error: 'no usable suggestions' });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
