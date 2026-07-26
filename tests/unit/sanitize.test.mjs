import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize } from '../../lib/coach-shape.js';

// sanitize() is the slot-output firewall: every coach pass runs model output
// through it before committing. It is pure, so it needs no mocking. These
// tests pin the invariants the agent's instructions now document (see
// lib/agent.js) so a future prompt/edit drift is caught here, not in prod.

test('clamps to at most 4 slots, keeping the first four', () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ habit: `H${i}`, emoji: '🟢', label: `l${i}` }));
  const out = sanitize(items);
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((s) => s.habit), ['H0', 'H1', 'H2', 'H3']);
});

test('strips non [A-Za-z0-9_-] from habit and caps at 24 chars', () => {
  const out = sanitize([{ habit: 'Food Good! 🍽', emoji: '👍', label: 'x' }]);
  assert.equal(out[0].habit, 'FoodGood');
  const long = sanitize([{ habit: 'A'.repeat(40), emoji: '👍', label: 'x' }]);
  assert.equal(long[0].habit.length, 24);
});

test('drops an item whose habit sanitizes to empty', () => {
  const out = sanitize([
    { habit: '🚫🚫', emoji: '👍', label: 'x' }, // only emoji → stripped to ''
    { habit: 'Real', emoji: '👍', label: 'x' }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].habit, 'Real');
});

test('dedups case-insensitively against reserved (fixed) habits AND within the batch', () => {
  const out = sanitize(
    [
      { habit: 'Water', emoji: '💧', label: 'w' }, // dup of reserved 'Water'
      { habit: 'water', emoji: '💦', label: 'w2' }, // dup of the batch item above (case-insensitive)
      { habit: 'Stretch', emoji: '🤸', label: 's' }
    ],
    { reserved: ['water'] }
  );
  assert.deepEqual(out.map((s) => s.habit), ['Stretch']);
});

test('truncates label (12), emoji (8), reason (160) and applies defaults', () => {
  const out = sanitize([
    {
      habit: 'X',
      emoji: 'ab'.repeat(10), // 20 chars → 8
      label: 'L'.repeat(20), // → 12
      reason: 'R'.repeat(200) // → 160
    }
  ]);
  assert.equal(out[0].emoji.length, 8);
  assert.equal(out[0].label.length, 12);
  assert.equal(out[0].reason.length, 160);
  // defaults when fields are missing
  const def = sanitize([{ habit: 'Y' }]);
  assert.equal(def[0].emoji, '✨');
  assert.equal(def[0].label, 'Y');
  assert.equal(def[0].reason, '');
});

test('honors ttlMinutes only inside [15,720]; otherwise falls back to defaultTtlMs', () => {
  const now = Date.now();
  const inRange = sanitize([{ habit: 'A', emoji: '👍', ttlMinutes: 30 }]);
  assert.ok(inRange[0].expiresAt > now + 29 * 60_000 && inRange[0].expiresAt <= now + 31 * 60_000);

  const tooLow = sanitize([{ habit: 'B', emoji: '👍', ttlMinutes: 5 }]); // < 15 → ignored
  assert.equal('expiresAt' in tooLow[0], false);

  const withDefault = sanitize([{ habit: 'C', emoji: '👍', ttlMinutes: 5 }], { defaultTtlMs: 3600_000 });
  assert.ok(withDefault[0].expiresAt > now); // default kicked in

  const noDefault = sanitize([{ habit: 'D', emoji: '👍' }]);
  assert.equal('expiresAt' in noDefault[0], false);
});

test('non-array or empty input yields [] (never throws)', () => {
  assert.deepEqual(sanitize(null), []);
  assert.deepEqual(sanitize(undefined), []);
  assert.deepEqual(sanitize('nope'), []);
  assert.deepEqual(sanitize([]), []);
});

test('a non-object item STOPS the loop (break, not skip) — items after it are lost', () => {
  // sanitize() uses `break` on a falsy/non-object item, so a malformed entry
  // mid-array terminates processing. Pinned here as existing behavior; changing
  // it to `continue` would be a separate, deliberate decision.
  const out = sanitize([{ habit: 'First', emoji: '👍', label: 'f' }, null, { habit: 'Lost', emoji: '👍', label: 'l' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].habit, 'First');
  // leading junk yields [] because the break fires before any good item
  assert.deepEqual(sanitize([null, { habit: 'X', emoji: '👍', label: 'x' }]), []);
});

test('assignedAt is always Date.now()', () => {
  const before = Date.now();
  const out = sanitize([{ habit: 'X', emoji: '👍', label: 'x' }]);
  const after = Date.now();
  assert.ok(out[0].assignedAt >= before && out[0].assignedAt <= after);
});
