import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreSuggestions } from '../../lib/scorer.js';

test('credits taps only inside the assignment window', () => {
  const t0 = 1_000_000;
  const hist = [
    { at: t0, slots: [{ habit: 'Mood', assignedAt: t0 }, { habit: 'Energy', assignedAt: t0 }, null, null] },
    { at: t0 + 1000, slots: [{ habit: 'Mood', assignedAt: t0 + 1000 }, null, null, null] }
  ];
  const entries = [
    { h: 'Mood', t: t0 + 500, slot: 1 },
    { h: 'Mood', t: t0 + 1500, slot: 1 },
    { h: 'Energy', t: t0 + 2000, slot: 2 }, // after Energy was replaced — no credit
    { h: 'Drink', t: t0 + 600 }             // fixed-habit tap, not via slot — ignored
  ];
  const r = scoreSuggestions(hist, entries, t0 + 3000);
  const mood = r.perHabit.find((x) => x.habit === 'Mood');
  const energy = r.perHabit.find((x) => x.habit === 'Energy');
  assert.deepEqual([mood.offered, mood.landed], [2, 2]);
  assert.deepEqual([energy.offered, energy.landed], [1, 0]);
  assert.deepEqual([r.overall.offered, r.overall.landed], [3, 2]);
});

test('expiry truncates the credit window', () => {
  const t0 = 1_000_000;
  const hist = [{ at: t0, slots: [{ habit: 'Nap', assignedAt: t0, expiresAt: t0 + 100 }, null, null, null] }];
  const r = scoreSuggestions(hist, [{ h: 'Nap', t: t0 + 500, slot: 1 }], t0 + 1000);
  assert.equal(r.perHabit.find((x) => x.habit === 'Nap').landed, 0);
});
