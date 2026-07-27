// Proactive nudges: the coach taps its human on the shoulder by repainting
// ONE slot key — "💧 Water?" where a suggestion used to sit — instead of ever
// sending text. The deck's own poll loop drives the check (see api/slots.js),
// so a deck that's off nudges no one.
//
// This module is deliberately dependency-free: the gate rules and the prompt
// live here so the zero-dep unit suite can pin them (CI's unit job runs
// without npm install); the model pass that uses them is nudgePass() in
// lib/coach.js.

export const CHECK_EVERY_MS = 20 * 60_000;   // full evaluation at most 3x/hour
export const MIN_GAP_MS = 2 * 3600_000;      // between actual nudges
export const RECENT_TAP_MS = 45 * 60_000;    // recently active humans need no push
export const MIN_DAYS_OF_DATA = 3;           // no pattern, no nudge
export const QUIET_END_HOUR = 8;             // local: nudges allowed [8, 22)
export const QUIET_START_HOUR = 22;
export const NUDGE_TTL_MS = 60 * 60_000;     // default face lifetime
export const DISMISS_QUIET_MS = 4 * 3600_000; // after an explicit "not today"

// The gate: cheap, pure, and biased toward silence. The model is only
// consulted when every rule passes — an interruption has to earn its call.
export function nudgeDue({
  now, hour, lastNudgeAt = 0, lastTapAt = 0, daysOfData = 0, slots = [], lastDismissAt = 0
}) {
  if (hour < QUIET_END_HOUR || hour >= QUIET_START_HOUR) return { due: false, reason: 'quiet hours' };
  // An explicit dismissal outranks the ordinary gap: being told "not today"
  // and coming back in two hours is exactly the badgering nudges must avoid.
  if (lastDismissAt && now - lastDismissAt < DISMISS_QUIET_MS) {
    return { due: false, reason: 'dismissed recently' };
  }
  if (now - lastNudgeAt < MIN_GAP_MS) return { due: false, reason: 'nudged recently' };
  if (lastTapAt && now - lastTapAt < RECENT_TAP_MS) return { due: false, reason: 'human recently active' };
  if (daysOfData < MIN_DAYS_OF_DATA) return { due: false, reason: 'not enough history' };
  if (slots.some((s) => s && s.nudge && (!s.expiresAt || s.expiresAt > now))) {
    return { due: false, reason: 'a nudge key is already live' };
  }
  return { due: true, reason: 'ok' };
}

// How insistent a live nudge should look right now: 0 the moment it lands,
// rising to 1 as it approaches expiry. Faces read this to escalate amber →
// brighter, so an ignored poke gets harder to keep ignoring instead of just
// vanishing (issue #35).
//
// A nudge with no expiry never escalates: it has no deadline to run down.
export function nudgeUrgency(def, now = Date.now()) {
  if (!def || !def.nudge || !def.expiresAt || !def.assignedAt) return 0;
  const span = def.expiresAt - def.assignedAt;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, (now - def.assignedAt) / span));
}

// Repainting on every tick would be churn nobody can see; repainting only on
// poll payload changes would never escalate at all, because the payload does
// not change as time passes. Quantizing splits the difference: the face is
// redrawn only when it would look meaningfully different.
export const URGENCY_STEPS = 8;

export function urgencyStep(def, now = Date.now()) {
  return Math.round(nudgeUrgency(def, now) * URGENCY_STEPS);
}

// Which slot a nudge may take when the model doesn't pick a valid one:
// an empty slot first, else the stalest assignment. Deliberately scans only
// the four FRONT slots (#52): a nudge is an interruption, and an
// interruption on a page nobody is looking at is not an interruption.
export function pickNudgeSlot(slots, now = Date.now()) {
  for (let i = 0; i < 4; i++) {
    const s = slots[i];
    if (!s || (s.expiresAt && s.expiresAt < now)) return i + 1;
  }
  let oldest = 1;
  let t = Infinity;
  for (let i = 0; i < 4; i++) {
    const at = slots[i]?.assignedAt || 0;
    if (at < t) { t = at; oldest = i + 1; }
  }
  return oldest;
}

// Pure (context) -> string like the other coach prompts, so the experiment
// runner can replay captured nudge contexts byte-identically.
export const NUDGE_PROMPT = (c) =>
  `It is ${c.localHour}:00 for your human (${c.human?.timezone || 'unknown tz'}). ` +
  'You may proactively nudge them by repainting ONE physical slot key — do it ONLY when their data shows ' +
  'something concrete slipping: a habit they reliably do by this hour still missing today, a streak about to break. ' +
  'A nudge interrupts a real person; when nothing is clearly slipping reply {"nudge":false} — that is the right ' +
  'answer most of the time. Unlike suggestions, a nudge MAY target a fixed habit (tapping the key logs that habit). ' +
  'Keep the label a question or a verb, not a scold. ' +
  'They can now long-press a nudge key to wave it away — nudgeRecord tells you which of your past pokes were ' +
  'acted on, which were explicitly dismissed, and which expired unseen. Never raise a habit listed in ' +
  'dismissedToday. ' +
  'Reply with ONLY JSON: {"nudge":false} OR ' +
  '{"nudge":true,"slot":2,"habit":"OneWordId","emoji":"💧","label":"Water?","reason":"why now, from their data","ttlMinutes":60}\n\n' +
  'Context: ' + JSON.stringify(c);
