// GET /api/experiment                -> latest stored experiment result
// GET /api/experiment?run=1[&models=glm-5.2,glm-4.7-flash][&n=3]
//   Replays the last n captured coach contexts (habits:dataset) against each
//   model with byte-identical prompts (lib/coach.js PROMPTS) and scores every
//   reply with the rule-based output-quality scorers. Compares models on the
//   coach's REAL production workload before a prompt/model change ships.
//   Invoked manually or by .github/workflows/coach-experiment.yml.
// Auth: HABIT_KEY (x-habit-key / ?key=) if set. Model names are allowlisted
// and run=1 is single-flight + cooldown-guarded (#122). 60s budget; keep
// n*models modest.
import { isConfigured } from '../lib/store.js';
import { chat, extractJson, zaiKey, zaiModel } from '../lib/ai.js';
import { PROMPTS } from '../lib/coach.js';
import { scoreOutput } from '../lib/quality.js';
import { listItems, storeExperiment, getExperiment } from '../lib/dataset.js';
import { getHabits } from '../lib/habits.js';
import { keyDenied } from '../lib/habit-key.js';
import {
  parseExperimentModels,
  claimExperimentRun,
  finishExperimentRun,
  EXPERIMENT_RUN_TIMEOUT_MS
} from '../lib/experiment-guard.js';

/** Safe server log: name + short message only (no stacks, secrets, or response bodies). */
function logExperimentError(label, err) {
  const name = err?.name || 'Error';
  const msg = String(err?.message || err).slice(0, 200);
  console.error(label, name, msg);
}

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
    if (keyDenied(req, res)) return;
    if (!zaiKey() || !isConfigured()) {
      res.status(503).json({ error: 'AI or storage not configured.' });
      return;
    }

    const parsed = parseExperimentModels(q.models, { preferred: zaiModel() });
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const models = parsed.models;
    const n = Math.max(1, Math.min(parseInt(q.n, 10) || 3, 5));
    const items = (await listItems(n)).filter((it) => PROMPTS[it.input?.kind]);
    const fixedNames = (await getHabits()).map((h) => h.name);
    if (!items.length) {
      res.status(409).json({ error: 'Dataset is empty — run a coach pass first (e.g. /api/suggest?run=1).' });
      return;
    }

    // Deadline covers claim Redis ops too — a stalled lock/cooldown must not
    // burn the whole Vercel maxDuration with no abort path.
    const runController = new AbortController();
    const runTimer = setTimeout(() => runController.abort(), EXPERIMENT_RUN_TIMEOUT_MS);
    let lockOwned = false;
    let lockHandled = false;
    try {
      const signal = runController.signal;
      const claim = await claimExperimentRun({ signal });
      if (!claim.ok) {
        res.setHeader('Retry-After', String(claim.retryAfterSec));
        res.status(429).json({
          error: 'Experiment just ran — try again shortly.',
          retryAfter: claim.retryAfterSec
        });
        return;
      }
      lockOwned = true;

      // All calls in parallel; per-call failure counts against that model.
      // AbortError (run deadline) is not swallowed into a per-model score —
      // it fails the whole run so we do not store a truncated result.
      const runs = await Promise.all(
        items.flatMap((it) =>
          models.map(async (model) => {
            const prompt = PROMPTS[it.input.kind](it.input.context);
            try {
              const text = await chat([{ role: 'user', content: prompt }], {
                model,
                temperature: 0.8,
                signal
              });
              let raw = null, parseOk = true;
              try {
                const parsedJson = extractJson(text);
                raw = Array.isArray(parsedJson.slots) ? parsedJson.slots : parsedJson.change === false ? [] : null;
                if (raw === null) parseOk = false;
              } catch {
                parseOk = false;
              }
              return { model, kind: it.input.kind, itemAt: it.at, quality: scoreOutput(raw, { parseOk, fixedNames }), error: null };
            } catch (err) {
              if (signal.aborted || err?.name === 'AbortError') throw err;
              return {
                model, kind: it.input.kind, itemAt: it.at,
                quality: scoreOutput(null, { parseOk: false, fixedNames }),
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
      await storeExperiment(doc, { signal });
      // Stamp cooldown before telling the client we succeeded. If the stamp
      // fails, finishExperimentRun leaves the lock until TTL (fail closed) and
      // we surface 500 — never a silent "success" with no cooldown.
      try {
        await finishExperimentRun({ ok: true, signal });
      } catch (err) {
        lockHandled = true;
        logExperimentError('finishExperimentRun failed:', err);
        res.status(500).json({ error: 'Experiment failed.' });
        return;
      }
      lockHandled = true;
      res.status(200).json(doc);
    } finally {
      clearTimeout(runTimer);
      if (lockOwned && !lockHandled) {
        // No aborted signal — cleanup after the deadline must still DEL.
        await finishExperimentRun({ ok: false }).catch((err) => {
          logExperimentError('finishExperimentRun failed:', err);
        });
      }
    }
  } catch (err) {
    logExperimentError('experiment failed:', err);
    res.status(500).json({ error: 'Experiment failed.' });
  }
}
