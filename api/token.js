// GET    /api/token  -> list this user's Stream Deck API tokens (metadata only)
// POST   /api/token  -> create a new token { label? }; plaintext returned once
// DELETE /api/token?hash=…  -> revoke one token
//
// Requires a Clerk session (not a plugin token — chicken-and-egg). The plaintext
// `ht_…` value is what the plugin puts in settings.key / ?key=.
import { handleOptions, withUser, setCors } from '../lib/auth.js';
import { isConfigured } from '../lib/store.js';
import { createApiToken, listApiTokens, revokeApiToken } from '../lib/tokens.js';

export default async function handler(req, res) {
  if (handleOptions(req, res, 'GET, POST, DELETE, OPTIONS')) return;
  setCors(res, { methods: 'GET, POST, DELETE, OPTIONS' });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!isConfigured()) {
      res.status(503).json({ error: 'Storage not connected.' });
      return;
    }
    // Token minting requires a Clerk session — reject plugin-token auth so a
    // stolen deck key cannot mint more keys for the same userId.
    await withUser(req, res, async (auth) => {
      if (auth.via === 'token') {
        res.status(403).json({ error: 'Sign in on the web to manage API tokens.' });
        return;
      }
      if (req.method === 'GET') {
        res.status(200).json({ tokens: await listApiTokens(auth.userId) });
        return;
      }
      if (req.method === 'POST') {
        const body = typeof req.body === 'object' && req.body ? req.body : {};
        const { token, meta } = await createApiToken(auth.userId, { label: body.label });
        res.status(201).json({
          token,
          prefix: meta.prefix,
          label: meta.label,
          createdAt: meta.createdAt,
          hash: meta.hash,
          note: 'Copy this token into the Stream Deck plugin settings.key. It is shown once.'
        });
        return;
      }
      if (req.method === 'DELETE') {
        const hash = String((req.query || {}).hash || '');
        if (!hash) {
          res.status(400).json({ error: 'Missing ?hash=' });
          return;
        }
        const ok = await revokeApiToken(auth.userId, hash);
        if (!ok) {
          res.status(404).json({ error: 'Token not found.' });
          return;
        }
        res.status(200).json({ revoked: true });
        return;
      }
      res.status(405).json({ error: 'Method not allowed' });
    }, {
      // Only Clerk sessions may manage tokens.
      verifyApiToken: async () => null
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
