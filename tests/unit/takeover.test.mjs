import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  takeoverDue, normalizeConsent, CONSENT_LEVELS,
  HUMAN_LOCK_MS, RESTORE_MS, SUPPRESS_MS, TAKEOVER_BUDGET_PER_DAY
} from '../../lib/takeover.js';
import { MIN_GAP_MS, QUIET_START_HOUR, QUIET_END_HOUR } from '../../lib/nudge.js';

// The takeover gate (issue #54) mirrors nudge.test.mjs: pure function, no
// device, and the BIAS IS TOWARD SILENCE — these tests say so explicitly by
// pinning that every input's default reading refuses.

const NOW = 1_800_000_000_000;
const NUDGE = { habit: 'Water', nudge: true, assignedAt: NOW - 60_000, expiresAt: NOW + 3600_000 };
// The one state that may navigate: consent granted, a live nudge, profile on
// screen, hands off the deck, budget unspent, kill switch disengaged.
const OK = {
  now: NOW, hour: 12, day: '2027-01-05', consent: 'may-navigate', nudge: NUDGE,
  visible: true, lastKeypressAt: NOW - HUMAN_LOCK_MS - 1000,
  lastPageChangeAt: NOW - HUMAN_LOCK_MS - 1000, takeoverDay: '2027-01-04', suppressedUntil: 0
};

test('the fully-earned state is due — and it is the ONLY due state in this file', () => {
  assert.deepEqual(takeoverDue(OK), { due: true, reason: 'ok' });
});

test('no arguments at all means no: every default is the silent reading', () => {
  assert.equal(takeoverDue().due, false);
  assert.equal(takeoverDue({}).due, false);
});

test('a broken clock fails closed before any other rule is consulted', () => {
  // Without now/hour/day the expiry, quiet-hour, human-lock and budget
  // checks would all fall through open — so they must never be reached.
  assert.equal(takeoverDue({ ...OK, now: undefined }).reason, 'invalid clock context');
  assert.equal(takeoverDue({ ...OK, hour: undefined }).reason, 'invalid clock context');
  assert.equal(takeoverDue({ ...OK, hour: 24 }).reason, 'invalid clock context');
  assert.equal(takeoverDue({ ...OK, day: '' }).reason, 'invalid clock context');
});

test('consent is default-off and unknown values normalize to off', () => {
  assert.deepEqual(CONSENT_LEVELS, ['off', 'nudge-only', 'may-navigate']);
  assert.equal(normalizeConsent(undefined), 'off');
  assert.equal(normalizeConsent('sure!'), 'off');
  assert.equal(normalizeConsent('nudge-only'), 'nudge-only');
  assert.equal(takeoverDue({ ...OK, consent: 'off' }).reason, 'consent withheld');
  assert.equal(takeoverDue({ ...OK, consent: 'nudge-only' }).reason, 'consent withheld',
    'nudge-only means today\'s repaint behaviour, never navigation');
  assert.equal(takeoverDue({ ...OK, consent: 'yes' }).reason, 'consent withheld');
});

test('a takeover only ever amplifies a LIVE nudge', () => {
  assert.equal(takeoverDue({ ...OK, nudge: null }).reason, 'no live nudge to amplify');
  assert.equal(takeoverDue({ ...OK, nudge: { habit: 'X' } }).reason, 'no live nudge to amplify',
    'a suggestion is not a nudge');
  assert.equal(takeoverDue({ ...OK, nudge: { ...NUDGE, expiresAt: NOW - 1 } }).reason,
    'no live nudge to amplify', 'an expired poke earns nothing');
});

test('the coach may not walk into another room: invisible profile refuses', () => {
  assert.equal(takeoverDue({ ...OK, visible: false }).reason, 'profile not on screen');
});

test('human-priority lock: a recent keypress or manual page change wins', () => {
  assert.equal(takeoverDue({ ...OK, lastKeypressAt: NOW - HUMAN_LOCK_MS + 1000 }).reason,
    'human at the controls');
  assert.equal(takeoverDue({ ...OK, lastPageChangeAt: NOW - HUMAN_LOCK_MS + 1000 }).reason,
    'human just changed pages');
  assert.equal(takeoverDue({ ...OK, lastKeypressAt: 0, lastPageChangeAt: 0 }).due, true,
    'never touched != just touched');
});

test('budget: one takeover per local day, and it must beat the nudge gap', () => {
  assert.equal(TAKEOVER_BUDGET_PER_DAY, 1);
  assert.equal(takeoverDue({ ...OK, takeoverDay: OK.day }).reason, 'budget spent');
  assert.equal(takeoverDue({ ...OK, takeoverDay: '2027-01-04' }).due, true, 'yesterday\'s spend expired');
  // A day is longer than the 2h nudge gap by construction — the budget is the
  // stricter rule, which is what makes a takeover "strictly louder".
  assert.ok(24 * 3600_000 > MIN_GAP_MS);
});

test('quiet hours hold even though the underlying nudge already passed them', () => {
  // A nudge placed at 21:xx stays live past 22:00; its takeover must not.
  assert.equal(takeoverDue({ ...OK, hour: QUIET_START_HOUR }).reason, 'quiet hours');
  assert.equal(takeoverDue({ ...OK, hour: QUIET_END_HOUR - 1 }).reason, 'quiet hours');
  assert.equal(takeoverDue({ ...OK, hour: QUIET_END_HOUR }).due, true);
});

test('the hardware kill switch buys a full day of silence', () => {
  assert.equal(SUPPRESS_MS, 24 * 3600_000);
  assert.equal(takeoverDue({ ...OK, suppressedUntil: NOW + 1 }).reason, 'kill switch engaged');
  assert.equal(takeoverDue({ ...OK, suppressedUntil: NOW - 1 }).due, true, 'an expired horizon frees the gate');
});

test('auto-restore is measured in seconds, not minutes — never strand anyone', () => {
  assert.ok(RESTORE_MS <= 2 * 60_000, 'a page nobody chose must give itself back quickly');
});
