# Living key faces (#32)

**Date:** 2026-07-26
**Issue:** [#32 — Living key faces: habit keys render today's state (streak ring, dim-when-done, count dots)](https://github.com/shaiss/StreamDeckHabitTracker/issues/32)
**Status:** Approved, ready for implementation plan

## Goal

The deck becomes the dashboard: each habit key renders today's state at a glance —
a streak ring showing daily-goal progress, subtle dimming once the goal is met,
and count dots for repeatable habits. **Zero extra round-trips** — it all rides
the existing 15s `/api/slots` poll the plugin already makes.

Builds on the existing poll + canvas renderer. Three sub-features in one PR:
streak ring, dim-when-done, count dots.

## Decisions (settled in brainstorming)

1. **Data source — augment `/api/slots`.** The current poll returns the habit
   *list* (`{name, emoji, label}`) and slot assignments but no per-habit today
   state. We add a `today` map to the same response rather than introducing a
   second endpoint. One round-trip, same cadence.
2. **Streak definition — calendar-day.** Count of consecutive days (ending today
   *or yesterday*) with ≥1 entry for the habit. Today not-yet-done does **not**
   break a streak; a fully missed day does.
3. **Done threshold — per-habit daily goal.** Each habit gains an optional
   `goal` field (positive integer, default 1). `doneToday = count >= goal`.
   Backward compatible: habits with no `goal` behave exactly as before
   (≥1 tap = done).
4. **Timezone — via `?tz=` query param.** `Date.now()` is UTC-ms and the server
   can't know the viewer's timezone, so the client sends its
   `getTimezoneOffset()` (minutes). Default UTC. This matches the dashboard's
   existing "group days in the viewer's timezone" design.

## Approach

A new **pure** `lib/today.js` module computes per-habit state from the raw log
entries; `/api/slots` calls it once per poll. This matches the repo's existing
pattern (`scorer.js`, `roster.js` are pure modules called from handlers, each
unit-tested without Redis).

Rejected alternatives:
- **Inline computation in `/api/slots`** — mixes transport with scoring logic,
  not unit-testable in isolation. Breaks the established `lib/` pattern.
- **New `/api/today` endpoint** — +1 round-trip per poll, more plugin state to
  reconcile. Ruled out in brainstorming.

## Components

### 1. `lib/today.js` (new, pure)

```js
computeToday(habits, entries, nowMs, tzOffsetMs)
  → { [name]: { count, goal, doneToday, streak, ringFill } }
```

- **Day bucketing:** `dayIndex(t) = floor((t + tzOffsetMs) / 86_400_000)`.
  Viewer-timezone days, matching the dashboard's design.
- **count** = number of `entries` with `e.h === name` whose dayIndex == today's.
- **goal** = `max(1, habit.goal || 1)`.
- **doneToday** = `count >= goal`.
- **streak** = walk backwards from today: count consecutive day indices with ≥1
  entry. If today has zero entries, the streak still continues from yesterday
  (today-not-done-yet is not a miss); if yesterday is also empty, streak is 0.
- **ringFill** = `min(1, count / goal)`.

Pure: takes arrays + numbers, returns a plain object. No Redis, no `Date.now()`
(caller passes `nowMs`). Deterministic, unit-testable.

### 2. Habit schema: optional `goal` (backward compatible)

- `validateHabits` accepts an optional `goal`: positive integer ≥1, ≤99.
  Missing/invalid → treated as 1 (default), not an error.
- `saveHabits` preserves `goal` when present.
- Existing habits without `goal` keep working unchanged.
- Habit manager UI (`public/index.html` editor): optional goal input, empty = 1.

### 3. `/api/slots` augmentation (`api/slots.js`)

- Parse `?tz=<minutes>` (integer; default 0). Negative = ahead of UTC (matches
  JS `getTimezoneOffset()` sign: UTC-5 → 300).
- When configured, attach `today: { [name]: {...} }` to the response, computed
  via `computeToday(habits, entries, now, tzMs)`. Reuses the existing `all()`
  import (already used by the `?track=1` path).
- No new Redis calls. `computeToday` is O(habits × entries) — trivial at
  single-user scale.

### 4. Plugin renderer (`streamdeck-plugin/…/app.js`)

- `face()` gains an optional `state` argument: `{count, goal, doneToday, streak, ringFill}`.
- `render()` reads `slotCache.today[habitName]` for habit keys; slot/nudge keys unchanged.
- **Streak ring:** thin arc inset from the key border, sweep = `ringFill * 360°`,
  drawn in the habit's hue before the emoji. Empty-track subtle, filled-track bright.
- **Dim-when-done:** if `doneToday`, drop halo saturation/lightness ~40% and
  show a small ✓ in the badge corner (replacing the absent badge on habit keys).
- **Count dots:** if `goal > 1`, render `goal` small dots along the bottom edge
  (capped at ~8 for space; if goal > 8, show `count` as a number instead).
  Filled = today's count, empty = remaining.
- The 15s poll already repaints on `habitsChanged`; we additionally repaint on
  `today` change (cheap deep-equal, same pattern as the existing slot diff).

### 5. Virtual deck parity (`public/deck.html`)

CSS/DOM mirror of the three effects, driven by the same `today` map already in
the `/api/slots` response it fetches:
- conic-gradient ring overlay,
- opacity dim + ✓ on done,
- dot spans for repeatables.
Same data, different render substrate.

### 6. Tests

- **`tests/unit/today.test.mjs`** (new) — count; goal defaulting to 1; goal≥2
  done threshold; streak continuation (today empty, yesterday present); streak
  break (yesterday + day-before empty); day-boundary correctness with a nonzero
  tz offset; ringFill clamping at 0/over-goal.
- **`tests/unit/habits.test.mjs`** (extend) — `goal` validates (positive int,
  ≤99), defaults to 1 when missing/garbage, round-trips through `saveHabits`.
- **`tests/e2e/habits.e2e.mjs`** (extend) — goal field round-trips through the
  habit manager UI.
- New UI behavior in the plugin/deck ships with a regression assertion where
  feasible (plugin renders are canvas; the deck.html DOM is testable in
  headless Chromium — assert ring/dim/dot elements appear given a `today` payload).

## Data flow

```
plugin polls GET /api/slots?tz=300          (every 15s; +~9s after a tap)
  → api/slots.js:
      habits = await getHabits()            (already fetched)
      entries = await all()                 (already imported for ?track=1)
      today = computeToday(habits, entries, Date.now(), tzMs)
      res.json({ habits, slots, today, ... })
  → plugin refreshSlots(): cache today, re-render habit keys where today changed
  → render(context): face(emoji, label, hue, badge, today[habitName]) → canvas
  → setImage(context, dataUri)
```

## Out of scope (YAGNI)

- Weekly/monthly streak history beyond the current count.
- Goal editing via the Stream Deck (habit manager only).
- Nudge-key or slot-key state changes (those belong to #35 / #34).
- Streak persistence across habit renames — a renamed habit is a new identity,
  matching existing log semantics (`e.h` is the habit *name* string).
- Per-user timezone storage (stateless `?tz=` per request is enough).

## Risks / gotchas

- **Timezone:** without `?tz=`, days are UTC — could split "today" oddly for
  some users. The plugin/deck send `tz` from `getTimezoneOffset()`; default UTC
  is the safe fallback and matches what the dashboard already does.
- **Poll cost:** `computeToday` is O(habits × entries) — trivial at single-user
  scale (hundreds of entries). No new Redis calls; reuses `all()`.
- **Plugin repaint cadence:** the streak ring won't visibly tick down between
  polls, but since the only thing that changes it is a tap (which forces an
  immediate re-poll via the existing `REACT_RECHECK_MS` path) and day rollover
  (caught by the next 15s poll), this is fine. No client-side ticker needed.
- **Goal > 8:** render count as a number rather than dots, to avoid clutter.
- **Habit with no entries ever:** streak 0, ringFill 0, not dimmed — reads as
  "nothing yet today," which is correct.
