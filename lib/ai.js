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
  // glm-4.7-flash is free-tier on z.ai, so it works on any key; override with
  // ZAI_MODEL (e.g. glm-4.7) for stronger suggestions.
  return process.env.ZAI_MODEL || 'glm-4.7-flash';
}

export async function chat(messages, { temperature = 0.8, maxTokens = 900 } = {}) {
  const url = (process.env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${zaiKey()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: zaiModel(),
      messages,
      temperature,
      max_tokens: maxTokens
    })
  });
  if (!res.ok) {
    throw new Error(`z.ai ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error('z.ai returned no content');
  return content;
}

// Pull the first JSON object out of a model reply (tolerates ``` fences/prose).
export function extractJson(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e <= s) throw new Error('no JSON in model reply');
  return JSON.parse(text.slice(s, e + 1));
}
