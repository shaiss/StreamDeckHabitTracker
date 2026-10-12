// Coach-owned adaptive targets (#70 / #64 part 2).
//
// The coach reviews each habit's trailing-window tap summary and proposes
// target changes. Autonomy is asymmetric: budgeting DOWN auto-applies with a
// visible reason; ramping UP queues for human approve/dismiss — the same
// propose→approve pattern as lib/roster.js. Nothing here touches the tap log.
//
// Every function is pure so the rails are unit-testable without Redis
// (tests/unit/target.test.mjs). The Redis doc lives at `habits:targets`.

export const WINDOW_DAYS = 14;
export const MAX_PENDING = 3;
export const MAX_HISTORY = 30;
export const MAX_REJECTED = 40;

const lc = (s) => String(s || '').toLowerCase();

// Reject key remembers "don't ask to raise Name to N again".
const rejectKey = (name, to) => `${lc(name)}:${to}`;

// UTC YYYY-MM-DD — used when the caller doesn't pass a timezone day helper.
function utcDay(t) {
  return new Date(t).toISOString().slice(0, 10);
}

// Walk back `n` calendar days from a YYYY-MM-DD key (UTC arithmetic on the
// date parts — good enough for a trailing window label, not for DST edges).
function prevDayKey(key, n = 1) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

export function normalizeTargets(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  return {
    proposals: Array.isArray(d.proposals) ? d.proposals.filter(Boolean) : [],
    history: Array.isArray(d.history) ? d.history.filter(Boolean) : [],
    rejected: Array.isArray(d.rejected) ? d.rejected.map(String) : [],
    lastRunAt: Number(d.lastRunAt) || 0,
    model: String(d.model || ''),
    engine: String(d.engine || '')
  };
}

// Read a habit's live target + coach metadata. A bare int means human-set.
export function goalMeta(habit) {
  const g = habit && habit.goal;
  if (g != null && typeof g === 'object') {
    const target = Number(g.target);
    const t = Number.isInteger(target) && target >= 1 && target <= 99 ? target : 1;
    const floor = Number(g.floor);
    const ceil = Number(g.ceil);
    return {
      target: t,
      setBy: g.setBy === 'coach' ? 'coach' : 'human',
      reason: String(g.reason || '').slice(0, 240),
      updatedAt: Number(g.updatedAt) || 0,
      floor: Number.isInteger(floor) && floor >= 1 && floor <= 99 ? floor : undefined,
      ceil: Number.isInteger(ceil) && ceil >= 1 && ceil <= 99 ? ceil : undefined
    };
  }
  const n = Number(g);
  return {
    target: Number.isInteger(n) && n >= 1 && n <= 99 ? n : 1,
    setBy: 'human',
    reason: '',
    updatedAt: 0
  };
}

function median(nums) {
  if (!nums.length) return 0;
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Per-habit trailing-window summary the coach reasons over — not raw entries.
// `dayOf(t)` returns a YYYY-MM-DD key in the viewer's/human's timezone
// (defaults to UTC). Matches the coach's summarize()/tzHelpers().day style.
export function summarizeTargets(habits, entries, {
  now = Date.now(),
  dayOf = utcDay,
  windowDays = WINDOW_DAYS
} = {}) {
  const todayKey = dayOf(now);
  const keys = [];
  for (let i = windowDays - 1; i >= 0; i--) keys.push(prevDayKey(todayKey, i));
  const keySet = new Set(keys);
  const out = [];
  for (const habit of habits || []) {
    if (!habit?.name) continue;
    const meta = goalMeta(habit);
    const perDay = new Map(keys.map((k) => [k, 0]));
    for (const e of entries || []) {
      if (!e || e.h !== habit.name) continue;
      const d = dayOf(e.t);
      if (!keySet.has(d)) continue;
      perDay.set(d, (perDay.get(d) || 0) + 1);
    }
    const counts = keys.map((k) => perDay.get(k) || 0);
    const half = Math.floor(counts.length / 2);
    const first = counts.slice(0, half);
    const second = counts.slice(half);
    const medianDay = median(counts);
    const early = median(first);
    const late = median(second);
    let trend = 'flat';
    if (late > early + 0.25) trend = 'up';
    else if (late < early - 0.25) trend = 'down';
    const daysHitGoal = counts.filter((c) => c >= meta.target).length;
    const activeDays = counts.filter((c) => c > 0).length;
    out.push({
      name: habit.name,
      label: habit.label || habit.name,
      emoji: habit.emoji || '✨',
      target: meta.target,
      setBy: meta.setBy,
      reason: meta.reason || undefined,
      updatedAt: meta.updatedAt || undefined,
      floor: meta.floor,
      ceil: meta.ceil,
      windowDays,
      medianPerDay: medianDay,
      activeDays,
      daysHitGoal,
      trend,
      dailyCounts: counts
    });
  }
  return out;
}

// Max step a single change may take: ±max(1, ceil(20% of current)).
export function maxStep(current) {
  const c = Math.max(1, Number(current) || 1);
  return Math.max(1, Math.ceil(c * 0.2));
}

function clampTo(to, from, bounds) {
  const step = maxStep(from);
  let n = to;
  if (n > from) n = Math.min(n, from + step);
  if (n < from) n = Math.max(n, from - step);
  if (bounds.floor != null) n = Math.max(n, bounds.floor);
  if (bounds.ceil != null) n = Math.min(n, bounds.ceil);
  n = Math.max(1, Math.min(99, n));
  return n;
}

function remember(rejected, name, to) {
  const k = rejectKey(name, to);
  return [k, ...rejected.filter((r) => r !== k)].slice(0, MAX_REJECTED);
}

// Turn raw model output into safe changes, split into auto-apply (down) and
// approval-queue (up). Anything outside the rails is dropped, not repaired.
export function sanitizeTargetChanges(raw, {
  habits = [],
  rejected = [],
  pending = [],
  now = Date.now()
} = {}) {
  const byName = new Map((habits || []).map((h) => [lc(h.name), h]));
  const taken = new Set([
    ...pending.map((p) => lc(p.name)),
    ...rejected.map(String)
  ]);
  let room = Math.max(0, MAX_PENDING - pending.length);
  const auto = [];
  const queue = [];

  for (const it of Array.isArray(raw) ? raw : []) {
    if (!it || typeof it !== 'object') continue;
    const habit = byName.get(lc(it.name || it.habit));
    if (!habit) continue;
    const meta = goalMeta(habit);
    const from = meta.target;
    let to = Number(it.to ?? it.target ?? it.newTarget);
    if (!Number.isInteger(to)) continue;
    to = clampTo(to, from, { floor: meta.floor, ceil: meta.ceil });
    if (to === from) continue; // no-op
    if (to > from && room <= 0) continue;
    const rk = rejectKey(habit.name, to);
    if (taken.has(lc(habit.name)) || taken.has(rk)) continue;

    const direction = to < from ? 'down' : 'up';
    const reason = String(it.reason || '').slice(0, 240);
    if (!reason) continue; // every change must carry a visible why
    const change = {
      id: `target-${lc(habit.name)}-${now}-${auto.length + queue.length}`,
      name: habit.name,
      label: habit.label || habit.name,
      emoji: habit.emoji || '✨',
      from,
      to,
      direction,
      reason,
      auto: direction === 'down',
      createdAt: now
    };
    if (direction === 'down') {
      taken.add(lc(habit.name));
      auto.push(change);
    } else {
      taken.add(lc(habit.name));
      taken.add(rk);
      queue.push(change);
      room--;
    }
  }
  return { auto, queue };
}

function writeGoal(habit, { target, reason, now, floor, ceil }) {
  const prev = goalMeta(habit);
  const next = {
    target,
    setBy: 'coach',
    reason: String(reason || '').slice(0, 240),
    updatedAt: now
  };
  const f = floor !== undefined ? floor : prev.floor;
  const c = ceil !== undefined ? ceil : prev.ceil;
  if (f != null) next.floor = f;
  if (c != null) next.ceil = c;
  return { ...habit, goal: next };
}

// Apply auto-downs to the habit list and append history. Returns new habits +
// targets doc. Never touches the tap log.
export function applyAutoChanges({ habits, targets, changes, now = Date.now() }) {
  const doc = normalizeTargets(targets);
  if (!changes?.length) return { habits, targets: doc, applied: [] };
  let nextHabits = habits.map((h) => ({ ...h }));
  const applied = [];
  for (const ch of changes) {
    if (!ch || ch.direction !== 'down' || ch.to >= ch.from) continue;
    const idx = nextHabits.findIndex((h) => lc(h.name) === lc(ch.name));
    if (idx < 0) continue;
    nextHabits[idx] = writeGoal(nextHabits[idx], {
      target: ch.to,
      reason: ch.reason,
      now
    });
    applied.push({
      name: ch.name,
      label: ch.label || ch.name,
      emoji: ch.emoji,
      from: ch.from,
      to: ch.to,
      direction: 'down',
      reason: ch.reason,
      appliedAt: now,
      via: 'auto'
    });
  }
  return {
    habits: nextHabits,
    targets: {
      ...doc,
      history: [...applied, ...doc.history].slice(0, MAX_HISTORY)
    },
    applied
  };
}

// Record a human decision on a queued ramp-up. Approve writes the new target;
// dismiss remembers so the coach stops re-asking for that (name, to) pair.
export function applyTargetDecision({ habits, targets, id, decision, now = Date.now() }) {
  const doc = normalizeTargets(targets);
  const p = doc.proposals.find((x) => x.id === id);
  if (!p) return { error: 'That target proposal is no longer pending.' };
  const proposals = doc.proposals.filter((x) => x !== p);

  if (decision === 'dismiss') {
    return {
      habits,
      targets: {
        ...doc,
        proposals,
        rejected: remember(doc.rejected, p.name, p.to)
      },
      applied: { ...p, status: 'dismissed' }
    };
  }
  if (decision !== 'approve') return { error: 'Decision must be "approve" or "dismiss".' };

  const idx = habits.findIndex((h) => lc(h.name) === lc(p.name));
  if (idx < 0) return { error: `${p.name} is no longer on your roster.` };
  // Defense: a ramp-up never applies at-or-below current (stale proposal) —
  // drop it quietly so the tray stays honest without rewriting the goal.
  const current = goalMeta(habits[idx]).target;
  if (p.to <= current) {
    return {
      habits,
      targets: { ...doc, proposals },
      applied: { ...p, status: 'stale', from: current }
    };
  }
  const nextHabits = habits.map((h, i) =>
    i === idx
      ? writeGoal(h, { target: p.to, reason: p.reason, now })
      : h
  );
  const hist = {
    name: p.name,
    label: p.label || p.name,
    emoji: p.emoji,
    from: current,
    to: p.to,
    direction: 'up',
    reason: p.reason,
    appliedAt: now,
    via: 'approve'
  };
  return {
    habits: nextHabits,
    targets: {
      ...doc,
      proposals,
      history: [hist, ...doc.history].slice(0, MAX_HISTORY)
    },
    applied: { ...p, status: 'approved', from: current }
  };
}

// Plain-language line for the dashboard / habit manager.
export function formatTargetLine(ch) {
  if (!ch) return '';
  const label = ch.label || ch.name || 'habit';
  const reason = String(ch.reason || '').trim();
  if (ch.direction === 'down' || (ch.to != null && ch.from != null && ch.to < ch.from)) {
    const body = `eased ${label} ${ch.from}→${ch.to}/day`;
    return reason ? `${body} — ${reason}` : body;
  }
  const body = `nudging ${label} ${ch.from}→${ch.to}/day`;
  return reason ? `${body} — ${reason}` : body;
}
