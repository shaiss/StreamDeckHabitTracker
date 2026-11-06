// Cipher #115 follow-up: keyedInit must force redirect:'error' so Node/undici
// never follows a 30x and re-sends x-habit-key to another origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyedInit, KEY_HEADER } from '../../streamdeck-plugin/src/habit-key.mjs';

test('keyedInit always sets redirect:error', () => {
  assert.equal(keyedInit('secret').redirect, 'error');
});

test('keyedInit forces redirect:error over caller redirect:follow', () => {
  const init = keyedInit('secret', { method: 'POST', redirect: 'follow' });
  assert.equal(init.redirect, 'error');
  assert.equal(init.method, 'POST');
});

test('keyedInit still sets x-habit-key when key is non-empty', () => {
  const init = keyedInit('secret');
  assert.equal(init.headers[KEY_HEADER], 'secret');
});

test('keyedInit omits x-habit-key when key is empty', () => {
  const init = keyedInit('');
  assert.equal(init.headers[KEY_HEADER], undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(init.headers, KEY_HEADER), false);
});

test('keyedInit preserves other init fields and merged headers', () => {
  const signal = AbortSignal.timeout(1000);
  const init = keyedInit('secret', {
    method: 'PUT',
    signal,
    headers: { 'content-type': 'application/json', 'x-extra': '1' },
  });
  assert.equal(init.method, 'PUT');
  assert.equal(init.signal, signal);
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.headers['x-extra'], '1');
  assert.equal(init.headers[KEY_HEADER], 'secret');
  assert.equal(init.redirect, 'error');
});
