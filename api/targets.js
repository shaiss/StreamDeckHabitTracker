// GET  /api/targets        -> { proposals, history, lastRunAt, model }
// GET  /api/targets?run=1  -> run a coach target pass now (30s cooldown)
// POST /api/targets        -> { id, decision: 'approve'|'dismiss' }
//
// Adaptive daily targets (#70): the coach proposes/applies goal changes
// (lib/coach.js targetPass, also run by the morning cron after roster). Downs
// auto-apply; ups wait here for a human decision. HABIT_KEY gates writes via
// x-habit-key (preferred), ?key=, or body.key — see lib/habit-key.js (#112:
// production fails closed when the secret is unset).
import { isConfigured, getTargets, setTargets, setHabitsAndTargets, withTargetsLock } from '../lib/store.js';
import { getHabitsStrict, prepareHabits, validateHabits } from '../lib/habits.js';
import { zaiKey } from '../lib/ai.js';
import { targetPass } from '../lib/coach.js';
import {
  normalizeTargets,
  applyTargetDecision,
  formatTargetLine,
  targetsClientMessage,
  targetsHttpError,
  TARGETS_WRITE_FAILED_MSG
} from '../lib/target.js';
import { keyDenied } from '../lib/habit-key.js';

const view = (doc) => ({
  proposals: doc.proposals,
  history: doc.history,
  lastRunAt: doc.lastRunAt,
  model: doc.model,
  lines: doc.history.slice(0, 8).map(formatTargetLine)
});

function wrapTargetsWriteError(op, err) {
  console.error(`[api/targets] ${op} failed:`, err?.message || err);
  const e = new Error(TARGETS_WRITE_FAILED_MSG);
  e.code = 'TARGETS_WRITE_FAILED';
  e.cause = err;
  return e;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-habit-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  try {
    if (!isConfigured()) {
      res.status(503).json({ error: 'Storage not connected.' });
      return;
    }
    const q = req.query || {};

    if (req.method !== 'POST') {
      const current = normalizeTargets(await getTargets());
      if (q.run !== '1') {
        res.status(200).json(view(current));
        return;
      }
      if (keyDenied(req, res)) return;
      if (!zaiKey()) {
        res.status(503).json({ error: 'No AI key set — add ZAI_API_KEY in Vercel, then redeploy.' });
        return;
      }
      // Cooldown is claimed under withTargetsLock inside targetPass (not here)
      // so concurrent ?run=1 cannot all pass a pre-check and each spend a model
      // call. TARGETS_COOLDOWN / TARGETS_BUSY map via targetsHttpError.
      try {
        const doc = await targetPass();
        res.status(200).json({
          autoApplied: doc.autoApplied,
          queued: doc.queued,
          parseError: doc.parseError || undefined,
          ...view(doc)
        });
      } catch (err) {
        const mapped = targetsHttpError(err);
        if (mapped.status === 429) {
          res.status(429).json({
            error: mapped.error,
            ...view(normalizeTargets(mapped.doc || current))
          });
          return;
        }
        if (mapped.status === 409) {
          res.status(409).json({ error: mapped.error });
          return;
        }
        throw err;
      }
      return;
    }

    const body = typeof req.body === 'object' && req.body ? req.body : {};
    if (keyDenied(req, res, body)) return;
    // Same lock as commitTargetPass — covers reads+writes of habits and targets
    // so a concurrent coach pass cannot SET a stale snapshot over this decision.
    let saved;
    let result;
    try {
      await withTargetsLock(async () => {
        const [habits, targets] = await Promise.all([getHabitsStrict(), getTargets()]);
        result = applyTargetDecision({
          habits,
          targets,
          id: String(body.id || ''),
          decision: String(body.decision || '')
        });
        if (result.error) return;
        saved = habits;
        if (result.habits !== habits) {
          const err = validateHabits(result.habits);
          if (err) {
            result = { error: err };
            return;
          }
          // Atomic with history — same rail as commitTargetPass auto-downs.
          saved = prepareHabits(result.habits);
          try {
            await setHabitsAndTargets(saved, result.targets);
          } catch (writeErr) {
            throw wrapTargetsWriteError('setHabitsAndTargets', writeErr);
          }
        } else {
          try {
            await setTargets(result.targets);
          } catch (writeErr) {
            throw wrapTargetsWriteError('setTargets', writeErr);
          }
        }
      });
    } catch (err) {
      const mapped = targetsHttpError(err);
      if (mapped.status === 409) {
        res.status(409).json({ error: mapped.error });
        return;
      }
      throw err;
    }
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(200).json({
      ok: true,
      applied: result.applied,
      habits: saved,
      line: result.applied?.status === 'approved' ? formatTargetLine(result.applied) : undefined,
      ...view(result.targets)
    });
  } catch (err) {
    // Log the real failure; clients only ever see a stable generic 500 body.
    console.error('[api/targets] error:', err?.message || err);
    const mapped = targetsHttpError(err);
    res.status(mapped.status === 500 ? 500 : mapped.status).json({
      error: mapped.status === 500 ? targetsClientMessage(err) : mapped.error
    });
  }
}
