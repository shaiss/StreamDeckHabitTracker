// Dataset capture (issue #11): every slots-producing coach pass appends one
// item — the exact context it saw, what it proposed (raw, pre-sanitize), and
// its live quality score from lib/quality.js. Items use a stable
// {input, output, metadata} shape consumed by /api/experiment for
// model-vs-model replay. Cap and Redis list semantics stay here (hand-rolled;
// no framework scorer/dataset packages — decision #66). Storage stays in
// Redis to keep the Vercel footprint lean.
import { scoreOutput } from './quality.js';
import { redisCmd, redisKey } from './store.js';

const CAP = 300;

export { CAP as DATASET_CAP };

// Pure item builder — unit-tested without Redis. captureItem persists it.
export function buildDatasetItem({ kind, context, rawSlots, engine, model, fixedNames, at = Date.now() }) {
  return {
    at,
    input: { kind, context },
    output: { rawSlots },
    metadata: { engine, model, quality: scoreOutput(rawSlots, { fixedNames }) }
  };
}

// Fire-and-forget from coach passes; failures never affect the pass itself.
export async function captureItem({ kind, context, rawSlots, engine, model, fixedNames }) {
  const item = buildDatasetItem({ kind, context, rawSlots, engine, model, fixedNames });
  const key = redisKey('habits:dataset');
  await redisCmd(['RPUSH', key, JSON.stringify(item)]);
  await redisCmd(['LTRIM', key, String(-CAP), '-1']);
  return item;
}

export async function listItems(n = 10) {
  const res = await redisCmd([
    'LRANGE',
    redisKey('habits:dataset'),
    String(-Math.max(1, Math.min(n, CAP))),
    '-1'
  ]);
  return (res || [])
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function storeExperiment(doc) {
  return redisCmd(['SET', redisKey('habits:experiment:latest'), JSON.stringify(doc)]);
}

export async function getExperiment() {
  const raw = await redisCmd(['GET', redisKey('habits:experiment:latest')]);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
