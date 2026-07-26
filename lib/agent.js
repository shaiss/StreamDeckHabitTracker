// The coach as a Mastra agent. z.ai (GLM) plugs in through the AI SDK's
// OpenAI-compatible provider; a custom fetch injects thinking:disabled into
// every chat/completions body — GLM-5.x are hybrid reasoning models and will
// otherwise spend the whole token budget thinking (see PR #2).
//
// v1 scope (issue #3): agent definition + model routing + a hypothesis-memory
// tool the model can call to persist what it's learning about its human.
// Scorers / datasets / experiments attach here later (issue #6).
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
      'hypotheses about their day. You receive your previous hypothesis notes with each request; when your ' +
      'understanding changes, call update_hypotheses with your full revised notes. ' +
      'Your final message must be ONLY a JSON object (no prose, no fences) in the shape the request asks for. ' +
      'Slot rules: 1-4 items; habit is a single CamelCase word (letters/digits, max 20 chars) never duplicating ' +
      'the fixed habits; label max 10 chars; exactly one emoji per item; a slots array replaces ALL current slots.',
    model: provider(zaiModel()),
    tools: { updateHypotheses }
  });
}

export async function coachMemory() {
  const doc = await getCoachMemory();
  return doc?.notes || '(no notes yet — first session)';
}
