// GET /api/data -> { configured, entries: [{h,t,note}, ...], insight, targetChanges }
// Feeds the dashboard at /. No auth: it's read-only counts of your own habits.
import { all, getInsight, getTargets, isConfigured } from '../lib/store.js';
import { normalizeTargets, formatTargetLine } from '../lib/target.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    if (!isConfigured()) {
      res.status(200).json({ configured: false, entries: [], targetChanges: [] });
      return;
    }
    const [entries, insight, targets] = await Promise.all([
      all(),
      getInsight().catch(() => null),
      getTargets().catch(() => null)
    ]);
    const hist = normalizeTargets(targets).history.slice(0, 8);
    res.status(200).json({
      configured: true,
      entries,
      insight,
      targetChanges: hist,
      targetLines: hist.map(formatTargetLine)
    });
  } catch (err) {
    res.status(500).json({ configured: true, error: err && err.message ? err.message : String(err), entries: [], targetChanges: [] });
  }
}
