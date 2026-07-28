// GET  /api/coachpage        -> current coach-page assignments { slots, updatedAt, model }
// GET  /api/coachpage?run=1   -> run a coach-page pass NOW (or POST); 30s cooldown,
//                               consumes a model call and rewrites habits:coach:page.
//
// The Coach page (#52) is the AI-curated "considered layer" the deck renders as
// slots 5..16 (lib/coach.js coachPagePass, also run by the morning cron). Reads
// are open-CORS; a forced run honors HABIT_KEY (if set) via ?key=, like the
// other coach endpoints.
import { isConfigured, getCoachPage } from '../lib/store.js';
import { zaiKey } from '../lib/ai.js';
import { coachPagePass, COACHPAGE_COOLDOWN_MS } from '../lib/coach.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
    const current = await getCoachPage();
    const running = req.method === 'POST' || q.run === '1';
    if (!running) {
      res.status(200).json(current);
      return;
    }
    const secret = process.env.HABIT_KEY;
    if (secret && q.key !== secret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!zaiKey()) {
      res.status(503).json({ error: 'No AI key set — add ZAI_API_KEY in Vercel, then redeploy.' });
      return;
    }
    if (Date.now() - (current.updatedAt || 0) < COACHPAGE_COOLDOWN_MS) {
      res.status(429).json({ error: 'Just ran — try again in half a minute.', ...current });
      return;
    }
    const doc = await coachPagePass();
    // Null = the coach declined or the reply was unusable; a clean 502 mirrors
    // /api/suggest rather than a 500.
    if (!doc) {
      res.status(502).json({ error: 'No usable coach-page suggestions.' });
      return;
    }
    res.status(200).json(doc);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
