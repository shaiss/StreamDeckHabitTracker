// Behavioral scorer (issue #6): score the coach's suggestions by what the
// human actually did. A slot key "landed" if the human tapped it while it was
// live (between its assignment and its replacement/expiry). Ground truth is
// the tap log — no model judgment involved.
//
// Output feeds straight back into the coach's context, so it learns which of
// its asks resonate and which get ignored.

export function scoreSuggestions(history, entries, now = Date.now()) {
  const perHabit = {};
  for (let i = 0; i < history.length; i++) {
    const rec = history[i];
    const windowEnd = i + 1 < history.length ? history[i + 1].at : now;
    for (const def of rec.slots || []) {
      if (!def || !def.habit) continue;
      const start = def.assignedAt || rec.at;
      const end = Math.min(windowEnd, def.expiresAt || Infinity);
      if (end <= start) continue;
      const s = (perHabit[def.habit] ||= { offered: 0, landed: 0, taps: 0 });
      s.offered++;
      // Slot taps record the resolved habit name at tap time, so matching on
      // habit + window is exact even after the same habit moves between slots.
      const taps = entries.filter((e) => e.slot && e.h === def.habit && e.t >= start && e.t <= end).length;
      s.taps += taps;
      if (taps > 0) s.landed++;
    }
  }
  const rows = Object.entries(perHabit).map(([habit, s]) => ({
    habit,
    offered: s.offered,
    landed: s.landed,
    taps: s.taps,
    hitRate: s.offered ? +(s.landed / s.offered).toFixed(2) : 0
  }));
  rows.sort((a, b) => b.taps - a.taps || b.hitRate - a.hitRate);
  const offered = rows.reduce((n, r) => n + r.offered, 0);
  const landed = rows.reduce((n, r) => n + r.landed, 0);
  return {
    overall: { offered, landed, hitRate: offered ? +(landed / offered).toFixed(2) : 0 },
    perHabit: rows
  };
}

// Nudges get their own three-way scoring (issue #35), because "I saw it and
// chose not to" and "I never noticed" are completely different lessons and the
// suggestion scorer above collapses both into "not landed":
//
//   tapped    — acted on (a slot tap inside the nudge's live window)
//   dismissed — an explicit long-press "not today"
//   ignored   — the window closed with no interaction at all
//
// A nudge still on the deck has no verdict yet and is counted in neither the
// numerator nor the denominator; reporting it as ignored would make every
// fresh poke look like a failure.
export function scoreNudges(history, entries, dismissals = [], now = Date.now()) {
  // setSlots rewrites the whole array, so a surviving nudge reappears in every
  // later history record. `assignedAt` is stable across those rewrites — key
  // on it so one poke counts once, over the full window it was really up.
  const seen = new Map();
  for (let i = 0; i < history.length; i++) {
    const rec = history[i];
    for (const def of rec.slots || []) {
      if (!def || !def.nudge || !def.habit) continue;
      const start = def.assignedAt || rec.at;
      const id = def.habit + ':' + start;
      const prev = seen.get(id);
      if (prev) prev.lastIdx = i;
      else seen.set(id, { habit: def.habit, start, expiresAt: def.expiresAt || 0, lastIdx: i });
    }
  }

  const perHabit = {};
  let live = 0;
  for (const n of seen.values()) {
    // A nudge stops being live for one of two reasons: a later slots doc no
    // longer carries it (replaced), or its own TTL ran out (expired). The
    // observation window must NOT come from "the next history record or now" —
    // for the newest record that always equals now, which would mark every
    // fresh poke as ignored the instant it was written.
    const replacedAt = n.lastIdx < history.length - 1 ? history[n.lastIdx + 1].at : Infinity;
    const expiry = n.expiresAt || Infinity;
    const end = Math.min(replacedAt, expiry);
    if (end <= n.start) continue;

    let verdict = null;
    if (entries.some((e) => e.slot && e.h === n.habit && e.t >= n.start && e.t <= end)) verdict = 'tapped';
    else if (dismissals.some((d) => d && d.habit === n.habit && d.at >= n.start && d.at <= end)) verdict = 'dismissed';
    else if (end <= now) verdict = 'ignored';
    if (!verdict) { live++; continue; }
    const s = (perHabit[n.habit] ||= { offered: 0, tapped: 0, dismissed: 0, ignored: 0 });
    s.offered++;
    s[verdict]++;
  }

  const rows = Object.entries(perHabit).map(([habit, s]) => ({
    habit,
    ...s,
    hitRate: s.offered ? +(s.tapped / s.offered).toFixed(2) : 0
  }));
  rows.sort((a, b) => b.offered - a.offered || b.hitRate - a.hitRate);
  const sum = (f) => rows.reduce((n, r) => n + r[f], 0);
  const offered = sum('offered');
  return {
    overall: {
      offered,
      tapped: sum('tapped'),
      dismissed: sum('dismissed'),
      ignored: sum('ignored'),
      hitRate: offered ? +(sum('tapped') / offered).toFixed(2) : 0
    },
    perHabit: rows,
    live
  };
}
