import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateHabits,
  isPreviousSeed,
  PREVIOUS_SEED,
  seedHabits,
  getHabits,
  saveHabits
} from '../../lib/habits.js';
import habitsHandler from '../../api/habits.js';

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

const WRITE_CMDS = new Set([
  'SET', 'SETNX', 'RPUSH', 'LPUSH', 'LSET', 'LREM', 'LTRIM', 'DEL', 'HSET', 'HDEL',
  'INCR', 'INCRBY', 'EXPIRE', 'PEXPIRE', 'GETSET', 'SADD', 'SREM', 'ZADD', 'ZREM',
  'MSET', 'APPEND', 'EVAL'
]);

function redisOk(result) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ result }),
    text: async () => JSON.stringify({ result })
  };
}

function withRedis(handlers, fn) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const env = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN
  };
  globalThis.fetch = async (_url, opts) => {
    const args = JSON.parse(opts.body);
    calls.push(args);
    const cmd = String(args[0] || '').toUpperCase();
    if (typeof handlers === 'function') {
      return handlers(args, calls);
    }
    const reply = handlers[cmd];
    if (reply === undefined) throw new Error(`unexpected redis ${args[0]}`);
    const result = typeof reply === 'function' ? await reply(args, calls) : reply;
    // Allow a handler to return a full Response-like object.
    if (result && typeof result === 'object' && typeof result.json === 'function') return result;
    return redisOk(result);
  };
  process.env.VERCEL_ENV = 'production';
  process.env.KV_REST_API_URL = 'https://example.test';
  process.env.KV_REST_API_TOKEN = 'test';
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      globalThis.fetch = originalFetch;
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

function mkRes() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('getHabits maps previous seed to current seed with zero Redis writes (#127)', async () => {
  const prev = PREVIOUS_SEED.map((h) => ({ ...h, origin: 'human' }));
  const prevRaw = JSON.stringify(prev);
  let redisValue = prevRaw;
  await withRedis({
    GET: () => redisValue
  }, async (calls) => {
    const list = await getHabits();
    assert.deepEqual(list.map((h) => h.name), seedHabits().map((h) => h.name));
    assert.equal(list[8].name, 'Code');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'GET');
    assert.ok(!calls.some((c) => WRITE_CMDS.has(String(c[0]).toUpperCase())));
    // Redis still holds the previous seed — no migration write on read.
    assert.equal(redisValue, prevRaw);
    assert.ok(isPreviousSeed(JSON.parse(redisValue)));
  });
});

test('getHabits leaves an intentionally custom catalog unchanged', async () => {
  const custom = [
    { name: 'Pee', emoji: '🚽', label: 'Pee', origin: 'human' },
    { name: 'Stretch', emoji: '🧘', label: 'Stretch', origin: 'coach' }
  ];
  await withRedis({
    GET: () => JSON.stringify(custom)
  }, async (calls) => {
    const list = await getHabits();
    assert.deepEqual(list, custom);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'GET');
    assert.ok(!calls.some((c) => WRITE_CMDS.has(String(c[0]).toUpperCase())));
  });
});

test('GET /api/habits returns current seed with zero Redis writes when stored is previous (#127)', async () => {
  const prev = PREVIOUS_SEED.map((h) => ({ ...h, origin: 'human' }));
  const prevRaw = JSON.stringify(prev);
  let redisValue = prevRaw;
  await withRedis((args) => {
    const cmd = String(args[0] || '').toUpperCase();
    if (cmd === 'GET') {
      // habits:config → previous seed; other GETs (log/slots/history) → empty.
      if (args[1] === 'habits:config') return redisOk(redisValue);
      return redisOk(null);
    }
    if (cmd === 'LRANGE') return redisOk([]);
    if (cmd === 'EXISTS' || cmd === 'TYPE') return redisOk(null);
    throw new Error(`unexpected redis write/cmd ${args[0]}`);
  }, async (calls) => {
    const res = mkRes();
    await habitsHandler({ method: 'GET', query: {}, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    const names = (res.body.habits || []).map((h) => h.name);
    assert.deepEqual(names, seedHabits().map((h) => h.name));
    assert.equal(names[8], 'Code');
    assert.ok(calls.every((c) => !WRITE_CMDS.has(String(c[0]).toUpperCase())),
      `read path wrote Redis: ${JSON.stringify(calls.filter((c) => WRITE_CMDS.has(String(c[0]).toUpperCase())))}`);
    assert.ok(calls.some((c) => c[0] === 'GET' && c[1] === 'habits:config'));
    assert.equal(redisValue, prevRaw);
  });
});

test('saveHabits persists the upgraded seed on the keyed write path (#127)', async () => {
  let redisValue = JSON.stringify(PREVIOUS_SEED.map((h) => ({ ...h, origin: 'human' })));
  await withRedis({
    SET: (args) => {
      redisValue = args[2];
      return 'OK';
    }
  }, async (calls) => {
    const saved = await saveHabits(seedHabits());
    assert.equal(saved[8].name, 'Code');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'SET');
    assert.equal(calls[0][1], 'habits:config');
    assert.deepEqual(JSON.parse(redisValue).map((h) => h.name), seedHabits().map((h) => h.name));
  });
});
