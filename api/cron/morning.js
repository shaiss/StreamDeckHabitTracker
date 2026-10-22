// Cron: morning pass — the coach sets the day's slot keys (see vercel.json).
// Vercel calls this with Authorization: Bearer $CRON_SECRET when that env var
// is set; manual trigger: GET ?run=1 with the x-habit-key header.
//
// Fail closed in production (#112): a manual ?run=1 follows the shared
// HABIT_KEY rule (503 when HABIT_KEY is unset, 401 on a wrong key), and the
// cron bearer path answers 503 when CRON_SECRET is unset — production never
// accepts an unauthenticated cron call. Outside production both keep the old
// open behavior.
import { isConfigured } from '../../lib/store.js';
import { zaiKey } from '../../lib/ai.js';
import { morningPass, rosterPass, coachPagePass } from '../../lib/coach.js';
import { keyStatus, safeEqual, isProduction, MISCONFIGURED } from '../../lib/habit-key.js';

// 200 = run, 401 = refuse, 503 = production is missing the secret this path needs.
export function cronStatus(req) {
  const cronSecret = process.env.CRON_SECRET || '';
  const auth = (req.headers && req.headers.authorization) || '';
  if (cronSecret && safeEqual(auth, `Bearer ${cronSecret}`)) return 200;
  const q = req.query || {};
  if (q.run === '1') return keyStatus(req);
  if (!cronSecret) return isProduction() ? 503 : 200;   // non-prod: unauthenticated cron OK
  return 401;
}

export function authorized(req) {
  return cronStatus(req) === 200;
}

// Shared by morning.js and daily.js: answers 401/503 and returns true when the
// request must stop before any work.
export function cronDenied(req, res) {
  const status = cronStatus(req);
  if (status === 200) return false;
  const q = req.query || {};
  const msg = status === 401 ? 'Unauthorized'
    : q.run === '1' ? MISCONFIGURED : 'Server misconfigured: CRON_SECRET is not set.';
  res.status(status).json({ error: msg });
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    if (cronDenied(req, res)) return;
    if (!zaiKey() || !isConfigured()) {
      res.status(503).json({ error: 'AI or storage not configured.' });
      return;
    }
    const doc = await morningPass();
    // The roster review and the coach-page refresh are advisory — neither may
    // fail the pass that sets the day's front keys, so both are caught.
    const roster = await rosterPass().catch(() => null);
    const coachPage = await coachPagePass().catch(() => null);
    res.status(200).json({
      ...(doc || { error: 'no usable suggestions' }),
      rosterProposals: roster ? roster.proposals.length : 0,
      coachPageKeys: coachPage ? coachPage.slots.filter(Boolean).length : 0
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
