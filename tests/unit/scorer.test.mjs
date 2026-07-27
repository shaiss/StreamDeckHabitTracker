import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreSuggestions, scoreNudges } from '../../lib/scorer.js';

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

// --- three-way nudge outcomes (#35) ---

const nudge = (habit, at, ttl = 3600_000) => ({ habit, nudge: 1, assignedAt: at, expiresAt: at + ttl });

test('tapped, dismissed and ignored are three distinct verdicts', () => {
  const t0 = 1_000_000;
  const hist = [
    { at: t0, slots: [nudge('Water', t0), null, null, null] },
    { at: t0 + 4000_000, slots: [nudge('Stretch', t0 + 4000_000), null, null, null] },
    { at: t0 + 8000_000, slots: [nudge('Walk', t0 + 8000_000), null, null, null] }
  ];
  const entries = [{ h: 'Water', t: t0 + 100, slot: 1 }];
  const dismissals = [{ habit: 'Stretch', slot: 1, at: t0 + 4000_100 }];
  const r = scoreNudges(hist, entries, dismissals, t0 + 20_000_000);

  const by = (h) => r.perHabit.find((x) => x.habit === h);
  assert.deepEqual([by('Water').tapped, by('Water').dismissed, by('Water').ignored], [1, 0, 0]);
  assert.deepEqual([by('Stretch').tapped, by('Stretch').dismissed, by('Stretch').ignored], [0, 1, 0]);
  assert.deepEqual([by('Walk').tapped, by('Walk').dismissed, by('Walk').ignored], [0, 0, 1]);
  assert.equal(r.overall.offered, 3);
  assert.equal(r.overall.hitRate, 0.33);
});

test('a nudge still on the deck has no verdict yet', () => {
  // Counting a fresh poke as ignored would make every nudge look like a
  // failure for the whole hour it is up.
  const t0 = 1_000_000;
  const hist = [{ at: t0, slots: [nudge('Water', t0), null, null, null] }];
  const r = scoreNudges(hist, [], [], t0 + 1000);
  assert.equal(r.overall.offered, 0, 'not yet scored');
  assert.equal(r.live, 1);
});

test('one nudge rewritten into many slot docs is counted once', () => {
  // setSlots rewrites the whole array, so a surviving nudge reappears in every
  // later record. assignedAt is the stable identity.
  const t0 = 1_000_000;
  const same = nudge('Water', t0);
  const hist = [
    { at: t0, slots: [same, null, null, null] },
    { at: t0 + 1000, slots: [same, { habit: 'Mood', assignedAt: t0 + 1000 }, null, null] },
    { at: t0 + 2000, slots: [same, null, null, null] }
  ];
  const r = scoreNudges(hist, [], [], t0 + 9_000_000);
  assert.equal(r.overall.offered, 1, 'three records, one poke');
  assert.equal(r.overall.ignored, 1);
});

test('plain suggestions are not scored as nudges', () => {
  const t0 = 1_000_000;
  const hist = [{ at: t0, slots: [{ habit: 'Mood', assignedAt: t0, expiresAt: t0 + 1000 }, null, null, null] }];
  assert.equal(scoreNudges(hist, [], [], t0 + 9000).overall.offered, 0);
});

test('a dismissal outside the live window does not count', () => {
  const t0 = 1_000_000;
  const hist = [{ at: t0, slots: [nudge('Water', t0, 1000), null, null, null] }];
  const r = scoreNudges(hist, [], [{ habit: 'Water', at: t0 + 50_000 }], t0 + 9_000_000);
  assert.deepEqual([r.overall.dismissed, r.overall.ignored], [0, 1]);
});
