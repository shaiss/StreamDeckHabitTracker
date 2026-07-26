// Per-habit "today" state for living key faces (issue #32). Pure: takes the
// habit list + raw log entries + a timezone offset and returns a map keyed by
// habit name. No Redis, no Date.now() — the caller passes `nowMs` so this is
// deterministic and unit-testable. Matches the established lib/ pattern
// (scorer.js, roster.js): a pure module called from an api/ handler.
//
// Day bucketing uses the VIEWER's timezone (the dashboard groups days in the
// viewer's tz by design). tzOffsetMs follows JS getTimezoneOffset() sign:
// UTC-5 → +300 min (positive west). To get local-day we SUBTRACT the offset
// from utc ms before flooring: t_local = t_utc - tzOffset.

const DAY_MS = 86_400_000;

function dayIndex(t, tzOffsetMs) {
  return Math.floor((t - tzOffsetMs) / DAY_MS);
}

function goalOf(habit) {
  const g = Number(habit && habit.goal);
  return Number.isInteger(g) && g >= 1 && g <= 99 ? g : 1;
}

export function computeToday(habits, entries, nowMs, tzOffsetMs = 0) {
  const today = dayIndex(nowMs, tzOffsetMs);
  const out = {};
  for (const habit of habits || []) {
    if (!habit || !habit.name) continue;
    const name = habit.name;
    const goal = goalOf(habit);

    // Collect the set of local-day indices that have >=1 entry for this habit.
    const days = new Set();
    let count = 0;
    for (const e of entries || []) {
      if (!e || e.h !== name) continue;
      const d = dayIndex(e.t, tzOffsetMs);
      days.add(d);
      if (d === today) count++;
    }

    // Streak: consecutive days ending today OR yesterday (today-not-done-yet
    // is not a miss; a fully missed day breaks the chain).
    let streak = 0;
    let cursor = today;
    if (!days.has(today)) cursor = today - 1; // allow today-empty to continue from yesterday
    while (days.has(cursor)) { streak++; cursor--; }

    const ringFill = goal > 0 ? Math.min(1, count / goal) : 0;
    out[name] = { count, goal, doneToday: count >= goal, streak, ringFill };
  }
  return out;
}
