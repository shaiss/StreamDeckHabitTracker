// GET /api/slots -> { configured, aiReady, model, suggestedAt, slots: [def|null x4] }
// def = { habit, emoji, label, reason, assignedAt }
// Read by the dashboard and by the Stream Deck plugin (CORS open, read-only).
import { getSlots, isConfigured } from '../lib/store.js';
import { zaiKey, zaiModel } from '../lib/ai.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const base = { configured: isConfigured(), aiReady: Boolean(zaiKey()), model: zaiModel() };
    if (!base.configured) {
      res.status(200).json({ ...base, suggestedAt: 0, slots: [null, null, null, null] });
      return;
    }
    const doc = await getSlots();
    res.status(200).json({ ...base, suggestedAt: doc.suggestedAt, slots: doc.slots });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
