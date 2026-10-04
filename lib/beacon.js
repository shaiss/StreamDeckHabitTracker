// Attention Beacon (#75 / study §3.3): how many coach decisions are waiting,
// and which turn-state frame the page-0 coach key should wear.
//
// Pure and dependency-free so the zero-dep unit suite can pin the count
// without Redis or a Stream Deck. The plugin and the virtual deck both
// consume this shape; deck.html cannot import it (no build step) and keeps
// a copy, drift-guarded from tests/unit/beacon.test.mjs.
//
// A pending item is a human decision the coach is owed:
//   - one live nudge key (a poke to tap or dismiss)
//   - one open question (Approval Gate / Choice Picker keys share a qid → 1)
//   - each queued roster proposal (approve/dismiss in the habit manager)
// Expired slots drop out. The beacon never commits any of these — it is a
// signpost. `blocked` is opt-in (poll flag or a live slot marked blocked):
// red-blink, still not a decision.

export function liveSlot(s, now = Date.now()) {
  return !!(s && (!s.expiresAt || s.expiresAt > now));
}

export function pendingCount(input = {}, now = Date.now()) {
  const slots = [...(input.slots || []), ...(input.coachPage || [])];
  let n = 0;
  const qids = new Set();
  for (const s of slots) {
    if (!liveSlot(s, now)) continue;
    if (s.nudge) n += 1;
    if (s.qid) qids.add(s.qid);
  }
  n += qids.size;
  const roster = input.rosterPending != null
    ? Number(input.rosterPending) || 0
    : (Array.isArray(input.roster && input.roster.proposals) ? input.roster.proposals.length : 0);
  return n + Math.max(0, roster);
}

export function isBlocked(input = {}, now = Date.now()) {
  if (input.blocked) return true;
  const slots = [...(input.slots || []), ...(input.coachPage || [])];
  return slots.some((s) => liveSlot(s, now) && s.blocked);
}

export function beaconOf(input = {}, now = Date.now()) {
  const pending = pendingCount(input, now);
  const blocked = isBlocked(input, now);
  // Blocked outranks wait: a hard-stop is louder than "your move". Idle is
  // the dark default when the coach owes nothing.
  const frame = blocked ? 'blocked' : (pending > 0 ? 'wait' : 'idle');
  return { pending, blocked, frame, badge: pending > 0 ? String(pending) : '' };
}
