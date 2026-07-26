// GET /api/slots -> { configured, aiReady, model, suggestedAt, slots: [def|null x4] }
// def = { habit, emoji, label, reason, assignedAt }
// Read by the dashboard and by the Stream Deck plugin (CORS open, read-only).
import { waitUntil } from '@vercel/functions';
import { getSlots, isConfigured, getSlotHistory, all, getDeckState, setDeckState } from '../lib/store.js';
import { zaiKey, zaiModel } from '../lib/ai.js';
import { getHabits } from '../lib/habits.js';
import { scoreSuggestions } from '../lib/scorer.js';
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
    const doc = await getSlots();
    const out = { ...base, suggestedAt: doc.suggestedAt, slots: doc.slots };
    // ?track=1 (dashboard only — keeps the plugin's poll light): behavioral
    // scorecard of past suggestions vs actual taps, plus the hardware
    // heartbeat so the dashboard can report whether a physical deck is live.
    if (q.track === '1') {
      const [history, entries, deck] = await Promise.all([
        getSlotHistory(),
        all(),
        getDeckState().catch(() => null)
      ]);
      out.track = scoreSuggestions(history, entries);
      out.deck = deck;
    }
    res.status(200).json(out);

    // ?deck=<pluginVersion> marks the physical deck's own poll. Recording it
    // after the response keeps the plugin's poll as cheap as it was.
    if (q.deck) {
      waitUntil(
        setDeckState({
          at: Date.now(),
          plugin: String(q.deck).slice(0, 20),
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
