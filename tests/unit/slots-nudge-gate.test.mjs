// Issue #110: GET /api/slots must not run nudgePass (Redis write + model)
// unless keyOk() accepts the request. I/O is stubbed in a child process so
// this file stays free of Redis, the model, and @vercel/functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const run = fileURLToPath(new URL('./slots-nudge-gate.run.mjs', import.meta.url));

function scrubbedEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/(HABIT_KEY|ZAI|GLM|ZHIPU|API_KEY|TOKEN|SECRET|REDIS|UPSTASH|^KV_)/i.test(k)) {
      delete env[k];
    }
  }
  return env;
}

function loadResults() {
  const proc = spawnSync(process.execPath, [run], { encoding: 'utf8', env: scrubbedEnv() });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  const line = proc.stdout.trim().split('\n').pop();
  return Object.fromEntries(JSON.parse(line).map((r) => [r.label, r]));
}

test('unkeyed and wrong-key GET /api/slots are pure reads (#110)', () => {
  const by = loadResults();
  for (const label of ['unkeyed', 'wrong-key']) {
    const r = by[label];
    assert.equal(r.status, 200, label);
    assert.equal(r.slotCount, 4, label);
    assert.ok(r.reads.includes('getSlots'), label + ' still reads slots');
    assert.deepEqual(r.nudges, [], label + ' must not run nudgePass');
    assert.deepEqual(r.writes, [], label + ' must not write');
    assert.deepEqual(r.fetches, [], label + ' must not call the network');
  }
});

test('keyed GET /api/slots still runs nudgePass (#110)', () => {
  const r = loadResults().keyed;
  assert.equal(r.status, 200);
  assert.equal(r.slotCount, 4);
  assert.deepEqual(r.nudges, ['nudgePass']);
  assert.ok(r.writes.includes('nudgePass'));
  assert.ok(r.writes.includes('setDeckState'));
  assert.deepEqual(r.fetches, []);
});

test('unset HABIT_KEY stays fail-open: a header-less poll may still nudge', () => {
  const r = loadResults()['unset-secret'];
  assert.equal(r.status, 200);
  assert.deepEqual(r.nudges, ['nudgePass']);
  assert.deepEqual(r.fetches, []);
});
