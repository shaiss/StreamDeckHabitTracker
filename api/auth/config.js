// GET /api/auth/config -> { publishableKey, configured }
// Public: the publishable key is meant for the browser. Never returns the secret.
import { publishableKey, clerkConfigured, setCors } from '../../lib/auth.js';

export default async function handler(req, res) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const pk = publishableKey();
  res.status(200).json({
    configured: clerkConfigured(),
    publishableKey: pk || null
  });
}
