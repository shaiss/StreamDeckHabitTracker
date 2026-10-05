// Coach-page read is user-scoped; forced run requires auth.
import { isConfigured, getCoachPage } from '../lib/store.js';
import { zaiKey } from '../lib/ai.js';
import { coachPagePass, COACHPAGE_COOLDOWN_MS } from '../lib/coach.js';
import { handleOptions, optionalAuth, withUser, setCors } from '../lib/auth.js';
import { runAsUser } from '../lib/scope.js';

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
    const running = req.method === 'POST' || q.run === '1';
    if (!running) {
      const auth = await optionalAuth(req);
      if (!auth) {
        res.status(200).json({
          slots: Array.from({ length: 12 }, () => null),
          updatedAt: 0,
          model: '',
          authRequired: true
        });
        return;
      }
      await runAsUser(auth.userId, async () => {
        res.status(200).json(await getCoachPage());
      });
      return;
    }
    await withUser(req, res, async () => {
      const current = await getCoachPage();
      if (!zaiKey()) {
        res.status(503).json({ error: 'No AI key set — add ZAI_API_KEY in Vercel, then redeploy.' });
        return;
      }
      if (Date.now() - (current.updatedAt || 0) < COACHPAGE_COOLDOWN_MS) {
        res.status(429).json({ error: 'Just ran — try again in half a minute.', ...current });
        return;
      }
      const doc = await coachPagePass();
      if (!doc) {
        res.status(502).json({ error: 'No usable coach-page suggestions.' });
        return;
      }
      res.status(200).json(doc);
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
