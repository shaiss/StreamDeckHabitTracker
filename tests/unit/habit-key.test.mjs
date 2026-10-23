// HABIT_KEY gate (#111): header preferred, query/body still accepted;
// timing-safe compare; open when unset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyOk, providedKey, HABIT_KEY_HEADER } from '../../lib/habit-key.js';

const SECRET = 'test-habit-key-111-dummy';

function req(partial = {}) {
  return {
    headers: {},
    query: {},
    body: {},
    ...partial,
    headers: { ...(partial.headers || {}) },
    query: { ...(partial.query || {}) },
    body: partial.body === undefined ? {} : partial.body
  };
}

test('keyOk: no secret configured → always true (open writes)', () => {
  assert.equal(keyOk(req(), ''), true);
  assert.equal(keyOk(req(), undefined), true);
  assert.equal(keyOk(req({ headers: { [HABIT_KEY_HEADER]: 'anything' } }), ''), true);
});

test('keyOk: correct x-habit-key header → true', () => {
  assert.equal(
    keyOk(req({ headers: { [HABIT_KEY_HEADER]: SECRET } }), SECRET),
    true
  );
});

test('keyOk: missing key when secret set → false (handler → 401)', () => {
  assert.equal(keyOk(req(), SECRET), false);
  assert.equal(keyOk(req({ headers: {}, query: {}, body: {} }), SECRET), false);
});

test('keyOk: wrong header → false', () => {
  assert.equal(
    keyOk(req({ headers: { [HABIT_KEY_HEADER]: 'wrong-key-not-secret' } }), SECRET),
    false
  );
});

test('keyOk: wrong length does not throw (length guard)', () => {
  assert.equal(keyOk(req({ headers: { [HABIT_KEY_HEADER]: 'x' } }), SECRET), false);
  assert.equal(
    keyOk(req({ headers: { [HABIT_KEY_HEADER]: SECRET + '-extra' } }), SECRET),
    false
  );
});

test('keyOk: ?key= still accepted (plugin / older callers)', () => {
  assert.equal(keyOk(req({ query: { key: SECRET } }), SECRET), true);
  assert.equal(keyOk(req({ query: { key: 'nope' } }), SECRET), false);
});

test('keyOk: body.key still accepted', () => {
  assert.equal(keyOk(req({ body: { key: SECRET } }), SECRET), true);
  assert.equal(keyOk(req({ body: { key: 'nope' } }), SECRET), false);
});

test('providedKey: header wins over query and body', () => {
  assert.equal(
    providedKey(req({
      headers: { [HABIT_KEY_HEADER]: 'from-header' },
      query: { key: 'from-query' },
      body: { key: 'from-body' }
    })),
    'from-header'
  );
  assert.equal(
    providedKey(req({ query: { key: 'from-query' }, body: { key: 'from-body' } })),
    'from-query'
  );
  assert.equal(providedKey(req({ body: { key: 'from-body' } })), 'from-body');
});

test('targets decide gate: correct header → allow; missing/wrong → 401 shape', () => {
  // Mirrors api/targets.js POST: if (!keyOk(req)) res.status(401)...
  const allow = (r) => (keyOk(r, SECRET) ? 200 : 401);
  assert.equal(allow(req({ headers: { [HABIT_KEY_HEADER]: SECRET } })), 200);
  assert.equal(allow(req()), 401);
  assert.equal(allow(req({ headers: { [HABIT_KEY_HEADER]: 'bad' } })), 401);
  assert.equal(allow(req({ query: { key: SECRET } })), 200);
});
