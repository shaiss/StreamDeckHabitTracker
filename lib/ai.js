// Z.AI (GLM) client — OpenAI-compatible chat completions.
// Key comes from the Vercel project env (Settings -> Environment Variables).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export const BASE_HABITS = require('../config/habits.json').habits;

export function zaiKey() {
  const env = process.env;
  return env.ZAI_API_KEY || env.Z_AI_API_KEY || env.GLM_API_KEY || env.ZHIPU_API_KEY || '';
}

export function zaiModel() {
  // Best model first; override with ZAI_MODEL. glm-4.7-flash (free tier) is
  // the automatic fallback if the preferred model rejects the call.
  return process.env.ZAI_MODEL || 'glm-5.2';
}

const FALLBACK_MODEL = 'glm-4.7-flash';

async function chatOnce(model, messages, { temperature, maxTokens }) {
  const url = (process.env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${zaiKey()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      // GLM-5.x are hybrid reasoning models; without this they can spend the
      // whole token budget thinking and return empty content. Our calls want
      // fast structured JSON, not chain-of-thought.
      thinking: { type: 'disabled' }
    })
  });
  if (!res.ok) {
    const err = new Error(`z.ai ${res.status} (${model}): ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  let content = json?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    content = content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  if (!content || !content.trim()) {
    const err = new Error(`z.ai (${model}) returned no content`);
    err.status = 502; // counts as a model-level failure -> fallback model runs
    throw err;
  }
  return content;
}

export async function chat(messages, { temperature = 0.8, maxTokens = 2000, model } = {}) {
  // Explicit model (experiments comparing models) = no fallback: a failure
  // must surface as that model's failure, not silently become another's win.
  if (model) return chatOnce(model, messages, { temperature, maxTokens });
  const preferred = zaiModel();
  try {
    return await chatOnce(preferred, messages, { temperature, maxTokens });
  } catch (err) {
    // Model-level rejections (unknown model, tier/quota) fall back to the free
    // model rather than leaving the coach mute. Network/auth errors propagate.
    if (preferred !== FALLBACK_MODEL && err.status && err.status !== 401) {
      return chatOnce(FALLBACK_MODEL, messages, { temperature, maxTokens });
    }
    throw err;
  }
}

// Index of the "}" that closes the object opening at `start`, or -1 if the
// text runs out first. String literals (and their escapes) are skipped so a
// brace inside a value never moves the boundary.
function balancedEnd(str, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

// Pull the first JSON object out of a model reply (tolerates ``` fences/prose).
// Prefers the first BALANCED object: GLM often follows short JSON with a
// sentence of reasoning, and a stray "}" in that prose would poison a naive
// first-{-to-last-} slice. Falls back to the wide slice for replies whose
// first object is truncated but which still close later.
export function extractJson(text) {
  const str = String(text ?? '');
  const s = str.indexOf('{');
  const e = str.lastIndexOf('}');
  if (s === -1 || e <= s) throw new Error('no JSON in model reply');
  const end = balancedEnd(str, s);
  if (end !== -1 && end !== e) {
    try {
      return JSON.parse(str.slice(s, end + 1));
    } catch { /* fall through to the wide slice */ }
  }
  return JSON.parse(str.slice(s, e + 1));
}
