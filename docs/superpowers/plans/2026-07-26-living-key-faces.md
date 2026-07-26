# Living key faces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Habit keys render today's state at a glance — a streak ring (daily-goal progress), subtle dim-when-done, and count dots for repeatables — all riding the existing 15s `/api/slots` poll.

**Architecture:** A new pure `lib/today.js` computes per-habit `{count, goal, doneToday, streak, ringFill}` from raw log entries. `/api/slots` calls it once per poll (no new Redis calls, no new round-trip) and attaches a `today` map. The Stream Deck plugin's canvas renderer and the virtual deck (`public/deck.html`) read that map and paint the three effects. Habit gains an optional, backward-compatible `goal` field (default 1).

**Tech Stack:** ESM Node (Vercel functions), `node:test` + `node:assert/strict` for unit tests, `playwright-core` for e2e, vanilla JS canvas (plugin `app.js`) and DOM/CSS (deck.html). No new dependencies.

## Global Constraints

- ESM everywhere (`"type": "module"`). Plugin `app.js` stays browser ES5-ish (`'use strict'`, `var`, `function`), no arrow functions / `let` / template literals in that file.
- Timestamps are `Date.now()` epoch ms everywhere. Day bucketing uses the viewer's timezone via a `?tz=<minutes>` query param (JS `getTimezoneOffset()` sign: UTC-5 → `tz=300`); default 0 (UTC).
- Model/log JSON parsed with `extractJson` rules — not relevant here (no model calls in this feature).
- Test commands (exact, from `package.json`):
  - `npm test` → `node --test "tests/unit/*.test.mjs"` (glob form is required on this Node).
  - `npm run test:e2e` → `node --test "tests/e2e/*.e2e.mjs"` (needs `playwright-core` + Chromium).
  - Plus `node --check <file>` on every touched `.js`/`.mjs`.
- CORS is open (`*`) on `/api/slots` (plugin fetches from a CEF page) — preserve it.
- Habit `name` is the identity key in log entries (`e.h === name`). A renamed habit is a new identity — do not attempt streak migration across renames.

---

## File Structure

- **Create** `lib/today.js` — pure per-habit today-state computation. One responsibility: turn `(habits, entries, now, tzMs)` into a `{[name]: state}` map.
- **Create** `tests/unit/today.test.mjs` — unit tests for `lib/today.js`.
- **Modify** `lib/habits.js` — accept + persist optional `goal` (validation + `saveHabits`).
- **Modify** `tests/unit/habits.test.mjs` — add `goal` validation/round-trip cases.
- **Modify** `api/slots.js` — parse `?tz=`, compute `today`, attach to response.
- **Modify** `streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/app.js` — cache `today`, repaint on change, extend `face()` with ring/dim/dots.
- **Modify** `public/deck.html` — CSS/DOM parity for the three effects.
- **Modify** `public/habits.html` — goal input in each habit row + include in save payload.
- **Modify** `tests/e2e/habits.e2e.mjs` — assert goal round-trips through the manager UI.

---

## Task 1: `lib/today.js` — pure today-state computation

**Files:**
- Create: `lib/today.js`
- Test: `tests/unit/today.test.mjs`

**Interfaces:**
- Consumes: `habits` = `[{name, emoji, label, goal?}]` (goal optional, ≥1); `entries` = `[{h, t, ...}]` from `lib/store.js`'s `all()`.
- Produces: `export function computeToday(habits, entries, nowMs, tzOffsetMs)` → `{ [name]: { count, goal, doneToday, streak, ringFill } }`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/today.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeToday } from '../../lib/today.js';

const DAY = 86_400_000;
// Pick a "now" at local noon on 2026-07-26 UTC so day boundaries are clean.
const NOON = Date.UTC(2026, 6, 26, 12, 0, 0); // 2026-07-26T12:00:00Z

const habit = (name, goal) => ({ name, emoji: '•', label: name, ...(goal ? { goal } : {}) });
const entry = (h, t) => ({ h, t });

test('count = entries today for the habit; goal defaults to 1; doneToday = count>=goal', () => {
  const habits = [habit('Eat')];
  const entries = [
    entry('Eat', NOON), entry('Eat', NOON - 1000), entry('Eat', NOON - DAY) // 2 today, 1 yesterday
  ];
  const out = computeToday(habits, entries, NOON, 0);
  assert.deepEqual(out.Eat, { count: 2, goal: 1, doneToday: true, streak: 2, ringFill: 1 });
});

test('goal>1: doneToday threshold, ringFill clamps at 1', () => {
  const habits = [habit('Drink', 8)];
  const entries = [entry('Drink', NOON), entry('Drink', NOON), entry('Drink', NOON)]; // 3 today
  const out = computeToday(habits, entries, NOON, 0);
  assert.equal(out.Drink.count, 3);
  assert.equal(out.Drink.goal, 8);
  assert.equal(out.Drink.doneToday, false);
  assert.equal(out.Drink.ringFill, 3 / 8);
  // over-goal clamps
  const over = computeToday(habits, [entry('Drink', NOON)], NOON + 1, 0); // not used; just shape
  assert.ok(over.Drink.ringFill <= 1);
});

test('streak continues when today is empty but yesterday has entries', () => {
  const habits = [habit('Run')];
  const entries = [entry('Run', NOON - DAY), entry('Run', NOON - 2 * DAY)];
  const out = computeToday(habits, entries, NOON, 0);
  assert.equal(out.Run.streak, 2); // yesterday + day-before
  assert.equal(out.Run.count, 0);
  assert.equal(out.Run.doneToday, false);
});

test('streak breaks at a full missed day', () => {
  const habits = [habit('Run')];
  // today empty, yesterday empty, day-before present → streak is 0 (the chain broke)
  const entries = [entry('Run', NOON - 2 * DAY)];
  const out = computeToday(habits, entries, NOON, 0);
  assert.equal(out.Run.streak, 0);
});

test('nonzero tz offset shifts the day boundary', () => {
  // tz=300 means UTC-5: local day starts at 05:00Z. An entry at 04:00Z on the
  // 26th is still "the 25th" locally.
  const habits = [habit('Eat')];
  const entries = [entry('Eat', Date.UTC(2026, 6, 26, 4, 0, 0))]; // 04:00Z = 23:00 prev-day local
  const now = Date.UTC(2026, 6, 26, 12, 0, 0); // local 07:00 on the 26th
  const out = computeToday(habits, entries, now, 300 * 60_000);
  assert.equal(out.Eat.count, 0); // that entry is yesterday-local
  assert.equal(out.Eat.streak, 1); // yesterday counts toward streak
});

test('habits with no entries ever: streak 0, ringFill 0, not done', () => {
  const out = computeToday([habit('New')], [], NOON, 0);
  assert.deepEqual(out.New, { count: 0, goal: 1, doneToday: false, streak: 0, ringFill: 0 });
});

test('invalid/missing goal treated as 1', () => {
  const habits = [{ name: 'X', emoji: '•', label: 'X', goal: 0 }, { name: 'Y', emoji: '•', label: 'Y', goal: 'garbage' }];
  const out = computeToday(habits, [], NOON, 0);
  assert.equal(out.X.goal, 1);
  assert.equal(out.Y.goal, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../lib/today.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `lib/today.js`:

```js
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

    // Collect the set of local-day indices that have ≥1 entry for this habit.
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — all `today.test.mjs` cases green.

- [ ] **Step 5: Commit**

```bash
git add lib/today.js tests/unit/today.test.mjs
git commit -m "Living key faces (#32): pure computeToday for per-habit state"
```

---

## Task 2: Habit `goal` field — validation + persistence

**Files:**
- Modify: `lib/habits.js` (`validateHabits` ~line 21-42; `saveHabits` ~line 56-65)
- Test: `tests/unit/habits.test.mjs`

**Interfaces:**
- Consumes: `BASE_HABITS` from `lib/ai.js` (existing seed fallback).
- Produces: `validateHabits` now accepts optional `goal` (positive integer 1-99; missing/invalid → treated as default, NOT an error); `saveHabits` persists `goal` when valid. `getHabits` returns it when present.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/habits.test.mjs`:

```js
test('accepts an optional positive-integer goal', () => {
  assert.equal(validateHabits([{ name: 'Drink', emoji: '💧', label: 'Drink', goal: 8 }]), null);
});

test('rejects out-of-range goal (must be 1-99)', () => {
  assert.match(validateHabits([{ name: 'X', emoji: '💧', label: 'D', goal: 0 }]), /goal/i);
  assert.match(validateHabits([{ name: 'X', emoji: '💧', label: 'D', goal: 100 }]), /goal/i);
  assert.match(validateHabits([{ name: 'X', emoji: '💧', label: 'D', goal: 2.5 }]), /goal/i);
  assert.match(validateHabits([{ name: 'X', emoji: '💧', label: 'D', goal: 'wat' }]), /goal/i);
});

test('goal is optional (no goal still validates)', () => {
  assert.equal(validateHabits([{ name: 'Eat', emoji: '🍽', label: 'Eat' }]), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — the new `goal` cases fail (no goal validation yet).

- [ ] **Step 3: Update `validateHabits`**

In `lib/habits.js`, inside the per-habit loop (after the `origin` check), add:

```js
    if (h.goal !== undefined) {
      const g = Number(h.goal);
      if (!Number.isInteger(g) || g < 1 || g > 99) {
        return `Habit "${name}" goal must be a whole number between 1 and 99 (omit for default 1).`;
      }
    }
```

- [ ] **Step 4: Update `saveHabits` to preserve `goal`**

In `lib/habits.js` `saveHabits`, extend the `clean` map (currently ~lines 57-62) to include goal when valid:

```js
export async function saveHabits(list) {
  const clean = list.map((h) => {
    const g = Number(h.goal);
    const item = {
      name: String(h.name),
      emoji: String(h.emoji).slice(0, 8),
      label: String(h.label).slice(0, 12),
      origin: h.origin === 'coach' ? 'coach' : 'human'
    };
    if (Number.isInteger(g) && g >= 1 && g <= 99) item.goal = g;
    return item;
  });
  await cmd(['SET', KEY, JSON.stringify(clean)]);
  return clean;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — all habits tests green (new + existing).

- [ ] **Step 6: Lint the touched file**

Run: `node --check lib/habits.js`
Expected: no output (success).

- [ ] **Step 7: Commit**

```bash
git add lib/habits.js tests/unit/habits.test.mjs
git commit -m "Living key faces (#32): optional habit goal field (1-99, default 1)"
```

---

## Task 3: Augment `/api/slots` with the `today` map

**Files:**
- Modify: `api/slots.js`

**Interfaces:**
- Consumes: `computeToday(habits, entries, nowMs, tzOffsetMs)` from `lib/today.js`; `all()` and `getHabits()` already imported.
- Produces: `GET /api/slots?tz=<minutes>` now returns `{ ..., today: { [name]: {count, goal, doneToday, streak, ringFill} } }` when configured. Default `tz=0`.

- [ ] **Step 1: Read the current handler to confirm imports + structure**

Run: `node --check api/slots.js` (sanity) and re-read lines 1-15 (imports) and 33-45 (the configured branch).
Expected: confirm `import { ... all } from '../lib/store.js'` and `import { getHabits } from '../lib/habits.js'` exist.

- [ ] **Step 2: Add the import**

In `api/slots.js`, add to the imports near the top:

```js
import { computeToday } from '../lib/today.js';
```

- [ ] **Step 3: Parse `?tz=` and attach `today` in the configured branch**

In the configured branch (after `const doc = await getSlots();` and before/while building `out`), replace:

```js
    const doc = await getSlots();
    const out = { ...base, suggestedAt: doc.suggestedAt, slots: doc.slots };
```

with:

```js
    const doc = await getSlots();
    // Living key faces (#32): per-habit today state for the deck. tz is the
    // viewer's getTimezoneOffset() in minutes (UTC-5 → 300); default UTC.
    // ?track=1 already calls all(); reuse the same fetch when both are wanted.
    const wantTrack = (req.query || {}).track === '1';
    const tzMin = parseInt((req.query || {}).tz, 10);
    const tzOffsetMs = (Number.isFinite(tzMin) ? tzMin : 0) * 60_000;
    const entries = await all();
    const today = computeToday(base.habits, entries, Date.now(), tzOffsetMs);
    const out = { ...base, suggestedAt: doc.suggestedAt, slots: doc.slots, today };
```

Then update the existing `?track=1` block so it reuses `entries` instead of re-fetching. Replace:

```js
    if ((req.query || {}).track === '1') {
      const [history, entries] = await Promise.all([getSlotHistory(), all()]);
      out.track = scoreSuggestions(history, entries);
    }
```

with:

```js
    if (wantTrack) {
      const history = await getSlotHistory();
      out.track = scoreSuggestions(history, entries);
    }
```

- [ ] **Step 4: Lint the touched file**

Run: `node --check api/slots.js`
Expected: no output (success).

- [ ] **Step 5: Verify unit suite still green (no regression)**

Run: `npm test`
Expected: PASS (this change isn't unit-tested directly — it's covered by the e2e + manual probe — but must not break existing tests).

- [ ] **Step 6: Commit**

```bash
git add api/slots.js
git commit -m "Living key faces (#32): /api/slots returns per-habit today state (?tz=)"
```

---

## Task 4: Plugin canvas renderer — streak ring, dim-when-done, count dots

**Files:**
- Modify: `streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/app.js` (cache `today` in `refreshSlots`; repaint on change; extend `face()` and `render()`)

**Interfaces:**
- Consumes: `slotCache.today[name]` set by `refreshSlots` from the `/api/slots` response (Task 3).
- Produces: habit-key faces now render a streak ring arc, dim + ✓ when doneToday, and count dots (or a number) when goal > 1. Slot/nudge keys unchanged.

⚠️ **Plugin constraint:** `app.js` is browser ES5-ish — `'use strict'`, `var`, `function`, no arrow functions, no `let`, no template literals. Match the surrounding style exactly.

- [ ] **Step 1: Add a `todayCache` variable and diff it in `refreshSlots`**

In `app.js`, near the other caches (after `var habitCache = null;` ~line 17), add:

```js
var todayCache = null;   // { habitName -> {count, goal, doneToday, streak, ringFill} }
```

In `refreshSlots` (the `.then(function (j) {...})` block), after `habitCache = j.habits || [];` (~line 126) add:

```js
      var todayChanged = !todayCache || JSON.stringify(todayCache) !== JSON.stringify(j.today || {});
      todayCache = j.today || null;
```

And in the repaint loop (~line 128-131), extend the habit-key branch to also repaint on `today` change. Replace:

```js
      for (var c in keys) {
        if (slotsChanged && isSlot(keys[c])) render(c);
        if (habitsChanged && isHabit(keys[c])) render(c);
      }
```

with:

```js
      for (var c in keys) {
        if (slotsChanged && isSlot(keys[c])) render(c);
        if (isHabit(keys[c]) && (habitsChanged || todayChanged)) render(c);
      }
```

- [ ] **Step 2: Pass today-state into `render()` for habit keys**

In `render()` (~line 137-160), find the habit branch:

```js
  if (isHabit(k)) {
    var idx = +s.index || 0;
    var def = habitCache ? habitCache[idx] : null;
    if (def) setImage(context, face(def.emoji || '•', def.label || def.habit, hueFor(def.name), ''));
    else if (habitCache) setImage(context, face('·', 'empty', SILVER_HUE, '', 22)); // habit removed in manager
    else setImage(context, face('⏳', '…', SILVER_HUE, '', 22)); // first poll pending
    return;
  }
```

Replace the `if (def) ...` line so it pulls today-state and passes it through:

```js
  if (isHabit(k)) {
    var idx = +s.index || 0;
    var def = habitCache ? habitCache[idx] : null;
    if (def) {
      var st = (todayCache && todayCache[def.name]) || null;
      setImage(context, face(def.emoji || '•', def.label || def.habit, hueFor(def.name), '', undefined, st));
    }
    else if (habitCache) setImage(context, face('·', 'empty', SILVER_HUE, '', 22)); // habit removed in manager
    else setImage(context, face('⏳', '…', SILVER_HUE, '', 22)); // first poll pending
    return;
  }
```

- [ ] **Step 3: Extend `face()` to render ring, dim, dots**

In `app.js`, change the `face` signature and add the three effects. Replace the existing `function face(emoji, label, hue, badge, sat) {` (~line 164) and its opening (up through the `ctx.fillRect(0, 0, S, S);` base paint ~line 175) — keep the gradient/halo code, but make `sat` reduce when dimmed, and add ring/dots before `return cv.toDataURL`. Concretely, replace the whole `face` function with:

```js
// Nocturne Ritual face: night base, votive halo in the key's hue, hairline
// inner ring, oversized glyph, whispered label. Living key faces (#32) layer
// a streak ring, dim-when-done, and count dots onto HABIT keys (state !== null).
function face(emoji, label, hue, badge, sat, state) {
  sat = sat === undefined ? 72 : sat;
  var done = state && state.doneToday;
  if (done) sat = Math.round(sat * 0.55);            // dim-when-done
  var S = 144;
  var cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  var ctx = cv.getContext('2d');

  var base = ctx.createLinearGradient(0, 0, 0, S);
  base.addColorStop(0, '#141827');
  base.addColorStop(1, '#0a0c13');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, S, S);

  var halo = ctx.createRadialGradient(S / 2, S * 0.36, 6, S / 2, S * 0.36, S * 0.62);
  halo.addColorStop(0, 'hsla(' + hue + ',' + sat + '%,58%,.62)');
  halo.addColorStop(0.42, 'hsla(' + hue + ',' + sat + '%,45%,.18)');
  halo.addColorStop(1, 'hsla(' + hue + ',' + sat + '%,45%,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, S, S);

  ctx.strokeStyle = 'hsla(' + hue + ',' + sat + '%,65%,.30)';
  ctx.lineWidth = 1.5;
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(6, 6, S - 12, S - 12, 17); ctx.stroke(); }

  // Streak ring (habit keys only): an arc inset 3px from the border, sweep =
  // ringFill * 360°. Empty track faint, filled arc bright. Draws over the halo
  // but under the emoji so the glyph stays the focus.
  if (state && typeof state.ringFill === 'number') {
    var cx = S / 2, cy = S / 2, R = S / 2 - 7;
    var start = -Math.PI / 2;
    ctx.lineCap = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'hsla(' + hue + ',' + sat + '%,55%,.18)';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    if (state.ringFill > 0) {
      ctx.strokeStyle = 'hsla(' + hue + ',85%,72%,.95)';
      ctx.beginPath();
      ctx.arc(cx, cy, R, start, start + Math.PI * 2 * state.ringFill);
      ctx.stroke();
    }
  }

  ctx.textAlign = 'center';
  ctx.font = '62px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  ctx.fillText(emoji, S / 2, 76);

  ctx.fillStyle = '#e9edf4';
  ctx.shadowColor = 'rgba(0,0,0,.6)';
  ctx.shadowBlur = 4;
  var lbl = String(label);
  ctx.font = '600 ' + (lbl.length > 8 ? 17 : 20) + 'px "Segoe UI",Arial,sans-serif';
  ctx.fillText(lbl.slice(0, 12), S / 2, 116);
  ctx.shadowBlur = 0;

  // Count dots (habit keys, repeatable habits): up to 8 dots along the bottom,
  // filled = today's count. Above 8, show the count as a number instead.
  if (state && state.goal > 1 && typeof state.count === 'number') {
    if (state.goal > 8) {
      ctx.fillStyle = 'hsla(' + hue + ',80%,80%,.95)';
      ctx.font = '700 12px "Segoe UI",Arial,sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(String(state.count), S - 10, S - 10);
    } else {
      var dots = state.goal, filled = Math.min(state.count, dots);
      var gap = 9, w = (dots - 1) * gap, startX = (S - w) / 2, y = S - 14;
      for (var i = 0; i < dots; i++) {
        ctx.beginPath();
        ctx.arc(startX + i * gap, y, 2.6, 0, Math.PI * 2);
        ctx.fillStyle = i < filled ? 'hsla(' + hue + ',85%,72%,.95)' : 'hsla(' + hue + ',' + sat + '%,45%,.30)';
        ctx.fill();
      }
    }
  }

  // Badge (slot/nudge) OR dim-when-done check (habit).
  if (state && done) {
    ctx.fillStyle = 'hsla(' + hue + ',80%,80%,.95)';
    ctx.font = '700 12px "Segoe UI",Arial,sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('✓', S - 10, 18);
  } else if (badge) {
    ctx.fillStyle = 'hsla(' + hue + ',80%,80%,.9)';
    ctx.font = '700 11px "Segoe UI",Arial,sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(badge, S - 10, 18);
  }
  return cv.toDataURL('image/png');
}
```

- [ ] **Step 4: Lint the touched file**

Run: `node --check streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/app.js`
Expected: no output (success).

- [ ] **Step 5: Commit**

```bash
git add streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/app.js
git commit -m "Living key faces (#32): streak ring, dim-when-done, count dots on habit keys"
```

---

## Task 5: Virtual deck parity (`public/deck.html`)

**Files:**
- Modify: `public/deck.html` (CSS for ring/dim/dots; DOM in `slotFaceHtml`/habit-face rendering; send `?tz=` on the `/api/slots` fetch)

**Interfaces:**
- Consumes: the `today` map from the same `/api/slots` response `deck.html` already fetches (Task 3).
- Produces: habit-key DOM mirrors the plugin — conic-gradient ring, opacity dim + ✓ on done, dot spans for repeatables.

- [ ] **Step 1: Add CSS for ring, dim, dots**

In the `<style>` block of `public/deck.html` (find the existing `.slotface`, `.nudgeface` rules around line referenced by `slotFaceHtml`), add:

```css
    .facecss.habitface { position: relative; }
    .facecss.habitface .ring {
      position: absolute; inset: 5px; border-radius: 17px;
      background: conic-gradient(var(--ring-fill, transparent) calc(var(--ring-pct,0)*1%), rgba(255,255,255,.06) 0);
      -webkit-mask: radial-gradient(circle, transparent 62%, #000 64%);
              mask: radial-gradient(circle, transparent 62%, #000 64%);
      pointer-events: none;
    }
    .facecss.habitface.dim .em,
    .facecss.habitface.dim .lb { opacity: .55; }
    .facecss.habitface .check { position: absolute; top: 4px; right: 7px;
      font: 700 12px "Segoe UI",Arial,sans-serif; color: hsla(var(--face-hue,222),80%,80%,.95); }
    .facecss.habitface .dots { position: absolute; bottom: 5px; left: 0; right: 0;
      display: flex; justify-content: center; gap: 4px; }
    .facecss.habitface .dots span { width: 5px; height: 5px; border-radius: 50%;
      background: hsla(var(--face-hue,222),45%,45%,.3); }
    .facecss.habitface .dots span.on { background: hsla(var(--face-hue,222),85%,72%,.95); }
    .facecss.habitface .count { position: absolute; bottom: 5px; right: 7px;
      font: 700 11px "Segoe UI",Arial,sans-serif; color: hsla(var(--face-hue,222),80%,80%,.95); }
```

- [ ] **Step 2: Tag habit keys at build so they can be repainted**

In `public/deck.html`'s `build()` function (the `habits.forEach((h, i) => {...})` block, ~lines 152-168), add `data-habit` + `data-hname` attributes to each habit key element so a `paintHabits()` can find them. After `const el = keyEl({...});` and before `face.appendChild(el);`, add:

```js
        el.dataset.habit = i;          // position index
        el.dataset.hname = h.name;     // identity for today-state lookup
```

(The `img` error-fallback block immediately below stays as-is — `paintHabits()` overlays state on top of whatever face is showing, whether the GIF loaded or the CSS fallback rendered.)

- [ ] **Step 3: Add `hueFor`, `today` state, and `paintHabits()`**

Near `slotFaceHtml` (~line 203), add the hue helper (it duplicates the inline fallback at line 161; consolidate both onto it — replace the inline FNV-1a in the `img` error handler at ~line 161-163 with a call to `hueFor(h.name)`):

```js
    // Same FNV-1a → hue as the plugin (hueFor in app.js) and tools/make-icons.
    function hueFor(name) {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      let hue = h % 320; if (hue >= 245) hue += 40; return hue;
    }
```

In the closure holding `slots` and `habits` (find `let slots = [...]` / `let habits = [...]` near the top of the script), add:

```js
    let today = {};   // habitName -> {count, goal, doneToday, streak, ringFill}
```

Then add `paintHabits()` alongside `paintSlots()` (~line 217):

```js
    function habitStateHtml(def, st) {
      const hue = hueFor(def.name);
      const done = st && st.doneToday;
      const goal = (st && st.goal) || 1;
      const pct = st ? Math.round((st.ringFill || 0) * 100) : 0;
      let extras = '<span class="ring" style="--face-hue:' + hue + '; --ring-pct:' + pct + '"></span>';
      if (done) extras += '<span class="check">✓</span>';
      if (goal > 1 && st && typeof st.count === 'number') {
        if (goal > 8) {
          extras += '<span class="count">' + st.count + '</span>';
        } else {
          let dots = '';
          for (let i = 0; i < goal; i++) dots += '<span class="' + (i < st.count ? 'on' : '') + '"></span>';
          extras += '<span class="dots" style="--face-hue:' + hue + '">' + dots + '</span>';
        }
      }
      return '<span class="facecss habitface ' + (done ? 'dim' : '') + '" style="--face-hue:' + hue + '">' +
        extras + '<span class="em">' + (def.emoji || '•') + '</span>' +
        '<span class="lb">' + esc(def.label || def.name) + '</span></span>' +
        '<span class="glass"></span><span class="flash"></span>';
    }

    function paintHabits() {
      if (!built) return;
      document.querySelectorAll('.k[data-habit]').forEach((el) => {
        const i = +el.dataset.habit;
        const def = habits[i];
        if (!def) return;
        el.innerHTML = habitStateHtml(def, today[def.name] || null);
      });
    }
```

(Note: `paintHabits` fully replaces each habit key's innerHTML with a CSS face — this is the deliberate parity trade-off. Habit keys currently show a GIF; once living faces are on, they render the same Nocturne-Ritual-style CSS face as the GIF-fallback path, now carrying today's state. The GIF animation is intentionally dropped in the virtual deck for parity with the plugin, whose canvas faces are static. This keeps the virtual deck an honest preview of the physical deck.)

- [ ] **Step 4: Capture `today` from the poll and repaint on change**

The poll handler is at ~line 252 (`fetch('/api/slots').then(...).then((j) => { ... paintSlots(); ... })`). It currently assigns `habits`/`slots` and calls `paintSlots()` unconditionally. Replace that `.then((j) => {...})` body with:

```js
        habits = j.habits || habits;
        slots = j.slots || slots;
        today = j.today || {};
        if (!built && habits.length) build();
        paintSlots();
        paintHabits();
        if (hint.textContent === 'Loading keys…') {
          hint.innerHTML = 'Tap a key — it logs exactly like the hardware. The <b>✨ AI keys</b> repaint themselves when the coach changes its mind.';
        }
```

(The existing handler repaints unconditionally on every poll, so we simply add `today = j.today || {}` and a `paintHabits()` call alongside `paintSlots()`. No change-detection needed — matches the file's existing pattern. `paintHabits` is a no-op before `build()` runs thanks to its `if (!built) return` guard.)

- [ ] **Step 5: Send `?tz=` on the `/api/slots` fetch**

The poll is triggered from the `fetch('/api/slots')` at ~line 252 (inside `refresh()`). Change it to include the viewer offset so `today`'s day boundary matches the viewer's timezone:

```js
      const tz = new Date().getTimezoneOffset(); // minutes; UTC-5 → 300
      fetch('/api/slots?tz=' + tz).then((r) => r.json()).then((j) => { /* ...Step 4 body... */ })
```

- [ ] **Step 6: Lint**

Run: `node --check public/deck.html` (HTML isn't JS — instead, open the file and confirm no syntax errors by loading it in the e2e test in Task 7; if there's an inline script parse error the e2e will fail to load).
Note: there is no standalone `--check` for HTML; verification is via the e2e suite.

- [ ] **Step 7: Commit**

```bash
git add public/deck.html
git commit -m "Living key faces (#32): virtual deck parity (ring, dim, count dots)"
```

---

## Task 6: Habit manager — goal input (`public/habits.html`)

**Files:**
- Modify: `public/habits.html` (CSS columns + row template ~line 14, 22, 74, 112; save handler ~line 236-242)

**Interfaces:**
- Consumes: the habit list (now possibly with `goal`) from `/api/habits`.
- Produces: each row has an optional `goal` input; Save posts `goal` (parsed int, omitted if empty/invalid so the backend defaults to 1).

- [ ] **Step 1: Add a Goal column to the header and grid**

In `public/habits.html`, update the two `grid-template-columns` rules (`.hrow` ~line 14 and `.cols` ~line 22) from `64px 1fr 1fr 64px 40px` to `64px 1fr 1fr 56px 64px 40px`:

```css
    .hrow { display: grid; grid-template-columns: 64px 1fr 1fr 56px 64px 40px; gap: 10px; align-items: center;
            background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; }
```

```css
    .cols { display: grid; grid-template-columns: 64px 1fr 1fr 56px 64px 40px; gap: 10px; padding: 0 14px; margin-bottom: 6px;
            color: var(--muted); font-size: 11.5px; text-transform: uppercase; letter-spacing: .06em; }
```

And update the `.cols` HTML (~line 74) to add a Goal header before the Origin header:

```html
    <div class="cols"><span>Emoji</span><span>Label (on the key)</span><span>Id (logged name)</span><span>Goal</span><span>Origin</span><span></span></div>
```

- [ ] **Step 2: Add the goal input to `rowHtml`**

In `rowHtml` (~line 112-118), insert a goal input before the `${chip}` line:

```js
      return `<div class="hrow" data-new="${isNew ? 1 : 0}" data-origin="${origin}">
        <input class="emoji" value="${esc(h.emoji||'')}" maxlength="8" placeholder="🙂">
        <input class="label" value="${esc(h.label||'')}" maxlength="12" placeholder="Label">
        <input class="name" value="${esc(h.name||'')}" maxlength="20" placeholder="OneWordId" ${isNew ? '' : 'readonly title="Ids are locked to keep history consistent — delete and re-add to rename."'}>
        <input class="goal" type="number" min="1" max="99" value="${h.goal ? esc(String(h.goal)) : ''}" placeholder="1" title="Daily goal (default 1). ≥2 makes the key show count dots and a progress ring.">
        ${chip}
        <button class="del" title="Remove">✕</button>
      </div>`;
```

- [ ] **Step 3: Include `goal` in the Save payload**

In the save handler (~line 236-242), extend the mapped object:

```js
      const habits = [...rowsEl.querySelectorAll('.hrow')].map(el => {
        const g = parseInt(el.querySelector('.goal').value, 10);
        return {
          emoji: el.querySelector('.emoji').value.trim(),
          label: el.querySelector('.label').value.trim(),
          name: el.querySelector('.name').value.trim(),
          origin: el.dataset.origin === 'coach' ? 'coach' : 'human',
          ...(Number.isInteger(g) && g >= 1 && g <= 99 ? { goal: g } : {})
        };
      });
```

- [ ] **Step 4: Commit**

```bash
git add public/habits.html
git commit -m "Living key faces (#32): goal input in the habit manager"
```

---

## Task 7: E2E regression — goal round-trips through the manager

**Files:**
- Modify: `tests/e2e/habits.e2e.mjs`

**Interfaces:**
- Consumes: the existing mock server + Playwright harness already in the file.
- Produces: an assertion that setting a goal in the UI and Saving results in the goal being persisted (the mock's POST handler echoes habits back).

- [ ] **Step 1: Read the existing e2e harness**

Re-read `tests/e2e/habits.e2e.mjs` lines 45-75 and the test bodies to confirm: the mock POST `/api/habits` stores `body.habits` into the `habits` variable and GET `/api/habits` returns it (it does — lines 48-58). The new test will set a goal input, click Save, reload, and assert the goal input shows the saved value.

- [ ] **Step 2: Add the test**

Append a new `test(...)` block to `tests/e2e/habits.e2e.mjs` (inside the existing `test` group, after the current habit tests):

```js
test('goal round-trips through the habit manager', async () => {
  await page.goto('http://localhost:' + port + '/habits.html');
  await page.waitForSelector('.hrow');
  // Set Drink's goal to 8
  const drinkRow = await page.$$('.hrow');
  // find the row whose .name value is 'Drink'; if none, add the value to the first row's goal
  let target = null;
  for (const r of drinkRow) {
    const name = await r.$eval('.name', el => el.value).catch(() => '');
    if (name === 'Drink') { target = r; break; }
  }
  if (!target) target = drinkRow[0];
  await target.$eval('.goal', el => el.value = '');
  await target.type('.goal', '8');
  await page.click('#saveBtn');
  await page.waitForFunction(() => {
    const s = document.getElementById('status');
    return s && /Saved/.test(s.textContent);
  }, { timeout: 4000 });
  // Reload and confirm the goal persisted
  await page.reload();
  await page.waitForSelector('.hrow');
  const goals = await page.$$eval('.hrow .goal', els => els.map(e => e.value));
  assert.ok(goals.includes('8'), 'expected a goal of 8 to persist after save+reload; got ' + JSON.stringify(goals));
});
```

- [ ] **Step 3: Run the e2e suite**

Run: `npm run test:e2e`
Expected: PASS — the new test green (and existing habits e2e still green).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/habits.e2e.mjs
git commit -m "Living key faces (#32): e2e — goal round-trips through the manager"
```

---

## Task 8: Pre-flight + ship

**Files:** none (verification + PR)

- [ ] **Step 1: Full unit suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 2: Full e2e suite**

Run: `npm run test:e2e`
Expected: all green.

- [ ] **Step 3: Lint every touched JS/mjs**

Run: `node --check lib/today.js && node --check lib/habits.js && node --check api/slots.js && node --check streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/app.js`
Expected: no output (success) for each.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin claude/living-key-faces-32
gh pr create --title "Living key faces: streak ring, dim-when-done, count dots (#32)" \
  --body "Closes #32. Habit keys now render today's state at a glance, riding the existing 15s /api/slots poll (augmented with a \`today\` map; no new round-trips, no new Redis calls).\n\n- Streak ring (arc inset, sweep = ringFill × 360°)\n- Dim-when-done + ✓ (per-habit daily goal, optional, default 1)\n- Count dots for repeatables (or a number if goal > 8)\n- New pure lib/today.js (unit-tested); optional habit goal field; /api/slots?tz=; plugin + virtual-deck parity; goal input in the habit manager.\n\nSpec: docs/superpowers/specs/2026-07-26-living-key-faces-design.md"
```

- [ ] **Step 5: After CI passes, follow the ship skill** (probe `/api/health`, `/api/slots?tz=300`, confirm the live deployment returns a `today` map).
