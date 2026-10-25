// Question dismiss requires auth; GET is user-scoped.
import { getQuestions, getSlots, isConfigured } from '../lib/store.js';
import { dismissQuestion } from '../lib/coach.js';
import { openQuestion, scoreQuestions } from '../lib/question.js';
import { handleOptions, optionalAuth, withUser, setCors } from '../lib/auth.js';
import { runAsUser } from '../lib/scope.js';

export default async function handler(req, res) {
  if (handleOptions(req, res, 'GET, POST, OPTIONS')) return;
  setCors(res, { methods: 'GET, POST, OPTIONS' });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const q = req.query || {};
    if (!isConfigured()) {
      res.status(503).json({ error: 'Storage not connected.' });
      return;
    }

    if (q.dismiss === '1') {
      await withUser(req, res, async () => {
        let qid = (q.qid || '').toString();
        if (!qid) {
          const n = parseInt(q.slot, 10);
          const def = n >= 1 && n <= 4 ? (await getSlots()).slots[n - 1] : null;
          qid = def && def.qid ? def.qid : '';
        }
        if (!qid) {
          res.status(409).json({ error: 'No open question on that key.' });
          return;
        }
        const rec = await dismissQuestion(qid);
        if (!rec) {
          res.status(409).json({ error: 'No such question.' });
          return;
        }
        res.status(200).json({ dismissed: true, qid, text: rec.text });
      });
      return;
    }

    const auth = await optionalAuth(req);
    if (!auth) {
      res.status(200).json({ open: null, track: null, authRequired: true });
      return;
    }
    await runAsUser(auth.userId, async () => {
      const records = await getQuestions();
      res.status(200).json({
        open: openQuestion(records),
        track: scoreQuestions(records)
      });
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
