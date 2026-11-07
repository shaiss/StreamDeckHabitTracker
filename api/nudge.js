// Nudge endpoint — dismiss / suppress / takeover / force-run require auth.
// GET status also scopes to the authenticated user (empty for anonymous).
import {
  getNudgeState, setNudgeState, getSlots, setSlots, all, getProfile, isConfigured,
  appendDismissal, getDismissals, getSlotHistory, claimTakeover
} from '../lib/store.js';
import { zaiKey } from '../lib/ai.js';
import { tzHelpers } from '../lib/tz.js';
import { nudgePass, summarize } from '../lib/coach.js';
import { nudgeDue } from '../lib/nudge.js';
import { SUPPRESS_MS } from '../lib/takeover.js';
import { scoreNudges } from '../lib/scorer.js';
import { handleOptions, optionalAuth, withUser, setCors } from '../lib/auth.js';
import { runAsUser } from '../lib/scope.js';

const RUN_COOLDOWN_MS = 30_000;

export default async function handler(req, res) {
  if (handleOptions(req, res, 'GET, POST, OPTIONS')) return;
  setCors(res, { methods: 'GET, POST, OPTIONS' });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const q = req.query || {};
    if (!isConfigured()) {
      res.status(503).json({ error: 'Storage not connected.' });
      return;
    }

    if (q.dismiss === '1') {
      await withUser(req, res, async () => {
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
      });
      return;
    }

    if (q.suppress === '1' || q.takeover === '1') {
      if (req.method !== 'POST') {
        res.status(405).json({ error: 'POST required.' });
        return;
      }
      await withUser(req, res, async () => {
        const state = (await getNudgeState()) || {};
        const now = Date.now();
        if (q.suppress === '1') {
          const until = now + SUPPRESS_MS;
          await setNudgeState({ ...state, suppressedUntil: until });
          res.status(200).json({ suppressed: true, until });
          return;
        }
        if (state.suppressedUntil && now < state.suppressedUntil) {
          res.status(409).json({ error: 'Kill switch engaged.', until: state.suppressedUntil });
          return;
        }
        const profile = await getProfile().catch(() => null);
        const day = tzHelpers(profile?.tz).day(now);
        if (state.takeoverDay === day || !(await claimTakeover(day))) {
          res.status(409).json({ error: 'Takeover budget spent for today.' });
          return;
        }
        await setNudgeState({ ...state, takeoverAt: now, takeoverDay: day });
        res.status(200).json({ granted: true, day });
      });
      return;
    }

    const running = req.method === 'POST' || q.run === '1';
    if (running) {
      await withUser(req, res, async () => {
        if (!zaiKey()) {
          res.status(503).json({ error: 'No AI key set.' });
          return;
        }
        const state = (await getNudgeState()) || {};
        if (Date.now() - (state.lastRunAt || 0) < RUN_COOLDOWN_MS) {
          res.status(429).json({ error: 'Just ran — try again in half a minute.' });
          return;
        }
        await setNudgeState({ ...state, lastRunAt: Date.now() });
        res.status(200).json(await nudgePass({ force: true }));
      });
      return;
    }

    const auth = await optionalAuth(req);
    if (!auth) {
      res.status(200).json({ state: {}, due: false, authRequired: true, liveNudge: null, track: null });
      return;
    }
    await runAsUser(auth.userId, async () => {
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
        track: scoreNudges(history, entries, dismissals, now)
      });
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
