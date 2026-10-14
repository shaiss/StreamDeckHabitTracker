// GET  /api/profile                    -> current settings
// GET  /api/profile?set=1&tz=...&name=...&about=...&coachNav=...  (or POST JSON)
// Lean single-user settings: timezone, name, free-text "about me" the coach
// reads on every pass, and coachNav — the tri-state navigation consent
// (off | nudge-only | may-navigate, issue #54; unknown values normalize to
// off). HABIT_KEY (if set) gates writes via ?key=.
//
// Autonomy clients (#94) may also send navSeq — a monotonic ordering token
// stored as coachNavSeq. When present, stale tokens are rejected (409) via
// an atomic CAS so two rapid POSTs cannot persist out of tap order. Clients
// that omit navSeq (dashboard form, older builds) keep the unconditional path.
import {
  getProfile, getProfileRaw, setProfile, setProfileIfNavSeq, isConfigured
} from '../lib/store.js';
import { isValidTz, HOME_TZ } from '../lib/tz.js';
import { normalizeConsent, acceptCoachNavSeq } from '../lib/takeover.js';

function parseProfileRaw(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
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
      const p = (await getProfile()) || {};
      res.status(200).json({
        tz: p.tz || '',
        effectiveTz: isValidTz(p.tz) ? p.tz : HOME_TZ,
        name: p.name || '',
        about: p.about || '',
        coachNav: normalizeConsent(p.coachNav),
        coachNavSeq: Math.max(0, Number(p.coachNavSeq) || 0),
        updatedAt: p.updatedAt || 0
      });
      return;
    }

    const secret = process.env.HABIT_KEY;
    const body = req.method === 'POST' ? (typeof req.body === 'object' && req.body ? req.body : {}) : q;
    if (secret && body.key !== secret && q.key !== secret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Optional Autonomy ordering token. Absent / non-positive → unconditional
    // write (backward compatible). Present → must be strictly newer than the
    // stored coachNavSeq, applied atomically with the profile SET.
    const rawNavSeq = body.navSeq !== undefined ? Number(body.navSeq) : NaN;
    const useNavSeq = Number.isFinite(rawNavSeq) && Number.isInteger(rawNavSeq) && rawNavSeq > 0;

    const expectedRaw = useNavSeq ? await getProfileRaw() : null;
    const prev = useNavSeq ? parseProfileRaw(expectedRaw) : ((await getProfile()) || {});
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
    // Navigation consent is a guardrail: anything unrecognized stores as off.
    if (body.coachNav !== undefined) next.coachNav = normalizeConsent(String(body.coachNav));

    if (useNavSeq) {
      if (body.coachNav === undefined) {
        res.status(400).json({ error: 'navSeq requires coachNav' });
        return;
      }
      if (!acceptCoachNavSeq(prev.coachNavSeq, rawNavSeq)) {
        res.status(409).json({
          error: 'stale navSeq',
          coachNav: normalizeConsent(prev.coachNav),
          coachNavSeq: Math.max(0, Number(prev.coachNavSeq) || 0)
        });
        return;
      }
      next.coachNavSeq = rawNavSeq;
      const ok = await setProfileIfNavSeq(next, rawNavSeq, expectedRaw);
      if (!ok) {
        const cur = (await getProfile()) || {};
        res.status(409).json({
          error: 'stale navSeq',
          coachNav: normalizeConsent(cur.coachNav),
          coachNavSeq: Math.max(0, Number(cur.coachNavSeq) || 0)
        });
        return;
      }
    } else {
      await setProfile(next);
    }

    res.status(200).json({
      ok: true, tz: next.tz || '', name: next.name || '', about: next.about || '',
      coachNav: normalizeConsent(next.coachNav),
      coachNavSeq: Math.max(0, Number(next.coachNavSeq) || 0)
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
