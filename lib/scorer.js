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
