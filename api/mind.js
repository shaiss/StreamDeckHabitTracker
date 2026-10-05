// GET /api/mind -> coach mind page payload. Auth required for personal data.
import {
  all, getSlots, getSlotHistory, getCoachMemory, getInsight, getProfile, isConfigured
} from '../lib/store.js';
import { zaiKey, zaiModel } from '../lib/ai.js';
import { scoreSuggestions } from '../lib/scorer.js';
import { handleOptions, optionalAuth, setCors } from '../lib/auth.js';
import { runAsUser } from '../lib/scope.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!isConfigured()) {
      res.status(200).json({ configured: false });
      return;
    }
    const auth = await optionalAuth(req);
    if (!auth) {
      res.status(200).json({ configured: true, authRequired: true, memory: null, slots: [null, null, null, null], stats: null });
      return;
    }
    await runAsUser(auth.userId, async () => {
      const [entries, slotsDoc, history, memory, insight, profile] = await Promise.all([
        all(),
        getSlots(),
        getSlotHistory().catch(() => []),
        getCoachMemory().catch(() => null),
        getInsight().catch(() => null),
        getProfile().catch(() => null)
      ]);
      const track = scoreSuggestions(history, entries);
      const ideasTried = new Set(
        history.flatMap((h) => (h.slots || []).filter(Boolean).map((s) => s.habit))
      ).size;
      const firstAt = Math.min(
        entries[0]?.t || Date.now(),
        history[0]?.at || Date.now(),
        memory?.updatedAt || Date.now()
      );
      res.status(200).json({
        configured: true,
        aiReady: Boolean(zaiKey()),
        model: slotsDoc.model || zaiModel(),
        humanName: profile?.name || '',
        memory: memory ? { notes: memory.notes || '', updatedAt: memory.updatedAt || 0 } : null,
        insight,
        slots: slotsDoc.slots,
        suggestedAt: slotsDoc.suggestedAt,
        track,
        stats: {
          tapsObserved: entries.length,
          daysTogether: Math.max(1, Math.ceil((Date.now() - firstAt) / 86400_000)),
          ideasTried,
          assignments: history.length
        }
      });
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
