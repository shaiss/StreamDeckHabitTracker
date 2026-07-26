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
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens })
  });
  if (!res.ok) {
    const err = new Error(`z.ai ${res.status} (${model}): ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`z.ai (${model}) returned no content`);
  return content;
}

export async function chat(messages, { temperature = 0.8, maxTokens = 900 } = {}) {
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

// Pull the first JSON object out of a model reply (tolerates ``` fences/prose).
export function extractJson(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e <= s) throw new Error('no JSON in model reply');
  return JSON.parse(text.slice(s, e + 1));
}
