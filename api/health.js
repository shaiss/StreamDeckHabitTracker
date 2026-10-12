// GET /api/health -> storage + AI wiring + auth readiness (env NAMES only).
import { isConfigured, detectedKeys, getDeckState } from '../lib/store.js';
import { zaiKey, zaiModel } from '../lib/ai.js';
import { clerkConfigured } from '../lib/auth.js';
import { ownerUserId, runAsUser } from '../lib/scope.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const aiKeys = Object.keys(process.env).filter((k) => /(ZAI|Z_AI|GLM|ZHIPU)/i.test(k));
  const configured = isConfigured();
  let deck = null;
  const owner = ownerUserId();
  if (configured && owner) {
    try {
      deck = await runAsUser(owner, () => getDeckState());
    } catch { /* leave null */ }
  }
  res.status(200).json({
    configured,
    aiReady: Boolean(zaiKey()),
    authReady: clerkConfigured(),
    ownerMapped: Boolean(owner),
    model: zaiModel(),
    deck: deck ? { ...deck, agoMs: Date.now() - (deck.at || 0) } : null,
    detectedEnvKeys: [...detectedKeys(), ...aiKeys]
  });
}
