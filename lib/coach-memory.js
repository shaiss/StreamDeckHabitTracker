// Hypothesis-memory helpers over habits:coach:memory (issue #36).
// Pure Redis semantics — AI SDK tools in lib/agent.js wrap these. Store
// accessors are injectable so the zero-dep unit suite can pin behavior
// without Redis or the AI SDK.
import { getCoachMemory, setCoachMemory } from './store.js';

export const EMPTY_NOTES = '(no notes yet — first session)';
export const MEMORY_MAX = 2000;

export async function recallHypothesesNotes({ getMemory = getCoachMemory } = {}) {
  const doc = await getMemory().catch(() => null);
  return { notes: doc?.notes || EMPTY_NOTES };
}

export async function updateHypothesesNotes(notes, { setMemory = setCoachMemory, now = Date.now } = {}) {
  const trimmed = String(notes).slice(0, MEMORY_MAX);
  await setMemory({ notes: trimmed, updatedAt: now() });
  return { saved: true };
}
