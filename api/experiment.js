// GET /api/experiment                -> latest stored experiment result
// GET /api/experiment?run=1[&models=glm-5.2,glm-4.7-flash][&n=3]
//   Replays the last n captured coach contexts (habits:dataset) against each
//   model with byte-identical prompts (lib/coach.js PROMPTS) and scores every
//   reply with the rule-based output-quality scorers. Compares models on the
//   coach's REAL production workload before a prompt/model change ships.
//   Invoked manually or by .github/workflows/coach-experiment.yml.
// Auth: HABIT_KEY (?key=) if set. 60s budget; keep n*models modest.
import { isConfigured } from '../lib/store.js';
import { chat, extractJson, zaiKey, zaiModel } from '../lib/ai.js';
import { PROMPTS } from '../lib/coach.js';
import { scoreOutput } from '../lib/quality.js';
import { listItems, storeExperiment, getExperiment } from '../lib/dataset.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const q = req.query || {};
    if (q.run !== '1') {
      const latest = await getExperiment();
      res.status(200).json(latest || { note: 'No experiment yet. GET ?run=1 to run one.' });
      return;
    }
    const secret = process.env.HABIT_KEY;
    if (secret && q.key !== secret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!zaiKey() || !isConfigured()) {
      res.status(503).json({ error: 'AI or storage not configured.' });
      return;
    }

    const models = String(q.models || `${zaiModel()},glm-4.7-flash`)
      .split(',').map((s) => s.trim()).filter(Boolean).slice(0, 3);
    const n = Math.max(1, Math.min(parseInt(q.n, 10) || 3, 5));
    const items = (await listItems(n)).filter((it) => PROMPTS[it.input?.kind]);
    if (!items.length) {
      res.status(409).json({ error: 'Dataset is empty — run a coach pass first (e.g. /api/suggest?run=1).' });
      return;
    }

    // All calls in parallel; per-call failure counts against that model.
    const runs = await Promise.all(
      items.flatMap((it) =>
        models.map(async (model) => {
          const prompt = PROMPTS[it.input.kind](it.input.context);
          try {
            const text = await chat([{ role: 'user', content: prompt }], { model, temperature: 0.8 });
            let raw = null, parseOk = true;
            try {
              const parsed = extractJson(text);
              raw = Array.isArray(parsed.slots) ? parsed.slots : parsed.change === false ? [] : null;
              if (raw === null) parseOk = false;
            } catch {
              parseOk = false;
            }
            return { model, kind: it.input.kind, itemAt: it.at, quality: scoreOutput(raw, { parseOk }), error: null };
          } catch (err) {
            return {
              model, kind: it.input.kind, itemAt: it.at,
              quality: scoreOutput(null, { parseOk: false }),
              error: String(err?.message || err).slice(0, 160)
            };
          }
        })
      )
    );

    const byModel = {};
    for (const r of runs) {
      const m = (byModel[r.model] ||= { runs: 0, errors: 0, composite: 0, jsonValid: 0, specificity: 0 });
      m.runs++;
      if (r.error) m.errors++;
      m.composite += r.quality.composite;
      m.jsonValid += r.quality.jsonValid;
      m.specificity += r.quality.specificity;
    }
    const summary = Object.fromEntries(
      Object.entries(byModel).map(([m, s]) => [
        m,
        {
          runs: s.runs,
          errors: s.errors,
          avgComposite: +(s.composite / s.runs).toFixed(3),
          jsonValidRate: +(s.jsonValid / s.runs).toFixed(2),
          avgSpecificity: +(s.specificity / s.runs).toFixed(2)
        }
      ])
    );
    // Reference: quality of what production actually shipped for these items.
    const productionAvg = +(
      items.reduce((a, it) => a + (it.metadata?.quality?.composite || 0), 0) / items.length
    ).toFixed(3);

    const doc = { at: Date.now(), items: items.length, models: summary, productionAvgComposite: productionAvg, runs };
    await storeExperiment(doc);
    res.status(200).json(doc);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
