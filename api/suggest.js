// POST /api/suggest (or GET /api/suggest?run=1) -> full slot refresh.
// The coach also updates its keys reactively after every tap (see api/log.js
// + lib/coach.js); this endpoint is the manual "re-think everything" button.
import { getSlots, isConfigured } from '../lib/store.js';
import { zaiKey } from '../lib/ai.js';
import { fullSuggest } from '../lib/coach.js';

const COOLDOWN_MS = 30_000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const q = req.query || {};
    if (req.method !== 'POST' && q.run !== '1') {
      res.status(405).json({ error: 'POST here (or GET with ?run=1) to refresh AI suggestions.' });
      return;
    }
    const secret = process.env.HABIT_KEY;
    if (secret && q.key !== secret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!zaiKey()) {
      res.status(503).json({
        error:
          'No AI key set. In Vercel: project -> Settings -> Environment Variables -> add ZAI_API_KEY (from z.ai), then redeploy.'
      });
      return;
    }
    if (!isConfigured()) {
      res.status(503).json({ error: 'Storage not connected.' });
      return;
    }

    const prev = await getSlots();
    if (Date.now() - prev.suggestedAt < COOLDOWN_MS) {
      res.status(429).json({ error: 'Just refreshed — try again in half a minute.', slots: prev.slots });
      return;
    }

    const doc = await fullSuggest();
    if (!doc) {
      res.status(502).json({ error: 'Model returned no usable suggestions — try again.' });
      return;
    }
    res.status(200).json(doc);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
