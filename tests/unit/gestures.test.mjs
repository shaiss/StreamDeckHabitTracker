import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGestures, LONG_PRESS_MS, DOUBLE_TAP_MS } from '../../streamdeck-plugin/src/gestures.mjs';

const mk = () => createGestures();

test('the pinned constants are the ones issues #33 and #35 agreed on', () => {
  assert.equal(LONG_PRESS_MS, 500);
  assert.equal(DOUBLE_TAP_MS, 300);
});

test('the virtual deck embeds the identical timings (drift guard)', () => {
  // public/deck.html has no build step, so it cannot import the module — it
  // carries its own copy. Two timings that disagree would make the virtual
  // deck a lying preview of the physical one, so pin them from the source of
  // truth rather than trusting a comment to keep them in step.
  const src = readFileSync(new URL('../../public/deck.html', import.meta.url), 'utf8');
  assert.match(src, new RegExp('LONG_PRESS_MS\\s*=\\s*' + LONG_PRESS_MS + '\\b'));
  assert.match(src, new RegExp('DOUBLE_TAP_MS\\s*=\\s*' + DOUBLE_TAP_MS + '\\b'));
});

test('a key with no double-tap handler taps immediately on release', () => {
  const g = mk();
  g.register('a', { doubleTap: false });
  g.down('a', 1000);
  assert.deepEqual(g.up('a', 1100), [{ id: 'a', gesture: 'tap' }]);
  assert.equal(g.nextDeadline(), 0, 'nothing left pending');
});

test('a key with a double-tap handler defers its tap by the window', () => {
  const g = mk();
  g.register('a', { doubleTap: true });
  g.down('a', 1000);
  assert.deepEqual(g.up('a', 1100), [], 'release alone resolves nothing');
  assert.equal(g.nextDeadline(), 1400, 'waiting out the double-tap window');
  assert.deepEqual(g.tick(1399), [], 'not due yet');
  assert.deepEqual(g.tick(1400), [{ id: 'a', gesture: 'tap' }]);
  assert.equal(g.nextDeadline(), 0);
});

test('a second short press inside the window is a double-tap, and cancels the tap', () => {
  const g = mk();
  g.register('a', { doubleTap: true });
  g.down('a', 1000);
  g.up('a', 1100);
  g.down('a', 1200);
  assert.deepEqual(g.up('a', 1250), [{ id: 'a', gesture: 'doubletap' }]);
  assert.deepEqual(g.tick(9999), [], 'the deferred tap was consumed, not merely delayed');
});

test('holding fires long-press while still held, and the release is swallowed', () => {
  const g = mk();
  g.register('a', { doubleTap: true });
  g.down('a', 1000);
  assert.deepEqual(g.tick(1499), [], 'not long enough yet');
  assert.deepEqual(g.tick(1500), [{ id: 'a', gesture: 'longpress' }]);
  assert.deepEqual(g.tick(2000), [], 'long-press fires once per press, not repeatedly');
  assert.deepEqual(g.up('a', 2500), [], 'the release that ends a hold logs nothing');
});

test('a hold is not mistaken for the first half of a double-tap', () => {
  const g = mk();
  g.register('a', { doubleTap: true });
  g.down('a', 1000);
  g.tick(1500);            // long-press fires
  g.up('a', 1600);
  g.down('a', 1650);       // a quick press right after the hold
  assert.deepEqual(g.up('a', 1700), [], 'is a fresh first press, not a double-tap');
  assert.deepEqual(g.tick(2000), [{ id: 'a', gesture: 'tap' }]);
});

test('keys resolve independently', () => {
  const g = mk();
  g.register('a', { doubleTap: true });
  g.register('b', { doubleTap: false });
  g.down('a', 1000);
  g.down('b', 1000);
  assert.deepEqual(g.up('b', 1050), [{ id: 'b', gesture: 'tap' }]);
  assert.deepEqual(g.tick(1500), [{ id: 'a', gesture: 'longpress' }], 'only the held key');
});

test('nextDeadline reports the soonest pending deadline across keys', () => {
  const g = mk();
  g.register('a', { doubleTap: true });
  g.register('b', { doubleTap: true });
  g.down('a', 1000);         // long-press deadline 1500
  g.up('b', 1300);           // double-tap deadline 1600
  assert.equal(g.nextDeadline(), 1500);
  g.tick(1500);
  assert.equal(g.nextDeadline(), 1600);
});

test('forget() drops a key that disappeared mid-press', () => {
  const g = mk();
  g.register('a', { doubleTap: true });
  g.down('a', 1000);
  g.forget('a');
  assert.deepEqual(g.tick(2000), [], 'a vanished key cannot fire a gesture');
  assert.equal(g.nextDeadline(), 0);
});
