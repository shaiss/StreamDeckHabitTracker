import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  nudgeDue, pickNudgeSlot, NUDGE_PROMPT,
  MIN_GAP_MS, RECENT_TAP_MS, MIN_DAYS_OF_DATA, QUIET_END_HOUR, QUIET_START_HOUR,
  DISMISS_QUIET_MS, nudgeUrgency, urgencyStep, URGENCY_STEPS
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

// --- escalation + dismissal (#35) ---

test('an explicit dismissal buys more quiet than the ordinary gap', () => {
  // Being told "not today" and returning inside two hours is exactly the
  // badgering the dismissal exists to stop, so it must outrank MIN_GAP_MS.
  assert.ok(DISMISS_QUIET_MS > MIN_GAP_MS, 'a dismissal must be stronger than a plain gap');
  assert.equal(nudgeDue({ ...OK, lastDismissAt: NOW - DISMISS_QUIET_MS + 1000 }).reason, 'dismissed recently');
  assert.equal(nudgeDue({ ...OK, lastDismissAt: NOW - DISMISS_QUIET_MS - 1000 }).due, true);
  assert.equal(nudgeDue({ ...OK, lastDismissAt: 0 }).due, true, 'never dismissed ≠ just dismissed');
});

test('urgency runs 0 -> 1 across the nudge lifetime', () => {
  const def = { nudge: true, assignedAt: NOW, expiresAt: NOW + 3600_000 };
  assert.equal(nudgeUrgency(def, NOW), 0, 'a fresh poke is not insistent');
  assert.equal(nudgeUrgency(def, NOW + 1800_000), 0.5);
  assert.equal(nudgeUrgency(def, NOW + 3600_000), 1, 'loudest right at expiry');
  assert.equal(nudgeUrgency(def, NOW + 9999_000), 1, 'and never past it');
  assert.equal(nudgeUrgency(def, NOW - 1000), 0, 'nor before it landed');
});

test('only expiring nudges escalate', () => {
  assert.equal(nudgeUrgency({ nudge: true, assignedAt: NOW }, NOW + 1000), 0, 'no expiry, no deadline to run down');
  assert.equal(nudgeUrgency({ assignedAt: NOW, expiresAt: NOW + 1000 }, NOW + 500), 0, 'a suggestion is not a nudge');
  assert.equal(nudgeUrgency(null, NOW), 0);
  assert.equal(nudgeUrgency({ nudge: true, assignedAt: NOW, expiresAt: NOW }, NOW), 0, 'zero-length window');
});

test('urgency is quantized so faces repaint on visible change, not every tick', () => {
  const def = { nudge: true, assignedAt: NOW, expiresAt: NOW + URGENCY_STEPS * 60_000 };
  assert.equal(urgencyStep(def, NOW), 0);
  assert.equal(urgencyStep(def, NOW + 1000), 0, 'a second later is not a repaint');
  assert.equal(urgencyStep(def, NOW + 60_000), 1);
  assert.equal(urgencyStep(def, NOW + URGENCY_STEPS * 60_000), URGENCY_STEPS);
});

test('the nudge prompt tells the coach dismissals exist and must be respected', () => {
  const p = NUDGE_PROMPT({ localHour: 14, human: { timezone: 'America/New_York' } });
  assert.match(p, /dismissedToday/);
  assert.match(p, /nudgeRecord/);
});

test('the virtual deck embeds the identical urgency curve (drift guard)', () => {
  // deck.html has no build step and carries its own copy. A virtual deck that
  // escalated on a different curve would be a lying preview of the hardware.
  const src = readFileSync(new URL('../../public/deck.html', import.meta.url), 'utf8');
  assert.match(src, /function urgencyOf\(def\)/, 'the curve exists');
  for (const marker of ['def.expiresAt - def.assignedAt', 'Date.now() - def.assignedAt', 'Math.max(0, Math.min(1']) {
    assert.ok(src.includes(marker), 'deck.html missing urgency marker: ' + marker);
  }
  assert.match(src, /--urg/, 'and drives the face from it');
});
