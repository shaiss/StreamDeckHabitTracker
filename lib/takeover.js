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

// Autonomy Toggle sticky key (#94 / study §3.5). Face labels map 1:1 onto the
// three consent values above — no new levels. Press cycles MANUAL → ASSISTED
// → AUTO → MANUAL. Default remains off / MANUAL.
export const AUTONOMY_GLYPH = '⚙';
export const AUTONOMY_MODES = Object.freeze({
  off: { consent: 'off', mode: 'MANUAL', label: 'MANUAL', glyph: AUTONOMY_GLYPH },
  'nudge-only': { consent: 'nudge-only', mode: 'ASSISTED', label: 'ASSISTED', glyph: AUTONOMY_GLYPH },
  'may-navigate': { consent: 'may-navigate', mode: 'AUTO', label: 'AUTO', glyph: AUTONOMY_GLYPH }
});
export function autonomyOf(consent) {
  return AUTONOMY_MODES[normalizeConsent(consent)];
}
export function cycleConsent(consent) {
  const cur = normalizeConsent(consent);
  const i = CONSENT_LEVELS.indexOf(cur);
  return CONSENT_LEVELS[(i + 1) % CONSENT_LEVELS.length];
}

// Optimistic consent writes (#94). Tap cycles paint immediately, then POST
// /api/profile. Without a sequence guard, an older failed POST can roll the
// face back after a newer one already succeeded, and a poll can clobber the
// optimistic value mid-flight. Pure helpers so unit tests pin the race
// without a device or network.
//
// Three counters stay separate:
//   write generation - local request identity (beginConsentWrite); only the
//                      newest generation may clear pending or roll back.
//   confirmed        - { consent, sequence }: the last persisted consent and
//                      the server sequence it was persisted at. Advanced by
//                      any successful write (even a superseded one), by a 409
//                      body, or by an accepted poll. A failed write never
//                      moves it.
//   issued token     - the navSeq last sent; nextNavSeq() derives it from the
//                      confirmed sequence so rejected attempts cannot push
//                      later tokens beyond what the server accepts. While any
//                      write is still in flight, the issued high-water mark is
//                      kept so a later tap cannot reuse a lower token than an
//                      older in-flight write. Only after every outstanding
//                      write has settled does releaseIssuedNavSeq drop it
//                      back to the confirmed sequence.
//
//   beginConsentWrite(gen) → next generation (caller sets pending + optimistic value)
//   nextNavSeq(confirmedSeq, issuedSeq) → navSeq for the next write
//   releaseIssuedNavSeq(issued, confirmed, outstanding) → issued watermark
//     after a write settles; resets to confirmed only when outstanding is 0
//   CONSENT_WRITE_TIMEOUT_MS → default lifetime of a consent POST (and 409 body)
//   settleConsentWrite(...) → only the latest generation may clear pending / roll
//     back; every settle may advance `confirmed` (pass `written` + `navSeq`
//     for the write being settled). Failure restores `confirmed.consent` as of
//     settle time (falls back to `prev` when `confirmed` is not supplied). On a
//     409, optional `server` ({coachNav, coachNavSeq}) reconciles to the
//     server's truth; callers must not auto-retry the rejected intent.
//   mergePolledConsent(...) → ignore poll while a write is pending, when the
//     write generation / pending flag at poll *start* no longer matches, or
//     when its server sequence is older than the last applied one.
//   acceptCoachNavSeq(stored, incoming) → server-side write ordering token
export function beginConsentWrite(seq) {
  return (Number(seq) || 0) + 1;
}
export function nextNavSeq(confirmedSeq, issuedSeq) {
  return Math.max(Number(confirmedSeq) || 0, Number(issuedSeq) || 0, 0) + 1;
}
export function releaseIssuedNavSeq(issued, confirmed, outstanding) {
  if ((Number(outstanding) || 0) > 0) return Math.max(0, Number(issued) || 0);
  return Math.max(0, Number(confirmed) || 0);
}
export const CONSENT_WRITE_TIMEOUT_MS = 10_000;
function asConfirmed(confirmed, prev) {
  if (confirmed && typeof confirmed === 'object') {
    return {
      consent: normalizeConsent(confirmed.consent),
      sequence: Math.max(0, Number(confirmed.sequence) || 0)
    };
  }
  return { consent: normalizeConsent(prev), sequence: 0 };
}
export function settleConsentWrite({
  currentSeq, writeSeq, ok, current, prev, server, written, navSeq, confirmed
}) {
  let conf = asConfirmed(confirmed, prev);
  // A success is durable no matter which tap it belonged to — keep it, but
  // never let an older success overwrite a newer confirmed one.
  if (ok && written !== undefined && Number.isSafeInteger(navSeq) && navSeq > conf.sequence) {
    conf = { consent: normalizeConsent(written), sequence: navSeq };
  }
  if (writeSeq !== currentSeq) {
    return { consent: current, pending: true, applied: false, confirmed: conf };
  }
  if (ok) return { consent: current, pending: false, applied: true, confirmed: conf };
  const serverSeq = Number(server?.coachNavSeq);
  if (typeof server?.coachNav === 'string' &&
      Number.isInteger(serverSeq) && serverSeq >= conf.sequence) {
    conf = { consent: normalizeConsent(server.coachNav), sequence: serverSeq };
    return {
      consent: conf.consent,
      sequence: serverSeq,
      pending: false,
      applied: true,
      confirmed: conf
    };
  }
  return { consent: conf.consent, pending: false, applied: true, confirmed: conf };
}
export function mergePolledConsent({
  pending, current, polled, pollSeq, currentSeq, pendingAtStart,
  serverSeq, appliedServerSeq
} = {}) {
  if (pending || pendingAtStart) {
    return { consent: current, applied: false, ignored: true };
  }
  if (pollSeq !== undefined && currentSeq !== undefined && pollSeq !== currentSeq) {
    return { consent: current, applied: false, ignored: true };
  }
  // Two polls can start at the same write generation and finish out of order;
  // the one carrying the older server sequence must not win. The watermark
  // starts at 0, so nothing is rejected before a higher sequence was applied.
  const incoming = Number(serverSeq);
  const applied = Number(appliedServerSeq);
  if (serverSeq !== undefined && appliedServerSeq !== undefined &&
      Number.isFinite(incoming) && Number.isFinite(applied) && incoming < applied) {
    return { consent: current, applied: false, ignored: true };
  }
  const next = normalizeConsent(polled);
  return {
    consent: next,
    applied: next !== normalizeConsent(current),
    ignored: false
  };
}

// Monotonic coachNav write token (#94 / CR). Every coachNav write must carry
// a strictly newer navSeq (api/profile rejects coachNav without it).
export function acceptCoachNavSeq(stored, incoming) {
  const s = Math.max(0, Number(stored) || 0);
  const n = Number(incoming);
  // SafeInteger only — non-safe integers (e.g. 1e21) must never order a write.
  if (!Number.isSafeInteger(n) || n <= 0) return false;
  return n > s;
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
  // Fail closed on a broken clock: without now/hour/day the expiry,
  // quiet-hour, human-lock, and budget checks would all fall through open.
  if (!Number.isFinite(now) || !Number.isInteger(hour) || hour < 0 || hour > 23 || !day) {
    return { due: false, reason: 'invalid clock context' };
  }
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
  if (takeoverDay === day) return { due: false, reason: 'budget spent' };
  return { due: true, reason: 'ok' };
}
