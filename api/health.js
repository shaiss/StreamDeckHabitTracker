// GET /api/health -> { configured, aiReady, model, deck, detectedEnvKeys: [names only] }
// Reports whether storage and AI credentials are visible to the function, and
// when a physical Stream Deck last polled (`deck`, null if never) — the quickest
// way to tell a dead plugin from a dead backend.
// Returns variable NAMES only (never values), so it's safe to leave public.
import { isConfigured, detectedKeys, getDeckState } from '../lib/store.js';
import { zaiKey, zaiModel } from '../lib/ai.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const aiKeys = Object.keys(process.env).filter((k) => /(ZAI|Z_AI|GLM|ZHIPU)/i.test(k));
  const configured = isConfigured();
  const deck = configured ? await getDeckState().catch(() => null) : null;
  res.status(200).json({
    configured,
    aiReady: Boolean(zaiKey()),
    model: zaiModel(),
    deck: deck ? { ...deck, agoMs: Date.now() - (deck.at || 0) } : null,
    detectedEnvKeys: [...detectedKeys(), ...aiKeys]
  });
}
