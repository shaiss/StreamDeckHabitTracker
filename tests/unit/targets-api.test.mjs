// Client-safe error mapping for POST /api/targets — storage failures must
// not echo Redis/Upstash response bodies to the browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  targetsClientMessage,
  TARGETS_WRITE_FAILED_MSG,
  TARGETS_STORAGE_UNAVAILABLE_MSG
} from '../../lib/target.js';

test('targetsClientMessage: TARGETS_WRITE_FAILED → stable generic', () => {
  const err = new Error(TARGETS_WRITE_FAILED_MSG);
  err.code = 'TARGETS_WRITE_FAILED';
  err.cause = new Error('store 503: {"error":"BUSYGROUP secrets"}');
  assert.equal(targetsClientMessage(err), TARGETS_WRITE_FAILED_MSG);
  assert.ok(!targetsClientMessage(err).includes('BUSYGROUP'));
  assert.ok(!targetsClientMessage(err).includes('store 503'));
});

test('targetsClientMessage: raw store status body → generic unavailable', () => {
  const err = new Error('store 500: ERR max requests limit exceeded; ACL denied');
  assert.equal(targetsClientMessage(err), TARGETS_STORAGE_UNAVAILABLE_MSG);
  assert.ok(!targetsClientMessage(err).includes('ACL'));
  assert.ok(!targetsClientMessage(err).includes('max requests'));
});

test('targetsClientMessage: non-storage errors keep their message', () => {
  assert.equal(targetsClientMessage(new Error('bad decision')), 'bad decision');
  assert.equal(targetsClientMessage('plain'), 'plain');
});
