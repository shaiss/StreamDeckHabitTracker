// GET /api/data -> { configured, entries: [{h,t,note}, ...], insight? }
// Feeds the dashboard. Personal data requires auth; anonymous gets empty.
import { all, getInsight, isConfigured } from '../lib/store.js';
import { handleOptions, optionalAuth, setCors } from '../lib/auth.js';
import { runAsUser } from '../lib/scope.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!isConfigured()) {
      res.status(200).json({ configured: false, entries: [] });
      return;
    }
    const auth = await optionalAuth(req);
    if (!auth) {
      res.status(200).json({ configured: true, entries: [], insight: null, authRequired: true });
      return;
    }
    await runAsUser(auth.userId, async () => {
      const [entries, insight] = await Promise.all([all(), getInsight().catch(() => null)]);
      res.status(200).json({ configured: true, entries, insight });
    });
  } catch (err) {
    res.status(500).json({ configured: true, error: err && err.message ? err.message : String(err), entries: [] });
  }
}
