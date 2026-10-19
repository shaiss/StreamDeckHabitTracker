// HABIT_KEY callers (#112 prep): server accepts the x-habit-key header, the
// web UIs keep the key in sessionStorage and send it as a header, and the
// plugin reads it from on-device global settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { keyOk, presentedKeys, redactKey, KEY_HEADER } from '../../lib/habit-key.js';
import { resolveKey, keyedInit, keyAllowedFor, KEY_ORIGINS } from '../../streamdeck-plugin/src/habit-key.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const S = 'test-' + 'placeholder-value';   // not a real key

// ---- server ---------------------------------------------------------------
test('keyOk: header, ?key=, and body.key are each accepted', () => {
  assert.equal(KEY_HEADER, 'x-habit-key');
  assert.ok(keyOk({ headers: { [KEY_HEADER]: S }, query: {} }, null, S));
  assert.ok(keyOk({ headers: {}, query: { key: S } }, null, S));
  assert.ok(keyOk({ headers: {}, query: {} }, { key: S }, S));
});

test('keyOk: wrong or missing key is refused when a secret is set', () => {
  assert.equal(keyOk({ headers: { [KEY_HEADER]: 'wrong-' + S }, query: {} }, null, S), false);
  assert.equal(keyOk({ headers: {}, query: {} }, null, S), false);
  assert.equal(keyOk({}, null, S), false);
  // body.key only counts on routes that pass the body
  assert.equal(keyOk({ headers: {}, query: {} }, undefined, S), false);
});

test('keyOk: unset secret stays fail-open (fail-closed is #112, not here)', () => {
  assert.ok(keyOk({ headers: {}, query: {} }, null, ''));
  assert.ok(keyOk({ headers: {}, query: {} }, null, undefined));
});

test('presentedKeys reads a WHATWG Headers object too', () => {
  const h = new Headers({ 'X-Habit-Key': S });
  assert.deepEqual(presentedKeys({ headers: h }), [S]);
});

test('redactKey strips key material from loggable strings', () => {
  assert.equal(redactKey('GET /api/log?hkey=1&key=' + S), 'GET /api/log?hkey=1&key=[redacted]');
  assert.equal(redactKey('/api/slots?key=' + S + '&tz=0'), '/api/slots?key=[redacted]&tz=0');
  assert.ok(!redactKey('x-habit-key: ' + S).includes(S));
});

test('every gated route uses keyOk — no raw ?key= compares left', () => {
  const files = [...readdirSync(join(ROOT, 'api')).filter((f) => f.endsWith('.js')).map((f) => 'api/' + f),
    'api/cron/morning.js'];
  const gated = ['log', 'habits', 'roster', 'profile', 'suggest', 'nudge', 'question', 'slots', 'coachpage',
    'experiment', 'cron/morning'].map((n) => 'api/' + n + '.js');
  for (const f of files) {
    const src = read(f);
    assert.doesNotMatch(src, /\.key\s*[!=]==?\s*(secret|habitKey)/, f + ' still compares the key by hand');
  }
  for (const f of gated) assert.match(read(f), /keyOk\(req/, f + ' must gate with keyOk');
});

test('CORS preflight allows the x-habit-key header where OPTIONS is answered', () => {
  for (const f of ['api/log.js', 'api/nudge.js', 'api/question.js', 'api/coachpage.js']) {
    assert.match(read(f), /Access-Control-Allow-Headers', 'Content-Type, x-habit-key'/, f);
  }
});

// ---- plugin ---------------------------------------------------------------
const PROD = 'https://stream-deck-habit-tracker.vercel.app';

test('plugin: global settings win, per-key settings.key is the fallback', () => {
  assert.equal(resolveKey({ habitKey: 'g' }, { key: 's' }, PROD), 'g');
  assert.equal(resolveKey({}, { key: 's' }, PROD), 's');
  assert.equal(resolveKey(null, null, PROD), '');
  assert.equal(resolveKey({ habitKey: '  ' }, {}, PROD), '');
});

// Cipher M1: the key only ever goes to a pinned https origin.
test('plugin M1: allowlisted https bases get the key', () => {
  assert.deepEqual([...KEY_ORIGINS], [PROD, 'https://habitdeck.fyi']);
  for (const b of [PROD, PROD + '/', 'https://habitdeck.fyi', 'https://HabitDeck.fyi/', 'https://habitdeck.fyi:443']) {
    assert.ok(keyAllowedFor(b), b);
    assert.equal(resolveKey({ habitKey: 'g' }, {}, b), 'g', b);
  }
});

test('plugin M1: a non-https base gets no key', () => {
  for (const b of ['http://habitdeck.fyi', 'http://stream-deck-habit-tracker.vercel.app', 'ws://habitdeck.fyi', 'ftp://habitdeck.fyi']) {
    assert.equal(keyAllowedFor(b), false, b);
    assert.equal(resolveKey({ habitKey: 'g' }, { key: 's' }, b), '', b);
  }
});

test('plugin M1: lookalike hosts get no key', () => {
  for (const b of ['https://habitdeck.fyi.evil.com', 'https://evilhabitdeck.fyi', 'https://habitdeck.fyi@evil.com',
    'https://user:pw@habitdeck.fyi', 'https://stream-deck-habit-tracker.vercel.app.evil.com',
    'https://www.habitdeck.fyi', 'https://x.stream-deck-habit-tracker.vercel.app']) {
    assert.equal(keyAllowedFor(b), false, b);
    assert.equal(resolveKey({ habitKey: 'g' }, { key: 's' }, b), '', b);
  }
});

test('plugin M1: a different origin (port, host, junk) gets no key', () => {
  for (const b of ['https://habitdeck.fyi:8443', 'https://example.com', 'https://my-fork.vercel.app', 'not a url', '', null, undefined]) {
    assert.equal(keyAllowedFor(b), false, String(b));
    assert.equal(resolveKey({ habitKey: 'g' }, { key: 's' }, b), '', String(b));
  }
});

test('plugin M1: plugin.mjs passes the request base into resolveKey', () => {
  assert.match(read('streamdeck-plugin/src/plugin.mjs'), /resolveKey\(globalSettings, s, baseOf\(s\)\)/);
});

test('plugin: keyedInit adds the header and keeps other init fields', () => {
  const ctrl = new AbortController();
  const i = keyedInit('k', { method: 'POST', signal: ctrl.signal, headers: { a: '1' } });
  assert.equal(i.method, 'POST');
  assert.equal(i.signal, ctrl.signal);
  assert.deepEqual(i.headers, { a: '1', [KEY_HEADER]: 'k' });
  assert.deepEqual(keyedInit('', {}).headers, {});
});

test('plugin source never puts the key in a URL', () => {
  const src = read('streamdeck-plugin/src/plugin.mjs');
  assert.doesNotMatch(src, /'&key='|'\?key='/);
  assert.match(src, /getGlobalSettings/);
  assert.match(src, /onDidReceiveGlobalSettings/);
});

test('plugin manifest wires the Property Inspector on every action', () => {
  const m = JSON.parse(read('streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/manifest.json'));
  for (const a of m.Actions) assert.equal(a.PropertyInspectorPath, 'ui/settings.html', a.UUID);
  const pi = read('streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/ui/settings.html');
  assert.match(pi, /setGlobalSettings/);
  assert.match(pi, /type="password"/);
});

// ---- web helper -----------------------------------------------------------
function loadHelper({ href = 'https://h.test/deck.html', session = true, responses = [] } = {}) {
  const ss = new Map();
  const ls = new Map();
  const calls = [];
  const replaced = [];
  const win = {
    location: { href },
    history: { state: null, replaceState: (_s, _t, u) => replaced.push(u) },
    sessionStorage: session ? {
      getItem: (k) => (ss.has(k) ? ss.get(k) : null), setItem: (k, v) => ss.set(k, String(v)), removeItem: (k) => ss.delete(k)
    } : undefined,
    localStorage: { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, v), removeItem: (k) => ls.delete(k) },
    fetch: (url, init) => {
      calls.push({ url, init });
      const status = responses.length ? responses.shift() : 200;
      return Promise.resolve({ status, ok: status < 400 });
    },
    URL
  };
  win.globalThis = win;
  vm.runInNewContext(read('public/habit-key.js'), win);
  return { HK: win.HabitKey, ss, ls, calls, replaced, win };
}

test('web: legacy ?key= moves to sessionStorage and is stripped from the URL', () => {
  const { HK, ss, ls, replaced } = loadHelper({ href: 'https://h.test/deck.html?x=1&key=' + S + '#top' });
  assert.equal(HK.get(), S);
  assert.equal([...ss.values()][0], S);
  assert.equal(ls.size, 0, 'never localStorage');
  assert.deepEqual(replaced, ['/deck.html?x=1#top']);
});

test('web: no ?key= means no history rewrite and no key', () => {
  const { HK, replaced } = loadHelper();
  assert.equal(HK.get(), '');
  assert.deepEqual(replaced, []);
});

test('web: memory fallback when sessionStorage is unavailable', () => {
  const { HK } = loadHelper({ session: false });
  HK.set('m');
  assert.equal(HK.get(), 'm');
});

test('web: writes send x-habit-key as a header, never in the URL', async () => {
  const { HK, calls } = loadHelper({ href: 'https://h.test/habits.html?key=' + S });
  await HK.postJson('/api/roster', { id: 'r1', decision: 'accept' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/roster');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-habit-key'], S);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  await HK.fetch('/api/log?hkey=1', { method: 'DELETE' });
  assert.equal(calls[1].url, '/api/log?hkey=1');
  assert.equal(calls[1].init.headers['x-habit-key'], S);
});

test('web: no key → no header (HABIT_KEY unset never prompts)', async () => {
  const { HK, calls } = loadHelper();
  await HK.fetch('/api/suggest', { method: 'POST' });
  assert.deepEqual(Object.keys(calls[0].init.headers), []);
});

test('web: a 401 clears the stale key; a dismissed prompt returns the 401', async () => {
  const { HK, calls } = loadHelper({ href: 'https://h.test/?key=' + S, responses: [401] });
  const r = await HK.fetch('/api/profile', { method: 'POST' });
  assert.equal(r.status, 401);
  assert.equal(calls.length, 1, 'no document → no prompt → no retry');
  assert.equal(HK.get(), '');
});

test('web pages load the helper and drop the old ?key= plumbing', () => {
  for (const f of ['public/deck.html', 'public/habits.html', 'public/index.html']) {
    const s = read(f);
    assert.match(s, /<script src="\/habit-key\.js"><\/script>/, f);
    assert.doesNotMatch(s, /localStorage/, f + ' must not use localStorage');
    assert.doesNotMatch(s, /withKey|'&key='|get\('key'\)/, f + ' still builds ?key= URLs');
  }
  const h = read('public/habits.html');
  assert.match(h, /HabitKey\.postJson\('\/api\/roster'/);
  assert.match(h, /HabitKey\.postJson\('\/api\/habits'/);
  const i = read('public/index.html');
  assert.match(i, /HabitKey\.fetch\('\/api\/suggest'/);
  assert.match(i, /HabitKey\.postJson\('\/api\/profile'/);
});
