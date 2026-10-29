// Rails for adaptive-targets I/O (#70 CodeRabbit follow-ups): the shared
// withTargetsLock, abort-on-read-failure, atomic habits+targets write, and
// commit re-read under the lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTargetsLock, getTargets, setTargets, setHabitsAndTargets } from '../../lib/store.js';
import {
  readTargetsForPass,
  commitTargetPass,
  claimTargetRun,
  TARGET_COOLDOWN_MS
} from '../../lib/target-pass.js';

const TARGETS_KEY = 'habits:targets';
const HABITS_KEY = 'habits:config';
const LOCK_KEY = 'habits:targets:lock';
const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const RENEW_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], tonumber(ARGV[2])) else return 0 end";

function isHabitsTargetsMset(args) {
  return args[0] === 'MSET'
    && args[1] === HABITS_KEY
    && args[3] === TARGETS_KEY;
}

function installRedisMock(state, { failAtomic = false } = {}) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, opts) => {
    const args = JSON.parse(opts.body);
    calls.push(args);
    const op = args[0];
    if (op === 'GET') {
      return { ok: true, json: async () => ({ result: state[args[1]] ?? null }) };
    }
    if (op === 'SET') {
      const key = args[1];
      const val = args[2];
      const nx = args.includes('NX');
      if (nx && state[key] != null) {
        return { ok: true, json: async () => ({ result: null }) };
      }
      state[key] = val;
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    if (op === 'MSET') {
      assert.ok(isHabitsTargetsMset(args), 'expected habits+targets MSET');
      if (failAtomic) {
        return { ok: false, status: 503, text: async () => 'atomic blip' };
      }
      // Single command: both keys land together (or neither, on failAtomic).
      state[args[1]] = args[2];
      state[args[3]] = args[4];
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    if (op === 'EVAL') {
      const lua = args[1];
      if (lua === RELEASE_LUA) {
        const key = args[3];
        const token = args[4];
        if (state[key] === token) {
          delete state[key];
          return { ok: true, json: async () => ({ result: 1 }) };
        }
        return { ok: true, json: async () => ({ result: 0 }) };
      }
      if (lua === RENEW_LUA) {
        const key = args[3];
        const token = args[4];
        if (state[key] === token) {
          return { ok: true, json: async () => ({ result: 1 }) };
        }
        return { ok: true, json: async () => ({ result: 0 }) };
      }
      throw new Error(`unexpected EVAL ${lua}`);
    }
    throw new Error(`unexpected redis ${op}`);
  };
  process.env.VERCEL_ENV = 'production';
  process.env.KV_REST_API_URL = 'https://example.test';
  process.env.KV_REST_API_TOKEN = 'test';
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
      delete process.env.VERCEL_ENV;
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;
    }
  };
}

test('withTargetsLock: concurrent second writer is rejected; first write preserved', async () => {
  const state = {
    [TARGETS_KEY]: JSON.stringify({
      proposals: [{ id: 't1', name: 'Exercise', from: 1, to: 2 }],
      history: [],
      rejected: ['caffeine:6']
    })
  };
  const mock = installRedisMock(state);
  try {
    let releaseGate;
    const gate = new Promise((r) => { releaseGate = r; });
    let signalAcquired;
    const acquired = new Promise((r) => { signalAcquired = r; });
    const first = withTargetsLock(async () => {
      signalAcquired();
      await gate;
      await setTargets({
        proposals: [],
        history: [{ name: 'Exercise', to: 2, via: 'approve' }],
        rejected: ['caffeine:6']
      });
      return 'ok';
    });
    await acquired; // first holds the lock before the contender starts
    await assert.rejects(
      () => withTargetsLock(async () => {
        // Stale pass snapshot — must NOT land.
        await setTargets({
          proposals: [{ id: 't1', name: 'Exercise', from: 1, to: 2 }],
          history: [],
          rejected: []
        });
      }),
      (err) => err && err.code === 'TARGETS_BUSY'
    );
    releaseGate();
    assert.equal(await first, 'ok');
    const stored = JSON.parse(state[TARGETS_KEY]);
    assert.equal(stored.proposals.length, 0, 'approval cleared proposals');
    assert.deepEqual(stored.rejected, ['caffeine:6'], 'dismissals preserved');
    assert.equal(stored.history[0].via, 'approve');
    assert.equal(state[LOCK_KEY], undefined, 'lock released');
  } finally {
    mock.restore();
  }
});

test('readTargetsForPass: store read failure aborts (does not empty-normalize)', async () => {
  const originalFetch = globalThis.fetch;
  let setTargetsCalled = false;
  globalThis.fetch = async (_url, opts) => {
    const args = JSON.parse(opts.body);
    if (args[0] === 'GET' && args[1] === TARGETS_KEY) {
      return { ok: false, status: 503, text: async () => 'down' };
    }
    if (args[0] === 'SET' && args[1] === TARGETS_KEY) {
      setTargetsCalled = true;
    }
    throw new Error(`unexpected redis ${args[0]}`);
  };
  process.env.VERCEL_ENV = 'production';
  process.env.KV_REST_API_URL = 'https://example.test';
  process.env.KV_REST_API_TOKEN = 'test';
  try {
    await assert.rejects(() => readTargetsForPass(), /store 503/);
    assert.equal(setTargetsCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.VERCEL_ENV;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test('commitTargetPass: getTargets failure under lock never writes (preserves stored data)', async () => {
  const preserved = {
    proposals: [{ id: 'p1', name: 'Exercise', from: 1, to: 2 }],
    history: [{ name: 'Caffeine', from: 5, to: 4, via: 'auto' }],
    rejected: ['drink:12']
  };
  const state = {
    [TARGETS_KEY]: JSON.stringify(preserved)
  };
  let getCount = 0;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, opts) => {
    const args = JSON.parse(opts.body);
    calls.push(args);
    if (args[0] === 'SET' && args[1] === LOCK_KEY) {
      if (state[LOCK_KEY] != null) return { ok: true, json: async () => ({ result: null }) };
      state[LOCK_KEY] = args[2];
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    if (args[0] === 'EVAL') {
      assert.equal(args[1], RELEASE_LUA);
      if (state[args[3]] === args[4]) delete state[args[3]];
      return { ok: true, json: async () => ({ result: 1 }) };
    }
    if (args[0] === 'GET' && args[1] === TARGETS_KEY) {
      getCount++;
      // Fail the re-read inside the lock (after acquire).
      return { ok: false, status: 502, text: async () => 'blip' };
    }
    if (args[0] === 'SET' && args[1] === TARGETS_KEY) {
      state[TARGETS_KEY] = args[2];
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    throw new Error(`unexpected redis ${JSON.stringify(args)}`);
  };
  process.env.VERCEL_ENV = 'production';
  process.env.KV_REST_API_URL = 'https://example.test';
  process.env.KV_REST_API_TOKEN = 'test';
  try {
    await assert.rejects(
      () => commitTargetPass({
        raw: [{ name: 'Caffeine', to: 3, reason: 'should never land' }],
        engine: 'test'
      }),
      /store 502/
    );
    assert.equal(getCount, 1);
    assert.ok(!calls.some((c) => c[0] === 'SET' && c[1] === TARGETS_KEY),
      'setTargets must not run after a failed read');
    assert.deepEqual(JSON.parse(state[TARGETS_KEY]), preserved,
      'stored proposals/history/rejected untouched');
    assert.equal(state[LOCK_KEY], undefined, 'lock released in finally');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.VERCEL_ENV;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test('commitTargetPass: getHabitsStrict failure under lock never writes (no wipe)', async () => {
  // Custom roster + targets with proposals/history/rejected — a soft getHabits()
  // seed fallback would let saveHabits/setTargets clobber all of this.
  const customHabits = [
    { name: 'Stretch', emoji: '🧘', label: 'Stretch', goal: 3, origin: 'human' },
    { name: 'Code', emoji: '💻', label: 'Code', goal: 2, origin: 'coach' }
  ];
  const preservedTargets = {
    proposals: [{ id: 'p1', name: 'Stretch', from: 3, to: 4 }],
    history: [{ name: 'Code', from: 3, to: 2, via: 'auto' }],
    rejected: ['caffeine:6'],
    lastRunAt: 42,
    model: 'kept',
    engine: 'kept'
  };
  const state = {
    [TARGETS_KEY]: JSON.stringify(preservedTargets),
    [HABITS_KEY]: JSON.stringify(customHabits)
  };
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, opts) => {
    const args = JSON.parse(opts.body);
    calls.push(args);
    if (args[0] === 'SET' && args[1] === LOCK_KEY) {
      if (state[LOCK_KEY] != null) return { ok: true, json: async () => ({ result: null }) };
      state[LOCK_KEY] = args[2];
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    if (args[0] === 'EVAL') {
      assert.equal(args[1], RELEASE_LUA);
      if (state[args[3]] === args[4]) delete state[args[3]];
      return { ok: true, json: async () => ({ result: 1 }) };
    }
    if (args[0] === 'GET' && args[1] === TARGETS_KEY) {
      return { ok: true, json: async () => ({ result: state[TARGETS_KEY] }) };
    }
    if (args[0] === 'GET' && args[1] === HABITS_KEY) {
      return { ok: false, status: 503, text: async () => 'blip' };
    }
    if (args[0] === 'SET') {
      state[args[1]] = args[2];
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    throw new Error(`unexpected redis ${JSON.stringify(args)}`);
  };
  process.env.VERCEL_ENV = 'production';
  process.env.KV_REST_API_URL = 'https://example.test';
  process.env.KV_REST_API_TOKEN = 'test';
  try {
    await assert.rejects(
      () => commitTargetPass({
        raw: [{ name: 'Stretch', to: 1, reason: 'must not land' }],
        engine: 'test'
      }),
      /store 503/
    );
    assert.ok(!calls.some((c) => c[0] === 'SET' && c[1] === HABITS_KEY),
      'saveHabits must not run after a failed habits read');
    assert.ok(!calls.some((c) => c[0] === 'SET' && c[1] === TARGETS_KEY),
      'setTargets must not run after a failed habits read');
    assert.ok(!calls.some(isHabitsTargetsMset),
      'atomic writer must not run after a failed habits read');
    assert.deepEqual(JSON.parse(state[HABITS_KEY]), customHabits,
      'custom roster untouched');
    assert.deepEqual(JSON.parse(state[TARGETS_KEY]), preservedTargets,
      'proposals/history/rejected untouched');
    assert.equal(state[LOCK_KEY], undefined, 'lock released in finally');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.VERCEL_ENV;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test('commitTargetPass: re-read under lock drops a raise already approved by POST', async () => {
  // POST already cleared the Exercise proposal and wrote history; a stale pass
  // that still "wanted" to keep it must not restore it.
  const state = {
    [TARGETS_KEY]: JSON.stringify({
      proposals: [],
      history: [{ name: 'Exercise', from: 1, to: 2, via: 'approve' }],
      rejected: ['caffeine:6'],
      lastRunAt: 1,
      model: '',
      engine: ''
    }),
    'habits:config': JSON.stringify([
      { name: 'Caffeine', emoji: '☕', label: 'Caffeine', goal: 5, origin: 'human' },
      { name: 'Exercise', emoji: '🏃', label: 'Exercise', goal: 2, origin: 'human' }
    ])
  };
  const mock = installRedisMock(state);
  try {
    const doc = await commitTargetPass({
      raw: [{ name: 'Exercise', to: 2, reason: 'stale queue echo' }],
      engine: 'test'
    });
    assert.equal(doc.queued, 0);
    const stored = JSON.parse(state[TARGETS_KEY]);
    assert.equal(stored.proposals.length, 0);
    assert.equal(stored.history[0].via, 'approve');
    assert.deepEqual(stored.rejected, ['caffeine:6']);
  } finally {
    mock.restore();
  }
});

test('commitTargetPass: expectedTargets discards downs after a concurrent human raise', async () => {
  // Model saw Caffeine@5 and proposed 4; human approved 5→6 while the model ran.
  // Without the snapshot check, sanitize would auto-apply 6→4 and undo the raise.
  const state = {
    [TARGETS_KEY]: JSON.stringify({
      proposals: [],
      history: [{ name: 'Caffeine', from: 5, to: 6, via: 'approve' }],
      rejected: [],
      lastRunAt: 1,
      model: '',
      engine: ''
    }),
    [HABITS_KEY]: JSON.stringify([
      { name: 'Caffeine', emoji: '☕', label: 'Caffeine', goal: 6, origin: 'human' }
    ])
  };
  const mock = installRedisMock(state);
  try {
    const doc = await commitTargetPass({
      raw: [{ name: 'Caffeine', to: 4, reason: 'stale ease from snapshot@5' }],
      engine: 'test',
      expectedTargets: { caffeine: 5 }
    });
    assert.equal(doc.autoApplied, 0);
    assert.equal(JSON.parse(state[HABITS_KEY])[0].goal, 6);
    assert.equal(JSON.parse(state[TARGETS_KEY]).history[0].via, 'approve');
  } finally {
    mock.restore();
  }
});

test('claimTargetRun: stamps lastRunAt under lock; second claim hits TARGETS_COOLDOWN', async () => {
  const state = {
    [TARGETS_KEY]: JSON.stringify({
      proposals: [],
      history: [],
      rejected: [],
      lastRunAt: 0
    })
  };
  const mock = installRedisMock(state);
  try {
    const first = await claimTargetRun();
    assert.equal(first.skip, false);
    assert.ok(first.doc.lastRunAt > 0);
    assert.equal(JSON.parse(state[TARGETS_KEY]).lastRunAt, first.doc.lastRunAt);
    await assert.rejects(
      () => claimTargetRun(),
      (err) => !!(err && err.code === 'TARGETS_COOLDOWN' && err.doc)
    );
  } finally {
    mock.restore();
  }
});

test('claimTargetRun: skips without stamping when pending is full', async () => {
  const proposals = Array.from({ length: 3 }, (_, i) => ({
    id: 'p' + i, name: 'H' + i, from: 1, to: 2
  }));
  const state = {
    [TARGETS_KEY]: JSON.stringify({
      proposals,
      history: [],
      rejected: [],
      lastRunAt: 0
    })
  };
  const mock = installRedisMock(state);
  try {
    const claim = await claimTargetRun();
    assert.equal(claim.skip, true);
    assert.equal(JSON.parse(state[TARGETS_KEY]).lastRunAt, 0, 'must not burn cooldown');
  } finally {
    mock.restore();
  }
});

test('claimTargetRun: respects TARGET_COOLDOWN_MS from stored lastRunAt', async () => {
  const recent = Date.now() - Math.floor(TARGET_COOLDOWN_MS / 2);
  const state = {
    [TARGETS_KEY]: JSON.stringify({
      proposals: [],
      history: [],
      rejected: [],
      lastRunAt: recent
    })
  };
  const mock = installRedisMock(state);
  try {
    await assert.rejects(
      () => claimTargetRun(),
      (err) => err && err.code === 'TARGETS_COOLDOWN'
    );
    assert.equal(JSON.parse(state[TARGETS_KEY]).lastRunAt, recent);
  } finally {
    mock.restore();
  }
});

test('getTargets still returns null for a missing doc (distinct from throw)', async () => {
  const state = {};
  const mock = installRedisMock(state);
  try {
    assert.equal(await getTargets(), null);
    const doc = await readTargetsForPass();
    assert.deepEqual(doc.proposals, []);
    assert.deepEqual(doc.rejected, []);
  } finally {
    mock.restore();
  }
});

test('getTargets: unparseable value throws (does not empty-normalize)', async () => {
  const state = { [TARGETS_KEY]: '{not-json' };
  const mock = installRedisMock(state);
  try {
    await assert.rejects(
      () => getTargets(),
      (err) => err && err.code === 'TARGETS_CORRUPT' && /unparseable/.test(err.message)
    );
    await assert.rejects(() => readTargetsForPass(), (err) => err?.code === 'TARGETS_CORRUPT');
  } finally {
    mock.restore();
  }
});

test('getTargets: empty string throws (not missing-key null)', async () => {
  // '' is present-but-corrupt. Returning null would empty-normalize then let
  // setTargets overwrite proposals/history/rejected.
  const state = { [TARGETS_KEY]: '' };
  const mock = installRedisMock(state);
  try {
    await assert.rejects(
      () => getTargets(),
      (err) => err && err.code === 'TARGETS_CORRUPT' && /unparseable/.test(err.message)
    );
    await assert.rejects(() => readTargetsForPass(), (err) => err?.code === 'TARGETS_CORRUPT');
  } finally {
    mock.restore();
  }
});

test('getTargets: non-object JSON throws (array/string/null literal)', async () => {
  for (const bad of ['[]', '"oops"', 'null', '42']) {
    const state = { [TARGETS_KEY]: bad };
    const mock = installRedisMock(state);
    try {
      await assert.rejects(
        () => getTargets(),
        (err) => err && err.code === 'TARGETS_CORRUPT' && /unexpected shape/.test(err.message),
        `expected TARGETS_CORRUPT for ${bad}`
      );
    } finally {
      mock.restore();
    }
  }
});

test('commitTargetPass: malformed habits:targets never writes (fail closed)', async () => {
  // Corrupt-but-present value must not become normalizeTargets(null) → empty
  // doc → setTargets wipe. Throw before any SET of habits:targets / habits:config.
  // Includes '' — previously short-circuited like a missing key.
  for (const corrupt of ['{truncated', '']) {
    const state = {
      [TARGETS_KEY]: corrupt,
      [HABITS_KEY]: JSON.stringify([
        { name: 'Caffeine', emoji: '☕', label: 'Caf', goal: 5, origin: 'human' }
      ])
    };
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (_url, opts) => {
      const args = JSON.parse(opts.body);
      calls.push(args);
      if (args[0] === 'SET' && args[1] === LOCK_KEY) {
        if (state[LOCK_KEY] != null) return { ok: true, json: async () => ({ result: null }) };
        state[LOCK_KEY] = args[2];
        return { ok: true, json: async () => ({ result: 'OK' }) };
      }
      if (args[0] === 'EVAL') {
        assert.equal(args[1], RELEASE_LUA);
        if (state[args[3]] === args[4]) delete state[args[3]];
        return { ok: true, json: async () => ({ result: 1 }) };
      }
      if (args[0] === 'GET' && args[1] === TARGETS_KEY) {
        return { ok: true, json: async () => ({ result: state[TARGETS_KEY] }) };
      }
      if (args[0] === 'GET' && args[1] === HABITS_KEY) {
        return { ok: true, json: async () => ({ result: state[HABITS_KEY] }) };
      }
      if (args[0] === 'SET' || args[0] === 'MSET') {
        throw new Error(`write must not run on corrupt targets: ${JSON.stringify(args)}`);
      }
      throw new Error(`unexpected redis ${JSON.stringify(args)}`);
    };
    process.env.VERCEL_ENV = 'production';
    process.env.KV_REST_API_URL = 'https://example.test';
    process.env.KV_REST_API_TOKEN = 'test';
    try {
      await assert.rejects(
        () => commitTargetPass({
          raw: [{ name: 'Caffeine', to: 3, reason: 'must not land' }],
          engine: 'test'
        }),
        (err) => err && err.code === 'TARGETS_CORRUPT',
        `expected TARGETS_CORRUPT for ${JSON.stringify(corrupt)}`
      );
      assert.ok(!calls.some((c) => c[0] === 'SET' && c[1] === TARGETS_KEY),
        'setTargets must not run after corrupt read');
      assert.ok(!calls.some((c) => c[0] === 'SET' && c[1] === HABITS_KEY),
        'saveHabits must not run after corrupt read');
      assert.ok(!calls.some(isHabitsTargetsMset),
        'atomic writer must not run after corrupt read');
      assert.equal(state[TARGETS_KEY], corrupt, 'corrupt value left untouched (no empty overwrite)');
      assert.equal(state[LOCK_KEY], undefined, 'lock released in finally');
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.VERCEL_ENV;
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;
    }
  }
});

test('setHabitsAndTargets: MSET failure leaves both keys untouched', async () => {
  const habitsBefore = [
    { name: 'Caffeine', emoji: '☕', label: 'Caf', goal: 5, origin: 'human' }
  ];
  const targetsBefore = {
    proposals: [],
    history: [],
    rejected: ['drink:12']
  };
  const state = {
    [HABITS_KEY]: JSON.stringify(habitsBefore),
    [TARGETS_KEY]: JSON.stringify(targetsBefore)
  };
  const mock = installRedisMock(state, { failAtomic: true });
  try {
    await assert.rejects(
      () => setHabitsAndTargets(
        [{ name: 'Caffeine', emoji: '☕', label: 'Caf', goal: { target: 3, setBy: 'coach' }, origin: 'human' }],
        {
          proposals: [],
          history: [{ name: 'Caffeine', from: 5, to: 3, via: 'auto' }],
          rejected: ['drink:12']
        }
      ),
      /store 503/
    );
    assert.deepEqual(JSON.parse(state[HABITS_KEY]), habitsBefore, 'habits not partially written');
    assert.deepEqual(JSON.parse(state[TARGETS_KEY]), targetsBefore, 'targets not partially written');
    assert.ok(mock.calls.some(isHabitsTargetsMset));
  } finally {
    mock.restore();
  }
});

test('commitTargetPass: auto-down uses atomic MSET; failed atomic write leaves both docs', async () => {
  const habitsBefore = [
    { name: 'Caffeine', emoji: '☕', label: 'Caffeine', goal: 5, origin: 'human' },
    { name: 'Exercise', emoji: '🏃', label: 'Exercise', goal: 2, origin: 'human' }
  ];
  const targetsBefore = {
    proposals: [],
    history: [],
    rejected: ['drink:12'],
    lastRunAt: 1,
    model: '',
    engine: ''
  };
  const state = {
    [TARGETS_KEY]: JSON.stringify(targetsBefore),
    [HABITS_KEY]: JSON.stringify(habitsBefore)
  };
  const mock = installRedisMock(state, { failAtomic: true });
  try {
    await assert.rejects(
      () => commitTargetPass({
        raw: [{ name: 'Caffeine', to: 3, reason: 'easing after misses' }],
        engine: 'test'
      }),
      /store 503/
    );
    assert.ok(mock.calls.some(isHabitsTargetsMset),
      'auto-down must use atomic two-key MSET');
    assert.ok(!mock.calls.some((c) => c[0] === 'SET' && c[1] === HABITS_KEY),
      'must not sequential-SET habits before targets');
    assert.ok(!mock.calls.some((c) => c[0] === 'SET' && c[1] === TARGETS_KEY),
      'must not sequential-SET targets after habits');
    assert.deepEqual(JSON.parse(state[HABITS_KEY]), habitsBefore,
      'goal change must not stick without history');
    assert.deepEqual(JSON.parse(state[TARGETS_KEY]), targetsBefore,
      'history must not land without goal change');
    assert.equal(state[LOCK_KEY], undefined, 'lock released in finally');
  } finally {
    mock.restore();
  }
});

test('commitTargetPass: successful auto-down writes habits+targets in one MSET', async () => {
  const state = {
    [TARGETS_KEY]: JSON.stringify({
      proposals: [],
      history: [],
      rejected: [],
      lastRunAt: 1,
      model: '',
      engine: ''
    }),
    [HABITS_KEY]: JSON.stringify([
      { name: 'Caffeine', emoji: '☕', label: 'Caffeine', goal: 5, origin: 'human' }
    ])
  };
  const mock = installRedisMock(state);
  try {
    // Step clamp: from 5, maxStep is 1 — ask for 4 so sanitize does not rewrite.
    const doc = await commitTargetPass({
      raw: [{ name: 'Caffeine', to: 4, reason: 'easing after misses' }],
      engine: 'test'
    });
    assert.equal(doc.autoApplied, 1);
    const atomic = mock.calls.find(isHabitsTargetsMset);
    assert.ok(atomic, 'expected setHabitsAndTargets MSET');
    const habits = JSON.parse(state[HABITS_KEY]);
    const targets = JSON.parse(state[TARGETS_KEY]);
    assert.equal(habits[0].goal.target, 4);
    assert.equal(habits[0].goal.setBy, 'coach');
    assert.equal(targets.history[0].via, 'auto');
    assert.equal(targets.history[0].to, 4);
    assert.deepEqual(JSON.parse(atomic[2]), habits);
    assert.deepEqual(JSON.parse(atomic[4]).history, targets.history);
  } finally {
    mock.restore();
  }
});
