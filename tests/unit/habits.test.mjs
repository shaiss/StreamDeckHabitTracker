import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateHabits,
  isPreviousSeed,
  PREVIOUS_SEED,
  seedHabits,
  getHabits
} from '../../lib/habits.js';

test('accepts a clean list with origins', () => {
  assert.equal(validateHabits([
    { name: 'Pee', emoji: '🚽', label: 'Pee', origin: 'human' },
    { name: 'Bedtime', emoji: '🛌', label: 'Bedtime', origin: 'coach' }
  ]), null);
});

test('rejects duplicate names case-insensitively (the double-promote bug)', () => {
  const err = validateHabits([
    { name: 'Awake', emoji: '☀️', label: 'Awake' },
    { name: 'awake', emoji: '☀️', label: 'Awake' }
  ]);
  assert.match(err, /Duplicate/);
});

test('rejects bad ids, missing emoji/label, unknown origin, bad counts', () => {
  assert.match(validateHabits([{ name: 'two words', emoji: '🙂', label: 'x' }]), /Bad habit id/);
  assert.match(validateHabits([{ name: '9lead', emoji: '🙂', label: 'x' }]), /Bad habit id/);
  assert.match(validateHabits([{ name: 'Ok', label: 'x' }]), /needs an emoji/);
  assert.match(validateHabits([{ name: 'Ok', emoji: '🙂' }]), /needs a label/);
  assert.match(validateHabits([{ name: 'Ok', emoji: '🙂', label: 'x', origin: 'martian' }]), /unknown origin/);
  assert.match(validateHabits([]), /Between 1 and 10/);
  assert.match(validateHabits(Array.from({ length: 11 }, (_, i) => ({ name: 'H' + i, emoji: '🙂', label: 'x' }))), /Between 1 and 10/);
});

test('accepts an optional positive-integer goal', () => {
  assert.equal(validateHabits([{ name: 'Drink', emoji: '💧', label: 'Drink', goal: 8 }]), null);
});

test('rejects out-of-range or non-integer goal (must be a whole number 1-99)', () => {
  assert.match(validateHabits([{ name: 'X', emoji: '💧', label: 'D', goal: 0 }]), /goal/i);
  assert.match(validateHabits([{ name: 'X', emoji: '💧', label: 'D', goal: 100 }]), /goal/i);
  assert.match(validateHabits([{ name: 'X', emoji: '💧', label: 'D', goal: 2.5 }]), /goal/i);
  assert.match(validateHabits([{ name: 'X', emoji: '💧', label: 'D', goal: 'wat' }]), /goal/i);
});

test('goal is optional (no goal still validates)', () => {
  assert.equal(validateHabits([{ name: 'Eat', emoji: '🍽', label: 'Eat' }]), null);
});

test('isPreviousSeed matches the pre-Code eight-entry catalog (origin extras ok)', () => {
  assert.equal(isPreviousSeed(PREVIOUS_SEED.map((h) => ({ ...h }))), true);
  assert.equal(
    isPreviousSeed(PREVIOUS_SEED.map((h) => ({ ...h, origin: 'human' }))),
    true
  );
});

test('isPreviousSeed rejects custom catalogs (length, order, name, emoji, label)', () => {
  assert.equal(isPreviousSeed([]), false);
  assert.equal(isPreviousSeed(seedHabits()), false); // already includes Code
  assert.equal(isPreviousSeed(PREVIOUS_SEED.slice(0, 7)), false);
  assert.equal(
    isPreviousSeed([...PREVIOUS_SEED, { name: 'Code', emoji: '💻', label: 'Code' }]),
    false
  );
  const reordered = [...PREVIOUS_SEED.slice(1), PREVIOUS_SEED[0]];
  assert.equal(isPreviousSeed(reordered), false);
  const renamed = PREVIOUS_SEED.map((h, i) => (i === 0 ? { ...h, name: 'Urinate' } : h));
  assert.equal(isPreviousSeed(renamed), false);
  const relabeled = PREVIOUS_SEED.map((h, i) => (i === 7 ? { ...h, label: 'Chef' } : h));
  assert.equal(isPreviousSeed(relabeled), false);
  const reemoji = PREVIOUS_SEED.map((h, i) => (i === 2 ? { ...h, emoji: '🍜' } : h));
  assert.equal(isPreviousSeed(reemoji), false);
});

test('seedHabits includes Code as the ninth entry (hkey=9)', () => {
  const seed = seedHabits();
  assert.equal(seed.length, 9);
  assert.deepEqual(seed[8], { name: 'Code', emoji: '💻', label: 'Code' });
  assert.ok(!isPreviousSeed(seed));
});

test('getHabits migrates persisted previous seed to the Code catalog once', async () => {
  const calls = [];
  const prev = PREVIOUS_SEED.map((h) => ({ ...h, origin: 'human' }));
  const prevRaw = JSON.stringify(prev);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const args = JSON.parse(opts.body);
    calls.push(args);
    if (args[0] === 'GET') {
      return {
        ok: true,
        json: async () => ({ result: prevRaw })
      };
    }
    if (args[0] === 'EVAL') {
      // CAS: only SET when GET bytes still match what we read.
      assert.equal(args[3], 'habits:config');
      assert.equal(args[4], prevRaw);
      assert.deepEqual(JSON.parse(args[5]), seedHabits());
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    throw new Error(`unexpected redis ${args[0]}`);
  };
  try {
    process.env.KV_REST_API_URL = 'https://example.test';
    process.env.KV_REST_API_TOKEN = 'test';
    const list = await getHabits();
    assert.deepEqual(list.map((h) => h.name), seedHabits().map((h) => h.name));
    assert.equal(list[8].name, 'Code');
    assert.equal(calls[0][0], 'GET');
    assert.equal(calls[1][0], 'EVAL');
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test('getHabits leaves an intentionally custom catalog unchanged', async () => {
  const calls = [];
  const custom = [
    { name: 'Pee', emoji: '🚽', label: 'Pee', origin: 'human' },
    { name: 'Stretch', emoji: '🧘', label: 'Stretch', origin: 'coach' }
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const args = JSON.parse(opts.body);
    calls.push(args);
    return {
      ok: true,
      json: async () => ({ result: JSON.stringify(custom) })
    };
  };
  try {
    process.env.KV_REST_API_URL = 'https://example.test';
    process.env.KV_REST_API_TOKEN = 'test';
    const list = await getHabits();
    assert.deepEqual(list, custom);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'GET');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test('getHabits migration CAS aborts when a concurrent saveHabits wins', async () => {
  const calls = [];
  const prev = PREVIOUS_SEED.map((h) => ({ ...h, origin: 'human' }));
  const prevRaw = JSON.stringify(prev);
  const custom = [
    { name: 'Pee', emoji: '🚽', label: 'Pee', origin: 'human' },
    { name: 'Meditate', emoji: '🧘', label: 'Meditate', origin: 'coach' }
  ];
  const customRaw = JSON.stringify(custom);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const args = JSON.parse(opts.body);
    calls.push(args);
    if (args[0] === 'GET') {
      // First GET: stale seed. Re-GET after failed CAS: concurrent custom.
      const result = calls.filter((c) => c[0] === 'GET').length === 1 ? prevRaw : customRaw;
      return { ok: true, json: async () => ({ result }) };
    }
    if (args[0] === 'EVAL') {
      assert.equal(args[4], prevRaw);
      // Simulate Redis: value no longer equals expected seed bytes.
      return { ok: true, json: async () => ({ result: null }) };
    }
    if (args[0] === 'SET') {
      throw new Error('unconditional SET must not run during seed migration');
    }
    throw new Error(`unexpected redis ${args[0]}`);
  };
  try {
    process.env.KV_REST_API_URL = 'https://example.test';
    process.env.KV_REST_API_TOKEN = 'test';
    const list = await getHabits();
    assert.deepEqual(list, custom);
    assert.equal(calls[0][0], 'GET');
    assert.equal(calls[1][0], 'EVAL');
    assert.equal(calls[2][0], 'GET');
    assert.ok(!calls.some((c) => c[0] === 'SET'));
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});
