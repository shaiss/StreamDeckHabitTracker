import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeTargets,
  sanitizeTargetChanges,
  applyAutoChanges,
  applyTargetDecision,
  normalizeTargets,
  goalMeta,
  maxStep,
  formatTargetLine,
  MAX_PENDING,
  WINDOW_DAYS
} from '../../lib/target.js';

const DAY = 86_400_000;
const NOON = Date.UTC(2026, 6, 26, 12, 0, 0); // 2026-07-26T12:00:00Z
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

const HABITS = [
  { name: 'Caffeine', emoji: '☕', label: 'Caffeine', goal: 5 },
  { name: 'Exercise', emoji: '🏃', label: 'Exercise', goal: 1 },
  { name: 'Drink', emoji: '💧', label: 'Drink', goal: { target: 8, setBy: 'human', floor: 4, ceil: 12 } }
];

test('goalMeta reads bare int as human-set and object form with pins', () => {
  assert.deepEqual(goalMeta({ goal: 5 }), {
    target: 5, setBy: 'human', reason: '', updatedAt: 0
  });
  assert.equal(goalMeta({ goal: { target: 3, setBy: 'coach', reason: 'eased', updatedAt: 9 } }).setBy, 'coach');
  assert.equal(goalMeta({ goal: { target: 8, floor: 4, ceil: 12 } }).floor, 4);
  assert.equal(goalMeta({}).target, 1);
});

test('maxStep is at least 1 and grows with 20% of current', () => {
  assert.equal(maxStep(1), 1);
  assert.equal(maxStep(5), 1); // ceil(1) = 1
  assert.equal(maxStep(10), 2);
  assert.equal(maxStep(20), 4);
});

test('summarizeTargets: median/day, days-hit-goal, trend over the window', () => {
  // Last 14 UTC days ending 2026-07-26. Put 5 taps/day on Caffeine for the
  // most recent 7 days and 1/day for the prior 7 → trend up, median mid.
  const entries = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const t = NOON - i * DAY;
    const n = i < 7 ? 5 : 1;
    for (let k = 0; k < n; k++) entries.push({ h: 'Caffeine', t });
  }
  const [caf] = summarizeTargets([HABITS[0]], entries, { now: NOON, dayOf });
  assert.equal(caf.target, 5);
  assert.equal(caf.windowDays, WINDOW_DAYS);
  assert.equal(caf.daysHitGoal, 7); // only the recent half hits goal 5
  assert.equal(caf.trend, 'up');
  assert.equal(caf.medianPerDay, 3); // median of [1×7, 5×7]
  assert.equal(caf.dailyCounts.length, WINDOW_DAYS);
});

test('sanitize: down is auto, up is queued; big jumps clamp to step', () => {
  const { auto, queue } = sanitizeTargetChanges(
    [
      { name: 'Caffeine', to: 1, reason: 'well over all week' }, // 5→1 clamps to 4
      { name: 'Exercise', to: 4, reason: 'hitting 2 most days' } // 1→4 clamps to 2
    ],
    { habits: HABITS, now: 1000 }
  );
  assert.equal(auto.length, 1);
  assert.equal(auto[0].from, 5);
  assert.equal(auto[0].to, 4); // step = max(1, ceil(1)) = 1
  assert.equal(auto[0].auto, true);
  assert.equal(auto[0].direction, 'down');
  assert.equal(queue.length, 1);
  assert.equal(queue[0].from, 1);
  assert.equal(queue[0].to, 2);
  assert.equal(queue[0].auto, false);
  assert.equal(queue[0].direction, 'up');
});

test('sanitize: floor/ceil pins are never crossed', () => {
  const { auto, queue } = sanitizeTargetChanges(
    [
      { name: 'Drink', to: 1, reason: 'too low for floor' },  // floor 4
      { name: 'Drink', to: 99, reason: 'too high for ceil' } // only one Drink change survives
    ],
    { habits: HABITS, now: 2000 }
  );
  // First change: 8→1 clamps by step to 7, then floor lifts to… wait, floor is 4,
  // step from 8 is max(1,ceil(1.6))=2, so 8→6. Second is dropped (name taken).
  assert.equal(auto.length, 1);
  assert.equal(auto[0].to, 6);
  assert.ok(auto[0].to >= 4);
  assert.deepEqual(queue, []);
});

test('sanitize: ceil blocks a ramp past the pin', () => {
  const habits = [{ name: 'Drink', emoji: '💧', label: 'Drink', goal: { target: 12, setBy: 'human', ceil: 12 } }];
  const { auto, queue } = sanitizeTargetChanges(
    [{ name: 'Drink', to: 20, reason: 'want more' }],
    { habits, now: 3000 }
  );
  assert.deepEqual(auto, []);
  assert.deepEqual(queue, [], 'to clamps back to 12 (= current) → no-op');
});

test('sanitize: no-op, unknown habit, missing reason, and duplicates are dropped', () => {
  const pending = [{ id: 'p1', name: 'Exercise', from: 1, to: 2 }];
  const { auto, queue } = sanitizeTargetChanges(
    [
      { name: 'Caffeine', to: 5, reason: 'same as current' },
      { name: 'Nope', to: 2, reason: 'not on roster' },
      { name: 'Caffeine', to: 3 }, // no reason
      { name: 'Exercise', to: 2, reason: 'already queued' },
      { name: 'Caffeine', to: 4, reason: 'ease a bit' },
      { name: 'Caffeine', to: 3, reason: 'second for same habit' }
    ],
    { habits: HABITS, pending, now: 4000 }
  );
  assert.equal(auto.length, 1);
  assert.equal(auto[0].to, 4);
  assert.deepEqual(queue, []);
});

test('sanitize: a dismissed (name:to) is never queued again', () => {
  const { queue } = sanitizeTargetChanges(
    [{ name: 'Exercise', to: 2, reason: 'try again' }],
    { habits: HABITS, rejected: ['exercise:2'], now: 5000 }
  );
  assert.deepEqual(queue, []);
});

test('sanitize: pending cap stops further ups', () => {
  const pending = Array.from({ length: MAX_PENDING }, (_, i) => ({
    id: 'p' + i, name: 'H' + i, from: 1, to: 2
  }));
  const { queue } = sanitizeTargetChanges(
    [{ name: 'Exercise', to: 2, reason: 'no room' }],
    { habits: HABITS, pending, now: 6000 }
  );
  assert.deepEqual(queue, []);
});

test('applyAutoChanges writes coach goal objects and history; never raises', () => {
  const { habits, targets, applied } = applyAutoChanges({
    habits: HABITS,
    targets: null,
    changes: [
      { name: 'Caffeine', label: 'Caffeine', emoji: '☕', from: 5, to: 4, direction: 'down', reason: 'eased', auto: true },
      { name: 'Exercise', label: 'Exercise', from: 1, to: 2, direction: 'up', reason: 'should not apply', auto: false }
    ],
    now: 7000
  });
  assert.equal(applied.length, 1);
  assert.deepEqual(habits[0].goal, {
    target: 4, setBy: 'coach', reason: 'eased', updatedAt: 7000
  });
  assert.equal(habits[1].goal, 1); // bare int untouched
  assert.equal(targets.history[0].via, 'auto');
  assert.equal(targets.history[0].to, 4);
});

test('applyTargetDecision: approve raises; dismiss remembers; ramp-up never self-applies', () => {
  const queued = {
    proposals: [{
      id: 't1', name: 'Exercise', label: 'Exercise', emoji: '🏃',
      from: 1, to: 2, direction: 'up', reason: 'hitting it', createdAt: 1, auto: false
    }],
    history: [],
    rejected: []
  };
  const ok = applyTargetDecision({
    habits: HABITS,
    targets: queued,
    id: 't1',
    decision: 'approve',
    now: 8000
  });
  assert.equal(ok.habits[1].goal.target, 2);
  assert.equal(ok.habits[1].goal.setBy, 'coach');
  assert.equal(ok.targets.proposals.length, 0);
  assert.equal(ok.targets.history[0].via, 'approve');
  assert.equal(ok.applied.status, 'approved');

  const no = applyTargetDecision({
    habits: HABITS,
    targets: queued,
    id: 't1',
    decision: 'dismiss',
    now: 8001
  });
  assert.equal(no.habits, HABITS);
  assert.deepEqual(no.targets.rejected, ['exercise:2']);
  assert.equal(no.applied.status, 'dismissed');
});

test('applyTargetDecision: stale raise (already at/above) drops without rewriting', () => {
  const habits = [{ name: 'Exercise', emoji: '🏃', label: 'Exercise', goal: 3 }];
  const r = applyTargetDecision({
    habits,
    targets: {
      proposals: [{ id: 't1', name: 'Exercise', from: 1, to: 2, direction: 'up', reason: 'old' }]
    },
    id: 't1',
    decision: 'approve',
    now: 9000
  });
  assert.equal(r.applied.status, 'stale');
  assert.equal(r.habits[0].goal, 3);
  assert.equal(r.targets.proposals.length, 0);
});

test('formatTargetLine is plain language for down and up', () => {
  assert.match(
    formatTargetLine({ label: 'Caffeine', from: 5, to: 3, direction: 'down', reason: 'well over all week' }),
    /eased Caffeine 5→3\/day — well over all week/
  );
  assert.match(
    formatTargetLine({ label: 'Exercise', from: 1, to: 2, direction: 'up', reason: 'hitting 2 often' }),
    /nudging Exercise 1→2\/day — hitting 2 often/
  );
});

test('normalizeTargets fills defaults for a missing/corrupt doc', () => {
  assert.deepEqual(normalizeTargets(null), {
    proposals: [], history: [], rejected: [], lastRunAt: 0, model: '', engine: ''
  });
});
