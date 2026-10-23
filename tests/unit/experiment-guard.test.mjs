// #122: /api/experiment model allowlist + run lock/cooldown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPERIMENT_ALLOWED_MODELS,
  EXPERIMENT_COOLDOWN_MS,
  EXPERIMENT_LOCK_TTL_SEC,
  EXPERIMENT_RUN_TIMEOUT_MS,
  experimentAllowlist,
  parseExperimentModels,
  claimExperimentRun,
  finishExperimentRun
} from '../../lib/experiment-guard.js';

const NOW = 1_700_000_000_000;

/** Minimal Redis stand-in: SET NX EX / GET / DEL with TTL bookkeeping. */
function memoryCmd() {
  const store = new Map(); // key -> { value, expAt }
  const cmd = async (args) => {
    const op = String(args[0] || '').toUpperCase();
    if (op === 'SET') {
      const key = args[1];
      const value = args[2];
      const flags = args.slice(3).map(String);
      const nx = flags.includes('NX');
      let exSec = null;
      const exIdx = flags.indexOf('EX');
      if (exIdx >= 0) exSec = Number(flags[exIdx + 1]);
      const cur = store.get(key);
      if (cur && cur.expAt <= cmd._now) store.delete(key);
      if (nx && store.has(key)) return null;
      store.set(key, {
        value: String(value),
        expAt: exSec != null ? cmd._now + exSec * 1000 : Infinity
      });
      return 'OK';
    }
    if (op === 'GET') {
      const cur = store.get(args[1]);
      if (!cur) return null;
      if (cur.expAt <= cmd._now) {
        store.delete(args[1]);
        return null;
      }
      return cur.value;
    }
    if (op === 'DEL') {
      const had = store.delete(args[1]);
      return had ? 1 : 0;
    }
    throw new Error('unsupported op ' + op);
  };
  cmd._now = NOW;
  cmd._store = store;
  return cmd;
}

test('allowlist includes the current default model pair', () => {
  assert.deepEqual([...EXPERIMENT_ALLOWED_MODELS], ['glm-5.2', 'glm-4.7-flash']);
  assert.ok(EXPERIMENT_COOLDOWN_MS >= 30_000);
  assert.ok(EXPERIMENT_LOCK_TTL_SEC * 1000 >= EXPERIMENT_COOLDOWN_MS);
});

test('run timeout stays comfortably below the lock lease', () => {
  assert.ok(EXPERIMENT_RUN_TIMEOUT_MS > 0);
  assert.ok(
    EXPERIMENT_RUN_TIMEOUT_MS < EXPERIMENT_LOCK_TTL_SEC * 1000,
    'run budget must end before the 90s lease so a hung fetch cannot overlap a second claim'
  );
  // Slack for Vercel maxDuration 60s and cleanup.
  assert.ok(EXPERIMENT_RUN_TIMEOUT_MS <= 60_000);
});

test('parseExperimentModels: default (no raw) accepts preferred + flash', () => {
  const r = parseExperimentModels(undefined, { preferred: 'glm-5.2' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ['glm-5.2', 'glm-4.7-flash']);
});

test('parseExperimentModels: accepts every allowlisted name', () => {
  for (const m of EXPERIMENT_ALLOWED_MODELS) {
    const r = parseExperimentModels(m);
    assert.equal(r.ok, true, m);
    assert.deepEqual(r.models, [m]);
  }
  const both = parseExperimentModels('glm-5.2,glm-4.7-flash');
  assert.equal(both.ok, true);
  assert.deepEqual(both.models, ['glm-5.2', 'glm-4.7-flash']);
});

test('parseExperimentModels: rejects unknown names with a clear 4xx-ready message', () => {
  const r = parseExperimentModels('glm-5.2,evil-model,glm-4.7-flash');
  assert.equal(r.ok, false);
  assert.match(r.error, /Unknown model/);
  assert.match(r.error, /evil-model/);
  assert.match(r.error, /Allowed:/);
  assert.ok(!/stack|ECONN|redis|Internal/i.test(r.error));
});

test('parseExperimentModels: preferred ZAI_MODEL override is admitted', () => {
  const allow = experimentAllowlist('custom-glm');
  assert.equal(allow.has('custom-glm'), true);
  const r = parseExperimentModels('custom-glm,glm-4.7-flash', { preferred: 'custom-glm' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ['custom-glm', 'glm-4.7-flash']);
});

test('parseExperimentModels: caps at 3 models', () => {
  const r = parseExperimentModels('glm-5.2,glm-4.7-flash,glm-5.2,glm-4.7-flash');
  assert.equal(r.ok, true);
  assert.equal(r.models.length, 3);
});

test('claimExperimentRun: first claim wins; second is blocked with retryAfter', async () => {
  const cmd = memoryCmd();
  const a = await claimExperimentRun({ now: NOW, cmd });
  assert.equal(a.ok, true);
  const b = await claimExperimentRun({ now: NOW + 1000, cmd });
  assert.equal(b.ok, false);
  assert.ok(b.retryAfterSec >= 1);
  assert.ok(b.retryAfterSec <= EXPERIMENT_LOCK_TTL_SEC);
});

test('claimExperimentRun: cooldown blocks after a successful finish', async () => {
  const cmd = memoryCmd();
  assert.equal((await claimExperimentRun({ now: NOW, cmd })).ok, true);
  await finishExperimentRun({ ok: true, now: NOW, cmd });

  const blocked = await claimExperimentRun({ now: NOW + 1_000, cmd });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSec >= 1);
  assert.ok(blocked.retryAfterSec <= Math.ceil(EXPERIMENT_COOLDOWN_MS / 1000));

  const after = await claimExperimentRun({ now: NOW + EXPERIMENT_COOLDOWN_MS + 1, cmd });
  assert.equal(after.ok, true);
  await finishExperimentRun({ ok: true, now: NOW + EXPERIMENT_COOLDOWN_MS + 1, cmd });
});

test('finishExperimentRun: lock is released on error so a retry can claim', async () => {
  const cmd = memoryCmd();
  assert.equal((await claimExperimentRun({ now: NOW, cmd })).ok, true);
  await finishExperimentRun({ ok: false, now: NOW + 500, cmd });

  // No cooldown stamp on failure — immediate re-claim must succeed.
  const again = await claimExperimentRun({ now: NOW + 600, cmd });
  assert.equal(again.ok, true);
  await finishExperimentRun({ ok: false, now: NOW + 700, cmd });
});

test('finishExperimentRun: always deletes the lock even when cooldown SET would throw', async () => {
  const base = memoryCmd();
  let setCoolFails = false;
  const cmd = async (args) => {
    if (setCoolFails && String(args[0]).toUpperCase() === 'SET' && String(args[1]).includes('cooldown')) {
      throw new Error('redis blip');
    }
    return base(args);
  };
  cmd._now = base._now;
  cmd._store = base._store;

  assert.equal((await claimExperimentRun({ now: NOW, cmd })).ok, true);
  setCoolFails = true;
  await assert.rejects(() => finishExperimentRun({ ok: true, now: NOW, cmd }), /redis blip/);
  // Lock must still be gone despite the cooldown write failing.
  const relock = await claimExperimentRun({ now: NOW + 10, cmd: base });
  assert.equal(relock.ok, true);
});

test('claimExperimentRun: releases lock if cooldown GET throws (and DEL failure does not mask)', async () => {
  const base = memoryCmd();
  let coolGetFails = false;
  let delFails = false;
  const cmd = async (args) => {
    const op = String(args[0] || '').toUpperCase();
    const key = String(args[1] || '');
    if (coolGetFails && op === 'GET' && key.includes('cooldown')) {
      throw new Error('cooldown GET boom');
    }
    if (delFails && op === 'DEL' && key.includes('lock')) {
      throw new Error('DEL boom');
    }
    return base(args);
  };
  cmd._now = base._now;
  cmd._store = base._store;

  coolGetFails = true;
  await assert.rejects(() => claimExperimentRun({ now: NOW, cmd }), /cooldown GET boom/);
  // Lock must be gone so a later claim can succeed.
  coolGetFails = false;
  const again = await claimExperimentRun({ now: NOW + 10, cmd: base });
  assert.equal(again.ok, true);
  await finishExperimentRun({ ok: false, now: NOW + 20, cmd: base });

  // If DEL also fails, the original cooldown error must still surface.
  coolGetFails = true;
  delFails = true;
  await assert.rejects(() => claimExperimentRun({ now: NOW + 30, cmd }), /cooldown GET boom/);
});
