// GET /api/nudge            -> nudge state + whether one is currently
//                              permissible (pure gate evaluation; no model
//                              call, no write) + the three-way track record
// GET /api/nudge?run=1      -> force a nudge pass NOW (or POST): bypasses the
//                              gate rules but keeps a 30s cooldown; consumes a
//                              model call and may repaint a slot key for real.
// POST /api/nudge?dismiss=1&slot=N -> explicit "not today" (the deck's
//                              long-press). Clears the key, records a
//                              `dismissed` outcome distinct from `ignored`,
//                              and buys quiet for DISMISS_QUIET_MS.
import {
  getNudgeState, setNudgeState, getSlots, setSlots, all, getProfile, isConfigured,
  appendDismissal, getDismissals, getSlotHistory
} from '../lib/store.js';
import { zaiKey } from '../lib/ai.js';
import { tzHelpers } from '../lib/tz.js';
import { nudgePass, summarize } from '../lib/coach.js';
import { nudgeDue } from '../lib/nudge.js';
import { scoreNudges } from '../lib/scorer.js';

const RUN_COOLDOWN_MS = 30_000;

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
    const q = req.query || {};
    if (!isConfigured()) {
      res.status(503).json({ error: 'Storage not connected.' });
      return;
    }

    // Dismissal is a write, so it honors HABIT_KEY like /api/log — otherwise
    // anyone could silence the coach on this human's behalf.
    if (q.dismiss === '1') {
      const secret = process.env.HABIT_KEY;
      if (secret && q.key !== secret) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const doc = await getSlots();
      const n = parseInt(q.slot, 10);
      const def = n >= 1 && n <= 4 ? doc.slots[n - 1] : null;
      if (!def || !def.nudge) {
        res.status(409).json({ error: 'No live nudge in that slot.' });
        return;
      }
      const at = Date.now();
      const slots = doc.slots.slice();
      slots[n - 1] = null;
      await setSlots({ ...doc, slots });
      await appendDismissal({ habit: def.habit, slot: n, at });
      const state = (await getNudgeState()) || {};
      await setNudgeState({ ...state, lastDismissAt: at, dismissed: (state.dismissed || 0) + 1 });
      res.status(200).json({ dismissed: true, habit: def.habit, slot: n, at });
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

    const [state, doc, entries, profile, dismissals, history] = await Promise.all([
      getNudgeState(),
      getSlots(),
      all(),
      getProfile().catch(() => null),
      getDismissals().catch(() => []),
      getSlotHistory().catch(() => [])
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
        slots: doc.slots,
        lastDismissAt: state?.lastDismissAt || 0
      }),
      localHour: tzh.hour(now),
      liveNudge: doc.slots.find((s) => s && s.nudge) || null,
      // tapped / dismissed / ignored — the whole point of #35.
      track: scoreNudges(history, entries, dismissals, now)
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
