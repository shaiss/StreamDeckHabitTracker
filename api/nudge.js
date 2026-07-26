// GET /api/nudge        -> nudge state + whether one is currently permissible
//                          (pure gate evaluation; no model call, no write)
// GET /api/nudge?run=1  -> force a nudge pass NOW (or POST): bypasses the gate
//                          rules but keeps a 30s cooldown; consumes a model
//                          call and may repaint a slot key for real.
import { getNudgeState, setNudgeState, getSlots, all, getProfile, isConfigured } from '../lib/store.js';
import { zaiKey } from '../lib/ai.js';
import { tzHelpers } from '../lib/tz.js';
import { nudgePass, summarize } from '../lib/coach.js';
import { nudgeDue } from '../lib/nudge.js';

const RUN_COOLDOWN_MS = 30_000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const q = req.query || {};
    if (!isConfigured()) {
      res.status(503).json({ error: 'Storage not connected.' });
      return;
    }

    const running = req.method === 'POST' || q.run === '1';
    if (running) {
      const secret = process.env.HABIT_KEY;
      if (secret && q.key !== secret) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      if (!zaiKey()) {
        res.status(503).json({ error: 'No AI key set.' });
        return;
      }
      const state = (await getNudgeState()) || {};
      if (Date.now() - (state.lastRunAt || 0) < RUN_COOLDOWN_MS) {
        res.status(429).json({ error: 'Just ran — try again in half a minute.' });
        return;
      }
      // Separate stamp from checkedAt: a forced probe must not eat the
      // passive loop's throttle window semantics.
      await setNudgeState({ ...state, lastRunAt: Date.now() });
      res.status(200).json(await nudgePass({ force: true }));
      return;
    }

    const [state, doc, entries, profile] = await Promise.all([
      getNudgeState(),
      getSlots(),
      all(),
      getProfile().catch(() => null)
    ]);
    const tzh = tzHelpers(profile?.tz);
    const now = Date.now();
    res.status(200).json({
      state: state || {},
      due: nudgeDue({
        now,
        hour: tzh.hour(now),
        lastNudgeAt: state?.lastAt || 0,
        lastTapAt: entries.at(-1)?.t || 0,
        daysOfData: summarize(entries, tzh).daysOfData,
        slots: doc.slots
      }),
      localHour: tzh.hour(now),
      liveNudge: doc.slots.find((s) => s && s.nudge) || null
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
