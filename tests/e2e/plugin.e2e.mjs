// E2E regression tests for the Stream Deck plugin's two-way sync.
//
// The plugin is a hidden CEF page, which is exactly why it broke on hardware:
// Chromium throttles page timers on hidden pages, so the old
// `setInterval(refreshSlots, 15000)` stopped keeping faces current (issue #5).
// These tests load the real app.js in a headless page against a mock Stream
// Deck WebSocket + mock backend and assert the properties that make the sync
// survive that environment:
//
//   1. a slot swap on the server repaints the physical key (setImage)
//   2. the poll clock survives dead page timers — the Web Worker beat carries
//      it (setInterval/setTimeout are stubbed to no-ops = full throttling)
//   3. inbound Stream Deck events pump the deadline check, so any interaction
//      un-sticks a page whose clock has stopped entirely
//   4. the poll identifies itself with ?deck=<version>&keys=N so the backend
//      can report whether hardware is live
//   5. a tap logs server-side and schedules rechecks for the reactive swap
//
// The throttled tests deliberately avoid page.waitForFunction (its polling can
// rely on the very timers they stub out) and drive waits from Node instead.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { chromium } from 'playwright-core';

const PLUGIN = new URL(
  '../../streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin',
  import.meta.url
).pathname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };

const HABITS = [
  { name: 'Pee', emoji: '🚽', label: 'Pee' },
  { name: 'Eat', emoji: '🍽', label: 'Eat' }
];
const SLOT_A = { habit: 'Flow', emoji: '🌊', label: 'Flow', reason: 'deep work', assignedAt: 1 };
const SLOT_B = { habit: 'Walk', emoji: '🚶', label: 'Walk', reason: 'afternoon', assignedAt: 2 };

let server, browser, port;
let slots = [SLOT_A, null, null, null];
let pollUrls = [];
let logUrls = [];

before(async () => {
  server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/slots') {
      pollUrls.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ configured: true, aiReady: true, model: 'glm-5.2', habits: HABITS, suggestedAt: 1, slots }));
      return;
    }
    if (url === '/api/log') {
      logUrls.push(req.url);
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('ok');
      return;
    }
    const p = join(PLUGIN, url === '/' ? 'index.html' : url);
    if (existsSync(p)) {
      res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
      res.end(readFileSync(p));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
  const exe = process.env.CHROME_PATH ||
    (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
});

after(async () => { await browser?.close(); server?.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for a Node-side predicate without relying on any page timer.
async function until(pred, { timeout = 30_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Boot the plugin page with a fake Stream Deck socket. `killTimers` stubs the
// page's setInterval/setTimeout into no-ops, standing in for a fully throttled
// or frozen hidden page — the worst case the fix has to survive.
async function boot({ killTimers = false, breakWorkerScript = false } = {}) {
  const page = await browser.newPage();
  await page.addInitScript(({ kill, breakWorker }) => {
    window.__sent = [];
    if (kill) {
      window.setInterval = function () { return 0; };
      window.setTimeout = function () { return 0; };
    }
    // Stand in for a file:// origin, where loading a sibling worker script is
    // an opaque-origin failure but a blob: worker still runs.
    if (breakWorker) {
      const Real = window.Worker;
      window.Worker = function (url) {
        if (String(url).indexOf('blob:') !== 0) {
          const stub = { postMessage() {}, terminate() {}, onmessage: null, onerror: null };
          Promise.resolve().then(() => stub.onerror && stub.onerror(new Error('opaque origin')));
          return stub;
        }
        return new Real(url);
      };
    }
    // Minimal stand-in for the Stream Deck app's WebSocket endpoint.
    window.WebSocket = function () {
      this.readyState = 1;
      window.__ws = this;
      this.send = function (raw) { window.__sent.push(JSON.parse(raw)); };
      const self = this;
      Promise.resolve().then(() => self.onopen && self.onopen());
    };
    window.__emit = (ev) => window.__ws.onmessage({ data: JSON.stringify(ev) });
  }, { kill: killTimers, breakWorker: breakWorkerScript });

  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
  await page.evaluate((base) => {
    window.connectElgatoStreamDeckSocket(1234, 'uuid-1', 'registerPlugin');
    window.__emit({
      event: 'willAppear',
      context: 'ctx-slot-1',
      action: 'com.shaiss.habit-tracker.slot',
      payload: { settings: { base, slot: 1 } }
    });
    window.__emit({
      event: 'willAppear',
      context: 'ctx-habit-0',
      action: 'com.shaiss.habit-tracker.habit',
      payload: { settings: { base, index: 0 } }
    });
  }, `http://127.0.0.1:${port}`);
  return page;
}

const painted = (page) =>
  page.evaluate(() => window.__sent.filter((m) => m.event === 'setImage'));
const paintCount = async (page) => (await painted(page)).length;

async function bootAndSettle(opts) {
  slots = [SLOT_A, null, null, null];
  pollUrls = [];
  logUrls = [];
  const page = await boot(opts);
  // First poll landed and both faces painted from live state.
  await until(() => pollUrls.length >= 1, { label: 'first poll' , timeout: 15_000 });
  await until(async () => (await paintCount(page)) >= 2, { label: 'initial faces', timeout: 15_000 });
  return page;
}

test('a slot swap on the server repaints the physical key', async () => {
  const page = await bootAndSettle();
  const before = await paintCount(page);

  // The coach swaps slot 1. The plugin must notice on its own beat.
  slots = [SLOT_B, null, null, null];
  await until(async () => (await paintCount(page)) > before, { label: 'repaint after swap' });

  const all = await painted(page);
  assert.match(all[all.length - 1].payload.image, /^data:image\/png;base64,/);
  await page.close();
});

test('the poll clock survives dead page timers (the worker beat carries it)', async () => {
  // setInterval/setTimeout are no-ops here, and no Stream Deck events fire
  // after boot — so a second poll can only come from the Web Worker.
  const page = await bootAndSettle({ killTimers: true });
  const before = pollUrls.length;
  await until(() => pollUrls.length > before, { label: 'a worker-driven poll' });
  await page.close();
});

test('a rejected worker script falls back to a blob worker, clock intact', async () => {
  // Sibling-script Worker fails asynchronously via onerror (what happens on a
  // file:// origin). The blob fallback has to pick the beat up, with page
  // timers dead so nothing else can.
  const page = await bootAndSettle({ killTimers: true, breakWorkerScript: true });
  assert.ok(
    await page.evaluate(() => !!window.__ticker && String(window.__ticker) !== '[object Object]'),
    'expected a real blob-backed worker after the sibling script was rejected'
  );
  const before = pollUrls.length;
  await until(() => pollUrls.length > before, { label: 'a blob-worker-driven poll' });
  await page.close();
});

test('inbound Stream Deck events pump the poll, un-sticking a stopped clock', async () => {
  const page = await bootAndSettle({ killTimers: true });
  // Stop the worker too: now nothing but the WebSocket can wake this page.
  await page.evaluate(() => window.__ticker && window.__ticker.terminate());
  await sleep(500);
  const before = pollUrls.length;

  slots = [SLOT_B, null, null, null];
  // A device reconnect is a hard "your faces are stale" signal.
  await page.evaluate(() => window.__emit({ event: 'deviceDidConnect', device: 'dev-1' }));

  await until(() => pollUrls.length > before, { label: 'poll from a Stream Deck event', timeout: 10_000 });
  await page.close();
});

test('the poll identifies itself so the backend can report live hardware', async () => {
  const page = await bootAndSettle();
  for (const u of pollUrls) {
    assert.match(u, /[?&]deck=\d+\.\d+\.\d+/, 'every poll should carry ?deck=<version>');
    assert.match(u, /[?&]keys=\d+\b/, 'every poll should report how many keys are live');
  }
  // The first poll rides the first willAppear, so the count climbs as the deck
  // registers; once both keys are up, it must report both.
  await until(() => pollUrls.some((u) => /[?&]keys=2\b/.test(u)), { label: 'a poll reporting 2 live keys', timeout: 20_000 });
  await page.close();
});

test('a tap logs server-side and schedules rechecks for the reactive swap', async () => {
  const page = await bootAndSettle({ killTimers: true });
  const before = pollUrls.length;

  await page.evaluate(() => window.__emit({ event: 'keyDown', context: 'ctx-slot-1' }));
  await until(() => logUrls.length === 1, { label: 'the tap to log', timeout: 10_000 });
  assert.match(logUrls[0], /[?&]slot=1\b/, 'slot taps resolve server-side');

  // Rechecks are wall-clock deadlines, so they land even with page timers dead.
  await until(() => pollUrls.length > before + 1, { label: 'post-tap rechecks', timeout: 20_000 });
  await page.close();
});
