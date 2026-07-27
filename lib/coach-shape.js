// Pure, dependency-free coach output shaping: the slot sanitizer and the
// per-flow prompt templates. Split out of lib/coach.js so the unit suite
// (which is zero-dep by design — CI's unit job runs no `npm install`) can pin
// these without pulling lib/agent.js -> @mastra/core. lib/coach.js re-exports
// both for back-comat; the experiment runner and the agent instructions both
// depend on these exact shapes.
import { NUDGE_PROMPT } from './nudge.js';
import { QUESTION_CLAUSE } from './question.js';
import { MAX_PENDING } from './roster.js';

// Coerce model output into safe slot defs (max 4 by default; the coach page
// passes { max: 12 } — issue #52). Items beyond the cap, items whose habit
// sanitizes to empty, and duplicates (case-insensitive) of the
// reserved/fixed habits OR of an earlier item this pass are dropped silently —
// never thrown on. Callers handle an empty result (no slots committed).
export function sanitize(items, { defaultTtlMs = 0, reserved, max = 4 } = {}) {
  const seen = new Set(reserved || []);
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (out.length >= max || !it || typeof it !== 'object') break;
    const habit = String(it.habit || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
    if (!habit || seen.has(habit.toLowerCase())) continue;
    seen.add(habit.toLowerCase());
    const def = {
      habit,
      emoji: String(it.emoji || '✨').slice(0, 8),
      label: String(it.label || habit).slice(0, 12),
      reason: String(it.reason || '').slice(0, 160),
      assignedAt: Date.now()
    };
    // The model may scope a key in time (ttlMinutes 15min..12h); reactive
    // feedback keys get a default TTL so they don't squat a slot all day.
    const ttlMin = Number(it.ttlMinutes);
    if (ttlMin >= 15 && ttlMin <= 720) def.expiresAt = Date.now() + ttlMin * 60_000;
    else if (defaultTtlMs > 0) def.expiresAt = Date.now() + defaultTtlMs;
    out.push(def);
  }
  return out;
}

// Prompt templates, keyed by pass kind. Kept as pure (context) -> string so
// the experiment runner (/api/experiment) can replay a captured context
// against other models with byte-identical requests (issue #11).
export const PROMPTS = {
  suggest: (c) =>
    'Propose what YOU want the human to start logging next — be concrete and personal, not generic. ' +
    'You may add "ttlMinutes" (15-720) to time-scoped keys. ' + QUESTION_CLAUSE + ' ' +
    'Reply with ONLY JSON: {"slots":[{"habit":"OneWordId","emoji":"🪴","label":"Short","reason":"why, referencing their data"}]}\n\n' +
    'Context: ' + JSON.stringify(c),
  react: (c) =>
    'The human JUST tapped a key. Decide whether to repaint your slot keys in response — e.g. right after Eat ' +
    'you might want "FoodGood 👍" / "FoodBad 👎" feedback keys; after Exercise, maybe "Energized" vs "Wiped". ' +
    'Only change keys when it genuinely helps you learn; otherwise keep them. ' +
    'justTapped.intensity is "high" when they double-tapped the key — a big meal, a hard session — and ' +
    '"normal" for a plain tap; bigTaps in their history counts those. ' +
    'You may add "ttlMinutes" (15-720) to any slot that should expire, e.g. a meal-feedback key. ' +
    QUESTION_CLAUSE + ' ' +
    'Reply with ONLY JSON: {"change":false} OR {"slots":[{"habit":"OneWordId","emoji":"👍","label":"Short","reason":"..."}]}\n\n' +
    'Context: ' + JSON.stringify(c),
  morning: (c) =>
    `It is morning for your human (timezone ${c.human?.timezone || 'unknown'}). Review yesterday, your notes, ` +
    'and your track record, then set the keys you want active for the day ahead. You may add "ttlMinutes" ' +
    '(15-720) to time-scoped keys. ' + QUESTION_CLAUSE + ' ' +
    'Reply with ONLY JSON: {"slots":[{"habit":"OneWordId","emoji":"🌅","label":"Short","reason":"..."}]}\n\n' +
    'Context: ' + JSON.stringify(c),
  // Lives in lib/nudge.js (dependency-free, unit-pinned); registered here so
  // the experiment runner can replay captured nudge contexts like any pass.
  nudge: NUDGE_PROMPT,
  roster: (c) =>
    'Review the FIXED habit roster — the permanent keys, not your 4 ✨ slots — and propose changes to it. ' +
    'Add only what earns a key every single day; retire only what has gone stale or that the human has ' +
    'clearly stopped caring about. Proposing nothing is the right answer most days. ' +
    `At most ${MAX_PENDING} proposals, and each one goes to the human to approve or dismiss — so make the ` +
    'reason worth reading, and cite the data behind it. ' +
    'Reply with ONLY JSON: {"proposals":[{"kind":"add","name":"OneWordId","emoji":"🪴","label":"Short","reason":"why"}]} ' +
    '— "kind" is "add" or "retire", and a "retire" name must already be on the roster. Empty list means no change.\n\n' +
    'Context: ' + JSON.stringify(c)
};
