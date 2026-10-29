// Profile write rules (#95 CodeRabbit): coachNav requires navSeq; unsequenced
// name/tz/about still work; a stale dashboard Save after MANUAL cannot restore
// may-navigate when the write is CAS-gated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildProfileNext, applyProfileWrite, applyProfileWriteFrom, parseProfileRaw,
  NAV_SEQ_MAX_AHEAD
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

test('navSeq must be a safe integer — huge / unsafe values are 400 (Cipher F1)', () => {
  const prev = { coachNav: 'off', coachNavSeq: 10 };
  // 1e21 is Number.isInteger(true) but not SafeInteger — would lock the key.
  for (const navSeq of [1e21, Number.MAX_VALUE, Infinity, NaN, 9007199254740992]) {
    const r = buildProfileNext(prev, { coachNav: 'may-navigate', navSeq });
    assert.equal(r.ok, false, `navSeq=${navSeq}`);
    assert.equal(r.status, 400, `navSeq=${navSeq} must be 400 not 409`);
    assert.equal(r.coachNavSeq, undefined, '400 must not advertise coachNavSeq');
    assert.equal(r.coachNav, undefined, '400 must not advertise coachNav');
  }
  // Negative stays 400 (not 409) — no watermark leak.
  const neg = buildProfileNext(prev, { coachNav: 'off', navSeq: -5 });
  assert.equal(neg.status, 400);
  assert.equal(neg.coachNavSeq, undefined);

  // Far ahead of stored: still 400 (not 409) so the live watermark stays opaque.
  const far = buildProfileNext(prev, {
    coachNav: 'may-navigate',
    navSeq: prev.coachNavSeq + NAV_SEQ_MAX_AHEAD + 1
  });
  assert.equal(far.ok, false);
  assert.equal(far.status, 400);
  assert.equal(far.error, 'invalid navSeq');
  assert.equal(far.coachNavSeq, undefined);
  assert.equal(far.coachNav, undefined);

  // Boundary: stored + MAX_AHEAD is accepted.
  const edge = buildProfileNext(prev, {
    coachNav: 'nudge-only',
    navSeq: prev.coachNavSeq + NAV_SEQ_MAX_AHEAD
  });
  assert.equal(edge.ok, true);
  assert.equal(edge.next.coachNavSeq, prev.coachNavSeq + NAV_SEQ_MAX_AHEAD);

  // Legitimate stored+1 still wins.
  const next = buildProfileNext(prev, { coachNav: 'may-navigate', navSeq: 11 });
  assert.equal(next.ok, true);
  assert.equal(next.next.coachNavSeq, 11);
  assert.equal(next.next.coachNav, 'may-navigate');
});

test('stale navSeq 409 body still only exposes coachNav + coachNavSeq (Cipher F1)', () => {
  const prev = { coachNav: 'off', coachNavSeq: 5, name: 'Ada', about: 'secret' };
  const r = buildProfileNext(prev, { coachNav: 'may-navigate', navSeq: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.error, 'stale navSeq');
  assert.equal(r.coachNav, 'off');
  assert.equal(r.coachNavSeq, 5);
  // Nothing new beyond the established 409 reconcile fields.
  assert.deepEqual(Object.keys(r).sort(), ['coachNav', 'coachNavSeq', 'error', 'ok', 'status']);
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

test('concurrent first-write: only one NX creator wins; loser cannot clobber', () => {
  // Two writers both read a missing key (expectedRaw/staleRaw = null). The
  // first SET NX lands; the second must lose — otherwise a stale name save
  // can erase a sequenced MANUAL consent that raced in first.
  const store = { raw: null };
  const a = applyProfileWriteFrom(
    store, null, { coachNav: 'off', navSeq: 1 }, { now: 1 }
  );
  assert.equal(a.ok, true);
  assert.equal(parseProfileRaw(store.raw).coachNav, 'off');
  assert.equal(parseProfileRaw(store.raw).coachNavSeq, 1);

  const b = applyProfileWriteFrom(store, null, { name: 'Ada' }, { now: 2 });
  assert.equal(b.ok, false);
  assert.equal(b.status, 409);
  assert.equal(parseProfileRaw(store.raw).coachNav, 'off', 'MANUAL survives');
  assert.equal(parseProfileRaw(store.raw).name, undefined);
});

test('unsequenced first-write retry after NX loss preserves winner consent', () => {
  // Writer A creates with MANUAL; writer B's null-snapshot name save loses NX
  // then retries from the live snapshot (API CAS-with-retry path).
  const store = { raw: null };
  assert.equal(
    applyProfileWrite(store, { coachNav: 'off', navSeq: 1 }, { now: 1 }).ok,
    true
  );
  // B already observed raw=null; SET NX against the live store must lose.
  const lost = applyProfileWriteFrom(store, null, { name: 'Ada' }, { now: 2 });
  assert.equal(lost.ok, false);
  assert.equal(lost.status, 409);
  assert.equal(parseProfileRaw(store.raw).name, undefined, 'NX loser must not write');
  // API-style retry: reread live profile and apply name only.
  const retried = applyProfileWrite(store, { name: 'Ada' }, { now: 3 });
  assert.equal(retried.ok, true);
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
  // Dashboard script lives in public/index.js (extracted with habit-key).
  const js = readFileSync(new URL('../../public/index.js', import.meta.url), 'utf8');
  assert.match(js, /let loadedCoachNav\s*=/);
  assert.match(js, /let loadedCoachNavSeq\s*=/);
  assert.match(js, /if \(coachNav !== loadedCoachNav\)/);
  assert.match(js, /body\.coachNav\s*=\s*coachNav/);
  assert.match(js, /body\.navSeq\s*=\s*loadedCoachNavSeq\s*\+\s*1/);
  // Must not unconditionally stuff coachNav into every Save payload.
  assert.doesNotMatch(
    js,
    /JSON\.stringify\(\{\s*name:[\s\S]*coachNav:\s*document\.getElementById\('setCoachNav'\)/
  );
});

test('dashboard Save resyncs consent tokens after every successful profile write (drift)', () => {
  // Name-only Saves can CAS-retry onto a fresher Autonomy write; the 200 body
  // carries the live coachNav/coachNavSeq and must update loaded* so the next
  // consent change does not send a stale navSeq (#95 Entelligence).
  const js = readFileSync(new URL('../../public/index.js', import.meta.url), 'utf8');
  const okBranch = js.match(/if \(j\.ok\) \{([\s\S]*?)\} else if \(r\.status === 409/);
  assert.ok(okBranch, 'successful Save branch missing');
  const body = okBranch[1];
  assert.match(body, /loadedCoachNavSeq\s*=\s*Math\.max\(0,\s*Number\(j\.coachNavSeq\)/);
  assert.match(body, /body\.coachNav\s*!==\s*undefined/);
  assert.match(body, /loadedCoachNav\s*=\s*j\.coachNav\s*\|\|\s*loadedCoachNav/);
  // Intentional consent Save must not rewrite the select; name-only else
  // branch rewrites only when the select still matches the click-time value
  // (preserve edits made while Save was pending — #95 Entelligence).
  const coachNavIf = body.match(/if \(body\.coachNav !== undefined\) \{([\s\S]*?)\} else \{/);
  assert.ok(coachNavIf, 'consent intentional / name-only branches missing');
  assert.doesNotMatch(coachNavIf[1], /setCoachNav/,
    'intentional consent Save must not rewrite the select');
  assert.match(
    body,
    /\} else \{[\s\S]*?getElementById\('setCoachNav'\)[\s\S]*?\.value\s*===\s*coachNav[\s\S]*?\}/
  );
});

test('dashboard Save 409 with coachNavSeq resyncs consent without clearing edits (drift)', () => {
  const js = readFileSync(new URL('../../public/index.js', import.meta.url), 'utf8');
  assert.match(js, /r\.status\s*===\s*409\s*&&\s*j\.coachNavSeq\s*!==\s*undefined/);
  assert.match(js, /loadedCoachNav\s*=\s*j\.coachNav\s*\|\|\s*loadedCoachNav/);
  assert.match(js, /loadedCoachNavSeq\s*=\s*Math\.max\(0,\s*Number\(j\.coachNavSeq\)/);
  assert.match(js, /getElementById\('setCoachNav'\)\.value\s*=\s*loadedCoachNav/);
  assert.match(js, /Consent changed on the deck/);
  // Must not wipe name/tz/about on 409 — only status + consent select.
  assert.doesNotMatch(
    js,
    /status\s*===\s*409[\s\S]{0,400}getElementById\('setName'\)\.value\s*=/
  );
});

test('api/profile requires navSeq for coachNav and CAS-gates unsequenced writes (drift)', () => {
  const api = readFileSync(new URL('../../api/profile.js', import.meta.url), 'utf8');
  const rules = readFileSync(new URL('../../lib/profile-write.js', import.meta.url), 'utf8');
  const store = readFileSync(new URL('../../lib/store.js', import.meta.url), 'utf8');
  assert.match(api, /buildProfileNext/);
  assert.match(api, /setProfileIfRaw/);
  assert.match(api, /setProfileIfNavSeq/);
  // Unconditional setProfile(next) is the clobber path CR flagged — gone.
  assert.doesNotMatch(api, /await setProfile\(next\)/);
  assert.match(rules, /coachNav requires navSeq/);
  // First-write path must be SET NX (not bare SET) so two null-snapshot
  // writers cannot both report success. Key is redisKey('habits:profile')
  // (preview isolation), not a module-level PROFILE_KEY constant.
  assert.match(
    store,
    /SET',\s*key,\s*nextRaw,\s*'NX'|SET",\s*key,\s*nextRaw,\s*"NX/
  );
  assert.match(store, /created\s*===\s*'OK'|return created === 'OK'/);
  assert.match(store, /redisKey\('habits:profile'\)/);
});
