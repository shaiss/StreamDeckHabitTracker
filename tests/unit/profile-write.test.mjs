// Profile write rules (#95 CodeRabbit): coachNav requires navSeq; unsequenced
// name/tz/about still work; a stale dashboard Save after MANUAL cannot restore
// may-navigate when the write is CAS-gated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildProfileNext, applyProfileWrite, applyProfileWriteFrom, parseProfileRaw
} from '../../lib/profile-write.js';

test('coachNav without navSeq is rejected (400)', () => {
  const r = buildProfileNext({ coachNav: 'off', coachNavSeq: 0 }, { coachNav: 'may-navigate' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /coachNav requires navSeq/);
});

test('coachNav with non-positive / non-integer navSeq is rejected (400)', () => {
  for (const navSeq of [0, -1, 1.5, 'nope', null]) {
    const r = buildProfileNext({}, { coachNav: 'off', navSeq });
    assert.equal(r.ok, false, `navSeq=${navSeq}`);
    assert.equal(r.status, 400);
  }
});

test('navSeq without coachNav is rejected (400)', () => {
  const r = buildProfileNext({}, { navSeq: 1, name: 'Ada' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /navSeq requires coachNav/);
});

test('non-consent profile edits (name/tz/about) work without navSeq', () => {
  const prev = { coachNav: 'off', coachNavSeq: 3, name: '', tz: '', about: '' };
  const r = buildProfileNext(prev, {
    name: 'Ada',
    tz: 'America/New_York',
    about: 'Night owl'
  }, { now: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.useNavSeq, false);
  assert.equal(r.next.name, 'Ada');
  assert.equal(r.next.tz, 'America/New_York');
  assert.equal(r.next.about, 'Night owl');
  assert.equal(r.next.coachNav, 'off', 'consent untouched when omitted');
  assert.equal(r.next.coachNavSeq, 3);
  assert.equal(r.next.updatedAt, 1000);
});

test('sequenced MANUAL write then unsequenced name save leaves coachNav off', () => {
  const store = {
    raw: JSON.stringify({ coachNav: 'may-navigate', coachNavSeq: 0, name: '' })
  };
  // Autonomy Toggle → MANUAL
  const auto = applyProfileWrite(store, { coachNav: 'off', navSeq: 1 }, { now: 1 });
  assert.equal(auto.ok, true);
  assert.equal(parseProfileRaw(store.raw).coachNav, 'off');

  // Dashboard Save of name only (omits coachNav) — must not restore may-navigate
  const dash = applyProfileWrite(store, { name: 'Ada' }, { now: 2 });
  assert.equal(dash.ok, true);
  const doc = parseProfileRaw(store.raw);
  assert.equal(doc.coachNav, 'off');
  assert.equal(doc.coachNavSeq, 1);
  assert.equal(doc.name, 'Ada');
});

test('stale unsequenced merge from pre-MANUAL snapshot loses CAS (cannot clobber off)', () => {
  const store = {
    raw: JSON.stringify({ coachNav: 'may-navigate', coachNavSeq: 0, name: 'Old' })
  };
  const staleRaw = store.raw;

  // Autonomy key lands MANUAL while the dashboard still holds the old snapshot
  assert.equal(applyProfileWrite(store, { coachNav: 'off', navSeq: 1 }, { now: 1 }).ok, true);
  assert.equal(parseProfileRaw(store.raw).coachNav, 'off');

  // Stale dashboard Save merged from the old snapshot (even omitting coachNav
  // would re-spread may-navigate from stale prev). CAS must refuse.
  const raced = applyProfileWriteFrom(store, staleRaw, { name: 'Ada' }, { now: 2 });
  assert.equal(raced.ok, false);
  assert.equal(raced.status, 409);
  assert.equal(parseProfileRaw(store.raw).coachNav, 'off', 'MANUAL survives');
  assert.equal(parseProfileRaw(store.raw).name, 'Old');
});

test('unsequenced retry after CAS loss preserves MANUAL and applies name', () => {
  // Model the API handler's retry: first attempt merges from stale raw and
  // loses CAS; second attempt re-reads live store (off) and lands the name.
  const store = {
    raw: JSON.stringify({ coachNav: 'may-navigate', coachNavSeq: 0, name: '' })
  };
  const staleRaw = store.raw;
  applyProfileWrite(store, { coachNav: 'off', navSeq: 1 }, { now: 1 });

  const lost = applyProfileWriteFrom(store, staleRaw, { name: 'Ada' }, { now: 2 });
  assert.equal(lost.ok, false);

  const retried = applyProfileWrite(store, { name: 'Ada' }, { now: 3 });
  assert.equal(retried.ok, true);
  const doc = parseProfileRaw(store.raw);
  assert.equal(doc.coachNav, 'off');
  assert.equal(doc.name, 'Ada');
});

test('sequenced consent write advances coachNavSeq', () => {
  const store = { raw: JSON.stringify({ coachNav: 'off', coachNavSeq: 2 }) };
  const r = applyProfileWrite(store, { coachNav: 'nudge-only', navSeq: 3 }, { now: 1 });
  assert.equal(r.ok, true);
  assert.equal(parseProfileRaw(store.raw).coachNav, 'nudge-only');
  assert.equal(parseProfileRaw(store.raw).coachNavSeq, 3);
});

test('stale navSeq is rejected (409) without mutating store', () => {
  const store = { raw: JSON.stringify({ coachNav: 'off', coachNavSeq: 5 }) };
  const r = applyProfileWrite(store, { coachNav: 'may-navigate', navSeq: 5 }, { now: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(parseProfileRaw(store.raw).coachNav, 'off');
});

test('dashboard Save omits coachNav unless the select changed (drift)', () => {
  const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /let loadedCoachNav\s*=/);
  assert.match(html, /let loadedCoachNavSeq\s*=/);
  assert.match(html, /if \(coachNav !== loadedCoachNav\)/);
  assert.match(html, /body\.coachNav\s*=\s*coachNav/);
  assert.match(html, /body\.navSeq\s*=\s*loadedCoachNavSeq\s*\+\s*1/);
  // Must not unconditionally stuff coachNav into every Save payload.
  assert.doesNotMatch(
    html,
    /JSON\.stringify\(\{\s*name:[\s\S]*coachNav:\s*document\.getElementById\('setCoachNav'\)/
  );
});

test('api/profile requires navSeq for coachNav and CAS-gates unsequenced writes (drift)', () => {
  const api = readFileSync(new URL('../../api/profile.js', import.meta.url), 'utf8');
  const rules = readFileSync(new URL('../../lib/profile-write.js', import.meta.url), 'utf8');
  assert.match(api, /buildProfileNext/);
  assert.match(api, /setProfileIfRaw/);
  assert.match(api, /setProfileIfNavSeq/);
  // Unconditional setProfile(next) is the clobber path CR flagged — gone.
  assert.doesNotMatch(api, /await setProfile\(next\)/);
  assert.match(rules, /coachNav requires navSeq/);
});
