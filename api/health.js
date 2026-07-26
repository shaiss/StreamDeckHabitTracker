// GET /api/health -> { configured, detectedEnvKeys: [names only] }
// Reports whether the storage credentials are visible to the function.
// Returns variable NAMES only (never values), so it's safe to leave public.
import { isConfigured, detectedKeys } from '../lib/store.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ configured: isConfigured(), detectedEnvKeys: detectedKeys() });
}
