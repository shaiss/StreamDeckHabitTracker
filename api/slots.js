// GET /api/slots -> { configured, aiReady, model, suggestedAt, slots: [def|null x4], coachPage: [def|null x12], today, track?, deck? }
// def = { habit, emoji, label, reason, assignedAt }
// today = { [habitName]: { count, goal, doneToday, streak, ringFill } } (living key faces, #32)
// Query: ?tz=<minutes> (viewer getTimezoneOffset; default 0=UTC) sets the day
// boundary for `today`; ?track=1 adds the behavioral scorecard + hardware
// heartbeat; ?deck=<pluginVersion> records the physical deck's own poll.
// Read by the dashboard and by the Stream Deck plugin (CORS open, read-only).
import { waitUntil } from '@vercel/functions';
import { getSlots, getCoachPage, getProfile, isConfigured, getSlotHistory, all, getDeckState, setDeckState } from '../lib/store.js';
import { zaiKey, zaiModel } from '../lib/ai.js';
import { getHabits } from '../lib/habits.js';
import { normalizeConsent } from '../lib/takeover.js';
import { scoreSuggestions } from '../lib/scorer.js';
import { computeToday } from '../lib/today.js';
import { nudgePass } from '../lib/coach.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    // habits: the live habit list, so clients (virtual deck) stay in sync
    // with the habit manager without a separate fetch.
    const base = {
      configured: isConfigured(),
      aiReady: Boolean(zaiKey()),
      model: zaiModel(),
      habits: isConfigured() ? await getHabits() : []
    };
    if (!base.configured) {
      res.status(200).json({ ...base, suggestedAt: 0, slots: [null, null, null, null] });
      return;
    }
    const q = req.query || {};
    const [doc, coachPage, profile] = await Promise.all([
      getSlots(),
      getCoachPage(),
      getProfile().catch(() => null)
    ]);
    // Living key faces (#32): per-habit today state for the deck. tz is the
    // viewer's getTimezoneOffset() in minutes (UTC-5 → 300); default UTC. We
    // fetch entries once and reuse them for ?track=1 below (no extra round-trip).
    const wantTrack = (req.query || {}).track === '1';
    const tzMin = parseInt((req.query || {}).tz, 10);
    const tzOffsetMs = (Number.isFinite(tzMin) ? tzMin : 0) * 60_000;
    const entries = await all();
    const today = computeToday(base.habits, entries, Date.now(), tzOffsetMs);
    // coachPage: the wider slot array behind the Coach page (#52); the plugin
    // renders keys with slot=5..16 from it (index slot-5). coachNav: the
    // human's navigation consent (#54) — the plugin's takeover gate reads it
    // on every poll, so flipping it off lands within one poll beat.
    const out = {
      ...base, suggestedAt: doc.suggestedAt, slots: doc.slots, coachPage: coachPage.slots,
      coachNav: normalizeConsent(profile?.coachNav), today
    };
    // ?track=1 (dashboard only — keeps the plugin's poll light): behavioral
    // scorecard of past suggestions vs actual taps, plus the hardware
    // heartbeat so the dashboard can report whether a physical deck is live.
    if (wantTrack) {
      const [history, deck] = await Promise.all([
        getSlotHistory(),
        getDeckState().catch(() => null)
      ]);
      out.track = scoreSuggestions(history, entries);
      out.deck = deck;
    }
    res.status(200).json(out);

    // ?deck=<pluginVersion> marks the physical deck's own poll. Recording it
    // after the response keeps the plugin's poll as cheap as it was.
    //
    // This is the one WRITE on an otherwise read-only, open-CORS endpoint, so it
    // honors the same HABIT_KEY gate as /api/log: without it, any anonymous
    // caller could forge "the hardware is live" (the plugin sends ?key= too when
    // the env var is set). `plugin` is still attacker-shaped when HABIT_KEY is
    // unset — it's stripped of markup here and escaped again at render.
    const secret = process.env.HABIT_KEY;
    if (q.deck && (!secret || q.key === secret)) {
      waitUntil(
        setDeckState({
          at: Date.now(),
          plugin: String(q.deck).replace(/[^\w.+-]/g, '').slice(0, 20),
          keys: Math.max(0, Math.min(64, parseInt(q.keys, 10) || 0))
        }).catch(() => {})
      );
    }

    // The deck's own heartbeat drives proactivity: the plugin polls this
    // endpoint every ~15s (dashboard every 20s), so a throttled background
    // nudge check rides on it — no cron, and a deck that's off nudges no one.
    // nudgePass gates itself in Redis (one read on almost every poll) before
    // doing anything expensive; the response above is already gone.
    if (base.aiReady) {
      waitUntil(nudgePass().catch(() => {}));
    }
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
