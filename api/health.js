// GET /api/health -> { configured, aiReady, model, detectedEnvKeys: [names only] }
// Reports whether storage and AI credentials are visible to the function.
// Returns variable NAMES only (never values), so it's safe to leave public.
import { isConfigured, detectedKeys } from '../lib/store.js';
import { zaiKey, zaiModel } from '../lib/ai.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const aiKeys = Object.keys(process.env).filter((k) => /(ZAI|Z_AI|GLM|ZHIPU)/i.test(k));
  res.status(200).json({
    configured: isConfigured(),
    aiReady: Boolean(zaiKey()),
    model: zaiModel(),
    detectedEnvKeys: [...detectedKeys(), ...aiKeys]
  });
}
