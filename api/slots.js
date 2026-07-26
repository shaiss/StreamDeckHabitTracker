// GET /api/slots -> { configured, aiReady, model, suggestedAt, slots: [def|null x4] }
// def = { habit, emoji, label, reason, assignedAt }
// Read by the dashboard and by the Stream Deck plugin (CORS open, read-only).
import { getSlots, isConfigured, getSlotHistory, all } from '../lib/store.js';
import { BASE_HABITS, zaiKey, zaiModel } from '../lib/ai.js';
import { scoreSuggestions } from '../lib/scorer.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    // habits: the fixed key set, so clients (virtual deck) stay in sync with
    // config/habits.json without a separate endpoint.
    const base = {
      configured: isConfigured(),
      aiReady: Boolean(zaiKey()),
      model: zaiModel(),
      habits: BASE_HABITS.map((h) => ({ name: h.name, emoji: h.emoji, label: h.label }))
    };
    if (!base.configured) {
      res.status(200).json({ ...base, suggestedAt: 0, slots: [null, null, null, null] });
      return;
    }
    const doc = await getSlots();
    const out = { ...base, suggestedAt: doc.suggestedAt, slots: doc.slots };
    // ?track=1 (dashboard only — keeps the plugin's poll light): behavioral
    // scorecard of past suggestions vs actual taps.
    if ((req.query || {}).track === '1') {
      const [history, entries] = await Promise.all([getSlotHistory(), all()]);
      out.track = scoreSuggestions(history, entries);
    }
    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
