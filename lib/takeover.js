// Coach-driven navigation guardrails (issue #54).
//
// The rule: THE COACH MAY RAISE ITS VOICE INSIDE THE ROOM IT IS ALREADY IN.
// IT MAY NOT WALK INTO ANOTHER ROOM. Concretely, it may switch pages within
// our profile and may never switch TO our profile — if you're on your OBS
// profile mid-stream, the deck does not get yanked out from under you; the
// escalation degrades to the ordinary slot repaint.
//
// A takeover is strictly louder than a nudge, so it exists only as the
// escalation OF a live nudge — one that already earned its way through
// nudgeDue() (quiet hours, 2h gap, 45min recent-tap suppression, 3 days of
// data, one-live-nudge, post-dismissal quiet). This gate adds the rules that
// belong to navigation specifically. Like nudge.js, it is dependency-free and
// pure so the zero-dep unit suite can pin every rule without a device, and
// the bias is toward silence: everything defaults to "no".
//
// Enforcement is split where the knowledge lives: the plugin holds visibility
// and the human-priority clocks and evaluates this gate before asking; the
// server holds the budget and the kill switch and re-checks both when the
// plugin claims the day's takeover (POST /api/nudge?takeover=1) — so a
// restarted plugin process can never double-spend the budget.

import { QUIET_END_HOUR, QUIET_START_HOUR } from './nudge.js';

// Consent (rule 5): tri-state, persisted in habits:profile so it rides
// getProfile() into every coach pass. DEFAULT OFF — navigation is something a
// human turns on, never something the coach assumes.
//   off          - no nudges may navigate, ever
//   nudge-only   - today's behaviour: repaint the slot key, nothing more
//   may-navigate - the coach may flip pages inside our profile
export const CONSENT_LEVELS = ['off', 'nudge-only', 'may-navigate'];
export function normalizeConsent(v) {
  return CONSENT_LEVELS.includes(v) ? v : 'off';
}

export const TAKEOVER_BUDGET_PER_DAY = 1;          // rule 1: <= 1/day
export const HUMAN_LOCK_MS = 10 * 60_000;          // rule 3: hands-off window
export const RESTORE_MS = 90_000;                  // rule 4: auto-restore
export const SUPPRESS_MS = 24 * 3600_000;          // rule 6: the kill switch

// The gate. Pure. Every input defaults to its most silent reading.
//   now, hour        - epoch ms + LOCAL hour (same convention as nudgeDue)
//   day              - local day string, e.g. '2026-07-27' (budget bucket)
//   consent          - tri-state above
//   nudge            - the live nudge def this takeover would amplify
//   visible          - rule 2: is ANY of our profile on screen (visibility.mjs)
//   lastKeypressAt   - rule 3: last physical keypress on our keys
//   lastPageChangeAt - rule 3: last manual page change (appeared-key churn)
//   takeoverDay      - rule 1: the day the budget was last spent
//   suppressedUntil  - rule 6: hardware "not now" horizon
export function takeoverDue({
  now, hour, day = '', consent = 'off', nudge = null, visible = false,
  lastKeypressAt = 0, lastPageChangeAt = 0, takeoverDay = '', suppressedUntil = 0
} = {}) {
  if (normalizeConsent(consent) !== 'may-navigate') return { due: false, reason: 'consent withheld' };
  if (suppressedUntil && now < suppressedUntil) return { due: false, reason: 'kill switch engaged' };
  // No live nudge, no takeover: navigation never fires on its own — it only
  // amplifies a poke that already passed the whole nudgeDue() gate.
  if (!nudge || !nudge.nudge || (nudge.expiresAt && nudge.expiresAt <= now)) {
    return { due: false, reason: 'no live nudge to amplify' };
  }
  // Quiet hours re-checked here even though the nudge passed them: a nudge
  // placed at 21:59 stays live for an hour, and its takeover must not land
  // at 22:30.
  if (hour < QUIET_END_HOUR || hour >= QUIET_START_HOUR) return { due: false, reason: 'quiet hours' };
  if (!visible) return { due: false, reason: 'profile not on screen' };
  if (lastKeypressAt && now - lastKeypressAt < HUMAN_LOCK_MS) {
    return { due: false, reason: 'human at the controls' };
  }
  if (lastPageChangeAt && now - lastPageChangeAt < HUMAN_LOCK_MS) {
    return { due: false, reason: 'human just changed pages' };
  }
  if (day && takeoverDay === day) return { due: false, reason: 'budget spent' };
  return { due: true, reason: 'ok' };
}
