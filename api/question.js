// GET  /api/question              -> the open question (if any) + the
//                                    asked/answered/dismissed/ignored record
// POST /api/question?dismiss=1[&slot=N] -> "I'm not answering that": retires
//                                    both halves of the pair and records a
//                                    `dismissed` verdict, which must stay
//                                    distinguishable from letting it lapse.
//
// Answering happens through /api/log (tapping either key is a real log row
// that also carries the answer) — this endpoint only handles refusal and
// inspection. See lib/question.js for the rules (issue #34).
import { getQuestions, getSlots, isConfigured } from '../lib/store.js';
import { dismissQuestion } from '../lib/coach.js';
import { openQuestion, scoreQuestions } from '../lib/question.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  try {
    const q = req.query || {};
    if (!isConfigured()) {
      res.status(503).json({ error: 'Storage not connected.' });
      return;
    }

    if (q.dismiss === '1') {
      // A write, so it honors HABIT_KEY like /api/log and the nudge dismissal.
      const secret = process.env.HABIT_KEY;
      if (secret && q.key !== secret) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      // Addressable two ways: by slot (what the deck knows — it holds a key,
      // not a question id) or by qid (what the dashboard knows).
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
      return;
    }

    const records = await getQuestions();
    res.status(200).json({
      open: openQuestion(records),
      track: scoreQuestions(records)
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
