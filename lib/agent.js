// The coach as a Mastra agent. z.ai (GLM) plugs in through the AI SDK's
// OpenAI-compatible provider; a custom fetch injects thinking:disabled into
// every chat/completions body — GLM-5.x are hybrid reasoning models and will
// otherwise spend the whole token budget thinking (see PR #2). NEVER wire this
// agent up without that custom fetch; there is no other guardrail.
//
// Hypothesis memory is a two-tool loop, both Mastra-mediated: recall_hypotheses
// (the model reads its prior notes at the start of a pass) and update_hypotheses
// (the model rewrites them when its understanding changes). The bytes persist in
// the habits:coach:memory Redis key via lib/store.js — that key survives Vercel
// cold starts, which Mastra's in-process memory would not without a full storage
// adapter we deliberately choose not to add (see issue #36).
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import { zaiKey, zaiModel } from './ai.js';
import { getCoachMemory, setCoachMemory } from './store.js';

function zaiFetch(url, init) {
  if (init?.body && String(url).includes('/chat/completions')) {
    try {
      const body = JSON.parse(init.body);
      if (!body.thinking) body.thinking = { type: 'disabled' };
      init = { ...init, body: JSON.stringify(body) };
    } catch { /* pass through untouched */ }
  }
  return fetch(url, init);
}

const recallHypotheses = createTool({
  id: 'recall_hypotheses',
  description:
    'Read your own previous hypothesis notes about this human — the working theories you have been testing, ' +
    'conclusions drawn, and open questions. Call this at the START of every pass so your decision builds on ' +
    'what you already know rather than starting blank.',
  inputSchema: z.object({}),
  outputSchema: z.object({ notes: z.string() }),
  execute: async () => {
    const doc = await getCoachMemory().catch(() => null);
    return { notes: doc?.notes || '(no notes yet — first session)' };
  }
});

const updateHypotheses = createTool({
  id: 'update_hypotheses',
  description:
    'Persist your working notes about the human: hypotheses you are testing via slot keys, ' +
    'conclusions you have drawn, and open questions. Overwrites the previous notes, so ' +
    'carry forward anything still relevant. Call at most once per turn.',
  inputSchema: z.object({
    notes: z.string().max(2000).describe('Your full updated notes (they replace the old ones)')
  }),
  outputSchema: z.object({ saved: z.boolean() }),
  execute: async ({ notes }) => {
    await setCoachMemory({ notes: String(notes).slice(0, 2000), updatedAt: Date.now() });
    return { saved: true };
  }
});

export function coachAgent() {
  const provider = createOpenAICompatible({
    name: 'zai',
    baseURL: process.env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4',
    apiKey: zaiKey(),
    fetch: zaiFetch
  });
  return new Agent({
    id: 'coach',
    name: 'Habit Coach',
    instructions:
      'You are the AI coach living inside a personal habit tracker. The human logs habits by tapping physical ' +
      'Stream Deck keys. You control up to 4 extra keys — they are your ONLY voice to the human, your gateway ' +
      'for interacting with them. Use them to ask for feedback, close gaps in your understanding, or test ' +
      'hypotheses about their day.\n\n' +
      'EVERY pass: call recall_hypotheses first to load your prior notes about this human. When your ' +
      'understanding meaningfully changes, call update_hypotheses with your full revised notes (max 2000 chars). ' +
      'These two tools ARE your memory — do not restate the notes in your reply.\n\n' +
      'Reply shape (your final message must be ONLY a JSON object — no prose, no code fences, in the shape the ' +
      'request asks for):\n' +
      '- Suggest / morning: {"slots":[{...}]} — 1 to 4 items; a slots array REPLACES ALL current slots.\n' +
      '- React (after a tap): {"change":false} OR {"slots":[...]} as above.\n' +
      '- Nudge: {"nudge":false} OR {"nudge":true,"slot":1..4,"habit","emoji","label","reason","ttlMinutes"}.\n' +
      '- Roster: {"proposals":[{"kind":"add"|"retire","name","emoji","label","reason"}]} — empty list means no change.\n' +
      '- Digest: {"insight":"2-3 sentences"}.\n\n' +
      'Per-slot rules (enforced server-side regardless of what you emit): habit is letters/digits/underscores/' +
      'hyphens, max 24 chars, and must NOT duplicate a fixed habit; label max 12 chars; exactly one emoji; ' +
      'reason max 160 chars; optional ttlMinutes 15..720. Items beyond the 4-slot cap are dropped silently, ' +
      'so never propose more than 4.',
    model: provider(zaiModel()),
    tools: { recallHypotheses, updateHypotheses }
  });
}

// Read the coach's hypothesis notes directly. Used by the dashboard/UI, not by
// the agent itself (the agent reads them via the recall_hypotheses tool).
export async function coachMemory() {
  const doc = await getCoachMemory();
  return doc?.notes || '(no notes yet — first session)';
}
