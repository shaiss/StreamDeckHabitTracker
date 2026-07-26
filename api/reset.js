// TEMPORARY: guarded one-shot to clear the seed/test data. Removed after use.
import { clearAll } from '../lib/store.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if ((req.query || {}).token !== 'cleanup-7f3a91b2') {
    res.status(403).send('forbidden');
    return;
  }
  try {
    await clearAll();
    res.status(200).send('cleared');
  } catch (err) {
    res.status(500).send('Error: ' + (err && err.message ? err.message : err));
  }
}
