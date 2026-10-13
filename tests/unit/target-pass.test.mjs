// Rails for adaptive-targets I/O (#70 CodeRabbit follow-ups): the shared
// withTargetsLock, abort-on-read-failure, and commit re-read under the lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTargetsLock, getTargets, setTargets } from '../../lib/store.js';
import { readTargetsForPass, commitTargetPass } from '../../lib/target-pass.js';

const TARGETS_KEY = 'habits:targets';
const LOCK_KEY = 'habits:targets:lock';
const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

function installRedisMock(state) {
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
    if (op === 'EVAL') {
      const lua = args[1];
      const key = args[3];
      const token = args[4];
      assert.equal(lua, RELEASE_LUA);
      if (state[key] === token) {
        delete state[key];
        return { ok: true, json: async () => ({ result: 1 }) };
      }
      return { ok: true, json: async () => ({ result: 0 }) };
    }
    throw new Error(`unexpected redis ${op}`);
  };
  process.env.KV_REST_API_URL = 'https://example.test';
  process.env.KV_REST_API_TOKEN = 'test';
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
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
  process.env.KV_REST_API_URL = 'https://example.test';
  process.env.KV_REST_API_TOKEN = 'test';
  try {
    await assert.rejects(() => readTargetsForPass(), /store 503/);
    assert.equal(setTargetsCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
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
    'habits:config': JSON.stringify(customHabits)
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
    if (args[0] === 'GET' && args[1] === 'habits:config') {
      return { ok: false, status: 503, text: async () => 'blip' };
    }
    if (args[0] === 'SET') {
      state[args[1]] = args[2];
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    throw new Error(`unexpected redis ${JSON.stringify(args)}`);
  };
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
    assert.ok(!calls.some((c) => c[0] === 'SET' && c[1] === 'habits:config'),
      'saveHabits must not run after a failed habits read');
    assert.ok(!calls.some((c) => c[0] === 'SET' && c[1] === TARGETS_KEY),
      'setTargets must not run after a failed habits read');
    assert.deepEqual(JSON.parse(state['habits:config']), customHabits,
      'custom roster untouched');
    assert.deepEqual(JSON.parse(state[TARGETS_KEY]), preservedTargets,
      'proposals/history/rejected untouched');
    assert.equal(state[LOCK_KEY], undefined, 'lock released in finally');
  } finally {
    globalThis.fetch = originalFetch;
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
