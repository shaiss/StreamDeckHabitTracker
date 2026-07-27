import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../../streamdeck-plugin/src/scheduler.mjs';

const mk = () => createScheduler({ pollMs: 15000, timeoutMs: 10000, recheckMs: [2000, 5000] });

test('polls immediately at boot, then honors the poll interval', () => {
  const s = mk();
  assert.deepEqual(s.pump(1000), { expired: false, poll: true });
  const seq = s.pollStarted(1000);
  assert.equal(s.pump(2000).poll, false, 'in-flight blocks a second poll');
  assert.ok(s.pollSettled(seq));
  assert.equal(s.pump(3000).poll, false, 'not due again until pollMs elapses');
  assert.equal(s.pump(16001).poll, true);
});

test('a hung poll expires after timeoutMs, is retried, and its late settle is orphaned', () => {
  const s = mk();
  s.pump(1000);
  const stuck = s.pollStarted(1000);
  assert.equal(s.pump(9000).expired, false, 'not expired yet');
  const r = s.pump(11001);
  assert.equal(r.expired, true, 'guard expired');
  assert.equal(r.poll, true, 'retry allowed in the same pump');
  const retry = s.pollStarted(11001);
  assert.equal(s.pollSettled(stuck), false, 'late settle of the orphan is ignored');
  assert.ok(s.pollSettled(retry), 'the retry settles normally');
});

test('a tap forces an immediate poll and schedules the recheck chain', () => {
  const s = mk();
  s.pump(1000);
  s.pollSettled(s.pollStarted(1000));   // routine poll done; next due at 16000
  s.tapped(2000);
  assert.equal(s.pump(2001).poll, true, 'tap zeroes the routine deadline');
  s.pollSettled(s.pollStarted(2001));   // next routine poll now due at 17001
  assert.equal(s.pump(3000).poll, false);
  assert.equal(s.pump(4001).poll, true, 'first recheck (tap+2000) came due');
  s.pollSettled(s.pollStarted(4001));
  assert.equal(s.pump(7001).poll, true, 'second recheck (tap+5000) came due');
});

test('forcePoll zeroes the routine deadline (wake/device-connect path)', () => {
  const s = mk();
  s.pump(1000);
  s.pollSettled(s.pollStarted(1000));
  s.forcePoll();
  assert.equal(s.pump(1002).poll, true);
});
