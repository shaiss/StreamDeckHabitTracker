import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeToday } from '../../lib/today.js';

const DAY = 86_400_000;
// Pick a "now" at noon UTC on 2026-07-26 so day boundaries are clean.
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

test('goal>1: doneToday threshold, ringFill is a fraction under 1', () => {
  const habits = [habit('Drink', 8)];
  const entries = [entry('Drink', NOON), entry('Drink', NOON), entry('Drink', NOON)]; // 3 today
  const out = computeToday(habits, entries, NOON, 0);
  assert.equal(out.Drink.count, 3);
  assert.equal(out.Drink.goal, 8);
  assert.equal(out.Drink.doneToday, false);
  assert.equal(out.Drink.ringFill, 3 / 8);
});

test('ringFill clamps to 1 when count exceeds goal', () => {
  const habits = [habit('Drink', 2)];
  const entries = [entry('Drink', NOON), entry('Drink', NOON), entry('Drink', NOON)]; // 3 today, goal 2
  const out = computeToday(habits, entries, NOON, 0);
  assert.equal(out.Drink.ringFill, 1);
  assert.equal(out.Drink.doneToday, true);
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
  // today empty, yesterday empty, day-before present -> chain broke before that
  const entries = [entry('Run', NOON - 2 * DAY)];
  const out = computeToday(habits, entries, NOON, 0);
  assert.equal(out.Run.streak, 0);
});

test('streak counts today when today has entries', () => {
  const habits = [habit('Run')];
  const entries = [entry('Run', NOON), entry('Run', NOON - DAY), entry('Run', NOON - 2 * DAY)];
  const out = computeToday(habits, entries, NOON, 0);
  assert.equal(out.Run.streak, 3);
});

test('nonzero tz offset shifts the day boundary', () => {
  // tz=300 means UTC-5: local day starts at 05:00Z. An entry at 04:00Z on the
  // 26th is still "the 25th" locally (23:00 on the 25th local time).
  const habits = [habit('Eat')];
  const entries = [entry('Eat', Date.UTC(2026, 6, 26, 4, 0, 0))]; // 04:00Z
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
  const habits = [
    { name: 'X', emoji: '•', label: 'X', goal: 0 },
    { name: 'Y', emoji: '•', label: 'Y', goal: 'garbage' },
    { name: 'Z', emoji: '•', label: 'Z', goal: 2.5 }
  ];
  const out = computeToday(habits, [], NOON, 0);
  assert.equal(out.X.goal, 1);
  assert.equal(out.Y.goal, 1);
  assert.equal(out.Z.goal, 1);
});

test('skips habit entries with no name and ignores entries for unknown habits', () => {
  const out = computeToday([habit('Eat')], [entry('Drink', NOON)], NOON, 0);
  assert.deepEqual(out.Eat, { count: 0, goal: 1, doneToday: false, streak: 0, ringFill: 0 });
  assert.ok(!out.Drink, 'unknown habit not present in output');
});
