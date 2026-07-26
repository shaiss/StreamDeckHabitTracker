// GET/POST /api/log?habit=NAME[&note=...][&key=SECRET]
// One tap -> one stored row. Returns plain text (the Stream Deck ignores it,
// but it's handy when you open the URL in a browser to test).
import { append, isConfigured } from '../lib/store.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  try {
    const q = req.query || {};
    const habit = (q.habit || '').toString().trim();
    if (!habit) {
      res.status(400).send('Missing habit');
      return;
    }

    // Optional shared secret. Set HABIT_KEY in the Vercel project env to require it.
    const secret = process.env.HABIT_KEY;
    if (secret && q.key !== secret) {
      res.status(401).send('Unauthorized');
      return;
    }

    if (!isConfigured()) {
      res
        .status(503)
        .send('Storage not connected yet. In Vercel: Storage -> create Upstash/KV -> connect to this project, then redeploy.');
      return;
    }

    await append({ h: habit, t: Date.now(), note: (q.note || '').toString() });
    res.status(200).send('Logged: ' + habit);
  } catch (err) {
    res.status(500).send('Error: ' + (err && err.message ? err.message : err));
  }
}
