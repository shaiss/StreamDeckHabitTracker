// GET /api/health -> storage + AI + auth readiness (env NAMES only) + previewIsolation.
import {
  isConfigured,
  detectedKeys,
  getDeckState,
  previewIsolationStatus
} from '../lib/store.js';
import { zaiKey, zaiModel } from '../lib/ai.js';
import { clerkConfigured } from '../lib/auth.js';
import { ownerUserId, runAsUser } from '../lib/scope.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const aiKeys = Object.keys(process.env).filter((k) => /(ZAI|Z_AI|GLM|ZHIPU)/i.test(k));
  const configured = isConfigured();
  const isolation = previewIsolationStatus();
  let deck = null;
  const owner = ownerUserId();
  // Skip deck read when non-prod would fail closed — avoids a 500 on /api/health
  // before ops finishes the env split (#104 / #106). Owner scope when mapped.
  if (configured && isolation.ok && owner) {
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
    previewIsolation: isolation,
    detectedEnvKeys: [...detectedKeys(), ...aiKeys]
  });
}
