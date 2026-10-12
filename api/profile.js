// GET  /api/profile  -> current settings (auth); anon → empty defaults
// POST /api/profile  -> update settings (auth required)
import { getProfile, setProfile, isConfigured } from '../lib/store.js';
import { isValidTz, HOME_TZ } from '../lib/tz.js';
import { normalizeConsent } from '../lib/takeover.js';
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
    const writing = req.method === 'POST' || q.set === '1';

    if (!writing) {
      const auth = await optionalAuth(req);
      if (!auth) {
        res.status(200).json({
          tz: '',
          effectiveTz: HOME_TZ,
          name: '',
          about: '',
          coachNav: 'off',
          updatedAt: 0,
          authRequired: true
        });
        return;
      }
      await runAsUser(auth.userId, async () => {
        const p = (await getProfile()) || {};
        res.status(200).json({
          tz: p.tz || '',
          effectiveTz: isValidTz(p.tz) ? p.tz : HOME_TZ,
          name: p.name || '',
          about: p.about || '',
          coachNav: normalizeConsent(p.coachNav),
          updatedAt: p.updatedAt || 0
        });
      });
      return;
    }

    await withUser(req, res, async () => {
      const body = req.method === 'POST' ? (typeof req.body === 'object' && req.body ? req.body : {}) : q;
      const prev = (await getProfile()) || {};
      const next = { ...prev, updatedAt: Date.now() };
      if (body.tz !== undefined) {
        const tz = String(body.tz).trim();
        if (tz && !isValidTz(tz)) {
          res.status(400).json({ error: `Unknown timezone: ${tz}. Use an IANA name like America/New_York.` });
          return;
        }
        next.tz = tz;
      }
      if (body.name !== undefined) next.name = String(body.name).slice(0, 60);
      if (body.about !== undefined) next.about = String(body.about).slice(0, 1000);
      if (body.coachNav !== undefined) next.coachNav = normalizeConsent(String(body.coachNav));
      await setProfile(next);
      res.status(200).json({
        ok: true, tz: next.tz || '', name: next.name || '', about: next.about || '',
        coachNav: normalizeConsent(next.coachNav)
      });
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
