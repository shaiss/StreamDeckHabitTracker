import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeNlEntries, NL_PROMPT, MAX_ENTRIES, MAX_BACKDATE_HOURS } from '../../lib/nlog.js';

const KEYS = [
  { name: 'Exercise', emoji: '🏃', label: 'Exercise' },
  { name: 'Drink', emoji: '💧', label: 'Water' },
  { name: 'DeepWork', emoji: '🧠', label: 'Deep Work' }
];
const NOW = 1_800_000_000_000;

test('matches habits case-insensitively by name or label and resolves emoji', () => {
  const { entries } = sanitizeNlEntries(
    { entries: [{ habit: 'exercise', note: '20 min walk' }, { habit: 'deep work' }, { habit: 'WATER' }] },
    KEYS, NOW
  );
  assert.deepEqual(entries.map((e) => e.h), ['Exercise', 'DeepWork', 'Drink']);
  assert.equal(entries[0].e, '🏃');
  assert.equal(entries[0].note, '20 min walk');
  assert.ok(entries.every((e) => e.nl === 1 && e.t === NOW));
});

test('drops unknown habits instead of inventing keys', () => {
  const { entries } = sanitizeNlEntries(
    { entries: [{ habit: 'Haircut' }, { habit: 'Exercise' }] }, KEYS, NOW
  );
  assert.deepEqual(entries.map((e) => e.h), ['Exercise']);
});

test('hoursAgo backdates and clamps to the window', () => {
  const { entries } = sanitizeNlEntries(
    { entries: [{ habit: 'Drink', hoursAgo: 3 }, { habit: 'Drink', hoursAgo: 999 }, { habit: 'Drink', hoursAgo: -5 }] },
    KEYS, NOW
  );
  assert.equal(entries[0].t, NOW - 3 * 3600_000);
  assert.equal(entries[1].t, NOW - MAX_BACKDATE_HOURS * 3600_000);
  assert.equal(entries[2].t, NOW); // nonsense hint -> "now"
});

test('round-tripped timestamps are clamped, never trusted', () => {
  const { entries } = sanitizeNlEntries(
    { entries: [{ h: 'Drink', t: NOW - 3600_000 }, { h: 'Drink', t: NOW + 86400_000 }, { h: 'Drink', t: 5 }] },
    KEYS, NOW
  );
  assert.equal(entries[0].t, NOW - 3600_000);              // in-window: kept
  assert.equal(entries[1].t, NOW);                          // future: clamped to now
  assert.equal(entries[2].t, NOW - MAX_BACKDATE_HOURS * 3600_000); // ancient: clamped
});

test('caps entry count, note length, unmatched list, and reply', () => {
  const many = Array.from({ length: 20 }, () => ({ habit: 'Drink', note: 'x'.repeat(500) }));
  const out = sanitizeNlEntries(
    { entries: many, unmatched: Array.from({ length: 12 }, (_, i) => 'thing' + i + 'y'.repeat(100)), reply: 'r'.repeat(999) },
    KEYS, NOW
  );
  assert.equal(out.entries.length, MAX_ENTRIES);
  assert.equal(out.entries[0].note.length, 120);
  assert.equal(out.unmatched.length, 6);
  assert.ok(out.unmatched.every((u) => u.length <= 40));
  assert.equal(out.reply.length, 240);
});

test('tolerates garbage shapes without throwing', () => {
  for (const junk of [null, {}, { entries: 'x' }, { entries: [null, 42, 'str'] }, { unmatched: 'x', reply: 7 }]) {
    const out = sanitizeNlEntries(junk, KEYS, NOW);
    assert.deepEqual(out.entries, []);
    assert.ok(Array.isArray(out.unmatched));
  }
});

test('prompt carries the key names, local time, and the raw text', () => {
  const p = NL_PROMPT({ keys: [{ name: 'Exercise', label: 'Exercise' }], localTime: 'Sat 9:15 PM', timezone: 'America/New_York', text: 'ran 5k' });
  assert.match(p, /Exercise/);
  assert.match(p, /Sat 9:15 PM/);
  assert.match(p, /"ran 5k"/);
  assert.match(p, /ONLY JSON/);
});
