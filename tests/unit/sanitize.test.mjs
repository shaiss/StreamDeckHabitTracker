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

test('max option widens the cap for the coach page (#52) without touching the default', () => {
  const items = Array.from({ length: 14 }, (_, i) => ({ habit: `H${i}`, emoji: '🟢', label: `l${i}` }));
  const wide = sanitize(items, { max: 12 });
  assert.equal(wide.length, 12);
  assert.deepEqual(wide.map((s) => s.habit), items.slice(0, 12).map((i) => i.habit));
  // the default stays the 4-slot wire contract
  assert.equal(sanitize(items).length, 4);
  // and max composes with the other options
  const reserved = sanitize(items, { max: 2, reserved: ['h0'] });
  assert.deepEqual(reserved.map((s) => s.habit), ['H1', 'H2']);
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

// --- the render boundary -------------------------------------------------
// sanitize() length-clamps emoji (8) and label (12) but does NOT strip markup:
// only `habit` is character-restricted. So the pages are the last line of
// defence, and `<img src=x>` fits in 11 characters. This guards the render
// sites the way tests/unit/hue.test.mjs guards the hue formula — as text, so
// a future edit that drops an esc() fails here rather than in a browser.
test('sanitize lets markup through emoji and label — the pages must escape', () => {
  const [def] = sanitize([{ habit: 'Evil', emoji: '<img src=x>', label: '<svg onload' }]);
  assert.equal(def.habit, 'Evil', 'habit is character-restricted');
  assert.ok(def.emoji.includes('<'), 'emoji is only length-clamped, so it can carry markup');
  assert.ok(def.label.includes('<'), 'label is only length-clamped, so it can carry markup');
});

test('every page escapes the model-supplied strings it renders', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (f) => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
  // A model-supplied field interpolated into innerHTML without esc() is the bug.
  const RAW = [
    /\$\{d\.emoji\}/, /\$\{d\.label\}/, /\$\{d\.habit\}/,
    /\$\{lastInsight\.date/, /\+ def\.emoji \+/, /\+ def\.label \+/
  ];
  for (const f of ['public/index.html', 'public/mind.html', 'public/deck.html']) {
    for (const line of read(f).split('\n')) {
      // Only lines that actually BUILD markup can inject. Assigning a DOM
      // property (el.title = def.emoji + …) never parses HTML, so it is safe
      // and would otherwise be a false positive.
      if (!/["'`]\s*<\/?[a-z]/i.test(line)) continue;
      for (const re of RAW) {
        assert.ok(!re.test(line), `${f}: ${re} is interpolated raw into markup — wrap it in esc()\n  ${line.trim()}`);
      }
    }
  }
});
