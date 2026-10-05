// GET /api/slots -> { configured, aiReady, model, suggestedAt, slots, coachPage, … }
// Anonymous visitors get the seed habit list + empty AI slots (landing/deck
// preview). Personal data, the hardware heartbeat write, and nudgePass require
// auth (Clerk session or plugin API token).
import { waitUntil } from '@vercel/functions';
import { getSlots, getCoachPage, getProfile, getRoster, isConfigured, getSlotHistory, all, getDeckState, setDeckState } from '../lib/store.js';
import { normalizeRoster } from '../lib/roster.js';
import { zaiKey, zaiModel, BASE_HABITS } from '../lib/ai.js';
import { getHabits } from '../lib/habits.js';
import { normalizeConsent } from '../lib/takeover.js';
import { scoreSuggestions } from '../lib/scorer.js';
import { computeToday } from '../lib/today.js';
import { nudgePass } from '../lib/coach.js';
import { isBlocked } from '../lib/beacon.js';
import { handleOptions, optionalAuth, setCors } from '../lib/auth.js';
import { runAsUser } from '../lib/scope.js';

function publicPayload() {
  const habits = BASE_HABITS.map((h) => ({ name: h.name, emoji: h.emoji, label: h.label }));
  return {
    configured: isConfigured(),
    aiReady: Boolean(zaiKey()),
    model: zaiModel(),
    habits,
    suggestedAt: 0,
    slots: [null, null, null, null],
    coachPage: Array.from({ length: 12 }, () => null),
    coachNav: 'off',
    today: {},
    rosterPending: 0,
    blocked: false,
    authRequired: true
  };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!isConfigured()) {
      res.status(200).json({
        ...publicPayload(),
        configured: false,
        habits: []
      });
      return;
    }

    const auth = await optionalAuth(req);
    if (!auth) {
      res.status(200).json(publicPayload());
      return;
    }

    await runAsUser(auth.userId, async () => {
      const base = {
        configured: true,
        aiReady: Boolean(zaiKey()),
        model: zaiModel(),
        habits: await getHabits()
      };
      const q = req.query || {};
      const [doc, coachPage, profile, roster] = await Promise.all([
        getSlots(),
        getCoachPage(),
        getProfile().catch(() => null),
        getRoster().catch(() => null)
      ]);
      const wantTrack = q.track === '1';
      const tzMin = parseInt(q.tz, 10);
      const tzOffsetMs = (Number.isFinite(tzMin) ? tzMin : 0) * 60_000;
      const entries = await all();
      const today = computeToday(base.habits, entries, Date.now(), tzOffsetMs);
      const out = {
        ...base,
        suggestedAt: doc.suggestedAt,
        slots: doc.slots,
        coachPage: coachPage.slots,
        coachNav: normalizeConsent(profile?.coachNav),
        today,
        rosterPending: normalizeRoster(roster).proposals.length,
        blocked: isBlocked({ slots: doc.slots, coachPage: coachPage.slots })
      };
      if (wantTrack) {
        const [history, deck] = await Promise.all([
          getSlotHistory(),
          getDeckState().catch(() => null)
        ]);
        out.track = scoreSuggestions(history, entries);
        out.deck = deck;
      }
      res.status(200).json(out);

      // Heartbeat write + nudge only for authenticated deck polls.
      if (q.deck) {
        const uid = auth.userId;
        waitUntil(
          runAsUser(uid, () =>
            setDeckState({
              at: Date.now(),
              plugin: String(q.deck).replace(/[^\w.+-]/g, '').slice(0, 20),
              keys: Math.max(0, Math.min(64, parseInt(q.keys, 10) || 0))
            })
          ).catch(() => {})
        );
      }
      if (base.aiReady) {
        const uid = auth.userId;
        waitUntil(runAsUser(uid, () => nudgePass()).catch(() => {}));
      }
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
