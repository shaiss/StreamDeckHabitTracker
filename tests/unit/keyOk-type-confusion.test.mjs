// Type-confusion pins for keyOk / presentedKeys (issue #115 leftover).
// Documents current tip behavior: only string values from header, query.key,
// and body.key are considered. Non-string channels must not authenticate.
// Prefer documenting safe tip behavior over changing production code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyOk, presentedKeys, KEY_HEADER } from '../../lib/habit-key.js';

const S = 'test-' + 'placeholder-value';   // not a real key

function req(headers = {}, query = {}) {
  return { headers, query };
}

// ---- query.key arrays -----------------------------------------------------
test('keyOk: query.key as an array does not authenticate even if an element equals the secret', () => {
  assert.equal(keyOk(req({}, { key: [S, 'other'] }), null, S), false);
  assert.equal(keyOk(req({}, { key: [S] }), null, S), false);
  assert.equal(keyOk(req({}, { key: ['other', S] }), null, S), false);
  assert.deepEqual(presentedKeys(req({}, { key: [S] })), []);
});

test('keyOk: query.key non-string scalars are refused', () => {
  for (const key of [1, 0, true, false, { key: S }, null, undefined, Symbol('x')]) {
    assert.equal(keyOk(req({}, { key }), null, S), false, String(key));
  }
  assert.deepEqual(presentedKeys(req({}, { key: 1 })), []);
});

// ---- body.key non-strings -------------------------------------------------
test('keyOk: body.key as a non-string does not authenticate', () => {
  for (const body of [
    { key: 1 },
    { key: 0 },
    { key: true },
    { key: false },
    { key: [S] },
    { key: [S, 'other'] },
    { key: { nested: S } },
    { key: null },
  ]) {
    assert.equal(keyOk(req({}, {}), body, S), false, JSON.stringify(body));
    assert.deepEqual(presentedKeys(req({}, {}), body), []);
  }
});

// ---- header shape quirks --------------------------------------------------
test('keyOk: duplicate / multi-value x-habit-key via Headers.get join does not throw and does not match', () => {
  const h = new Headers();
  h.append(KEY_HEADER, S);
  h.append(KEY_HEADER, 'other');
  // WHATWG Headers.get joins duplicates with ", " → not equal to S
  assert.equal(h.get(KEY_HEADER), S + ', other');
  assert.doesNotThrow(() => keyOk(req(h), null, S));
  assert.equal(keyOk(req(h), null, S), false);
  assert.deepEqual(presentedKeys(req(h)), [S + ', other']);
});

test('keyOk: plain-object header array value is ignored (not a string)', () => {
  assert.equal(keyOk(req({ [KEY_HEADER]: [S] }), null, S), false);
  assert.equal(keyOk(req({ [KEY_HEADER]: [S, 'other'] }), null, S), false);
  assert.deepEqual(presentedKeys(req({ [KEY_HEADER]: [S] })), []);
});

test('keyOk: only a single string header match authenticates', () => {
  assert.ok(keyOk(req({ [KEY_HEADER]: S }), null, S));
  assert.ok(keyOk(req(new Headers({ [KEY_HEADER]: S })), null, S));
  assert.equal(keyOk(req({ [KEY_HEADER]: S + ', other' }), null, S), false);
  assert.equal(keyOk(req({ [KEY_HEADER]: 42 }), null, S), false);
  assert.equal(keyOk(req({ [KEY_HEADER]: true }), null, S), false);
});

// ---- mixed: wrong-type + valid string channel still works -----------------
test('keyOk: type-confused channel mixed with a valid string channel still authenticates', () => {
  // array query.key is ignored; header string wins
  assert.ok(keyOk(req({ [KEY_HEADER]: S }, { key: [S] }), null, S));
  // non-string body ignored; query string wins
  assert.ok(keyOk(req({}, { key: S }), { key: [S] }, S));
  // non-string query ignored; body string wins
  assert.ok(keyOk(req({}, { key: [S] }), { key: S }, S));
  // non-string header ignored; query string wins
  assert.ok(keyOk(req({ [KEY_HEADER]: [S] }, { key: S }), null, S));
});

// ---- secret set vs fail-open ----------------------------------------------
test('keyOk: when secret is set, type-confused-only presentations return false', () => {
  assert.equal(keyOk(req({}, { key: [S] }), null, S), false);
  assert.equal(keyOk(req({}, {}), { key: [S] }, S), false);
  assert.equal(keyOk(req({ [KEY_HEADER]: [S] }), null, S), false);
  assert.equal(keyOk(req({}, { key: 1 }), { key: true }, S), false);
});

test('keyOk: when secret is unset/empty, fail-open still holds for type-confused inputs', () => {
  for (const secret of ['', undefined, null]) {
    assert.ok(keyOk(req({}, { key: [S] }), null, secret));
    assert.ok(keyOk(req({}, {}), { key: [S] }, secret));
    assert.ok(keyOk(req({ [KEY_HEADER]: [S] }), null, secret));
    assert.ok(keyOk(req({}, {}), null, secret));
  }
});
