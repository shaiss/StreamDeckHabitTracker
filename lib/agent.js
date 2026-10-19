// The coach driven by the Vercel AI SDK directly (Keel decision on #66 —
// drop @mastra/core). z.ai (GLM) plugs in through @ai-sdk/openai-compatible;
// a custom fetch injects thinking:disabled into every chat/completions body
// — GLM-5.x are hybrid reasoning models and will otherwise spend the whole
// token budget thinking (see PR #2 / lib/zai-fetch.js). NEVER wire this up
// without that custom fetch; there is no other guardrail.
//
// Hypothesis memory is a two-tool loop over Redis (issue #36):
// recall_hypotheses / update_hypotheses → habits:coach:memory via
// lib/coach-memory.js. Same key, max length, and updatedAt as before.
import { generateText, tool, isStepCount } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import { zaiKey, zaiModel } from './ai.js';
import { zaiFetch } from './zai-fetch.js';
import { recallHypothesesNotes, updateHypothesesNotes, MEMORY_MAX } from './coach-memory.js';
import { getCoachMemory } from './store.js';

export const COACH_INSTRUCTIONS =
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
  'so never propose more than 4.';

const recallHypotheses = tool({
  description:
    'Read your own previous hypothesis notes about this human — the working theories you have been testing, ' +
    'conclusions drawn, and open questions. Call this at the START of every pass so your decision builds on ' +
    'what you already know rather than starting blank.',
  inputSchema: z.object({}),
  execute: async () => recallHypothesesNotes()
});

const updateHypotheses = tool({
  description:
    'Persist your working notes about the human: hypotheses you are testing via slot keys, ' +
    'conclusions you have drawn, and open questions. Overwrites the previous notes, so ' +
    'carry forward anything still relevant. Call at most once per turn.',
  inputSchema: z.object({
    notes: z.string().max(MEMORY_MAX).describe('Your full updated notes (they replace the old ones)')
  }),
  execute: async ({ notes }) => updateHypothesesNotes(notes)
});

function coachModel() {
  const provider = createOpenAICompatible({
    name: 'zai',
    baseURL: process.env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4',
    apiKey: zaiKey(),
    fetch: zaiFetch
  });
  return provider(zaiModel());
}

// One coach turn: instructions + tools + the per-pass request prompt.
// Returns { text } so lib/coach.js ask() stays injectable/testable.
// stopWhen allows recall → optional update → final JSON (default is 1 step).
export async function generateCoach(prompt) {
  const result = await generateText({
    model: coachModel(),
    instructions: COACH_INSTRUCTIONS,
    prompt,
    tools: {
      recall_hypotheses: recallHypotheses,
      update_hypotheses: updateHypotheses
    },
    stopWhen: isStepCount(5)
  });
  return { text: result.text };
}

// Read the coach's hypothesis notes directly. Used by the dashboard/UI, not by
// the model itself (the model reads them via the recall_hypotheses tool).
export async function coachMemory() {
  const doc = await getCoachMemory();
  return doc?.notes || '(no notes yet — first session)';
}
