// GET  /api/profile                    -> current settings
// GET  /api/profile?set=1&tz=...&name=...&about=...&coachNav=...  (or POST JSON)
// Lean single-user settings: timezone, name, free-text "about me" the coach
// reads on every pass, and coachNav — the tri-state navigation consent
// (off | nudge-only | may-navigate, issue #54; unknown values normalize to
// off). HABIT_KEY (if set) gates writes via ?key=.
//
// Autonomy clients (#94) send navSeq — a monotonic ordering token stored as
// coachNavSeq. coachNav changes REQUIRE navSeq (400 without it) so a stale
// dashboard Save cannot restore may-navigate after MANUAL. Stale tokens are
// rejected (409) via atomic CAS. Non-consent edits (name/tz/about) omit
// coachNav and write through CAS-with-retry so they cannot clobber a newer
// sequenced consent either.
import {
  getProfile, getProfileRaw, setProfileIfNavSeq, setProfileIfRaw, isConfigured
} from '../lib/store.js';
import { HOME_TZ, isValidTz } from '../lib/tz.js';
import { normalizeConsent } from '../lib/takeover.js';
import { buildProfileNext, parseProfileRaw } from '../lib/profile-write.js';

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

    const now = Date.now();
    // Always merge from a raw snapshot so unsequenced writes can CAS.
    let expectedRaw = await getProfileRaw();
    let prev = parseProfileRaw(expectedRaw);
    let built = buildProfileNext(prev, body, { now });
    if (!built.ok) {
      const payload = { error: built.error };
      if (built.status === 409) {
        payload.coachNav = built.coachNav;
        payload.coachNavSeq = built.coachNavSeq;
      }
      res.status(built.status).json(payload);
      return;
    }

    if (built.useNavSeq) {
      const ok = await setProfileIfNavSeq(built.next, built.navSeq, expectedRaw);
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
      // Unsequenced name/tz/about: CAS + retry so a concurrent Autonomy
      // MANUAL write is never overwritten by a stale full-record merge.
      let ok = await setProfileIfRaw(built.next, expectedRaw);
      for (let attempt = 0; !ok && attempt < 2; attempt++) {
        expectedRaw = await getProfileRaw();
        prev = parseProfileRaw(expectedRaw);
        built = buildProfileNext(prev, body, { now });
        if (!built.ok) {
          res.status(built.status).json({ error: built.error });
          return;
        }
        if (built.useNavSeq) {
          // Body gained navSeq mid-retry only if the client sent it — still CAS.
          ok = await setProfileIfNavSeq(built.next, built.navSeq, expectedRaw);
          break;
        }
        ok = await setProfileIfRaw(built.next, expectedRaw);
      }
      if (!ok) {
        const cur = (await getProfile()) || {};
        res.status(409).json({
          error: 'profile busy',
          coachNav: normalizeConsent(cur.coachNav),
          coachNavSeq: Math.max(0, Number(cur.coachNavSeq) || 0)
        });
        return;
      }
    }

    const next = built.next;
    res.status(200).json({
      ok: true, tz: next.tz || '', name: next.name || '', about: next.about || '',
      coachNav: normalizeConsent(next.coachNav),
      coachNavSeq: Math.max(0, Number(next.coachNavSeq) || 0)
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
