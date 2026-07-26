// GET /api/data -> { configured, entries: [{h,t,note}, ...] }
// Feeds the dashboard at /. No auth: it's read-only counts of your own habits.
import { all, isConfigured } from '../lib/store.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!isConfigured()) {
      res.status(200).json({ configured: false, entries: [] });
      return;
    }
    const entries = await all();
    res.status(200).json({ configured: true, entries });
  } catch (err) {
    res.status(500).json({ configured: true, error: err && err.message ? err.message : String(err), entries: [] });
  }
}
