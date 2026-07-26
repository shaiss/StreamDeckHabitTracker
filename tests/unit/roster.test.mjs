import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeProposals,
  applyDecision,
  restoreFromArchive,
  normalizeRoster,
  MAX_PENDING,
  MAX_ROSTER
} from '../../lib/roster.js';

const HABITS = [
  { name: 'Pee', emoji: '🚽', label: 'Pee', origin: 'human' },
  { name: 'Eat', emoji: '🍽', label: 'Eat', origin: 'human' },
  { name: 'Awake', emoji: '☀️', label: 'Awake', origin: 'coach' }
];
const fill = (n) => Array.from({ length: n }, (_, i) => ({ name: 'H' + i, emoji: '🙂', label: 'h' + i }));

test('accepts a clean add and retire, and dresses the retire from the roster', () => {
  const out = sanitizeProposals(
    [
      { kind: 'add', name: 'Stretch', emoji: '🧘', label: 'Stretch', reason: 'you sit all day' },
      { kind: 'retire', name: 'awake', emoji: '🙃', label: 'ignored', reason: 'untapped for 3 weeks' }
    ],
    { habits: HABITS, now: 1000 }
  );
  assert.equal(out.length, 2);
  assert.deepEqual(
    { ...out[0], id: null },
    { id: null, kind: 'add', name: 'Stretch', emoji: '🧘', label: 'Stretch', origin: 'coach', reason: 'you sit all day', createdAt: 1000 }
  );
  // A retirement is shown as the key really looks, not as the model described it.
  assert.equal(out[1].emoji, '☀️');
  assert.equal(out[1].label, 'Awake');
  assert.equal(out[1].origin, 'coach');
  assert.notEqual(out[0].id, out[1].id);
});

test('drops adds already on the roster and retires that are not', () => {
  const out = sanitizeProposals(
    [
      { kind: 'add', name: 'pee', reason: 'dup, case-insensitive' },
      { kind: 'retire', name: 'Nonexistent', reason: 'not on the roster' },
      { kind: 'sabotage', name: 'Eat', reason: 'unknown kind' }
    ],
    { habits: HABITS }
  );
  assert.deepEqual(out, []);
});

test('drops ids that validateHabits would reject', () => {
  const out = sanitizeProposals(
    [
      { kind: 'add', name: '9lead', reason: 'leading digit' },
      { kind: 'add', name: '', reason: 'empty' },
      { kind: 'add', name: '!!!', reason: 'strips to nothing' },
      { kind: 'add', name: 'two words', reason: 'strips to a valid id' }
    ],
    { habits: HABITS }
  );
  assert.deepEqual(out.map((p) => p.name), ['twowords']);
});

test('never proposes past the roster bounds, in any approval order', () => {
  const full = sanitizeProposals(
    [{ kind: 'add', name: 'One' }, { kind: 'add', name: 'Two' }],
    { habits: fill(MAX_ROSTER - 1) }
  );
  assert.deepEqual(full.map((p) => p.name), ['One'], 'only the add that fits survives');

  const last = sanitizeProposals(
    [{ kind: 'retire', name: 'Solo' }],
    { habits: [{ name: 'Solo', emoji: '🙂', label: 'Solo' }] }
  );
  assert.deepEqual(last, [], 'the last habit is never proposed for retirement');
});

test('honours the pending cap and dedupes against what is already queued', () => {
  const pending = [{ id: 'p1', kind: 'add', name: 'Stretch' }];
  const out = sanitizeProposals(
    [
      { kind: 'add', name: 'Stretch', reason: 'already queued' },
      { kind: 'add', name: 'Water' },
      { kind: 'add', name: 'Walk' },
      { kind: 'add', name: 'Read' }
    ],
    { habits: HABITS, pending }
  );
  assert.deepEqual(out.map((p) => p.name), ['Water', 'Walk']);
  assert.equal(pending.length + out.length, MAX_PENDING);
});

test('a dismissed proposal is never queued again', () => {
  const out = sanitizeProposals(
    [{ kind: 'add', name: 'Journal' }, { kind: 'retire', name: 'Eat' }],
    { habits: HABITS, rejected: ['add:journal'] }
  );
  assert.deepEqual(out.map((p) => p.name), ['Eat']);
});

test('approving an add appends it with coach origin and clears the proposal', () => {
  const roster = { proposals: sanitizeProposals([{ kind: 'add', name: 'Stretch', emoji: '🧘', label: 'Stretch' }], { habits: HABITS }) };
  const r = applyDecision({ habits: HABITS, roster, id: roster.proposals[0].id, decision: 'approve' });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.habits.at(-1), { name: 'Stretch', emoji: '🧘', label: 'Stretch', origin: 'coach' });
  assert.equal(r.habits.length, HABITS.length + 1);
  assert.deepEqual(r.roster.proposals, []);
  assert.equal(r.applied.status, 'approved');
});

test('approving a retire removes the habit and archives it with its origin', () => {
  const roster = { proposals: sanitizeProposals([{ kind: 'retire', name: 'Awake', reason: 'stale' }], { habits: HABITS }) };
  const r = applyDecision({ habits: HABITS, roster, id: roster.proposals[0].id, decision: 'approve', now: 42 });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.habits.map((h) => h.name), ['Pee', 'Eat']);
  assert.deepEqual(r.roster.archive, [
    { name: 'Awake', emoji: '☀️', label: 'Awake', origin: 'coach', reason: 'stale', retiredAt: 42 }
  ]);
  // Retirement is a proposal outcome, not a rejection — nothing to remember.
  assert.deepEqual(r.roster.rejected, []);
});

test('dismissing leaves the roster untouched and remembers the refusal', () => {
  const roster = { proposals: sanitizeProposals([{ kind: 'add', name: 'Journal' }], { habits: HABITS }) };
  const r = applyDecision({ habits: HABITS, roster, id: roster.proposals[0].id, decision: 'dismiss' });
  assert.equal(r.habits, HABITS, 'same reference — no write needed');
  assert.deepEqual(r.roster.rejected, ['add:journal']);
  assert.equal(r.applied.status, 'dismissed');
  // ...and the coach does not get to re-ask.
  assert.deepEqual(sanitizeProposals([{ kind: 'add', name: 'Journal' }], { habits: HABITS, rejected: r.roster.rejected }), []);
});

test('rejects unknown ids, unknown decisions, and stale proposals', () => {
  const roster = { proposals: sanitizeProposals([{ kind: 'add', name: 'Stretch' }], { habits: HABITS }) };
  const id = roster.proposals[0].id;
  assert.match(applyDecision({ habits: HABITS, roster, id: 'nope', decision: 'approve' }).error, /no longer pending/);
  assert.match(applyDecision({ habits: HABITS, roster, id, decision: 'maybe' }).error, /approve.*dismiss/);
  // The human hand-added Stretch before getting to the proposal.
  const already = [...HABITS, { name: 'Stretch', emoji: '🧘', label: 'Stretch', origin: 'human' }];
  assert.match(applyDecision({ habits: already, roster, id, decision: 'approve' }).error, /already on your roster/);
});

test('an approve that would break the roster bounds is refused, not clamped', () => {
  const addRoster = { proposals: [{ id: 'a', kind: 'add', name: 'Extra', emoji: '🙂', label: 'Extra' }] };
  assert.match(
    applyDecision({ habits: fill(MAX_ROSTER), roster: addRoster, id: 'a', decision: 'approve' }).error,
    /roster is full/
  );
  const solo = [{ name: 'Solo', emoji: '🙂', label: 'Solo' }];
  const retRoster = { proposals: [{ id: 'r', kind: 'retire', name: 'Solo', emoji: '🙂', label: 'Solo' }] };
  assert.match(
    applyDecision({ habits: solo, roster: retRoster, id: 'r', decision: 'approve' }).error,
    /last habit/
  );
});

test('restore puts a retired habit back with its original origin', () => {
  const roster = { archive: [{ name: 'Awake', emoji: '☀️', label: 'Awake', origin: 'coach', retiredAt: 1 }] };
  const r = restoreFromArchive({ habits: HABITS.slice(0, 2), roster, name: 'awake' });
  assert.deepEqual(r.habits.at(-1), { name: 'Awake', emoji: '☀️', label: 'Awake', origin: 'coach' });
  assert.deepEqual(r.roster.archive, []);
  assert.equal(r.applied.status, 'restored');
  assert.match(restoreFromArchive({ habits: HABITS, roster: { archive: [] }, name: 'Ghost' }).error, /not in the archive/);
  assert.match(restoreFromArchive({ habits: HABITS, roster, name: 'Awake' }).error, /already on your roster/);
});

test('re-adding a retired habit takes it out of the archive', () => {
  const roster = {
    proposals: [{ id: 'a', kind: 'add', name: 'Awake', emoji: '☀️', label: 'Awake' }],
    archive: [{ name: 'Awake', emoji: '☀️', label: 'Awake', origin: 'coach', retiredAt: 1 }]
  };
  const r = applyDecision({ habits: HABITS.slice(0, 2), roster, id: 'a', decision: 'approve' });
  assert.deepEqual(r.roster.archive, [], 'no ghost entry left behind');
  assert.deepEqual(r.habits.map((h) => h.name), ['Pee', 'Eat', 'Awake']);
});

test('normalizeRoster survives missing, partial, and junk docs', () => {
  const empty = { proposals: [], archive: [], rejected: [], lastRunAt: 0, model: '', engine: '' };
  assert.deepEqual(normalizeRoster(null), empty);
  assert.deepEqual(normalizeRoster({ proposals: 'nope', archive: [null], rejected: ['ADD:X'] }), {
    ...empty,
    rejected: ['add:x']
  });
});
