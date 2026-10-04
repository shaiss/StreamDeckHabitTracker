import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pendingCount, isBlocked, beaconOf, liveSlot } from '../../lib/beacon.js';

const NOW = 1_800_000_000_000;
const live = (over = {}) => ({ habit: 'X', assignedAt: NOW, expiresAt: NOW + 60_000, ...over });

test('empty poll is zero, idle, no badge', () => {
  assert.equal(pendingCount({}), 0);
  assert.deepEqual(beaconOf({ slots: [null, null, null, null] }, NOW), {
    pending: 0, blocked: false, frame: 'idle', badge: ''
  });
});

test('a live nudge counts as one pending decision', () => {
  const slots = [live({ nudge: true, habit: 'Water' }), null, null, null];
  assert.equal(pendingCount({ slots }, NOW), 1);
  assert.equal(beaconOf({ slots }, NOW).frame, 'wait');
  assert.equal(beaconOf({ slots }, NOW).badge, '1');
});

test('an expired nudge does not count', () => {
  const slots = [live({ nudge: true, expiresAt: NOW - 1 }), null];
  assert.equal(liveSlot(slots[0], NOW), false);
  assert.equal(pendingCount({ slots }, NOW), 0);
  assert.equal(beaconOf({ slots }, NOW).frame, 'idle');
});

test('a linked question pair shares a qid and counts as one', () => {
  const q = (answer) => live({ qid: 'q1', answer, habit: 'LunchSat' });
  assert.equal(pendingCount({ slots: [q('yes'), q('no'), null, null] }, NOW), 1);
});

test('nudge + question + roster proposals add', () => {
  const slots = [
    live({ nudge: true }),
    live({ qid: 'q1', answer: 'yes' }),
    live({ qid: 'q1', answer: 'no' }),
    null
  ];
  assert.equal(pendingCount({ slots, rosterPending: 2 }, NOW), 1 + 1 + 2);
  assert.equal(pendingCount({ slots, roster: { proposals: [{}, {}] } }, NOW), 4);
  assert.equal(beaconOf({ slots, rosterPending: 2 }, NOW).badge, '4');
});

test('coach-page questions count (slots 5..16 live in coachPage)', () => {
  const coachPage = [live({ qid: 'q-back' }), null];
  assert.equal(pendingCount({ slots: [null, null, null, null], coachPage }, NOW), 1);
});

test('blocked outranks wait; interior callers still see the pending count', () => {
  const slots = [live({ nudge: true })];
  assert.equal(isBlocked({ slots }, NOW), false);
  assert.equal(isBlocked({ blocked: true }, NOW), true);
  assert.equal(isBlocked({ slots: [live({ blocked: true })] }, NOW), true);
  assert.equal(isBlocked({ slots: [live({ blocked: true, expiresAt: NOW - 1 })] }, NOW), false,
    'an expired blocked slot is not a hard-stop');
  const snap = beaconOf({ slots, blocked: true }, NOW);
  assert.equal(snap.frame, 'blocked');
  assert.equal(snap.pending, 1);
  assert.equal(snap.badge, '1');
});

test('the virtual deck embeds the identical pending-count rules (drift guard)', () => {
  const src = readFileSync(new URL('../../public/deck.html', import.meta.url), 'utf8');
  assert.match(src, /function beaconOf\(/, 'deck.html must carry the beacon helper');
  for (const marker of [
    'if (s.nudge) pending += 1',
    'if (s.qid) qids.add(s.qid)',
    'rosterPending',
    "blocked ? 'blocked' : pending > 0 ? 'wait' : 'idle'"
  ]) {
    assert.ok(src.includes(marker), 'deck.html missing beacon marker: ' + marker);
  }
  const plugin = readFileSync(new URL('../../streamdeck-plugin/src/plugin.mjs', import.meta.url), 'utf8');
  assert.match(plugin, /beaconOf/, 'plugin must drive the coach key from beaconOf');
  assert.match(plugin, /VIOLET_HUE, snap\.badge/, 'coach face stays violet; badge is the count');
  const slotsApi = readFileSync(new URL('../../api/slots.js', import.meta.url), 'utf8');
  assert.match(slotsApi, /isBlocked/, '/api/slots must compute blocked for the plugin poll');
  assert.match(slotsApi, /blocked:\s*isBlocked/, 'j.blocked must be the server-derived isBlocked() value');
});
