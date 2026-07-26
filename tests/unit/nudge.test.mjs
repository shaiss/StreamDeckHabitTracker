import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nudgeDue, pickNudgeSlot, NUDGE_PROMPT,
  MIN_GAP_MS, RECENT_TAP_MS, MIN_DAYS_OF_DATA, QUIET_END_HOUR, QUIET_START_HOUR
} from '../../lib/nudge.js';

const NOW = 1_800_000_000_000;
const OK = { now: NOW, hour: 12, lastNudgeAt: 0, lastTapAt: NOW - 3 * 3600_000, daysOfData: 7, slots: [] };

test('a clean midday state is due', () => {
  assert.deepEqual(nudgeDue(OK), { due: true, reason: 'ok' });
});

test('quiet hours block on both ends, boundaries included', () => {
  assert.equal(nudgeDue({ ...OK, hour: QUIET_START_HOUR }).due, false);
  assert.equal(nudgeDue({ ...OK, hour: 23 }).due, false);
  assert.equal(nudgeDue({ ...OK, hour: QUIET_END_HOUR - 1 }).due, false);
  assert.equal(nudgeDue({ ...OK, hour: QUIET_END_HOUR }).due, true);
  assert.equal(nudgeDue({ ...OK, hour: QUIET_START_HOUR - 1 }).due, true);
});

test('a recent nudge blocks until the gap passes', () => {
  assert.equal(nudgeDue({ ...OK, lastNudgeAt: NOW - MIN_GAP_MS + 1000 }).due, false);
  assert.equal(nudgeDue({ ...OK, lastNudgeAt: NOW - MIN_GAP_MS - 1000 }).due, true);
});

test('a recently active human is not nudged', () => {
  assert.equal(nudgeDue({ ...OK, lastTapAt: NOW - RECENT_TAP_MS + 1000 }).due, false);
  assert.equal(nudgeDue({ ...OK, lastTapAt: 0 }).due, true, 'no taps ever ≠ recently active');
});

test('no pattern, no nudge', () => {
  assert.equal(nudgeDue({ ...OK, daysOfData: MIN_DAYS_OF_DATA - 1 }).due, false);
});

test('a live nudge key blocks; an expired one does not', () => {
  const live = { habit: 'Drink', nudge: true, expiresAt: NOW + 60_000 };
  const stale = { habit: 'Drink', nudge: true, expiresAt: NOW - 60_000 };
  assert.equal(nudgeDue({ ...OK, slots: [null, live, null, null] }).due, false);
  assert.equal(nudgeDue({ ...OK, slots: [null, stale, null, null] }).due, true);
});

test('pickNudgeSlot prefers an empty or expired slot, else the stalest', () => {
  const s = (assignedAt, expiresAt) => ({ habit: 'X', assignedAt, ...(expiresAt ? { expiresAt } : {}) });
  assert.equal(pickNudgeSlot([s(1), null, s(3), s(4)], NOW), 2);
  assert.equal(pickNudgeSlot([s(1), s(2, NOW - 5), s(3), s(4)], NOW), 2, 'expired counts as empty');
  assert.equal(pickNudgeSlot([s(9), s(2), s(7), s(5)], NOW), 2, 'stalest assignment loses its slot');
});

test('prompt is biased to silence and states the full contract', () => {
  const p = NUDGE_PROMPT({ localHour: 14, human: { timezone: 'America/New_York' }, todayTaps: [] });
  assert.match(p, /\{"nudge":false\}/);
  assert.match(p, /right\s+answer most of the time/);
  assert.match(p, /ONE physical slot key/);
  assert.match(p, /MAY target a fixed habit/);
  assert.match(p, /ONLY JSON/);
  assert.match(p, /It is 14:00/);
});
