// strip-key.js is the first blocking script. It must perform the same
// ?key= → sessionStorage + replaceState move as habit-key.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const S = 'test-' + 'placeholder-value';

function load(file, href) {
  const ss = new Map();
  const replaced = [];
  const win = {
    location: { href },
    history: { state: { n: 1 }, replaceState: (state, _t, u) => replaced.push([state, u]) },
    sessionStorage: {
      getItem: (k) => (ss.has(k) ? ss.get(k) : null),
      setItem: (k, v) => ss.set(k, String(v)),
      removeItem: (k) => ss.delete(k)
    },
    URL
  };
  win.globalThis = win;
  vm.runInNewContext(read(file), win);
  return { ss, replaced, win };
}

test('strip-key moves ?key= into sessionStorage and rewrites the URL', () => {
  const { ss, replaced } = load('public/strip-key.js', 'https://h.test/deck.html?x=1&key=' + S + '#top');
  assert.equal(ss.get('habitdeck.key'), S);
  assert.deepEqual(replaced, [[{ n: 1 }, '/deck.html?x=1#top']]);
});

test('strip-key leaves a URL with no key untouched', () => {
  const { ss, replaced } = load('public/strip-key.js', 'https://h.test/mind.html?settings=1');
  assert.equal(ss.size, 0);
  assert.deepEqual(replaced, []);
});

test('strip-key and habit-key.js rewrite the same URL', () => {
  const href = 'https://h.test/habits.html?key=' + S;
  const a = load('public/strip-key.js', href);
  const b = load('public/habit-key.js', href);
  assert.equal(a.ss.get('habitdeck.key'), b.ss.get('habitdeck.key'));
  assert.equal(a.replaced[0][1], b.replaced[0][1]);
  assert.equal(a.win.__habitdeckPendingKey, undefined);
});

test('setItem throwing still strips the URL and habit-key.js keeps the key in memory', () => {
  const href = 'https://h.test/deck.html?x=1&key=' + S + '#top';
  const replaced = [];
  const calls = [];
  const win = {
    location: { href },
    history: {
      state: { n: 1 },
      replaceState: (state, _t, u) => replaced.push([state, u])
    },
    sessionStorage: {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); }
    },
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({ status: 200, ok: true });
    },
    URL
  };
  win.globalThis = win;
  vm.runInNewContext(read('public/strip-key.js'), win);
  assert.equal(win.__habitdeckPendingKey, S);
  assert.deepEqual(replaced, [[{ n: 1 }, '/deck.html?x=1#top']]);
  assert.equal(replaced[0][1].includes('key='), false);
  // The browser's location updates with replaceState. The harness does not,
  // so point habit-key.js at the scrubbed URL the next script would see.
  win.location.href = 'https://h.test' + replaced[0][1];
  vm.runInNewContext(read('public/habit-key.js'), win);
  assert.equal(Object.prototype.hasOwnProperty.call(win, '__habitdeckPendingKey'), false);
  assert.equal(win.HabitKey.get(), S);
  return win.HabitKey.fetch('/api/log?habit=Test', { method: 'POST' }).then(() => {
    assert.equal(calls[0].init.headers['x-habit-key'], S);
    assert.equal(String(calls[0].url).includes('key='), false);
  });
});
