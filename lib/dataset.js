// Dataset capture (issue #11): every slots-producing coach pass appends one
// item — the exact context it saw, what it proposed (raw, pre-sanitize), and
// its live quality score. Items are Mastra-Dataset-shaped ({input, output,
// metadata}) so they can be exported into Mastra's Datasets/Experiments
// tooling verbatim; storage stays in Redis to keep the Vercel footprint lean.
import { scoreOutput } from './quality.js';

const DATASET_KEY = 'habits:dataset';
const EXPERIMENT_KEY = 'habits:experiment:latest';
const CAP = 300;

// Storage primitives live in store.js but its cmd() is private; a tiny local
// mirror avoids widening that surface.
async function cmd(args) {
  const url =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  if (!res.ok) throw new Error(`store ${res.status}`);
  return (await res.json()).result;
}

// Fire-and-forget from coach passes; failures never affect the pass itself.
export async function captureItem({ kind, context, rawSlots, engine, model, fixedNames }) {
  const item = {
    at: Date.now(),
    input: { kind, context },
    output: { rawSlots },
    metadata: { engine, model, quality: scoreOutput(rawSlots, { fixedNames }) }
  };
  await cmd(['RPUSH', DATASET_KEY, JSON.stringify(item)]);
  await cmd(['LTRIM', DATASET_KEY, String(-CAP), '-1']);
  return item;
}

export async function listItems(n = 10) {
  const res = await cmd(['LRANGE', DATASET_KEY, String(-Math.max(1, Math.min(n, CAP))), '-1']);
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
  return cmd(['SET', EXPERIMENT_KEY, JSON.stringify(doc)]);
}

export async function getExperiment() {
  const raw = await cmd(['GET', EXPERIMENT_KEY]);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
