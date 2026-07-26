// Natural-language logging (the dashboard's "Tell the coach" box).
//   POST {"text":"..."}     -> parse only: proposed {entries, unmatched, reply};
//                              NOTHING is written — the human confirms first.
//   POST {"entries":[...]}  -> the confirm step: re-validate every entry
//                              against the live keys, append to the log, then
//                              let the coach react in the background.
//   GET  ?run=1&text=...    -> parse only, for probing (model call, no write).
import { waitUntil } from '@vercel/functions';
import { appendMany, isConfigured } from '../lib/store.js';
import { zaiKey } from '../lib/ai.js';
import { reactTo } from '../lib/coach.js';
import { parseNl, sanitizeNlEntries, loggableKeys } from '../lib/nlog.js';

// Only entries this fresh trigger the coach's reactive pass — its prompt says
// "the human JUST tapped a key", which is a lie for a backdated report like
// "big dinner yesterday evening" and would repaint today's keys around a
// long-gone moment.
const REACT_FRESH_MS = 15 * 60_000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const q = req.query || {};
    const body = req.method === 'POST' && req.body && typeof req.body === 'object' ? req.body : {};
    if (req.method !== 'POST' && q.run !== '1') {
      res.status(405).json({
        error: 'POST {"text":"..."} to parse, {"entries":[...]} to log — or GET ?run=1&text=... to try a parse.'
      });
      return;
    }
    const secret = process.env.HABIT_KEY;
    if (secret && q.key !== secret && body.key !== secret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!isConfigured()) {
      res.status(503).json({ error: 'Storage not connected.' });
      return;
    }

    // Confirm step. Entries round-trip from a proposal, but never trust the
    // wire: the same sanitizer that gated the model gates the client.
    if (Array.isArray(body.entries)) {
      const { entries } = sanitizeNlEntries({ entries: body.entries }, await loggableKeys());
      if (!entries.length) {
        res.status(400).json({ error: 'No valid entries — habits must match existing keys.' });
        return;
      }
      await appendMany(entries);
      res.status(200).json({ ok: true, logged: entries });
      // The coach hears about it after the response, same as a key tap
      // (reactTo's cooldown makes multi-entry commits a single pass).
      const latest = entries.reduce((a, b) => (b.t > a.t ? b : a));
      if (zaiKey() && Date.now() - latest.t < REACT_FRESH_MS) {
        waitUntil(reactTo(latest).catch(() => {}));
      }
      return;
    }

    const text = String(body.text ?? q.text ?? '').trim();
    if (!text) {
      res.status(400).json({ error: 'Missing text' });
      return;
    }
    if (!zaiKey()) {
      res.status(503).json({
        error:
          'No AI key set. In Vercel: project -> Settings -> Environment Variables -> add ZAI_API_KEY (from z.ai), then redeploy.'
      });
      return;
    }
    res.status(200).json(await parseNl(text));
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
